import { ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderWorkbenchDecisionActionResult,
  ProviderWorkbenchDecisionItem,
} from "@t3tools/contracts";

/**
 * Pure decision/branch surface logic (Dokkabi R8): safe option-id
 * derivation, per-submission decision identities, the recorded-fact
 * lifecycle labels derived from the host's preparation overlay, and the
 * branch-attempt runner that captures ONE target/start-command per operator
 * attempt and reuses it across explicit retries with continuation guards.
 * Nothing here can mint applied from selected/ready, send a hidden turn,
 * allocate a second target for the same attempt, or let a stale continuation
 * act in a newer scope.
 *
 * @module components/chat/WorkbenchBranchesBar.logic
 */

/** The initiating action scope every async branch action captures. */
export interface BranchActionScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | null;
}

/** Exact scope equality — a late reply may only act while this still holds. */
export function branchActionScopeEquals(
  left: BranchActionScope,
  right: BranchActionScope,
): boolean {
  return (
    String(left.environmentId) === String(right.environmentId) &&
    String(left.threadId) === String(right.threadId) &&
    String(left.providerInstanceId ?? "unbound") === String(right.providerInstanceId ?? "unbound")
  );
}

/** Small dependency-free deterministic digest (FNV-1a, 32-bit hex). */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Safely derived option ids: plain lowercase ordinals (`opt-1`, `opt-2`, …)
 * in the harness OPTION_ID vocabulary. An id is POSITION-derived and carries
 * no executable meaning — labels are never interpreted as commands.
 */
export function deriveDecisionOptions(labels: ReadonlyArray<string>): ReadonlyArray<{
  id: string;
  label: string;
}> {
  return labels.map((label, index) => ({ id: `opt-${index + 1}`, label: label.trim() }));
}

export interface DecisionDefinitionDraft {
  readonly question: string;
  readonly optionLabels: ReadonlyArray<string>;
  /** Index into the option-label ROWS; -1 when nothing is picked. */
  readonly recommendationIndex: number;
  readonly rationale: string;
}

export interface ValidatedDecisionDefinition {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly recommendation: string;
  readonly rationale: string;
}

export type DecisionDefinitionValidation =
  | { readonly ok: true; readonly definition: ValidatedDecisionDefinition }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate an explicit operator definition. The returned definition carries
 * NO identity: the submission id is minted ONCE per operator submission
 * (`newDecisionSubmissionId`) so the same question opened against a later
 * checkpoint is a FRESH intent, while an explicit retry reuses the SAME
 * captured id (see `CapturedDecisionSubmission`). Option ids are derived
 * densely over the NON-EMPTY rows; the recommendation index addresses the
 * original rows, so a blank row can never become the recommendation and an
 * earlier blank never shifts which option is recommended.
 */
export function validateDecisionDefinition(
  draft: DecisionDefinitionDraft,
): DecisionDefinitionValidation {
  const question = draft.question.trim();
  if (question.length === 0) return { ok: false, reason: "A decision needs a question." };
  if (question.length > 2000) {
    return { ok: false, reason: "The question is too long (at most 2000 characters)." };
  }
  const labels = draft.optionLabels.map((label) => label.trim());
  const filledRowIndexes = labels
    .map((label, index) => (label.length > 0 ? index : -1))
    .filter((index) => index >= 0);
  if (filledRowIndexes.length < 2) {
    return { ok: false, reason: "A decision needs at least two non-empty options." };
  }
  if (filledRowIndexes.length > 16) {
    return { ok: false, reason: "A decision supports at most sixteen options." };
  }
  if (labels.some((label) => label.length > 200)) {
    return { ok: false, reason: "An option label is too long (at most 200 characters)." };
  }
  if (draft.recommendationIndex < 0 || draft.recommendationIndex >= labels.length) {
    return { ok: false, reason: "Pick which option you recommend." };
  }
  if (!filledRowIndexes.includes(draft.recommendationIndex)) {
    return { ok: false, reason: "The recommended option needs a label." };
  }
  const rationale = draft.rationale.trim();
  if (rationale.length > 2000) {
    return { ok: false, reason: "The rationale is too long (at most 2000 characters)." };
  }
  const options = deriveDecisionOptions(
    labels.filter((_, index) => filledRowIndexes.includes(index)),
  );
  const recommendation = options[filledRowIndexes.indexOf(draft.recommendationIndex)]!.id;
  return {
    ok: true,
    definition: { question, options, recommendation, rationale },
  };
}

/**
 * FULL validated-definition equality — a failed submission's explicit retry
 * reuses its captured identity ONLY when the operator resubmitted the exact
 * same definition. A changed question, option set, recommendation or
 * rationale is a NEW intent (fresh id), never the old captured definition
 * silently sent under the old identity.
 */
export function decisionDefinitionEquals(
  left: ValidatedDecisionDefinition,
  right: ValidatedDecisionDefinition,
): boolean {
  return (
    left.question === right.question &&
    left.recommendation === right.recommendation &&
    left.rationale === right.rationale &&
    left.options.length === right.options.length &&
    left.options.every(
      (option, index) =>
        option.id === right.options[index]!.id && option.label === right.options[index]!.label,
    )
  );
}

/**
 * One captured operator submission: the definition plus the id minted at
 * first submit. Retries of a FAILED submission reuse this capture; a later
 * new submission of the same question mints a fresh id (a new intent against
 * the then-current checkpoint).
 */
export interface CapturedDecisionSubmission {
  readonly id: string;
  readonly definition: ValidatedDecisionDefinition;
}

let submissionCounter = 0;

/** A fresh per-submission decision id (harness decision-id vocabulary). */
export function newDecisionSubmissionId(): string {
  submissionCounter += 1;
  return `dec-${Date.now().toString(36)}-${submissionCounter.toString(36)}-${fnv1aHex(
    `${Date.now()}:${submissionCounter}:${Math.random()}`,
  )}`;
}

/**
 * Deterministic command ids for explicit operator retries: the same
 * decision/option/target always maps to the same command id, so the
 * harness's durable command binding deduplicates an explicit retry instead
 * of treating it as new work.
 */
export function deriveDecisionCommandId(
  kind: "select" | "start",
  parts: ReadonlyArray<string>,
): string {
  return `decision-${kind}-${fnv1aHex(JSON.stringify(parts))}`;
}

/** The honest UI lifecycle for one recorded decision. */
export type DecisionLifecycle = "pending" | "selected" | "unknown" | "prepared";

/**
 * Lifecycle label derived ONLY from the recorded item: the host's
 * preparation overlay decides "prepared" (a confirmed recorded child) and
 * keeps a reserved start "unknown"; `application_pending` without a
 * confirmed child stays unknown. Never a synthetic applied, never renderer
 * Set authority.
 */
export function decisionLifecycle(
  item: Pick<ProviderWorkbenchDecisionItem, "id" | "state" | "preparation">,
): DecisionLifecycle {
  if (item.preparation?.state === "ready") return "prepared";
  if (item.preparation?.state === "unknown") return "unknown";
  switch (item.state) {
    case "awaiting":
      return "pending";
    case "selected":
      return "selected";
    case "application_pending":
      return "unknown";
  }
}

/** The recorded open target for a prepared decision, from the host fact. */
export function preparedChildThreadIdOf(
  item: Pick<ProviderWorkbenchDecisionItem, "preparation">,
): ThreadId | null {
  return item.preparation?.state === "ready"
    ? ThreadId.make(item.preparation.child.binding.threadId)
    : null;
}

/**
 * The pre-start expected revision for an EXPLICIT reconcile/open of a
 * recorded preparation: the revision the decision held BEFORE its application
 * admission (the host records each admitted action as exactly one revision
 * bump, so an application_pending row sits one past its pre-admission
 * revision). The captured start MUST name that pre-admission revision — the
 * server compares it exactly before adopting.
 */
export function preStartExpectedRevisionOf(
  item: Pick<ProviderWorkbenchDecisionItem, "state" | "revision">,
): number {
  return item.state === "application_pending" ? Math.max(item.revision - 1, 0) : item.revision;
}

/**
 * Scope-checked navigation guard: a branch action's late reply may open the
 * child conversation ONLY when the result is a confirmed ready AND the
 * initiating scope is still the current one. Unknown and conflict results
 * never navigate; a scope change never navigates from an old reply.
 */
export function shouldOpenChildConversation(
  initiatingScope: BranchActionScope,
  currentScope: BranchActionScope,
  result: ProviderWorkbenchDecisionActionResult,
): result is ProviderWorkbenchDecisionActionResult & {
  readonly state: "ready";
  readonly child: NonNullable<ProviderWorkbenchDecisionActionResult["child"]>;
} {
  return (
    result.state === "ready" &&
    result.child !== undefined &&
    branchActionScopeEquals(initiatingScope, currentScope)
  );
}

// ---------------------------------------------------------------------------
// Branch-attempt runner: one captured target + start command per operator
// attempt, reused across explicit retries; no blind new allocations.
// ---------------------------------------------------------------------------

/** ONE operator attempt to open a prepared child: the captured target thread
 * and start command reused by every explicit retry of that attempt. */
export interface CapturedBranchAttempt {
  readonly decisionId: string;
  readonly commandId: string;
  readonly childThreadId: ThreadId;
  readonly expectedRevision: number;
}

export type BranchAttemptOutcome =
  | { readonly kind: "ready"; readonly childThreadId: ThreadId }
  | { readonly kind: "unknown"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export interface BranchAttemptDeps {
  /** Allocates the target app thread — called AT MOST ONCE per attempt. */
  readonly createTarget: (title: string) => Promise<ThreadId>;
  /** Sends/reconciles the recorded start through the facade. */
  readonly startBranch: (
    attempt: CapturedBranchAttempt,
  ) => Promise<ProviderWorkbenchDecisionActionResult>;
  /**
   * True while the initiating scope/generation is still current AND the
   * surface is still mounted — evaluated before EVERY continuation.
   */
  readonly isCurrent: () => boolean;
  /** Called only for a confirmed ready outcome, after the isCurrent check. */
  readonly onReady: (childThreadId: ThreadId) => void;
}

/**
 * Runs one branch attempt per decision id. Every run is guarded BEFORE the
 * target allocation and BEFORE every dispatch — including the reuse of an
 * already captured attempt: a stopped runner or an inactive owner
 * (unmounted, superseded scope, changed generation) never allocates and
 * never sends. The FIRST live run allocates the target thread and derives
 * the stable start command; subsequent runs REUSE that capture (the facade
 * reconciles through recorded status — no second start, no second target).
 * A ready outcome is honored only when the CONFIRMED target equals the
 * captured target exactly; a foreign target never navigates. Rejected/
 * interrupted dispatches keep the captured attempt (the outcome is
 * uncertain, not failed) so an explicit retry reconciles the SAME intent.
 */
export class BranchAttemptRunner {
  private readonly attempts = new Map<string, CapturedBranchAttempt>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: BranchAttemptDeps) {}

  /** The captured attempt for a decision, when one exists (recorded fact). */
  attemptFor(decisionId: string): CapturedBranchAttempt | undefined {
    return this.attempts.get(decisionId);
  }

  /** Whether this runner was stopped and can no longer dispatch anything. */
  isStopped(): boolean {
    return this.stopped;
  }

  /** Abandon continuation: in-flight runs stop at their next guard. */
  stop(): void {
    this.stopped = true;
  }

  private stopped = false;

  async run(input: {
    readonly decisionId: string;
    readonly title: string;
    readonly expectedRevision: number;
  }): Promise<BranchAttemptOutcome> {
    if (this.inFlight.has(input.decisionId)) {
      return { kind: "refused", message: "An attempt for this decision is already running." };
    }
    // Guard BEFORE allocation and before the reuse of an existing capture:
    // an inactive owner never allocates a target and a stopped runner never
    // re-dispatches a captured attempt.
    if (this.stopped || !this.deps.isCurrent()) {
      return {
        kind: "refused",
        message:
          "This branch surface is no longer the active owner of the attempt; nothing was allocated and no start was sent. The recorded decision state stays authoritative.",
      };
    }
    this.inFlight.add(input.decisionId);
    try {
      let attempt = this.attempts.get(input.decisionId);
      if (attempt === undefined) {
        let childThreadId: ThreadId;
        try {
          childThreadId = await this.deps.createTarget(input.title);
        } catch {
          return {
            kind: "refused",
            message: "Creating the branch target thread failed; no start was sent.",
          };
        }
        if (this.stopped || !this.deps.isCurrent()) {
          // The target exists but no start was sent; retain it so a later
          // explicit attempt in a live scope reuses it instead of allocating
          // another target.
          this.attempts.set(input.decisionId, {
            decisionId: input.decisionId,
            commandId: deriveDecisionCommandId("start", [input.decisionId, String(childThreadId)]),
            childThreadId,
            expectedRevision: input.expectedRevision,
          });
          return {
            kind: "unknown",
            message:
              "The view changed before the start was sent; the created target is retained and no start was sent.",
          };
        }
        attempt = {
          decisionId: input.decisionId,
          commandId: deriveDecisionCommandId("start", [input.decisionId, String(childThreadId)]),
          childThreadId,
          expectedRevision: input.expectedRevision,
        };
        this.attempts.set(input.decisionId, attempt);
      }
      let result: ProviderWorkbenchDecisionActionResult;
      try {
        result = await this.deps.startBranch(attempt);
      } catch {
        // Rejected promise / interrupted dispatch: the outcome is uncertain
        // and the captured attempt is RETAINED for an explicit retry.
        return {
          kind: "unknown",
          message:
            "The start's outcome is uncertain (the request failed before an answer); the same target and command are reused on an explicit retry — nothing was re-sent.",
        };
      }
      if (this.stopped || !this.deps.isCurrent()) {
        return {
          kind: "unknown",
          message:
            "The start's outcome arrived after this view changed; it was not applied here. The recorded decision state stays authoritative.",
        };
      }
      if (result.state === "ready" && result.child !== undefined) {
        // The confirmed target must equal the CAPTURED target exactly — a
        // ready answer naming any other thread never navigates and never
        // counts as this attempt's outcome.
        if (result.child.binding.threadId !== String(attempt.childThreadId)) {
          return {
            kind: "refused",
            message: `The confirmed child names target thread '${result.child.binding.threadId}' but this attempt captured '${String(attempt.childThreadId)}'; it was not opened and nothing was re-sent.`,
          };
        }
        const recorded = ThreadId.make(result.child.binding.threadId);
        this.deps.onReady(recorded);
        return { kind: "ready", childThreadId: recorded };
      }
      if (result.state === "unknown") {
        return {
          kind: "unknown",
          message: result.reason ?? "The outcome is unknown; it was not re-sent.",
        };
      }
      return {
        kind: "refused",
        message: result.reason ?? `The gateway answered state '${result.state}'.`,
      };
    } finally {
      this.inFlight.delete(input.decisionId);
    }
  }
}

/** Whether an unknown outcome may be explicitly reconciled (never auto). */
export function canExplicitlyReconcile(result: ProviderWorkbenchDecisionActionResult): boolean {
  return result.state === "unknown";
}
