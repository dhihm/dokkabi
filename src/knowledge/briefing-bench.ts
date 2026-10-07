import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../host/event-log.ts";
import { swarmRepositoryDigest } from "../swarm/repository-identity.ts";
import { repositoryScopedBriefing } from "./briefing-scope.ts";
import { createKnowledgeService } from "./service.ts";
import type { KnowledgeProfile, KnowledgeService } from "./types.ts";

/**
 * The briefing benchmark (#58 acceptance 10).
 *
 * "Compare briefing latency, tokens, quality, and re-search reduction against
 * a baseline on an ordinary repository corpus."
 *
 * Deterministic and model-free ON PURPOSE. The quantity that matters here is
 * what the HOST hands the model before it thinks, and every part of it is
 * measurable without a generation: how long the brief took, how many bytes it
 * spends, which documents it delivers, and how many of the documents the goal
 * needs are already in hand instead of costing a `wiki_search` hop. Routing
 * this through a model would add sampling noise to a host measurement and
 * spend tokens to learn nothing extra (#60 item 3 is still unsettled, and
 * `docs/monkey.md` is where sampled measurement belongs).
 *
 * The baseline is the pre-#58 behaviour: the same brief with no project, the
 * unscoped call that `plugins/knowledge/provider.ts` used to make.
 */

export interface BriefingCorpusDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly relations?: readonly { readonly predicate: string; readonly target: string }[];
}

export interface BriefingCorpusCase {
  readonly repository: string;
  readonly statement: string;
  readonly relevant: readonly string[];
  readonly out_of_scope: readonly string[];
}

export interface BriefingCorpus {
  readonly projects: Readonly<Record<string, readonly BriefingCorpusDocument[]>>;
  /** Documents with no `wiki_project`. A repository-scoped view deliberately
   * EXCLUDES them: with no project they belong to no repository, and path
   * inference also stamps `shared` onto anything unfiled, so admitting them
   * would sweep in stray notes too. The corpus carries one so that exclusion
   * is measured rather than assumed. */
  readonly shared?: readonly BriefingCorpusDocument[];
  readonly cases: readonly BriefingCorpusCase[];
}

export interface BriefingArmResult {
  /** Documents the briefing actually named. */
  readonly delivered: string[];
  /** Relevant documents delivered — these cost no `wiki_search` hop. */
  readonly hits: number;
  /** Documents a repository-scoped view must not deliver: another project's,
   * or an unfiled `shared` one. Under #58 this must be 0 when scoped. */
  readonly outOfScope: number;
  readonly bytes: number;
  readonly latencyMs: number;
  readonly sufficiency: "sufficient" | "insufficient" | "none";
}

export interface BriefingCaseResult {
  readonly repository: string;
  readonly statement: string;
  readonly needed: number;
  readonly scoped: BriefingArmResult;
  readonly baseline: BriefingArmResult;
  /** No briefing at all — the arm that makes "re-search avoided" mean
   * something. Without it both briefing arms sit at 100% and the metric
   * measures nothing. */
  readonly none: BriefingArmResult;
}

export interface BriefingBenchReport {
  readonly format: 1;
  readonly cases: readonly BriefingCaseResult[];
  readonly totals: {
    readonly cases: number;
    readonly needed: number;
    /** Relevant documents the arm delivered, over all cases. */
    readonly scopedHits: number;
    readonly baselineHits: number;
    readonly noneHits: number;
    /** Out-of-project documents the arm delivered. */
    readonly scopedOutOfScope: number;
    readonly baselineOutOfScope: number;
    readonly scopedBytes: number;
    readonly baselineBytes: number;
    /** Fraction of needed documents already in hand: 1 − (searches still required / needed). */
    readonly scopedResearchAvoided: number;
    readonly baselineResearchAvoided: number;
    readonly noneResearchAvoided: number;
  };
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function document(project: string, doc: BriefingCorpusDocument): string {
  const relations = JSON.stringify(doc.relations ?? []);
  return [
    "---",
    "wiki_schema: 2",
    `wiki_id: "${doc.id}"`,
    'wiki_kind: "claim"',
    'wiki_scope: "project"',
    `wiki_project: "${project}"`,
    'wiki_status: "verified"',
    'wiki_visibility: "private"',
    'wiki_types: ["wiki:Claim"]',
    `wiki_relations: ${relations}`,
    'wiki_evidence: [{"kind":"source","locator":"source:corpus"}]',
    "---",
    `# ${doc.title}`,
    "",
    doc.body,
    "",
  ].join("\n");
}

function sharedDocument(doc: BriefingCorpusDocument): string {
  return [
    "---",
    "wiki_schema: 2",
    `wiki_id: "${doc.id}"`,
    'wiki_kind: "claim"',
    'wiki_scope: "shared"',
    'wiki_status: "verified"',
    'wiki_visibility: "private"',
    'wiki_types: ["wiki:Claim"]',
    `wiki_relations: ${JSON.stringify(doc.relations ?? [])}`,
    'wiki_evidence: [{"kind":"source","locator":"source:corpus"}]',
    "---",
    `# ${doc.title}`,
    "",
    doc.body,
    "",
  ].join("\n");
}

/** Materialise the corpus: one vault, and one real repository per project so
 * the digests are the same clone-stable identities production derives. */
export function materialiseBriefingCorpus(corpus: BriefingCorpus): {
  readonly vault: string;
  readonly repositories: Readonly<Record<string, string>>;
  readonly repositoryProjects: Readonly<Record<string, string>>;
} {
  const vault = mkdtempSync(join(tmpdir(), "dokkabi-brief-bench-vault-"));
  if (corpus.shared && corpus.shared.length > 0) {
    mkdirSync(join(vault, "shared"), { recursive: true });
    for (const doc of corpus.shared) {
      writeFileSync(join(vault, "shared", `${doc.id.split(":").pop()}.md`), sharedDocument(doc));
    }
  }
  const repositories: Record<string, string> = {};
  const repositoryProjects: Record<string, string> = {};
  for (const [project, documents] of Object.entries(corpus.projects)) {
    mkdirSync(join(vault, "projects", project), { recursive: true });
    for (const doc of documents) {
      writeFileSync(join(vault, "projects", project, `${doc.id.split(":").pop()}.md`), document(project, doc));
    }
    const root = mkdtempSync(join(tmpdir(), `dokkabi-brief-bench-${project}-`));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "bench@local.invalid"]);
    git(root, ["config", "user.name", "bench"]);
    // The project name seeds the root commit, so every repository gets its
    // own clone-stable digest.
    writeFileSync(join(root, "README.md"), `${project}\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", `seed ${project}`]);
    repositories[project] = root;
    repositoryProjects[swarmRepositoryDigest(root)] = project;
  }
  return { vault, repositories, repositoryProjects };
}

function measure(
  text: string | undefined,
  sufficiency: BriefingArmResult["sufficiency"],
  item: BriefingCorpusCase,
  latencyMs: number,
): BriefingArmResult {
  const body = text ?? "";
  const delivered = [...item.relevant, ...item.out_of_scope].filter((id) => body.includes(id));
  return {
    delivered,
    hits: item.relevant.filter((id) => body.includes(id)).length,
    outOfScope: item.out_of_scope.filter((id) => body.includes(id)).length,
    bytes: Buffer.byteLength(body),
    latencyMs,
    sufficiency,
  };
}

function timed<T>(body: () => T): { value: T; latencyMs: number } {
  const started = performance.now();
  const value = body();
  return { value, latencyMs: performance.now() - started };
}

export function runBriefingBench(corpus: BriefingCorpus, options: {
  readonly vault: string;
  readonly repositories: Readonly<Record<string, string>>;
  readonly repositoryProjects: Readonly<Record<string, string>>;
}): BriefingBenchReport {
  const cases: BriefingCaseResult[] = [];
  for (const item of corpus.cases) {
    const workspaceRoot = options.repositories[item.repository];
    if (!workspaceRoot) throw new Error(`corpus case names an unknown repository ${item.repository}`);
    const wiki = service(options.vault, options.repositoryProjects);

    const scopedRun = timed(() => repositoryScopedBriefing({ wiki, statement: item.statement, workspaceRoot }));
    const scoped = measure(
      scopedRun.value?.text,
      scopedRun.value ? scopedRun.value.sufficiency : "none",
      item,
      scopedRun.latencyMs,
    );

    // The pre-#58 call: no project, whole vault.
    const baselineRun = timed(() => wiki.brief({ statement: item.statement, limit: 3, maxBytes: 12_000 }));
    const baseline = measure(baselineRun.value.text, baselineRun.value.sufficiency, item, baselineRun.latencyMs);

    // With no briefing the model starts empty: every needed document costs a
    // `wiki_search`/`wiki_read` hop before it can be used.
    const none = measure(undefined, "none", item, 0);

    cases.push({
      repository: item.repository,
      statement: item.statement,
      needed: item.relevant.length,
      scoped,
      baseline,
      none,
    });
  }

  const sum = (pick: (row: BriefingCaseResult) => number): number =>
    cases.reduce((total, row) => total + pick(row), 0);
  const needed = sum((row) => row.needed);
  const scopedHits = sum((row) => row.scoped.hits);
  const baselineHits = sum((row) => row.baseline.hits);
  const noneHits = sum((row) => row.none.hits);
  return {
    format: 1,
    cases,
    totals: {
      cases: cases.length,
      needed,
      scopedHits,
      baselineHits,
      noneHits,
      scopedOutOfScope: sum((row) => row.scoped.outOfScope),
      baselineOutOfScope: sum((row) => row.baseline.outOfScope),
      scopedBytes: sum((row) => row.scoped.bytes),
      baselineBytes: sum((row) => row.baseline.bytes),
      scopedResearchAvoided: needed === 0 ? 0 : scopedHits / needed,
      baselineResearchAvoided: needed === 0 ? 0 : baselineHits / needed,
      noneResearchAvoided: needed === 0 ? 0 : noneHits / needed,
    },
  };
}

function service(vault: string, repositoryProjects: Readonly<Record<string, string>>): KnowledgeService {
  const profile: KnowledgeProfile = {
    name: "bench",
    root: vault,
    dialect: "commonmark",
    layout: "generic",
    visibility: "private",
    permissions: { read: true, write: false, publish: false },
    publisher: { kind: "none" },
    repositoryProjects,
  };
  const log = EventLog.create(join(mkdtempSync(join(tmpdir(), "dokkabi-brief-bench-log-")), "events.jsonl"));
  return createKnowledgeService({ log, profile });
}
