import { isRecoveryTerminalError } from "../host/recovery.ts";
import { recoveringWorkLoop } from "./recovery-loop.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import { readFailoverPolicyV1 } from "../host/config.ts";
import { deriveMessages } from "../host/derive-messages.ts";
import type { EventRecord } from "../host/schema.ts";
import { renderPrompt } from "./prompt-slots.ts";
import { observedFailureReason } from "./model-loop.ts";
import type { HostContext, SessionBudgetSnapshot } from "../loader/types.ts";
import type { WorkPlan } from "./schema.ts";

/**
 * The model-driven planning session (interfaces-v2.md §3): render
 * prompts/work/plan-v2.md with the order, hand the model the plan tool
 * surface, and stop when a plan seals, the budget ends, or three rounds
 * produce no progress. This mirrors driveModelLoop's mechanics — failover
 * refusal, budget observes, turn continuation via ctx.loop — but the only
 * host-authored text the model ever sees is the rendered prompt and the
 * budget line. No nextAction, no coaching prose: propose_plan returns
 * findings as data and the model iterates on facts.
 */

export interface PlanSessionBudget {
  /** Explicit minutes win. Absent, the session takes a share of the run's
   * remaining wall (the deadlineMs input): 40% for an initial plan, 25% for
   * a delta, capped at 20 minutes — also the fallback when no wall is
   * known. */
  minutes?: number;
  maxSteps?: number;
}

export type PlanSessionMode = "initial" | "delta";

export type PlanSessionResult =
  | { status: "sealed" }
  | { status: "unavailable" }
  | { status: "no_progress" }
  | {
      status: "provider_failure";
      /** The host's own refusal labels, or the failure class the episode
       * actually saw (e.g. "empty_completion") when the loop threw. */
      reason: "model_loop_requires_failover_off" | "route_transition_refused" | (string & {});
      steps: number;
    };

interface SealFinding {
  readonly check: string;
  readonly node: string;
  readonly fact: string;
}

const RECEIPT_EVENTS = new Set(["exec/receipt", "verify/receipt"]);
const NO_PROGRESS_ROUNDS = 3;

export async function runPlanSession(input: {
  ctx: HostContext;
  requireRecovery?: boolean;
  order: string;
  mode: PlanSessionMode;
  budget: PlanSessionBudget;
  /** The sealed graph a delta merges into (delta mode). */
  sealed?: WorkPlan;
  /** The verdict summary the drive loop already produces, shown in delta mode. */
  ledger?: string;
  /** The run's wall-clock deadline; sizes the session budget when minutes
   * are not explicit. */
  deadlineMs?: number;
}): Promise<PlanSessionResult> {
  const { ctx } = input;
  const log = ctx.log;
  if (!ctx.loop) throw new Error("plan session requires a loop facade (ctx.loop missing after load)");
  const loop = recoveringWorkLoop(ctx, ctx.loop, { unattended: true, requireRecovery: input.requireRecovery, order: input.order });

  const stepsUsed = (afterSeq: number): number =>
    log.events.filter((event) => event.seq > afterSeq && event.name === "model/usage").length;

  const recordResult = (result: PlanSessionResult): PlanSessionResult => {
    log.append({
      kind: "observe",
      name: "work/plan_result",
      payload: { status: result.status, ...(result.status === "provider_failure" ? { reason: result.reason } : {}) },
    });
    return result;
  };

  // One model judges, exactly as the model loop refuses: this session runs
  // only with the failover policy off (host/config.ts readFailoverPolicyV1).
  const failoverPolicy = readFailoverPolicyV1();
  if (failoverPolicy.mode !== "off") {
    return recordResult({
      status: "provider_failure",
      reason: "model_loop_requires_failover_off",
      steps: 0,
    });
  }

  // Seal-tool precondition (v2-t10): the prompt tells the model to seal with
  // propose_plan, so a session whose exposed tool surface lacks it can never
  // seal — refuse before the first model request instead of running to the
  // wall. The names come from the live tools provider; a resumed process
  // without one falls back to the latest tool/profile row. A surface that is
  // unknowable at all (v2-t10b) refuses too: the host always registers the
  // tools provider at boot, so an absent one is a regression, not a pass.
  const exposed = exposedToolNames(ctx, log.events);
  if (exposed === undefined || !exposed.includes("propose_plan")) {
    log.append({
      kind: "observe",
      name: "work/plan_unavailable",
      payload: {
        reason: exposed === undefined ? "seal_tools_unknown" : "seal_tool_not_exposed",
        missing_tools: ["propose_plan"],
      },
    });
    return recordResult({ status: "unavailable" });
  }

  // The effective session budget: explicit minutes win; otherwise a share of
  // the run's remaining wall — 40% for the initial plan, 25% for a delta —
  // capped at the 20-minute default, which is also the fallback when no wall
  // is known (§12 item 3).
  const wallSeconds = input.deadlineMs === undefined
    ? undefined
    : Math.max(0, (input.deadlineMs - Date.now()) / 1_000);
  const effectiveMinutes = input.budget.minutes
    ?? (wallSeconds === undefined
      ? 20
      : Math.min(20, ((input.mode === "initial" ? 0.40 : 0.25) * wallSeconds) / 60));

  // Session identity, recorded once: wall clock, the pinned route/model the
  // per-turn transition check defends, and the budget the session runs on.
  const sessionEvent = log.append({
    kind: "observe",
    name: "work/plan_session",
    payload: {
      mode: input.mode,
      route: ctx.llm?.activeName ?? "unknown",
      model: ctx.llm?.activeModelId ?? "unknown",
      failover: failoverPolicy.mode,
      budget: {
        minutes: round3(effectiveMinutes),
        ...(input.budget.maxSteps !== undefined ? { max_steps: input.budget.maxSteps } : {}),
      },
    },
  });
  const pinnedRoute = String(sessionEvent.payload.route);
  const pinnedModel = String(sessionEvent.payload.model);

  const budgetSeconds = effectiveMinutes * 60;
  const sessionStartMs = Date.parse(sessionEvent.ts);
  // The episode-level deadline the loop enforces: session start plus the
  // effective budget, on the same wall clock Date.now() reads.
  const sessionDeadlineMs = (Number.isFinite(sessionStartMs) ? sessionStartMs : Date.now()) + budgetSeconds * 1_000;
  const startedNs = process.hrtime.bigint();
  const elapsedSeconds = () =>
    Math.max(
      (Date.now() - (Number.isFinite(sessionStartMs) ? sessionStartMs : Date.now())) / 1_000,
      Number(process.hrtime.bigint() - startedNs) / 1e9,
    );

  // The rendered prompt is the only instruction the model gets. The mode
  // block names what this session is: a first plan, or a delta against the
  // sealed graph with the verdict ledger so far.
  const sealedDigest = latestGoalDigest(log.events) ?? digestPlan(input.sealed);
  const modeBlock =
    input.mode === "delta" && sealedDigest !== undefined
      ? `Delta to the sealed graph ${sealedDigest}; verdicts so far: ${input.ledger?.trim() || "none"}.`
      : "Initial plan.";
  const prompt = renderPrompt("work/plan-v2.md", {
    order: input.order,
    mode_block: modeBlock,
  });

  // No-progress signature (§3): the sealed-graph digest plus the set of
  // earned evidence — every receipt id tagged by whether it passed. Three
  // consecutive rounds with an identical signature mean the session is
  // spinning: the third round's request carries work/plan_no_progress and,
  // if the round still moves nothing, the session ends as no_progress.
  const progressSignature = (): string => {
    const evidence = log.events
      .filter((event) => RECEIPT_EVENTS.has(event.name) && typeof event.payload.id === "string")
      .map((event) => `${event.payload.id}:${event.payload.exit_code === 0 ? "0" : "x"}`)
      .sort();
    return `${latestGoalDigest(log.events) ?? ""}|${evidence.join(",")}`;
  };
  const signatures: string[] = [];

  let lastFindings: SealFinding[] = [];
  let firstTurn = true;

  for (;;) {
    const steps = stepsUsed(sessionEvent.seq);
    const remainingSeconds = budgetSeconds - elapsedSeconds();
    // Safety net only: the budget is enforced inside the episode — the
    // loop's sessionBudget observes work/plan_budget before every model
    // request and ends a runaway episode itself (v2-t8). This catches a
    // session that arrived at the turn boundary already spent.
    if (input.budget.maxSteps !== undefined && steps >= input.budget.maxSteps || elapsedSeconds() >= budgetSeconds) {
      log.append({
        kind: "observe",
        name: "work/plan_unavailable",
        payload: { last_findings: lastFindings },
      });
      return recordResult({ status: "unavailable" });
    }

    // Three rounds without a moved digest or a new receipt: say so on the
    // record before the third request, then judge the round's outcome.
    const stalled = signatures.length >= NO_PROGRESS_ROUNDS - 1
      && signatures.slice(-(NO_PROGRESS_ROUNDS - 1)).every((signature) => signature === progressSignature());
    if (stalled) {
      log.append({
        kind: "observe",
        name: "work/plan_no_progress",
        payload: { rounds: signatures.length + 1 },
      });
    }

    const before = log.events.length;
    const sessionBudget = {
      deadlineMs: sessionDeadlineMs,
      ...(input.budget.maxSteps !== undefined ? { maxRequests: input.budget.maxSteps } : {}),
      requestsSoFar: steps,
      observe: (state: SessionBudgetSnapshot) => {
        log.append({
          kind: "observe",
          name: "work/plan_budget",
          payload: {
            step: state.requests_used,
            remaining_seconds: round3(Math.max(0, state.remaining_seconds)),
            ...(input.budget.maxSteps !== undefined
              ? { steps_remaining: Math.max(0, state.requests_remaining ?? 0) }
              : {}),
          },
        });
      },
    };
    try {
      if (firstTurn) {
        await loop.prompt(prompt, { sessionBudget });
      } else {
        const lastRole = deriveMessages(log.events).at(-1)?.role;
        if ((lastRole === "user" || lastRole === "tool") && loop.resume) {
          await loop.resume({ sessionBudget });
        } else {
          await loop.prompt(budgetLine(remainingSeconds, input.budget, steps), { sessionBudget });
        }
      }
    } catch (error) {
      if (isRecoveryTerminalError(error)) throw error;
      return recordResult({
        status: "provider_failure",
        reason: observedFailureReason(log.events, sessionEvent.seq, error),
        steps: stepsUsed(sessionEvent.seq),
      });
    } finally {
      firstTurn = false;
    }

    // One model judges: a recorded move to another route/model ends the
    // session honestly instead of continuing on the intervening model.
    const intervened = log.events.some((event) => {
      if (event.seq <= sessionEvent.seq) return false;
      if (event.name !== "model/route_transition" && event.name !== "model/failover") return false;
      const target = transitionTarget(event);
      return target === undefined || target.route !== pinnedRoute || target.model !== pinnedModel;
    });
    if (intervened) {
      return recordResult({ status: "provider_failure", reason: "route_transition_refused", steps: stepsUsed(sessionEvent.seq) });
    }

    const appended = log.events.slice(before);

    // Seal detection, two ways: the binding bindPlan appends (a fresh
    // work/goal row), or propose_plan's own outcome row. Findings and seals
    // travel on the work/plan_proposal row the tool appends in its execute —
    // never on the model-facing result text, which the loop may extend with
    // its budget state line (v2-t11). A seal the row reports is recorded as
    // the session's own work/plan_sealed observe.
    for (const event of appended) {
      if (event.name !== "work/plan_proposal") continue;
      const payload = event.payload as { findings?: unknown; sealed?: unknown; plan_path?: unknown };
      if (Array.isArray(payload.findings)) {
        lastFindings = payload.findings.filter(isSealFinding);
      } else if (typeof payload.sealed === "string") {
        log.append({
          kind: "observe",
          name: "work/plan_sealed",
          payload: {
            digest: payload.sealed,
            plan_path: typeof payload.plan_path === "string" ? payload.plan_path : "",
          },
        });
      }
    }
    // Re-read from the same watermark: the work/plan_sealed observe above was
    // appended after `appended` was snapshotted.
    const sealed = log.events.slice(before).some((event) => event.name === "work/goal" || event.name === "work/plan_sealed");
    if (sealed) {
      return recordResult({ status: "sealed" });
    }

    // An episode the loop ended on the session budget is the session's own
    // exhausted stop; a seal above always wins over it.
    const budgetStop = appended.find(
      (event) => event.name === "loop/budget_exhausted" && event.payload.scope === "session",
    );
    if (budgetStop) {
      log.append({
        kind: "observe",
        name: "work/plan_unavailable",
        payload: {
          last_findings: lastFindings,
          reason: budgetStop.payload.reason === "deadline" ? "deadline" : "requests",
        },
      });
      return recordResult({ status: "unavailable" });
    }

    const signature = progressSignature();
    if (signatures.at(-1) === signature) {
      signatures.push(signature);
    } else {
      signatures.length = 0;
      signatures.push(signature);
    }
    if (stalled && signatures.length >= NO_PROGRESS_ROUNDS) {
      return recordResult({ status: "no_progress" });
    }
  }
}

/** The budget-only continuation line. It carries state, never instruction. */
function budgetLine(remainingSeconds: number, budget: PlanSessionBudget, steps: number): string {
  const stepsRemaining = budget.maxSteps !== undefined ? `${Math.max(0, budget.maxSteps - steps)}` : "unbounded";
  return `Budget: ${round3(Math.max(0, remainingSeconds))}s remaining, ${stepsRemaining} steps remaining. Continue.`;
}

/** The tool names this session actually exposes to the model: the live tools
 * provider when present, else the latest tool/profile row in the log; both
 * name the same surface the model would see. Undefined when neither is
 * knowable, in which case no precondition can be judged. */
function exposedToolNames(ctx: HostContext, events: readonly EventRecord[]): string[] | undefined {
  const tools = ctx.tryGet<readonly { name?: unknown }[]>("tools");
  if (Array.isArray(tools)) {
    return tools.filter((tool) => typeof tool?.name === "string").map((tool) => String(tool.name));
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "tool/profile" || !Array.isArray(event.payload.tools)) continue;
    const names = event.payload.tools.filter((name): name is string => typeof name === "string");
    if (names.length > 0) return names;
  }
  return undefined;
}

/** The digest of the newest sealed graph, from the work/goal row bindPlan
 * appends; undefined when nothing is sealed yet. */
function latestGoalDigest(events: readonly EventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name === "work/goal" && typeof event.payload.digest === "string") return event.payload.digest;
  }
  return undefined;
}

function digestPlan(plan: WorkPlan | undefined): string | undefined {
  if (!plan) return undefined;
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

function isSealFinding(value: unknown): value is SealFinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.check === "string" && typeof candidate.node === "string" && typeof candidate.fact === "string";
}

/** The target of a recorded transition row (model-loop's reader, unchanged):
 * payload.to on model/route_transition, transcript metadata on model/failover. */
function transitionTarget(event: EventRecord): { route: string; model: string } | undefined {
  if (event.name === "model/route_transition") {
    const to = event.payload.to as { route?: unknown; model?: unknown } | undefined;
    if (typeof to?.route === "string" && typeof to?.model === "string") return { route: to.route, model: to.model };
    return undefined;
  }
  const metadata = event.payload.metadata as { route?: unknown; model_id?: unknown } | undefined;
  if (typeof metadata?.route === "string" && typeof metadata?.model_id === "string") {
    return { route: metadata.route, model: metadata.model_id };
  }
  return undefined;
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
