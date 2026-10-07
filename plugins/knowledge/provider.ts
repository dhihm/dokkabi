import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { canonicalJson } from "../../src/host/canonical.ts";
import { readConfig } from "../../src/host/config.ts";
import { assertNoSecrets, collectStrings, containsPrivateInfrastructureValue } from "../../src/host/redact.ts";
import { resolveActiveKnowledgeProfile } from "../../src/knowledge/config.ts";
import { createKnowledgeService } from "../../src/knowledge/service.ts";
import {
  repositoryScopedBriefing,
  resolveRepositoryScope,
  type RepositoryScope,
} from "../../src/knowledge/briefing-scope.ts";
import { KnowledgeIndex } from "../../src/knowledge/index.ts";
import type { KnowledgeFollowOptions, KnowledgeQuery, KnowledgeService } from "../../src/knowledge/types.ts";
import type {
  GoalContextContributionRegistry,
  HostContext,
  PluginModule,
  SwarmMemoryContributionRegistry,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import {
  MAX_SWARM_MEMORY_SELECTED_IDS,
  type SwarmMemoryCompileInput,
  type SwarmMemoryContribution,
} from "../../src/swarm/memory-view.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const Scope = Type.Union([Type.Literal("task"), Type.Literal("project"), Type.Literal("shared")]);
const Kind = Type.Union([
  Type.Literal("task"), Type.Literal("worklog"), Type.Literal("research"), Type.Literal("claim"),
  Type.Literal("decision"), Type.Literal("experiment"), Type.Literal("procedure"), Type.Literal("incident"),
  Type.Literal("artifact"), Type.Literal("source"), Type.Literal("concept"), Type.Literal("error"),
]);
const SearchParameters = Type.Object({
  text: Type.Optional(Type.String()),
  scope: Type.Optional(Scope),
  project: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  types: Type.Optional(Type.Array(Type.String())),
  tags: Type.Optional(Type.Array(Type.String())),
  kind: Type.Optional(Kind),
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("verified"), Type.Literal("deprecated")])),
  truth_state: Type.Optional(Type.Union([
    Type.Literal("unverified"), Type.Literal("current"), Type.Literal("contested"), Type.Literal("superseded"), Type.Literal("deprecated"),
  ])),
  limit: Type.Optional(Type.Number()),
}, { additionalProperties: false });
const ReadParameters = Type.Object({ id: Type.String() }, { additionalProperties: false });
const FollowParameters = Type.Object({
  id: Type.String(),
  predicate: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union([Type.Literal("out"), Type.Literal("in"), Type.Literal("both")])),
  depth: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
}, { additionalProperties: false });
const EmptyParameters = Type.Object({}, { additionalProperties: false });
const BriefParameters = Type.Object({
  statement: Type.String(),
  project: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  max_bytes: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const WIKI_MEMORY_MAX_BYTES = 6_000;
const WIKI_MEMORY_UNAVAILABLE = "Wiki briefing is unavailable for this captured repository snapshot.";
const RAW_ABSOLUTE_PATH = /(?:^|[\s"'`(=])(?:~\/|\/(?!\/)[^\s"'`)>\]}]+|[A-Za-z]:[\\/][^\s"'`)>\]}]+|\\\\[^\s\\/"'`]+\\[^\s"'`)>\]}]+)/u;

const UNBOUND = "This repository has no bound knowledge project, so the vault is out of scope. "
  + "Run `dokkabi knowledge bind --project ID` to open it, then start a new session.";
const FOREIGN_PROJECT = "This session is scoped to its repository's own knowledge project; "
  + "another project cannot be requested.";

/** Refuse a document that is not this repository's. Scoping the goal briefing
 * while leaving these tools open would close the window and leave the door:
 * the model can ask for the same documents directly.
 *
 * Uses the NON-recording lookup: a scope check that went through `read` would
 * store the refused document's body in the session blobs and its id in the
 * replay contract — leaking the very id it withholds.
 *
 * Strict equality, matching `index.ts` search: a `shared` document carries no
 * `wiki_project`, so it is in no repository's scope. */
function outOfScope(wiki: KnowledgeService, id: string, project: string): boolean {
  return wiki.documentProject(id) !== project;
}

const RecallParameters = Type.Object({
  query: Type.String({ description: "Text to recall across this session's MAEK memory and the repository's wiki." }),
  limit: Type.Optional(Type.Number({ description: "Rows per layer, 1-8 (default 4)." })),
  max_bytes: Type.Optional(Type.Number({ description: "Byte budget for the combined result, 1000-16000 (default 6000). The budget is part of the contract: results shrink to fit, never overflow." })),
}, { additionalProperties: false });

/** Exported for testing (#108): the read-tool surface with its scope guard. */
export function readTools(
  wiki: KnowledgeService,
  scope: () => RepositoryScope,
  maek?: import("../../src/maek/types.ts").MaekService,
): AgentTool[] {
  return [
    {
      // #108: one bounded cross-layer recall — "how did I solve this
      // before?" answered from session memory (MAEK decisions + similar
      // faults) and cross-session memory (wiki hits) in a single call.
      // Both layers already record their own query envelopes, so the join
      // needs no new replay surface.
      name: "wiki_recall",
      label: "wiki recall",
      description:
        "Cross-layer recall: this session's recorded MAEK decisions and similar faults joined with the repository's wiki hits, under one byte budget. Ask before re-deriving a decision or re-diagnosing a familiar failure.",
      parameters: RecallParameters,
      async execute(_id, params) {
        const project = scope().project;
        if (!project) return textToolResult(UNBOUND, true);
        const p = params as { query: string; limit?: number; max_bytes?: number };
        const limit = Math.max(1, Math.min(8, Math.trunc(p.limit ?? 4)));
        const maxBytes = Math.max(1_000, Math.min(16_000, Math.trunc(p.max_bytes ?? 6_000)));
        // Query each layer ONCE at the full limit and shrink locally: the
        // budget loop must not multiply recorded envelopes or re-scan the
        // vault per iteration. A mounted-but-broken maek degrades with a
        // note (its failure is already recorded as maek/query_failed) —
        // the wiki half still answers.
        const wikiRows = wiki.search({ text: p.query, project, limit })
          .map((hit) => ({ id: hit.id, title: hit.title, snippet: hit.snippet, score: hit.score }));
        let note: string | undefined = maek ? undefined : "maek is not mounted this session";
        let decisionRows: unknown[] = [];
        let faultRows: unknown[] = [];
        if (maek) {
          try {
            decisionRows = await maek.queryDecisions(p.query, { limit });
            faultRows = await maek.querySimilarFaults({ errorPattern: p.query, limit });
          } catch {
            decisionRows = [];
            faultRows = [];
            note = "maek was unavailable for this call";
          }
        }
        let take = limit;
        for (;;) {
          const payload = {
            wiki: wikiRows.slice(0, take),
            decisions: decisionRows.slice(0, take),
            faults: faultRows.slice(0, take),
            ...(note ? { note } : {}),
            truncated: take < limit,
          };
          const body = JSON.stringify(payload);
          if (Buffer.byteLength(body) <= maxBytes || take === 0) return textToolResult(body);
          take = Math.trunc(take / 2);
        }
      },
    },
    {
      name: "wiki_search",
      label: "wiki search",
      description: "Lexically search the configured Markdown knowledge vault with scope, project, task, type, and tag filters.",
      parameters: SearchParameters,
      async execute(_id, params) {
        const project = scope().project;
        if (!project) return textToolResult(UNBOUND, true);
        const query = params as KnowledgeQuery;
        // Refused, not silently rewritten: answering a different question
        // than the one asked is worse than saying no.
        if (query.project && query.project !== project) return textToolResult(FOREIGN_PROJECT, true);
        return textToolResult(JSON.stringify(wiki.search({ ...query, project })));
      },
    },
    {
      name: "wiki_read",
      label: "wiki read",
      description: "Read one knowledge document by its exact stable wiki_id. Search first when the id is unknown.",
      parameters: ReadParameters,
      async execute(_id, params) {
        const { id } = params as { id: string };
        const project = scope().project;
        if (!project) return textToolResult(UNBOUND, true);
        if (outOfScope(wiki, id, project)) {
          return textToolResult(`knowledge document ${id} is not in this repository's project`, true);
        }
        const document = wiki.read(id);
        return document ? textToolResult(JSON.stringify(document)) : textToolResult(`unknown knowledge document ${id}`, true);
      },
    },
    {
      name: "wiki_follow",
      label: "wiki follow",
      description: "Traverse outgoing or incoming Markdown links and typed ontology relations from one stable wiki_id.",
      parameters: FollowParameters,
      async execute(_id, params) {
        const { id, ...options } = params as { id: string } & KnowledgeFollowOptions;
        const project = scope().project;
        if (!project) return textToolResult(UNBOUND, true);
        if (outOfScope(wiki, id, project)) {
          return textToolResult(`knowledge document ${id} is not in this repository's project`, true);
        }
        const graph = wiki.follow(id, options);
        // Nodes AND edges. service.ts states the rule this has to hold:
        // "neither the foreign document nor even its stable ID may enter
        // child bytes" — and an edge carries the foreign id in its target.
        const visible = (candidate: string): boolean => !outOfScope(wiki, candidate, project);
        return textToolResult(JSON.stringify({
          ...graph,
          nodes: graph.nodes.filter((node) => visible(node.id)),
          edges: graph.edges.filter((edge) => visible(edge.source) && visible(edge.target)),
        }));
      },
    },
    {
      name: "wiki_brief",
      label: "wiki brief",
      description: "Build the same bounded, recorded, truth-state-aware knowledge briefing used for automatic goal context, scoped to this repository's bound project.",
      parameters: BriefParameters,
      async execute(_id, params) {
        const value = params as { statement: string; project?: string; limit?: number; max_bytes?: number };
        const project = scope().project;
        if (!project) return textToolResult(UNBOUND, true);
        if (value.project && value.project !== project) return textToolResult(FOREIGN_PROJECT, true);
        return textToolResult(JSON.stringify(wiki.brief({
          statement: value.statement,
          project,
          ...(value.limit !== undefined ? { limit: value.limit } : {}),
          ...(value.max_bytes !== undefined ? { maxBytes: value.max_bytes } : {}),
        })));
      },
    },
    {
      name: "wiki_status",
      label: "wiki status",
      description: "Report safe vault counts, permissions, lint totals, and revision digest without exposing its filesystem root.",
      parameters: EmptyParameters,
      async execute() {
        return textToolResult(JSON.stringify(wiki.status()));
      },
    },
    {
      name: "wiki_lint",
      label: "wiki lint",
      description: "Validate stable IDs, metadata, and relation targets in this repository's knowledge project without changing files.",
      parameters: EmptyParameters,
      async execute() {
        const project = scope().project;
        if (!project) return textToolResult(UNBOUND, true);
        // Lint rows are keyed by stable id and its `detail` strings name other
        // documents' ids, so an unscoped lint is a complete cross-project id
        // enumeration. `wiki_status` really is counts-only and stays open.
        // A vault-level row (`meta:ontology`) names no document, so it has no
        // project and must NOT be filtered: dropping it made wiki_status
        // report errors that wiki_lint then showed none of.
        return textToolResult(JSON.stringify(wiki.lint().filter((issue) =>
          !wiki.hasDocument(issue.document) || !outOfScope(wiki, issue.document, project))));
      },
    },
  ];
}

function loadedInReplay(ctx: HostContext, id: string): boolean {
  return ctx.log.isReadOnly && ctx.log.events.some((event) => event.name === "plugin/load" && event.payload.id === id);
}

export const plugin: PluginModule = {
  id: "knowledge",
  claims: [
    { key: "knowledge", role: "definition" },
    { key: "knowledge", role: "provider" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "skills", role: "consumer", modelFacing: true },
    { key: "goal_context_contributions", role: "consumer" },
    { key: "swarm_memory_contributions", role: "consumer" },
    { key: "maek", role: "consumer", optional: true },
  ],
  activate(ctx) {
    return resolveActiveKnowledgeProfile(readConfig()) || loadedInReplay(ctx, "knowledge")
      ? { active: true }
      : { active: false, reason: "no active knowledge profile", kind: "not_configured" };
  },
  // The vault the profile names is read here, as register reads it: a vault
  // that cannot be read refuses the boot in preflight, never in register
  // (#230 round 5, B0). Reading changes nothing.
  preflight(ctx) {
    const profile = resolveActiveKnowledgeProfile(readConfig());
    if (profile && !ctx.log.isReadOnly) new KnowledgeIndex(profile).status();
  },
  register(ctx) {
    const profile = resolveActiveKnowledgeProfile(readConfig());
    const wiki = createKnowledgeService({ log: ctx.log, ...(profile ? { profile } : {}) });
    ctx.define("knowledge", { storage: "markdown", replay: "recorded_blobs" });
    ctx.provide("knowledge", wiki);
    if (profile && !ctx.log.isReadOnly) {
      const status = new KnowledgeIndex(profile).status();
      ctx.log.append({
        kind: "observe",
        name: "knowledge/profile",
        payload: {
          profile: profile.name,
          dialect: profile.dialect,
          layout: profile.layout,
          writable: status.writable,
          publishable: status.publishable,
          documents: status.documents,
          relations: status.relations,
          orphans: status.orphans,
          errors: status.errors,
          warnings: status.warnings,
          revision_digest: status.revision_digest,
        },
      });
    }
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    // Resolved lazily and cached: the workspace does not move mid-session,
    // and swarmRepositoryDigest costs several git spawns.
    let cachedScope: RepositoryScope | undefined;
    const scope = (): RepositoryScope =>
      cachedScope ??= resolveRepositoryScope({
        repositoryProjects: wiki.profile?.repositoryProjects,
        workspaceRoot: ctx.workspaceRoot,
      });
    const maek = ctx.tryGet<import("../../src/maek/types.ts").MaekService>("maek");
    for (const tool of readTools(wiki, scope, maek)) ctx.effect(() => tools.register("knowledge", tool));
    const goalContext = ctx.get<GoalContextContributionRegistry>("goal_context_contributions");
    // Repository-scoped, and fail-closed when unbound (#58). An unscoped
    // brief searches the whole vault and its cross-project traversal guard is
    // itself conditioned on a project, so working in one repository used to
    // put another repository's documents into the recorded turn input.
    ctx.effect(() => goalContext.register("knowledge", (input) => repositoryScopedBriefing({
      wiki,
      statement: input.statement,
      workspaceRoot: ctx.workspaceRoot,
      ...(input.project ? { project: input.project } : {}),
      log: ctx.log,
    })));
    const memory = ctx.get<SwarmMemoryContributionRegistry>("swarm_memory_contributions");
    ctx.effect(() => memory.register("knowledge", (input) => wikiMemory(wiki, input)));
  },
};

function wikiMemory(wiki: KnowledgeService, input: SwarmMemoryCompileInput): SwarmMemoryContribution {
  try {
    const project = wiki.profile?.repositoryProjects?.[input.repositoryDigest];
    if (!project) throw new Error("Wiki profile has no project binding for this repository");
    const brief = wiki.brief({
      statement: input.purpose,
      project,
      limit: 3,
      maxBytes: WIKI_MEMORY_MAX_BYTES,
    });
    assertSafeMemory(brief);
    if (!/^[a-f0-9]{64}$/u.test(brief.revision_digest)) {
      throw new Error("Wiki briefing has an invalid revision digest");
    }
    const selectedIds = [...new Set([...brief.document_ids, ...brief.related_ids])]
      .slice(0, MAX_SWARM_MEMORY_SELECTED_IDS);
    const selectionDigest = sha256(canonicalJson({
      repository_digest: input.repositoryDigest,
      selected_ids: selectedIds,
      sufficiency: brief.sufficiency,
      truncated: brief.truncated,
    }));
    return {
      sufficiency: brief.truncated ? "insufficient" : brief.sufficiency,
      content: brief.text,
      sourceRevisionDigest: brief.revision_digest,
      selectedIds,
      evidenceDigests: [brief.revision_digest, selectionDigest],
    };
  } catch {
    return {
      sufficiency: "insufficient",
      content: WIKI_MEMORY_UNAVAILABLE,
      sourceRevisionDigest: sha256(WIKI_MEMORY_UNAVAILABLE),
      selectedIds: [],
      evidenceDigests: [],
    };
  }
}

function assertSafeMemory(value: unknown): void {
  assertNoSecrets(value);
  if (containsPrivateInfrastructureValue(value) || containsRawFilesystemPath(value)) {
    throw new Error("Wiki memory contains a private coordinate or raw path");
  }
}

function containsRawFilesystemPath(value: unknown): boolean {
  return collectStrings(value).some((text) => RAW_ABSOLUTE_PATH.test(text));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
