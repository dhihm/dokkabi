import type { EventLog } from "../host/event-log.ts";
import type { DriveResult } from "./drive.ts";
import { formatIncompleteWorkReport } from "./report.ts";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ToolBudgetFinalizerCall } from "../loader/types.ts";
import type { ToolScope } from "../loader/tool-profiles.ts";
import { thinkingBudgetsForLevel } from "../host/thinking.ts";
import {
  buildGatePrompt,
  buildGateReplyPrompt,
  buildGateRetryPrompt,
  buildOperatorReplyPrompt,
  parseGateDecision,
  stripDecisionLine,
} from "./prompt.ts";
import {
  reportEvidence,
  streamFinalChunk,
  type VoiceLoop,
} from "./turn-support.ts";

export { acceptanceSpecTurn, acceptTurn } from "./accept-turn.ts";
export type { AcceptVerdict } from "./accept-turn.ts";
export { RATE_LIMIT_BACKOFF_MS, backoffBetween, withTransientRetry } from "./turn-support.ts";
export type { TransientRetryOptions, VoiceLoop } from "./turn-support.ts";

export interface ModelVoices {
  /** Operator-facing turns (brief, reply): the model's text reaches the terminal. */
  speak(text: string, modelId?: string): Promise<void>;
  /** Work turns (decompose, implement, replan): EventLog only, never printed. */
  work(text: string, modelId?: string, options?: WorkTurnOptions): Promise<void>;
}

export interface WorkTurnOptions {
  readonly timeoutMs?: number;
  readonly timeoutPolicy?: "fail" | "continue";
  readonly thinkingBudgets?: ThinkingBudgets;
  readonly maxOutputTokens?: number;
  readonly maxToolCalls?: number;
  readonly toolBudgetFinalizers?: readonly string[];
  readonly toolBudgetFinalizerCalls?: readonly ToolBudgetFinalizerCall[];
  readonly toolScope?: ToolScope;
}

/**
 * Default work-turn budgets.
 *
 * The turn owns only its cooperative clock. The output allowance and the
 * thinking policy come from the resolved model and the operator's selected
 * effort, exactly as ordinary final review already does. A fixed phase cap
 * once starved an adaptive provider: each 4,096-token request spent
 * essentially the whole allowance in reasoning and stopped at length with
 * empty visible output, on every retry, because such a provider cannot
 * reserve reasoning tokens inside a caller-chosen ceiling and an explicit
 * High effort rightly refuses the default-only relief that would lower
 * thinking. A caller that supplies an explicit cap or numeric thinking
 * budgets still gets them unchanged.
 */
export const DEFAULT_WORK_TURN_OPTIONS = {
  timeoutMs: 300_000,
  timeoutPolicy: "continue",
} as const satisfies WorkTurnOptions;

/**
 * The decompose turn's exploration boundary.
 *
 * Sixteen calls and the write/edit finalizers bound how much of the workspace
 * the turn may touch before it must write the ledger; a host-bound enablement
 * raises them through DOKKABI_DECOMPOSE_TOOL_CALLS. The output allowance and
 * thinking policy are deliberately absent: the turn inherits the resolved
 * model's allowance and the operator's selected effort, for the same adaptive
 * starvation DEFAULT_WORK_TURN_OPTIONS records. The same fixed four-thousand
 * cap that truncated a long host-bound ledger also left nothing visible after
 * reasoning. DOKKABI_DECOMPOSE_OUTPUT_TOKENS remains the operator's ceiling.
 */
export const DECOMPOSE_WORK_OPTIONS = {
  timeoutMs: 300_000,
  timeoutPolicy: "continue",
  maxToolCalls: 16,
  toolBudgetFinalizers: ["write", "edit"],
} as const satisfies WorkTurnOptions;
/**
 * The decompose turn's operator overrides.
 *
 * The clock needed a door. A decompose turn that reads a host-bound tree
 * spends its slice discovering before it can write, and the write is the one
 * thing the turn exists to do — so running out mid-exploration costs the whole
 * run, not a retry. One live enablement aborted at 300s with the model saying
 * "I have enough information to write the plan", then aborted again at the
 * repair turn's 120s saying "Writing the work plan now"; the ledger was never
 * written and the run ended with `work/current.json is missing`.
 * DOKKABI_DECOMPOSE_TIMEOUT_MS raises both, because a repair turn that
 * inherits a short clock fails the same way the turn it is repairing did.
 *
 * The output cap is an operator ceiling on top of the resolved model's
 * allowance, not a phase default: DOKKABI_DECOMPOSE_OUTPUT_TOKENS tightens
 * what the model declared, and without it the loop states the model's own
 * documented limit explicitly.
 */
/**
 * What the operator asked for on the command line, when they did.
 *
 * An environment variable is a poor place for a knob an operator reaches for
 * while launching a run: it hides in a launch script, it does not appear in
 * `--help`, and a typo is silent. `dokkabi work` already takes `--budget-hours`
 * and `--max-waves`; these belong beside them. The variables stay for the
 * evaluator and for a shell that would rather export once, so the order is
 * flag, then environment, then the phase default.
 */
export interface DecomposeBudgetOverrides {
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxOutputTokens?: number;
}

/** Refusal-feedback turns a decompose may burn before the host gives up. */
export const DECOMPOSE_RETRIES_DEFAULT = 3;

/**
 * How many repair turns the host grants.
 *
 * Three was chosen when a repair turn could not explore: it could only rewrite
 * from what the decompose turn already knew, so a fourth was unlikely to differ
 * from the third. A repair turn that may look things up is a different turn —
 * each one can bring back a fact the last did not have — and a long host-bound
 * order can need more than three. The count stays operator-set rather than
 * raised for everyone, because a repair that keeps failing the same way is
 * still supposed to stop: `takeDecomposeRetry` ends on an unchanged refusal
 * whatever this number is.
 */
export function decomposeRetries(
  env: NodeJS.Dict<string> = process.env,
  override?: number,
): number {
  return override ?? positiveInteger(env.DOKKABI_DECOMPOSE_RETRIES) ?? DECOMPOSE_RETRIES_DEFAULT;
}

export function decomposeWorkOptions(
  env: NodeJS.Dict<string> = process.env,
  overrides: DecomposeBudgetOverrides = {},
): WorkTurnOptions {
  // Output: an explicit flag, then a valid positive integer in the
  // environment; with neither, no phase cap is set and the loop resolves the
  // model's declared allowance. Anything that is not a positive integer keeps
  // that inheritance rather than inventing a replacement constant.
  const outputCap = overrides.maxOutputTokens
    ?? positiveInteger(env.DOKKABI_DECOMPOSE_OUTPUT_TOKENS);
  return {
    ...DECOMPOSE_WORK_OPTIONS,
    ...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
    maxToolCalls: overrides.maxToolCalls
      ?? positiveInteger(env.DOKKABI_DECOMPOSE_TOOL_CALLS)
      ?? DECOMPOSE_WORK_OPTIONS.maxToolCalls,
    timeoutMs: overrides.timeoutMs
      ?? positiveInteger(env.DOKKABI_DECOMPOSE_TIMEOUT_MS)
      ?? DECOMPOSE_WORK_OPTIONS.timeoutMs,
  };
}

/**
 * The repair turn writes the same ledger, so it inherits the same resolved
 * output allowance and the same clock — and the same call budget, which it
 * did not.
 *
 * Its default is zero calls, on the premise that the decompose turn already
 * explored and the repair only has to write. But the refusal it repairs can
 * name a fact that turn never went looking for: "scenario s-git has no cases —
 * append one naming an existing test file" cannot be satisfied by a turn that
 * may not list a directory. Live, a run reached exactly that and terminated
 * with `Exploration budget exhausted. Use only write/edit`, unable to learn
 * the one thing the host had just asked it for.
 *
 * The premise stays the default: an unraised repair turn still explores
 * nothing, because a repair that wanders is the failure this budget was
 * written against. An operator who raises the decompose budget now raises
 * both, since the refusals that need a look are the same ones that made
 * the order long enough to need raising.
 */
export function decomposeRetryWorkOptions(
  env: NodeJS.Dict<string> = process.env,
  overrides: DecomposeBudgetOverrides = {},
): WorkTurnOptions {
  // Same output-door as the decompose turn: an explicit ceiling tightens the
  // resolved allowance; the default is no phase cap at all.
  const outputCap = overrides.maxOutputTokens
    ?? positiveInteger(env.DOKKABI_DECOMPOSE_OUTPUT_TOKENS);
  return {
    ...DECOMPOSE_RETRY_WORK_OPTIONS,
    ...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
    maxToolCalls: overrides.maxToolCalls
      ?? positiveInteger(env.DOKKABI_DECOMPOSE_TOOL_CALLS)
      ?? DECOMPOSE_RETRY_WORK_OPTIONS.maxToolCalls,
    timeoutMs: overrides.timeoutMs
      ?? positiveInteger(env.DOKKABI_DECOMPOSE_TIMEOUT_MS)
      ?? DECOMPOSE_RETRY_WORK_OPTIONS.timeoutMs,
  };
}

function positiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * The refused-plan repair turn.
 *
 * Zero exploration calls, write/edit finalizers only, and the exact remote
 * write plus one local plan re-read that host validation needs. The output
 * allowance and thinking policy are inherited from the resolved model, like
 * every other work phase: the repair writes the same ledger the decompose
 * turn did, and a shorter phase cap would truncate it for the same reasons.
 */
export const DECOMPOSE_RETRY_WORK_OPTIONS = {
  timeoutMs: 120_000,
  // A repair turn may spend its whole slice writing RED/plan artifacts. Yield
  // to host validation instead of aborting the entire HEUNG child at the
  // generation boundary.
  timeoutPolicy: "continue",
  maxToolCalls: 0,
  toolBudgetFinalizers: ["write", "edit"],
  toolBudgetFinalizerCalls: [{ tool: "ssh", op: "put" }, { tool: "read", path: "work/current.json" }],
} as const satisfies WorkTurnOptions;

/**
 * Two voices over one loop. The operator hears the brief and the final reply;
 * mid-loop model narration stays in the log where the dashboard reads it.
 * Narrate mode opts into streaming work-turn text to the terminal; the TUI
 * board turns it on by default, the CLI keeps it opt-in.
 */
export function createModelVoices(
  loop: VoiceLoop,
  print: (text: string) => void,
  options: { narrate?: boolean; log?: EventLog; thinkingLevel?: ThinkingLevel } = {},
): ModelVoices {
  return {
    speak: (text, modelId) => loop.prompt(text, {
      modelId,
      thinkingLevel: options.thinkingLevel,
      onAssistant: print,
    }),
    work: (text, modelId, workOptions) => {
      const turnOptions: WorkTurnOptions = workOptions ?? DEFAULT_WORK_TURN_OPTIONS;
      return loop.prompt(text, {
        modelId,
        thinkingLevel: options.thinkingLevel,
        ...(turnOptions.timeoutMs === undefined
          ? {}
          : { timeoutMs: turnOptions.timeoutMs }),
        ...(turnOptions.timeoutPolicy === undefined
          ? {}
          : { timeoutPolicy: turnOptions.timeoutPolicy }),
        ...(turnOptions.thinkingBudgets === undefined
          ? {}
          : { thinkingBudgets: options.thinkingLevel === undefined
            ? turnOptions.thinkingBudgets
            : thinkingBudgetsForLevel(options.thinkingLevel, turnOptions.thinkingBudgets) }),
        ...(turnOptions.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: turnOptions.maxOutputTokens }),
        ...(turnOptions.maxToolCalls === undefined
          ? {}
          : { maxToolCalls: turnOptions.maxToolCalls }),
        ...(turnOptions.toolBudgetFinalizers === undefined
          ? {}
          : { toolBudgetFinalizers: turnOptions.toolBudgetFinalizers }),
        ...(turnOptions.toolBudgetFinalizerCalls === undefined
          ? {}
          : { toolBudgetFinalizerCalls: turnOptions.toolBudgetFinalizerCalls }),
        ...(turnOptions.toolScope === undefined ? {} : { toolScope: turnOptions.toolScope }),
        ...(options.narrate ? { onAssistant: print } : {}),
      });
    },
  };
}

export interface GateTurnResult {
  speech: string;
  decision: "work" | "answer" | "chat" | "invalid";
  marker: boolean;
  reason?: string;
}

/**
 * First model turn over a raw loop: the model answers the operator naturally
 * and decides with a trailing WORK/CHAT marker whether the work loop should
 * run. The host strips the marker before printing and records the decision.
 */
/**
 * The operator (or the SWE adapter, whose order is a work order by
 * construction) asserts the route. The model gate is skipped, and the log
 * says so honestly: the decision came from the caller, not model judgment.
 */
/**
 * The gate turn classifies an order as CHAT, ANSWER, or WORK, and runs
 * read-only because classifying needs no writes. When the operator has already
 * asserted the route the turn is pure cost: the model reads the order as its
 * job, drives real work against a read-only workspace, and never emits a route.
 */
export function overrideGate(
  flags: { decision?: string; autonomousWork?: boolean },
  log: EventLog,
): boolean {
  const reason = flags.decision === "work"
    ? "operator override (--decision work)"
    : flags.autonomousWork === true
    ? "operator override (HEUNG: explicit autonomous work directive)"
    : undefined;
  if (reason === undefined) {
    return false;
  }
  log.append({
    kind: "observe",
    name: "work/gate",
    payload: { decision: "work", marker: true, reason },
  });
  return true;
}

export async function gateTurn(input: {
  log: EventLog;
  loop: VoiceLoop;
  order: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  print: (text: string) => void;
  narrate?: boolean;
  /** Bounded host/plugin context recorded before this model turn. */
  goalContext?: string;
}): Promise<GateTurnResult> {
  input.log.append({
    kind: "observe",
    name: "work/step",
    payload: { action: "gate", agent: "dokkabi" },
  });
  const gatePrompt = withGoalContext(buildGatePrompt(input.order), input.goalContext);
  const reply = await streamFinalChunk(input.loop, gatePrompt, {
    providerRole: "classifier",
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    print: input.narrate ? input.print : undefined,
  });
  let parsed = parseGateDecision(reply);
  if (!parsed.marker) {
    // Fail closed is not enough here: give the model one strict re-ask before
    // refusing to route. Two invalid replies stay invalid — no work graph.
    const retry = await streamFinalChunk(input.loop, buildGateRetryPrompt(input.order), {
      providerRole: "classifier",
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      print: undefined,
    });
    const reparsed = parseGateDecision(retry);
    if (reparsed.marker) {
      parsed = { ...reparsed, speech: parsed.speech };
    }
  }
  if (
    parsed.marker
    && parsed.decision !== "work"
    && parsed.speech.trim().length === 0
  ) {
    const reply = await streamFinalChunk(input.loop, buildGateReplyPrompt(input.order), {
      providerRole: "classifier",
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      print: undefined,
    });
    parsed = { ...parsed, speech: stripDecisionLine(reply) };
  }
  if (parsed.speech.trim().length > 0) {
    input.print(parsed.speech);
  }
  input.log.append({
    kind: "observe",
    name: "work/gate",
    payload: {
      decision: parsed.decision,
      marker: parsed.marker,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    },
  });
  // ANSWER (and CHAT) ends at the gate turn. Cross-check citations against
  // what this session actually read before the operator walks away.
  if (parsed.speech.trim().length > 0) {
    reportEvidence({
      log: input.log,
      text: parsed.speech,
      stage: parsed.decision === "work" ? "gate" : parsed.decision,
      print: input.print,
    });
  }
  return parsed;
}

function withGoalContext(prompt: string, context: string | undefined): string {
  const value = context?.trim();
  // Untrusted corpus text precedes the host route contract so a note cannot
  // become the last instruction in the gate prompt.
  return value ? `${value}\n\n${prompt}` : prompt;
}

type PromptFn = VoiceLoop["prompt"];

export async function speakToOperator(input: {
  log: EventLog;
  result: DriveResult;
  prompt: PromptFn;
  order: string;
  modelId?: string;
  onAssistant?: (text: string) => void;
}): Promise<void> {
  if (input.result.status !== "done") {
    const report = formatIncompleteWorkReport(input.result, input.log.events);
    input.log.appendDurable({ kind: "observe", name: "work/operator_report", payload: report });
    input.onAssistant?.(report.text);
    return;
  }
  input.log.append({
    kind: "observe",
    name: "work/step",
    payload: { action: "reply", agent: "dokkabi" },
  });
  let last = "";
  await input.prompt(buildOperatorReplyPrompt(input.order), {
    modelId: input.modelId,
    onAssistant: (text) => {
      last = text;
      input.onAssistant?.(text);
    },
  });
  if (last.trim().length > 0) {
    reportEvidence({
      log: input.log,
      text: last,
      stage: "reply",
      print: input.onAssistant ?? (() => undefined),
    });
  }
}
