import type { EventLog } from "../host/event-log.ts";

/**
 * The work phase the workspace write guard enforces (#77 T6).
 *
 * `workspace-tools` and `workspace-bash` read `DOKKABI_WORK_PHASE` LAZILY,
 * per tool call, so the phase has always been an ambient process global that
 * five call sites assigned by hand — and nothing recorded the transitions.
 * That is how the guard hole reopened once already: a single assignment made
 * conditional silently unguarded the turn that ran before the plan bound.
 *
 * This module keeps the env write-through (the guard is unchanged and still
 * reads it) but makes every transition go through one door and land on the
 * log, so a run's write authority is auditable after the fact rather than
 * inferred from control flow.
 */

export const WORK_PHASES = ["decompose", "plan", "implement"] as const;
export type WorkPhase = (typeof WORK_PHASES)[number];

export function currentWorkPhase(): string | undefined {
  return process.env.DOKKABI_WORK_PHASE;
}

/** Enter a phase, recording the transition. Re-entering the phase already in
 * force records nothing — the log carries transitions, not heartbeats. */
export function enterWorkPhase(log: EventLog, phase: WorkPhase, reason: string): void {
  if (!(WORK_PHASES as readonly string[]).includes(phase)) {
    throw new Error(`unknown work phase ${String(phase)}`);
  }
  if (currentWorkPhase() === phase) return;
  process.env.DOKKABI_WORK_PHASE = phase;
  log.append({
    kind: "observe",
    name: "work/phase",
    payload: { phase, reason },
  });
}

/**
 * Record how decompose ended, and say whether the graph sealed.
 *
 * The two outcomes used to be written in the wrong order: "graph sealed" went
 * to the log before the refusals were read, so a run that exited with seven of
 * them left a ledger claiming it had sealed. It emitted no `plan_sealed` and no
 * `plan_refused` either, so the ending was invisible to the dashboard that
 * already reads `plan_refused.errors`. Deciding and recording in one place
 * makes writing them out of order impossible rather than merely fixed.
 *
 * A refusal is not a phase transition: the run stays in decompose, which is
 * where it actually is, and the errors are the record.
 */
export function sealedWorkGraph(log: EventLog, errors: readonly string[]): boolean {
  if (errors.length > 0) {
    log.append({
      kind: "observe",
      name: "work/plan_refused",
      payload: { stage: "work_plan", errors: [...errors] },
    });
    return false;
  }
  enterWorkPhase(log, "implement", "graph sealed");
  return true;
}

/**
 * Run `body` under `phase` and restore the previous phase afterwards —
 * including when the body throws. A step that dies mid-turn must not leave
 * the workspace writable for whatever runs next.
 */
export async function withWorkPhase<T>(
  log: EventLog,
  phase: WorkPhase,
  reason: string,
  body: () => Promise<T>,
): Promise<T> {
  const previous = currentWorkPhase();
  enterWorkPhase(log, phase, reason);
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.DOKKABI_WORK_PHASE;
      log.append({ kind: "observe", name: "work/phase", payload: { phase: "none", reason: `${reason} ended` } });
    } else if ((WORK_PHASES as readonly string[]).includes(previous)) {
      enterWorkPhase(log, previous as WorkPhase, `${reason} ended`);
    }
  }
}

/**
 * Run the planner-v2 planning session under its own phase (redesign memo §12
 * item 2). The session authors and runs its own cases like any other
 * session, so v1's decompose write rules — the read-only bash sibling bound
 * to work/+tests/ and the path-name write guard — must not bind it; the
 * seal's mechanical checks (immobility, red) are the only guard, and a model
 * that moves product code gets a seal finding, not a tool refusal.
 *
 * A seal moves the phase to implement from inside the session (sealProposal
 * → sealedWorkGraph), so only a session that ENDS still in plan — stopped or
 * dead — has the phase it interrupted restored. Restoring after a seal would
 * record a backwards transition that never happened.
 */
export async function withPlanSessionPhase<T>(log: EventLog, body: () => Promise<T>): Promise<T> {
  const previous = currentWorkPhase();
  enterWorkPhase(log, "plan", "model-driven planning session");
  try {
    return await body();
  } finally {
    if (currentWorkPhase() === "plan") {
      if (previous === undefined) {
        delete process.env.DOKKABI_WORK_PHASE;
        log.append({ kind: "observe", name: "work/phase", payload: { phase: "none", reason: "planning session ended" } });
      } else if ((WORK_PHASES as readonly string[]).includes(previous)) {
        enterWorkPhase(log, previous as WorkPhase, "planning session ended");
      }
    }
  }
}
