import type {
  FailoverPolicyV1,
  ModelRouteSelection,
  NormalizedModelFailureV1,
} from "./model-failover.ts";
import { selectionKey } from "./model-failover.ts";

export type FailoverSessionPhase =
  | "DISABLED"
  | "ARMED"
  | "DEGRADED"
  | "AWAITING_OPERATOR"
  | "SWITCHING"
  | "FALLBACK_ACTIVE"
  | "PAUSED";

export interface FailoverSessionSnapshot {
  state: FailoverSessionPhase;
  primary: ModelRouteSelection;
  active: ModelRouteSelection;
  policyDigest?: string;
  failure?: NormalizedModelFailureV1;
  pendingCandidates: ModelRouteSelection[];
  transitionCount: number;
  generation: number;
  pauseReason?: string;
  lastTransition?: {
    from: ModelRouteSelection;
    to: ModelRouteSelection;
    at: number;
    status: "active" | "failed";
    reason?: string;
  };
}

/** Session-local transition owner. Persisted model configuration remains
 * outside this class; an automatic switch can therefore never overwrite it.
 * `visited` spans user turns and is cleared only by an explicit manual primary
 * selection (or a new session object), preventing automatic failback/ping-pong. */
export class ModelFailoverSession {
  #phase: FailoverSessionPhase = "DISABLED";
  #primary: ModelRouteSelection;
  #active: ModelRouteSelection;
  #policyDigest?: string;
  #failure?: NormalizedModelFailureV1;
  #pendingCandidates: ModelRouteSelection[] = [];
  #transitionCount = 0;
  #turnId?: string;
  #generation = 0;
  #pauseReason?: string;
  #lastTransition?: FailoverSessionSnapshot["lastTransition"];
  readonly #visited = new Set<string>();
  /**
   * Selections left because the LINK dropped, not because the route was at
   * fault. They stay eligible.
   *
   * `#visited` burns a selection for the rest of the run, and returning to the
   * primary is refused outright. That is right for a durable fault — an
   * exhausted quota or a model that is gone does not heal by being asked
   * twice. A transport failure says nothing about the route at all: on a
   * link-inspected network the socket is closed by a middlebox, and the route
   * it was carrying is as healthy as it ever was. Burning those, one run went
   * primary → fallback in twenty minutes, met the same dropped link, had
   * nowhere left to go, and stopped with `automatic_failback_forbidden` while
   * both of its routes were fine. The policy's own cooldown is what keeps this
   * from flapping.
   */
  readonly #transportOnly = new Set<string>();

  constructor(primary: ModelRouteSelection) {
    this.#primary = copySelection(primary);
    this.#active = copySelection(primary);
  }

  snapshot(): FailoverSessionSnapshot {
    return {
      state: this.#phase,
      primary: copySelection(this.#primary),
      active: copySelection(this.#active),
      ...(this.#policyDigest ? { policyDigest: this.#policyDigest } : {}),
      ...(this.#failure ? { failure: { ...this.#failure } } : {}),
      pendingCandidates: this.#pendingCandidates.map(copySelection),
      transitionCount: this.#transitionCount,
      generation: this.#generation,
      ...(this.#pauseReason ? { pauseReason: this.#pauseReason } : {}),
      ...(this.#lastTransition
        ? {
            lastTransition: {
              ...this.#lastTransition,
              from: copySelection(this.#lastTransition.from),
              to: copySelection(this.#lastTransition.to),
            },
          }
        : {}),
    };
  }

  disable(): void {
    this.#phase = "DISABLED";
    this.#policyDigest = undefined;
    this.#failure = undefined;
    this.#pendingCandidates = [];
    this.#pauseReason = undefined;
  }

  arm(policyDigest: string): void {
    this.#policyDigest = policyDigest;
    this.#phase = selectionKey(this.#active) === selectionKey(this.#primary) ? "ARMED" : "FALLBACK_ACTIVE";
    this.#pauseReason = undefined;
  }

  beginTurn(turnId: string): void {
    if (turnId !== this.#turnId) {
      this.#turnId = turnId;
      this.#transitionCount = 0;
    }
    this.#failure = undefined;
    this.#pendingCandidates = [];
    this.#pauseReason = undefined;
    if (this.#phase !== "DISABLED") {
      this.#phase = selectionKey(this.#active) === selectionKey(this.#primary) ? "ARMED" : "FALLBACK_ACTIVE";
    }
  }

  degrade(failure: NormalizedModelFailureV1): void {
    this.#failure = { ...failure };
    this.#pendingCandidates = [];
    this.#phase = "DEGRADED";
  }

  awaitOperator(candidates: readonly ModelRouteSelection[]): void {
    this.#pendingCandidates = candidates.map(copySelection);
    this.#phase = "AWAITING_OPERATOR";
  }

  reject(reason = "operator_rejected"): void {
    this.#pendingCandidates = [];
    this.pause(reason);
  }

  canTransitionTo(
    target: ModelRouteSelection,
    policy: FailoverPolicyV1,
    now: number,
  ): { ok: true } | { ok: false; reason: string } {
    if (policy.mode === "off" || this.#phase === "DISABLED") return { ok: false, reason: "disabled" };
    if (this.#transitionCount >= policy.maxTransitionsPerTurn) {
      return { ok: false, reason: "transition_budget_exhausted" };
    }
    const targetKey = selectionKey(target);
    // A route we left only because the link dropped is not spent: it never
    // failed as a route. The cooldown below still governs how fast we may go
    // back, so this widens what is reachable without letting it flap.
    const reusable = this.#transportOnly.has(targetKey);
    if (
      targetKey === selectionKey(this.#primary)
      && targetKey !== selectionKey(this.#active)
      && !reusable
    ) {
      return { ok: false, reason: "automatic_failback_forbidden" };
    }
    if (this.#visited.has(targetKey) && !reusable) {
      return { ok: false, reason: "selection_already_visited" };
    }
    if (
      this.#lastTransition
      && now - this.#lastTransition.at < policy.cooldownSeconds * 1_000
    ) {
      return { ok: false, reason: "cooldown_active" };
    }
    return { ok: true };
  }

  beginTransition(target: ModelRouteSelection, policyDigest: string, now: number): void {
    this.#policyDigest = policyDigest;
    const leaving = selectionKey(this.#active);
    this.#visited.add(leaving);
    this.#visited.add(selectionKey(target));
    // Record WHY we are leaving, so a later hop can tell a spent route from
    // one that merely lost its connection. The target is dropped from the set
    // because we are about to use it: whatever happens next is its own record.
    if (this.#failure?.class === "transport_failure") this.#transportOnly.add(leaving);
    else this.#transportOnly.delete(leaving);
    this.#transportOnly.delete(selectionKey(target));
    this.#transitionCount += 1;
    this.#generation += 1;
    this.#pendingCandidates = [];
    this.#phase = "SWITCHING";
    this.#lastTransition = {
      from: copySelection(this.#active),
      to: copySelection(target),
      at: now,
      status: "failed",
      reason: "pending",
    };
  }

  activate(target: ModelRouteSelection, now: number): void {
    const from = this.#lastTransition?.from ?? this.#active;
    this.#active = copySelection(target);
    this.#phase = selectionKey(target) === selectionKey(this.#primary) ? "ARMED" : "FALLBACK_ACTIVE";
    this.#failure = undefined;
    this.#lastTransition = {
      from: copySelection(from),
      to: copySelection(target),
      at: now,
      status: "active",
    };
  }

  failTransition(target: ModelRouteSelection, reason: string, now: number): void {
    const from = this.#lastTransition?.from ?? this.#active;
    this.#lastTransition = {
      from: copySelection(from),
      to: copySelection(target),
      at: now,
      status: "failed",
      reason,
    };
    this.#phase = "DEGRADED";
  }

  pause(reason: string): void {
    this.#phase = "PAUSED";
    this.#pauseReason = reason;
    this.#pendingCandidates = [];
  }

  setManualPrimary(selection: ModelRouteSelection): void {
    this.#primary = copySelection(selection);
    this.#active = copySelection(selection);
    this.#failure = undefined;
    this.#pendingCandidates = [];
    this.#transitionCount = 0;
    this.#turnId = undefined;
    this.#generation += 1;
    this.#pauseReason = undefined;
    this.#lastTransition = undefined;
    this.#visited.clear();
    this.#phase = this.#policyDigest ? "ARMED" : "DISABLED";
  }
}

function copySelection(selection: ModelRouteSelection): ModelRouteSelection {
  return { route: selection.route, model: selection.model };
}
