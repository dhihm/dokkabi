import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dokkabiHome } from "../host/paths.ts";
import { redactText } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";
import { detectBackend } from "../host/sandbox.ts";
import { runDokkabiChild, type BoundedProcessResult, type RunDokkabiChildInput } from "./child-process.ts";
import {
  stageMode,
  stageSpawnOptions,
  type FreeswarmRoleKey,
  stagePlanHandoff,
} from "./freeswarm-pipeline.ts";
import type { FreeswarmStageRunner } from "./freeswarm-run.ts";

/**
 * The live stage runner for 두레 (freeswarm): each pipeline stage spawns a
 * `cli.ts work` child on the OpenRouter route with the stage's assigned free
 * model as DOKKABI_MODEL, and the stage's artifact is the child's final
 * assistant message read back from its session log.
 *
 * Trust model: freeswarm children run with the operator's own environment —
 * the same authority as the operator running `dokkabi work` per role by hand.
 * This is deliberately NOT the sealed swarm-child isolation (private HOME,
 * staged auth, memory views): the pipeline is an operator convenience over
 * their own credentials, not a boundary. The spawn is injectable so the
 * orchestration wiring is testable without a model call.
 */

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60_000;
const SANDBOX_REFUSAL =
  "no sandbox backend available (bwrap on Linux, sandbox-exec on macOS); refusing to open a session without a sandbox";

export interface FreeswarmLiveOptions {
  repoRoot: string;
  workspaceRoot: string;
  /** Session prefix; each stage runs as `<runId>-<role>`. */
  runId: string;
  route?: string;
  maxSteps?: number;
  stageTimeoutMs?: number;
  /** DOKKABI_HOME the children write their session logs under. */
  home?: string;
  /** Injectable spawn (tests fake the child); defaults to runDokkabiChild. */
  runChild?: (input: RunDokkabiChildInput) => Promise<BoundedProcessResult>;
}

export interface FreeswarmStageEvaluation {
  artifact: string;
  /** Hard failure — the role produced nothing usable and later stages should stop. */
  error?: boolean;
  /** Goal GREEN but accept/spec failed — artifact still threads forward. */
  acceptFailed?: boolean;
  /** The route rejected the ASSIGNED model (invalid_request) — the stage
   * never really ran; the orchestrator may reassign the role (#85). */
  unroutableModel?: boolean;
}

/** Fail closed before spawning when the host cannot open a sandboxed session. */
export function assertFreeswarmSandbox(workspaceRoot: string): void {
  if (detectBackend(workspaceRoot) === "none") {
    throw new Error(SANDBOX_REFUSAL);
  }
}

function sessionLogPath(home: string, sessionId: string): string {
  return join(home, "sessions", sessionId, "events.jsonl");
}

function readChildSessionEvents(home: string, sessionId: string): EventRecord[] {
  const path = sessionLogPath(home, sessionId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: EventRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as EventRecord);
    } catch {
      // Torn tail: keep what parsed.
    }
  }
  return events;
}

/** The child's final assistant message text, from its session event log.
 * Reads the raw JSONL without chain verification — this is an artifact fetch,
 * not an audit; a torn tail simply yields the last complete message. */
export function readChildArtifact(home: string, sessionId: string): string | undefined {
  const events = readChildSessionEvents(home, sessionId);
  let last: string | undefined;
  for (const event of events) {
    if (event.name === "assistant/message" && typeof event.payload.text === "string") {
      last = event.payload.text;
    }
  }
  return last;
}

export function readDesignArtifact(workspaceRoot: string, home: string, sessionId: string): string | undefined {
  const assistant = readChildArtifact(home, sessionId);
  if (assistant !== undefined) return assistant;
  const designPath = join(workspaceRoot, "work", "DESIGN.md");
  if (!existsSync(designPath)) return undefined;
  try {
    return readFileSync(designPath, "utf8");
  } catch {
    return undefined;
  }
}

export function childGoalCompleted(events: readonly EventRecord[]): boolean {
  let sawDone = false;
  let sawGoalDone = false;
  for (const event of events) {
    if (event.name === "work/step" && event.payload.action === "done") {
      sawDone = true;
    }
    if (
      event.name === "work/checkpoint"
      && event.payload.reason === "goal_done"
      && event.payload.status === "completed"
    ) {
      sawGoalDone = true;
    }
  }
  return sawDone && sawGoalDone;
}

export function childAcceptFailed(events: readonly EventRecord[], result: BoundedProcessResult): boolean {
  if (result.status === "completed" && result.exitCode === 0) return false;
  const run = [...events].reverse().find((event) => event.name === "work/run_result");
  if (run) {
    if (run.payload.accepted === false) return true;
    const status = run.payload.status;
    if (status === "acceptance_rejected" || status === "acceptance_inconclusive") return true;
  }
  return false;
}

function redactFailureText(text: string): string {
  return redactText(text).trim();
}

function modelFailureReason(event: EventRecord): string | undefined {
  const parts: string[] = [];
  if (typeof event.payload.class === "string" && event.payload.class.trim().length > 0) {
    parts.push(event.payload.class);
  }
  if (typeof event.payload.reason_code === "string" && event.payload.reason_code.trim().length > 0) {
    parts.push(event.payload.reason_code);
  }
  if (typeof event.payload.model === "string" && event.payload.model.trim().length > 0) {
    parts.push(event.payload.model);
  }
  return parts.length > 0 ? parts.join(": ") : undefined;
}

function isIgnorableHostProbe(event: EventRecord): boolean {
  if (event.name === "plugin/skip") {
    return true;
  }
  if (event.name === "prerequisite/state") {
    return true;
  }
  return false;
}

function workOutcomeReason(event: EventRecord): string | undefined {
  if (event.name === "work/accept") {
    const decision = event.payload.decision;
    if (decision === "not_done" || decision === "inconclusive") {
      const parts = [`accept/${String(decision)}`];
      if (event.payload.tool_budget_exhausted === true) {
        parts.push("tool_budget_exhausted");
      }
      if (event.payload.turn_budget_exhausted === true) {
        parts.push("turn_budget_exhausted");
      }
      return parts.join(": ");
    }
  }
  if (event.name === "work/run_result") {
    const stopReason = event.payload.stop_reason;
    if (typeof stopReason === "string" && stopReason.trim().length > 0) {
      return stopReason.trim();
    }
    const status = event.payload.status;
    if (typeof status === "string" && status !== "done" && status !== "planned") {
      return status;
    }
  }
  if (event.name === "model/tool_budget") {
    return "exploration budget exhausted";
  }
  if (event.name === "model/turn_budget") {
    return "turn budget exhausted";
  }
  if (event.name === "work/step" && event.payload.action === "decompose_retry") {
    const errors = event.payload.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((error) => String(error)).join("; ");
    }
  }
  return undefined;
}

function payloadReason(event: EventRecord): string | undefined {
  if (isIgnorableHostProbe(event)) {
    return undefined;
  }
  const reasonCode = event.payload.reason_code;
  if (typeof reasonCode === "string" && reasonCode.trim().length > 0) return reasonCode;
  const reason = event.payload.reason;
  if (typeof reason === "string" && reason.trim().length > 0) return reason;
  const message = event.payload.message;
  if (typeof message === "string" && message.trim().length > 0) return message;
  return undefined;
}

/** Refusal or stderr/stdout text when a child dies before surfacing an assistant message. */
export function readChildFailureReason(
  home: string,
  sessionId: string,
  result: BoundedProcessResult,
): string | undefined {
  const events = readChildSessionEvents(home, sessionId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.name !== "model/failure") continue;
    const reason = modelFailureReason(event);
    if (reason !== undefined) return redactFailureText(reason);
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const reason = workOutcomeReason(events[i]!);
    if (reason !== undefined) return redactFailureText(reason);
  }
  for (const event of events) {
    if (isIgnorableHostProbe(event)) continue;
    const reason = payloadReason(event);
    if (reason !== undefined) return redactFailureText(reason);
    if (event.name === "model/failure" && typeof event.payload.class === "string") {
      return redactFailureText(event.payload.class);
    }
  }
  const stderr = redactFailureText(result.stderrTail);
  if (stderr.length > 0) return stderr;
  const stdout = redactFailureText(result.stdoutTail);
  if (stdout.length > 0) return stdout;
  // Last resort only: a suppressed host probe (missing ssh, skipped plugin)
  // is better than nothing when the child left NO other trace — but it must
  // never outrank a real outcome (#86).
  for (const event of events) {
    if (!isIgnorableHostProbe(event)) continue;
    const reason = payloadReason(event);
    if (reason !== undefined) return redactFailureText(reason);
  }
  return undefined;
}

export function formatStageChildFailure(
  role: FreeswarmRoleKey,
  result: BoundedProcessResult,
  reason?: string,
): string {
  const detail = reason ? redactFailureText(reason) : undefined;
  if (detail && detail.length > 0) return detail;
  return `stage ${role} child ${result.status} (exit=${result.exitCode ?? "?"} signal=${result.signalCode ?? "-"})`;
}

export function evaluateFreeswarmStage(input: {
  role: FreeswarmRoleKey;
  home: string;
  workspaceRoot: string;
  sessionId: string;
  /** The model ASSIGNED to this stage — unroutable detection matches on it. */
  model?: string;
  result: BoundedProcessResult;
}): FreeswarmStageEvaluation {
  const events = readChildSessionEvents(input.home, input.sessionId);
  const mode = stageMode(input.role);
  const artifactFromSession = mode === "design"
    ? readDesignArtifact(input.workspaceRoot, input.home, input.sessionId)
    : readChildArtifact(input.home, input.sessionId);
  const goalDone = childGoalCompleted(events);

  if (goalDone && artifactFromSession !== undefined) {
    const acceptFailed = input.result.exitCode !== 0 || childAcceptFailed(events, input.result);
    if (acceptFailed) {
      return {
        artifact: artifactFromSession,
        acceptFailed: true,
      };
    }
    return { artifact: artifactFromSession };
  }

  if (mode === "design" || mode === "review") {
    if (artifactFromSession !== undefined) {
      return { artifact: artifactFromSession };
    }
  }

  if (input.result.status === "completed" && input.result.exitCode === 0 && artifactFromSession !== undefined) {
    return { artifact: artifactFromSession };
  }

  const reason = readChildFailureReason(input.home, input.sessionId, input.result);
  return {
    artifact: formatStageChildFailure(input.role, input.result, reason),
    error: true,
    // The route rejected the ASSIGNED model itself (#85): the stage never
    // really ran, so the orchestrator may reassign instead of folding.
    // rate_limited and every real work failure stay non-reassignable.
    ...(input.model !== undefined && childModelUnroutable(events, input.model)
      ? { unroutableModel: true }
      : {}),
  };
}

/** Events that prove the child's model actually produced work. */
const WORK_PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  "assistant/message",
  "tool/start",
  "tool/call",
  "tool/end",
  "tool/result",
  "work/doing",
  "work/case",
  "work/case_preflight",
  "work/clear",
  "work/checkpoint",
  "work/todo",
]);

/**
 * Did the route reject the ASSIGNED model before it did anything?
 *
 * `invalid_request` is this codebase's CATCH-ALL class, not a routing
 * verdict: normalizeModelFailureV1 falls through to it with reason_code
 * `unclassified_failure`, and a mid-run context overflow lands there too
 * whenever the provider's phrasing misses the context regex. Treating any
 * such row as "this model is not callable" made a stage that worked for
 * many turns and then overflowed get reassigned and rerun from scratch,
 * discarding real work and folding under a reason that never happened
 * (PR #97 review H1). So the verdict requires BOTH:
 *   - a reason code that actually names a rejection (never the
 *     "we don't know" bucket), and
 *   - no work-progress event before it — a pre-flight refusal.
 */
function childModelUnroutable(events: readonly EventRecord[], model: string): boolean {
  // Any work progress ANYWHERE voids the verdict: a stage that produced
  // output did run, so "the model is not callable" is false whatever killed
  // it later — including a run that recovered from an early rejection and
  // then died of something else.
  if (events.some((event) => WORK_PROGRESS_EVENTS.has(event.name))) return false;
  const lastFailure = [...events].reverse().find((event) => event.name === "model/failure");
  return (
    lastFailure !== undefined &&
    lastFailure.payload.class === "invalid_request" &&
    lastFailure.payload.model === model &&
    lastFailure.payload.reason_code !== "unclassified_failure"
  );
}

/** Retry attempts get their own child sessions — a reassigned stage must
 * not append onto (or read) the unroutable attempt's log (#85). */
export function stageSessionId(runId: string, role: string, attempt: number): string {
  return attempt > 1 ? `${runId}-${role}-r${attempt}` : `${runId}-${role}`;
}

export function createFreeswarmStageRunner(options: FreeswarmLiveOptions): FreeswarmStageRunner {
  const route = options.route ?? "openrouter";
  const home = options.home ?? dokkabiHome();
  const runChild = options.runChild ?? runDokkabiChild;
  return async ({ plan, order, attempt, signal }) => {
    const sessionId = stageSessionId(options.runId, plan.role, attempt ?? 1);
    const spawn = stageSpawnOptions(plan.role);
    const result = await runChild({
      repoRoot: options.repoRoot,
      sessionId,
      workspaceRoot: options.workspaceRoot,
      route,
      order,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      timeoutMs: options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
      decision: spawn.decision,
      ...(spawn.deferAcceptance ? { deferAcceptance: true } : {}),
      env: {
        ...process.env,
        DOKKABI_HOME: home,
        DOKKABI_ROUTE: route,
        ...(plan.model ? { DOKKABI_MODEL: plan.model.id } : {}),
        // Plan-handoff authority is per-role (PR #96 review H2): only the
        // builder inherits the architect's sealed plan; the tester must
        // decompose its own graph even though a current.json is sitting in
        // the shared workspace.
        ...(stagePlanHandoff(plan.role) ? { DOKKABI_WORK_REUSE_PLAN: "1" } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    return evaluateFreeswarmStage({
      role: plan.role,
      home,
      workspaceRoot: options.workspaceRoot,
      sessionId,
      ...(plan.model ? { model: plan.model.id } : {}),
      result,
    });
  };
}
