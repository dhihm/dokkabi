import type { RecoveryOperation } from "../host/recovery.ts";
import type { EventLog } from "../host/event-log.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";
import type { ModelCost } from "../host/model-failover.ts";
import type { ManualHandoffResult } from "../host/model-handoff.ts";
import type { EventRecord } from "../host/schema.ts";
import type {
  SwarmMemoryCompileInput,
  SwarmMemoryContributor,
  SwarmMemoryViewV1,
} from "../swarm/memory-view.ts";
import type { ToolScope } from "./tool-profiles.ts";

export type PluginRole = "definition" | "provider" | "consumer";

export type ToolBudgetFinalizerCall = Readonly<{
  tool: "ssh";
  op: "put";
}> | Readonly<{
  tool: "read";
  path: "work/current.json";
}>;

export type ManifestPlugin =
  | { readonly id: string; readonly path: string }
  | { readonly id: string; readonly package: string };

export interface PluginManifestFile {
  readonly plugins: readonly ManifestPlugin[];
}

export interface CapabilityClaim {
  key: string;
  role: PluginRole;
  /** Named route on a shared key such as ctx.llm. */
  route?: string;
  /** True when this changes the model-visible prefix (tools/system). */
  modelFacing?: boolean;
  /** Optional consumers rebind when the provider changes but do not wait for it. */
  optional?: boolean;
}

export type PluginDisposer = () => void | Promise<void>;
export type PluginFiberState = "pending" | "loading" | "active" | "unloading" | "disposed" | "failed";

export interface PluginModule {
  readonly id: string;
  readonly claims: readonly CapabilityClaim[];
  activate?(ctx: HostContext): PluginActivation | Promise<PluginActivation>;
  /**
   * The refusals registration would make, checked without a side effect
   * (#230 round 3, D1'): every boot's prepare phase calls it (a work session
   * and `dokkabi doctor` alike), and the commit phase calls it again right
   * before `register`. A throw here is the boot's refusal.
   */
  preflight?(ctx: HostContext): void | Promise<void>;
  register(ctx: HostContext): void | Promise<void>;
}

/** Thrown in a boot's prepare phase when a plugin reaches for something only
 * a committed boot has (a provider, a log append, an effect): the verdict is
 * then unknown, never a refusal. */
export class PrepareUnavailable extends Error {
  readonly name = "PrepareUnavailable";
  constructor(message: string, readonly pluginId?: string) {
    super(message);
  }
}

export type PreparedPluginVerdict =
  | { readonly verdict: "active" }
  | { readonly verdict: "skipped"; readonly kind: PluginSkipKind | "unclassified" }
  | { readonly verdict: "refused"; readonly stage: "activation" | "preflight" }
  | { readonly verdict: "unknown" };

export type BootStage = "manifest" | "import" | "claims" | "activation" | "preflight";

/** The prepare phase's verdict: what the commit phase will do. `cause` is
 * the boot's own refusal, as thrown. */
export type BootPreparation =
  | { readonly status: "admissible"; readonly plugins: ReadonlyMap<string, PreparedPluginVerdict> }
  | { readonly status: "refused"; readonly stage: BootStage; readonly pluginId?: string; readonly plugins: ReadonlyMap<string, PreparedPluginVerdict>; readonly cause?: unknown }
  | { readonly status: "unknown"; readonly pluginId?: string; readonly plugins: ReadonlyMap<string, PreparedPluginVerdict> };

/**
 * Why a plugin declined to activate, in the plugin's own words (#230). The
 * runtime records it as `skip_class` on `plugin/skip`; readers never infer it
 * from the reason text:
 * - `not_configured`: the operator has not turned it on (a disabled option);
 * - `invalid_configuration`: the operator's configuration for it is invalid;
 * - `unavailable`: this session or host cannot run it (a child, a missing
 *   dependency, a platform).
 * A skip without a kind is recorded `unclassified`.
 */
export type PluginSkipKind = "not_configured" | "invalid_configuration" | "unavailable";

export type PluginActivation =
  | { readonly active: true }
  | { readonly active: false; readonly reason: string; readonly kind?: PluginSkipKind };

export interface PluginSkill {
  readonly id: string;
  readonly pluginId: string;
  readonly description: string;
  readonly body: string;
  readonly digest: string;
}

export interface SkillRegistry {
  register(skill: PluginSkill): PluginDisposer;
  get(id: string): PluginSkill | undefined;
  list(): readonly PluginSkill[];
}

export interface ToolContributionRegistry<T = unknown> {
  register(pluginId: string, tool: T): PluginDisposer;
  list(): readonly T[];
}

export type ModelAuthStatus = "connected" | "missing" | "expired" | "unknown";

export interface GoalContextInput {
  readonly goalId: string;
  readonly statement: string;
  readonly project?: string;
}

export interface GoalContextBlock {
  readonly id: string;
  readonly text: string;
}

export type GoalContextContribution = (
  input: GoalContextInput,
) => { readonly text: string } | undefined | Promise<{ readonly text: string } | undefined>;

export interface GoalContextContributionRegistry {
  register(pluginId: string, contribution: GoalContextContribution): PluginDisposer;
  prepare(input: GoalContextInput): Promise<GoalContextBlock[]>;
}

/** #227 CG-04: where a provider request is being prepared. The same registry
 * runs at every one of them — the first request of an episode, the request
 * after a tool batch, a resume and a same-route retry. */
export type RequestContextBoundary = "initial" | "tool_batch" | "resume" | "retry" | "completion";

export interface RequestContextInput {
  readonly boundary: RequestContextBoundary;
  /** The durable transcript the next request carries, before any frame. */
  readonly messages: readonly unknown[];
  /** The tool profile the request is projected under. */
  readonly profile: string;
  readonly contextWindow?: number;
  readonly contextUsed?: number;
  /** §133 R2: whether THIS request's tools hold the result-source reader. */
  readonly readerAuthorised?: boolean;
}

/** What a contribution asks the host to do. The host — never the
 * contribution — stores the bytes and appends the rows. */
export type RequestContextDecision =
  | { readonly action: "none" }
  | { readonly action: "record"; readonly frameId: string; readonly payload: Record<string, unknown>; readonly text: string; readonly present: boolean }
  | { readonly action: "present"; readonly frameId: string };

export interface RequestContextContribution {
  /** Opt in to a bounded, same-episode checkpoint before normal completion. */
  readonly continueOnCompletion?: boolean;
  /** `shadow` records frames without changing the provider input. */
  readonly mode: "shadow" | "on";
  prepare(input: RequestContextInput): RequestContextDecision;
  /** Record a bounded, honest failure: the frame could not be stored, or a
   * guard refused it. The request then proceeds without it. */
  degraded?(reason: "frame_store_failed" | "frame_refused", boundary: string, detail: string, guard?: string | null): void;
  /** §132 F2': the frame that replaces the previous one when the full frame
   * was refused by `guard` (no items, the reason stated), or none. */
  refused?(input: RequestContextInput, guard: string): RequestContextDecision;
}

export interface RequestContextContributionRegistry {
  register(pluginId: string, contribution: RequestContextContribution): PluginDisposer;
  /** True when any contribution is registered: the loop then links tool
   * rows to their invocations and asks at every boundary. */
  active(): boolean;
  prepare(input: RequestContextInput): Array<{ readonly pluginId: string; readonly contribution: RequestContextContribution; readonly decision: RequestContextDecision }>;
}

/** Exclusive plugin resources released around an owned child process. */
export interface OwnedWorkResourceRegistry {
  register(pluginId: string, resource: {
    suspend(): Promise<void>;
    resume(): Promise<void>;
  }): PluginDisposer;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface WorkCheckpointInput {
  readonly events: readonly EventRecord[];
  readonly goalId: string;
  readonly reason: "todo_clear" | "goal_done";
  readonly todoId?: string;
}

export type WorkCheckpointContribution = (input: WorkCheckpointInput) => void | Promise<void>;

export interface WorkCheckpointContributionRegistry {
  register(pluginId: string, contribution: WorkCheckpointContribution): PluginDisposer;
  checkpoint(input: WorkCheckpointInput): Promise<void>;
}

/**
 * A typed body one work step hands the loop, or the loop hands a step (#77).
 * The SHAPE belongs to the contributing plugin; the registry owns only
 * validation ordering, byte caps, blob storage, and the recorded row. The
 * work loop names a `kind` string and never learns what is inside one —
 * there is no per-artifact-type branch in the loop (constitution 7).
 *
 * `validate` RETURNS the body instead of asserting: TypeScript refuses an
 * assertion call whose target root lacks an explicit annotation (TS2775),
 * and a Map lookup has none. The free `assert*` functions stay the
 * fail-closed truth; a contribution wraps one. Both members use METHOD
 * syntax so `ArtifactContribution<StepInputV1>` stays assignable to
 * `ArtifactContribution<unknown>` under strictFunctionTypes.
 */
export interface ArtifactContribution<T = unknown> {
  validate(value: unknown): T;
  digest(value: T): string;
}

export interface RecordedArtifact {
  readonly kind: string;
  readonly digest: string;
  /** Canonical JSON body, recorded under `payload.blob`. */
  readonly blob: string;
  readonly blobBytes: number;
  /** Raw evidence the typed body names only by digest, under
   * `payload.source_blob`. Absent when the artifact carries none. */
  readonly sourceBlob?: string;
}

export interface ArtifactRecordInput {
  readonly kind: string;
  readonly body: unknown;
  /** EventLog name this artifact is recorded on, e.g. `work/step_input`. */
  readonly name: string;
  /** Projectable scalars only. The host owns `artifact`, `digest`, `blob`,
   * `blob_bytes`, `source_blob` and `source_blob_bytes`. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Raw bytes the typed body names by digest — the unified diff behind a
   * patch artifact. It rides as `payload.source_blob` because the GC roots
   * ONLY `payload.blob` and `payload.source_blob`; any other field name is
   * deleted by `dokkabi blob-gc`. */
  readonly source?: string;
}

export interface ArtifactContributionRegistry {
  register<T>(kind: string, contribution: ArtifactContribution<T>): PluginDisposer;
  kinds(): readonly string[];
  /** Validate → digest → blob → append. Refused on a read-only log. */
  record(input: ArtifactRecordInput): RecordedArtifact;
  /** Read a recorded body back and re-validate it fail-closed. */
  read<T>(kind: string, blob: string): T;
}

/** Provider-neutral, manifest-ordered read-only context for swarm dispatch. */
export interface SwarmMemoryContributionRegistry {
  register(providerId: string, contribution: SwarmMemoryContributor): PluginDisposer;
  compile(input: SwarmMemoryCompileInput): Promise<SwarmMemoryViewV1>;
}

export interface LlmRoute {
  name: string;
  providerId: string;
  authKind: "oauth" | "plan_key";
  hasNetwork: boolean;
  /**
   * False when the provider's API never reports cached-token counts (vLLM
   * 0.27 leaves prompt_tokens_details null even with prefix caching on).
   * Unset means reported: a zero from such a provider is a real 0% hit,
   * while a zero from an unreporting one must surface as missing, not 0%.
   */
  reportsCacheUsage?: boolean;
  defaultModelId(): string | undefined;
  /** Trusted catalog classification; unknown is mandatory when absent. */
  modelCost?(modelId: string): ModelCost;
  resolveModel(modelId?: string): Promise<unknown>;
  ready(): Promise<{ ok: boolean; reason?: string }>;
  /** Public connection metadata only. Implementations may inspect protected
   * credentials, but must never return token, account, path, or endpoint data. */
  authStatus?(): Promise<ModelAuthStatus>;
  /** Reset provider-owned continuation state after durable context rewrite. */
  resetSession?(sessionId: string): void;
  /** Host-owned fixed credential probe, recorded separately from work input. */
  streamCredentialProbe?(model: unknown, timeoutMs: number): unknown;
  stream: (model: unknown, context: unknown, options?: unknown) => unknown;
  describe(): RouteStatus;
}

export interface RouteStatus {
  name: string;
  providerId: string;
  authKind: "oauth" | "plan_key";
  configured: boolean;
  reason?: string;
}

export interface LlmFacade {
  routes: Map<string, LlmRoute>;
  activeName: string;
  activeModelId?: string;
  active(): LlmRoute;
  select(name: string, modelId?: string): void;
  registerRoute(route: LlmRoute): PluginDisposer;
}

/** The budget state the loop reports through SessionBudget.observe before
 * every provider request of an episode. */
export interface SessionBudgetSnapshot {
  remaining_seconds: number;
  requests_used: number;
  requests_remaining?: number;
}

/** A session-scoped budget the LOOP enforces, because prompt() is a whole
 * agentic episode: a caller that checks its budget only when prompt()
 * returns never bounds a model that never stops. Before every provider
 * request of the episode the loop calls `observe` with the current state
 * (the caller appends its budget row there), and once the deadline has
 * passed or the request count is spent it ends the episode instead of
 * requesting again, recording loop/budget_exhausted {scope:"session"}. */
export interface SessionBudget {
  deadlineMs?: number;
  maxRequests?: number;
  /** Requests the caller already spent before this episode; the loop
   * continues the count from here (per provider request, the model/usage
   * row). */
  requestsSoFar?: number;
  /** Whether the model reads the budget in-band: the `[session budget: …]`
   * line the loop appends to every tool result. Default true, which is what
   * every caller had. A driver passes false to keep the model's band free of
   * budget state while the host still enforces the same limits — all three
   * studied harnesses hide it, and a model that reads a deadline on every
   * tool result paces against it instead of finishing. */
  stateLine?: boolean;
  observe?: (state: SessionBudgetSnapshot) => void;
}

export interface LoopFacade {
  implementation: "pi";
  prompt(
    text: string,
    options?: {
      modelId?: string;
      /** Called immediately after user/message is durable, before provider
       * work. Interactive transports spend their delivery copy here. */
      onAccepted?: () => void;
      /** Who this turn's text came from. Interactive transports pass
       * `operator`; every harness-driven turn leaves it at `harness`. The
       * board reads it to tell an intervention from a re-prompt. */
      origin?: "operator" | "harness";
      onAssistant?: (text: string) => void;
      thinkingLevel?: ThinkingLevel;
      thinkingBudgets?: ThinkingBudgets;
      /** Host producer metadata; never a provider generation option. */
      providerRole?: string;
      maxOutputTokens?: number;
      timeoutMs?: number;
      timeoutPolicy?: "fail" | "continue";
      /** Abort the request when no assistant delta arrives for this long
       * while no tool executes — the silent-stream stall watchdog. Absent
       * resolves the environment default; `0` disables it for this turn. */
      streamIdleMs?: number;
      /** Larger budget for the FIRST delta (queueing, prefill). */
      streamFirstDeltaMs?: number;
      /** Test seam: how long a stalled request that ignores abort() is
       * given before the turn is abandoned. Production uses the host grace. */
      stallGraceMs?: number;
      maxToolCalls?: number;
      toolBudgetFinalizers?: readonly string[];
      toolBudgetFinalizerCalls?: readonly ToolBudgetFinalizerCall[];
      toolScope?: ToolScope;
      recoveryOperation?: RecoveryOperation;
      sessionBudget?: SessionBudget;
    },
  ): Promise<void>;
  /** Continue a transcript whose durable suffix is user/toolResult without
   * appending another operator message. */
  resume?(options?: {
    modelId?: string;
    onAssistant?: (text: string) => void;
    thinkingLevel?: ThinkingLevel;
    toolScope?: ToolScope;
    recoveryOperation?: RecoveryOperation;
    sessionBudget?: SessionBudget;
  }): Promise<void>;
  /** Persist an idle transcript for a destination model before its route is
   * selected. A failure leaves the current live agent and route untouched. */
  handoff?(target: {
    route: string;
    model: string;
    contextWindow: number;
    /** Operator-named landing mode: carry keeps the full 75% budget even for
     * a large context; slim lands at 25% with the checkpoint summary. A bare
     * large switch refuses with carry_confirmation_required. */
    mode?: "carry" | "slim";
  }): ManualHandoffResult<unknown>;
  /** Background soft-threshold compaction; safe to call any time. */
  sweep(): { swept: boolean; reason?: string };
  /** Abort the in-flight model run without retry or failover. */
  abort(): void;
  /** Release the live agent after a model-visible plugin surface change. */
  invalidateSurface(): void;
  dispose(): void;
}

export interface HostContext {
  log: EventLog;
  sessionId: string;
  workspaceRoot: string;
  systemPrompt: string;
  toolSchemas: unknown[];
  readonly llm?: LlmFacade;
  readonly loop?: LoopFacade;
  effect(setup: () => void | PluginDisposer): void;
  define(key: string, definition: unknown): void;
  provide(key: string, provider: unknown, route?: string): void;
  inject<T>(key: string, route?: string): T;
  get<T>(key: string): T;
  tryGet<T>(key: string): T | undefined;
  markModelFacingChange(): void;
  /** `force` seals even when the prefix hash is unchanged — for a caller that
   * knows something the hash does not, such as a tool profile that changed
   * while the prefix stayed put. */
  sealIfNeeded(reason: "compaction" | "tools_changed" | "skill_set_changed", force?: boolean): void;
  requireSealedBeforeModel(): void;
}

export interface LoadResult {
  readonly digest: string;
  readonly loaded: readonly string[];
  readonly skipped: readonly string[];
  readonly runtime: PluginRuntime;
}

export interface PluginRuntime {
  disable(id: string, reason?: string): Promise<void>;
  enable(id: string, reason?: string): Promise<void>;
  state(id: string): PluginFiberState;
  states(): Readonly<Record<string, PluginFiberState>>;
  dispose(): Promise<void>;
}

/** Trusted host plugins enroll callbacks; candidate code never receives this registry. */
export type Evaluator = (request: import("../work/evidence/schema.ts").EvaluationRequestV2 & {
  readonly dispatch: import("../work/evidence/schema.ts").EvaluationDispatchV2;
}) => unknown | Promise<unknown>;
export type EvaluationRun =
  | { readonly status: "completed"; readonly input: import("../work/evidence/schema.ts").GateEvidenceInputV2;
      readonly receipt: import("../work/evidence/schema.ts").EvaluationReceiptV2;
      readonly decision: import("../work/evidence/schema.ts").EvidenceDecisionV2 }
  | { readonly status: "refused" | "unavailable"; readonly reason_code: string };
export interface EvaluationRegistry {
  register(descriptor: import("../work/evidence/schema.ts").EvaluatorDescriptorV2, evaluator: Evaluator): PluginDisposer;
  list(): readonly import("../work/evidence/schema.ts").EvaluatorDescriptorV2[];
  dispatch(request: unknown): Promise<EvaluationRun>;
  /** Host-only immutable expectations; shares enrollment and receipt authority with dispatch. */
  dispatchForContext(request: unknown, context: import("../work/evidence/schema.ts").EvaluationContextV2): Promise<EvaluationRun>;
  dispose(): void;
}
export interface EvaluationContextSource { current(): import("../work/evidence/schema.ts").EvaluationContextV2; }
export interface WorkEvidence {
  evaluate(request: unknown): Promise<EvaluationRun>;
  projectEvidence: typeof import("../work/evidence/projection.ts").projectEvidence;
}

/** Protected measurements are host services, never model-authored evaluator results. */
export interface WorkMeasurementInput {
  readonly plan: import("../work/schema.ts").WorkPlan;
  readonly caseId: string;
  readonly cwd: string;
  readonly phase: "red" | "green";
}
export type WorkMeasurementRun =
  | { readonly status: "completed";
      readonly evaluation: Extract<EvaluationRun, { status: "completed" }>;
      readonly measurement_ref: import("zod").infer<typeof import("../work/evidence/schema.ts").artifactRefSchema>;
      readonly session_id: string;
      readonly decision: import("../work/evidence/measurement-projection.ts").MeasurementDecision }
  | { readonly status: "unavailable" | "evaluator_error"; readonly reason_code: string };
export interface WorkMeasurements {
  evaluateCase(input: WorkMeasurementInput): Promise<WorkMeasurementRun>;
}
