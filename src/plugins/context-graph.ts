import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { clampToolResultText } from "../tools/model-result.ts";
import type { EventLog } from "../host/event-log.ts";
import type { HostContext, PluginModule, RequestContextContributionRegistry, ToolContributionRegistry } from "../loader/types.ts";
import type { ContextGraphService, LessonProposal } from "../context-graph/service.ts";
import { repositoryScopeOf } from "../context-graph/scope.ts";

type EventRef = { seq: number; hash: string };

/** The host-only capability key the desktop owner calls to import retained
 * parent lessons into this session's context graph (R8-03). */
export const BRANCH_CONTEXT_IMPORT_CAPABILITY = "branch_context_import";

/** The host-only capability key exposing this session's ACTUAL registered
 * ContextGraphService to trusted desktop hosts (R8-05): the branch runtime
 * reads it for the authenticated lesson import and the mutable dispatch
 * readiness guard. It is a separately declared service capability, not a
 * model tool, and adds no loop branch. */
export const CONTEXT_GRAPH_SERVICE_CAPABILITY = "context_graph_service";

/** The rollout switch, read here without loading the context graph: with the
 * feature off nothing of it is even imported (G6). */
function contextGraphMode(env: NodeJS.Dict<string> = process.env): "off" | "shadow" | "on" {
  const value = env.DOKKABI_CONTEXT_GRAPH?.trim().toLowerCase();
  return value === "shadow" || value === "on" ? value : "off";
}

/**
 * #227 — the context graph plugin (CG-01..CG-05).
 *
 * The rollout switch is DOKKABI_CONTEXT_GRAPH (TS-28 §15): `off` (the
 * default) skips the plugin at activation — nothing registers, nothing is
 * recorded, the loop behaves as before; `shadow` registers the request-context
 * contribution only, so frames are selected and recorded (`context/frame`,
 * mode shadow) but never reach the provider and the tool surface is the same
 * as off; `on` also appends each frame to the transcript as recorded
 * host-context bytes and mounts `lesson_record` and `context_query` beside
 * the ledger tools. Projection needs only the EventLog: no MAEK, no DuckDB,
 * no Wiki (G6, C21).
 */

const EVENT_REF_SCHEMA = {
  type: "object",
  properties: {
    seq: { type: "integer", description: "The row's sequence number in this session's log." },
    hash: { type: "string", description: "The row's hash (64 hex)." },
  },
  required: ["seq", "hash"],
  additionalProperties: false,
};

const LESSON_RECORD_DESCRIPTION =
  "Record what a failed (or surprising) attempt taught, as a conditional lesson the host shows in later requests of this goal. "
  + "Cite the rows it rests on by {seq, hash} — tool calls, tool results, receipts, checks of THIS session and goal; context_query and the context frame expose citable references. "
  + "The host checks every reference and records the lesson as `proposed`; it never judges whether your explanation is true. "
  + "To revise a lesson pass `lesson` and the `revision` you read with a new `statement`. Name the calls of the attempt (`attempt.actions`): "
  + "if one of them was a check (or another host-judged run) that came out RED, that run is the lesson's observable, and the host itself "
  + "records whether a later judged run of that same command is red again (corroborated) or green (contested). You cannot assess a lesson. "
  + "A lesson is never a ban: retrying is allowed, and a frame shows whether the conditions changed. A refused record changes nothing; keep working.";

const CONTEXT_QUERY_DESCRIPTION =
  "Read this goal's context graph: recent current-scope actions with call/result/end hashes, unresolved failures, and exact named nodes (lesson-N, act:N, att-N) with their history. The question is an audit label, not semantic search. "
  + "Reference data from this session's log, bounded; it grants no new authority.";

function textResult(text: string, error = false) {
  return { content: [{ type: "text" as const, text: clampToolResultText(text) }], details: { error } };
}

function eventRefs(value: unknown): EventRef[] | unknown {
  return value;
}

export function createLessonRecordTool(service: ContextGraphService): AgentTool {
  return {
    name: "lesson_record",
    label: "lesson record",
    description: LESSON_RECORD_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The lesson, stated conditionally (what failed, under which conditions, what to check before retrying)." },
        evidence: { type: "array", items: EVENT_REF_SCHEMA, description: "The rows the lesson rests on." },
        lesson: { type: "string", description: "An existing lesson id (lesson-N) to revise or assess." },
        revision: { type: "integer", description: "The revision of `lesson` you read (stale revisions are refused)." },
        supersedes: { type: "string", description: "Another lesson id this lesson replaces (its history is kept)." },
        condition: { type: "string", description: "When the lesson applies." },
        resources: { type: "array", items: { type: "string" }, description: "Actual workspace file paths the lesson depends on. Environment or API descriptions are not file paths; declare incomplete coverage when unsupported conditions are required." },
        dependency_coverage: { type: "string", enum: ["declared", "incomplete"], description: "Whether `resources` covers everything the lesson depends on." },
        retry_conditions: { type: "array", items: { type: "string" }, description: "What would justify retrying the same approach." },
        invalidation_conditions: { type: "array", items: { type: "string" }, description: "What would make the lesson wrong." },
        repository_wide: { type: "boolean", description: "Scope the lesson to the repository instead of the current goal." },
        attempt: {
          type: "object",
          description: "The attempt this lesson came from (optional).",
          properties: {
            question: { type: "string" },
            expected: { type: "string" },
            outcome: { type: "string", enum: ["open", "met", "not_met", "inconclusive", "interrupted"] },
            actions: { type: "array", items: EVENT_REF_SCHEMA, description: "The tool/call rows of the attempt." },
            previous_attempt: { type: "string", description: "The attempt (att-N) this one retries." },
            changed_conditions: { type: "array", items: EVENT_REF_SCHEMA, description: "Rows showing what changed since the previous attempt." },
            changed_approach: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["evidence"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const p = (params ?? {}) as Record<string, unknown>;
      const attempt = p.attempt as Record<string, unknown> | undefined;
      const proposal: LessonProposal = {
        evidence: eventRefs(p.evidence) as EventRef[],
        ...(p.statement === undefined ? {} : { statement: p.statement as string }),
        ...(p.lesson === undefined ? {} : { lesson: p.lesson as string }),
        ...(p.revision === undefined ? {} : { revision: p.revision as number }),
        ...(p.supersedes === undefined ? {} : { supersedes: p.supersedes as string }),
        ...(p.condition === undefined ? {} : { condition: p.condition as string }),
        ...(p.resources === undefined ? {} : { resources: p.resources as string[] }),
        ...(p.dependency_coverage === undefined ? {} : { dependencyCoverage: p.dependency_coverage as "declared" | "incomplete" }),
        ...(p.retry_conditions === undefined ? {} : { retryConditions: p.retry_conditions as string[] }),
        ...(p.invalidation_conditions === undefined ? {} : { invalidationConditions: p.invalidation_conditions as string[] }),
        ...(p.repository_wide === true ? { repositoryWide: true } : {}),
        ...(attempt === undefined ? {} : { attempt: {
          ...(attempt.question === undefined ? {} : { question: attempt.question as string }),
          ...(attempt.expected === undefined ? {} : { expected: attempt.expected as string }),
          ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome as "open" }),
          ...(attempt.actions === undefined ? {} : { actions: attempt.actions as EventRef[] }),
          ...(attempt.previous_attempt === undefined ? {} : { previousAttempt: attempt.previous_attempt as string }),
          ...(attempt.changed_conditions === undefined ? {} : { changedConditions: attempt.changed_conditions as EventRef[] }),
          ...(attempt.changed_approach === undefined ? {} : { changedApproach: attempt.changed_approach as string }),
        } }),
      };
      const result = service.recordLesson(proposal);
      if (result.status === "not_recorded") {
        // Data, not a tool failure: nothing was recorded and the session goes on.
        return textResult(`not_recorded (${result.reason}): ${result.detail}. Nothing was recorded; continue working.`);
      }
      return textResult(result.kind === "assessment"
        ? `assessment of ${result.lessonId} r${result.revision} recorded at seq ${result.event.seq}; the lesson's state is derived from assessments that cite new observations`
        : `${result.lessonId} r${result.revision} recorded at seq ${result.event.seq} as proposed; the host checked its references, not its truth`);
    },
  };
}

export function createContextQueryTool(service: ContextGraphService): AgentTool {
  return {
    name: "context_query",
    label: "context query",
    description: CONTEXT_QUERY_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Audit label recorded as a digest, not semantic search. The response lists bounded current-scope actions with citable event hashes; use nodes for exact inspection." },
        nodes: { type: "array", items: { type: "string" }, description: "Node ids from a frame: lesson-N, act:N, att-N." },
        max_bytes: { type: "integer", description: "Result bound in bytes (1024..16384, default 8192)." },
      },
      required: ["question"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const p = (params ?? {}) as { question?: unknown; nodes?: unknown; max_bytes?: unknown };
      if (typeof p.question !== "string") return textResult("context_query: question is required", true);
      const nodes = Array.isArray(p.nodes) ? p.nodes.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
      const result = service.query({ question: p.question, nodeIds: nodes, ...(typeof p.max_bytes === "number" ? { maxBytes: p.max_bytes } : {}) });
      return textResult(result.text);
    },
  };
}

/** §130 S1: the session's repository scope — the identity of the ROOT the
 * session works on (its device and inode, which no path spelling changes),
 * bound to the base record the log names (63581f7: the host's own record of
 * the tree at the session's start). Never `unidentified`: two unrelated
 * workspaces are two scopes, and a log resumed on another root is a new scope
 * whose frames exclude everything of the old one. The derivation itself is
 * shared with the branch-context prepare-boundary refresh
 * (context-graph/branch-context.ts `repositoryScopeOf`). */
export function repositoryScope(log: EventLog, workspaceRoot: string): { id: string; source: "base_record" | "root_inode" } {
  const scope = repositoryScopeOf(log, workspaceRoot);
  if (scope === undefined) {
    const root = statSync(realpathSync(resolve(workspaceRoot)), { bigint: true });
    throw new Error(`repository scope of ${workspaceRoot} cannot be derived (dev ${root.dev}, ino ${root.ino})`);
  }
  return scope;
}

async function createContextGraphService(log: EventLog, mode: "shadow" | "on", workspaceRoot: string): Promise<ContextGraphService> {
  const { ContextGraphService: Service } = await import("../context-graph/service.ts");
  return new Service({ log, mode, workspaceRoot });
}

export const plugin: PluginModule = {
  id: "context-graph",
  claims: [
    { key: "request_context_contributions", role: "consumer" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: BRANCH_CONTEXT_IMPORT_CAPABILITY, role: "definition" },
    { key: BRANCH_CONTEXT_IMPORT_CAPABILITY, role: "provider" },
    { key: CONTEXT_GRAPH_SERVICE_CAPABILITY, role: "definition" },
    { key: CONTEXT_GRAPH_SERVICE_CAPABILITY, role: "provider" },
  ],
  activate() {
    // Off by default: an option the operator has not turned on, reported as
    // such (#230 D1) — `disabled`, optional, never an unknown required row.
    return contextGraphMode() === "off"
      ? { active: false, reason: "DOKKABI_CONTEXT_GRAPH is off", kind: "not_configured" }
      : { active: true };
  },
  async register(ctx: HostContext) {
    const mode = contextGraphMode();
    if (mode === "off") return;
    const service = await createContextGraphService(ctx.log, mode, ctx.workspaceRoot);
    const scope = repositoryScope(ctx.log, ctx.workspaceRoot);
    service.recordScope(scope.id, scope.source);
    const registry = ctx.inject<RequestContextContributionRegistry>("request_context_contributions");
    ctx.effect(() => registry.register(plugin.id, service.contribution()));
    // R8-03: the host-only branch-context import capability for this
    // session's registered service. It is not a model tool and adds no loop
    // branch: the owner (the desktop checkpoint host) supplies the actual
    // branch workspace service and calls this when the child is ready. The
    // writer module loads here, lazily, like the service above (G6).
    const { importCheckpointLessons } = await import("../context-graph/branch-context.ts");
    ctx.define(BRANCH_CONTEXT_IMPORT_CAPABILITY, {
      visibility: "host_only",
      format: 1,
      feature: "branch-context-v1",
      mutations: ["import_lessons"],
    });
    ctx.provide(BRANCH_CONTEXT_IMPORT_CAPABILITY, {
      importCheckpointLessons: (request: unknown) => importCheckpointLessons(service, request),
    });
    // R8-05: the actual registered service itself, host-only — the trusted
    // desktop branch boundary consumes it for the authenticated lesson
    // import and the mutable dispatch readiness guard. No model tool.
    ctx.define(CONTEXT_GRAPH_SERVICE_CAPABILITY, {
      visibility: "host_only",
      format: 1,
      read: "verified_fold",
    });
    ctx.provide(CONTEXT_GRAPH_SERVICE_CAPABILITY, service);
    if (mode === "on") {
      const tools = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
      const contributed = [createLessonRecordTool(service), createContextQueryTool(service)];
      ctx.effect(() => {
        const disposers = contributed.map((tool) => tools.register(plugin.id, tool));
        return () => { for (const dispose of disposers) dispose(); };
      });
    }
  },
};
