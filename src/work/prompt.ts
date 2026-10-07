import { formatSubstrate } from "./case-substrate.ts";
import type { EventRecord } from "../host/schema.ts";
import { readWorkCeiling } from "./ceiling.ts";
import { caseCommandHint } from "./case-runners.ts";
import { formatLessonsBlock } from "./lessons.ts";
import { renderPrompt } from "./prompt-slots.ts";
import { WORK_CLASSES, type WorkPlan } from "./schema.ts";
import { TOOL_PROFILE_NAMES } from "../loader/tool-profiles.ts";

/** Locate/repro/find todos are observational. Run 39 followed the implement
 * lift, rewrote product source, and burned the wave on a NameError it created. */
export function isLocateTodo(todoId: string): boolean {
  return /locate|repro|find/i.test(todoId);
}

function ceilingLine(todoId: string, ceiling?: string): string {
  if (isLocateTodo(todoId)) {
    return [
      "THIS IS THE LOCATE TURN. Do not edit product source.",
      "Write work/REPRO.md describing the failing path and the failing command output.",
      "Read, reproduce, document, and stop. The product fix belongs to a later todo.",
    ].join("\n");
  }
  if (ceiling && ceiling !== "implement") {
    return `The work ceiling is ${ceiling}. Do not implement product code.\nPlanning-turn rules still hold. Do not lift them.`;
  }
  return [
    "THIS IS THE IMPLEMENT TURN. The planning-turn product-code ban is lifted now.",
    "Edit the product source in this turn and check the result.",
  ].join("\n");
}

export function buildWorkPrompt(plan: WorkPlan, todoId: string, ceiling?: string): string {
  const todo = plan.todos.find((item) => item.id === todoId);
  if (!todo) {
    throw new Error(`unknown todo ${todoId}`);
  }
  const scenarios = plan.scenarios.filter((item) => item.todo === todoId);
  const scenarioIds = new Set(scenarios.map((item) => item.id));
  const cases = plan.cases.filter((item) => scenarioIds.has(item.scenario));
  const checks = [
    ...scenarios.map(
      (item) => `- ${item.id}: Given ${item.given}; When ${item.when}; Then ${item.then}`,
    ),
    ...cases.map((item) => {
      // The substrate travels with the case every turn: a claim the model
      // cannot see is a claim it will close with whatever ran.
      if (item.measurement) {
        return `- ${item.id}: ${item.command} (green: ${item.green_means}) [protected measurement: ${JSON.stringify(item.measurement)}${item.substrate ? `; substrate=${formatSubstrate(item.substrate)}` : ""}; host inputs and independently checked outputs; unsupported observations remain unavailable; do not print legacy markers as proof]`;
      }
      const evidence = item.evidence_level === "workspace_reported"
        ? " [evidence=workspace_reported; printed reports are not attested measurements]"
        : item.substrate || item.thresholds || item.witness_for || item.min_duration_ms !== undefined
          ? " [measurement contract required; this claim cannot earn GREEN from stdout]" : "";
      const substrate = item.substrate
        ? ` [substrate: ${formatSubstrate(item.substrate)} — the run must print this line]`
        : "";
      const bars = item.thresholds
        ? ` [thresholds fixed by the plan — the run must apply and echo each: ${Object.entries(item.thresholds).map(([k, v]) => `threshold: ${k}=${v}`).join("; ")}${
          Object.values(item.thresholds).some((v) => /^[<>]/u.test(String(v).trim()))
            ? "; comparison bars also require the run to print its own measurement as `measured: <name>=<number>` — the harness evaluates the comparison itself"
            : ""
        }; the run is HANDED these bars at $DOKKABI_CASE_BARS (JSON, name to value) — read them there, never from a copy of the plan]`
        : "";
      return `- ${item.id}: ${item.command} (green: ${item.green_means})${evidence}${substrate}${bars}`;
    }),
  ];
  const turn = renderPrompt("work/implement.md", {
    title: todo.title,
    ceiling_line: ceilingLine(todoId, ceiling),
  }).trimEnd();
  return [
    `Goal: ${plan.goal.id} — ${plan.goal.statement}`,
    `Todo: ${todo.id} [${todo.class} p=${todo.priority}] ${todo.title}`,
    `Success: ${todo.statement}`,
    ...(checks.length > 0 ? ["", "Checks:", ...checks] : []),
    "",
    turn,
  ].join("\n");
}

export function buildWorkContinuePrompt(plan: WorkPlan, todoId: string, ceiling?: string): string {
  const todo = plan.todos.find((item) => item.id === todoId);
  if (!todo) {
    throw new Error(`unknown todo ${todoId}`);
  }
  return renderPrompt("work/continue.md", {
    title: `${todo.id} — ${todo.title}`,
    ceiling_line: ceilingLine(todoId, ceiling),
  }).trimEnd();
}

export function buildAcceptancePrompt(order: string, ledger?: string, specReview?: string): string {
  return renderPrompt("work/accept.md", {
    order,
    ledger: ledger && ledger.trim().length > 0 ? `\nEvidence ledger:\n${ledger}\n` : "",
    spec_review: specReview && specReview.trim().length > 0
      ? `\nBlind specification review, written before the candidate was visible:\n${specReview.trim()}\n`
      : "",
  }).trimEnd();
}

export function buildAcceptanceSpecPrompt(order: string): string {
  return renderPrompt("work/accept-spec.md", { order }).trimEnd();
}

/** The optional host diagnosis is appended; the no-argument prompt is unchanged. */
export function buildAcceptanceSpecRetryPrompt(diagnosis?: string): string {
  const prompt = renderPrompt("work/accept-spec-retry.md", {}).trimEnd();
  return diagnosis ? `${prompt}\nHost diagnosis of the last review: ${diagnosis}.` : prompt;
}

export interface AcceptanceSpecReview {
  readonly valid: boolean;
  readonly review: string;
  readonly reason?: string;
}

const ACCEPTANCE_SPEC_LABELS = ["BOUNDARIES", "CONTRACT", "COUNTEREXAMPLE", "CHECK"] as const;

export function parseAcceptanceSpecReview(reply: string): AcceptanceSpecReview {
  const lines = reply
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => index === 0
      ? line.replace(/^:\s*(?=BOUNDARIES:)/u, "")
      : line);
  if (lines.length !== ACCEPTANCE_SPEC_LABELS.length) {
    return {
      valid: false,
      review: reply.trim(),
      reason: "review must contain exactly four non-empty labeled lines",
    };
  }
  for (let index = 0; index < ACCEPTANCE_SPEC_LABELS.length; index += 1) {
    const label = ACCEPTANCE_SPEC_LABELS[index];
    const line = lines[index] ?? "";
    const prefix = `${label}:`;
    if (!line.startsWith(prefix) || line.slice(prefix.length).trim().length === 0) {
      return {
        valid: false,
        review: reply.trim(),
        reason: `review line ${index + 1} must be a non-empty ${prefix} field`,
      };
    }
  }
  return { valid: true, review: lines.join("\n") };
}

export function buildAcceptanceVerdictPrompt(): string {
  return renderPrompt("work/accept-verdict.md", {}).trimEnd();
}

export function parseAcceptDecision(reply: string): AcceptDecision {
  const lines = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const marker = line
      .replace(/^```(?:text)?/i, "")
      .replace(/```$/, "")
      .replace(/[`_*\][().,!?:;'"-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
    if (marker === "DONE") {
      return { kind: "done", speech: lines.slice(0, i).join("\n") };
    }
    if (marker === "NOT DONE") {
      return { kind: "not_done", speech: lines.slice(0, i).join("\n") };
    }
    if (marker === "INCONCLUSIVE") {
      return { kind: "inconclusive", speech: lines.slice(0, i).join("\n") };
    }
  }
  return { kind: "unknown", speech: reply.trim() };
}

export type AcceptDecision =
  | { kind: "done"; speech: string }
  | { kind: "not_done"; speech: string }
  | { kind: "inconclusive"; speech: string }
  | { kind: "unknown"; speech: string };

export function buildAcceptanceReplanPrompt(input: { order: string; gaps: string; plan: WorkPlan; errors?: readonly string[] }): string {
  return renderPrompt("work/accept-replan.md", {
    order: input.order,
    gaps: input.gaps,
    case_hint: caseCommandHint(),
    admitted_plan: `<admitted-work-plan>\n${JSON.stringify(input.plan, null, 2).replaceAll("<", "\\u003c")}\n</admitted-work-plan>`,
    work_classes: WORK_CLASSES.join("|"),
    tool_profiles: TOOL_PROFILE_NAMES.join("|"),
    refusal_reasons: input.errors?.length
      ? `Acceptance followup repair: the host refused the previous proposal. Correct these errors before execution can resume:\n${input.errors.map(error => `- ${error}`).join("\n")}`
      : "",
  }).trimEnd();
}

export function buildGatePrompt(order: string): string {
  return renderPrompt("work/gate.md", { order }).trimEnd();
}

export function buildGateRetryPrompt(order: string): string {
  return renderPrompt("work/gate-retry.md", { order }).trimEnd();
}

export function buildGateReplyPrompt(order: string): string {
  return renderPrompt("work/gate-reply.md", { order }).trimEnd();
}

export interface GateDecision {
  speech: string;
  decision: "work" | "answer" | "chat" | "invalid";
  marker: boolean;
  reason?: string;
}

const GATE_ROUTES = new Set(["work", "answer", "chat"]);

function parseDecisionLine(line: string): { route: "work" | "answer" | "chat"; reason?: string } | undefined {
  const stripped = line.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (stripped.startsWith("{") && stripped.endsWith("}")) {
    try {
      const parsed = JSON.parse(stripped) as { route?: unknown; reason?: unknown };
      if (typeof parsed.route === "string" && GATE_ROUTES.has(parsed.route)) {
        return {
          route: parsed.route as "work" | "answer" | "chat",
          ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  const normalized = stripped.replace(/[`_*\]\[().,!?:;'"\-]+/g, "").trim().toUpperCase();
  if (normalized === "WORK" || normalized === "ANSWER" || normalized === "CHAT") {
    return { route: normalized.toLowerCase() as "work" | "answer" | "chat" };
  }
  return undefined;
}

export function parseGateDecision(reply: string): GateDecision {
  const lines = reply.split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") {
    lines.pop();
  }
  if (lines.length > 0 && lines.at(-1)!.trim() === "```") {
    lines.pop();
  }
  const last = lines.at(-1)?.trim() ?? "";
  const parsed = parseDecisionLine(last);
  if (parsed) {
    return {
      speech: lines.slice(0, -1).join("\n").trimEnd(),
      decision: parsed.route,
      marker: true,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  }
  return { speech: reply.trim(), decision: "invalid", marker: false };
}

export function stripDecisionLine(reply: string): string {
  const parsed = parseGateDecision(reply);
  return parsed.decision === "invalid" ? reply.trim() : parsed.speech;
}

export function buildHeungContinuePrompt(): string {
  return "Continue the same session. Use the conversation, files, and work/current.json already in context. Do not restart.";
}

/** Retired export kept for source compatibility. */
export const buildCrunchContinuePrompt = buildHeungContinuePrompt;

export function nextWorkModelPrompt(input: {
  plan: WorkPlan;
  todoId: string;
  order?: string;
  hasPriorModelTurn: boolean;
  bornGreen?: string[];
  events?: readonly EventRecord[];
  goalContext?: string;
  /** Cases that could not run at all — a deleted or renamed test path. Without
   * this the model reads the red as "already handled" and the same todo comes
   * round again, which is exactly what happened live. */
  unrunnable?: readonly { readonly id: string; readonly reason: string }[];
  /** Latest failing output of this todo's red cases. A red without its output
   * is a rumor: one live gate crashed on a missing import three rounds in a
   * row while the turn that could fix it was only told "the case is red". */
  redOutputs?: readonly { readonly id: string; readonly tail: string; readonly durationMs?: number; readonly reconfirmed?: number; readonly refusal?: string }[];
  /** Per case, per metric, what the recent executed runs measured. A model
   * cannot judge whether its approach is working from one measurement; the
   * trend is the fact that says "your last five changes bought nothing —
   * the bottleneck is elsewhere" (scope.ts). */
  trends?: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>;
  /** Why the last ledger edit was thrown away, when it was (scope.ts). */
  planRefused?: readonly string[];
  /** True when the previous turn ended with no tool call and no text — its
   * whole budget went into reasoning that was then truncated (scope.ts). */
  lastTurnSilent?: boolean;
  /** Consecutive turns that ran no case and moved nothing on the host. */
  idleStreak?: number;
  /** Guards whose standing invariant is broken. They do not refuse the seal —
   * they are the first thing this run must repair (verify.ts). */
  brokenGuards?: readonly string[];
}): string {
  const ceiling = input.events ? readWorkCeiling(input.events) : undefined;
  const bornGreen = input.bornGreen ?? [];
  const bornGreenBlock = bornGreen.length > 0
    ? [
        "",
        "These cases passed before implementation and do not prove the deliverable:",
        ...bornGreen.map((id) => `- ${id}`),
        "Replace them with RED-capable cases before clearing the todo.",
      ].join("\n")
    : "";
  const unrunnableBlock = (input.unrunnable ?? []).length > 0
    ? [
      "",
      "These cases cannot run at all — no product work will move them:",
      ...(input.unrunnable ?? []).map((item) => `- ${item.id}: ${item.reason}`),
      "Restore the path the case names, or point the case at the file that now holds this check.",
    ].join("\n")
    : "";
  const redOutputBlock = (input.redOutputs ?? []).length > 0
    ? [
      "",
      "Latest output of this todo's red cases — the run's own words:",
      ...(input.redOutputs ?? []).flatMap((item) => [
        `- ${item.id}${item.durationMs !== undefined ? ` (ran ${Math.round(item.durationMs / 1000)}s${
          (item.reconfirmed ?? 0) > 0
            ? `; re-confirmed against UNCHANGED dependencies ${item.reconfirmed}x since — this failure reflects the code as it stands, nothing is awaiting verification`
            : ""
        })` : ""}:`,
        "```",
        item.tail.trim(),
        "```",
        ...(item.refusal
          ? [
            `  THE HARNESS REFUSED THIS RUN — its own reason, which the output above does not contain: ${item.refusal}`,
            "  A passing test that is refused is not a broken recorder: satisfy the reason above, in the run itself.",
          ]
          : []),
      ]),
      "Judge from these lines, not from what you remember doing. A case that is still red after your edit means the run disagrees with you — fix what its output says is broken before concluding nothing needs to change.",
    ].join("\n")
    : "";
  const refusedBlock = (input.planRefused ?? []).length > 0
    ? [
      "",
      "YOUR LAST LEDGER EDIT WAS REFUSED and the previous plan was restored — this is why your changes are not in the file:",
      ...(input.planRefused ?? []).map((error) => `- ${error}`),
      "Fix exactly these and write the ledger again; re-registering the same shape will be refused the same way.",
    ].join("\n")
    : "";
  const silentBlock = input.lastTurnSilent
    ? [
      "",
      "YOUR PREVIOUS TURN PRODUCED NOTHING — no tool call, no text, no edit: its entire output budget went into reasoning that was then truncated.",
      "Act first this turn: make the smallest concrete move (one command, one read, one edit) before reasoning further. A conclusion you cannot emit is worth less than a single command that produces a fact.",
    ].join("\n")
    : "";
  const idleBlock = (input.idleStreak ?? 0) >= 4
    ? [
      "",
      `THE LAST ${input.idleStreak} TURNS CHANGED NOTHING A CASE CAN SEE — no case ran and nothing moved in the workspace the cases judge.`,
      "Reading, reasoning and re-planning are not progress by themselves. This turn: change one file the declared cases actually exercise, or say plainly what is blocking you and what you need — do not spend another turn restating the diagnosis.",
    ].join("\n")
    : "";
  const guardBlock = (input.brokenGuards ?? []).length > 0
    ? [
      "",
      "THESE GUARDS ARE BROKEN — a standing invariant that was already earned is failing now:",
      ...(input.brokenGuards ?? []).map((id) => `- ${id}`),
      "Repair them before anything else. A guard is not new work: it protects a verdict this run already holds, "
        + "and every case built on top of it is measuring a foundation that moved. Fix the guard, watch it go green, then continue.",
    ].join("\n")
    : "";
  const trendBlock = trendLines(input.plan, input.trends);
  if (input.hasPriorModelTurn) {
    return `${buildWorkContinuePrompt(input.plan, input.todoId, ceiling)}${guardBlock}${bornGreenBlock}${unrunnableBlock}${redOutputBlock}${trendBlock}${refusedBlock}${silentBlock}${idleBlock}`;
  }
  const order = input.order?.trim();
  return [
    ...(order ? [`Operator order:\n${order}`, ""] : []),
    ...(input.goalContext?.trim() ? [input.goalContext.trim(), ""] : []),
    buildWorkPrompt(input.plan, input.todoId, ceiling),
    bornGreenBlock,
    unrunnableBlock,
    redOutputBlock,
    trendBlock,
    refusedBlock,
    silentBlock,
    idleBlock,
  ].filter((line) => line.length > 0).join("\n");
}

/** Round for reading: a trend is judged by its shape, not its precision. */
function trendValue(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  if (magnitude >= 0.001) return value.toFixed(3);
  return value.toExponential(2);
}

/**
 * The measured history of this todo's cases, oldest to newest, with the bar
 * each metric is judged against. A trend that has flattened while work
 * continues is the fact that redirects the work.
 */
function trendLines(
  plan: WorkPlan,
  trends?: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>,
): string {
  if (!trends || Object.keys(trends).length === 0) return "";
  const lines: string[] = [];
  let flat = false;
  for (const [caseId, metrics] of Object.entries(trends)) {
    const bars = plan.cases.find((item) => item.id === caseId)?.thresholds ?? {};
    for (const [name, values] of Object.entries(metrics)) {
      if (values.length < 2) continue;
      const bar = bars[name];
      const first = values[0]!;
      const last = values.at(-1)!;
      // "Moving" is relative to the distance still to cover: a metric that
      // closed a hundredth of its remaining gap over several runs is flat
      // whatever its absolute step size.
      const barValue = bar ? Number(String(bar).replace(/^[<>=]+/u, "")) : undefined;
      const gap = barValue !== undefined && Number.isFinite(barValue)
        ? Math.abs(barValue - first)
        : Math.abs(first) || 1;
      if (values.length >= 3 && gap > 0 && Math.abs(last - first) / gap < 0.1) flat = true;
      lines.push(
        `- ${caseId} ${name}: ${values.map(trendValue).join(" → ")}${bar ? ` [bar ${bar}]` : ""}`,
      );
    }
  }
  if (lines.length === 0) return "";
  return [
    "",
    "Measured trend across this case's recent runs (oldest → newest):",
    ...lines,
    flat
      ? "A metric that has stopped moving while you keep changing things is telling you the bottleneck is no longer where you are working. Measure where the cost actually goes before optimizing further, and say what the profile shows before your next change."
      : "Judge your next change against this trend: if it does not move the number toward the bar, it was not the bottleneck.",
  ].join("\n");
}

export function buildOperatorReplyPrompt(order?: string): string {
  return renderPrompt("work/reply.md", {
    order_line: order && order.trim().length > 0 ? `Operator order: ${order.trim()}` : "",
  }).trimEnd();
}

function stuckBlock(input: {
  status: string;
  stuck?: { todo: string; cases: { id: string; green_means?: string }[] }[];
}): string {
  const stuckLines = (input.stuck ?? []).flatMap((entry) => [
    `- ${entry.todo} stayed RED:`,
    ...entry.cases.map(
      (item) => `  - ${item.id}${item.green_means ? ` — green means: ${item.green_means}` : ""}`,
    ),
  ]);
  const lines: string[] = [];
  if (stuckLines.length > 0) {
    lines.push(
      "",
      "Stuck evidence from the drive:",
      ...stuckLines,
      "Judge WHY each case stayed red. If a case's green condition requires a later todo's deliverable (e.g. a locate case that only the fix can turn green), rescope that case to what its own todo alone produces. A case must be greenable by its own todo.",
    );
  }
  if (input.status === "max_steps") {
    lines.push(
      "",
      "STEP BUDGET EXHAUSTED — the goal is NOT done. This is not a stop",
      "condition. Diagnose what consumed the budget (verbose diagnosis?",
      "a repeated failing strategy? the wrong dependency ladder?) and",
      "re-plan the remaining work to be cheaper: fewer, bigger steps; skip",
      "re-checking what you already proved; write the ONE command that",
      "finishes it.",
    );
  }
  return lines.join("\n");
}

export function buildHeungReplanPrompt(input: {
  order: string;
  plan: WorkPlan;
  status: string;
  hasPriorModelTurn: boolean;
  stuck?: { todo: string; cases: { id: string; green_means?: string }[] }[];
  lessons?: readonly string[];
  strategyShift?: string;
}): string {
  const lessons = formatLessonsBlock(input.lessons ?? []).join("\n");
  const stuck = stuckBlock(input);
  const strategyShift = input.strategyShift?.trim() ?? "";
  if (input.hasPriorModelTurn) {
    return renderPrompt("work/heung-continue.md", {
      status: input.status,
      stuck_block: stuck,
      lessons_block: lessons,
      strategy_shift_block: strategyShift,
    }).trimEnd();
  }
  const remaining = input.plan.todos.map((todo) => `- ${todo.id} ${todo.title}`).join("\n");
  return renderPrompt("work/heung-fresh.md", {
    order_line: input.order.trim() ? `Operator order: ${input.order.trim()}` : "",
    status: input.status,
    remaining_block: remaining ? `Current todos:\n${remaining}` : "",
    stuck_block: stuck,
    lessons_block: lessons,
    strategy_shift_block: strategyShift,
  }).trimEnd();
}

/** Retired export kept for source compatibility. */
export const buildCrunchReplanPrompt = buildHeungReplanPrompt;
