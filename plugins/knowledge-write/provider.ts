import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type {
  JournalRecordInput,
  KnowledgePromoteInput,
  KnowledgeProfile,
  KnowledgePublishInput,
  KnowledgeResolveInput,
  KnowledgeService,
} from "../../src/knowledge/types.ts";
import { resolveRepositoryScope, type RepositoryScope } from "../../src/knowledge/briefing-scope.ts";
import type { HostContext, PluginModule, ToolContributionRegistry, WorkCheckpointContributionRegistry, WorkCheckpointInput } from "../../src/loader/types.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const Scope = Type.Union([Type.Literal("task"), Type.Literal("project"), Type.Literal("shared")]);
const Status = Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("verified"), Type.Literal("deprecated")]);
const Visibility = Type.Union([Type.Literal("private"), Type.Literal("team"), Type.Literal("public")]);
const EvidenceKind = Type.Union([
  Type.Literal("event"), Type.Literal("artifact"), Type.Literal("commit"), Type.Literal("test"),
  Type.Literal("document"), Type.Literal("source"), Type.Literal("operator"),
]);
const Evidence = Type.Object({
  kind: EvidenceKind,
  locator: Type.String(),
  digest: Type.Optional(Type.String()),
}, { additionalProperties: false });
const Relation = Type.Object({
  predicate: Type.String(),
  target: Type.String(),
  evidence: Type.Optional(Type.String()),
}, { additionalProperties: false });
const JournalParameters = Type.Object({
  kind: Type.Union([Type.Literal("worklog"), Type.Literal("research"), Type.Literal("decision"), Type.Literal("error")]),
  scope: Scope,
  project: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  title: Type.String(),
  summary: Type.String(),
  details: Type.Optional(Type.String()),
  status: Type.Optional(Status),
  tags: Type.Optional(Type.Array(Type.String())),
  types: Type.Optional(Type.Array(Type.String())),
  relations: Type.Optional(Type.Array(Relation)),
  evidence: Type.Optional(Type.Array(Evidence)),
  visibility: Type.Optional(Visibility),
  research: Type.Optional(Type.Object({
    hypothesis: Type.String(),
    method: Type.String(),
    setup: Type.String(),
    results: Type.String(),
    analysis: Type.String(),
    conclusion: Type.String(),
    sources: Type.Array(Evidence),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
const PromoteParameters = Type.Object({
  source_id: Type.String(),
  scope: Type.Union([Type.Literal("project"), Type.Literal("shared")]),
  project: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  status: Type.Optional(Status),
  kind: Type.Optional(Type.Union([Type.Literal("claim"), Type.Literal("decision"), Type.Literal("procedure"), Type.Literal("concept")])),
  visibility: Type.Optional(Visibility),
  allow_visibility_promotion: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const ResolveParameters = Type.Object({
  source_id: Type.String(),
  target_id: Type.String(),
  relation: Type.Union([Type.Literal("wiki:contradicts"), Type.Literal("wiki:supersedes")]),
  evidence: Evidence,
}, { additionalProperties: false });
const MigrateParameters = Type.Object({ id: Type.String() }, { additionalProperties: false });
const PublishParameters = Type.Object({
  paths: Type.Array(Type.String()),
  message: Type.Optional(Type.String()),
  push: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

/** Project checkpoint publication policy without touching Git. */
export function checkpointPublicationRequest(
  profile: KnowledgeProfile | undefined,
  paths: readonly string[],
  goalId: string,
): KnowledgePublishInput | undefined {
  const publisher = profile?.publisher;
  const exactPaths = [...new Set(paths)].sort();
  if (exactPaths.length === 0 || publisher?.kind !== "git" || !publisher.policy || publisher.policy === "manual") {
    return undefined;
  }
  return {
    paths: exactPaths,
    push: publisher.policy === "automatic" && publisher.push,
    message: `knowledge checkpoint ${goalId}`,
  };
}

function writeTools(wiki: KnowledgeService): AgentTool[] {
  return [
    {
      name: "journal_record",
      label: "journal record",
      description: "Append a guarded task, project, or shared worklog, research, decision, or Error Book entry.",
      parameters: JournalParameters,
      async execute(_id, params) {
        return textToolResult(JSON.stringify(await wiki.record(params as JournalRecordInput)));
      },
    },
    {
      name: "knowledge_promote",
      label: "knowledge promote",
      description: "Promote one read and supported note into project or shared scope with a wiki:derivedFrom relation.",
      parameters: PromoteParameters,
      async execute(_id, params) {
        const value = params as {
          source_id: string;
          scope: KnowledgePromoteInput["scope"];
          project?: string;
          title?: string;
          status?: KnowledgePromoteInput["status"];
          kind?: KnowledgePromoteInput["kind"];
          visibility?: KnowledgePromoteInput["visibility"];
          allow_visibility_promotion?: boolean;
        };
        return textToolResult(JSON.stringify(await wiki.promote({
          sourceId: value.source_id,
          scope: value.scope,
          ...(value.project ? { project: value.project } : {}),
          ...(value.title ? { title: value.title } : {}),
          ...(value.status ? { status: value.status } : {}),
          ...(value.kind ? { kind: value.kind } : {}),
          ...(value.visibility ? { visibility: value.visibility } : {}),
          ...(value.allow_visibility_promotion === true ? { allowVisibilityPromotion: true } : {}),
        })));
      },
    },
    {
      name: "knowledge_resolve",
      label: "knowledge resolve",
      description: "Record an evidence-backed contradiction or supersession between two existing stable knowledge IDs.",
      parameters: ResolveParameters,
      async execute(_id, params) {
        const value = params as { source_id: string; target_id: string; relation: KnowledgeResolveInput["relation"]; evidence: KnowledgeResolveInput["evidence"] };
        return textToolResult(JSON.stringify(await wiki.resolve({
          sourceId: value.source_id,
          targetId: value.target_id,
          relation: value.relation,
          evidence: value.evidence,
        })));
      },
    },
    {
      name: "wiki_migrate",
      label: "wiki migrate",
      description: "Apply the one explicit ontology schema migration for an exact stable document ID using guarded compare-and-swap.",
      parameters: MigrateParameters,
      async execute(_id, params) {
        return textToolResult(JSON.stringify(await wiki.migrate((params as { id: string }).id)));
      },
    },
    ...(wiki.profile?.permissions.publish ? [{
      name: "wiki_publish",
      label: "wiki publish",
      description: "Commit exact changed knowledge paths, and push only when the protected profile explicitly grants push.",
      parameters: PublishParameters,
      async execute(_id: string, params: unknown) {
        return textToolResult(JSON.stringify(await wiki.publish(params as KnowledgePublishInput)));
      },
    } satisfies AgentTool] : []),
  ];
}

export const plugin: PluginModule = {
  id: "knowledge-write",
  claims: [
    { key: "knowledge", role: "consumer" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "skills", role: "consumer", modelFacing: true },
    { key: "work_checkpoint_contributions", role: "consumer" },
  ],
  activate(ctx) {
    const wiki = ctx.tryGet<KnowledgeService>("knowledge");
    if (!wiki) return { active: false, reason: "knowledge provider is inactive", kind: "unavailable" };
    if (wiki.profile?.permissions.write) return { active: true };
    return ctx.log.isReadOnly && ctx.log.events.some((event) => event.name === "plugin/load" && event.payload.id === "knowledge-write")
      ? { active: true }
      : { active: false, reason: "active knowledge profile is read-only", kind: "not_configured" };
  },
  register(ctx) {
    const wiki = ctx.get<KnowledgeService>("knowledge");
    // Same repository scoping as every read tool (#58): probes carry the
    // bound project or do not run at all. Resolved lazily and cached — the
    // workspace does not move mid-session.
    let cachedScope: RepositoryScope | undefined;
    const scope = (): RepositoryScope =>
      cachedScope ??= resolveRepositoryScope({
        repositoryProjects: wiki.profile?.repositoryProjects,
        workspaceRoot: ctx.workspaceRoot,
      });
    const promotionCandidates = async (input: WorkCheckpointInput): Promise<void> => {
      try {
        const candidates = await checkpointPromotionCandidates(wiki, input, scope().project);
        if (candidates.length === 0) return;
        ctx.log.append({
          kind: "observe",
          name: "knowledge/promotion_candidates",
          payload: {
            goal: input.goalId,
            reason: input.reason,
            candidates,
            count: candidates.length,
          },
        });
      } catch {
        // A candidate probe is advisory; it never fails the milestone.
      }
    };
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    for (const tool of writeTools(wiki)) ctx.effect(() => tools.register("knowledge-write", tool));
    const checkpoints = ctx.get<WorkCheckpointContributionRegistry>("work_checkpoint_contributions");
    ctx.effect(() => checkpoints.register("knowledge-write", async (input) => {
      const result = await wiki.checkpoint(input);
      const maintenance = await wiki.maintain(input.goalId);
      const paths = [
        result.path,
        ...(maintenance.error_book?.status === "written" ? [maintenance.error_book.path] : []),
        // Aging rewrites (refresh stamps, archive demotions) must ride the
        // same publication or a git-published vault accumulates permanently
        // uncommitted lifecycle changes (#110).
        ...(maintenance.aging?.touched_paths ?? []),
      ];
      const publication = checkpointPublicationRequest(wiki.profile, paths, input.goalId);
      if (publication) await wiki.publish(publication);
      await promotionCandidates(input);
    }));
  },
};

/** ASCII words that pass the length filter but distinguish nothing — a title
 * echo built on one of these is noise, not knowledge. */
const PROBE_STOPWORDS = new Set([
  "with", "that", "this", "from", "into", "over", "when", "then", "them",
  "they", "have", "does", "will", "each", "only", "under", "after", "before",
  "about", "their", "there", "these", "those", "should", "would", "could",
]);

function probeWordsOf(title: string): string[] {
  const seen = new Set<string>();
  for (const raw of title.split(/[^\p{L}\p{N}]+/u)) {
    const word = raw.toLowerCase();
    if (!word) continue;
    if (word.length < 4 && !/[^\x00-\x7F]/u.test(word)) continue;
    if (PROBE_STOPWORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/** Echo = a hit whose TITLE shares whole distinctive words with the probe —
 * judged locally on word boundaries, never reverse-engineered from the
 * scalar score (per-term sums and the ontology boost make any threshold
 * mean something else). */
function titleEchoes(hitTitle: string, probeWords: readonly string[]): boolean {
  const titleWords = new Set(
    hitTitle.split(/[^\p{L}\p{N}]+/u).map((word) => word.toLowerCase()).filter(Boolean),
  );
  const shared = probeWords.filter((word) => titleWords.has(word)).length;
  return shared >= Math.min(2, probeWords.length);
}

/** Exported for testing (#108). A cleared todo whose statement finds NO
 * title-level echo in this repository's wiki project is a promotion
 * candidate: work happened, a lesson exists in the log, and cross-session
 * memory holds nothing about it. Advisory only — the surface proposes, the
 * model or operator promotes. Bounded to 4 probes per milestone; each probe
 * is an ordinary recorded knowledge/query, scoped to the bound project like
 * every read tool (no project bound → no probes at all, #58). Todos already
 * proposed earlier in the session are skipped, and goal_done only considers
 * clears belonging to THIS goal's plan — a multi-goal session or a HEUNG
 * wave must not re-propose or misattribute another goal's todos. */
export async function checkpointPromotionCandidates(
  wiki: KnowledgeService,
  input: WorkCheckpointInput,
  project: string | undefined,
): Promise<Array<{ todo: string; title: string }>> {
  if (!project) return [];
  const clearedIds = input.reason === "todo_clear" && input.todoId !== undefined
    ? [input.todoId]
    : input.events
        .filter((event) =>
          event.name === "work/clear"
          && typeof event.payload.todo === "string"
          && event.payload.plan === input.goalId)
        .map((event) => event.payload.todo as string);
  // One forward pass over the log: last-seen todo titles win, and todos a
  // previous milestone already proposed stay proposed.
  const titles = new Map<string, string>();
  const proposed = new Set<string>();
  for (const event of input.events) {
    if (event.name === "work/todo" && typeof event.payload.id === "string") {
      titles.set(
        event.payload.id,
        String(event.payload.title ?? event.payload.statement ?? "").trim().slice(0, 200),
      );
    }
    if (event.name === "knowledge/promotion_candidates" && Array.isArray(event.payload.candidates)) {
      for (const candidate of event.payload.candidates) {
        if (candidate && typeof candidate === "object" && typeof (candidate as { todo?: unknown }).todo === "string") {
          proposed.add((candidate as { todo: string }).todo);
        }
      }
    }
  }
  const seen = new Set<string>();
  const candidates: Array<{ todo: string; title: string }> = [];
  for (const todo of clearedIds.slice(-4)) {
    if (seen.has(todo) || proposed.has(todo)) continue;
    seen.add(todo);
    const title = titles.get(todo) ?? "";
    if (!title) continue;
    const probeWords = probeWordsOf(title);
    if (probeWords.length === 0) continue;
    const hits = wiki.search({ text: probeWords.join(" "), project, limit: 3 });
    if (hits.some((hit) => titleEchoes(hit.title, probeWords))) continue;
    candidates.push({ todo, title });
  }
  return candidates;
}
