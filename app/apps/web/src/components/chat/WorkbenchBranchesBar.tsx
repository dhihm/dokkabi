import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranchIcon, PlusIcon, ShieldQuestionIcon } from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderWorkbenchDecisionActionResult,
  ProviderWorkbenchDecisionItem,
} from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { workbenchDecisionAction, workbenchDecisionsAtomFor } from "~/state/workbenchDecisions";
import {
  BranchAttemptRunner,
  branchActionScopeEquals,
  decisionDefinitionEquals,
  decisionLifecycle,
  deriveDecisionCommandId,
  newDecisionSubmissionId,
  preStartExpectedRevisionOf,
  preparedChildThreadIdOf,
  validateDecisionDefinition,
  type BranchActionScope,
  type CapturedBranchAttempt,
  type CapturedDecisionSubmission,
  type DecisionDefinitionDraft,
} from "./WorkbenchBranchesBar.logic";

/**
 * R8 WorkbenchBranchesBar: a compact, read-mostly decisions/branches surface
 * beside the established Work/Context/Record controls. Model output and user
 * input stay in the main conversation — this bar records explicit operator
 * decisions, selections and prepared-child opens only:
 *
 * - Creating a decision requires an explicit question, two or more option
 *   labels, a recommendation and a rationale; option ids are derived safely
 *   and never interpreted as commands. A failed submission keeps its
 *   captured identity ONLY while the operator retries the exact same
 *   validated definition; any change is a fresh intent.
 * - Selection is explicit. Preparing the child captures ONE target thread +
 *   start command per operator attempt and REUSES that capture on every
 *   explicit retry. The attempt runner lives per EXACT
 *   environment/thread/provider scope and resolves its callbacks through
 *   live refs, so ordinary projection updates never recreate it or lose the
 *   captured attempt; a stopped or superseded runner refuses BEFORE any
 *   allocation or dispatch. A recorded reserved (unknown) row with no
 *   captured target never allocates a replacement blindly.
 * - Labels and open targets come from the RECORDED preparation overlay, not
 *   renderer Sets. Opening a prepared child goes through the facade's
 *   explicit reconcile/adopt with the RECORDED preparation command and
 *   pre-start revision — never raw navigation around durable adoption — and
 *   navigates only on an app-ready answer naming the exact recorded target.
 * - Every async continuation is guarded by mount + action generation + scope
 *   equality: a stale or unmounted reply cannot touch state, clear the form
 *   or navigate; unknown outcomes never navigate and are never re-sent
 *   automatically.
 */

interface DecisionActionState {
  readonly kind: "idle" | "busy";
  readonly result: ProviderWorkbenchDecisionActionResult | null;
  readonly message: string | null;
}

const IDLE_ACTION: DecisionActionState = { kind: "idle", result: null, message: null };

function resultLabel(result: ProviderWorkbenchDecisionActionResult): string {
  switch (result.state) {
    case "ready":
      return "Prepared child conversation is ready.";
    case "unknown":
      return result.reason ?? "The outcome is unknown; it was not re-sent.";
    case "conflict":
      return result.reason ?? "The recorded revision changed; refresh and retry explicitly.";
    case "unsupported":
      return result.reason ?? "This provider has no decision capability.";
    case "available":
      return "Recorded.";
  }
}

/** One retained branch-attempt runner bound to its EXACT initiating scope. */
interface RunnerEntry {
  readonly scope: BranchActionScope;
  runner: BranchAttemptRunner | undefined;
  stopped: boolean;
}

export function WorkbenchBranchesBar({
  environmentId,
  threadId,
  providerInstanceId,
  visible,
  createBranchTarget,
  onOpenChildThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  /** Stops the bounded decisions poll while the surface is hidden. */
  readonly visible: boolean;
  /**
   * Creates the prepared child's TARGET app thread through the normal
   * thread-create operation (same project/provider instance/runtime mode)
   * with NO Send; returns the new thread id. Called at most once per
   * operator attempt.
   */
  readonly createBranchTarget: (title: string) => Promise<ThreadId>;
  /** Opens a CONFIRMED prepared child conversation (recorded target). */
  readonly onOpenChildThread: (childThreadId: ThreadId) => void;
}) {
  const scope = useMemo<BranchActionScope>(
    () => ({
      environmentId,
      threadId,
      providerInstanceId: providerInstanceId ?? null,
    }),
    [environmentId, threadId, providerInstanceId],
  );
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(true);
  /** Bumped on unmount and on every scope change: continuations of an older
   * generation may neither touch state nor navigate. */
  const actionGenerationRef = useRef(0);

  // Callback refs: the runner resolves its dependencies through these LIVE
  // refs, so normal projection updates (new activeThread → new callback
  // identities) never recreate the runner or lose a captured attempt.
  const createTargetRef = useRef(createBranchTarget);
  createTargetRef.current = createBranchTarget;
  const openChildRef = useRef(onOpenChildThread);
  openChildRef.current = onOpenChildThread;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionGenerationRef.current += 1;
    };
  }, []);

  const query = useEnvironmentQuery(
    visible ? workbenchDecisionsAtomFor({ environmentId, threadId, providerInstanceId }) : null,
  );
  const runDecisionAction = useAtomCommand(workbenchDecisionAction, {
    reportFailure: false,
  });
  const runDecisionActionRef = useRef(runDecisionAction);
  runDecisionActionRef.current = runDecisionAction;

  const [expanded, setExpanded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [actions, setActions] = useState<ReadonlyMap<string, DecisionActionState>>(() => new Map());
  const [draft, setDraft] = useState<DecisionDefinitionDraft>({
    question: "",
    optionLabels: ["", ""],
    recommendationIndex: -1,
    rationale: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  /** A failed create keeps its captured identity; an explicit retry reuses
   * it while the validated definition is unchanged, a new submit mints a
   * fresh intent id. */
  const capturedSubmissionRef = useRef<CapturedDecisionSubmission | null>(null);

  const decisions = query.data?.status === "available" ? (query.data.decisions ?? []) : [];

  /** Guarded state write: only the CURRENT generation may touch state. */
  const recordAction = useCallback(
    (decisionId: string, generation: number, state: DecisionActionState) => {
      if (!mountedRef.current || generation !== actionGenerationRef.current) return;
      setActions((current) => {
        const next = new Map(current);
        next.set(decisionId, state);
        return next;
      });
    },
    [],
  );

  // The retained attempt runner, one per EXACT environment/thread/provider
  // scope. A changed scope (or a stopped runner — including a StrictMode
  // mount-cleanup-remount cycle) hands the surface a FRESH runner; the old
  // one is stopped, so its captured attempts can never dispatch under a
  // newer scope. Callbacks resolve through refs, so the runner (and its
  // captured attempts) survive ordinary callback-identity churn.
  const runnerEntryRef = useRef<RunnerEntry | null>(null);
  const runnerForCurrentScope = useCallback((): BranchAttemptRunner => {
    const current = runnerEntryRef.current;
    if (
      current !== null &&
      current.runner !== undefined &&
      !current.stopped &&
      branchActionScopeEquals(current.scope, scopeRef.current)
    ) {
      return current.runner;
    }
    if (current !== null) {
      current.stopped = true;
      current.runner?.stop();
    }
    const entry: RunnerEntry = {
      scope: scopeRef.current,
      runner: undefined,
      stopped: false,
    };
    // Captured at entry creation: every dispatch of this runner's attempts
    // travels the attempt's OWN scope identity, never a later rendered one.
    const entryScope = entry.scope;
    entry.runner = new BranchAttemptRunner({
      createTarget: (title) => createTargetRef.current(title),
      startBranch: async (attempt: CapturedBranchAttempt) => {
        const result = await runDecisionActionRef.current({
          environmentId: entryScope.environmentId,
          input: {
            type: "start",
            threadId: entryScope.threadId,
            id: attempt.decisionId,
            commandId: attempt.commandId,
            expectedRevision: attempt.expectedRevision,
            childThreadId: attempt.childThreadId,
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            throw new Error("interrupted");
          }
          throw squashAtomCommandFailure(result);
        }
        return result.value;
      },
      isCurrent: () =>
        mountedRef.current &&
        runnerEntryRef.current === entry &&
        branchActionScopeEquals(scopeRef.current, entryScope),
      onReady: (childThreadId) => {
        openChildRef.current(childThreadId);
      },
    });
    runnerEntryRef.current = entry;
    return entry.runner;
  }, []);
  useEffect(() => {
    // A scope change invalidates every in-flight continuation and the old
    // scope's retained attempts, then (re)creates the runner for the CURRENT
    // scope — a StrictMode remount lands here with a stopped runner and must
    // leave a USABLE one, never a permanently stopped surface.
    actionGenerationRef.current += 1;
    const runner = runnerForCurrentScope();
    return () => {
      runner.stop();
    };
  }, [scope, runnerForCurrentScope]);

  /** Read-only: does the CURRENT scope's runner hold a captured attempt? */
  const hasCapturedAttempt = useCallback(
    (decisionId: string): boolean => {
      const entry = runnerEntryRef.current;
      return (
        entry !== null &&
        !entry.stopped &&
        branchActionScopeEquals(entry.scope, scope) &&
        entry.runner !== undefined &&
        entry.runner.attemptFor(decisionId) !== undefined
      );
    },
    [scope],
  );

  const submitDefinition = useCallback(async () => {
    const validation = validateDecisionDefinition(draft);
    if (!validation.ok) {
      setFormError(validation.reason);
      return;
    }
    setFormError(null);
    // Capture (or reuse) the submission identity: a retry reuses the SAME id
    // only for the EXACT same validated definition — question AND options
    // AND recommendation AND rationale; any change is a fresh intent.
    let captured = capturedSubmissionRef.current;
    if (
      captured === null ||
      !decisionDefinitionEquals(captured.definition, validation.definition)
    ) {
      captured = { id: newDecisionSubmissionId(), definition: validation.definition };
      capturedSubmissionRef.current = captured;
    }
    const generation = actionGenerationRef.current;
    recordAction(captured.id, generation, { kind: "busy", result: null, message: null });
    let outcome: ProviderWorkbenchDecisionActionResult | null = null;
    let failure: string | null = null;
    try {
      const result = await runDecisionAction({
        environmentId,
        input: {
          type: "create",
          threadId,
          definition: { id: captured.id, ...captured.definition },
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const squashed = squashAtomCommandFailure(result);
          failure = squashed instanceof Error ? squashed.message : "The decision creation failed.";
        }
      } else {
        outcome = result.value;
      }
    } catch {
      failure = "The decision creation failed.";
    }
    if (!mountedRef.current || generation !== actionGenerationRef.current) {
      // Stale continuation: keep the captured submission for an explicit
      // retry; never clear the form or touch state from a dead generation.
      return;
    }
    if (outcome !== null && (outcome.state === "available" || outcome.state === "ready")) {
      capturedSubmissionRef.current = null;
      recordAction(captured.id, generation, { kind: "idle", result: outcome, message: null });
      setShowForm(false);
      setDraft({ question: "", optionLabels: ["", ""], recommendationIndex: -1, rationale: "" });
      return;
    }
    // Failure or uncertain outcome: the attempt identity stays captured so
    // an explicit retry reuses the SAME intent.
    recordAction(captured.id, generation, { kind: "idle", result: outcome, message: failure });
  }, [draft, environmentId, recordAction, runDecisionAction, threadId]);

  const selectOption = useCallback(
    async (item: ProviderWorkbenchDecisionItem, option: string) => {
      setSelectedOptions((current) => {
        const next = new Map(current);
        next.set(item.id, option);
        return next;
      });
      const generation = actionGenerationRef.current;
      recordAction(item.id, generation, { kind: "busy", result: null, message: null });
      try {
        const result = await runDecisionAction({
          environmentId,
          input: {
            type: "select",
            threadId,
            id: item.id,
            commandId: deriveDecisionCommandId("select", [item.id, option]),
            expectedRevision: item.revision,
            option,
          },
        });
        if (!mountedRef.current || generation !== actionGenerationRef.current) return;
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const squashed = squashAtomCommandFailure(result);
            recordAction(item.id, generation, {
              kind: "idle",
              result: null,
              message:
                squashed instanceof Error
                  ? squashed.message
                  : "The selection failed at the provider boundary.",
            });
          } else {
            recordAction(item.id, generation, IDLE_ACTION);
          }
          return;
        }
        recordAction(item.id, generation, { kind: "idle", result: result.value, message: null });
      } catch {
        if (mountedRef.current && generation === actionGenerationRef.current) {
          recordAction(item.id, generation, {
            kind: "idle",
            result: null,
            message: "The selection failed.",
          });
        }
      }
    },
    [environmentId, recordAction, runDecisionAction, threadId],
  );

  const prepareChild = useCallback(
    async (item: ProviderWorkbenchDecisionItem) => {
      if (!mountedRef.current) return;
      const chosen = selectedOptions.get(item.id) ?? item.selected?.option ?? null;
      if (chosen === null) {
        recordAction(item.id, actionGenerationRef.current, {
          kind: "idle",
          result: null,
          message: "Select an option before preparing the child conversation.",
        });
        return;
      }
      const runner = runnerForCurrentScope();
      const captured = runner.attemptFor(item.id);
      if (decisionLifecycle(item) === "unknown" && captured === undefined) {
        // A reserved start exists in the recorded state but THIS view holds
        // no captured target (fresh mount/scope): a replacement target is
        // never allocated blindly and the recorded state stays the only
        // authority.
        recordAction(item.id, actionGenerationRef.current, {
          kind: "idle",
          result: null,
          message:
            "A start is recorded for this decision, but this view holds no captured target for it; a replacement target is never allocated blindly. The recorded decision state stays authoritative.",
        });
        return;
      }
      const expectedRevision = captured !== undefined ? captured.expectedRevision : item.revision;
      const generation = actionGenerationRef.current;
      recordAction(item.id, generation, { kind: "busy", result: null, message: null });
      const outcome = await runner.run({
        decisionId: item.id,
        title: `Branch — ${item.question.slice(0, 60)}`,
        expectedRevision,
      });
      // The runner guarded its own continuations; the recorded outcome is
      // written only from the live generation, and busy ALWAYS clears.
      recordAction(item.id, generation, {
        kind: "idle",
        result: null,
        message:
          outcome.kind === "ready" ? "Prepared child conversation is ready." : outcome.message,
      });
    },
    [recordAction, runnerForCurrentScope, selectedOptions],
  );

  /**
   * Open a RECORDED prepared child: an explicit facade reconcile/adopt of the
   * recorded preparation — its own commandId, its exact recorded target and
   * the pre-start expected revision — so durable adoption runs server-side
   * before any navigation. Navigation happens only for an app-ready answer
   * naming the EXACT recorded target while this scope is still current;
   * never a raw thread switch around the boundary.
   */
  const openPreparedChild = useCallback(
    async (item: ProviderWorkbenchDecisionItem) => {
      const preparation = item.preparation;
      if (preparation?.state !== "ready" || !mountedRef.current) return;
      const childThreadId = ThreadId.make(preparation.child.binding.threadId);
      const scopeAtStart = scopeRef.current;
      const generation = actionGenerationRef.current;
      recordAction(item.id, generation, { kind: "busy", result: null, message: null });
      let result: ProviderWorkbenchDecisionActionResult | null = null;
      let message: string | null = null;
      try {
        const answered = await runDecisionAction({
          environmentId: scopeAtStart.environmentId,
          input: {
            type: "start",
            threadId: scopeAtStart.threadId,
            id: item.id,
            commandId: preparation.commandId,
            expectedRevision: preStartExpectedRevisionOf(item),
            childThreadId,
          },
        });
        if (answered._tag === "Failure") {
          if (isAtomCommandInterrupted(answered)) {
            message =
              "Reconciling the prepared child was interrupted; the recorded preparation stays authoritative.";
          } else {
            const squashed = squashAtomCommandFailure(answered);
            message =
              squashed instanceof Error
                ? squashed.message
                : "Reconciling the prepared child failed.";
          }
        } else {
          result = answered.value;
        }
      } catch {
        message = "Reconciling the prepared child failed.";
      }
      if (
        !mountedRef.current ||
        generation !== actionGenerationRef.current ||
        !branchActionScopeEquals(scopeRef.current, scopeAtStart)
      ) {
        // Stale continuation: no state write and never a navigation.
        return;
      }
      if (
        result !== null &&
        result.state === "ready" &&
        result.child !== undefined &&
        result.child.binding.threadId === String(childThreadId)
      ) {
        openChildRef.current(childThreadId);
        recordAction(item.id, generation, {
          kind: "idle",
          result: null,
          message: "Prepared child conversation is ready.",
        });
        return;
      }
      if (message === null) {
        message =
          result !== null && result.state === "ready"
            ? `The reconciled child names target '${
                result.child?.binding.threadId ?? "unknown"
              }' but the recorded preparation names '${String(childThreadId)}'; it was not opened.`
            : (result?.reason ??
              "The prepared child did not reconcile as ready; it was not opened.");
      }
      recordAction(item.id, generation, {
        kind: "idle",
        result: result !== null && result.state !== "ready" ? result : null,
        message,
      });
    },
    [recordAction, runDecisionAction],
  );

  if (!visible) return null;
  const result = query.data;
  if (result !== null && (result.status === "unsupported" || result.status === "unavailable")) {
    return (
      <div
        className="flex min-h-9 items-center gap-3 border-b border-border bg-background px-4 text-xs text-muted-foreground"
        data-workbench-branches-bar={result.status}
        data-thread-id={threadId}
      >
        <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {result.status === "unsupported"
            ? (result.reason ?? "Decisions are not supported for this conversation.")
            : (result.reason ?? "Recorded decisions are not available yet.")}
        </span>
      </div>
    );
  }
  if (result !== null && result.status === "invalid") {
    // The retained decision authority refused: an explicit invalid surface
    // with its reason — never an empty success with a New decision form.
    return (
      <div
        className="flex min-h-9 items-center gap-3 border-b border-border bg-background px-4 text-xs text-warning-foreground"
        data-workbench-branches-bar="invalid"
        data-thread-id={threadId}
      >
        <ShieldQuestionIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Recorded decisions are invalid:{" "}
          {result.reason ?? "the retained decision authority refused this read."} Nothing was
          applied or changed.
        </span>
      </div>
    );
  }

  return (
    <div
      className="border-b border-border bg-background px-4 py-1 text-xs text-foreground"
      data-workbench-branches-bar="view"
      data-thread-id={threadId}
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <button
          type="button"
          className="font-medium hover:underline"
          data-workbench-branches-toggle="true"
          onClick={() => setExpanded((current) => !current)}
        >
          Branches · {decisions.length}
          {result?.status === "missing"
            ? " (no decision rows recorded)"
            : result?.omitted !== undefined && result.omitted > 0
              ? ` (+${result.omitted} omitted)`
              : ""}
        </button>
        {query.error !== null ? (
          <span className="rounded bg-warning/12 px-1.5 py-0.5 font-medium text-warning-foreground">
            stale
          </span>
        ) : null}
        <span className="grow" />
        <Button
          variant="ghost"
          size="xs"
          data-workbench-branches-new="true"
          onClick={() => {
            setShowForm((current) => !current);
            setFormError(null);
          }}
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
          New decision
        </Button>
      </div>
      {showForm ? (
        <form
          className="flex flex-col gap-2 pb-2"
          data-workbench-branches-form="true"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDefinition();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Question</span>
            <Input
              value={draft.question}
              data-workbench-branches-question="true"
              onChange={(event) =>
                setDraft((current) => ({ ...current, question: event.target.value }))
              }
              placeholder="What should decide the next branch?"
            />
          </label>
          {draft.optionLabels.map((label, index) => (
            <label key={index} className="flex items-center gap-2">
              <input
                type="radio"
                name="workbench-branches-recommendation"
                checked={draft.recommendationIndex === index}
                onChange={() => setDraft((current) => ({ ...current, recommendationIndex: index }))}
              />
              <Input
                value={label}
                data-workbench-branches-option={String(index + 1)}
                onChange={(event) =>
                  setDraft((current) => {
                    const optionLabels = [...current.optionLabels];
                    optionLabels[index] = event.target.value;
                    return { ...current, optionLabels };
                  })
                }
                placeholder={`Option ${index + 1}`}
              />
            </label>
          ))}
          {draft.optionLabels.length < 16 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-workbench-branches-add-option="true"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  optionLabels: [...current.optionLabels, ""],
                }))
              }
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Add option
            </Button>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Rationale</span>
            <Input
              value={draft.rationale}
              data-workbench-branches-rationale="true"
              onChange={(event) =>
                setDraft((current) => ({ ...current, rationale: event.target.value }))
              }
              placeholder="Why this recommendation?"
            />
          </label>
          {formError !== null ? (
            <p className="text-destructive" data-workbench-branches-form-error="true">
              {formError}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="outline" size="xs" data-workbench-branches-submit="true">
              Record decision
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {expanded ? (
        <ul className="flex flex-col gap-2 pb-2" data-workbench-branches-list="true">
          {decisions.length === 0 ? (
            <li className="text-muted-foreground">No decisions recorded.</li>
          ) : null}
          {decisions.map((item) => {
            const action = actions.get(item.id) ?? IDLE_ACTION;
            const lifecycle = decisionLifecycle(item);
            const recordedChild = preparedChildThreadIdOf(item);
            const chosen = selectedOptions.get(item.id) ?? item.selected?.option ?? null;
            const reservedWithoutCapture = lifecycle === "unknown" && !hasCapturedAttempt(item.id);
            return (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded border border-border p-2"
                data-workbench-branch-decision={item.id}
                data-decision-state={lifecycle}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ShieldQuestionIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="max-w-[52ch] truncate font-medium">{item.question}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    rev {item.revision} · cite {item.citations.open}
                    {item.citations.selected !== null ? `/${item.citations.selected}` : ""}
                  </span>
                  <span data-decision-lifecycle={lifecycle}>{lifecycle}</span>
                </div>
                <ul className="flex flex-col gap-0.5 pl-5">
                  {item.options.map((option) => (
                    <li key={option.id} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`workbench-branch-option-${item.id}`}
                        checked={chosen === option.id}
                        disabled={lifecycle === "prepared" || action.kind === "busy"}
                        onChange={() => {
                          void selectOption(item, option.id);
                        }}
                        data-workbench-branch-option={option.id}
                      />
                      <span
                        className={item.selected?.option === option.id ? "font-medium" : undefined}
                      >
                        {option.label}
                      </span>
                      {item.recommendation === option.id ? (
                        <span className="text-muted-foreground">(recommended)</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {item.selected !== null ? (
                  <p className="text-[11px] text-muted-foreground">
                    selected by {item.selected.actor} · seq {item.selected.seq}
                  </p>
                ) : null}
                {lifecycle === "selected" || lifecycle === "unknown" ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={action.kind === "busy" || chosen === null || reservedWithoutCapture}
                      data-workbench-branches-prepare="true"
                      onClick={() => {
                        void prepareChild(item);
                      }}
                    >
                      {lifecycle === "unknown" ? "Reconcile / open child" : "Prepare child"}
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      {reservedWithoutCapture
                        ? "Reserved: a start is recorded without a captured target here; nothing is re-allocated or re-sent."
                        : "Creates a new conversation; no message is sent."}
                    </span>
                  </div>
                ) : null}
                {lifecycle === "prepared" && recordedChild !== null ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={action.kind === "busy"}
                      data-workbench-branches-open="true"
                      onClick={() => {
                        void openPreparedChild(item);
                      }}
                    >
                      Open child conversation
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      Prepared; this is not a model result.
                    </span>
                  </div>
                ) : null}
                {action.kind === "busy" ? (
                  <p className="text-muted-foreground" data-decision-action="busy">
                    Working…
                  </p>
                ) : action.message !== null ? (
                  <p className="text-destructive" data-decision-action="message">
                    {action.message}
                  </p>
                ) : action.result !== null ? (
                  <p
                    data-decision-action={action.result.state}
                    className={
                      action.result.state === "unknown" || action.result.state === "conflict"
                        ? "text-warning-foreground"
                        : "text-muted-foreground"
                    }
                  >
                    {resultLabel(action.result)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
