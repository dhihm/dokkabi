import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, posix, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import { parseKnowledgeMarkdown, slug } from "./markdown.ts";
import { reservedKnowledgePath } from "./layout.ts";
import { CURRENT_WIKI_SCHEMA, loadOntologyCatalog, validateOntologyPacks, type OntologyCatalog } from "./ontology.ts";
import type {
  KnowledgeDocument,
  KnowledgeEdge,
  KnowledgeFollowOptions,
  KnowledgeGraph,
  KnowledgeLintIssue,
  KnowledgeProfile,
  KnowledgeQuery,
  KnowledgeSearchHit,
  KnowledgeTruthState,
  KnowledgeVaultStatus,
} from "./types.ts";

const MAX_DOCUMENTS = 20_000;
export class KnowledgeIndex {
  private documents = new Map<string, KnowledgeDocument>();
  private duplicateIds = new Set<string>();
  private revision = createHash("sha256").update("[]").digest("hex");

  constructor(readonly profile: KnowledgeProfile) {
    if (!profile.permissions.read) throw new Error(`knowledge profile ${profile.name} does not grant read access`);
    this.refresh();
  }

  refresh(): void {
    const root = realpathSync(this.profile.root);
    const rows: KnowledgeDocument[] = [];
    for (const absolute of walkMarkdown(root)) {
      const path = relative(root, absolute).split(sep).join("/");
      rows.push(parseKnowledgeMarkdown(path, readFileSync(absolute, "utf8"), { layout: this.profile.layout }));
      if (rows.length > MAX_DOCUMENTS) throw new Error(`knowledge vault exceeds ${MAX_DOCUMENTS} Markdown documents`);
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    this.documents = new Map();
    this.duplicateIds = new Set();
    for (const document of rows) {
      if (this.documents.has(document.id)) this.duplicateIds.add(document.id);
      else this.documents.set(document.id, document);
    }
    this.resolveLinkTargets();
    this.revision = createHash("sha256")
      .update(canonicalJson(rows.map((document) => ({ path: document.path, digest: document.digest }))))
      .digest("hex");
  }

  search(query: KnowledgeQuery): KnowledgeSearchHit[] {
    const terms = tokens(query.text ?? "");
    const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 10)));
    const hits: KnowledgeSearchHit[] = [];
    const scored = new Map<string, KnowledgeDocument>();
    for (const document of this.documents.values()) {
      // The forgetting zone: an archived doc never surfaces in default
      // search, briefings, or swarm views — only an explicit opt-in or a
      // direct id read reaches it (#110).
      if (!query.include_archived && document.metadata.lifecycle === "archive") continue;
      if (query.scope && document.metadata.scope !== query.scope) continue;
      // Strict equality, deliberately. A `shared` document carries no
      // `wiki_project`, so it belongs to no project and therefore to no
      // repository's scope. (`wiki_scope: shared` IS a declaration —
      // markdown.ts reads frontmatter first — but path inference also assigns
      // `shared` to anything outside tasks/ and projects/, so widening the
      // filter would additionally sweep in every unfiled note.)
      if (query.project && document.metadata.project !== query.project) continue;
      if (query.task && document.metadata.task !== query.task) continue;
      if (query.types?.length && !query.types.every((type) => document.metadata.types.includes(type))) continue;
      if (query.tags?.length && !query.tags.every((tag) => document.metadata.tags.includes(tag))) continue;
      if (query.kind && document.metadata.kind !== query.kind) continue;
      if (query.status && document.metadata.status !== query.status) continue;
      const truthState = this.truthState(document.id, query.project);
      if (query.truth_state && truthState !== query.truth_state) continue;
      const title = `${document.title} ${document.metadata.aliases.join(" ")}`.toLowerCase();
      const headings = document.headings.map((heading) => heading.text).join(" ").toLowerCase();
      const metadata = [
        ...document.metadata.tags,
        ...document.metadata.types,
        ...document.metadata.evidence.flatMap((item) => [item.kind, item.locator, item.digest ?? ""]),
        ...document.metadata.relations.flatMap((item) => [item.predicate, item.target, item.evidence ?? ""]),
      ].join(" ").toLowerCase();
      const body = document.body.toLowerCase();
      let score = terms.length === 0 ? 1 : 0;
      for (const term of terms) {
        if (title.includes(term)) score += 12;
        if (headings.includes(term)) score += 8;
        if (metadata.includes(term)) score += 6;
        score += Math.min(5, occurrences(body, term));
      }
      if (terms.length > 0 && score === 0) continue;
      scored.set(document.id, document);
      hits.push({
        id: document.id,
        path: document.path,
        title: document.title,
        scope: document.metadata.scope,
        kind: document.metadata.kind,
        status: document.metadata.status,
        truth_state: truthState,
        score,
        snippet: snippet(document.body, terms),
        digest: document.digest,
        tags: document.metadata.tags,
        types: document.metadata.types,
      });
    }
    // Ontology-weighted ranking (#108): a matching doc that a STRONGER
    // matching doc links to or relates to inherits a quarter of that
    // score. One damped hop over pre-boost scores — deterministic, no
    // iteration, a doc that did not match at all never enters, and the
    // strict strength guard means a weak stray mention can never reorder
    // two stronger equals or let mid-tier mutuals leapfrog an unlinked
    // stronger hit (the boost re-ranks downward-linked weaker matches
    // only; it cannot resurrect a non-hit or promote past a peer).
    if (terms.length > 0 && hits.length > 1) {
      const byId = new Map(hits.map((hit) => [hit.id, hit]));
      const base = new Map(hits.map((hit) => [hit.id, hit.score]));
      for (const [id, document] of scored) {
        const sourceScore = base.get(id)!;
        const targets = new Set([
          ...document.links.map((link) => link.target),
          ...document.metadata.relations.map((relation) => relation.target),
        ]);
        for (const target of targets) {
          if (target === id) continue;
          const neighbor = byId.get(target);
          if (neighbor && sourceScore > base.get(target)!) {
            neighbor.score += 0.25 * sourceScore;
          }
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }

  read(id: string): KnowledgeDocument | undefined {
    return this.documents.get(id);
  }

  /** Every document, archived included — the aging pass iterates the whole
   * vault, so it must not look through the search filter it maintains. */
  list(): KnowledgeDocument[] {
    return [...this.documents.values()];
  }

  /** Revision of the closed project corpus used by repository-scoped swarm
   * views. Unrelated projects must not churn another repository's dispatch. */
  projectRevision(project: string): string {
    const rows = [...this.documents.values()]
      .filter((document) => document.metadata.project === project)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((document) => ({ id: document.id, digest: document.digest }));
    return createHash("sha256").update(canonicalJson(rows)).digest("hex");
  }

  follow(id: string, options: KnowledgeFollowOptions = {}): KnowledgeGraph {
    if (!this.documents.has(id)) throw new Error(`unknown knowledge document ${id}`);
    const direction = options.direction ?? "both";
    const depth = Math.max(1, Math.min(4, Math.trunc(options.depth ?? 1)));
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
    const all = this.edges().filter((edge) => !options.predicate || edge.predicate === options.predicate);
    const seen = new Set([id]);
    const selected: KnowledgeEdge[] = [];
    let frontier = [id];
    for (let level = 0; level < depth && frontier.length > 0 && selected.length < limit; level += 1) {
      const next = new Set<string>();
      for (const current of frontier) {
        for (const edge of all) {
          const out = edge.source === current;
          const incoming = edge.target === current;
          if (!((direction === "out" || direction === "both") && out) && !((direction === "in" || direction === "both") && incoming)) continue;
          if (!selected.some((row) => canonicalJson(row) === canonicalJson(edge))) selected.push(edge);
          const neighbor = out ? edge.target : edge.source;
          if (this.documents.has(neighbor) && !seen.has(neighbor)) {
            seen.add(neighbor);
            next.add(neighbor);
          }
          if (selected.length >= limit) break;
        }
      }
      frontier = [...next].sort();
    }
    return {
      root: id,
      nodes: [...seen].sort().flatMap((nodeId) => {
        const document = this.documents.get(nodeId);
        return document ? [{ id: document.id, title: document.title, path: document.path }] : [];
      }),
      edges: selected.slice(0, limit),
      revision_digest: this.revision,
    };
  }

  lint(): KnowledgeLintIssue[] {
    const issues: KnowledgeLintIssue[] = [];
    let ontology: OntologyCatalog;
    try {
      ontology = this.ontology();
    } catch {
      ontology = validateOntologyPacks([]);
      issues.push({
        severity: "error",
        code: "invalid_metadata",
        document: "meta:ontology",
        detail: "Ontology pack validation failed.",
      });
    }
    const edges = this.edges();
    const aliases = new Map<string, string[]>();
    for (const document of this.documents.values()) {
      for (const alias of document.metadata.aliases) {
        const key = alias.normalize("NFKC").toLowerCase();
        aliases.set(key, [...(aliases.get(key) ?? []), document.id]);
      }
    }
    for (const id of [...this.duplicateIds].sort()) {
      issues.push({ severity: "error", code: "duplicate_id", document: id, detail: "Multiple Markdown files declare this wiki_id." });
    }
    for (const [alias, ids] of aliases) {
      if (new Set(ids).size > 1) {
        for (const id of [...new Set(ids)].sort()) issues.push({ severity: "warning", code: "duplicate_alias", document: id, detail: `Alias ${alias} is declared by more than one document.` });
      }
    }
    for (const document of this.documents.values()) {
      if (!document.title.trim()) issues.push({ severity: "error", code: "missing_title", document: document.id, detail: "Document has no level-one title." });
      if (!document.metadata.declared_id) issues.push({ severity: "warning", code: "missing_stable_id", document: document.id, detail: "Document relies on a path-derived fallback ID." });
      if (document.metadata.declared_id && !/^[\p{L}\p{N}._-]+(?::[\p{L}\p{N}._-]+)+$/u.test(document.id)) issues.push({ severity: "error", code: "invalid_metadata", document: document.id, detail: "Document declares an invalid stable ID." });
      if (document.metadata.parse_issues?.some((code) => code !== "missing_stable_id")) issues.push({ severity: "error", code: "invalid_metadata", document: document.id, detail: "Document frontmatter violates the portable metadata contract." });
      if (document.metadata.schema >= 2 && document.metadata.types.length === 0) issues.push({ severity: "error", code: "invalid_metadata", document: document.id, detail: "Current-schema document requires at least one ontology type." });
      if (document.metadata.scope === "task" && !document.metadata.task) issues.push({ severity: "error", code: "invalid_metadata", document: document.id, detail: "Task-scoped document requires wiki_task." });
      if (document.metadata.scope === "project" && !document.metadata.project) issues.push({ severity: "error", code: "invalid_metadata", document: document.id, detail: "Project-scoped document requires wiki_project." });
      if (document.metadata.schema !== CURRENT_WIKI_SCHEMA) issues.push({ severity: "warning", code: "migration_required", document: document.id, detail: `wiki_schema ${document.metadata.schema} requires explicit migration to ${CURRENT_WIKI_SCHEMA}.` });
      for (const type of document.metadata.types) {
        if (!ontology.classes.has(type)) issues.push({ severity: "warning", code: "unknown_type", document: document.id, detail: `Ontology does not declare ${type}.` });
      }
      if (evidenceRequired(document) && document.metadata.evidence.length === 0) {
        issues.push({ severity: "error", code: "missing_evidence", document: document.id, detail: "Verified durable knowledge requires at least one stable evidence locator." });
      }
      for (const evidence of document.metadata.evidence) {
        if (!validEvidence(evidence.locator, evidence.digest)) issues.push({ severity: "error", code: "invalid_evidence", document: document.id, detail: "Evidence locator or digest is invalid." });
      }
      for (const relation of document.metadata.relations) {
        const predicate = ontology.predicates.get(relation.predicate);
        if (!predicate) {
          issues.push({ severity: "warning", code: "unknown_predicate", document: document.id, detail: `Ontology does not declare ${relation.predicate}.` });
        }
        const target = this.documents.get(relation.target);
        if (!target) issues.push({ severity: "warning", code: "broken_target", document: document.id, detail: `${relation.predicate} targets missing ${relation.target}.` });
        if (predicate && !matchesOntology(document.metadata.types, predicate.domain)) {
          issues.push({ severity: "error", code: "ontology_domain", document: document.id, detail: `${relation.predicate} does not permit the source types.` });
        }
        if (predicate && target && !matchesOntology(target.metadata.types, predicate.range)) {
          issues.push({ severity: "error", code: "ontology_range", document: document.id, detail: `${relation.predicate} does not permit target ${target.id} types.` });
        }
        if (predicate?.evidence === "required" && !relation.evidence) {
          issues.push({ severity: "error", code: "missing_evidence", document: document.id, detail: `${relation.predicate} requires evidence.` });
        }
        if (relation.evidence && !relation.evidence.startsWith("#") && !validEvidence(relation.evidence)) {
          issues.push({ severity: "error", code: "invalid_evidence", document: document.id, detail: `${relation.predicate} has an invalid evidence locator.` });
        }
        if (relation.evidence?.startsWith("#")) {
          const anchor = slug(relation.evidence.slice(1));
          if (!document.headings.some((heading) => heading.anchor === anchor)) {
            issues.push({ severity: "warning", code: "missing_evidence_anchor", document: document.id, detail: `${relation.predicate} cites missing ${relation.evidence}.` });
          }
        }
        if (target && scopeRank(document.metadata.scope) > scopeRank(target.metadata.scope) && relation.predicate !== "wiki:derivedFrom") {
          issues.push({ severity: "error", code: "scope_leakage", document: document.id, detail: `${relation.predicate} exposes narrower-scope ${target.id}.` });
        }
      }
      for (const link of document.links) {
        const target = this.documents.get(link.target);
        const anchor = link.anchor;
        if (!target) issues.push({ severity: "warning", code: "broken_link", document: document.id, detail: `Markdown link targets missing ${link.target}.` });
        else if (anchor && !target.headings.some((heading) => heading.anchor === slug(anchor))) {
          issues.push({ severity: "warning", code: "broken_link", document: document.id, detail: `Markdown link targets missing anchor ${anchor}.` });
        }
        if (target && scopeRank(document.metadata.scope) > scopeRank(target.metadata.scope)) {
          issues.push({ severity: "error", code: "scope_leakage", document: document.id, detail: `Markdown link exposes narrower-scope ${target.id}.` });
        }
      }
      const connected = edges.some((edge) => edge.source === document.id || edge.target === document.id);
      if (!connected && !["task", "worklog", "error"].includes(document.metadata.kind)) issues.push({ severity: "warning", code: "orphan", document: document.id, detail: "Document has no incoming or outgoing knowledge edge." });
      if (this.truthState(document.id) === "contested" && document.metadata.status !== "deprecated") issues.push({ severity: "warning", code: "contradictory_active", document: document.id, detail: "An active claim has an unresolved contradiction." });
      if (this.truthState(document.id) === "superseded" && document.metadata.status !== "deprecated") issues.push({ severity: "warning", code: "stale_claim", document: document.id, detail: "A superseded document remains active." });
      if (document.metadata.kind === "source" && !edges.some((edge) =>
        (edge.target === document.id && edge.predicate === "wiki:derivedFrom")
          || (edge.source === document.id && edge.predicate === "wiki:validates")
      )) {
        issues.push({ severity: "warning", code: "source_coverage", document: document.id, detail: "Source is not connected to a derived or validated document." });
      }
    }
    return dedupeIssues(issues)
      .sort((a, b) => a.document.localeCompare(b.document) || a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail))
      .map((issue) => ({ ...issue, fingerprint: knowledgeLintFingerprint(issue) }));
  }

  status(): KnowledgeVaultStatus {
    const issues = this.lint();
    const docs = [...this.documents.values()];
    return {
      profile: this.profile.name,
      dialect: this.profile.dialect,
      layout: this.profile.layout,
      documents: docs.length,
      relations: docs.reduce((sum, doc) => sum + doc.metadata.relations.length, 0),
      links: docs.reduce((sum, doc) => sum + doc.links.length, 0),
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      orphans: issues.filter((issue) => issue.code === "orphan").length,
      contested: docs.filter((doc) => this.truthState(doc.id) === "contested").length,
      superseded: docs.filter((doc) => this.truthState(doc.id) === "superseded").length,
      writable: this.profile.permissions.write,
      publishable: this.profile.permissions.publish && this.profile.publisher.kind === "git",
      revision_digest: this.revision,
    };
  }

  private edges(): KnowledgeEdge[] {
    const edges: KnowledgeEdge[] = [];
    for (const document of this.documents.values()) {
      edges.push(...document.metadata.relations.map((relation) => ({ source: document.id, ...relation })));
      edges.push(...document.links.map((link) => ({ source: document.id, predicate: "wiki:linksTo", target: link.target, ...(link.anchor ? { evidence: `#${link.anchor}` } : {}) })));
    }
    return edges.sort((a, b) => a.source.localeCompare(b.source) || a.predicate.localeCompare(b.predicate) || a.target.localeCompare(b.target));
  }

  truthState(id: string, project?: string): KnowledgeTruthState {
    const document = this.documents.get(id);
    if (!document) return "unverified";
    if (document.metadata.status === "deprecated") return "deprecated";
    const edges = project
      ? this.edges().filter((edge) =>
          this.documents.get(edge.source)?.metadata.project === project &&
          this.documents.get(edge.target)?.metadata.project === project
        )
      : this.edges();
    if (edges.some((edge) => edge.predicate === "wiki:supersedes" && edge.target === id)) return "superseded";
    const unresolvedContradiction = edges.some((edge) => {
      if (edge.predicate !== "wiki:contradicts" || (edge.source !== id && edge.target !== id)) return false;
      const other = edge.source === id ? edge.target : edge.source;
      return !edges.some((candidate) =>
        candidate.predicate === "wiki:supersedes"
          && ((candidate.source === id && candidate.target === other) || (candidate.source === other && candidate.target === id))
      );
    });
    if (unresolvedContradiction) return "contested";
    return document.metadata.status === "verified" ? "current" : "unverified";
  }

  private resolveLinkTargets(): void {
    const byName = new Map<string, string>();
    for (const document of this.documents.values()) {
      byName.set(basename(document.path, ".md").toLowerCase(), document.id);
      byName.set(document.path.replace(/\.md$/iu, "").toLowerCase(), document.id);
    }
    for (const document of this.documents.values()) {
      document.links = document.links.map((link) => ({
        ...link,
        target: this.documents.has(link.target)
          ? link.target
          : byName.get(link.target.replace(/\.md$/iu, "").toLowerCase())
            ?? byName.get(posix.normalize(posix.join(posix.dirname(document.path), link.target)).replace(/\.md$/iu, "").toLowerCase())
            ?? link.target,
      }));
    }
  }

  private ontology(): OntologyCatalog {
    return loadOntologyCatalog(realpathSync(this.profile.root));
  }
}

export function knowledgeLintFingerprint(issue: Pick<KnowledgeLintIssue, "severity" | "code" | "document" | "detail">): string {
  return createHash("sha256").update(canonicalJson({
    severity: issue.severity,
    code: issue.code,
    document: issue.document,
    detail: issue.detail,
  })).digest("hex");
}

function* walkMarkdown(root: string): Generator<string> {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relative(root, resolve(dir, entry.name)).split(sep).join("/");
      if (reservedKnowledgePath(rel)) continue;
      const absolute = resolve(dir, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("knowledge vault contains a symbolic link");
      if (stat.isDirectory()) stack.push(absolute);
      else if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) yield absolute;
    }
  }
}

function evidenceRequired(document: KnowledgeDocument): boolean {
  return document.metadata.status === "verified" && ["research", "claim", "decision", "experiment", "procedure", "incident", "source"].includes(document.metadata.kind);
}

function validEvidence(locator: string, digest?: string): boolean {
  if (!/^(?:event|artifact|commit|test|document|source|operator):[^\s]{1,300}$/u.test(locator)) return false;
  return digest === undefined || /^[a-f0-9]{40,64}$/u.test(digest);
}

function matchesOntology(actual: string[], allowed: string[]): boolean {
  return allowed.includes("*") || actual.some((type) => allowed.includes(type));
}

function scopeRank(scope: string): number {
  return scope === "shared" ? 3 : scope === "project" ? 2 : 1;
}

function dedupeIssues(issues: KnowledgeLintIssue[]): KnowledgeLintIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = canonicalJson(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((term) => term.length > 1))];
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = 0;
  while ((at = haystack.indexOf(needle, at)) >= 0) {
    count += 1;
    at += needle.length;
  }
  return count;
}

function snippet(body: string, terms: string[]): string {
  const flat = body.replace(/^#+\s+/gmu, "").replace(/\s+/gu, " ").trim();
  const first = terms.map((term) => flat.toLowerCase().indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 80);
  const clipped = flat.slice(start, start + 320);
  return `${start > 0 ? "…" : ""}${clipped}${start + clipped.length < flat.length ? "…" : ""}`;
}
