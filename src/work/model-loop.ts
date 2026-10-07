import { isRecoveryTerminalError } from "../host/recovery.ts";
import { recoveringWorkLoop } from "./recovery-loop.ts";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { BlobStore } from "../host/blob-store.ts";
import { observedSecretDigests } from "../host/redact.ts";
import { normalizeModelFailureV1 } from "../host/model-failover.ts";
import { readFailoverPolicyV1 } from "../host/config.ts";
import { deriveMessages } from "../host/derive-messages.ts";
import type { EventRecord } from "../host/schema.ts";
import { systemPromptHash } from "../host/prefix.ts";
import type { HostContext, LoopFacade, SessionBudgetSnapshot } from "../loader/types.ts";
import { operatorInboxPath, takeOperatorInbox, withOperatorNotes } from "./inbox.ts";

/**
 * The model-driven work loop (interfaces.md §4): the operator's order is
 * sealed once, then the model works until it finishes or the budget ends. The
 * only host decisions in here are the budget checks and the finish verdict;
 * nothing in this module tells the model how to work. No nextAction, no
 * phases, no stage prompts — those stay with the graph loop (driveWork).
 *
 * Budgets are read from the log, so they survive restarts: steps count
 * observe.model_usage rows, tokens sum them, and seconds are wall clock from
 * the work/loop event (monotonic within a process via hrtime).
 */

export interface ModelLoopBudget {
  hours: number;
  maxSteps?: number;
  maxTokens?: number;
}

export type ModelLoopMode = "unattended" | "attended";

/** The reason a thrown episode failure is labelled with: the failure class the
 * loop itself observed (the latest agent/status {status:"failed"} row of the
 * episode), or the normalized reason of the thrown error, never a guess. */
export function observedFailureReason(events: readonly EventRecord[], afterSeq: number, error: unknown): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.seq <= afterSeq) break;
    if (event.name === "agent/status" && event.payload?.status === "failed" && typeof event.payload.error === "string") {
      return event.payload.error;
    }
  }
  return normalizeModelFailureV1({ error }).reasonCode;
}


export type ModelLoopStopReason =
  | "finish_supported"
  | "finish_unsupported"
  | "budget_seconds"
  | "budget_steps"
  | "budget_tokens"
  | "operator_stop"
  | "provider_failure";

export interface ModelLoopResult {
  stopReason: ModelLoopStopReason;
  steps: number;
  seconds: number;
  verdict?: "supported" | "unsupported";
  finish?: { seq: number; hash: string };
  /** The typed cause of a provider_failure: the host's own refusal (the run
   * never started, or a recorded transition to another route/model ended it)
   * or the failure class the episode actually saw when the loop threw
   * (e.g. "empty_completion"). */
  reason?:
    | "model_loop_requires_failover_off"
    | "route_transition_refused"
    | "finish_tool_not_exposed"
    | "finish_tools_unknown"
    | (string & {});
}

type ModelLoopTurnOptions = Parameters<LoopFacade["prompt"]>[1];

interface ModelLoopUsage {
  steps: number;
  tokens: { input: number; output: number; reasoning: number; cache_read: number };
}

export async function driveModelLoop(input: {
  ctx: HostContext;
  requireRecovery?: boolean;
  order: string;
  budget: ModelLoopBudget;
  /** v1 records no driver decision on mode; the ask_operator tool owns the
   * attended/unattended behaviour. Kept in the signature per the contract. */
  mode: ModelLoopMode;
  /** Passed through to every prompt/resume call (modelId, thinkingLevel,
   * onAssistant). The contract fixes the events, not the turn knobs. */
  turn?: ModelLoopTurnOptions;
  /** The run's wall-clock deadline (the supervisor ceiling, when one is
   * set); caps the episode deadline the loop enforces. */
  deadlineMs?: number;
}): Promise<ModelLoopResult> {
  const { ctx } = input;
  const log = ctx.log;
  if (!ctx.loop) throw new Error("model loop requires a loop facade (ctx.loop missing after load)");
  const loop = recoveringWorkLoop(ctx, ctx.loop, { unattended: input.mode === "unattended", requireRecovery: input.requireRecovery, order: input.order, ...(input.budget.hours > 0 ? { defaultBudgetMs: input.budget.hours * 3_600_000 } : {}) });

  const recordResult = (result: ModelLoopResult): ModelLoopResult => {
    log.append({
      kind: "observe",
      name: "work/model_loop_result",
      payload: {
        stop_reason: result.stopReason,
        steps: result.steps,
        seconds: result.seconds,
        ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
        ...(result.finish !== undefined ? { finish: result.finish } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      },
    });
    return result;
  };

  // One model judges (interfaces.md §4): this loop runs only with the
  // failover policy off. The policy lives in the operator config
  // (host/config.ts readFailoverPolicyV1) and model-resilience re-reads it on
  // every failure — there is no per-session pin — so a non-off policy
  // refuses the run up front rather than letting another model in mid-run.
  const failoverPolicy = readFailoverPolicyV1();
  if (failoverPolicy.mode !== "off") {
    const priorLoop = log.events.find((event) => event.name === "work/loop");
    const refused: ModelLoopResult = {
      stopReason: "provider_failure",
      steps: modelLoopUsage(log.events).steps,
      seconds: priorLoop ? round3(Math.max(0, (Date.now() - Date.parse(priorLoop.ts)) / 1_000)) : 0,
      reason: "model_loop_requires_failover_off",
    };
    return recordResult(refused);
  }

  // Finish-tool precondition (v2-t10): the only honest end to this loop is
  // the finish tool, so a session whose exposed tool surface lacks it can
  // never finish — refuse before the first model request instead of running
  // to the budget wall. The names come from the live tools provider; a
  // resumed process without one falls back to the latest tool/profile row.
  // A surface that is unknowable at all (v2-t10b) refuses too: the host
  // always registers the tools provider at boot, so an absent one is a
  // regression, not a pass.
  const exposed = exposedToolNames(ctx, log.events);
  if (exposed === undefined || !exposed.includes("finish")) {
    const refused: ModelLoopResult = {
      stopReason: "provider_failure",
      steps: 0,
      seconds: 0,
      reason: exposed === undefined ? "finish_tools_unknown" : "finish_tool_not_exposed",
    };
    return recordResult(refused);
  }

  // 1. The order is sealed once and immutable: a resume reuses an identical
  // one, a differing one is refused before anything is appended.
  const sealedOrder = log.events.find((event) => event.name === "work/order");
  let fresh = false;
  if (sealedOrder) {
    const digest = sha256(input.order);
    if (input.order.trim().length > 0 && sealedOrder.payload.digest !== digest) {
      throw new Error(
        `work/order refused: this session already sealed a different order (${String(sealedOrder.payload.digest).slice(0, 12)}…)`,
      );
    }
  } else {
    if (input.order.trim().length === 0) {
      throw new Error("model loop requires an order: none given and none sealed in this session");
    }
    const blob = BlobStore.forSession(log.path).put(input.order);
    const observed = observedSecretDigests(input.order);
    log.append({
      kind: "observe",
      name: "work/order",
      // The order is READ by the session. A credential value it names is the
      // operator's, so the model cannot author it by repeating it (D36).
      payload: { blob, blob_bytes: Buffer.byteLength(input.order), digest: blob,
        ...(observed.length === 0 ? {} : { observed_secret_digests: observed }) },
    });
    fresh = true;
  }

  // 2. The loop identity is recorded once, after boot and seal. A resumed
  // session already carries it. The route, model and failover mode pin the
  // one working model for the whole run: any recorded move to another
  // route or model ends the run (the per-turn check below).
  let loopEvent = log.events.find((event) => event.name === "work/loop");
  if (!loopEvent) {
    loopEvent = log.append({
      kind: "observe",
      name: "work/loop",
      payload: {
        loop: "model",
        route: ctx.llm?.activeName ?? "unknown",
        model: ctx.llm?.activeModelId ?? "unknown",
        failover: failoverPolicy.mode,
        manifest_digest: manifestDigest(log.events),
        prompt_digest: systemPromptHash(ctx.systemPrompt),
        budget: {
          hours: input.budget.hours,
          ...(input.budget.maxSteps !== undefined ? { max_steps: input.budget.maxSteps } : {}),
          ...(input.budget.maxTokens !== undefined ? { max_tokens: input.budget.maxTokens } : {}),
        },
      },
    });
  }
  const pinnedRoute = String(loopEvent.payload.route ?? "unknown");
  const pinnedModel = String(loopEvent.payload.model ?? "unknown");

  const budgetSeconds = input.budget.hours * 3_600;
  const loopStartMs = Date.parse(loopEvent.ts);
  // The episode-level deadline the loop enforces: the loop's own wall, capped
  // by the run's wall when the caller knows one (the supervisor ceiling).
  const loopDeadlineMs = [
    (Number.isFinite(loopStartMs) ? loopStartMs : Date.now()) + budgetSeconds * 1_000,
    ...(input.deadlineMs !== undefined ? [input.deadlineMs] : []),
  ].reduce((a, b) => Math.min(a, b));
  const startedNs = process.hrtime.bigint();
  // Wall clock since the loop was born covers restarts; hrtime keeps the
  // reading monotonic (and sub-millisecond) inside one process.
  const elapsedSeconds = () =>
    Math.max(
      (Date.now() - (Number.isFinite(loopStartMs) ? loopStartMs : Date.now())) / 1_000,
      Number(process.hrtime.bigint() - startedNs) / 1e9,
    );
  const inboxPath = operatorInboxPath(dirname(log.path));
  const orderDelivered = () => log.events.some((event) => event.name === "user/message");
  let firstTurn = true;

  const finish = (stopReason: ModelLoopStopReason, extra: Partial<ModelLoopResult> = {}): ModelLoopResult => {
    const usage = modelLoopUsage(log.events);
    return recordResult({
      stopReason,
      steps: usage.steps,
      seconds: round3(elapsedSeconds()),
      ...extra,
    });
  };

  const appendBudget = (step: number, remainingSeconds: number, tokens: ModelLoopUsage["tokens"]): void => {
    log.append({
      kind: "observe",
      name: "work/budget",
      payload: {
        step,
        remaining_seconds: round3(Math.max(0, remainingSeconds)),
        ...(input.budget.maxSteps !== undefined
          ? { steps_remaining: Math.max(0, input.budget.maxSteps - step) }
          : {}),
        tokens,
      },
    });
  };

  // 3. The loop: budget check, one model turn, finish check. The budget
  // observe moved into the episode (v2-t8): the loop's sessionBudget reports
  // before every model request, so a model that never stops is still
  // budgeted. The checks below are the safety net for a turn the loop
  // arrived at already spent, and still say so on the record.
  for (;;) {
    const elapsed = elapsedSeconds();
    const usage = modelLoopUsage(log.events);
    const remainingSeconds = budgetSeconds - elapsed;
    const tokensUsed = usage.tokens.input + usage.tokens.output + usage.tokens.reasoning + usage.tokens.cache_read;
    const spent = elapsed >= budgetSeconds
      || (input.budget.maxSteps !== undefined && usage.steps >= input.budget.maxSteps)
      || (input.budget.maxTokens !== undefined && tokensUsed >= input.budget.maxTokens);
    if (spent) {
      appendBudget(usage.steps, Math.max(0, remainingSeconds), usage.tokens);
      if (elapsed >= budgetSeconds) return finish("budget_seconds");
      if (input.budget.maxSteps !== undefined && usage.steps >= input.budget.maxSteps) return finish("budget_steps");
      if (input.budget.maxTokens !== undefined && tokensUsed >= input.budget.maxTokens) return finish("budget_tokens");
    }

    const before = log.events.length;
    const inbox = takeOperatorInbox(inboxPath);
    const sessionBudget = {
      deadlineMs: loopDeadlineMs,
      ...(input.budget.maxSteps !== undefined ? { maxRequests: input.budget.maxSteps } : {}),
      requestsSoFar: usage.steps,
      observe: (state: SessionBudgetSnapshot) => {
        appendBudget(state.requests_used, state.remaining_seconds, modelLoopUsage(log.events).tokens);
      },
    };
    try {
      if (firstTurn && fresh) {
        await loop.prompt(withOperatorNotes(inbox.notes, input.order), { ...input.turn, sessionBudget });
      } else if (firstTurn && !orderDelivered()) {
        // The order was sealed but a crash took the process before the first
        // turn: deliver it now rather than continuing from nothing.
        await loop.prompt(withOperatorNotes(inbox.notes, input.order), { ...input.turn, sessionBudget });
      } else if (inbox.notes.length > 0) {
        await loop.prompt(withOperatorNotes(inbox.notes, budgetLine(remainingSeconds, input.budget, usage.steps, tokensUsed)), { ...input.turn, sessionBudget });
      } else {
        const lastRole = deriveMessages(log.events).at(-1)?.role;
        if (lastRole === "user" || lastRole === "tool") {
          // A stop mid-turn leaves a user/toolResult suffix: continue without
          // appending another operator message.
          if (loop.resume) await loop.resume({ ...input.turn, sessionBudget });
          else await loop.prompt(budgetLine(remainingSeconds, input.budget, usage.steps, tokensUsed), { ...input.turn, sessionBudget });
        } else {
          // pi cannot continue() from an assistant suffix, so the "nothing
          // new" turn is a budget-only line — no new instruction.
          await loop.prompt(budgetLine(remainingSeconds, input.budget, usage.steps, tokensUsed), { ...input.turn, sessionBudget });
        }
      }
      inbox.commit();
    } catch (error) {
      inbox.rollback();
      if (isRecoveryTerminalError(error)) throw error;
      return finish("provider_failure", { reason: observedFailureReason(log.events, loopEvent.seq, error) });
    } finally {
      firstTurn = false;
    }

    // One model judges: a transition row that names another route or model
    // means a second model entered the run. End honestly as provider_failure
    // — resumable later on the pinned route and model — instead of continuing
    // on the intervening one. The scan starts at the sealed work/loop row, not
    // at this turn, so a transition persisted by an earlier process and
    // resumed into cannot slip past the check.
    const intervened = log.events.filter((event) => event.seq > loopEvent.seq).some((event) => {
      if (event.name !== "model/route_transition" && event.name !== "model/failover") return false;
      const target = transitionTarget(event);
      return target === undefined || target.route !== pinnedRoute || target.model !== pinnedModel;
    });
    if (intervened) return finish("provider_failure", { reason: "route_transition_refused" });

    const finished = log.events.slice(before).find((event) => event.name === "work/finish");
    if (finished) {
      const verdict = finished.payload.verdict === "supported" ? "supported" : "unsupported";
      return finish(verdict === "supported" ? "finish_supported" : "finish_unsupported", {
        verdict,
        finish: { seq: finished.seq, hash: finished.hash },
      });
    }

    // An episode the loop ended on the session budget maps to the loop's own
    // stop reasons; a finish above always wins over it.
    const budgetStop = log.events.slice(before).find(
      (event) => event.name === "loop/budget_exhausted" && event.payload.scope === "session",
    );
    if (budgetStop) {
      return finish(budgetStop.payload.reason === "deadline" ? "budget_seconds" : "budget_steps");
    }
  }
}

/** The budget-only continuation line. It carries state, never instruction. */
function budgetLine(remainingSeconds: number, budget: ModelLoopBudget, steps: number, tokensUsed: number): string {
  const stepsRemaining = budget.maxSteps !== undefined ? `${Math.max(0, budget.maxSteps - steps)}` : "unbounded";
  return `Budget: ${round3(Math.max(0, remainingSeconds))}s remaining, ${stepsRemaining} steps remaining, ${tokensUsed} tokens used. Continue.`;
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

/** Steps and tokens are model requests, counted from observe.model_usage rows
 * (token numbers live only on observe.model_usage — host/schema.ts). */
function modelLoopUsage(events: readonly EventRecord[]): ModelLoopUsage {
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0 };
  let steps = 0;
  for (const event of events) {
    if (event.name !== "model/usage") continue;
    steps += 1;
    const row = event.observe?.model_usage;
    tokens.input += metric(row?.input_tokens);
    tokens.output += metric(row?.output_tokens);
    tokens.reasoning += metric(row?.reasoning_tokens);
    tokens.cache_read += metric(row?.cache_read_tokens);
  }
  return { steps, tokens };
}

function metric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The target of a recorded transition row, whichever name carried it:
 * model/route_transition keeps it in payload.to, model/failover in the
 * transcript metadata (plugins/loop-pi.ts). */
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

/** The manifest identity is a boot fact; the driver cites it from the log. */
function manifestDigest(events: readonly EventRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name === "session/open" && typeof event.payload.plugin_manifest_digest === "string") {
      return event.payload.plugin_manifest_digest;
    }
  }
  return "unknown";
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
