import type { AgentTool } from "@earendil-works/pi-agent-core";
import { workspaceDigest } from "../host/execution-receipt.ts";
import { sessionDigestCache } from "../work/session-base.ts";
import type { PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import { clampToolResultText } from "../tools/model-result.ts";
import { sealProposal } from "../work/plan-seal.ts";
import { WORK_CLASSES, type WorkPlan } from "../work/schema.ts";
import { captureTrackedChanges } from "../work/verify.ts";

/**
 * `propose_plan` (interfaces-v2.md §2): the planning model's only way to seal
 * a work graph. The JSON schema carries the WorkPlan node types with every
 * optional field described in one line; the prompt never mentions them. The
 * result is data — findings `{check, node, fact}` or the sealed digest — so
 * the model iterates on facts, not advice.
 *
 * Session state is resolved the way model-loop-tools resolves it: the log and
 * workspace root come from the plugin context, and the workspace digest is a
 * lazy capability lookup because the receipt-digest provider registers after
 * this plugin. The tracked-tree baseline is captured at registration, which
 * is when the planning session begins.
 */

/** Capability key for the current workspace digest, provided by the receipt
 * substrate (T1's execution-receipt). Falls back to the execution-views
 * capture digest where that backend exists. */
type WorkspaceDigest = (root: string) => string;

interface ExecutionViewsCapture {
  capture(): { status: "retained"; digest: string } | { status: "unavailable"; reason: string };
}

const port = {
  type: "object",
  properties: {
    id: { type: "string", description: "Logical port name, lowercase slug." },
    kind: { type: "string", description: "Artifact shape, so a consumer cannot be fed another kind." },
  },
  required: ["id", "kind"],
  additionalProperties: false,
};

const parameters = {
  type: "object",
  properties: {
    goal: {
      type: "object",
      properties: {
        id: { type: "string" },
        statement: { type: "string", description: "Set by the host to the operator's order; you may omit it." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          class: { type: "string", enum: [...WORK_CLASSES], description: "The subsystem this todo works on." },
          priority: { type: "number" },
          blocked_by: { type: "array", items: { type: "string" }, description: "Todo ids that must finish first." },
          statement: { type: "string", description: "The one piece of the goal this todo delivers." },
          consumes: { type: "array", items: port, description: "Artifacts this todo needs; each must be produced by a todo it depends on." },
          produces: { type: "array", items: port, description: "Artifacts this todo makes; an id may have exactly one producer." },
          judgment: { type: "string", description: "Short display clause naming the acceptance signal; falls back to statement." },
          plan: { type: "string", description: "Short display clause naming the approach; falls back to case layers." },
          profile: { type: "string", description: "Tool profile for this todo's steps." },
        },
        required: ["id", "title", "class", "priority", "blocked_by", "statement"],
        additionalProperties: false,
      },
    },
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          todo: { type: "string", description: "Todo id this scenario belongs to." },
          given: { type: "string" },
          when: { type: "string" },
          then: { type: "string" },
        },
        required: ["id", "todo", "given", "when", "then"],
        additionalProperties: false,
      },
    },
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          scenario: { type: "string", description: "Scenario id this case proves." },
          layer: { type: "string", enum: ["unit", "contract", "replay"] },
          command: { type: "string", description: "One command that actually runs; only a case carries a verdict." },
          red_means: { type: "string", description: "Why the command fails now, recorded as the model's description." },
          green_means: { type: "string", description: "What the command passing means." },
          guard: { type: "boolean", description: "A standing invariant this case protects; expected to pass from the start." },
          evidence_level: { type: "string", enum: ["workspace_reported"], description: "Candidate text counts as weak evidence only when declared." },
          measurement: { type: "object", description: "Host-observed work, with independently checked output and typed bars." },
          host: { type: "string", description: "Operator-enrolled ssh alias naming where this case runs; absent means local." },
          dir: { type: "string", description: "Working directory for a host-bound case, applied on the remote side." },
          substrate: { type: "object", description: "Fidelity axes this case's claim depends on, as axis=level." },
          witness_for: { type: "object", description: "Axis to name of a positive number the run can only obtain by doing the work." },
          thresholds: { type: "object", description: "Named bars this gate is judged by, fixed before any run." },
          depends_on: { type: "array", items: { type: "string" }, description: "Path globs this case's verdict actually depends on, relative to its dir." },
          needs_memory_gb: { type: "number", description: "Gigabytes this case's run needs on its host." },
          local_accelerator: { type: "boolean", description: "This case uses this machine's accelerator, so it runs outside the sandbox." },
          min_duration_ms: { type: "number", description: "Floor on how long this case's run may take." },
          timeout_ms: { type: "number", description: "Absolute backstop for a run that never says anything conclusive." },
          done_when: { type: "string", description: "Output regex meaning the work finished." },
          failed_when: { type: "string", description: "Output regex meaning this run has already failed." },
          stall_after_ms: { type: "number", description: "Quiet this long with no completion signal means it is not coming." },
          telemetry_pattern: { type: "string", description: "Output regex whose match is this run's progress counter." },
        },
        required: ["id", "scenario", "layer", "command", "red_means", "green_means"],
        additionalProperties: false,
      },
    },
    runners: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Runner id, lowercase slug." },
          example: { type: "string", description: "Command shape shown in prompts and refusals." },
          invocations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                programs: { type: "array", items: { type: "string" }, description: "Accepted argv[0] basenames after normalization." },
                subcommand: { type: "array", items: { type: "string" }, description: "Tokens that must follow the program exactly." },
              },
              required: ["programs"],
              additionalProperties: false,
            },
            description: "A command matches the runner when one invocation matches its tokens.",
          },
          test_file: { type: "object", description: "Rule naming which token is the test file (extensions, dir segments, basenames)." },
          measurement_evaluator: { type: "string", description: "Reference to a host-enrolled evaluator; grants no authority." },
        },
        required: ["id", "invocations", "test_file"],
        additionalProperties: false,
      },
      description: "Declarative case-runner specs for commands no registered runner recognizes; sealed under work/runners/.",
    },
    delta: { type: "boolean", description: "Merge this proposal into the sealed graph instead of replacing it (default false)." },
  },
  required: ["goal", "todos", "scenarios", "cases"],
  additionalProperties: false,
};

export const plugin: PluginModule = {
  id: "plan-tools",
  claims: [
    // Optional consumers: this plugin registers before the tools provider and
    // the receipt substrate exist, so both are resolved lazily per call — the
    // same pattern model-loop-tools documents on its claims.
    { key: "workspace_digest", role: "consumer", optional: true },
    { key: "execution_views", role: "consumer", optional: true },
    { key: "tools", role: "consumer", optional: true },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
  ],
  register(ctx) {
    // The planning session begins at boot: the tracked-tree baseline the
    // immobility check compares every proposal against — the state of every
    // path tracked at the session's base, as the host's own listing reads it
    // (C1, D57e), never git's diff of an index the session writes.
    const baseline = captureTrackedChanges(ctx.workspaceRoot, ctx.log);

    // One cache per session: a file whose inode state (change time included)
    // has not moved since the host read it is not read again (execution-
    // receipt §1, D57d); its images cover what the session's base decides.
    const digestCache = sessionDigestCache(ctx.log, ctx.workspaceRoot);
    const currentDigest = (): string | undefined => {
      const capability = ctx.tryGet<WorkspaceDigest>("workspace_digest");
      if (capability) return capability(ctx.workspaceRoot);
      try {
        // The same function the receipt path binds into exec/receipt images,
        // so a receipt the model already earned matches instead of re-running.
        return workspaceDigest(ctx.workspaceRoot, digestCache);
      } catch {
        const captured = ctx.tryGet<ExecutionViewsCapture>("execution_views")?.capture();
        return captured?.status === "retained" ? captured.digest : undefined;
      }
    };

    // The red check no longer runs through the session bash tool: the seal
    // executes its cases through the host RED preflight (src/work/verify.ts),
    // which is the same sandboxed, earned-evidence path the drive loop uses.

    const proposePlan: AgentTool = {
      name: "propose_plan",
      label: "propose plan",
      description:
        "Propose a work graph for sealing. The host runs mechanical checks (shape, files, immobility, red, ports, obligations) and returns every finding as {check, node, fact} data; when nothing fires, the graph seals in the same call and execution begins.",
      parameters: parameters as never,
      async execute(toolCallId, params) {
        void toolCallId;
        const proposal = params as {
          goal?: unknown;
          todos?: unknown;
          scenarios?: unknown;
          cases?: unknown;
          runners?: unknown;
          delta?: unknown;
        };
        const plan = {
          goal: proposal.goal,
          todos: proposal.todos,
          scenarios: proposal.scenarios,
          cases: proposal.cases,
        } as WorkPlan;
        const digest = currentDigest();
        if (digest === undefined) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "unavailable", reason: "workspace_digest_unavailable" }) }],
            details: { error: true },
          };
        }
        const result = await sealProposal({
          log: ctx.log,
          workspaceRoot: ctx.workspaceRoot,
          plan,
          ...(Array.isArray(proposal.runners) ? { runners: proposal.runners as unknown[] } : {}),
          delta: proposal.delta === true,
          sessionStartRef: baseline,
        });
        // The outcome is recorded as the tool's own log row so the session
        // driver never parses the model-facing result text — the loop may
        // append its budget state line to that text (v2-t11).
        ctx.log.append({
          kind: "observe",
          name: "work/plan_proposal",
          payload:
            result.status === "findings"
              ? { findings: result.findings }
              : { sealed: result.digest, plan_path: result.plan_path },
        });
        return {
          content: [{ type: "text" as const, text: clampToolResultText(JSON.stringify(result)) }],
          details: { error: false },
        };
      },
    };

    const registry = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => {
      const dispose = registry.register(plugin.id, proposePlan);
      return () => {
        void dispose();
      };
    });
  },
};
