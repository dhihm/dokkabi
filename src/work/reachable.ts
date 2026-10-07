import type { EventRecord } from "../host/schema.ts";
import type { WorkPlan } from "./schema.ts";
import { viewPlan } from "./view.ts";
import { scopeWorkEvents, workCaseDigest } from "./scope.ts";

/**
 * Todos that can actually be worked on now.
 *
 * Boot verify ran every case in the graph before the model took a single turn.
 * On a twelve-phase chain whose later gates each load a large checkpoint, that
 * was half an hour of remote work spent re-learning what the graph already
 * said: those todos sit behind eleven others, cannot be worked this wave, and
 * their reds change nothing about what happens next.
 *
 * A blocked todo's cases run when its turn comes — the first moment their
 * answer can matter.
 */
export function reachableTodos(
  plan: WorkPlan,
  events: readonly EventRecord[] = [],
): string[] {
  const view = viewPlan(plan, events);
  return plan.todos
    .filter((todo) => {
      const state = view.todoState[todo.id];
      // Cleared todos stay in scope: their greens are what keep the chain open,
      // and a regression there must still surface.
      if (state === "clear") return true;
      const blockers = todo.blocked_by ?? [];
      return blockers.every((id) => view.todoState[id] === "clear");
    })
    .map((todo) => todo.id);
}

/**
 * Cases already green on exactly these terms.
 *
 * phase-0 was re-executed on every wave although it was green and nothing
 * about it had changed. Re-running settled work costs a remote round trip to
 * learn what the log already recorded, and on a case that loads a checkpoint
 * that is twelve minutes to confirm a result nobody doubted.
 *
 * The case digest is what makes this safe: it covers the command and the
 * scenario, so any edit to either drops the case out of this set and it is
 * verified again. A red result also drops it — a case is settled only while
 * its last word was green.
 */
export function alreadySettledCases(
  plan: WorkPlan,
  events: readonly EventRecord[],
): string[] {
  const digestFor = new Map(
    plan.cases.map((item) => [
      item.id,
      workCaseDigest(item, plan.scenarios.find((scenario) => scenario.id === item.scenario)),
    ]),
  );
  const hostOf = new Map(plan.cases.map((item) => [item.id, item.host]));
  const latest = new Map<string, { status: string; digest: unknown; revision: unknown }>();
  // Latest revision seen per host, from the remote diff probe.
  const hostRevision = new Map<string, unknown>();
  for (const event of scopeWorkEvents(plan, events)) {
    if (event.name === "ssh/diff") {
      const payload = event.payload as { target?: unknown; revision?: unknown };
      if (typeof payload.target === "string") hostRevision.set(payload.target, payload.revision);
      continue;
    }
    if (event.name !== "work/case") continue;
    const payload = event.payload as {
      id?: unknown; status?: unknown; duration_ms?: unknown; case_digest?: unknown;
      host_revision?: unknown; first_run?: unknown;
    };
    // Only executed results count. A plan-bind row carries the ledger's
    // declared status, which is not something this run has learned.
    if (typeof payload.id !== "string" || typeof payload.status !== "string") continue;
    if (payload.duration_ms === undefined || payload.duration_ms === null) continue;
    latest.set(payload.id, {
      // A first-run green is explicitly unearned under RED-first: the whole
      // point is that implement runs and the case is judged AGAIN. Treating it
      // as settled skipped that second judgment and the todo could never clear.
      status: payload.first_run === true ? "born_green" : payload.status,
      digest: payload.case_digest,
      revision: payload.host_revision,
    });
  }
  return [...latest]
    .filter(([id, seen]) => {
      if (seen.status !== "green" || seen.digest !== digestFor.get(id)) return false;
      const host = hostOf.get(id);
      // A local case is settled by its digest alone: this workspace is the one
      // the harness can already see change.
      if (!host) return true;
      const current = hostRevision.get(host);
      // Nothing observed about the host since: the green still stands.
      if (current === undefined) return true;
      // The case digest covers the case's own terms, never the product they
      // check. A green recorded before the remote moved says nothing about the
      // code after it, so the case is reopened — including when the green was
      // recorded without a revision at all and cannot be compared.
      return seen.revision !== undefined && seen.revision === current;
    })
    .map(([id]) => id);
}
