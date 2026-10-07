import { projectBranchDecisions, type DecisionSnapshot } from "../host/branch-decision.ts";
import { projectBranchRuntime, type BranchChildDescriptor, type BranchRuntimeStartView } from "../chat/desktop-branch-runtime.ts";
import type { EventRecord } from "../host/schema.ts";

/** R8-04 workbench decision view — the bounded read behind
 * `workbench.decisions` v1. A pure projection of ONE verified session
 * prefix through the canonical decision fold and its retained-evidence
 * verification: truthful snapshots with local citations, explicit
 * missing/invalid states, and no synthetic applied outcome. It never
 * evaluates a deadline (an expired-but-unselected decision stays
 * `awaiting`), never appends, and reports execution unsupported until the
 * actual R8-05 dispatch binding exists. */

export type WorkbenchDecisionPreparation =
  | { readonly state: "unknown" }
  | { readonly state: "ready"; readonly commandId: string; readonly child: BranchChildDescriptor };

export interface WorkbenchDecisionItem {
  readonly id: string;
  readonly state: DecisionSnapshot["state"];
  readonly revision: number;
  readonly kind: "branch";
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly recommendation: string;
  readonly rationale: string;
  readonly policy: { readonly id: string; readonly version: number; readonly deadline: number } | null;
  readonly selected: { readonly option: string; readonly actor: string; readonly commandId: string; readonly seq: number } | null;
  readonly application: { readonly commandId: string; readonly state: "unknown"; readonly seq: number } | null;
  readonly alternateOf: { readonly id: string; readonly selectionSeq: number } | null;
  readonly preparation?: WorkbenchDecisionPreparation;
  readonly citations: { readonly open: number; readonly selected: number | null; readonly application: number | null };
}

export type WorkbenchDecisionsView =
  | { readonly state: "available"; readonly decisions: readonly WorkbenchDecisionItem[]; readonly total: number; readonly omitted: number }
  | { readonly state: "missing" | "invalid"; readonly decisions: []; readonly total: 0; readonly omitted: 0; readonly reason: string };

/** Explicit output bounds: the fold verifies EVERY recorded decision, while
 * the read-only RPC answer carries at most this many items and this many
 * canonical UTF-8 bytes. Whatever does not fit is reported as an explicit
 * omitted count — never silently clipped. */
export const MAX_WORKBENCH_DECISION_ITEMS = 256;
export const MAX_WORKBENCH_DECISIONS_BYTES = 1024 * 1024;

export function projectWorkbenchDecisions(
  events: readonly EventRecord[],
  retained: (digest: string) => string | undefined,
): WorkbenchDecisionsView {
  if (!events.some(row => row.name.startsWith("decision/"))) {
    return { state: "missing", decisions: [], total: 0, omitted: 0, reason: "this session recorded no branch decision rows" };
  }
  let projected: ReturnType<typeof projectBranchDecisions>;
  const runtimeByDecision = new Map<string, BranchRuntimeStartView>();
  try {
    projected = projectBranchDecisions(events, retained);
    // Recorded preparation is verified once against the same retained prefix.
    // It remains a historical fact when no live kernel is available.
    if (events.some(row => row.name.startsWith("branch/runtime_"))) {
      for (const start of projectBranchRuntime(events, retained).starts.values()) {
        runtimeByDecision.set(start.decisionId, start);
      }
    }
  } catch (error) {
    return {
      state: "invalid",
      decisions: [],
      total: 0,
      omitted: 0,
      reason: `the decision fold or its retained evidence refused: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
    };
  }
  const preparationOf = (id: string): WorkbenchDecisionPreparation | undefined => {
    const start = runtimeByDecision.get(id);
    if (start === undefined) return undefined;
    if (start.state === "ready" && start.child !== undefined) {
      return { state: "ready", commandId: start.commandId, child: start.child };
    }
    return { state: "unknown" };
  };
  const itemOf = (snapshot: DecisionSnapshot): WorkbenchDecisionItem => ({
    id: snapshot.id,
    state: snapshot.state,
    revision: snapshot.revision,
    kind: snapshot.kind,
    question: snapshot.question,
    options: snapshot.options,
    recommendation: snapshot.recommendation,
    rationale: snapshot.rationale,
    policy: snapshot.policy === null ? null : {
      id: snapshot.policy.id, version: snapshot.policy.version, deadline: snapshot.policy.deadline,
    },
    selected: snapshot.selected === null ? null : {
      option: snapshot.selected.option, actor: snapshot.selected.actor,
      commandId: snapshot.selected.commandId, seq: snapshot.selected.ref.seq,
    },
    application: snapshot.application === null ? null : {
      commandId: snapshot.application.commandId, state: snapshot.application.state, seq: snapshot.application.ref.seq,
    },
    alternateOf: snapshot.alternateOf === null ? null : {
      id: snapshot.alternateOf.id, selectionSeq: snapshot.alternateOf.selection.seq,
    },
    citations: snapshot.citations,
    ...(runtimeByDecision.has(snapshot.id) ? { preparation: preparationOf(snapshot.id) } : {}),
  });
  const snapshots = [...projected.decisions.values()].reverse();
  const decisions: WorkbenchDecisionItem[] = [];
  for (const snapshot of snapshots) {
    if (decisions.length >= MAX_WORKBENCH_DECISION_ITEMS) break;
    const next = itemOf(snapshot);
    const candidate = { state: "available", decisions: [...decisions, next],
      total: snapshots.length, omitted: snapshots.length - decisions.length - 1 };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_WORKBENCH_DECISIONS_BYTES) break;
    decisions.push(next);
  }
  return { state: "available", decisions, total: snapshots.length, omitted: snapshots.length - decisions.length };
}
