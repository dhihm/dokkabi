import { DurableRecoveryService, isRecoveryTerminalError, type RecoveryOperation } from "../host/recovery.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import {
  readFailoverPolicyV1,
  writeFailoverPolicyV1,
} from "../host/config.ts";
import {
  failoverPolicyDigest,
  modelFailureTrigger,
  normalizeFailoverPolicyV1,
  normalizeModelFailureV1,
  policyAllowsFailure,
  selectFailoverCandidatesV1,
  selectionKey,
  type FailoverCandidatePolicyV1,
  type FailoverCandidateStatusV1,
  type FailoverPolicyV1,
  type ModelRouteSelection,
  type NormalizedModelFailureV1,
} from "../host/model-failover.ts";
import { ModelFailoverSession, type FailoverSessionSnapshot } from "../host/model-failover-session.ts";
import {
  formatModelResilienceStatus,
  type ModelResilienceCandidateViewV1,
  type ModelResilienceViewV1,
} from "../host/model-resilience-view.ts";
import {
  QuotaProbeRegistry,
  QuotaTracker,
  quotaSnapshotFromRpc,
  readCodexQuota,
  type QuotaFreshnessV1,
  type QuotaSelection,
} from "../host/quota.ts";
import type { ModelQuotaSnapshotV1 } from "../host/schema.ts";
import type { CapabilityClaim, HostContext, LlmFacade, LlmRoute, ModelAuthStatus, PluginModule } from "../loader/types.ts";
import type { RemoteStatusRegistry } from "../remote/types.ts";

export interface ModelLimitStatus extends QuotaSelection {
  connected: boolean;
  auth: "connected" | "missing" | "expired" | "unknown";
  cost: "free" | "paid" | "subscription" | "unknown";
  freshness: QuotaFreshnessV1;
  snapshot?: ModelQuotaSnapshotV1;
}

export interface FailoverNextOptions {
  resumable?: boolean;
  turnId?: string;
  now?: number;
  status?: number;
  retryAfterSeconds?: number;
  recoveryOperation?: RecoveryOperation;
}

export interface PendingRouteTransitionV1 {
  target: ModelRouteSelection;
  policyDigest: string;
  continuity: "continue" | "checkpoint";
  generation: number;
}

export interface ModelResilienceService {
  readonly recovery: DurableRecoveryService;
  refresh(selection: QuotaSelection, options?: { force?: boolean }): Promise<ModelQuotaSnapshotV1 | undefined>;
  limits(selections: readonly QuotaSelection[], options?: { force?: boolean }): Promise<ModelLimitStatus[]>;
  policy(): Promise<FailoverPolicyV1>;
  configure(command: string): Promise<string>;
  next(
    current: ModelRouteSelection,
    error: unknown,
    excluded?: ReadonlySet<string>,
    options?: FailoverNextOptions,
  ): Promise<ModelRouteSelection | undefined>;
  pendingTransition(): PendingRouteTransitionV1 | undefined;
  activateTransition(target: ModelRouteSelection, transitionDigest: string): void;
  failTransition(target: ModelRouteSelection, transitionDigest: string, reasonCode: string): void;
  setInteractiveApproval(enabled: boolean): void;
  setManualPrimary(selection: ModelRouteSelection): void;
  session(): FailoverSessionSnapshot;
  view(): Promise<ModelResilienceViewV1>;
  dispose(): void;
}

interface PendingApproval {
  candidates: FailoverCandidateStatusV1[];
  policyDigest: string;
  generation: number;
  current: ModelRouteSelection;
  resolve: (candidate: FailoverCandidateStatusV1 | undefined) => void;
}

export class FailoverApprovalRequiredError extends Error {
  constructor(
    readonly candidates: readonly FailoverCandidateStatusV1[],
    readonly continuity: "continue" | "checkpoint" = "checkpoint",
  ) {
    const choices = candidates.map((candidate) => {
      const remaining = typeof candidate.quota?.remainingPercent === "number"
        ? `${candidate.quota.remainingPercent}% remaining`
        : "quota unknown";
      const auth = candidate.auth ?? (candidate.connected ? "connected" : "missing");
      const freshness = candidate.quota?.freshness ??
        (candidate.quota?.confidence === "authoritative" ? "fresh" : "unknown");
      return `${candidateName(candidate)} auth=${auth} cost=${candidate.cost} quota=${freshness}:${remaining} continuity=${continuity}`;
    });
    super(`model failover approval required (${continuity} context): ${choices.join(", ")}`);
    this.name = "FailoverApprovalRequiredError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function candidateName(candidate: ModelRouteSelection): string {
  return `${candidate.route}/${candidate.model}`;
}

function splitCandidate(value: string): ModelRouteSelection {
  const slash = value.indexOf("/");
  const route = slash < 1 ? "" : value.slice(0, slash);
  const model = slash < 1 ? "" : value.slice(slash + 1);
  if (!route || !model) throw new Error(`invalid failover candidate ${value}; expected route/model`);
  return { route, model };
}

export function createModelResilience(
  ctx: HostContext,
  llm: LlmFacade,
  quotas = new QuotaProbeRegistry(),
): ModelResilienceService {
  const tracker = new QuotaTracker(quotas);
  const initialRoute = llm.active();
  const initial = {
    route: llm.activeName,
    model: llm.activeModelId ?? initialRoute.defaultModelId() ?? "missing",
  };
  const runtime = new ModelFailoverSession(initial);
  const loggedQuota = new Map<string, string>();
  let interactiveApproval = false;
  let pending: PendingApproval | undefined;
  let transition: PendingRouteTransitionV1 | undefined;
  let recordedPolicyDigest: string | undefined;

  const initialPolicy = readFailoverPolicyV1();
  // Bind the exact policy before any failure, decision, transition, quota
  // probe, or provider request can refer to it. This is deliberately an
  // effect even for the default `off` policy: replay must be able to prove
  // that zero fallback calls were the result of a sealed policy, not an
  // absent implementation.
  recordPolicy(initialPolicy);

  const removeCodex = quotas.register({
    id: "openai-codex-rate-limits",
    supports: (selection) => selection.provider === "openai-codex",
    async read(selection) {
      const rpc = await readCodexQuota(process.env.DOKKABI_CODEX_BIN ?? "codex");
      return rpc ? quotaSnapshotFromRpc(rpc, selection) : undefined;
    },
  });

  async function candidateStatus(
    selection: ModelRouteSelection,
    refreshQuota = false,
    operation?: RecoveryOperation,
  ): Promise<FailoverCandidateStatusV1> {
    const route = llm.routes.get(selection.route);
    if (!route || selection.route === "replay") throw new Error(`unknown live route ${selection.route}`);
    let grant;
    if (operation) { await recovery.wait(operation); grant = recovery.reserve(operation); }
    let auth: ModelAuthStatus;
    try {
      await route.resolveModel(selection.model);
      auth = await modelRouteAuthStatus(route);
    } finally {
      if (operation && grant) recovery.result(operation, grant, { tokens: 0, cost: 0 });
    }
    const connected = auth === "connected";
    const quotaSelection = { route: route.name, provider: route.providerId, model: selection.model };
    if (refreshQuota) await service.refresh(quotaSelection);
    const quota = tracker.peek(quotaSelection);
    const remaining = quota.snapshot?.windows
      .filter((window) => window.confidence === "authoritative" && typeof window.remaining_percent === "number")
      .map((window) => Number(window.remaining_percent));
    return {
      ...selection,
      cost: route.modelCost?.(selection.model) ?? "unknown",
      connected,
      auth,
      quota: {
        confidence: quota.freshness === "fresh" && remaining && remaining.length > 0 ? "authoritative" : "unknown",
        freshness: quota.freshness,
        remainingPercent: remaining && remaining.length > 0 ? Math.min(...remaining) : "missing",
        ...(quota.snapshot ? { snapshotDigest: digest(quota.snapshot) } : {}),
      },
    };
  }

  function policyText(policy: FailoverPolicyV1): string {
    const candidates = policy.candidates.map((item) =>
      `${candidateName(item)}:${item.allowedCost}${item.reservePercent === undefined ? "" : ` reserve>${item.reservePercent}%`}`
    );
    return [
      `failover=${policy.mode}`,
      `selector=${policy.selector}`,
      `cost=${policy.costPolicy}`,
      `continuity=${policy.continuity}`,
      `recovery=${policy.recovery}`,
      `max=${policy.maxTransitionsPerTurn}`,
      `cooldown=${policy.cooldownSeconds}s`,
      `triggers=${policy.triggers.join(",") || "none"}`,
      `candidates=${candidates.join(",") || "none"}`,
    ].join(" ");
  }

  function approve(choice?: string): string {
    if (!pending) throw new Error("no model failover approval is waiting");
    const waiting = pending;
    const currentPolicyDigest = failoverPolicyDigest(readFailoverPolicyV1());
    const session = runtime.snapshot();
    if (
      currentPolicyDigest !== waiting.policyDigest
      || session.generation !== waiting.generation
      || session.state !== "AWAITING_OPERATOR"
      || selectionKey(session.active) !== selectionKey(waiting.current)
    ) {
      pending = undefined;
      waiting.resolve(undefined);
      throw new Error("model failover approval expired; review the current policy and active model");
    }
    const selected = choice
      ? waiting.candidates.find((item) => candidateName(item) === choice)
      : waiting.candidates[0];
    if (!selected) throw new Error("choose one of the pending failover candidates");
    pending = undefined;
    waiting.resolve(selected);
    return `approved model failover to ${candidateName(selected)}`;
  }

  function reject(): string {
    if (!pending) throw new Error("no model failover approval is waiting");
    const waiting = pending;
    pending = undefined;
    waiting.resolve(undefined);
    runtime.reject();
    return "rejected model failover; the active turn remains on its original failure";
  }

  function recordPolicy(policy: FailoverPolicyV1): void {
    const policyDigest = failoverPolicyDigest(policy);
    invalidatePendingApproval();
    transition = undefined;
    const before = runtime.snapshot();
    const nextState = policy.mode === "off"
      ? "DISABLED"
      : selectionKey(before.active) === selectionKey(before.primary)
        ? "ARMED"
        : "FALLBACK_ACTIVE";
    ctx.log.append({
      kind: "effect",
      name: "model/failover_policy",
      payload: {
        policy,
        mode: policy.mode,
        continuity: policy.continuity,
        policy_digest: policyDigest,
        candidate_count: policy.candidates.length,
        primary: before.primary,
        active: before.active,
        next_state: nextState,
      },
    });
    recordedPolicyDigest = policyDigest;
    if (policy.mode === "off") runtime.disable();
    else runtime.arm(policyDigest);
  }

  async function policyCandidates(policy: FailoverPolicyV1, operation?: RecoveryOperation): Promise<FailoverCandidateStatusV1[]> {
    const refreshQuota = policy.selector === "most_remaining"
      || policy.candidates.some((candidate) => candidate.reservePercent !== undefined);
    const candidates: FailoverCandidateStatusV1[] = [];
    for (const selection of policy.candidates) {
      try {
        candidates.push(await candidateStatus(selection, refreshQuota, operation));
      } catch (error) {
        if (isRecoveryTerminalError(error)) throw error;
        // Exact stale ids remain configured but never expand to another model.
      }
    }
    return candidates;
  }

  const recovery = new DurableRecoveryService(ctx.log);
  const service: ModelResilienceService = {
    recovery,
    async refresh(selection, options = {}) {
      const before = tracker.peek(selection);
      if (!options.force && before.freshness === "fresh") return before.snapshot;
      const request = {
        probe_id: quotas.probeId(selection) ?? "unavailable",
        selection_digest: digest(selection),
        cache_policy: options.force ? "refresh" : "on_use",
      };
      ctx.log.append({ kind: "effect", name: "model/quota_probe", payload: request });
      const status = await tracker.refresh(selection, options);
      if (!status.snapshot) {
        ctx.log.append({
          kind: "observe",
          name: "model/quota_probe_result",
          payload: {
            selection_digest: request.selection_digest,
            freshness: status.freshness,
            status: "unknown",
          },
        });
        return undefined;
      }
      const snapshotDigest = digest(status.snapshot);
      ctx.log.append({
        kind: "observe",
        name: "model/quota_probe_result",
        payload: {
          selection_digest: request.selection_digest,
          freshness: status.freshness,
          status: "known",
          snapshot_digest: snapshotDigest,
        },
      });
      const key = candidateName(selection);
      const loggedState = `${snapshotDigest}:${status.freshness}`;
      if (loggedQuota.get(key) !== loggedState) {
        loggedQuota.set(key, loggedState);
        ctx.log.append({
          kind: "observe",
          name: "model/quota",
          payload: {
            provider: status.snapshot.provider,
            route: status.snapshot.route,
            model: status.snapshot.model,
            bucket: status.snapshot.bucketDigest,
            freshness: status.freshness,
            snapshot_digest: snapshotDigest,
          },
          observe: { model_quota_snapshot: status.snapshot },
        });
      }
      return status.snapshot;
    },

    async limits(selections, options = {}) {
      const out: ModelLimitStatus[] = [];
      for (const selection of selections) {
        const route = llm.routes.get(selection.route);
        if (!route || selection.route === "replay") continue;
        const auth = await modelRouteAuthStatus(route);
        const connected = auth === "connected";
        const snapshot = connected ? await service.refresh(selection, options) : undefined;
        const tracked = tracker.peek(selection);
        out.push({
          ...selection,
          connected,
          auth,
          cost: route.modelCost?.(selection.model) ?? "unknown",
          freshness: snapshot ? tracked.freshness : "unknown",
          ...(snapshot ? { snapshot } : {}),
        });
      }
      return out;
    },

    async policy() {
      return readFailoverPolicyV1();
    },

    async configure(command) {
      const trimmed = command.trim();
      if (trimmed === "" || trimmed === "status") return `${policyText(readFailoverPolicyV1())} ${formatModelResilienceStatus(await service.view())}`;
      const firstSpace = trimmed.indexOf(" ");
      const verb = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const tail = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
      if (verb === "approve") return approve(tail || undefined);
      if (verb === "reject") return reject();
      if (verb === "configure") {
        if (!tail) return `policy=${canonicalJson(readFailoverPolicyV1())}`;
        const policy = normalizeFailoverPolicyV1(JSON.parse(tail));
        writeFailoverPolicyV1(policy);
        recordPolicy(policy);
        return policyText(policy);
      }
      const saved = readFailoverPolicyV1();
      if (verb === "off") {
        const policy = writeFailoverPolicyV1({ ...saved, mode: "off" });
        recordPolicy(policy);
        return policyText(policy);
      }
      const mode = verb === "on" ? "auto" : verb;
      if (mode !== "ask" && mode !== "auto") {
        throw new Error("usage: /failover [status|off|on|ask|auto|approve|reject|configure] ...");
      }
      const words = tail.split(/\s+/).filter(Boolean);
      let costPolicy = saved.costPolicy;
      let selector = saved.selector;
      let continuity = saved.continuity;
      let recovery = saved.recovery;
      let maxTransitionsPerTurn = saved.maxTransitionsPerTurn;
      let cooldownSeconds = saved.cooldownSeconds;
      let triggers = saved.triggers;
      const candidateWords: string[] = [];
      for (const word of words) {
        if (word === "free-only") costPolicy = "free_only";
        else if (word.startsWith("selector=")) selector = word.slice(9) as typeof selector;
        else if (word.startsWith("continuity=")) continuity = word.slice(11) as typeof continuity;
        else if (word.startsWith("recovery=")) recovery = word.slice(9) as typeof recovery;
        else if (word.startsWith("cost=")) costPolicy = word.slice(5) as typeof costPolicy;
        else if (word.startsWith("max=")) maxTransitionsPerTurn = Number(word.slice(4));
        else if (word.startsWith("cooldown=")) cooldownSeconds = Number(word.slice(9));
        else if (word.startsWith("triggers=")) triggers = word.slice(9).split(",") as typeof triggers;
        else candidateWords.push(word);
      }
      let candidates: FailoverCandidatePolicyV1[];
      if (candidateWords.length === 0) {
        candidates = saved.candidates;
      } else {
        candidates = [];
        for (const word of candidateWords) {
          const selection = splitCandidate(word);
          const status = await candidateStatus(selection);
          if (status.cost === "unknown") {
            throw new Error(`cost is unknown for ${word}; use /failover configure with an explicit allowedCost`);
          }
          candidates.push({ ...selection, allowedCost: status.cost });
        }
      }
      const policy = normalizeFailoverPolicyV1({
        format: 1,
        mode,
        triggers,
        candidates,
        selector,
        costPolicy,
        continuity,
        recovery,
        maxTransitionsPerTurn,
        cooldownSeconds,
      });
      writeFailoverPolicyV1(policy);
      recordPolicy(policy);
      return policyText(policy);
    },

    async next(current, error, excluded = new Set(), options = {}) {
      const now = options.now ?? Date.now();
      const policy = readFailoverPolicyV1();
      const policyDigest = failoverPolicyDigest(policy);
      if (recordedPolicyDigest !== policyDigest) recordPolicy(policy);
      const failure = normalizeModelFailureV1({
        error,
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: options.retryAfterSeconds }),
        retriesExhausted: true,
      });
      const failureFact = {
        class: failure.class,
        reason_code: failure.reasonCode,
        retries_exhausted: failure.retriesExhausted === true,
        ...(failure.retryAfterSeconds === undefined ? {} : { retry_after_seconds: failure.retryAfterSeconds }),
        // The unclassified fallthrough keeps a bounded, redacted hint — the
        // one case where the message IS the diagnosis (model-failover.ts).
        ...(failure.detailHint === undefined ? {} : { detail: failure.detailHint }),
        route: current.route,
        model: current.model,
      };
      ctx.log.append({
        kind: "observe",
        name: "model/failure",
        payload: { ...failureFact, failure_digest: digest(failureFact) },
      });

      const turnId = options.turnId ?? String([...ctx.log.events].reverse().find((event) => event.name === "user/message")?.seq ?? 0);
      if (policy.mode === "off") {
        runtime.disable();
        recordDecision("stop", "disabled", current, failure, policy, policyDigest, []);
        return undefined; // Do not resolve or ready() any configured candidate.
      }
      runtime.arm(policyDigest);
      runtime.beginTurn(turnId);
      runtime.degrade(failure);
      if (!policyAllowsFailure(policy, failure)) {
        runtime.pause(modelFailureTrigger(failure) ? "trigger_not_enabled" : "failure_not_eligible");
        recordDecision("stop", runtime.snapshot().pauseReason ?? "failure_not_eligible", current, failure, policy, policyDigest, []);
        return undefined;
      }
      if (options.resumable === false) {
        runtime.pause("context_not_resumable");
        recordDecision("stop", "context_not_resumable", current, failure, policy, policyDigest, []);
        return undefined;
      }
      const available = await policyCandidates(policy, options.recoveryOperation);
      const selected = selectFailoverCandidatesV1(policy, available, current, excluded)
        .filter((candidate) => runtime.canTransitionTo(candidate, policy, now).ok);
      if (selected.length === 0) {
        const reasons = available.map((candidate) => runtime.canTransitionTo(candidate, policy, now)).filter((item) => !item.ok);
        const reason = reasons[0]?.reason ?? "no_candidate";
        runtime.pause(reason);
        recordDecision("stop", reason, current, failure, policy, policyDigest, []);
        return undefined;
      }
      let target: FailoverCandidateStatusV1 | undefined;
      if (policy.mode === "ask") {
        runtime.awaitOperator(selected);
        recordDecision("ask", "operator_approval_required", current, failure, policy, policyDigest, selected);
        if (!interactiveApproval) throw new FailoverApprovalRequiredError(selected, policy.continuity);
        if (pending) throw new Error("a model failover approval is already waiting");
        const waitingGeneration = runtime.snapshot().generation;
        target = await new Promise<FailoverCandidateStatusV1 | undefined>((resolve) => {
          pending = {
            candidates: selected,
            policyDigest,
            generation: waitingGeneration,
            current: { ...current },
            resolve,
          };
        });
        if (!target) return undefined;
        const currentPolicy = readFailoverPolicyV1();
        const currentPolicyDigest = failoverPolicyDigest(currentPolicy);
        const approvalSession = runtime.snapshot();
        if (
          currentPolicyDigest !== policyDigest
          || approvalSession.generation !== waitingGeneration
          || selectionKey(approvalSession.active) !== selectionKey(current)
        ) {
          if (recordedPolicyDigest !== currentPolicyDigest) recordPolicy(currentPolicy);
          recordDecision(
            "stop",
            "approval_invalidated",
            approvalSession.active,
            failure,
            currentPolicy,
            currentPolicyDigest,
            [],
          );
          return undefined;
        }
        const refreshed = selectFailoverCandidatesV1(
          currentPolicy,
          await policyCandidates(currentPolicy, options.recoveryOperation),
          current,
          excluded,
        );
        const approved = refreshed.find((candidate) => selectionKey(candidate) === selectionKey(target!));
        if (!approved) {
          runtime.pause("approved_candidate_ineligible");
          recordDecision("stop", "approved_candidate_ineligible", current, failure, currentPolicy, currentPolicyDigest, []);
          return undefined;
        }
        target = approved;
        const recheck = runtime.canTransitionTo(target, policy, Date.now());
        if (!recheck.ok) {
          runtime.pause(recheck.reason);
          recordDecision("stop", recheck.reason, current, failure, policy, policyDigest, []);
          return undefined;
        }
        recordDecision("switch", "operator_approved", current, failure, policy, policyDigest, [target]);
      } else {
        target = selected[0];
        if (target) recordDecision("switch", "policy_selected", current, failure, policy, policyDigest, [target]);
      }
      if (!target) {
        runtime.pause("no_candidate");
        recordDecision("stop", "no_candidate", current, failure, policy, policyDigest, []);
        return undefined;
      }
      runtime.beginTransition(target, policyDigest, now);
      transition = {
        target: { route: target.route, model: target.model },
        policyDigest,
        continuity: policy.continuity,
        generation: runtime.snapshot().generation,
      };
      return transition.target;
    },

    pendingTransition() {
      return transition ? { ...transition, target: { ...transition.target } } : undefined;
    },

    activateTransition(target, transitionDigest) {
      runtime.activate(target, Date.now());
      const session = runtime.snapshot();
      const result = {
        status: "active",
        active: target,
        transition_digest: transitionDigest,
        generation: session.generation,
        state: session.state,
        primary: session.primary,
      };
      ctx.log.append({
        kind: "observe",
        name: "model/route_transition_result",
        payload: { ...result, transition_result_digest: digest(result) },
      });
      transition = undefined;
    },

    failTransition(target, transitionDigest, reasonCode) {
      runtime.failTransition(target, reasonCode, Date.now());
      const session = runtime.snapshot();
      const result = {
        status: "failed",
        target,
        reason_code: reasonCode,
        transition_digest: transitionDigest,
        generation: session.generation,
        state: session.state,
        primary: session.primary,
        active: session.active,
      };
      ctx.log.append({
        kind: "observe",
        name: "model/route_transition_result",
        payload: { ...result, transition_result_digest: digest(result) },
      });
      transition = undefined;
    },

    setInteractiveApproval(enabled) {
      interactiveApproval = enabled;
    },

    setManualPrimary(selection) {
      invalidatePendingApproval();
      transition = undefined;
      runtime.setManualPrimary(selection);
      const session = runtime.snapshot();
      const fact = {
        selection,
        primary: session.primary,
        active: session.active,
        state: session.state,
        generation: session.generation,
      };
      ctx.log.append({ kind: "effect", name: "model/primary_selection", payload: { ...fact, selection_digest: digest(fact) } });
    },

    session() {
      return runtime.snapshot();
    },

    async view() {
      const policy = readFailoverPolicyV1();
      const snapshot = runtime.snapshot();
      const selections = new Map<string, ModelRouteSelection>();
      for (const selection of [snapshot.primary, snapshot.active, ...policy.candidates]) {
        selections.set(selectionKey(selection), { route: selection.route, model: selection.model });
      }
      const candidates: ModelResilienceCandidateViewV1[] = [];
      for (const selection of selections.values()) {
        const route = llm.routes.get(selection.route);
        if (!route) continue;
        let status: FailoverCandidateStatusV1;
        try {
          status = await candidateStatus(selection, false);
        } catch {
          status = { ...selection, connected: false, cost: "unknown" };
        }
        const quota = tracker.peek({ route: route.name, provider: route.providerId, model: selection.model });
        const windows = quota.snapshot?.windows.map((window) => {
          const remaining = typeof window.remaining_percent === "number"
            ? `${window.remaining_percent}% remaining`
            : typeof window.remaining === "number"
              ? `remaining=${window.remaining}`
              : "remaining unknown";
          return `${window.id}:${remaining}`;
        }) ?? [];
        const key = selectionKey(selection);
        candidates.push({
          ...selection,
          auth: status.auth ?? (status.connected ? "connected" : "missing"),
          cost: status.cost,
          eligibility: key === selectionKey(snapshot.active)
            ? "active"
            : key === selectionKey(snapshot.primary)
              ? "primary"
              : selectFailoverCandidatesV1(policy, [status], snapshot.active).length > 0
                ? "eligible"
                : "ineligible",
          quota: { freshness: quota.freshness, windows },
        });
      }
      return {
        recovery: recovery.episodes(),
        mode: policy.mode,
        state: snapshot.state,
        primary: snapshot.primary,
        active: snapshot.active,
        continuity: policy.continuity,
        ...(snapshot.lastTransition
          ? { lastTransition: `${candidateName(snapshot.lastTransition.from)} -> ${candidateName(snapshot.lastTransition.to)} (${snapshot.lastTransition.status})` }
          : {}),
        candidates,
      };
    },

    dispose() {
      removeCodex();
      invalidatePendingApproval();
      transition = undefined;
    },
  };

  function recordDecision(
    action: "stop" | "ask" | "switch",
    reason: string,
    current: ModelRouteSelection,
    failure: NormalizedModelFailureV1,
    policy: FailoverPolicyV1,
    policyDigest: string,
    candidates: readonly FailoverCandidateStatusV1[],
  ): void {
    const session = runtime.snapshot();
    const base = {
      action,
      reason,
      mode: policy.mode,
      continuity: policy.continuity,
      state: session.state,
      primary: session.primary,
      active: session.active,
      current,
      failure_class: failure.class,
      policy_digest: policyDigest,
      candidate_digests: candidates.map((candidate) => digest({
        route: candidate.route,
        model: candidate.model,
        connected: candidate.connected,
        cost: candidate.cost,
        quota: candidate.quota ?? { confidence: "unknown", remainingPercent: "missing" },
      })),
      candidate_summaries: candidates.map((candidate) => ({
        route: candidate.route,
        model: candidate.model,
        auth: candidate.auth ?? (candidate.connected ? "connected" : "missing"),
        cost: candidate.cost,
        quota_freshness: candidate.quota?.freshness ??
          (candidate.quota?.confidence === "authoritative" ? "fresh" : "unknown"),
        quota_remaining_percent: typeof candidate.quota?.remainingPercent === "number"
          ? candidate.quota.remainingPercent
          : "missing",
        ...(candidate.quota?.snapshotDigest
          ? { quota_snapshot_digest: candidate.quota.snapshotDigest }
          : {}),
      })),
      ...(action === "ask" ? { candidates: candidates.map(candidateName) } : {}),
      ...(candidates[0]
        ? {
            target: { route: candidates[0].route, model: candidates[0].model },
            target_cost: candidates[0].cost,
            quota_freshness: candidates[0].quota?.freshness ??
              (candidates[0].quota?.confidence === "authoritative" ? "fresh" : "unknown"),
          }
        : {}),
    };
    ctx.log.append({
      kind: "observe",
      name: "model/failover",
      payload: { ...base, decision_digest: digest(base) },
    });
  }

  return service;

  function invalidatePendingApproval(): void {
    if (!pending) return;
    const waiting = pending;
    pending = undefined;
    waiting.resolve(undefined);
  }
}

export async function modelRouteAuthStatus(
  route: Pick<LlmRoute, "ready" | "authStatus">,
): Promise<ModelAuthStatus> {
  if (route.authStatus) {
    try {
      return await route.authStatus();
    } catch {
      return "unknown";
    }
  }
  try {
    return (await route.ready()).ok ? "connected" : "missing";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "oauth" ? "expired" : "unknown";
  }
}

const claims: CapabilityClaim[] = [
  { key: "model_quotas", role: "definition" },
  { key: "model_quotas", role: "provider" },
  { key: "model_resilience", role: "definition" },
  { key: "model_resilience", role: "provider" },
  { key: "llm", role: "consumer" },
  { key: "remote_status", role: "consumer", optional: true },
];

export const plugin: PluginModule = {
  id: "model-resilience",
  claims,
  register(ctx) {
    ctx.define("model_quotas", { version: 1 });
    ctx.define("model_resilience", { version: 1 });
    const quotas = new QuotaProbeRegistry();
    ctx.provide("model_quotas", quotas);
    const service = createModelResilience(ctx, ctx.inject<LlmFacade>("llm"), quotas);
    ctx.provide("model_resilience", service);
    const remoteStatus = ctx.tryGet<RemoteStatusRegistry>("remote_status");
    if (remoteStatus) {
      ctx.effect(() => remoteStatus.register(
        "model-resilience",
        async () => formatModelResilienceStatus(await service.view(), { compact: true }),
      ));
    }
    ctx.effect(() => () => service.dispose());
  },
};
