import { RecoveryTerminalError, isRecoveryTerminalError, type DurableRecoveryService, type RecoveryOperation, type RecoveryAttemptGrant } from "../host/recovery.ts";
import { restoreOwnedAgentTranscript } from "../host/agent-transcript.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { CREDENTIAL_PATH_REFUSAL } from "../host/workspace-secrets.ts";
import { join, resolve } from "node:path";
import { ABORT_GRACE_MS, TurnAbandonedError, waitForIdleWithin } from "../host/turn-grace.ts";
import {
  STREAM_STALL_ERROR_CODE,
  StreamStallError,
  resolveStreamIdleBudget,
  streamIdleFor,
} from "../host/stream-stall.ts";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { cleanupSessionResources, type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type ThinkingBudgets } from "@earendil-works/pi-ai";
import type { SpeculationService } from "../speculative/service.ts";
import {
  isSafeWorkspaceTransferSource,
  isSecretPath,
  pathInsideWorkspace,
  workspaceToolPath,
  workspaceToolSecretPath,
} from "./workspace-tools.ts";
import {
  authoredSecretDigests,
  containsPrivateInfrastructure,
  containsPrivateInfrastructureValue,
  containsSecret,
  containsSecretValue,
  normalizeHomePathsValue,
  observedSecretDigests,
  sessionObservedSecretValues,
  privateInfrastructureClassInValue,
  redactText,
  secretShapeClassInValue,
  toolArgsPrivateInfrastructureClass,
} from "../host/redact.ts";
import { BlobStore } from "../host/blob-store.ts";
import { deliverToolResult, resultSourceReaderAuthorised } from "../host/result-source.ts";
import { readResultProjection } from "../tools/model-result.ts";
import { safeToolResultInput } from "../host/tool-result-input.ts";
import { deliveredContent, toolResultDelivered } from "../tools/delivery.ts";
import { admitProviderInput, appendProviderMessage, assertProviderMessages, inputDigest,
  liveProviderState, replaceProviderMessages, requireProviderInput, ProviderInputError,
  observeProviderInputRefusal } from "../host/provider-input.ts";
import {
  agentTranscriptPath,
  inspectAgentTranscript,
  loadAgentTranscript,
  saveAgentTranscript,
  synchronizeAgentTranscript,
  type AgentTranscriptInspection,
} from "../host/agent-transcript.ts";
import { buildCompactionCheckpoint, compactionCheckpointText } from "../host/compaction-checkpoint.ts";
import { contributeModelInput, MODEL_INPUT_CONTRIBUTIONS_KEY,
  type ModelInputContributionRegistry } from "../host/model-input-contributions.ts";
import { finishCompactionTransaction } from "../host/compaction-transaction.ts";
import { applyCompactionToTranscript, compactionExhausted, compactionPressure, shouldCompact, transcriptTokens, messageTokens, scaledMessageTokens, COMPACTION_THRESHOLD, COMPACTION_SOFT_THRESHOLD, CHARS_PER_TOKEN, pruneInFlightMessages, slimInFlightMessages, estimateMessagesTokensPublic, effectiveCompactionWindow, refreshResultRecovery, compactionLandingBudget } from "../host/compaction.ts";
import { canonicalJson } from "../host/canonical.ts";
import {
  classifyModelFailure,
  EmptyCompletionError,
  TRUNCATED_RETRY_BUDGET_SCALE,
  nextProviderRetry,
  providerRetryEligible,
  normalizeModelFailureV1,
  type ModelRouteSelection,
  type NormalizedModelFailureV1,
  type ProviderRetryOptionsV1,
} from "../host/model-failover.ts";
import { MANUAL_HANDOFF_SLIM_SHARE, manualHandoffCaution, prepareFailoverHandoff, prepareFailoverMessages, prepareManualHandoff, type ManualHandoffResult } from "../host/model-handoff.ts";
import type { DurableToolCallReceipt, EventLog } from "../host/event-log.ts";
import { appendUserMessage, safeModelInputText } from "../host/model-input.ts";
import { occupancyOf, cacheHitRatio, contextOccupancy } from "../host/hit-ratio.ts";
import {
  assertPrefixMatchesSeal,
  frozenPrefixHash,
  sameToolSchemas,
  systemPromptHash,
  toolSchemaHash,
  toolSchemaSnapshot,
} from "../host/prefix.ts";
import type { EventInput, EventRecord, Metric, ModelUsage } from "../host/schema.ts";
import { classifySlowTool, intentionalWaitMs, safeArgHint } from "../host/tool-slow.ts";
import { redCaseIdsFor, toolDiagnosis } from "../host/tool-diagnose.ts";
import { latencyBreakdown } from "../host/tool-latency.ts";
import { remoteWorkspacesFromPlan } from "../host/ssh-remote-diff.ts";
import {
  appendToolProfileEvent,
  toolProfileProjectionChanges,
  hasPriorToolProfilePrefix,
} from "../host/tool-profile-event.ts";
import {
  ConsecutiveToolCallGuard,
  TOOL_LOOP_TERMINATION,
  TOOL_LOOP_WARNING,
  toolArgumentsDigest,
  type ToolCallStreak,
} from "../host/tool-loop.ts";
import type {
  HostContext,
  OwnedWorkResourceRegistry,
  LlmRoute,
  LoopFacade,
  PluginModule,
  RequestContextBoundary,
  RequestContextContributionRegistry,
  SessionBudgetSnapshot,
  ToolBudgetFinalizerCall,
} from "../loader/types.ts";
import { projectTools, type ToolProfileName } from "../loader/tool-profiles.ts";
import { enforcedTools, outOfProfileAction, PROFILE_EXCEEDED, refusalText, sendsFullSurface } from "../loader/tool-profile-policy.ts";
import { permissionModeFromEvents } from "../host/permissions.ts";
import type { ModelResilienceService } from "./model-resilience.ts";
import { applyPromptThinkingPolicy } from "./thinking-policy.ts";
import { OperatorAbortError } from "../chat/turn-failure.ts";
import { contributeCancelledTurn } from "../host/cancelled-turn-context.ts";
import { applyRequestContext } from "../host/request-context.ts";
import { ContextFrameError, recordContextDispatch, recordContextResponse } from "../host/context-frame.ts";
import { latestProviderRequestRef } from "../host/provider-input.ts";
import { observedRowsField, runInInvocation, type ObservedRow } from "../host/invocation-scope.ts";
import { readIdentityKey } from "../host/read-identity.ts";
import { READ_BATCH_CHILD_CALL_EVENT } from "../host/tool-rows.ts";
import {
  EARLY_READ_ADMISSION_EVENT,
  RECEIVED_TOOL_EXECUTION_KEY,
  type BoundReceivedSurface,
  type EarlyAdmissionRequest,
  type ReceivedToolExecution,
} from "../host/received-calls.ts";

export interface ToolCallBudgetState {
  limit?: number;
  used: number;
  warned: boolean;
  finalizers?: ReadonlySet<string>;
  finalizerCalls?: ReadonlySet<string>;
  finalizerWorkspaceRoot?: string;
  finalizerRemoteWorkspaces?: Readonly<Record<string, string>>;
  finalizerRemoteWorkspacesLive?: boolean;
}

export interface ModelAttemptState {
  /** Generic plugin-owned completion checkpoints already spent in this episode. */
  completionRounds?: number;
  completionToolsUsed?: number;
  /** The durable user/message already exists for this recursive attempt. */
  accepted?: boolean;
  resume: boolean;
  /** Same-route provider-resilience retries already spent on this turn. ONE
   * counter for every eligible class, because there is one ladder:
   * PROVIDER_RETRY_POLICY_V1 (host/model-failover.ts). */
  providerRetries?: number;
  /** Truncated-reply re-asks already spent. Not a wait and not part of the
   * retry policy: the route answered well and is asked again with a bigger
   * output budget (TRUNCATED_RETRY_BUDGET_SCALE). */
  transportFailures: number;
  /** Superseded by providerRetries; retained so callers that still construct
   * the older shape keep type-checking. Neither is read any more. */
  rateFailures?: number;
  emptyFailures?: number;
  visited: string[];
  /** This prompt() call is a retry/failover leg re-entering facade.prompt
   * from handleBoundaryFailure, not an outermost prompt()/resume(): the
   * session-budget episode of the outermost call stays armed and keeps
   * counting instead of being re-armed. */
  episodeReentry?: true;
}

export class ToolLoopError extends Error {
  readonly code = "DOKKABI_TOOL_LOOP";

  constructor(readonly tool: string, readonly calls: number) {
    super("tool_loop");
    this.name = "ToolLoopError";
  }
}

interface ToolLoopRuntime {
  guard: ConsecutiveToolCallGuard;
  warningCalls: Set<string>;
  terminated?: ToolCallStreak;
}

function resetToolLoop(runtime: ToolLoopRuntime): void {
  runtime.guard.reset();
  runtime.warningCalls.clear();
  delete runtime.terminated;
}

function appendToolLoopEvents(log: { append(input: EventInput): unknown }, streak: ToolCallStreak): void {
  if (streak.reset) {
    log.append({
      kind: "observe",
      name: "tool/loop",
      payload: {
        tool: streak.reset.tool,
        calls: streak.reset.count,
        decision: "reset",
        call_digest: streak.reset.callDigest,
      },
    });
  }
  if (streak.decision === "allow") return;
  log.append({
    kind: "observe",
    name: "tool/loop",
    payload: {
      tool: streak.tool,
      calls: streak.count,
      decision: streak.decision,
      call_digest: streak.callDigest,
    },
  });
}

/** Public terminal error for a provider boundary. The untrusted provider
 * object remains only as `cause`; EventLog, TUI, CLI, and remote surfaces see
 * the normalized class and reason code. */

/** The output cap a request states: the surface's ask bounded by the model's
 * documented limit, or that limit alone when the surface asks for nothing. */
export function boundedMaxTokens(modelMax: number, requested?: number): number | undefined {
  const documented = Number.isFinite(modelMax) && modelMax > 0 ? modelMax : undefined;
  if (requested === undefined) return documented;
  return documented === undefined ? requested : Math.min(documented, requested);
}

export class SafeModelFailureError extends Error {
  constructor(
    readonly failure: NormalizedModelFailureV1,
    cause?: unknown,
    selection?: ModelRouteSelection,
    /** Last observed context size, so an invalid_request line can say what
     * the provider was actually asked to hold. */
    contextTokens?: number | "missing",
  ) {
    super(modelFailureOperatorMessage(failure, selection, contextTokens), { cause });
    this.name = "SafeModelFailureError";
  }
}

function modelFailureOperatorMessage(
  failure: NormalizedModelFailureV1,
  selection?: ModelRouteSelection,
  contextTokens?: number | "missing",
): string {
  if (failure.class === "invalid_request") {
    // The provider rejected the request body itself. With a large carried
    // context this is usually a size rejection despite the advertised window
    // (identical failure digests at ~320-366k on an advertised-1M model), and
    // "unclassified_failure" alone reads as a dead end.
    const size = typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0
      ? ` — last context ~${Math.round(contextTokens)} tokens`
      : "";
    return `model request failed: ${failure.class} (${failure.reasonCode})${size}; `
      + "if the provider rejects this size despite its advertised window, switch with "
      + "`/model <route/model> carry|slim` or rebuild a bounded context with /resume --reseed";
  }
  if (failure.class === "transport_failure") {
    // The reason code is a catch-all; the provider's own words are what say
    // which fault this was. Without them the operator sees the same line for
    // a socket close, a stream that ended, and a fetch that never left.
    const detail = failure.detailHint ? ` — ${failure.detailHint}` : "";
    const where = selection
      ? ` on ${safeSelectionPart(selection.route)}/${safeSelectionPart(selection.model)}`
      : "";
    return `model request failed: transport_failure (${failure.reasonCode})${where}${detail}; `
      + "the link dropped, not the request. Dokkabi retries on a backoff and then hands over to failover "
      + "if a candidate is configured — `dokkabi failover status` shows whether one is.";
  }
  if (failure.class !== "empty_completion" || !selection) {
    return `model request failed: ${failure.class} (${failure.reasonCode})`;
  }
  const route = safeSelectionPart(selection.route);
  const model = safeSelectionPart(selection.model);
  return `model request failed: empty_completion (${route}/${model} returned no content); retry, switch with \`dokkabi model --route <route> <model>\`, or allow failover`;
}

function safeSelectionPart(value: string): string {
  const safe = redactText(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 256);
  return !safe ? "missing" : containsPrivateInfrastructure(safe) ? "redacted" : safe;
}

interface TurnGenerationLimits {
  recovery?: { service: DurableRecoveryService; token: RecoveryOperation; grant?: RecoveryAttemptGrant; toolsPending?: boolean; usage?: { tokens?: number; cost?: number } };
  recoveryError?: unknown;
  providerRole?: string;
  maxOutputTokens?: number;
  thinkingBudgets?: ThinkingBudgets;
  timeoutMs?: number;
  timeoutPolicy?: "fail" | "continue";
  deadlineExpired?: boolean;
  activeToolCalls: number;
  /** Silent-stream stall watchdog state (host/stream-stall.ts): the limit
   * for this turn, whether a request is in flight, when the last assistant
   * delta arrived, and how much text had arrived by then. */
  streamIdleMs?: number;
  streamFirstDeltaMs?: number;
  streaming?: boolean;
  firstDeltaSeen?: boolean;
  lastStreamActivityAt?: number;
  streamChars?: number;
  /** The watchdog fired this turn: message_end must record the aborted
   * fragment as a stall failure, never forward it as a reply. */
  stalled?: boolean;
  /** Sampling temperature for this turn (monkeymode diversity, #59). Absent
   * is the provider default — today's behavior. Never a prompt byte. */
  temperature?: number;
}

/** The LoopFacade sessionBudget option made mutable for the turn hooks. One
 * prompt() call is a whole agentic episode, so the budget is enforced where
 * the next request is decided: at prompt() entry for the episode's first
 * request, in shouldStopAfterTurn for every later one. Counting is in
 * model/usage rows — the same rows the drivers budget on — continuing from
 * the caller's requestsSoFar. The episode arms ONCE at the outermost
 * prompt()/resume(); retry/failover legs re-enter facade.prompt recursively
 * with attempt.episodeReentry set and reuse this state — same anchor, same
 * running count, same exhaustion flag — so every attempted request of every
 * leg counts against the one episode. */
interface SessionBudgetEpisode {
  active: boolean;
  deadlineMs?: number;
  maxRequests?: number;
  requestsSoFar: number;
  /** Whether the model reads the budget in-band. Default true. */
  stateLine: boolean;
  /** model/usage rows in the log when the episode began. */
  usageAtStart: number;
  observe?: (state: SessionBudgetSnapshot) => void;
  exhaustion?: "deadline" | "requests";
}

function countModelUsageRows(events: readonly EventRecord[]): number {
  let count = 0;
  for (const event of events) if (event.name === "model/usage") count += 1;
  return count;
}

function sessionBudgetSnapshot(log: EventLog, budget: SessionBudgetEpisode): SessionBudgetSnapshot {
  const used = budget.requestsSoFar + (countModelUsageRows(log.events) - budget.usageAtStart);
  return {
    remaining_seconds: budget.deadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.round((budget.deadlineMs - Date.now()) / 1_000)),
    requests_used: used,
    ...(budget.maxRequests !== undefined
      ? { requests_remaining: Math.max(0, budget.maxRequests - used) }
      : {}),
  };
}

/** The per-request budget decision: report the state through observe first
 * (the caller appends its budget row there), then name the exhausted limit,
 * if any, instead of letting another provider request begin. */
function checkSessionBudget(log: EventLog, budget: SessionBudgetEpisode): "deadline" | "requests" | undefined {
  if (!budget.active) return undefined;
  const state = sessionBudgetSnapshot(log, budget);
  budget.observe?.(state);
  if (budget.deadlineMs !== undefined && Date.now() >= budget.deadlineMs) return "deadline";
  if (budget.maxRequests !== undefined && state.requests_used >= budget.maxRequests) return "requests";
  return undefined;
}

/** The in-band budget state the MODEL reads: while a session budget is
 * active, one bracketed line appended to every tool result, built from the
 * same snapshot observe reports (seconds already rounded and clamped there).
 * State only — no advice. Each clause appears only when its limit is set; a
 * budget with no limits carries no state, so there is no line. The line is
 * part of the recorded tool/result, so replay reproduces it from the log and
 * never recomputes it from the clock.
 *
 * A caller may turn the line off (SessionBudget.stateLine: false) and keep the
 * enforcement: the host still ends the episode on the same limits, and the
 * model's band carries no budget state. */
function sessionBudgetStateLine(log: EventLog, budget: SessionBudgetEpisode): string | undefined {
  if (!budget.active || !budget.stateLine) return undefined;
  const state = sessionBudgetSnapshot(log, budget);
  const parts: string[] = [];
  if (budget.deadlineMs !== undefined) parts.push(`${state.remaining_seconds} s remaining`);
  if (state.requests_remaining !== undefined) parts.push(`${state.requests_remaining} requests left`);
  if (parts.length === 0) return undefined;
  return `[session budget: ${parts.join(", ")}]`;
}

/** The typed stop the caller reads back from its log, once per episode. */
function recordSessionBudgetExhaustion(
  log: EventLog,
  budget: SessionBudgetEpisode,
  reason: "deadline" | "requests",
): void {
  if (budget.exhaustion !== undefined) return;
  budget.exhaustion = reason;
  log.append({
    kind: "observe",
    name: "loop/budget_exhausted",
    payload: {
      scope: "session",
      reason,
      requests_used: sessionBudgetSnapshot(log, budget).requests_used,
    },
  });
}

/**
 * DOKKABI_TEMPERATURE, set by a sampling coordinator on the work child.
 * Anything but a finite value in (0, 2] fails closed to the provider
 * default: a typo must not silently change every generation.
 */
export function resolveSamplingTemperature(env: NodeJS.Dict<string> = process.env): number | undefined {
  const raw = env.DOKKABI_TEMPERATURE?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 2) return undefined;
  return value;
}

const SLOW_TOOL_ASSESSMENT = Symbol("dokkabi.slow-tool-assessment");

interface SlowToolAssessment {
  durationMs: number;
  resultBytes: number;
  argHint: string;
  reasons?: string[];
  waitedMs?: number;
}

export type ToolCallBudgetDecision = "allow" | "warn" | "terminate";

/**
 * A budget whose escape hatch names tools the turn does not have is a wall.
 *
 * The repair turn after a refused plan gets no exploration budget at all and
 * is meant to finish by writing its artifacts through the finalizer tools
 * "write" and "edit". Those are part of the descriptor-anchored set, which is
 * built only on Linux — so a macOS run has bash and little else, the allowlist
 * matched nothing, every call was refused, and the turn was told to use tools
 * absent from its own list. The model noticed, tried the shell twice, and the
 * campaign ended without a plan.
 *
 * Finalizers are therefore resolved against what the turn actually has. A
 * bounded non-zero turn may fall back to the shell when no declared writer is
 * exposed; a zero-budget repair turn never gets that fallback, so it cannot
 * reopen exploration through bash.
 */
const WRITING_FALLBACK_TOOLS = ["bash"] as const;

export function resolveFinalizers(
  declared: readonly string[] | undefined,
  available: readonly string[],
  allowFallback = true,
): Set<string> | undefined {
  if (declared === undefined) return undefined;
  const present = new Set(available);
  const kept = declared.filter((name) => present.has(name));
  if (kept.length > 0 || declared.length === 0) return new Set(kept);
  if (!allowFallback) return new Set();
  return new Set(WRITING_FALLBACK_TOOLS.filter((name) => present.has(name)));
}

function finalizerCallKey(call: ToolBudgetFinalizerCall): string {
  return call.tool === "ssh" ? `${call.tool}:${call.op}` : `${call.tool}:${call.path}`;
}

export function resolveFinalizerCalls(
  declared: readonly ToolBudgetFinalizerCall[] | undefined,
  available: readonly string[],
): ReadonlySet<string> | undefined {
  if (declared === undefined) return undefined;
  const present = new Set(available);
  return new Set(
    declared
      .filter((call) => present.has(call.tool))
      .map(finalizerCallKey),
  );
}

type SshPutArguments = Readonly<{
  op: "put";
  target: string;
  local: string;
  remote: string;
  recursive?: boolean;
  timeout?: number;
}>;

function isSshPutCall(args: unknown): args is SshPutArguments {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  const allowed = new Set(["op", "target", "local", "remote", "recursive", "timeout"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return value.op === "put"
    && typeof value.target === "string"
    && typeof value.local === "string"
    && typeof value.remote === "string"
    && (value.recursive === undefined || typeof value.recursive === "boolean")
    && (value.timeout === undefined || typeof value.timeout === "number");
}

function canonicalRemotePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.includes("\0")) return undefined;
  const home = normalized === "$HOME"
    ? "~"
    : normalized.startsWith("$HOME/")
      ? `~/${normalized.slice("$HOME/".length)}`
      : normalized;
  const absolute = home.startsWith("/");
  const homeRelative = home === "~" || home.startsWith("~/");
  if (!absolute && !homeRelative) return undefined;
  const prefix = absolute ? "/" : home === "~" ? "~" : "~/";
  const body = absolute ? home.slice(1) : homeRelative && home !== "~" ? home.slice(2) : "";
  const segments = body.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  return prefix === "/" ? `/${segments.join("/")}` : prefix === "~" ? "~" : `~/${segments.join("/")}`;
}

function isSafeFinalizerRemotePath(
  target: string,
  remote: string,
  declaredWorkspaces: Readonly<Record<string, string>> | undefined,
): boolean {
  const declared = declaredWorkspaces !== undefined && Object.hasOwn(declaredWorkspaces, target)
    ? declaredWorkspaces[target]
    : undefined;
  const base = canonicalRemotePath(declared ?? "");
  const destination = canonicalRemotePath(remote);
  if (base === undefined || destination === undefined) return false;
  const suffix = base === "~"
    ? destination.startsWith("~/") ? destination.slice(2) : undefined
    : destination.startsWith(`${base}/`) ? destination.slice(base.length + 1) : undefined;
  if (suffix === undefined || (!suffix.startsWith("tests/") && !suffix.startsWith("work/"))) return false;
  return !isSecretPath(suffix);
}

/** Refresh only the repair artifact the host may have rewritten. This is
 * finalization, not permission to inspect other workspace inputs. */
function isPlanReadFinalizer(budget: ToolCallBudgetState, args: unknown): boolean {
  if (budget.finalizerCalls?.has("read:work/current.json") !== true ||
    budget.finalizerWorkspaceRoot === undefined || typeof args !== "object" ||
    args === null || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some(key => !["path", "offset", "limit"].includes(key)) ||
    typeof value.path !== "string" ||
    [value.offset, value.limit].some(number => number !== undefined &&
      (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1))) return false;
  const root = resolve(budget.finalizerWorkspaceRoot);
  if (value.path !== "work/current.json" && value.path !== join(root, "work", "current.json")) return false;
  try {
    // Even an in-workspace parent alias must not broaden this exact exception.
    const parent = lstatSync(join(root, "work"));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
    return isSafeWorkspaceTransferSource(root, value.path);
  } catch {
    return false;
  }
}

function isFinalizerCall(
  budget: ToolCallBudgetState,
  toolName: string,
  args: unknown,
): boolean {
  if (toolName === "read") return isPlanReadFinalizer(budget, args);
  if (toolName !== "ssh" || !isSshPutCall(args)) return false;
  if (budget.finalizerCalls?.has("ssh:put") !== true) return false;
  if (budget.finalizerWorkspaceRoot === undefined) return false;
  if (args.recursive === true) return false;
  const declaredWorkspaces = budget.finalizerRemoteWorkspacesLive === true
    ? readFinalizerRemoteWorkspaces(budget.finalizerWorkspaceRoot)
    : budget.finalizerRemoteWorkspaces;
  return isSafeWorkspaceTransferSource(budget.finalizerWorkspaceRoot, args.local)
    && isSafeFinalizerRemotePath(args.target, args.remote, declaredWorkspaces);
}

function readFinalizerRemoteWorkspaces(workspaceRoot: string): Readonly<Record<string, string>> {
  try {
    const plan = JSON.parse(readFileSync(join(workspaceRoot, "work", "current.json"), "utf8")) as unknown;
    return remoteWorkspacesFromPlan(plan);
  } catch {
    return {};
  }
}

function finalizerHints(budget: ToolCallBudgetState): string[] {
  const hints = [...(budget.finalizers ?? [])];
  if (budget.finalizerCalls?.has("ssh:put") === true) hints.push("ssh op=put");
  if (budget.finalizerCalls?.has("read:work/current.json") === true) hints.push("read work/current.json");
  return hints;
}

export function toolCallBudgetDecision(
  budget: ToolCallBudgetState,
  toolName?: string,
  args?: unknown,
): ToolCallBudgetDecision {
  if (budget.limit === undefined) {
    return "allow";
  }
  if (toolName !== undefined && budget.finalizers?.has(toolName)) {
    return "allow";
  }
  if (toolName !== undefined && isFinalizerCall(budget, toolName, args)) {
    return "allow";
  }
  budget.used += 1;
  if (budget.used <= budget.limit) {
    return "allow";
  }
  if (!budget.warned) {
    budget.warned = true;
    return "warn";
  }
  return "terminate";
}

/** Preserve full tool arguments only when every nested string passes the
 * EventLog's own secret predicate. Checking JSON.stringify(args) is weaker:
 * escaping quote-based assignments can hide a value the recursive log guard
 * will still reject. */
const NO_OBSERVED_DIGESTS: ReadonlySet<string> = new Set<string>();

export function safeToolCallArgs(args: unknown): unknown | undefined {
  const value = args ?? {};
  return containsSecretValue(value) ? undefined : value;
}

/** `ssh op=enroll` is the one sanctioned path for an operator coordinate to
 * enter (it is approval-gated and writes to the operator's ssh config, never
 * to the log). Its args are still WITHHELD from the durable payload — they
 * simply must not be mistaken for a secret and blocked before execution. */
export function isSshEnrollCall(toolName: string, args: unknown): boolean {
  return toolName === "ssh"
    && typeof args === "object" && args !== null
    && (args as { op?: unknown }).op === "enroll";
}

export function safeWorkspaceMutationArgs(toolName: string, args: unknown): unknown | undefined {
  const protectsPrivateCoordinates = protectsPrivateInfrastructure(toolName);
  if (protectsPrivateCoordinates && !isSshEnrollCall(toolName, args) && containsPrivateInfrastructureValue(args)) {
    return undefined;
  }
  return safeToolCallArgs(args);
}

export function safeWorkspaceMutationArgHint(toolName: string, args: unknown): string {
  const protectsPrivateCoordinates = protectsPrivateInfrastructure(toolName);
  if (protectsPrivateCoordinates && containsPrivateInfrastructureValue(args)) return "";
  return safeArgHint(toolName, args);
}

function protectsPrivateInfrastructure(toolName: string): boolean {
  return toolName === "read"
    || toolName === "write"
    || toolName === "edit"
    || toolName === "ssh"
    || toolName === "bash"
    || toolName === "bash_wait"
    || toolName === "bash_probe";
}

/** Build the exact durable tool/call payload and return the independently
 * useful execution decision. Secret-shaped nested arguments never join the
 * payload; the redacted hint is the only retained representation. The durable
 * `args` are account-normalized (home paths become `~/…`) while execution
 * uses the original arguments unchanged, and `args_digest` stays the digest
 * of the ORIGINAL arguments — replay, the loop-streak guard, and speculative
 * promotion all key on that digest, so normalization must never move it. */
export function safeToolCallRecord(
  toolName: string,
  toolCallId: string,
  args: unknown,
  observedDigests: () => ReadonlySet<string> = () => NO_OBSERVED_DIGESTS,
): { payload: Record<string, unknown>; safeArgs: unknown | undefined; argsDigest: string } {
  const safeArgs = safeWorkspaceMutationArgs(toolName, args);
  const argsDigest = toolArgumentsDigest(args);
  // Provenance is taken from the RAW arguments, because the scrub below is
  // what removes the only copy of the model's own literal the log would hold.
  // Digests only: enough to recognise the same string later, and a strictly
  // weaker disclosure than the value the guard exists to keep out. A digest
  // the session already READ stays out — the model can only be echoing it.
  const authored = authoredSecretDigests(args, observedDigests);
  // An enroll may execute with its coordinate, but the coordinate must never
  // become durable: withhold its args from the payload independently of the
  // execution decision.
  const durableArgs = isSshEnrollCall(toolName, args) && containsPrivateInfrastructureValue(args)
    ? undefined
    : safeArgs;
  return {
    payload: {
      name: toolName,
      id: toolCallId,
      args_digest: argsDigest,
      arg_hint: safeWorkspaceMutationArgHint(toolName, args),
      ...(durableArgs === undefined ? {} : { args: normalizeHomePathsValue(durableArgs) }),
      ...(authored.length === 0 ? {} : { authored_secret_digests: authored }),
    },
    safeArgs,
    argsDigest,
  };
}

/** Foreground shell executions in the current operator turn, and whether the
 * batching nudge has already been delivered for it. */
export interface ProbeChurnState {
  shellCalls: number;
  hinted: boolean;
}

export const PROBE_HINT_THRESHOLD = 6;

/** One in-band nudge per churning turn: sustained one-command probing is the
 * observed cost pattern (440 requests in 37 minutes while bash_probe sat
 * unused), and a single bracketed line on the Nth result steers without
 * blocking. bash_probe/bash_wait/bash_poll are the remedy, so they never
 * count; neither do read tools. */
export function probeBatchingHint(state: ProbeChurnState, toolName: string): string | undefined {
  if (toolName !== "bash" && toolName !== "ssh") return undefined;
  state.shellCalls += 1;
  if (state.hinted || state.shellCalls < PROBE_HINT_THRESHOLD) return undefined;
  state.hinted = true;
  return `[probe hint: ${state.shellCalls} foreground shell calls this turn — batch independent read-only diagnostics into one bash_probe call (id-keyed results), and poll conditions with bash_wait instead of repeated checks.]`;
}

export function privateInfrastructureRefusal(toolName: string, matchClass?: string): string {
  // The refusal must name the actual exit. A blocked BASH call is using the
  // wrong tool — send it to ssh. A blocked SSH call is already on the right
  // tool with a coordinate inside its own arguments — telling it to "use the
  // ssh tool" looped it dead (observed live: bash blocked, then ssh blocked
  // with the same text, twice). Tell it what to change instead. The refusal
  // names the CLASS of the coordinate that matched — never its value — so the
  // model can find the span in its own arguments.
  const matched = matchClass ?? "a private address or account";
  if (toolName === "ssh") {
    return `Private infrastructure arguments are blocked: this ssh call carries ${matched} where a Host alias belongs. If NO alias exists for this host yet, register one with \`ssh op=enroll alias=<name> address=<the operator's user@host>\` — the operator confirms it in a popup (or it is automatic under bypass) and it is written to their ssh config, never logged; then use op=exec target=<name>. Never put a raw address in op=exec, and on the remote side refer to services as localhost or by names from operator-owned remote configuration. If you cannot proceed, stop and report the blocker to the operator.`;
  }
  return `Private infrastructure arguments are blocked: this call carries ${matched}. Do not stage or encode them in workspace files. Private infrastructure belongs in operator-owned configuration. Use an already-available authorized tool: the official ssh tool with op=exec and an operator-owned logical Host alias; multiline remote work goes in its script parameter, delivered over stdin. Do not open a remote shell from the sandbox; if no authorized alias is available, stop and report the blocker to the operator.`;
}

/** Private-infrastructure blocks already delivered in the current operator
 * turn. Reset with the other per-turn churn state on prompt acceptance. */
export interface GuardChurnState {
  blocks: number;
  /** Sticky once the threshold is crossed: the loop core only ends a batch
   * when EVERY call in it terminates, and a fresh turn would otherwise start
   * the count over — live, blocks 4, 5 and 6 kept landing after the third
   * "terminate". Staying tripped makes every later block terminal too. */
  tripped?: boolean;
}

export const GUARD_CHURN_THRESHOLD = 3;

/**
 * The live audit found 80 guard blocks, 46 of them inside one hour: each
 * refusal fed the next workaround (staging, base64 chunks, obfuscated paths)
 * instead of the report the refusal text asked for. Repeating the same
 * refusal is what churned, so at the threshold the turn ends — a terminated
 * turn reaches the operator; a fourth refusal reaches a fifth workaround.
 */
export function privateInfrastructureBlockDecision(
  state: GuardChurnState,
  toolName: string,
  matchClass?: string,
): { reason: string; terminate: boolean; announce?: boolean } {
  state.blocks += 1;
  const refusal = privateInfrastructureRefusal(toolName, matchClass);
  if (!state.tripped && state.blocks < GUARD_CHURN_THRESHOLD) {
    return { reason: refusal, terminate: false };
  }
  const announce = !state.tripped;
  state.tripped = true;
  return {
    reason: `${refusal} [guard escalation: ${state.blocks} private-infrastructure blocks this operator turn — every variant of this approach is fenced, so the turn ends here. Report the blocker to the operator.]`,
    terminate: true,
    ...(announce ? { announce: true } : {}),
  };
}

const UNKNOWN_TOOL_TEXT = /^Tool (\S+) not found$/u;

/**
 * A remembered tool from another harness died by attrition live (five calls
 * to read/write/write_with_encoding_args). The loop core answers before any
 * hook runs, so the roster is patched into the result just before the next
 * request — only within the current batch (after the last assistant message),
 * because anything earlier has already been paid for in the prompt prefix.
 */
export function annotateUnknownToolResults(
  messages: AgentMessage[],
  toolNames: readonly string[],
): { messages: AgentMessage[]; annotated: number } | undefined {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  let annotated = 0;
  const out = messages.map((message, index) => {
    if (index <= lastAssistant || message.role !== "toolResult") return message;
    const record = message as unknown as { content?: { type?: string; text?: string }[] };
    const part = record.content?.[0];
    if (record.content?.length !== 1 || part?.type !== "text" || typeof part.text !== "string") return message;
    const match = UNKNOWN_TOOL_TEXT.exec(part.text);
    if (!match) return message;
    annotated += 1;
    return {
      ...message,
      content: [{
        type: "text",
        text: `Tool ${match[1]} not found. This harness has no such tool — available tools: ${toolNames.join(", ")}. Use one of these; do not call tool names remembered from other harnesses.`,
      }],
    } as typeof message;
  });
  return annotated === 0 ? undefined : { messages: out, annotated };
}

const BASH_SSH_FAILURE = /ssh: Could not resolve hostname|ssh: connect to host \S+ port|Permission denied \(publickey/u;

/** A raw ssh from bash fails on purpose — the sandbox holds no aliases or
 * credentials. Say where they live instead of letting the retry loop guess. */
export function bashSshRedirectHint(
  toolName: string,
  isError: boolean,
  resultText: string,
): string | undefined {
  if (toolName !== "bash" || !isError || !BASH_SSH_FAILURE.test(resultText)) return undefined;
  return "[remote hint: bash has no SSH aliases or credentials — use the ssh tool (op=exec) with an operator-owned Host alias; multiline work goes in its script parameter.]";
}

export function attachPiLoop(ctx: HostContext): LoopFacade {
  let operatorAbort = false;
  let recoveryAbort = new AbortController();
  let disposed = false;
  const probeChurn: ProbeChurnState = { shellCalls: 0, hinted: false };
  const guardChurn: GuardChurnState = { blocks: 0 };
  let live:
    | {
        key: string;
        agent: Agent;
        route: string;
        model: string;
      }
    | undefined;
  const sink: { onAssistant?: (text: string) => void } = {};
  const toolBudget: ToolCallBudgetState = {
    used: 0,
    warned: false,
    finalizerWorkspaceRoot: ctx.workspaceRoot,
  };
  const generationLimits: TurnGenerationLimits = { activeToolCalls: 0 };
  const sessionBudget: SessionBudgetEpisode = { active: false, requestsSoFar: 0, stateLine: true, usageAtStart: 0 };
  const repeatedReads = new Map<string, RepeatReadEntry>();
  // The profile the current step is held to at the call (tool-profile-policy.ts).
  // One object for the loop's lifetime: a live agent outlives a profile change
  // now that working profiles send the same tool surface.
  const profileScope: ProfileScope = { current: undefined };
  const toolLoop: ToolLoopRuntime = {
    guard: new ConsecutiveToolCallGuard(),
    warningCalls: new Set(),
  };
  let speculation: SpeculationService | undefined;
  let speculationRevision: number | undefined;
  // #227: the tool profile the current request is projected under, read by
  // the request-context boundary inside the live agent's next-turn hook.
  const requestContext: RequestContextState = { profile: "default" };

  const projectSpeculativeTools = (
    available: readonly AgentTool[],
    projected: readonly AgentTool[],
  ): AgentTool[] => {
    const provider = ctx.tryGet<SpeculationService>("speculation");
    if (speculation !== provider) {
      speculation?.invalidate();
      speculation = provider;
      speculationRevision = undefined;
      live = undefined;
    }
    if (!provider) return [...projected];
    const projection = provider.project({ available, projected });
    if (speculationRevision !== projection.revision) {
      speculationRevision = projection.revision;
      live = undefined;
    }
    return [...projection.tools];
  };

  type PromptOptions = Exclude<Parameters<LoopFacade["prompt"]>[1], undefined>;

  async function handlePreRequestFailure(input: {
    route: LlmRoute;
    modelId: string;
    error: unknown;
    text: string;
    options: PromptOptions | undefined;
    attempt: ModelAttemptState;
  }): Promise<void> {
    const normalized = normalizeModelFailureV1({ error: input.error });
    ctx.log.append({
      kind: "observe",
      name: "model/usage",
      observe: {
        model_usage: usageFromBoundaryFailure(ctx.log, input.route, input.modelId, normalized),
      },
    });
    ctx.log.append({
      kind: "observe",
      name: "agent/status",
      payload: {
        status: "failed",
        route: input.route.name,
        error: normalized.reasonCode,
        failure_class: normalized.class,
      },
    });
    return handleBoundaryFailure({
      ...input,
      messages: messagesAtUnstartedBoundary(
        ctx,
        input.route.name,
        input.modelId,
        input.text,
        input.attempt.resume === true,
      ),
      allowSameRouteRetry: true,
    });
  }

  async function handleBoundaryFailure(input: {
    route: LlmRoute;
    modelId: string;
    error: unknown;
    messages: readonly AgentMessage[];
    text: string;
    options: PromptOptions | undefined;
    attempt: ModelAttemptState;
    allowSameRouteRetry: boolean;
  }): Promise<void> {
    if (isRecoveryTerminalError(input.error)) throw input.error;
    if (generationLimits.recoveryError) throw generationLimits.recoveryError;
    if (input.error instanceof ProviderInputError || (input.error instanceof Error && input.error.message.startsWith("provider-input:"))) {
      throw observeProviderInputRefusal(ctx.log, input.error, "turn");
    }
    if (liveProviderState(ctx.log).ref) assertProviderMessages(ctx.log, input.messages);
    const current = { route: input.route.name, model: input.modelId };
    const failure = normalizeModelFailureV1({ error: input.error, retriesExhausted: true });
    const failureClass = classifyModelFailure(input.error);
    const retryMessages = prepareFailoverMessages(input.messages);
    // Both bounds on the wait come from facts already in hand: what the
    // provider stated, and what is left of the episode's deadline. A retry
    // that would wake after the deadline is refused here rather than slept,
    // so the turn ends with the class it observed instead of with a budget
    // that expired inside a sleep.
    const durable = generationLimits.recovery;
    let durableRetry: { attempt: number; delayMs: number; providerRetries: number; transportFailures: number; retryAfterMs?: number } | undefined;
    if (durable?.grant) {
      const grant = durable.grant;
      if (durable.toolsPending && !prepareFailoverHandoff(input.messages, { continuity: "continue" }).resumable) throw new RecoveryTerminalError("reconciliation_required", durable.token);
      durable.grant = undefined;
      if (failureClass === "output_truncated") {
        durable.service.result(durable.token, grant);
      } else {
        if (!resumableSuffix(retryMessages.messages)) throw new Error("recovery continuation is not resumable");
        const decision = durable.service.failure(durable.token, grant, {
          class: failureClass,
          retry: input.allowSameRouteRetry,
          ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterMs: failure.retryAfterSeconds * 1000 }),
        });
        if (input.allowSameRouteRetry && providerRetryEligible(failureClass)) durableRetry = { ...decision, providerRetries: decision.attempt, transportFailures: input.attempt.transportFailures,
          ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterMs: failure.retryAfterSeconds * 1000 }) };
      }
    }
    const retry = durableRetry ?? (input.allowSameRouteRetry && (!durable || failureClass === "output_truncated")
      ? sameRouteRetry(input.attempt, failureClass, failure.reasonCode, {
          ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterMs: failure.retryAfterSeconds * 1_000 }),
          ...(sessionBudget.active && sessionBudget.deadlineMs !== undefined
            ? { remainingMs: Math.max(0, sessionBudget.deadlineMs - Date.now()) }
            : {}),
        })
      : undefined);
    if (retry && resumableSuffix(retryMessages.messages)) {
      replaceProviderMessages(ctx.log, retryMessages.messages, "model/retry", { reason_code: failure.reasonCode });
      if (!saveMessagesForRoute(ctx, current.route, current.model, retryMessages.messages)) {
        throw new SafeModelFailureError(failure, input.error, current, lastUsage(ctx)?.context_used);
      }
      live = undefined;
      input.route.resetSession?.(ctx.sessionId);
      ctx.log.append({
        kind: "observe",
        name: "model/retry",
        payload: {
          attempt: retry.attempt,
          delay_ms: retry.delayMs,
          reason_class: failureClass,
          // The stated wait that produced this delay, when there was one: the
          // row has to say why it waited two minutes, and replay reads both
          // numbers back rather than deriving either.
          ...(retry.retryAfterMs === undefined ? {} : { retry_after_ms: retry.retryAfterMs }),
        },
      });
      const waitMs = retryBackoffMs(retry.delayMs);
      if (durable) {
        try { await durable.service.wait(durable.token, recoveryAbort.signal); }
        catch (error) { if (operatorAbort) throw new OperatorAbortError(); throw error; }
      } else if (waitMs > 0) await Bun.sleep(waitMs);
      // Retrying a truncated reply with the same budget truncates it again.
      // The scale is what the ladder counted, so the second rung asks for
      // four times the first rather than twice the already-doubled one.
      const truncatedScale = failureClass === "output_truncated"
        ? TRUNCATED_RETRY_BUDGET_SCALE[retry.attempt - 1]
        : undefined;
      const widened: { maxOutputTokens?: number } = truncatedScale !== undefined && input.options?.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.options.maxOutputTokens * truncatedScale }
        : {};
      return facade.prompt(input.text, {
        ...input.options,
        ...widened,
        modelId: current.model,
        __attempt: {
          ...input.attempt,
          accepted: true,
          resume: true,
          episodeReentry: true,
          providerRetries: retry.providerRetries,
          transportFailures: retry.transportFailures,
        },
      } as PromptOptions);
    }

    const resilience = ctx.tryGet<ModelResilienceService>("model_resilience");
    if (!resilience) throw new SafeModelFailureError(failure, input.error, current, lastUsage(ctx)?.context_used);
    const policy = await resilience.policy();
    const handoff = prepareFailoverHandoff(input.messages, policy.continuity === "checkpoint"
      ? { continuity: "checkpoint", checkpoint: failoverCheckpointMessage(ctx) }
      : { continuity: "continue" });
    const visited = new Set([...input.attempt.visited, modelSelectionName(current)]);
    const next = await resilience.next(current, input.error, visited, {
      resumable: handoff.resumable,
      turnId: currentTurnId(ctx),
      recoveryOperation: durable?.token,
    });
    if (!next) {
      if (durable) durable.service.exhaust(durable.token, "failure_ineligible");
      throw new SafeModelFailureError(failure, input.error, current, lastUsage(ctx)?.context_used);
    }

    const pending = resilience.pendingTransition();
    if (
      !pending
      || pending.target.route !== next.route
      || pending.target.model !== next.model
    ) {
      throw new Error("model resilience returned a transition without sealed state");
    }
    const target = ctx.llm?.routes.get(next.route);
    if (!target || next.route === "replay") {
      const missing = "target_route_unavailable";
      const digest = modelEventDigest({ from: current, to: next, reason_code: missing });
      resilience.failTransition(next, digest, missing);
      throw new SafeModelFailureError(failure, input.error, current, lastUsage(ctx)?.context_used);
    }

    const transitionFact = {
      from: current,
      to: next,
      from_selection_digest: modelEventDigest(current),
      to_selection_digest: modelEventDigest(next),
      failure_class: failure.class,
      reason_code: failure.reasonCode,
      policy_digest: pending.policyDigest,
      continuity: pending.continuity,
      generation: pending.generation,
      dropped_failed_assistant: handoff.droppedFailedAssistant,
      handoff_digest: modelEventDigest(handoff.messages),
    };
    const transitionDigest = modelEventDigest(transitionFact);
    ctx.log.append({
      kind: "effect",
      name: "model/route_transition",
      payload: { ...transitionFact, transition_digest: transitionDigest },
    });

    const failoverSource = liveProviderState(ctx.log);
    replaceProviderMessages(ctx.log, handoff.messages, "model/failover", { transition_digest: transitionDigest,
      metadata: transcriptMetadata(ctx, next.route, next.model) });
    let persisted = false;
    try { persisted = saveMessagesForRoute(ctx, next.route, next.model, handoff.messages); } catch { /* The recorded source is restored below. */ }
    if (!persisted) {
      if (failoverSource.ref) replaceProviderMessages(ctx.log, failoverSource.messages, "model/handoff_rollback", {
        transition_digest: transitionDigest, source_state: failoverSource.ref,
        metadata: failoverSource.metadata ?? transcriptMetadata(ctx, current.route, current.model),
      });
      ctx.log.append({
        kind: "observe",
        name: "model/handoff_failed",
        payload: {
          transition_digest: transitionDigest,
          reason_code: "transcript_not_persisted",
        },
      });
      resilience.failTransition(next, transitionDigest, "transcript_not_persisted");
      throw new SafeModelFailureError(failure, input.error, current, lastUsage(ctx)?.context_used);
    }

    live = undefined;
    input.route.resetSession?.(ctx.sessionId);
    ctx.llm?.select(next.route, next.model);
    // The route selection and transcript are now durable and the transition
    // result is visible before recursive prompt() reaches ready/resolve/stream.
    // Thus an approved candidate's first provider request can never precede
    // the effect/result pair in the EventLog.
    resilience.activateTransition(next, transitionDigest);
    return facade.prompt(input.text, {
      ...input.options,
      modelId: next.model,
      __attempt: {
        ...input.attempt,
        accepted: true,
        resume: true,
        episodeReentry: true,
        providerRetries: 0,
        transportFailures: 0,
        visited: [...visited],
      },
    } as PromptOptions);
  }

  const facade: LoopFacade = {
    implementation: "pi",
    async resume(options) {
      return facade.prompt("", {
        ...options,
        __attempt: {
          accepted: true,
          resume: true,
          providerRetries: 0,
          transportFailures: 0,
          visited: [],
        },
      } as PromptOptions);
    },
    async prompt(text, options) {
      const internal = options as typeof options & { __attempt?: ModelAttemptState };
      const attempt: ModelAttemptState = internal?.__attempt ?? {
        accepted: false,
        resume: false,
        providerRetries: 0,
        transportFailures: 0,
        visited: [],
      };
      if (!attempt.accepted) {
        operatorAbort = false;
        if (recoveryAbort.signal.aborted) recoveryAbort = new AbortController();
        repeatedReads.clear();
        resetToolLoop(toolLoop);
        probeChurn.shellCalls = 0;
        probeChurn.hinted = false;
        guardChurn.blocks = 0;
        delete guardChurn.tripped;
      }
      if (operatorAbort) {
        throw new OperatorAbortError();
      }
      ctx.log.assertCanRequestModel();
      ctx.requireSealedBeforeModel();
      // The session budget arms ONCE per outermost prompt()/resume(), and the
      // episode's first request is decided here; every later request of the
      // episode passes the same check in shouldStopAfterTurn, so a model that
      // never stops issuing tool calls is still budgeted inside ONE prompt()
      // call. Retry/failover legs re-enter facade.prompt recursively with
      // attempt.episodeReentry set: they skip the arming and reuse the episode
      // the outermost call anchored — same usageAtStart, same running count,
      // same exhaustion flag — so a flapping provider cannot restart the count
      // per leg and spend the budget twice inside a single prompt() call.
      if (attempt.episodeReentry !== true) {
        sessionBudget.active = options?.sessionBudget !== undefined;
        sessionBudget.deadlineMs = options?.sessionBudget?.deadlineMs;
        sessionBudget.maxRequests = options?.sessionBudget?.maxRequests;
        sessionBudget.requestsSoFar = options?.sessionBudget?.requestsSoFar ?? 0;
        sessionBudget.stateLine = options?.sessionBudget?.stateLine !== false;
        sessionBudget.usageAtStart = countModelUsageRows(ctx.log.events);
        sessionBudget.observe = options?.sessionBudget?.observe;
        sessionBudget.exhaustion = undefined;
      }
      const sessionStopAtEntry = checkSessionBudget(ctx.log, sessionBudget);
      if (sessionStopAtEntry !== undefined) {
        recordSessionBudgetExhaustion(ctx.log, sessionBudget, sessionStopAtEntry);
        return;
      }
      const compacted = compactIfNeeded(ctx);
      const llm = ctx.llm;
      if (!llm) {
        throw new Error("ctx.llm is not registered");
      }
      const route = llm.active();
      if (compacted) {
        live = undefined;
        route.resetSession?.(ctx.sessionId);
      }
      if (!attempt.accepted) {
        text = appendUserMessage(ctx.log, text, options?.origin ?? "harness");
        options?.onAccepted?.();
      } else {
        // Recursive retries only receive the already-accepted value, but keep
        // the boundary defensive so an internal caller cannot reintroduce a
        // raw credential shape on a resumed request.
        text = safeModelInputText(text).text;
      }

      const recovery = route.name === "replay" ? undefined : ctx.tryGet<ModelResilienceService>("model_resilience")?.recovery;
      const token = options?.recoveryOperation ?? recovery?.bind(inputDigest({ text, origin: options?.origin ?? "harness", toolScope: options?.toolScope ?? null }), attempt.accepted === true);
      if (recovery && token) {
        await recovery.wait(token, recoveryAbort.signal);
        generationLimits.recovery = { service: recovery, token, grant: recovery.reserve(token) };
        generationLimits.recoveryError = undefined;
      } else generationLimits.recovery = undefined;
      const requestedModelId = llm.activeModelId ?? options?.modelId ?? route.defaultModelId() ?? "missing";
      let ready: Awaited<ReturnType<LlmRoute["ready"]>>;
      try {
        ready = await route.ready();
      } catch (error) {
        return handlePreRequestFailure({
          route,
          modelId: requestedModelId,
          error,
          text,
          options,
          attempt,
        });
      }
      if (!ready.ok) {
        return handlePreRequestFailure({
          route,
          modelId: requestedModelId,
          // ready.reason is provider/operator text and may contain a private
          // endpoint or account hint. The boundary knows only that the
          // selected credential is unavailable; preserve that normalized
          // fact and never carry the raw reason into EventLog or TUI.
          error: new Error("authentication unavailable"),
          text,
          options,
          attempt,
        });
      }
      ctx.log.append({
        kind: "observe",
        name: "agent/status",
        payload: { status: "running", route: route.name },
      });

      let model: Model<Api>;
      try {
        model = (await route.resolveModel(llm.activeModelId ?? options?.modelId)) as Model<Api>;
      } catch (error) {
        return handlePreRequestFailure({
          route,
          modelId: requestedModelId,
          error,
          text,
          options,
          attempt,
        });
      }
      void maybeRecordQuota(ctx, route, model.id);
      const availableTools = toolsFor(ctx);
      const scopeProfile = options?.toolScope?.profile ?? "default";
      const projectedTools = projectTools(availableTools ?? [], scopeProfile);
      // A working profile sends every tool so the prompt head stays put across
      // steps; the profile is held at the call instead (tool-profile-policy.ts).
      const tools = projectSpeculativeTools(availableTools ?? [],
        sendsFullSurface(scopeProfile) ? (availableTools ?? []) : projectedTools);
      const toolScopeTodo = options?.toolScope?.todo ?? "unscoped";
      profileScope.current = scopeProfile === "default" || !sendsFullSurface(scopeProfile)
        ? undefined
        : {
            profile: scopeProfile,
            todo: toolScopeTodo,
            allowed: new Set(enforcedTools(ctx.log.events, scopeProfile, toolScopeTodo, tools.map((tool) => tool.name))),
          };
      const recordedTools = profileScope.current
        ? projectTools(tools, scopeProfile).map((tool) => tool.name)
        : tools.map((tool) => tool.name);
      const activeSpeculation = speculation;
      const schemas = toolSchemaSnapshot(tools);
      if ((availableTools !== undefined || options?.toolScope !== undefined)
        && !sameToolSchemas(ctx.toolSchemas, schemas)) {
        ctx.toolSchemas = schemas;
        ctx.markModelFacingChange();
      }
      const toolScope = options?.toolScope
        ?? (availableTools === undefined ? undefined : { todo: "unscoped", profile: "default" as const });
      // Seal for the PROFILE, not only for the prefix. A run that ended on a
      // narrow tool scope and a process that starts on the full set can share
      // a prefix hash, so the hash alone says nothing changed while the
      // projection — which reads the profile — sees four tools become
      // twenty-eight and rejects the log for the rest of the session.
      const profileChanges = toolScope !== undefined && toolProfileProjectionChanges(
        ctx.log.events,
        recordedTools,
        toolSchemaHash(schemas),
      );
      ctx.sealIfNeeded("tools_changed", profileChanges);
      assertFrozenPrefix(ctx);
      if (toolScope) {
        appendToolProfileEvent({
          log: ctx.log,
          scope: toolScope,
          tools: recordedTools,
          toolSchemaHash: toolSchemaHash(schemas),
        });
      }

      const key = agentReuseKey({
        sessionId: ctx.sessionId,
        route: route.name,
        modelId: model.id,
        systemPrompt: ctx.systemPrompt,
        toolSchemas: ctx.toolSchemas,
      });
      const agent = live?.key === key
        ? live.agent
        : createLiveAgent(
            ctx,
            route,
            model,
            tools,
            sink,
            toolBudget,
            generationLimits,
            sessionBudget,
            repeatedReads,
            toolLoop,
            probeChurn,
            guardChurn,
            activeSpeculation,
            profileScope,
            requestContext,
          );
      if (live?.key !== key) {
        live = { key, agent, route: route.name, model: model.id };
      }

      applyPromptThinkingPolicy(agent.state, ctx.log, {
        requestedLevel: options?.thinkingLevel,
        phase: process.env.DOKKABI_WORK_PHASE,
        route: route.name,
        model,
      });
      toolBudget.limit = options?.maxToolCalls;
      toolBudget.used = attempt.completionToolsUsed ?? 0;
      toolBudget.warned = false;
      toolBudget.finalizers = resolveFinalizers(
        options?.toolBudgetFinalizers,
        tools.map((tool) => tool.name),
        options?.maxToolCalls !== 0,
      );
      toolBudget.finalizerCalls = resolveFinalizerCalls(
        options?.toolBudgetFinalizerCalls,
        tools.map((tool) => tool.name),
      );
      toolBudget.finalizerRemoteWorkspaces = readFinalizerRemoteWorkspaces(ctx.workspaceRoot);
      toolBudget.finalizerRemoteWorkspacesLive = true;
      generationLimits.maxOutputTokens = options?.maxOutputTokens;
      generationLimits.providerRole = options?.providerRole;
      generationLimits.thinkingBudgets = options?.thinkingBudgets;
      generationLimits.timeoutMs = options?.timeoutMs;
      generationLimits.timeoutPolicy = options?.timeoutPolicy;
      generationLimits.deadlineExpired = false;
      generationLimits.activeToolCalls = 0;
      // The watchdog is the loop's default for EVERY turn — acceptance,
      // ralph-plan, step, and operator-reply turns included — not something
      // each call site remembers to opt into. An explicit option wins; `0`
      // switches it off for that turn.
      const streamBudget = resolveStreamIdleBudget();
      generationLimits.streamIdleMs = options?.streamIdleMs ?? streamBudget.streamIdleMs;
      generationLimits.streamFirstDeltaMs = options?.streamFirstDeltaMs ?? streamBudget.streamFirstDeltaMs;
      generationLimits.streaming = false;
      generationLimits.firstDeltaSeen = false;
      generationLimits.lastStreamActivityAt = undefined;
      generationLimits.streamChars = 0;
      generationLimits.stalled = false;
      generationLimits.temperature = resolveSamplingTemperature();
      sink.onAssistant = options?.onAssistant;
      let failed: unknown | undefined;
      let timedOut = false;
      let completionToolsUsed = toolBudget.used;
      let stalled: StreamStallError | undefined;
      let stallAbandoned = false;
      let stallGrace: ReturnType<typeof setTimeout> | undefined;
      let abandonStall: (() => void) | undefined;
      const stallAbandonment = new Promise<void>((resolve) => {
        abandonStall = resolve;
      });
      // Delta-based watchdog: a request in flight with no tool executing and
      // no assistant delta for the phase budget (first-delta, then idle) is
      // a dead connection, not a slow model. Recorded before the abort,
      // classified as a transport failure so the retry ladder and failover
      // see it like any other dropped link. abort() may not reach a request
      // hanging on a transport that ignores its signal, so the run below is
      // RACED against a grace: past it the turn is abandoned and said so.
      const watchdog = generationLimits.streamIdleMs === undefined || generationLimits.streamIdleMs <= 0
        ? undefined
        : setInterval(() => {
            if (stalled !== undefined) return;
            const idle = streamIdleFor(generationLimits, Date.now());
            if (idle === undefined) return;
            const chars = generationLimits.streamChars ?? 0;
            stalled = new StreamStallError(idle, chars);
            generationLimits.stalled = true;
            ctx.log.append({
              kind: "observe",
              name: "model/stall",
              payload: {
                idle_ms: idle,
                limit_ms: generationLimits.firstDeltaSeen === true
                  ? generationLimits.streamIdleMs
                  : Math.max(generationLimits.streamFirstDeltaMs ?? 0, generationLimits.streamIdleMs ?? 0),
                first_delta_seen: generationLimits.firstDeltaSeen === true,
                chars,
                decision: "abort",
              },
            });
            generationLimits.streaming = false;
            // The stall owns this turn's outcome: the deadline must not
            // relabel it, and its timer is pointless once we are aborting.
            if (timeout !== undefined) clearTimeout(timeout);
            const graceMs = options?.stallGraceMs ?? ABORT_GRACE_MS;
            stallGrace = setTimeout(() => {
              stallAbandoned = true;
              ctx.log.append({
                kind: "observe",
                name: "model/stall",
                payload: { decision: "abandoned", grace_ms: graceMs, chars },
              });
              abandonStall?.();
            }, graceMs);
            agent.abort();
          }, Math.max(250, Math.min(5_000, Math.trunc(generationLimits.streamIdleMs / 4))));
      const timeout = generationLimits.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            generationLimits.deadlineExpired = true;
            const decision = generationLimits.activeToolCalls > 0 ? "defer" : "abort";
            ctx.log.append({
              kind: "observe",
              name: "model/turn_budget",
              payload: {
                timeout_ms: generationLimits.timeoutMs,
                decision,
                policy: generationLimits.timeoutPolicy ?? "fail",
                ...(generationLimits.activeToolCalls > 0
                  ? { active_tools: generationLimits.activeToolCalls }
                  : {}),
              },
            });
            // A tool is an effect that may have already changed the outside
            // world. Cutting it off at an arbitrary generation deadline can
            // leave a deployment, poll, or write half-finished. Let the
            // active batch settle, then shouldStopAfterTurn yields to host
            // verification before another model request begins.
            if (decision === "abort") {
              agent.abort();
            }
          }, generationLimits.timeoutMs);
      requestContext.profile = toolScope?.profile ?? "default";
      try {
        // Close the cancelled historical turn BEFORE Pi appends a new
        // operator message. A trailing notice would ambiguously cancel the
        // new task too. Both live and cold agents mirror the durable append.
        const cancelled = contributeCancelledTurn(ctx.log, {
          kind: attempt.resume ? "continue" : "prompt",
          request: ctx.log.events.reduce((count, event) => count + (event.name === "provider/request" ? 1 : 0), 1),
        });
        if (cancelled) {
          agent.state.messages = [...agent.state.messages, cancelled as AgentMessage];
          persistAgent(ctx, route.name, model.id, agent);
        }
        // #227 CG-04: the same request-context registry runs at this
        // boundary (the episode's first request, a resume, or a same-route
        // retry) as after every tool batch. A recorded frame joins the
        // durable transcript before the request is built from it.
        const boundary: RequestContextBoundary = !attempt.resume ? "initial" : attempt.episodeReentry === true ? "retry" : "resume";
        const framed = applyRequestContext(ctx.log, ctx.tryGet<RequestContextContributionRegistry>("request_context_contributions"), {
          boundary,
          messages: agent.state.messages,
          profile: requestContext.profile,
          // §133 R2: recovery is what THIS request's tools can do.
          readerAuthorised: resultSourceReaderAuthorised(agent.state.tools, ctx.log),
          ...requestUsage(ctx),
        });
        if (framed) agent.state.messages = framed as AgentMessage[];
        // The run is raced against stall abandonment: Agent.prompt() awaits
        // the whole run, so a request whose transport ignores abort() would
        // otherwise hold this await with no end — the ~1300-second shape.
        const run = attempt.resume ? agent.continue() : agent.prompt(text);
        await Promise.race([run, stallAbandonment]);
        // Once the deadline has expired the wait for idle is itself bounded.
        // abort() may not reach a request already hanging on a silent
        // connection, and then this wait had no end — sixty-three minutes
        // against a five-minute budget, once (host/turn-grace.ts).
        const settle = stallAbandoned
          ? { outcome: "abandoned" as const, graceMs: options?.stallGraceMs ?? ABORT_GRACE_MS }
          : await waitForIdleWithin({
              waitForIdle: () => agent.waitForIdle(),
              deadlineExpired: () => generationLimits.deadlineExpired === true,
              decision: () => (generationLimits.activeToolCalls > 0 ? "defer" : "abort"),
            });
        // A stall abandonment already recorded its own model/stall row; it
        // must not masquerade as a deadline outcome.
        if (settle.outcome === "abandoned" && !stallAbandoned) {
          ctx.log.append({
            kind: "observe",
            name: "model/turn_budget",
            payload: {
              timeout_ms: generationLimits.timeoutMs,
              decision: "abandoned",
              grace_ms: settle.graceMs,
              policy: generationLimits.timeoutPolicy ?? "fail",
            },
          });
        }
        const lastMessage = agent.state.messages.at(-1);
        if (operatorAbort) {
          failed = new OperatorAbortError();
        } else if (stalled !== undefined) {
          failed = stalled;
        } else if (settle.outcome === "abandoned") {
          // A local scheduling decision, like the deadline that preceded it —
          // never a provider failure, so it must not drive failover.
          failed = new TurnAbandonedError(settle.graceMs ?? 0);
        } else if (toolLoop.terminated) {
          failed = new ToolLoopError(toolLoop.terminated.tool, toolLoop.terminated.count);
        } else if (
          lastMessage?.role === "assistant"
          && (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted")
        ) {
          failed = new Error(lastMessage.errorMessage ?? `model stop=${lastMessage.stopReason}`);
        } else if (lastMessage?.role === "assistant" && isEmptyCompletion(lastMessage as AssistantMessage)) {
          const empty = new EmptyCompletionError();
          failed = empty;
          // Keep the persisted Pi transcript honest and make the existing
          // handoff helper drop this failed fragment before retry/failover.
          lastMessage.stopReason = "error";
          lastMessage.errorMessage = "empty_completion";
          // The durable transcript took a snapshot at message_end, before
          // this marking: without the same rewrite here the retry boundary
          // below refuses to admit the next request against a history that
          // still calls the failed turn a success.
          replaceProviderMessages(ctx.log, agent.state.messages, "model/retry", { reason_code: "empty_completion" });
        }
      } catch (error) {
        if (operatorAbort) {
          failed = new OperatorAbortError();
        } else if (stalled !== undefined) {
          failed = stalled;
        } else if (!timedOut) {
          failed = toolLoop.terminated
            ? new ToolLoopError(toolLoop.terminated.tool, toolLoop.terminated.count)
            : error;
        }
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (watchdog !== undefined) {
          clearInterval(watchdog);
        }
        if (stallGrace !== undefined) {
          clearTimeout(stallGrace);
        }
        generationLimits.streamIdleMs = undefined;
        generationLimits.streamFirstDeltaMs = undefined;
        generationLimits.streaming = false;
        generationLimits.firstDeltaSeen = false;
        generationLimits.lastStreamActivityAt = undefined;
        generationLimits.streamChars = 0;
        generationLimits.stalled = false;
        // A stall that overlapped the deadline stays a stall: the transport
        // failure it carries is what retries and failover key on.
        if (timedOut && stalled === undefined) {
          failed = generationLimits.timeoutPolicy === "continue"
            ? undefined
            : new Error(`model turn budget exhausted after ${options?.timeoutMs ?? 0}ms`);
        }
        completionToolsUsed = toolBudget.used;
        toolBudget.limit = undefined;
        toolBudget.used = 0;
        toolBudget.warned = false;
        toolBudget.finalizers = undefined;
        toolBudget.finalizerCalls = undefined;
        toolBudget.finalizerRemoteWorkspaces = undefined;
        toolBudget.finalizerRemoteWorkspacesLive = undefined;
        generationLimits.maxOutputTokens = undefined;
        generationLimits.providerRole = undefined;
        generationLimits.thinkingBudgets = undefined;
        generationLimits.timeoutMs = undefined;
        generationLimits.timeoutPolicy = undefined;
        generationLimits.deadlineExpired = false;
        generationLimits.activeToolCalls = 0;
        // No sessionBudget reset here: this finally runs BEFORE the retry /
        // failover recursion below, and those legs must find the episode
        // still armed. The next outermost prompt()/resume() re-arms every
        // field at entry, which is what keeps episodes isolated.
        sink.onAssistant = undefined;
        try { persistAgent(ctx, route.name, model.id, agent); }
        catch (error) { failed ??= error; }
        const normalized = failed === undefined
          ? undefined
          : failed instanceof ToolLoopError
            ? { class: "policy_failure" as const, reasonCode: "tool_loop" }
            : normalizeModelFailureV1({ error: failed });
        ctx.log.append({
          kind: "observe",
          name: "agent/status",
          payload: {
            status: failed instanceof OperatorAbortError ? "cancelled" : failed ? "failed" : "idle",
            route: route.name,
            ...(failed instanceof OperatorAbortError
              ? { error: "operator_abort" }
              : normalized
                ? { error: normalized.reasonCode, failure_class: normalized.class }
                : {}),
          },
        });
      }
      if (failed !== undefined) {
        const failure = failed instanceof Error ? failed : new Error(String(failed));
        // The host created this bounded, public error after recording
        // model/turn_budget. It is a local scheduling decision rather than a
        // provider failure, so it must never enter cross-model failover or be
        // replaced by a generic normalized provider error.
        if (timedOut || failure instanceof ToolLoopError || failure instanceof OperatorAbortError) throw failure;
        // #227 G5: a frame that could not be recorded ends the turn with that
        // bounded failure — it is not a provider failure, so it never enters
        // the retry ladder or failover (Pi turns an error thrown in its
        // next-turn hook into an error message; the prefix names it).
        if (failure.message.startsWith("turn-context:")) throw failure;
        if (failure instanceof ContextFrameError) throw failure;
        if (failure.message.startsWith("context-frame:")) throw new ContextFrameError(failure.message.slice("context-frame:".length).trim());
        return handleBoundaryFailure({
          route,
          modelId: model.id,
          error: failure,
          messages: agent.state.messages,
          text,
          options,
          attempt: {...attempt,...(attempt.completionRounds===undefined?{}:{completionToolsUsed})},
          allowSameRouteRetry: !timedOut,
        });
      }
      if (generationLimits.recoveryError) throw generationLimits.recoveryError;
      const settledRecovery = generationLimits.recovery;
      if (settledRecovery?.grant && settledRecovery.toolsPending && prepareFailoverHandoff(agent.state.messages, { continuity: "continue" }).resumable) {
        assertProviderMessages(ctx.log, agent.state.messages);
        settledRecovery.service.result(settledRecovery.token, settledRecovery.grant, settledRecovery.usage);
        settledRecovery.grant = undefined;
        settledRecovery.toolsPending = false;
      }
      // Plugin-owned completion requirements, never task wording or repository
      // branches in the loop. Frames cross the same durable input boundary.
      if (!timedOut && sessionBudget.exhaustion === undefined) {
        const framed = applyRequestContext(ctx.log, ctx.tryGet<RequestContextContributionRegistry>("request_context_contributions"), {
          boundary: "completion", messages: agent.state.messages,
          profile: requestContext.profile,
          readerAuthorised: resultSourceReaderAuthorised(agent.state.tools, ctx.log),
          ...requestUsage(ctx),
        });
        if (framed) {
          const round = (attempt.completionRounds ?? 0) + 1;
          if (round > 8) {
            ctx.log.append({kind:"observe",name:"loop/completion_incomplete",payload:{round,reason:"checkpoint_cap"}});
            throw new Error("Plugin completion checkpoint exhausted; task remains incomplete");
          }
          agent.state.messages = framed as AgentMessage[];
          persistAgent(ctx, route.name, model.id, agent);
          ctx.log.append({kind:"observe",name:"loop/completion_continue",payload:{round}});
          return facade.prompt("", {...options,__attempt:{...attempt,accepted:true,resume:true,episodeReentry:true,completionRounds:round,completionToolsUsed}} as PromptOptions);
        }
      }
    },
    handoff(target): ManualHandoffResult<AgentMessage> {
      const llm = ctx.llm;
      if (!llm) throw new Error("ctx.llm is not registered");
      const sourceRoute = llm.active();
      const sourceModel = llm.activeModelId ?? sourceRoute.defaultModelId() ?? "missing";
      const source = { route: sourceRoute.name, model: sourceModel };
      const destination = { route: target.route, model: target.model };
      const restored = live?.route === source.route && live.model === source.model
        ? live.agent.state.messages
        : loadAgentTranscript(agentTranscriptPath(ctx.log.path), {
            prefix_hash: frozenPrefixHash({
              systemPrompt: ctx.systemPrompt,
              toolSchemas: ctx.toolSchemas,
            }),
            model_id: source.model,
            route: source.route,
          }) as AgentMessage[] | undefined;
      const retained = liveProviderState(ctx.log);
      requireProviderInput(!restored?.length || retained.ref, "handoff source has no durable history");
      if (retained.ref && restored) assertProviderMessages(ctx.log, restored);
      const messages = (retained.ref ? retained.messages : restored ?? []) as AgentMessage[];
      const rawTokens = estimateMessagesTokensPublic(messages);
      const prefixTokens = Math.ceil(ctx.systemPrompt.length / CHARS_PER_TOKEN)
        + Math.ceil(JSON.stringify(ctx.toolSchemas).length / CHARS_PER_TOKEN);
      const calibrationMessages = messages.at(-1)?.role === "assistant"
        ? messages.slice(0, -1)
        : messages;
      const calibrationTokens = prefixTokens + estimateMessagesTokensPublic(calibrationMessages);
      const observedUsage = lastUsage(ctx);
      const observedTokens = typeof observedUsage?.context_used === "number"
        ? observedUsage.context_used
        : 0;
      const tokenScale = calibrationTokens > 0 && observedTokens > 0
        ? Math.max(1, observedTokens / calibrationTokens)
        : 1;
      const prepared = agentBusy(ctx)
        ? {
            ok: false as const,
            reason: "agent_busy" as const,
            beforeMessages: messages.length,
            afterMessages: 0,
            beforeTokens: Math.ceil((prefixTokens + rawTokens) * tokenScale),
            afterTokens: 0,
            droppedMessages: 0,
            truncated: false,
            tokenScale,
            prefixTokens,
          }
        : prepareManualHandoff(messages, {
            contextWindow: target.contextWindow,
            tokenScale,
            prefixTokens,
            ...(target.mode === "slim" ? { budgetShare: MANUAL_HANDOFF_SLIM_SHARE } : {}),
            summaryText: compactionCheckpointText(buildCompactionCheckpoint(ctx.log.events)),
          });
      // A large bare carry is the incident shape (370k onto an advertised-1M
      // stealth model, then live 400s): the operator must name carry or slim.
      const result = prepared.ok && target.mode === undefined && manualHandoffCaution(prepared.afterTokens)
        ? {
            ok: false as const,
            reason: "carry_confirmation_required" as const,
            beforeMessages: prepared.beforeMessages,
            afterMessages: prepared.afterMessages,
            beforeTokens: prepared.beforeTokens,
            afterTokens: prepared.afterTokens,
            droppedMessages: prepared.droppedMessages,
            truncated: prepared.truncated,
            tokenScale: prepared.tokenScale,
            prefixTokens: prepared.prefixTokens,
          }
        : prepared;
      const fact = {
        cause: "manual",
        from: source,
        to: destination,
        truncated: result.truncated,
        before_messages: result.beforeMessages,
        after_messages: result.afterMessages,
        before_tokens: result.beforeTokens,
        after_tokens: result.afterTokens,
        dropped_messages: result.droppedMessages,
        token_scale: Number(result.tokenScale.toFixed(3)),
        prefix_tokens: result.prefixTokens,
        target_context_window: target.contextWindow,
        target_budget_tokens: Math.floor(target.contextWindow * (target.mode === "slim" ? MANUAL_HANDOFF_SLIM_SHARE : 0.75)),
        transcript_digest: modelEventDigest({
          source,
          destination,
          messages: result.ok ? result.messages : [],
          reason: result.ok ? "ready" : result.reason,
        }),
        ...(result.ok && result.beforeMessages === 0 ? { warning: "empty_source_transcript" } : {}),
      };
      const handoffDigest = modelEventDigest(fact);
      // The intended handoff is durable before transcript persistence. A
      // failed write gets an explicit terminal observation and cannot mutate
      // the live agent or active route.
      ctx.log.append({
        kind: "effect",
        name: "model/handoff",
        payload: { ...fact, handoff_digest: handoffDigest },
      });
      if (!result.ok) {
        ctx.log.append({
          kind: "observe",
          name: "model/handoff_failed",
          payload: { handoff_digest: handoffDigest, reason_code: result.reason },
        });
        return result;
      }

      let persisted = result.messages.length === 0;
      const handoffSource = liveProviderState(ctx.log);
      try {
        if (result.messages.length > 0) {
          replaceProviderMessages(ctx.log, result.messages, "model/handoff", { handoff_digest: handoffDigest,
            metadata: transcriptMetadata(ctx, target.route, target.model) });
          persisted = saveMessagesForRoute(ctx, target.route, target.model, result.messages);
        }
      } catch {
        persisted = false;
      }
      if (!persisted) {
        if (handoffSource.ref && liveProviderState(ctx.log).ref?.seq !== handoffSource.ref.seq) {
          replaceProviderMessages(ctx.log, handoffSource.messages, "model/handoff_rollback", {
            handoff_digest: handoffDigest, source_state: handoffSource.ref,
            metadata: handoffSource.metadata ?? transcriptMetadata(ctx, source.route, source.model),
          });
        }
        const failure = {
          ok: false as const,
          reason: "transcript_not_persisted" as const,
          beforeMessages: result.beforeMessages,
          afterMessages: result.afterMessages,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          droppedMessages: result.droppedMessages,
          truncated: result.truncated,
          tokenScale: result.tokenScale,
          prefixTokens: result.prefixTokens,
        };
        ctx.log.append({
          kind: "observe",
          name: "model/handoff_failed",
          payload: { handoff_digest: handoffDigest, reason_code: failure.reason },
        });
        return failure;
      }

      live = undefined;
      sourceRoute.resetSession?.(ctx.sessionId);
      return result;
    },
    /**
     * Background soft-threshold compaction. Runs from the sweeper timer
     * while the agent is idle; also safe to call directly. Invalidating the
     * in-memory agent matters: reuse would otherwise resurrect the pre-
     * compaction messages and persistAgent would write them back.
     */
    abort() {
      operatorAbort = true;
      recoveryAbort.abort();
      live?.agent.abort();
    },
    sweep(): { swept: boolean; reason?: string } {
      if (!shouldCompact(ctx.log.events, COMPACTION_SOFT_THRESHOLD)) {
        const pressure = compactionPressure(ctx.log.events);
        return { swept: false, reason: pressure?.relieved ? "relieved_awaiting_usage" : "under_soft_threshold" };
      }
      if (agentBusy(ctx)) {
        return { swept: false, reason: "agent_busy" };
      }
      const done = compactNow(ctx, COMPACTION_SOFT_THRESHOLD);
      if (done) {
        live = undefined;
        ctx.llm?.active().resetSession?.(ctx.sessionId);
      }
      return done ? { swept: true } : { swept: false, reason: "nothing_to_drop" };
    },
    invalidateSurface() {
      live = undefined;
      speculation?.invalidate();
      speculationRevision = undefined;
      cleanupSessionResources(ctx.sessionId);
    },
    dispose() {
      disposed = true;
      operatorAbort = true;
      const holder = TOOL_CALL_PIPELINES.get(ctx.log);
      if (holder) delete holder.current;
      live?.agent.abort();
      sink.onAssistant = undefined;
      live = undefined;
      speculation?.invalidate();
      speculation = undefined;
      cleanupSessionResources(ctx.sessionId);
    },
  };
  const resources = ctx.log.isReadOnly ? undefined : ctx.tryGet<OwnedWorkResourceRegistry>("owned_work_resources");
  let transferred = false;
  if (resources) ctx.effect(() => resources.register("loop-pi", {
    async suspend() {
      if (live?.agent.state.isStreaming) throw new Error("Owned loop transfer requires an idle agent");
      transferred = true;
      facade.invalidateSurface();
      ctx.llm?.active().resetSession?.(ctx.sessionId);
    },
    async resume() {
      if (!transferred || disposed) return;
      const route = ctx.llm?.activeName;
      const model = ctx.llm?.activeModelId ?? ctx.llm?.active().defaultModelId();
      if (!route || !model) throw new Error("Owned loop return requires a selected model");
      restoreOwnedAgentTranscript(ctx.log, transcriptMetadata(ctx, route, model));
      transferred = false;
    },
  }));
  ctx.provide("loop", facade);
  ctx.effect(() => () => facade.dispose());
  return facade;
}

function messagesAtUnstartedBoundary(
  ctx: HostContext,
  route: string,
  modelId: string,
  text: string,
  resume: boolean,
): AgentMessage[] {
  const restored = loadAgentTranscript(agentTranscriptPath(ctx.log.path), {
    prefix_hash: frozenPrefixHash({
      systemPrompt: ctx.systemPrompt,
      toolSchemas: ctx.toolSchemas,
    }),
    model_id: modelId,
    route,
  }) as AgentMessage[] | undefined;
  let retained = liveProviderState(ctx.log);
  requireProviderInput(!restored?.length || (retained.ref && inputDigest(restored) === inputDigest(retained.messages)),
    "unstarted boundary contains private cache-only history");
  if (!retained.ref) {
    replaceProviderMessages(ctx.log, [], "start");
    retained = liveProviderState(ctx.log);
  }
  const prior = prepareFailoverMessages(retained.messages as AgentMessage[]).messages;
  if (inputDigest(prior) !== inputDigest(retained.messages)) replaceProviderMessages(ctx.log, prior, "model/retry");
  if (resume) return prior;
  const accepted = [...ctx.log.events].reverse().find((event) => event.name === "user/message");
  const timestamp = accepted ? Date.parse(accepted.ts) : Date.now();
  const user = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  } as AgentMessage;
  appendProviderMessage(ctx.log, user);
  return [...prior, user];
}

function currentTurnId(ctx: HostContext): string {
  const event = [...ctx.log.events].reverse().find((candidate) => candidate.name === "user/message");
  return String(event?.seq ?? 0);
}

/** Build checkpoint continuity solely from durable host facts. It contains no
 * provider free-form output, thinking, failed tool fragment, endpoint, header,
 * or credential. Tool evidence is referenced by safe digests so a completed
 * mutation is known without placing a tool call back into runnable context. */
function failoverCheckpointMessage(ctx: HostContext): AgentMessage {
  const events = ctx.log.events;
  const operator = [...events].reverse().find(
    (event) => event.name === "user/message" && typeof event.payload.text === "string",
  );
  const completedTools = events
    .filter((event) => event.name === "tool/end")
    .slice(-16)
    .map((event) => ({
      name: typeof event.payload.name === "string" ? event.payload.name : "unknown",
      error: event.payload.error === true,
      evidence_digest: modelEventDigest({
        seq: event.seq,
        name: event.payload.name,
        error: event.payload.error === true,
        result_bytes: typeof event.payload.result_bytes === "number" ? event.payload.result_bytes : "missing",
      }),
    }));
  const graphRev = events.reduce(
    (current, event) => event.name === "graph/apply" && typeof event.payload.next === "number"
      ? Math.max(current, event.payload.next)
      : current,
    0,
  );
  const checkpoint = buildCompactionCheckpoint(events);
  const envelope = {
    kind: "dokkabi.failover_checkpoint",
    version: 1,
    operator_order: typeof operator?.payload.text === "string"
      ? operator.payload.text
      : "Continue the current operator goal.",
    work: checkpoint,
    graph_rev: graphRev,
    completed_tools: completedTools,
  };
  return {
    role: "user",
    content: [{
      type: "text",
      text: `[dokkabi failover checkpoint; host-derived non-authoritative state] ${canonicalJson(envelope)}`,
    }],
    timestamp: operator ? Date.parse(operator.ts) : Date.now(),
  } as AgentMessage;
}

/** #227: the request-context state the live agent's hooks read. */
interface RequestContextState {
  profile: string;
}

/** The last recorded usage as the request-context budget input — none when
 * a compaction dropped messages after it (that measurement no longer
 * describes the transcript; the next reply measures again). */
function requestUsage(ctx: HostContext): { contextWindow?: number; contextUsed?: number } {
  let usage: ReturnType<typeof lastUsage>;
  for (let i = ctx.log.events.length - 1; i >= 0; i -= 1) {
    const event = ctx.log.events[i]!;
    if (event.name === "compaction/drop" && event.payload.in_turn !== true) return {};
    if (event.observe?.model_usage) { usage = event.observe.model_usage; break; }
  }
  return {
    ...(typeof usage?.context_window === "number" ? { contextWindow: usage.context_window } : {}),
    ...(typeof usage?.context_used === "number" ? { contextUsed: usage.context_used } : {}),
  };
}

export function agentReuseKey(input: {
  sessionId: string;
  route: string;
  modelId: string;
  systemPrompt: string;
  toolSchemas: unknown;
}): string {
  return `${input.sessionId}\0${input.route}\0${input.modelId}\0${frozenPrefixHash({
    systemPrompt: input.systemPrompt,
    toolSchemas: input.toolSchemas,
  })}`;
}

async function maybeRecordQuota(ctx: HostContext, route: LlmRoute, modelId: string): Promise<void> {
  if (!route.hasNetwork) return;
  await ctx.tryGet<ModelResilienceService>("model_resilience")?.refresh({
    route: route.name,
    provider: route.providerId,
    model: modelId,
  });
}

function modelSelectionName(selection: ModelRouteSelection): string {
  return `${selection.route}/${selection.model}`;
}

function modelEventDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function resumableSuffix(messages: readonly AgentMessage[]): boolean {
  const role = messages[messages.length - 1]?.role;
  return role === "user" || role === "toolResult";
}

/**
 * How much of a retry's backoff is actually slept.
 *
 * The ladder is real seconds against a real provider, and a test that drives
 * a retry has to sit through them. One did: a transport case waited a 5s rung
 * inside a 30s test timeout, passed alone, and timed out under the contention
 * of a full 638-file run — a flake that says nothing about the code. The
 * ladder's VALUES are asserted on the recorded `model/retry` rows and on
 * `providerRetryDelayMs`, neither of which sleeps, so nothing is lost by not
 * living through them.
 *
 * `tests/preload.ts` sets this to 0 for the whole suite. Unset, it is 1.
 */
function retryBackoffMs(delayMs: number): number {
  const scale = Number(process.env.DOKKABI_RETRY_BACKOFF_SCALE ?? "1");
  if (!Number.isFinite(scale) || scale < 0) return delayMs;
  return Math.round(delayMs * scale);
}

/**
 * The same-route ladder: ONE policy for every provider fault a wait can fix
 * (PROVIDER_RETRY_POLICY_V1), plus the truncated-reply re-ask, which is not a
 * wait at all.
 *
 * There used to be three ladders here — six rungs for a rate limit, two for a
 * dropped link, one for an empty completion — each length argued from the same
 * premise: exhausting it hands the turn to failover, and failover is what
 * keeps the run alive. Research runs turn failover OFF, and then the short
 * ladders ARE the resilience: one empty completion at request 45 ended a live
 * session, and so did two provider timeouts followed by a 429. The policy is
 * now uniform and bounded, and exhausting it still hands over to failover
 * wherever failover is configured.
 *
 * The cost this accepts, knowingly: a stalled stream is no longer the special
 * case that got a single fast retry. Each stall attempt first spends its
 * watchdog budget (DEFAULT_STREAM_IDLE_MS, 90s), so a route that stalls every
 * time now holds the turn for that budget times the attempts the ladder allows
 * before the work loop can replan. That is the price of surviving a route that
 * stalls once, which is the case the research runs actually hit.
 */
export function sameRouteRetry(
  state: ModelAttemptState,
  failure: ReturnType<typeof classifyModelFailure>,
  /** The normalized reason, when the caller has it. Recorded by the caller;
   * it no longer selects a ladder — a stalled stream, a dropped link and a
   * provider timeout are the same fault to the policy. */
  reasonCode?: string,
  /** What the provider stated and what the episode has left. Both bound the
   * wait: a stated Retry-After stretches it, a deadline forbids outliving it. */
  options: ProviderRetryOptionsV1 = {},
): {
  attempt: number;
  delayMs: number;
  providerRetries: number;
  transportFailures: number;
  retryAfterMs?: number;
} | undefined {
  void reasonCode;
  // A truncated reply is retried at once, twice, with a bigger budget each
  // time. There is nothing to wait for — the provider is healthy and answered
  // promptly; it was simply asked for more than it was allowed to say.
  if (failure === "output_truncated") {
    const truncatedFailures = state.transportFailures;
    if (TRUNCATED_RETRY_BUDGET_SCALE[truncatedFailures] === undefined) return undefined;
    return {
      attempt: truncatedFailures + 1,
      delayMs: 0,
      providerRetries: state.providerRetries ?? 0,
      transportFailures: truncatedFailures + 1,
    };
  }
  const spent = state.providerRetries ?? 0;
  const next = nextProviderRetry(spent, failure, options);
  if (next === undefined) return undefined;
  return { ...next, providerRetries: spent + 1, transportFailures: state.transportFailures };
}

function compactIfNeeded(ctx: HostContext): boolean {
  if (!shouldCompact(ctx.log.events, COMPACTION_THRESHOLD)) {
    return false;
  }
  return compactNow(ctx, COMPACTION_THRESHOLD);
}

/** Shared compaction body for the hard pre-model check and the soft sweep. */
function compactNow(ctx: HostContext, threshold: number): boolean {
  const usage = lastUsage(ctx);
  const window = typeof usage?.context_window === "number" ? usage.context_window : 0;
  const used = typeof usage?.context_used === "number" ? usage.context_used : 0;
  if (window <= 0 || used <= 0) {
    return false;
  }
  // Exhaustion gate: a zero-drop compaction blocks retries only while usage
  // stays at or below the pressure it recorded. The legacy blanket guard
  // deadlocked after any drop-0 (the live-session bug).
  if (compactionExhausted(ctx.log.events, used)) {
    return false;
  }
  const transcriptPath = agentTranscriptPath(ctx.log.path);
  synchronizeAgentTranscript(ctx.log, transcriptPath);
  const transcript = readTranscript(transcriptPath);
  // Calibrate the per-message estimate against the measured pressure: the
  // provider's history number versus what the local transcript estimates.
  const estimated = transcriptTokens(transcriptPath);
  const calibration = estimated > 0 ? { measured: used, estimated } : undefined;
  const messageTokens = perMessageTokens(transcript, calibration);
  const checkpoint = buildCompactionCheckpoint(ctx.log.events);
  const total = Math.max(used, transcriptTokens(transcriptPath));
  const budget = compactionLandingBudget(window, threshold);
  const result = applyCompactionToTranscript({
    transcriptPath,
    log: ctx.log,
    summary: compactionCheckpointText(checkpoint),
    keepMessages: 6,
    keepTurns: 3,
    transcriptTokens: total,
    tokenBudget: budget,
    ...(messageTokens ? { messageTokens } : {}),
    ...(transcript?.messages ? { roles: transcript.messages.map((message) => message.role ?? "") } : {}),
    checkpoint: checkpoint as unknown as Record<string, unknown>,
    nothingLeftPressure: used,
  });
  if (result.droppedMessages > 0) {
    ctx.sealIfNeeded("compaction");
    finishCompactionTransaction(transcriptPath);
    return true;
  }
  return false;
}

/** The sweep must not touch the transcript while a model request is in flight. */
function agentBusy(ctx: HostContext): boolean {
  for (let i = ctx.log.events.length - 1; i >= 0; i -= 1) {
    const event = ctx.log.events[i];
    if (event?.name === "agent/status" && typeof event.payload.status === "string") {
      return event.payload.status === "running" || event.payload.status === "waiting_tool" || event.payload.status === "compacting";
    }
  }
  return false;
}

function lastUsage(ctx: HostContext): { context_window?: number | "missing"; context_used?: number | "missing" } | undefined {
  for (let i = ctx.log.events.length - 1; i >= 0; i -= 1) {
    const usage = ctx.log.events[i]?.observe?.model_usage;
    if (usage) {
      return usage;
    }
  }
  return undefined;
}

function readTranscript(path: string): { messages?: Array<{ role?: string; content?: Array<{ text?: string }> }> } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function perMessageTokens(
  transcript: { messages?: Array<{ content?: unknown }> } | undefined,
  calibration?: { measured: number; estimated: number },
): number[] | undefined {
  if (!transcript?.messages) {
    return undefined;
  }
  // Full-content measurement: toolCall argument JSON and thinking blocks
  // are part of what the provider charges for (messageTokens contract), and
  // the estimate is scaled to what the provider actually billed so CJK
  // sessions do not size their drops from a number half the truth.
  return transcript.messages.map((message) => scaledMessageTokens(message, calibration));
}

function persistAgent(ctx: HostContext, route: string, modelId: string, agent: Agent): void {
  if (agent.state.messages.length && !saveMessagesForRoute(ctx, route, modelId, agent.state.messages)) {
    throw new Error("Transcript cache persistence refused; task remains incomplete");
  }
}

function saveMessagesForRoute(
  ctx: HostContext,
  route: string,
  modelId: string,
  messages: readonly AgentMessage[],
): boolean {
  if (liveProviderState(ctx.log).ref) assertProviderMessages(ctx.log, messages);
  return saveAgentTranscript(agentTranscriptPath(ctx.log.path), { ...transcriptMetadata(ctx, route, modelId), messages: [...messages] }, ctx.log);
}

function transcriptMetadata(ctx: HostContext, route: string, modelId: string) {
  const pluginManifestDigest = currentPluginManifestDigest(ctx.log.events);
  return {
    prefix_hash: frozenPrefixHash({
      systemPrompt: ctx.systemPrompt,
      toolSchemas: ctx.toolSchemas,
    }),
    system_prompt_hash: systemPromptHash(ctx.systemPrompt),
    tool_schema_hash: toolSchemaHash(ctx.toolSchemas),
    ...(pluginManifestDigest
      ? { plugin_manifest_digest: pluginManifestDigest }
      : {}),
    model_id: modelId,
    route,
  };
}

function currentPluginManifestDigest(events: readonly EventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const digest = events[index]?.name === "session/open"
      ? events[index]?.payload.plugin_manifest_digest
      : undefined;
    if (typeof digest === "string" && digest.length > 0) return digest;
  }
  return undefined;
}

interface CommittedContextRelief {
  messages: AgentMessage[];
  name: "context/slim" | "context/prune";
  payload: Record<string, unknown>;
}

/**
 * Pair-safe context relief for a completed Pi turn.
 *
 * The caller owns the commit point. Keeping this calculation pure makes it
 * impossible for a provider error path to partially mutate the transcript.
 */
export function committedContextRelief(
  messages: readonly AgentMessage[],
  usage: { context_window?: number | "missing"; context_used?: number | "missing" } | undefined,
  opts: { readerAuthorised?: boolean } = {},
): CommittedContextRelief | undefined {
  const window = typeof usage?.context_window === "number" ? usage.context_window : 0;
  const used = typeof usage?.context_used === "number" ? usage.context_used : 0;
  if (window <= 0) return undefined;

  const estimate = estimateMessagesTokensPublic(messages);
  const ratio = estimate > 0 && used > 0 ? Math.max(1, used / estimate) : 1;
  const projected = estimate * ratio;
  if (projected <= Math.floor(window * 0.75)) return undefined;

  const slimmed = slimInFlightMessages(messages, { keepRounds: 3, readerAuthorised: opts.readerAuthorised === true });
  const slimmedEstimate = estimateMessagesTokensPublic(slimmed.messages);
  // Separate numbers for the dashboard: results re-projected from their
  // recorded source, and the source bytes that slimming newly omitted.
  const sourceFacts = slimmed.sourcesSlimmed > 0
    ? { sources_slimmed: slimmed.sourcesSlimmed, source_omitted_bytes: slimmed.sourceOmittedBytes }
    : {};
  const slimmedTokens = Math.floor(slimmedEstimate * ratio);
  if (slimmed.reclaimed > 0 && slimmedTokens <= Math.floor(window * 0.5)) {
    return {
      messages: slimmed.messages as AgentMessage[],
      name: "context/slim",
      payload: {
        before_tokens: Math.floor(projected),
        after_tokens: slimmedTokens,
        reclaimed_bytes: slimmed.reclaimed,
        dropped_messages: 0,
        in_turn: true,
        committed: true,
        ...sourceFacts,
      },
    };
  }

  const effectiveWindow = Math.max(1, Math.floor((window * 0.75) / ratio));
  const result = pruneInFlightMessages(slimmed.messages, effectiveWindow, undefined, {
    fireAt: 1,
    pruneTo: 0.5 / 0.75,
  });
  if (result.dropped <= 0) return undefined;
  return {
    messages: result.messages as AgentMessage[],
    name: "context/prune",
    payload: {
      before_tokens: Math.floor(projected),
      after_tokens: Math.max(0, Math.floor((slimmedEstimate - result.droppedTokens) * ratio)),
      reclaimed_bytes: slimmed.reclaimed,
      dropped_messages: result.dropped,
      kept_messages: result.messages.length,
      in_turn: true,
      committed: true,
      ...sourceFacts,
    },
  };
}

/** Pi treats a returned value as success unless a tool throws. Dokkabi tools
 * also use details.error for bounded functional failures, so promote that
 * declaration before events and diagnostics are emitted. */
export function effectiveToolResultError(isError: boolean, details: unknown): boolean {
  return isError || (
    typeof details === "object"
    && details !== null
    && Reflect.get(details, "error") === true
  );
}

/** A fresh authoritative provider reserve at or below five percent is a
 * completed-turn stop signal. Unknown, observed, and stale estimates never
 * block work. */
export function quotaReserveReached(
  events: readonly EventRecord[],
  now = Date.now(),
  reservePercent = 5,
  selection?: { route: string; model: string },
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const snapshot = events[index]?.observe?.model_quota_snapshot;
    if (!snapshot) continue;
    if (selection && (snapshot.route !== selection.route || snapshot.model !== selection.model)) continue;
    const staleAfter = "staleAfter" in snapshot ? snapshot.staleAfter : undefined;
    const staleAt = typeof staleAfter === "string" ? Date.parse(staleAfter) : Number.NaN;
    if (!Number.isFinite(staleAt) || staleAt <= now) return false;
    return snapshot.windows.some((window) => {
      const confidence = "confidence" in window ? window.confidence : snapshot.confidence;
      return confidence === "authoritative"
        && typeof window.remaining_percent === "number"
        && window.remaining_percent <= reservePercent;
    });
  }
  return false;
}

interface ProfileScope {
  current: { profile: ToolProfileName; todo: string; allowed: Set<string> } | undefined;
}

/**
 * THE PRE-CALL PIPELINE (#228 A2'): what every tool call passes before it
 * runs — the model's own calls from `beforeToolCall`, and a read batch's
 * children through the provided `tool_call_pipeline` — in one function, so
 * the two paths cannot drift: the step's tool profile, the workspace and
 * secret path predicates (container alias mapped first), the private
 * coordinate and secret guards, the repeat-read cooldown and the per-turn
 * tool budget (each child counted as one call). The `tool/call` row is
 * appended here; a child's names its `parent`. Only the model's calls feed
 * the consecutive-call breaker and stage a durable foreground receipt.
 */
export interface ToolCallPipelineDeps {
  readonly ctx: HostContext;
  readonly profileScope: ProfileScope;
  readonly toolLoop: ToolLoopRuntime;
  readonly guardChurn: GuardChurnState;
  readonly toolBudget: ToolCallBudgetState;
  readonly repeatedReads: Map<string, RepeatReadEntry>;
  readonly speculation: SpeculationService | undefined;
}

export type ToolCallAdmission =
  | { readonly block: false; readonly durableReceipt?: DurableToolCallReceipt; readonly record: Readonly<Record<string, unknown>> }
  | { readonly block: true; readonly reason: string; readonly terminate?: boolean; readonly record: Readonly<Record<string, unknown>> };

export interface ToolCallPipelineCall {
  readonly name: string;
  readonly id: string;
  readonly args: unknown;
  /** The model's call this one is a child of (a read batch's item). */
  readonly parent?: string;
  /** #224 A1': a PREVIEW of a RECEIVED call's admission, before the
   * assistant commits: the same decision the ordinary guard would make, on a
   * shadow of the guard state (with the previews of the attempt's earlier
   * live leases, `prior`, replayed onto it) — no guard is mutated, no guard
   * row is appended, no receipt is minted. The decision is recorded only as
   * `early_read/admission`. The call is admitted for real, from scratch, at
   * Pi's ordinary point, where the guards commit and their rows land exactly
   * as with the feature off. */
  readonly early?: Pick<EarlyAdmissionRequest, "attempt" | "ordinal" | "lease" | "registration" | "schemaDigest" | "resource" | "prior">;
}

/** A1': the guard state one admission reads and writes — the live one at Pi's
 * ordinary point, a shadow copy for a preview. */
interface GuardState {
  readonly toolBudget: ToolCallBudgetState;
  readonly toolLoop: ToolLoopRuntime;
  readonly guardChurn: GuardChurnState;
  readonly repeatedReads: Map<string, RepeatReadEntry>;
  readonly scope: ProfileScope["current"];
}

function shadowGuardState(deps: ToolCallPipelineDeps): GuardState {
  const scope = deps.profileScope.current;
  return {
    toolBudget: { ...deps.toolBudget },
    toolLoop: { guard: deps.toolLoop.guard.clone(), warningCalls: new Set(deps.toolLoop.warningCalls), ...(deps.toolLoop.terminated ? { terminated: deps.toolLoop.terminated } : {}) },
    guardChurn: { ...deps.guardChurn },
    repeatedReads: new Map([...deps.repeatedReads].map(([key, entry]) => [key, { ...entry }])),
    scope: scope ? { ...scope, allowed: new Set(scope.allowed) } : undefined,
  };
}

/** R3: one withholding rule for `tool/call` and `early_read/admission` — a
 * record without `args` and with an empty hint is a withheld one (a secret
 * or outside path); nothing that names the path may join either row. */
export function toolCallRecordWithheld(record: Readonly<Record<string, unknown>>): boolean {
  return record.args === undefined && record.arg_hint === "";
}

export type ToolCallPipeline = (call: ToolCallPipelineCall) => ToolCallAdmission;

/** The provided `tool_call_pipeline`: `current` is the live agent's pipeline
 * while one exists; a consumer without one admits nothing through the loop. */
export interface ToolCallPipelineHolder {
  current?: ToolCallPipeline;
}

export const TOOL_CALL_PIPELINE_KEY = "tool_call_pipeline";

const TOOL_CALL_PIPELINES = new WeakMap<object, ToolCallPipelineHolder>();

export function admitToolCall(deps: ToolCallPipelineDeps, call: ToolCallPipelineCall): ToolCallAdmission {
  if (call.early === undefined) {
    const live: GuardState = { toolBudget: deps.toolBudget, toolLoop: deps.toolLoop, guardChurn: deps.guardChurn, repeatedReads: deps.repeatedReads, scope: deps.profileScope.current };
    return decideToolCall(deps, call, live, (row) => deps.ctx.log.append(row), true);
  }
  // A1': a pure preview on a shadow — the attempt's earlier live leases
  // replayed first, in ordinal order, so this decision reads the state the
  // ordinary guard will have when it reaches this call; nothing real moves.
  const shadow = shadowGuardState(deps);
  const silent = () => undefined;
  for (const prior of call.early.prior) decideToolCall(deps, { name: prior.name, id: prior.id, args: prior.args }, shadow, silent, false);
  const decision = decideToolCall(deps, call, shadow, silent, false);
  const withheld = toolCallRecordWithheld(decision.record);
  deps.ctx.log.append({
    kind: "observe",
    name: EARLY_READ_ADMISSION_EVENT,
    payload: {
      ...decision.record,
      lease: call.early.lease,
      attempt: call.early.attempt,
      ordinal: call.early.ordinal,
      registration: call.early.registration,
      schema_digest: call.early.schemaDigest,
      // R3/R3': what tool/call withholds, this row withholds; a refusal's text
      // is the model's tool result, never a row of either family; the
      // resolved path is never text — the identity and the digest are.
      ...(withheld ? {} : { resource_identity: call.early.resource.identity, resource_version: call.early.resource.version }),
      decision: decision.block ? "refused" : "admitted",
      ...(decision.block ? { reason: "pipeline_refused" } : {}),
    },
  });
  return decision;
}

/**
 * The one decision, on `state`: the live guards at Pi's ordinary point
 * (`commit`: rows appended through `emit`, the `tool/call` row and any
 * durable receipt written) or a shadow for an early preview (`emit` silent,
 * nothing written, nothing minted).
 */
function decideToolCall(deps: ToolCallPipelineDeps, call: ToolCallPipelineCall, state: GuardState, emit: (row: EventInput) => unknown, commit: boolean): ToolCallAdmission {
  const { ctx, speculation } = deps;
  const { toolLoop, guardChurn, toolBudget, repeatedReads } = state;
  const rows = { append: emit };
  const args = call.args;
  // Outside this step's profile: record it before the call itself, so a
  // replay sees why the call was admitted (or refused) under this profile.
  const scope = state.scope;
  let profileRefusal: string | undefined;
  if (scope && !scope.allowed.has(call.name)) {
    const mode = permissionModeFromEvents(ctx.log.events);
    const action = outOfProfileAction(mode, scope.profile);
    emit({
      kind: "observe",
      name: PROFILE_EXCEEDED,
      payload: { id: call.id, tool: call.name, profile: scope.profile, todo: scope.todo, mode, action },
    });
    if (action === "widen") scope.allowed.add(call.name);
    if (action === "refuse") profileRefusal = refusalText(call.name, scope.profile, [...scope.allowed]);
  }
  const path = typeof (args as { path?: string }).path === "string" ? (args as { path: string }).path : "";
  const guardedPath = process.env.DOKKABI_DOCKER_CONTAINER || process.env.DOKKABI_SWE_CONTAINER
    ? workspaceToolPath(ctx.workspaceRoot, path)
    : path;
  const outsideWorkspace = guardedPath !== ""
    && !pathInsideWorkspace(ctx.workspaceRoot, guardedPath);
  const secretPath = guardedPath !== "" && workspaceToolSecretPath(toolsFor(ctx), call.name, guardedPath);
  const protectsPrivateCoordinates = protectsPrivateInfrastructure(call.name);
  // ssh op=enroll is the sanctioned path for a coordinate to enter: the
  // operator confirms it in an approval popup and it is written to their
  // ssh config, never to the log (safeToolCallRecord still withholds the
  // args). So enroll is exempt from the coordinate block — otherwise the
  // one legitimate way to register a host would be blocked before it runs.
  // The class is computed here so the refusal can NAME what matched; a
  // refusal that only says "blocked" looped the model on reworded retries.
  const coordinateClass = protectsPrivateCoordinates && !isSshEnrollCall(call.name, args)
    ? toolArgsPrivateInfrastructureClass(args)
    : undefined;
  const hasPrivateInfrastructure = coordinateClass !== undefined;
  // A path may itself contain a private coordinate. The shared record
  // builder suppresses that hint and retains full args only when safe.
  const { payload: toolPayload, safeArgs, argsDigest } = safeToolCallRecord(
    call.name,
    call.id,
    args,
    () => sessionObservedSecretValues(ctx.log.events),
  );
  if (outsideWorkspace || secretPath) {
    // A refused host path did not previously enter tool/call at all. Count
    // it so a model cannot loop on the refusal, but retain no coordinate
    // or hint which the workspace boundary was specifically protecting.
    delete toolPayload.args;
    toolPayload.arg_hint = "";
  }
  // #228 X2': a batch child is recorded under its own family, never as a
  // loop `tool/call` — no consumer of loop rows can see it by construction.
  if (call.parent !== undefined && commit) {
    ctx.log.append({ kind: "observe", name: READ_BATCH_CHILD_CALL_EVENT, payload: { ...toolPayload, parent: call.parent } });
  }
  const durableReceipt = commit && call.parent === undefined && speculation?.requiresDurableForeground?.(call.name, args) === true
    ? ctx.log.appendDurableToolCall(toolPayload)
    : undefined;
  // #224 A1': a preview writes no tool/call row; the ordinary point does.
  if (commit && call.parent === undefined && !durableReceipt) ctx.log.append({ kind: "observe", name: "tool/call", payload: toolPayload });
  const record = toolPayload;
  if (profileRefusal !== undefined) return { block: true, reason: profileRefusal, record };
  if (toolLoop.terminated) {
    return { block: true, reason: TOOL_LOOP_TERMINATION, terminate: true, record };
  }
  // The consecutive-call breaker judges the MODEL's calls: a batch child is
  // not one (its parent was judged), so a child neither feeds nor resets it.
  const streak: ToolCallStreak | { readonly decision: "allow" } = call.parent === undefined
    ? toolLoop.guard.observeDigest(call.name, argsDigest)
    : { decision: "allow" };
  if ("tool" in streak) appendToolLoopEvents(rows, streak);
  if (streak.decision === "warn") toolLoop.warningCalls.add(call.id);
  if (streak.decision === "terminate") {
    // Block the call and say what to do instead — but leave the turn
    // running. Ending it here was written for an operator who would read
    // the terminated turn; unattended there is nobody, so it ended the run
    // instead. The model is holding a refusal that usually names what is
    // wrong with its arguments; give it the chance to act on that.
    return { block: true, reason: TOOL_LOOP_TERMINATION, record };
  }
  if (streak.decision === "hard_stop") {
    toolLoop.terminated = streak;
    return { block: true, reason: TOOL_LOOP_TERMINATION, terminate: true, record };
  }
  const blocked = (reason: string, terminate = false) => {
    const warn = toolLoop.warningCalls.delete(call.id);
    return {
      block: true as const,
      reason: warn ? `${reason}${TOOL_LOOP_WARNING}` : reason,
      ...(terminate ? { terminate: true } : {}),
      record,
    };
  };
  if (outsideWorkspace) {
    return blocked(`path ${path} is outside the workspace`);
  }
  if (secretPath) {
    return blocked(CREDENTIAL_PATH_REFUSAL);
  }
  // #228 A2''': the cooldown folds the same mapped path the guards decided on.
  const mappedArgs = guardedPath !== path && typeof args === "object" && args !== null ? { ...args, path: guardedPath } : args;
  const repeatedRead = repeatedWorkspaceRead(call.name, mappedArgs, repeatedReads, ctx.workspaceRoot);
  const repeatDecision = repeatedRead ? repeatedReadDecision(repeatedRead.entry, Date.now()) : "allow";
  if (repeatedRead && repeatDecision !== "allow") {
    emit({
      kind: "observe",
      name: "context/repeat_read",
      payload: {
        tool: call.name,
        calls: repeatedRead.entry.count,
        target_digest: modelEventDigest(repeatedRead.target),
        decision: repeatDecision,
        ...(repeatDecision === "block" ? { cooldown_ms: REPEAT_READ_COOLDOWN_MS } : {}),
      },
    });
  }
  if (repeatDecision === "block") {
    // This call only, and only for a while: the turn keeps its plan.
    return blocked(
      `This exact call has run ${REPEAT_READ_BLOCK_AT} times in one turn and is on cooldown for ${
        Math.round(REPEAT_READ_COOLDOWN_MS / 1000)
      }s. Reading the same file at a different offset, or grepping it with a different pattern, is not affected — reuse what you already read, or move to the next thing.`,
    );
  }
  if (hasPrivateInfrastructure) {
    const decision = privateInfrastructureBlockDecision(guardChurn, call.name, coordinateClass);
    // One escalation row per turn: later blocks in the same batch are the
    // same decision, not new ones.
    if (decision.announce) {
      emit({
        kind: "observe",
        name: "security/private_guard_churn",
        payload: { tool: call.name, blocks: guardChurn.blocks, decision: "terminate" },
      });
    }
    return blocked(decision.reason, decision.terminate);
  }
  if (safeArgs === undefined) {
    // The durable-args check withholds on a secret OR (for protected
    // tools) a coordinate; the refusal must name the guard that actually
    // fired. Live, twenty home-path bash calls were told "secret guard"
    // and the model had no cause to comply with. A home path is no longer
    // a coordinate at all — what remains here is a real credential, or a
    // raw coordinate the home-normalized check above legitimately skipped.
    const secretClass = secretShapeClassInValue(args);
    if (secretClass !== undefined) {
      return blocked(
        `tool arguments matched the secret guard: they carry ${secretClass}; remove the credential value or use a safe placeholder`,
      );
    }
    const rawCoordinateClass = protectsPrivateCoordinates
      ? privateInfrastructureClassInValue(args)
      : undefined;
    if (rawCoordinateClass !== undefined) {
      const decision = privateInfrastructureBlockDecision(guardChurn, call.name, rawCoordinateClass);
      if (decision.announce) {
        emit({
          kind: "observe",
          name: "security/private_guard_churn",
          payload: { tool: call.name, blocks: guardChurn.blocks, decision: "terminate" },
        });
      }
      return blocked(decision.reason, decision.terminate);
    }
    return blocked("tool arguments matched the secret guard; remove the credential value or use a safe placeholder");
  }
  const budgetDecision = toolCallBudgetDecision(toolBudget, call.name, args);
  if (budgetDecision !== "allow") {
    emit({
      kind: "observe",
      name: "model/tool_budget",
      payload: {
        limit: toolBudget.limit,
        used: toolBudget.used,
        decision: budgetDecision,
      },
    });
    const hints = finalizerHints(toolBudget);
    return blocked(
      hints.length > 0
        ? `Exploration budget exhausted. Use only ${hints.join("/")} to finalize the required artifacts, then finish this turn.`
        : "Tool budget exhausted for this turn. Return the requested verdict now without more tool calls.",
      budgetDecision === "terminate",
    );
  }
  return { block: false, record, ...(durableReceipt ? { durableReceipt } : {}) };
}

function createLiveAgent(
  ctx: HostContext,
  route: LlmRoute,
  model: Model<Api>,
  tools: AgentTool[],
  sink: { onAssistant?: (text: string) => void },
  toolBudget: ToolCallBudgetState,
  generationLimits: TurnGenerationLimits,
  sessionBudget: SessionBudgetEpisode,
  repeatedReads: Map<string, RepeatReadEntry>,
  toolLoop: ToolLoopRuntime,
  probeChurn: ProbeChurnState,
  guardChurn: GuardChurnState,
  speculation: SpeculationService | undefined,
  profileScope: ProfileScope,
  requestContext: RequestContextState = { profile: "default" },
): Agent {
  const pipelineDeps: ToolCallPipelineDeps = { ctx, profileScope, toolLoop, guardChurn, toolBudget, repeatedReads, speculation };
  // #228 A2': the same pipeline, offered to a read batch for its children
  // while this agent is live.
  const pipelineHolder = TOOL_CALL_PIPELINES.get(ctx.log);
  if (pipelineHolder) pipelineHolder.current = (call) => admitToolCall(pipelineDeps, call);
  // #227 CG-02: while a request-context contribution is registered, each
  // tool's execution runs in its own invocation scope, so the rows it
  // appends are named on its `tool/end` by host identity (never by order).
  // Without one the tools are passed through untouched: off is byte-identical.
  const contextRegistry = ctx.tryGet<RequestContextContributionRegistry>("request_context_contributions");
  const linking = contextRegistry?.active() === true;
  const observedByCall = new Map<string, { rows: readonly ObservedRow[]; dropped: number }>();
  const agentTools = linking
    ? tools.map((tool) => ({
        ...tool,
        execute: async (...args: Parameters<AgentTool["execute"]>) => {
          const run = runInInvocation(ctx.log, args[0], () => tool.execute(...args));
          try {
            return await run.result;
          } finally {
            observedByCall.set(args[0], { rows: run.scope.rows, dropped: run.scope.dropped });
          }
        },
      }) as AgentTool)
    : tools;
  const observedRows = linking
    ? (id: string): Record<string, unknown> => {
        const found = observedByCall.get(id);
        observedByCall.delete(id);
        return found ? observedRowsField(found.rows, found.dropped) : {};
      }
    : undefined;
  // Pi converts ordinary tool exceptions to error results. A durable child
  // terminal must still end the parent operation before another dispatch.
  const recoveryTools = generationLimits.recovery ? agentTools.map(tool => ({ ...tool,
    execute: async (...args: Parameters<AgentTool["execute"]>) => {
      try { return await tool.execute(...args); }
      catch (error) {
        if (isRecoveryTerminalError(error)) { generationLimits.recoveryError = error; agent.abort(); }
        throw error;
      }
    },
  }) as AgentTool) : agentTools;
  // #224: the received-call capability, when a plugin provides it (opt-in).
  // It wraps the tools OUTERMOST — over the speculation projection and the
  // invocation link — so an early start executes through the same objects
  // Pi executes (one authority, SO-O2) and Pi's ordinary point consumes the
  // lease. Absent, `executedTools` is `agentTools`: byte-identical (E1).
  const received = route.name === "replay" ? undefined : ctx.tryGet<ReceivedToolExecution>(RECEIVED_TOOL_EXECUTION_KEY);
  let bound: BoundReceivedSurface | undefined;
  if (received) {
    const registered = toolsFor(ctx) ?? [];
    bound = received.bind({
      registered,
      live: recoveryTools,
      api: model.api,
      route: route.name,
      admit: (call) => {
        const decision = admitToolCall(pipelineDeps, { name: call.name, id: call.id, args: call.args, early: call });
        return decision.block
          ? { block: true, reason: decision.reason, ...(decision.terminate ? { terminate: true } : {}), record: decision.record }
          : { block: false, record: decision.record };
      },
      requiresDurableForeground: (name, args) => speculation?.requiresDurableForeground?.(name, args) === true,
    });
  }
  const executedTools = bound ? bound.tools : recoveryTools;
  const prefix = frozenPrefixHash({
    systemPrompt: ctx.systemPrompt,
    toolSchemas: ctx.toolSchemas,
  });
  const pluginManifestDigest = currentPluginManifestDigest(ctx.log.events);
  const inspected = inspectAgentTranscript(agentTranscriptPath(ctx.log.path), {
    prefix_hash: prefix,
    system_prompt_hash: systemPromptHash(ctx.systemPrompt),
    tool_schema_hash: toolSchemaHash(ctx.toolSchemas),
    ...(pluginManifestDigest
      ? { plugin_manifest_digest: pluginManifestDigest }
      : {}),
    model_id: model.id,
    route: route.name,
  });
  const transitionedMessages = profileTransitionMessages(inspected, ctx.log.events);
  let inputState = liveProviderState(ctx.log);
  const cacheMessages = inspected.restored ? inspected.messages : transitionedMessages;
  if (inspected.file?.messages.length) {
    requireProviderInput(inputState.ref && !inputState.pending
      && inputDigest(inspected.file.messages) === inputDigest(inputState.messages),
      "private cache has no matching durable history; explicit logged reseed is required");
    if (!cacheMessages) {
      const reason = inspected.restored ? "metadata_mismatch" : inspected.reason;
      ctx.log.append({
        kind: "observe", name: "session/resume",
        payload: {
          restored: false, reason, stored_messages: inspected.stored_messages,
          ...(!inspected.restored && inspected.mismatches ? { mismatches: inspected.mismatches } : {}),
          action: "reseed_required",
        },
      });
      requireProviderInput(false, `private cache metadata requires explicit reseed: ${reason}; `
        + "use dokkabi resume --session <ID> --workspace <DIR> --reseed to carry bounded EventLog history under the current prefix");
    }
  }
  if (!inputState.ref) {
    replaceProviderMessages(ctx.log, [], "start");
    inputState = liveProviderState(ctx.log);
  }
  requireProviderInput(!inputState.pending, "compaction recovery is incomplete");
  ctx.log.append({
    kind: "observe",
    name: "session/resume",
    payload: inputState.messages.length > 0
      ? {
          restored: true,
          messages: inputState.messages.length,
          source: "event-log",
          ...(transitionedMessages ? { transition: "tool_profile" } : {}),
        }
      : {
          restored: false,
          reason: inspected.restored ? "empty_transcript" : inspected.reason,
          ...(!inspected.restored && inspected.mismatches ? { mismatches: inspected.mismatches } : {}),
          stored_messages: inspected.stored_messages,
          ...(!inspected.restored && inspected.reason === "transcript_missing" ? {} : { action: "fresh_start" }),
        },
  });
  // #223 R3: projections delivered under another tool profile state the
  // recovery that profile had; restate it for this one before any request.
  const readerAuthorised = resultSourceReaderAuthorised(tools, ctx.log);
  const recovery = refreshResultRecovery(inputState.messages as Array<{ role: string; content?: unknown }>, readerAuthorised);
  if (recovery.changed > 0) {
    assertProviderMessages(ctx.log, inputState.messages);
    replaceProviderMessages(ctx.log, recovery.messages, "tool/source_recovery", { changed: recovery.changed, reader_authorised: readerAuthorised });
    ctx.log.append({ kind: "observe", name: "tool/source_recovery", payload: { changed: recovery.changed, reader_authorised: readerAuthorised } });
    inputState = liveProviderState(ctx.log);
    // Keep the private cache on the durable history it mirrors.
    saveMessagesForRoute(ctx, route.name, model.id, inputState.messages as AgentMessage[]);
  }
  const restored = inputState.messages;
  // sessionId is Codex prompt_cache_key and the WebSocket reuse key. Without it every
  // inner tool-loop request opens a new socket and prefix cache misses.
  let agent: Agent;
  agent = new Agent({
    sessionId: ctx.sessionId,
    initialState: {
      systemPrompt: ctx.systemPrompt,
      model,
      tools: executedTools,
      ...(restored ? { messages: restored as AgentMessage[] } : {}),
    },
    // #222 D2: the one real provider-request boundary. Pi calls this before
    // EVERY request of an episode — the first, the one after a tool batch in
    // the same episode, a continuation, a retry — and never while a response
    // streams. What the registered sources have ready is recorded as an
    // exact suffix (row, then transcript append naming it) and only then
    // joins this request's context; an append failure delivers nothing. The
    // array is the loop's own context, so the suffix stays in the transcript
    // the next request extends, as it does in the durable one.
    transformContext: async (messages) => {
      const boundary = {
        kind: messages.at(-1)?.role === "toolResult" ? "tool_batch" as const : messages.at(-1)?.role === "user" ? "prompt" as const : "continue" as const,
        request: ctx.log.events.reduce((count, event) => count + (event.name === "provider/request" ? 1 : 0), 1),
      };
      // Optional advisory sources keep their existing failure semantics.
      const registry = ctx.tryGet<ModelInputContributionRegistry>(MODEL_INPUT_CONTRIBUTIONS_KEY);
      if (!registry || registry.list().length === 0) return messages;
      const message = contributeModelInput({
        log: ctx.log,
        registry,
        boundary,
      });
      if (!message) return messages;
      messages.push(message as AgentMessage);
      agent.state.messages = messages;
      return messages;
    },
    // Context relief is committed only after a successful assistant/tool
    // turn. Pi does not call this hook for failed or aborted assistant
    // messages, so same-route retries retain their original context.
    prepareNextTurnWithContext: ({ context, toolResults }) => {
      // The loop core answers an unknown tool name before beforeToolCall can;
      // patch the roster in while the result is still in the unsent batch.
      const roster = annotateUnknownToolResults(context.messages, tools.map((tool) => tool.name));
      let messages = context.messages;
      if (roster) {
        assertProviderMessages(ctx.log, messages);
        replaceProviderMessages(ctx.log, roster.messages, "tool/unknown_tool_hint", { annotated: roster.annotated });
        messages = roster.messages;
        agent.state.messages = messages;
        ctx.log.append({
          kind: "observe",
          name: "tool/unknown_tool_hint",
          payload: { annotated: roster.annotated },
        });
      }
      const relief = committedContextRelief(messages, lastUsage(ctx), {
        readerAuthorised: resultSourceReaderAuthorised(tools, ctx.log),
      });
      if (relief) {
        assertProviderMessages(ctx.log, messages);
        replaceProviderMessages(ctx.log, relief.messages, relief.name, { transformation: relief.payload });
        agent.state.messages = relief.messages;
        ctx.log.append({ kind: "observe", name: relief.name, payload: relief.payload });
        messages = relief.messages;
      }
      // #227 CG-04: the next request after a tool batch — inside one Pi
      // episode — gets the same request-context boundary as the first one,
      // so a failure just observed reaches the very next provider input.
      // Pi calls this hook after every turn; only a turn that ran tools is
      // followed by another request, so only it is a preparation boundary.
      const framed = toolResults.length === 0 ? undefined : applyRequestContext(ctx.log, contextRegistry, {
        boundary: "tool_batch",
        messages,
        profile: requestContext.profile,
        readerAuthorised: resultSourceReaderAuthorised(tools, ctx.log),
        ...requestUsage(ctx),
      });
      if (framed) {
        messages = framed as AgentMessage[];
        agent.state.messages = messages;
      }
      return roster || relief || framed ? { context: { ...context, messages } } : undefined;
    },
    beforeToolCall: async ({ args, toolCall }) => {
      // #224 A1': the ordinary admission, from scratch, exactly as with the
      // feature off — the guards commit here, once, and their rows land here.
      // A lease for the call is served only if this admission allows it.
      const decision = admitToolCall(pipelineDeps, { name: toolCall.name, id: toolCall.id, args });
      if (bound) await bound.settleAdmission(toolCall.id, args, decision.block);
      if (decision.block) return { block: true, reason: decision.reason, ...(decision.terminate ? { terminate: true } : {}) };
      if (decision.durableReceipt) speculation?.stageForegroundAuthorization?.(toolCall.id, decision.durableReceipt);
      return {};
    },
    afterToolCall: async ({ args, toolCall, result, isError }) => {
      const safe = safeToolResultInput(result);
      result = safe.result;
      if (safe.redactedStrings > 0) {
        ctx.log.append({ kind: "observe", name: "tool/output_redacted", payload: {
          name: toolCall.name, id: toolCall.id, redacted_strings: safe.redactedStrings,
        } });
      }
      // #223: the delivery step. Redaction came first; the safe bytes are
      // stored and their envelope recorded before this bounded projection
      // can reach a provider request. Host hints below append after it.
      result = deliverToolResult({
        log: ctx.log,
        invocationId: toolCall.id,
        tool: toolCall.name,
        result,
        redactedStrings: safe.redactedStrings,
        readerAuthorised: resultSourceReaderAuthorised(tools, ctx.log),
      });
      const details = result.details && typeof result.details === "object"
        ? result.details as Record<PropertyKey, unknown>
        : {};
      const effectiveError = effectiveToolResultError(isError, details);
      const feedback = slowToolFeedback({
        log: ctx.log,
        name: toolCall.name,
        id: toolCall.id,
        args,
        result,
        isError: effectiveError,
      });
      const warn = toolLoop.warningCalls.delete(toolCall.id);
      const probeHint = probeBatchingHint(probeChurn, toolCall.name);
      if (probeHint !== undefined) {
        ctx.log.append({
          kind: "observe",
          name: "tool/probe_hint",
          payload: { name: toolCall.name, shell_calls: probeChurn.shellCalls },
        });
      }
      const resultText = (result.content ?? [])
        .map((part) => (part as { text?: string }).text ?? "")
        .join("\n");
      speculation?.observeToolResult({
        callId: toolCall.id,
        tool: toolCall.name,
        args,
        text: resultText,
        isError: effectiveError,
        exitCode: typeof details.exit_code === "number" ? details.exit_code : null,
      });
      const redirectHint = bashSshRedirectHint(toolCall.name, effectiveError, resultText);
      // The session budget the host enforces must also be VISIBLE to the
      // model: one state line per tool result, last so the result ends with
      // the current numbers. Absent budget, absent line — byte-identical.
      const budgetLine = sessionBudgetStateLine(ctx.log, sessionBudget);
      const hints = [probeHint, redirectHint, budgetLine].filter((hint): hint is string => hint !== undefined);
      const withHint = hints.length === 0
        ? feedback.content
        : [
            ...(feedback.content ?? result.content),
            ...hints.map((hint) => ({ type: "text" as const, text: `${"\n\n"}${hint}` })),
          ];
      const baseContent = withHint ?? result.content;
      const delivered = warn
        ? [...baseContent, { type: "text" as const, text: TOOL_LOOP_WARNING }]
        : baseContent;
      // The projection step (#221 M1'): exactly this content is the model's
      // result for its own call.
      toolResultDelivered({
        session: ctx.log,
        callId: toolCall.id,
        tool: toolCall.name,
        args,
        ...deliveredContent(delivered),
        isError: effectiveError,
      });
      return {
        content: delivered,
        details: { ...details, [SLOW_TOOL_ASSESSMENT]: feedback.assessment },
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        isError: effectiveError,
        ...(toolLoop.terminated ? { terminate: true } : {}),
      };
    },
    shouldStopAfterTurn: () => {
      if (generationLimits.recoveryError) return true;
      if (toolLoop.terminated) return true;
      // The guard tripped: end the operator turn rather than opening another
      // model request that would just hit the same fence.
      if (guardChurn.tripped) return true;
      if (generationLimits.deadlineExpired === true) return true;
      // The caller-declared session budget is decided where the next request
      // is: the episode ends here, honestly, instead of opening one more
      // provider request the caller already spent.
      const sessionStop = checkSessionBudget(ctx.log, sessionBudget);
      if (sessionStop !== undefined) {
        recordSessionBudgetExhaustion(ctx.log, sessionBudget, sessionStop);
        return true;
      }
      if (!quotaReserveReached(ctx.log.events, Date.now(), 5, { route: route.name, model: model.id })) return false;
      const alreadyRecorded = [...ctx.log.events].reverse().find(
        (event) => event.name === "model/quota_guard" && event.payload.route === route.name && event.payload.model === model.id,
      );
      if (!alreadyRecorded) {
        ctx.log.append({
          kind: "observe",
          name: "model/quota_guard",
          payload: { route: route.name, model: model.id, decision: "stop", reserve_percent: 5 },
        });
      }
      return true;
    },
    streamFn: (nextModel, context, streamOptions) => {
      if (generationLimits.recoveryError) throw generationLimits.recoveryError;
      ctx.log.assertCanRequestModel();
      const recovery = generationLimits.recovery;
      if (recovery?.grant && recovery.toolsPending) {
        assertProviderMessages(ctx.log, context.messages);
        if (!prepareFailoverHandoff(context.messages, { continuity: "continue" }).resumable) throw new RecoveryTerminalError("reconciliation_required", recovery.token);
        recovery.service.result(recovery.token, recovery.grant, recovery.usage);
        recovery.grant = undefined;
        recovery.toolsPending = false;
      }
      if (recovery && !recovery.grant) {
        try { recovery.grant = recovery.service.reserve(recovery.token); }
        catch (error) { generationLimits.recoveryError = error; throw error; }
      }
      speculation?.assertHealthy?.();
      const boundedOptions: SimpleStreamOptions = {
        ...streamOptions,
        ...(recovery ? { maxRetries: 0, maxRetryDelayMs: 0 } : {}),
        // An omitted max_tokens is not "unlimited" — it is the provider's
        // default. One provider defaulted to 8192; at maximum reasoning
        // effort the thinking alone consumed it and every turn truncated
        // before its first tool call. State the cap explicitly: the model's
        // documented limit when the surface asks for nothing tighter.
        ...(() => {
          const cap = boundedMaxTokens(nextModel.maxTokens, generationLimits.maxOutputTokens);
          return cap === undefined ? {} : { maxTokens: cap };
        })(),
        ...(generationLimits.thinkingBudgets === undefined
          ? {}
          : { thinkingBudgets: generationLimits.thinkingBudgets }),
        ...(generationLimits.timeoutMs === undefined
          ? {}
          : { timeoutMs: generationLimits.timeoutMs }),
        ...(generationLimits.temperature === undefined
          ? {}
          : { temperature: generationLimits.temperature }),
      };
      const parent = [...ctx.log.events].reverse().find(event => event.name === "session/parent");
      admitProviderInput(ctx.log, { route: route.name, role: generationLimits.providerRole
        || (typeof parent?.payload.role === "string" ? parent.payload.role : undefined)
        || process.env.DOKKABI_WORK_PHASE || "operator",
        model: nextModel, context, options: boundedOptions });
      // #227: the admitted request carrying frames is handed to the send
      // path — the frames' `dispatched` stage (never merely `prepared`).
      if (linking) recordContextDispatch(ctx.log, latestProviderRequestRef(ctx.log), context.messages);
      if (recovery?.grant) {
        const request = latestProviderRequestRef(ctx.log);
        if (!request) throw new RecoveryTerminalError("dispatch_receipt_missing", recovery.token);
        try { recovery.service.dispatch(recovery.token, recovery.grant, request); }
        catch (error) { generationLimits.recoveryError = error; throw error; }
      }
      if (route.name === "replay" || !route.hasNetwork) {
        return route.stream(nextModel, context, boundedOptions) as never;
      }
      return (
        route.stream as (
          m: Model<Api>,
          c: typeof context,
          o?: SimpleStreamOptions,
        ) => ReturnType<Agent["streamFunction"]>
      )(nextModel, context, boundedOptions);
    },
  });
  const gate = progressGate(Date.now());
  agent.subscribe(async (event) => {
    if (event.type === "message_end") appendProviderMessage(ctx.log, event.message);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message as AssistantMessage;
      const recovery = generationLimits.recovery;
      const usable = message.content.some((part) => part.type === "toolCall" || (part.type === "text" && part.text.trim().length > 0));
      if (recovery?.grant && usable && message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length") {
        const usage = { tokens: message.usage?.totalTokens, cost: message.usage?.cost?.total };
        if (message.content.some((part) => part.type === "toolCall")) {
          recovery.toolsPending = true;
          recovery.usage = usage;
        } else {
          recovery.service.result(recovery.token, recovery.grant, usage);
          recovery.grant = undefined;
        }
      }
    }
    if (event.type === "tool_execution_start") {
      generationLimits.activeToolCalls += 1;
    }
    if (event.type === "tool_execution_end") {
      generationLimits.activeToolCalls = Math.max(0, generationLimits.activeToolCalls - 1);
    }
    sealPiEvent(ctx.log, route, event, model, sink.onAssistant, ctx, gate, generationLimits, observedRows);
    if (linking && event.type === "message_end" && event.message.role === "assistant") {
      const stop = (event.message as AssistantMessage).stopReason ?? "stop";
      recordContextResponse(ctx.log, stop, stop !== "error" && stop !== "aborted");
    }
    speculation?.observeAgentEvent(event);
    // #224: after the #128 owner has seen the event (its exact candidate is
    // queued first; an early start then adopts it through the wrapper). A
    // commit's cancellations settle before Pi goes on (awaited listener).
    if (bound) await bound.observe(event);
  });
  return agent;
}

function profileTransitionMessages(
  inspected: AgentTranscriptInspection,
  events: readonly EventRecord[],
): unknown[] | undefined {
  if (inspected.restored || !inspected.file || inspected.mismatches?.length !== 2) {
    return undefined;
  }
  const mismatches = new Set(inspected.mismatches);
  if (!mismatches.has("tool_schema") || !mismatches.has("prefix_hash")) {
    return undefined;
  }
  const schemaHash = inspected.file.tool_schema_hash;
  if (typeof schemaHash !== "string") {
    return undefined;
  }
  return hasPriorToolProfilePrefix(events, inspected.file.prefix_hash, schemaHash)
    ? inspected.file.messages
    : undefined;
}

/**
 * Re-reading the SAME thing is a loop; reading the NEXT thing is progress.
 *
 * The guard used to key on `tool:path` alone, which cannot tell those apart.
 * Paging a large file — `{path, offset: 1}`, `{path, offset: 284}`,
 * `{path, offset: 624}`, the exact shape a live run used on a three-thousand
 * line ledger — collapsed to one target, hit eight, and lost the turn. Two
 * different regexes over one file had the same problem: different patterns
 * are different evidence, not a repeat.
 *
 * So the key carries whatever argument makes one call different from the
 * next. What remains counted is what was meant all along: the identical call,
 * issued again and again.
 */
/** How many identical calls before one warning line. */
export const REPEAT_READ_WARN_AT = 4;
/** How many identical calls before the call is put on cooldown. */
export const REPEAT_READ_BLOCK_AT = 8;
/**
 * How long an identical call stays refused.
 *
 * The block used to end the operator turn. That is the wrong instrument for
 * this: a turn carries the model's whole plan, and killing it over one
 * over-eager read throws away work that had nothing to do with the read. A
 * cooldown refuses the ONE call and leaves the turn free to do something
 * else — and it heals, so a re-read that is legitimate a minute later simply
 * happens. A genuine tight loop keeps striking the refusal and is caught by
 * the tool-loop breaker, which is the guard that should end a turn.
 */
export const REPEAT_READ_COOLDOWN_MS = 60_000;

export interface RepeatReadEntry {
  count: number;
  /** Set while the identical call is refused; cleared when it expires. */
  blockedUntil?: number;
}

export function repeatedWorkspaceRead(
  toolName: string,
  args: unknown,
  counts: Map<string, RepeatReadEntry>,
  root?: string,
): { target: string; entry: RepeatReadEntry } | undefined {
  if (!args || typeof args !== "object") return undefined;
  // #228 A2'': one fold for one decision — the same identity the batch's
  // "same read twice" rule uses (read-identity.ts), never the spelling.
  const target = readIdentityKey(toolName, args, root);
  if (target === undefined) return undefined;
  const entry = counts.get(target) ?? { count: 0 };
  entry.count += 1;
  counts.set(target, entry);
  return { target, entry };
}

/**
 * Decide on one identical call, and move the entry's cooldown with it.
 *
 * An expired cooldown resets the count rather than leaving the call blocked
 * forever: the refusal is a pause, not a ban.
 */
export function repeatedReadDecision(
  entry: RepeatReadEntry,
  now: number,
  cooldownMs = REPEAT_READ_COOLDOWN_MS,
): "allow" | "warn" | "block" {
  if (entry.blockedUntil !== undefined) {
    if (now < entry.blockedUntil) return "block";
    delete entry.blockedUntil;
    entry.count = 1;
    return "allow";
  }
  if (entry.count >= REPEAT_READ_BLOCK_AT) {
    entry.blockedUntil = now + cooldownMs;
    return "block";
  }
  return entry.count === REPEAT_READ_WARN_AT ? "warn" : "allow";
}

function assertFrozenPrefix(ctx: HostContext): void {
  assertPrefixMatchesSeal({
    systemPrompt: ctx.systemPrompt,
    toolSchemas: ctx.toolSchemas,
    events: ctx.log.events,
  });
}

/** Throttle state for generation heartbeats: one tick per interval, the
 * first only after a full interval (fast turns stay heartbeat-free). */
export interface ProgressGate {
  startedAt: number;
  lastAt: number;
  intervalMs: number;
  /** Characters of reply and thinking already published as deltas. */
  sentText: number;
  sentThinking: number;
  reset(now: number): void;
}

export function progressGate(startedAt: number, intervalMs = 200): ProgressGate {
  return {
    startedAt,
    lastAt: startedAt,
    intervalMs,
    sentText: 0,
    sentThinking: 0,
    reset(now: number) {
      this.startedAt = now;
      this.lastAt = now;
      this.sentText = 0;
      this.sentThinking = 0;
    },
  };
}

/**
 * What is new since the last heartbeat.
 *
 * Each tick used to repeat the last 800 characters of the message, so a
 * 24KB turn wrote 404KB of overlapping tails — three quarters of the whole
 * log — and the board still only ever saw the last 800. Deltas cost what the
 * model actually produced and let a reader reassemble the whole generation.
 *
 * A retry regenerates the message, so the text can shrink; that sends the new
 * text whole rather than a slice of a string the reader has never seen.
 */
export function progressDelta(
  gate: ProgressGate,
  text: string,
  thinking: string,
): { text_delta: string; thinking_delta: string } {
  const textDelta = text.length >= gate.sentText ? text.slice(gate.sentText) : text;
  const thinkingDelta = thinking.length >= gate.sentThinking ? thinking.slice(gate.sentThinking) : thinking;
  gate.sentText = text.length;
  gate.sentThinking = thinking.length;
  return { text_delta: textDelta, thinking_delta: thinkingDelta };
}

export function takeProgressTick(gate: ProgressGate, now: number): boolean {
  if (now - gate.lastAt < gate.intervalMs) {
    return false;
  }
  gate.lastAt = now;
  return true;
}

export function sealPiEvent(
  log: EventLog,
  route: LlmRoute,
  event: AgentEvent,
  model?: Model<Api>,
  onAssistant?: (text: string) => void,
  ctx?: HostContext,
  gate?: ProgressGate,
  generationLimits?: TurnGenerationLimits,
  /** #227: the rows the invocation's execution appended, for its tool/end. */
  observedRows?: (toolCallId: string) => Record<string, unknown>,
): void {
  if (event.type === "agent_start") {
    log.append({ kind: "observe", name: "agent/step", payload: { phase: "start", route: route.name } });
    return;
  }
  if (event.type === "turn_start") {
    gate?.reset(Date.now());
    if (generationLimits) {
      // The request is in flight from here: the stall clock starts at the
      // request under the larger first-delta budget, so a connection that
      // never sends a first byte also trips — after queueing and prefill
      // have had their honest time.
      generationLimits.streaming = true;
      generationLimits.firstDeltaSeen = false;
      generationLimits.streamChars = 0;
      generationLimits.lastStreamActivityAt = Date.now();
    }
    log.append({ kind: "observe", name: "agent/step", payload: { phase: "turn_start" } });
    return;
  }
  if (event.type === "message_update") {
    // Run 18 (vllm, ~11 tok/s): a 14-minute turn appended NOTHING between
    // turn_start and message_end — the board could not tell generation from
    // a hang (constitution 6). A throttled heartbeat observes progress
    // without flooding the log with per-token deltas.
    const message = event.message;
    if (generationLimits && message.role === "assistant") {
      // Every delta feeds the stall watchdog and the char count (from the
      // delta itself, never a re-join of the whole message); only the
      // throttled tick below pays for the telemetry row.
      generationLimits.lastStreamActivityAt = Date.now();
      generationLimits.firstDeltaSeen = true;
      const streamed = (event as { assistantMessageEvent?: { delta?: unknown } }).assistantMessageEvent?.delta;
      if (typeof streamed === "string") {
        generationLimits.streamChars = (generationLimits.streamChars ?? 0) + streamed.length;
      }
    }
    if (gate && message.role === "assistant" && takeProgressTick(gate, Date.now())) {
      const assistant = message as AssistantMessage;
      const thinking = assistantThinking(assistant);
      const reply = assistantText(assistant);
      const delta = progressDelta(gate, reply, thinking);
      const safeReply = safeGeneratedText(
        containsSecret(reply) ? reply : delta.text_delta,
        "model reply",
      );
      const safeThinking = safeGeneratedText(
        containsSecret(thinking) ? thinking : delta.thinking_delta,
        "model thinking",
      );
      // A heartbeat, not content: the live tail rides the rotatable telemetry
      // stream so the hash-chained log stays small (progress was ~55% of it).
      log.appendTelemetry({
        kind: "observe",
        name: "model/progress",
        payload: {
          chars: reply.length,
          thinking_chars: thinking.length,
          tool_chars: assistantToolChars(assistant),
          elapsed_ms: Date.now() - gate.startedAt,
          text_delta: safeReply.text,
          thinking_delta: safeThinking.text,
        },
      });
    }
    return;
  }
  if (event.type === "turn_end") {
    if (generationLimits) generationLimits.streaming = false;
    log.append({ kind: "observe", name: "agent/step", payload: { phase: "turn_end" } });
    return;
  }
  if (event.type === "message_end") {
    const message = event.message;
    if (message.role === "assistant") {
      // The response has landed; tool execution that follows is silent by
      // nature and must not read as a stalled stream.
      if (generationLimits) generationLimits.streaming = false;
      const assistant = message as AssistantMessage;
      const text = assistantText(assistant);
      const thinking = assistantThinking(assistant);
      const rawError = typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined;
      const emptyCompletion = isEmptyCompletion(assistant);
      // A fragment cut off by the stall watchdog is a transport failure, not
      // a reply: it must carry the stall's class and must never reach
      // onAssistant, or the operator reads a truncated answer and then the
      // retry prints the whole one again.
      const stalledFragment = generationLimits?.stalled === true;
      const failure = stalledFragment
        ? normalizeModelFailureV1({ code: STREAM_STALL_ERROR_CODE, message: "stream stalled" })
        : rawError === undefined
          ? emptyCompletion
            ? normalizeModelFailureV1({ kind: "empty_completion" })
            : undefined
          : normalizeModelFailureV1({ message: rawError });
      const reportedStop = assistant.stopReason ?? "stop";
      const cooperativeAbort =
        generationLimits?.deadlineExpired === true
        && generationLimits.timeoutPolicy === "continue"
        && reportedStop === "error"
        && typeof rawError === "string"
        && /\babort(?:ed)?\b/i.test(rawError);
      const stop = stalledFragment ? "error" : cooperativeAbort ? "aborted" : emptyCompletion ? "error" : reportedStop;
      const safeText = safeGeneratedText(text, "model reply");
      const safeThinking = safeGeneratedText(thinking, "model thinking");
      // The reply is the model's own output, and safeGeneratedText is about to
      // replace it wholesale when it matches the guard. Take provenance from
      // the raw text first, as digests (D36).
      const authoredDigests = authoredSecretDigests(text, () => sessionObservedSecretValues(log.events));
      log.append({
        kind: "surface",
        name: "assistant/message",
        payload: {
          text: safeText.text,
          stop,
          ...(failure ? { error: failure.reasonCode, failure_class: failure.class } : {}),
          ...(safeThinking.text ? { thinking: safeThinking.text } : {}),
          ...(authoredDigests.length === 0 ? {} : { authored_secret_digests: authoredDigests }),
        },
      });
      if (text && stop !== "error") {
        onAssistant?.(safeText.text);
      }
      log.append({
        kind: "observe",
        name: "model/usage",
        observe: {
          model_usage: {
            ...usageFromAssistant(route, assistant, log, model),
            // A monkey sample must be able to prove its diversity source
            // from the log alone (#59 S4): the temperature REQUESTED — a
            // provider whose model rejects the field may still drop it.
            ...(generationLimits?.temperature === undefined
              ? {}
              : { temperature: generationLimits.temperature }),
          },
        },
      });
      if (ctx) {
        appendContextLayers(ctx, assistant);
      }
    }
    return;
  }
  if (event.type === "tool_execution_start") {
    log.append({
      kind: "observe",
      name: "tool/start",
      payload: {
        name: event.toolName,
        id: event.toolCallId,
        arg_hint: safeWorkspaceMutationArgHint(event.toolName, event.args),
      },
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    const hostStart = performance.now();
    const rawText = toolResultText(event.result);
    const text = safeToolText(rawText);
    let blob: string | undefined;
    let blobBytes: number | undefined;
    const resultDetails = (event.result && typeof event.result === "object" && "details" in event.result)
      ? (event.result as { details?: Record<string, unknown> }).details
      : undefined;
    const projection = readResultProjection(resultDetails);
    if (projection) {
      // The recorded source is the body; an unstored one names no blob at
      // all rather than a copy of its own preview.
      if (projection.source.source.kind === "blob" && projection.source.resultEvent > 0) {
        blob = projection.source.source.digest;
        blobBytes = projection.source.sourceBytes;
      }
    } else if (rawText.length > 4000 && !containsSecret(rawText)) {
      // #223: only the host names a result body. A digest a tool put in its
      // own details is not adopted — it would make any blob of this session
      // a readable "source" (a digest is not access).
      blob = BlobStore.forSession(log.path).put(rawText);
      blobBytes = Buffer.byteLength(rawText, "utf8");
    }
    const startedAt = toolStartedAt(log, event.toolCallId, event.toolName);
    const duration_ms = startedAt === undefined ? "missing" : Math.max(0, Date.now() - startedAt);
    const result_bytes = Buffer.byteLength(text, "utf8");
    const resultPayload: Record<string, unknown> = { tool: event.toolName, id: event.toolCallId, text, error: event.isError };
    // A value the workspace or the environment handed back is READ, never
    // authored: record its digest so the model cannot author it by echoing it.
    const observedDigests = observedSecretDigests(rawText);
    if (observedDigests.length > 0) resultPayload.observed_secret_digests = observedDigests;
    if (typeof resultDetails?.exit_code === "number" && Number.isSafeInteger(resultDetails.exit_code)) {
      resultPayload.exit_code = resultDetails.exit_code;
    }
    if (projection && projection.source.resultEvent > 0) resultPayload.source_seq = projection.source.resultEvent;
    if (blob) {
      resultPayload.blob = blob;
      resultPayload.blob_bytes = blobBytes ?? Buffer.byteLength(rawText, "utf8");
    } else if (rawText === text) {
      // The unredacted provider output crossed the redaction path unchanged;
      // keep it verbatim for replay. Redacted values stay summary-only.
      resultPayload.raw = rawText;
    }
    log.append({
      kind: "surface",
      name: "tool/result",
      payload: resultPayload,
    });
    const argHint = lastArgHint(log, event.toolCallId, event.toolName);
    const diagnosis = event.isError
      ? toolDiagnosis({
          name: event.toolName,
          command: argHint,
          exit_text: "",
          result_text: text,
          red_case_ids: redCaseIdsFor(log, argHint),
        })
      : undefined;
    const latency = latencyBreakdown({
      name: event.toolName,
      duration_ms,
      arg_hint: argHint,
      result_bytes,
      // Harness overhead: capture, redaction, event appends, classification.
      harness_ms: Math.max(0, Math.round(performance.now() - hostStart)),
    });
    log.append({
      kind: "observe",
      name: "tool/end",
      payload: {
        name: event.toolName,
        id: event.toolCallId,
        error: event.isError,
        duration_ms,
        result_bytes,
        harness_ms: latency.harness_ms,
        command_bound_ms: latency.command_bound_ms,
        total_ms: latency.total_ms,
        verdict: latency.verdict,
        ...(diagnosis ? { diagnosis: diagnosis.kind, diagnosis_detail: diagnosis.detail } : {}),
        ...(observedRows?.(event.toolCallId) ?? {}),
      },
    });
    const assessed = readSlowToolAssessment(event.result);
    const reasons = assessed
      ? assessed.reasons
      : classifySlowTool({
          duration_ms,
          result_bytes,
          overlap: countOpenTools(log, event.toolCallId),
          error: event.isError,
          cpu_pct: lastHostCpu(log),
          name: event.toolName,
          arg_hint: argHint,
        });
    if (reasons && reasons.length > 0) {
      const declaredWait = intentionalWaitMs({ name: event.toolName, arg_hint: argHint });
      const waitedMs = assessed?.waitedMs ??
        (typeof duration_ms === "number" && declaredWait !== undefined
          ? Math.min(declaredWait, duration_ms)
          : undefined);
      log.append({
        kind: "observe",
        name: "tool/slow",
        payload: {
          name: event.toolName,
          id: event.toolCallId,
          duration_ms: assessed?.durationMs ?? duration_ms,
          result_bytes: assessed?.resultBytes ?? result_bytes,
          reason: reasons.join("+"),
          arg_hint: assessed?.argHint ?? argHint,
          ...(waitedMs === undefined ? {} : { waited_ms: waitedMs }),
        },
      });
    }
    return;
  }
  if (event.type === "agent_end") {
    log.append({ kind: "observe", name: "agent/step", payload: { phase: "end" } });
  }
}

function toolsFor(ctx: HostContext): AgentTool[] | undefined {
  try {
    return ctx.get<AgentTool[]>("tools");
  } catch {
    return undefined;
  }
}

function countOpenTools(log: EventLog, exceptId: string): number {
  const open = new Set<string>();
  for (const event of log.events) {
    const id = typeof event.payload.id === "string" ? event.payload.id : "";
    if (!id || id === exceptId) {
      continue;
    }
    if (event.name === "tool/start" || event.name === "tool/call") {
      open.add(id);
    }
    if (event.name === "tool/end") {
      open.delete(id);
    }
  }
  return open.size;
}

function lastHostCpu(log: EventLog): number | "missing" {
  for (let i = log.events.length - 1; i >= 0; i -= 1) {
    const cpu = log.events[i]?.observe?.host?.cpu_pct;
    if (typeof cpu === "number") {
      return cpu;
    }
  }
  return "missing";
}

function lastArgHint(log: EventLog, id: string, name: string): string {
  for (let i = log.events.length - 1; i >= 0; i -= 1) {
    const event = log.events[i];
    if (event?.name !== "tool/start" && event?.name !== "tool/call") {
      continue;
    }
    if (event.payload.id !== id && event.payload.name !== name) {
      continue;
    }
    return typeof event.payload.arg_hint === "string" ? event.payload.arg_hint : "";
  }
  return "";
}

function toolStartedAt(log: EventLog, id: string, name: string): number | undefined {
  for (let i = log.events.length - 1; i >= 0; i -= 1) {
    const event = log.events[i];
    if (event?.name !== "tool/start" && event?.name !== "tool/call") {
      continue;
    }
    const sameId = event.payload.id === id;
    const sameName = event.payload.name === name;
    if (!sameId && !sameName) {
      continue;
    }
    const started = Date.parse(event.ts);
    return Number.isNaN(started) ? undefined : started;
  }
  return undefined;
}

function safeToolText(text: string): string {
  if (containsSecret(text)) {
    return `[redacted tool output ${text.length} bytes]`;
  }
  return text.slice(0, 4000);
}

function slowToolFeedback(input: {
  log: EventLog;
  name: string;
  id: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}): {
  assessment: SlowToolAssessment;
  content?: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
} {
  const startedAt = toolStartedAt(input.log, input.id, input.name);
  const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
  const rawText = toolResultText(input.result);
  const argHint = safeWorkspaceMutationArgHint(input.name, input.args);
  const reasons = classifySlowTool({
    duration_ms: durationMs,
    result_bytes: safeToolText(rawText).length,
    overlap: countOpenTools(input.log, input.id),
    error: input.isError,
    cpu_pct: lastHostCpu(input.log),
    name: input.name,
    arg_hint: argHint,
  });
  const declaredWait = intentionalWaitMs({ name: input.name, arg_hint: argHint });
  const waitedMs = declaredWait === undefined ? undefined : Math.min(declaredWait, durationMs);
  const assessment: SlowToolAssessment = {
    durationMs,
    resultBytes: safeToolText(rawText).length,
    argHint,
    ...(reasons ? { reasons } : {}),
    ...(waitedMs === undefined ? {} : { waitedMs }),
  };
  if (!reasons) return { assessment };
  const reasonText = reasons
    .map((reason) => reason === "intentional_wait" && waitedMs !== undefined
      ? `intentional_wait ${seconds(waitedMs)}`
      : reason)
    .join("+");
  const priorWaitedMs = input.log.events.reduce((sum, event) =>
    event.name === "tool/slow" && typeof event.payload.waited_ms === "number"
      ? sum + event.payload.waited_ms
      : sum, 0);
  const waitBudget = waitedMs === undefined
    ? ""
    : ` session intentional wait: ${seconds(priorWaitedMs + waitedMs)}.`;
  const summary = `[slow: ${seconds(durationMs)} (${reasonText}).${waitBudget}]`;
  const content = readToolResultContent(input.result);
  return {
    assessment,
    content: [
      ...content,
      { type: "text", text: `${content.length > 0 ? "\n\n" : ""}${summary}` },
    ],
  };
}

function readSlowToolAssessment(result: unknown): SlowToolAssessment | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = Reflect.get(result, "details");
  if (!details || typeof details !== "object") return undefined;
  const assessment = Reflect.get(details, SLOW_TOOL_ASSESSMENT);
  return assessment && typeof assessment === "object"
    ? assessment as SlowToolAssessment
    : undefined;
}

function readToolResultContent(
  result: unknown,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (!result || typeof result !== "object") return [];
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } =>
    Boolean(part) && typeof part === "object" &&
    ((Reflect.get(part, "type") === "text" && typeof Reflect.get(part, "text") === "string") ||
      (Reflect.get(part, "type") === "image" && typeof Reflect.get(part, "data") === "string" &&
        typeof Reflect.get(part, "mimeType") === "string")));
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

export interface SafeGeneratedText {
  text: string;
  redacted: boolean;
}

/** Model-generated text is untrusted output. A secret-shaped completion is
 * represented explicitly instead of poisoning the append-only event stream. */
export function safeGeneratedText(text: string, label: string): SafeGeneratedText {
  if (!containsSecret(text)) {
    return { text, redacted: false };
  }
  return { text: `[redacted ${label} ${text.length} chars]`, redacted: true };
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** A provider can finish "successfully" while returning nothing the loop can
 * act on. Tool calls are useful assistant output even when their text is
 * empty, but a stop with neither text nor a tool call is an empty completion
 * regardless of usage accounting — a reasoning model can bill real thinking
 * tokens and still deliver no message and no action, which stalls the turn
 * as surely as provider silence does. */
export function isEmptyCompletion(message: AssistantMessage): boolean {
  if (message.stopReason !== "stop") return false;
  if (assistantText(message).trim().length > 0) return false;
  return !message.content.some((part) => part.type === "toolCall");
}

/** Characters of tool-call arguments generated so far. A big write() call
 * streams minutes of args with zero visible text — without this the
 * heartbeat reads `+125s (0 chars)` and the operator suspects a hang
 * (run 36 operator report). */
export function assistantToolChars(message: AssistantMessage): number {
  let total = 0;
  for (const part of message.content) {
    if (part.type === "toolCall") {
      try {
        total += JSON.stringify(part.arguments ?? {}).length;
      } catch {
        // unserializable partial args: count nothing rather than throw
      }
    }
  }
  return total;
}

/**
 * Provider reasoning (ThinkingContent) — constitution 1: what the model saw
 * must stay reconstructible from the log. Empty or safety-redacted reasoning
 * stays absent from the payload rather than an empty string.
 */
function assistantThinking(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "thinking" && !part.redacted)
    .map((part) => (part.type === "thinking" ? part.thinking : ""))
    .join("")
    .trim();
}

function usageFromBoundaryFailure(
  log: EventLog,
  route: LlmRoute,
  modelId: string,
  failure: NormalizedModelFailureV1,
): ModelUsage {
  const seal = [...log.events].reverse().find((event) => event.name === "prompt/seal");
  return {
    provider: redactText(route.providerId ?? "missing"),
    model: redactText(modelId || "missing"),
    auth: route.authKind,
    route: redactText(route.name ?? "missing"),
    input_tokens: "missing",
    output_tokens: "missing",
    reasoning_tokens: "missing",
    cache_read_tokens: "missing",
    cache_write_tokens: "missing",
    prefix_hash: typeof seal?.payload.prefix_hash === "string"
      ? redactText(seal.payload.prefix_hash)
      : "missing",
    prompt_generation: typeof seal?.payload.prompt_generation === "number"
      ? seal.payload.prompt_generation
      : "missing",
    hit_ratio: "missing",
    context_window: "missing",
    context_used: "missing",
    status: failure.class,
    reason_code: failure.reasonCode,
    ...(failure.retryAfterSeconds === undefined ? {} : { retry_after_sec: failure.retryAfterSeconds }),
  };
}

export function usageFromAssistant(route: LlmRoute, message: AssistantMessage, log: EventLog, model?: Model<Api>): ModelUsage {
  const emptyCompletion = isEmptyCompletion(message);
  // A reply cut off at its output budget is not the model's answer, and
  // nothing here used to say so: `length` is neither "error" nor "aborted"
  // nor empty, so the truncated text was accepted whole. The decompose turn
  // writes the entire ledger in one call, so a cut there is half a JSON
  // document — the seal then refuses it and every repair turn afterwards
  // argues with a cause no one can see.
  const truncated = message.stopReason === "length";
  const failed = message.stopReason === "error" || message.stopReason === "aborted"
    || emptyCompletion || truncated;
  const failure = emptyCompletion
    ? normalizeModelFailureV1({ kind: "empty_completion" })
    : truncated
      ? normalizeModelFailureV1({ kind: "output_truncated" })
      : failed
        ? normalizeModelFailureV1({ message: message.errorMessage ?? `model stop=${message.stopReason}` })
        : undefined;
  const usage = message.usage;
  const input = emptyCompletion
    ? metric(usage?.input)
    : failed && !usage?.input
      ? "missing"
      : metric(usage?.input);
  // A provider that never reports cached tokens (vllm route) would otherwise
  // show a permanent 0% hit — the board must say missing, not lie cold.
  const cacheUnreported = route.reportsCacheUsage === false;
  const cacheRead: Metric = cacheUnreported
    ? "missing"
    : failed && !emptyCompletion && !usage?.cacheRead
      ? "missing"
      : metric(usage?.cacheRead);
  const cacheWrite: Metric = cacheUnreported ? "missing" : metric(usage?.cacheWrite);
  const hit = cacheHitRatio(input, cacheRead, cacheWrite);
  const seal = [...log.events].reverse().find((event) => event.name === "prompt/seal");
  const prefix =
    typeof seal?.payload.prefix_hash === "string"
      ? redactText(seal.payload.prefix_hash)
      : "missing";
  const generation =
    typeof seal?.payload.prompt_generation === "number" ? seal.payload.prompt_generation : "missing";
  const window = model && model.contextWindow > 0 ? model.contextWindow : "missing";
  // Issue #21: observe.model_usage is operator-facing, so every free-form
  // string passes the redactor — a hostile model id or seal hash must not
  // carry token material onto the dashboard.
  return {
    provider: redactText(route.providerId ?? "missing"),
    model: redactText(model?.id ?? message.model ?? "missing"),
    auth: route.authKind,
    route: redactText(route.name ?? "missing"),
    input_tokens: input,
    output_tokens: failed && !emptyCompletion && !usage?.output ? "missing" : metric(usage?.output),
    reasoning_tokens: usage && "reasoning" in usage && usage.reasoning !== undefined ? usage.reasoning : "missing",
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheUnreported
      ? "missing"
      : failed && !emptyCompletion && !usage?.cacheWrite
        ? "missing"
        : metric(usage?.cacheWrite),
    prefix_hash: prefix,
    prompt_generation: generation,
    hit_ratio: hit,
    context_window: window,
    context_used: contextOccupancy(input, cacheRead, "missing", cacheWrite),
    ...(failure
      ? {
          status: failure.class,
          reason_code: failure.reasonCode,
          ...(failure.retryAfterSeconds === undefined ? {} : { retry_after_sec: failure.retryAfterSeconds }),
        }
      : {}),
  };
}

/**
 * Composition of the input context of this turn: the byte-fixed prefix
 * (system prompt + tool schemas) versus the mutable history. Sizes are
 * character estimates — the exact token counts are the provider's — so the
 * pane labels them est. History is what remains of the measured context
 * after the prefix layers.
 */
export function appendContextLayers(ctx: HostContext, message: AssistantMessage): void {
  const usage = message.usage;
  // The shared occupancy, writes included. Hand-rolling input+cacheRead here
  // reported a 190k reload as system+tools with zero history — the fifth
  // call site reinventing this arithmetic, and the reason it now lives in
  // exactly one place.
  const derived = occupancyOf({
    input_tokens: typeof usage?.input === "number" ? usage.input : "missing",
    cache_read_tokens: typeof usage?.cacheRead === "number" ? usage.cacheRead : "missing",
    cache_write_tokens: typeof usage?.cacheWrite === "number" ? usage.cacheWrite : "missing",
  });
  const used = typeof derived === "number" ? derived : 0;
  if (used <= 0) {
    return;
  }
  const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
  const system = estimate(ctx.systemPrompt);
  const tools = estimate(JSON.stringify(ctx.toolSchemas));
  const history = Math.max(0, used - system - tools);
  ctx.log.append({
    kind: "observe",
    name: "model/context_layers",
    payload: { layers: { system, tools, history } },
  });
}

function metric(value: number | undefined): Metric {
  return typeof value === "number" ? value : "missing";
}

export const plugin: PluginModule = {
  id: "loop-pi",
  claims: [
    { key: "loop", role: "definition" },
    { key: "loop", role: "provider" },
    { key: "owned_work_resources", role: "consumer", optional: true },
    { key: "tool_call_pipeline", role: "definition" },
    { key: "tool_call_pipeline", role: "provider" },
    { key: "llm", role: "consumer" },
    // Reached only through tryGet and an optional call, so its absence costs
    // failover and quota reporting and nothing else. Declared as required, it
    // instead left the loop pending forever in any manifest that omits the
    // provider — which is every reduced manifest, including the one the
    // acceptance gate boots.
    { key: "model_resilience", role: "consumer", optional: true },
    { key: "speculation", role: "consumer", optional: true },
    // #224: received-call overlap; absent, the loop is byte-identical.
    { key: RECEIVED_TOOL_EXECUTION_KEY, role: "consumer", optional: true },
    // #222 D2: recorded request suffixes; absent or empty, requests are unchanged.
    { key: "model_input_contributions", role: "consumer", optional: true },
  ],
  register(ctx: HostContext) {
    ctx.define("loop", { implementation: "pi" });
    // #228 A2': the pre-call pipeline, host-only; `current` is set while an
    // agent is live and cleared with it.
    const holder: ToolCallPipelineHolder = {};
    TOOL_CALL_PIPELINES.set(ctx.log, holder);
    ctx.define(TOOL_CALL_PIPELINE_KEY, { visibility: "host_only", origin: "loop" });
    ctx.provide(TOOL_CALL_PIPELINE_KEY, holder);
    ctx.effect(() => () => { delete holder.current; TOOL_CALL_PIPELINES.delete(ctx.log); });
    attachPiLoop(ctx);
  },
};
