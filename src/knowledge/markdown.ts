import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  KnowledgeDocument,
  KnowledgeEvidence,
  KnowledgeKind,
  KnowledgeLifecycle,
  KnowledgeLink,
  KnowledgeMetadata,
  KnowledgeRelation,
  KnowledgeScope,
  KnowledgeStatus,
} from "./types.ts";
import { inferKnowledgeScope } from "./layout.ts";

const KINDS = new Set<KnowledgeKind>([
  "task", "worklog", "research", "claim", "decision", "experiment", "procedure",
  "incident", "artifact", "source", "concept", "error",
]);
const SCOPES = new Set<KnowledgeScope>(["task", "project", "shared"]);
const STATUSES = new Set<KnowledgeStatus>(["draft", "active", "verified", "deprecated"]);
const LIFECYCLES = new Set<KnowledgeLifecycle>(["core", "archive"]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

export function parseKnowledgeMarkdown(path: string, raw: string, options: { layout?: "generic" | "research-lab" } = {}): KnowledgeDocument {
  const digest = sha256(raw);
  const { values, body } = splitFrontmatter(raw);
  const fallback = path.replace(/\.md$/iu, "").replaceAll("/", ":");
  const declaredId = stringValue(values.wiki_id);
  const id = declaredId ?? fallback;
  const kind = enumValue(values.wiki_kind, KINDS) ?? "concept";
  const scope = enumValue(values.wiki_scope, SCOPES) ?? inferKnowledgeScope(path, options.layout ?? "generic");
  const status = enumValue(values.wiki_status, STATUSES) ?? "draft";
  const visibility = enumValue(values.wiki_visibility, new Set(["private", "team", "public"] as const)) ?? "private";
  const schema = numberValue(values.wiki_schema) ?? 1;
  const parseIssues = [
    ...(!declaredId ? ["missing_stable_id"] : []),
    ...(values.wiki_schema !== undefined && numberValue(values.wiki_schema) === undefined ? ["invalid_schema"] : []),
    ...(values.wiki_kind !== undefined && !enumValue(values.wiki_kind, KINDS) ? ["invalid_kind"] : []),
    ...(values.wiki_scope !== undefined && !enumValue(values.wiki_scope, SCOPES) ? ["invalid_scope"] : []),
    ...(values.wiki_status !== undefined && !enumValue(values.wiki_status, STATUSES) ? ["invalid_status"] : []),
    ...(values.wiki_visibility !== undefined && !enumValue(values.wiki_visibility, new Set(["private", "team", "public"] as const)) ? ["invalid_visibility"] : []),
    ...(values.wiki_types !== undefined && !validStringArray(values.wiki_types) ? ["invalid_types"] : []),
    ...(values.wiki_relations !== undefined && !validRelationArray(values.wiki_relations) ? ["invalid_relations"] : []),
    ...(values.wiki_evidence !== undefined && !validEvidenceArray(values.wiki_evidence) ? ["invalid_evidence"] : []),
    ...(values.aliases !== undefined && !validStringArray(values.aliases) ? ["invalid_aliases"] : []),
    ...(values.tags !== undefined && !validStringArray(values.tags) ? ["invalid_tags"] : []),
    ...(values.wiki_lifecycle !== undefined && !enumValue(values.wiki_lifecycle, LIFECYCLES) ? ["invalid_lifecycle"] : []),
    ...(values.wiki_last_referenced !== undefined
      && !(typeof values.wiki_last_referenced === "string" && DATE_ONLY.test(values.wiki_last_referenced))
      ? ["invalid_last_referenced"] : []),
    ...(schema >= 2 && values.wiki_visibility === undefined ? ["missing_visibility"] : []),
    ...(schema >= 2 && values.wiki_types === undefined ? ["missing_types"] : []),
    ...(schema >= 2 && values.wiki_relations === undefined ? ["missing_relations"] : []),
    ...(schema >= 2 && values.wiki_evidence === undefined ? ["missing_evidence_array"] : []),
  ];
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gmu)].map((match) => ({
    level: match[1]!.length,
    text: match[2]!.trim(),
    anchor: slug(match[2]!),
  }));
  const title = headings.find((heading) => heading.level === 1)?.text
    ?? stringValue(values.title)
    ?? basename(path, ".md");
  const metadata: KnowledgeMetadata = {
    schema,
    id,
    kind,
    scope,
    ...(stringValue(values.wiki_project) ? { project: stringValue(values.wiki_project)! } : {}),
    ...(stringValue(values.wiki_task) ? { task: stringValue(values.wiki_task)! } : {}),
    status,
    visibility,
    types: stringArray(values.wiki_types),
    relations: relationArray(values.wiki_relations),
    evidence: evidenceArray(values.wiki_evidence),
    aliases: stringArray(values.aliases),
    tags: stringArray(values.tags),
    ...(stringValue(values.created_at) ? { created_at: stringValue(values.created_at)! } : {}),
    ...(stringValue(values.updated_at) ? { updated_at: stringValue(values.updated_at)! } : {}),
    ...(enumValue(values.wiki_lifecycle, LIFECYCLES) ? { lifecycle: enumValue(values.wiki_lifecycle, LIFECYCLES)! } : {}),
    ...(typeof values.wiki_last_referenced === "string" && DATE_ONLY.test(values.wiki_last_referenced)
      ? { last_referenced: values.wiki_last_referenced }
      : {}),
    declared_id: Boolean(declaredId),
    parse_issues: parseIssues,
  };
  return { id, path, title, body, digest, metadata, headings, links: extractLinks(body) };
}

export function serializeKnowledgeMarkdown(document: Omit<KnowledgeDocument, "digest" | "headings" | "links">): string {
  const meta = document.metadata;
  const rows: Array<[string, unknown]> = [
    ["wiki_schema", meta.schema || 2],
    ["wiki_id", meta.id],
    ["wiki_kind", meta.kind],
    ["wiki_scope", meta.scope],
    ...(meta.project ? [["wiki_project", meta.project] as [string, unknown]] : []),
    ...(meta.task ? [["wiki_task", meta.task] as [string, unknown]] : []),
    ["wiki_status", meta.status],
    ["wiki_visibility", meta.visibility ?? "private"],
    ["wiki_types", meta.types],
    ["wiki_relations", meta.relations],
    ["wiki_evidence", meta.evidence ?? []],
    ["aliases", meta.aliases],
    ["tags", meta.tags],
    ...(meta.created_at ? [["created_at", meta.created_at] as [string, unknown]] : []),
    ...(meta.updated_at ? [["updated_at", meta.updated_at] as [string, unknown]] : []),
    ...(meta.lifecycle ? [["wiki_lifecycle", meta.lifecycle] as [string, unknown]] : []),
    ...(meta.last_referenced ? [["wiki_last_referenced", meta.last_referenced] as [string, unknown]] : []),
  ];
  return `---\n${rows.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${document.body.trim()}\n`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slug(value: string): string {
  const normalized = value.normalize("NFKD").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || `note-${sha256(value).slice(0, 12)}`;
}

function splitFrontmatter(raw: string): { values: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---\n")) return { values: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { values: {}, body: raw };
  const values: Record<string, unknown> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const text = match[2]!.trim();
    try {
      values[key] = JSON.parse(text);
    } catch {
      values[key] = text.replace(/^['"]|['"]$/gu, "");
    }
  }
  return { values, body: raw.slice(end + 5) };
}

function extractLinks(body: string): KnowledgeLink[] {
  const links: KnowledgeLink[] = [];
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/gu)) {
    links.push({ target: match[1]!.trim(), ...(match[3] ? { label: match[3].trim() } : {}), ...(match[2] ? { anchor: match[2].trim() } : {}) });
  }
  for (const match of body.matchAll(/\[([^\]]+)\]\(([^)]+\.md)(?:#([^)]+))?\)/gu)) {
    links.push({ target: match[2]!.trim(), label: match[1]!.trim(), ...(match[3] ? { anchor: match[3].trim() } : {}) });
  }
  return links;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ? value as T : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function validStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validRelationArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.predicate === "string" && row.predicate.trim().length > 0
      && typeof row.target === "string" && row.target.trim().length > 0
      && (row.evidence === undefined || typeof row.evidence === "string");
  });
}

function validEvidenceArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.kind === "string"
      && ["event", "artifact", "commit", "test", "document", "source", "operator"].includes(row.kind)
      && typeof row.locator === "string" && row.locator.trim().length > 0
      && (row.digest === undefined || typeof row.digest === "string");
  });
}

function relationArray(value: unknown): KnowledgeRelation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.predicate !== "string" || typeof row.target !== "string") return [];
    return [{ predicate: row.predicate, target: row.target, ...(typeof row.evidence === "string" ? { evidence: row.evidence } : {}) }];
  });
}

function evidenceArray(value: unknown): KnowledgeEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.kind !== "string" || typeof row.locator !== "string") return [];
    if (!["event", "artifact", "commit", "test", "document", "source", "operator"].includes(row.kind)) return [];
    return [{
      kind: row.kind as KnowledgeEvidence["kind"],
      locator: row.locator,
      ...(typeof row.digest === "string" ? { digest: row.digest } : {}),
    }];
  });
}
