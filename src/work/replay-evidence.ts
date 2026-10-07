import { canonicalJson } from "../host/canonical.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import { projectPlanEvidence } from "./plan-evidence.ts";
import { canClear, viewPlan } from "./view.ts";
import type { WorkPlan } from "./schema.ts";
import { evidenceDigest } from "./evidence/contract.ts";
import { projectObligations, projectPlanDrafts } from "./evidence/obligations.ts";
import { projectEarnedInputs } from "./evidence/earned.ts";
import type { EvidenceBodies } from "./evidence/projection.ts";
import { projectExecutionViews } from "./evidence/execution-view.ts";
import { projectCheckerRevisions } from "./evidence/checker-revision.ts";
import { classifyRedFailure } from "./verify.ts";

export function clearEvidence(plan: WorkPlan, events: readonly EventRecord[], todo: string) {
  const view = viewPlan(plan, events), authority = projectObligations(events).current;
  return { replay_schema: 1, authority_digest: authority?.digest ?? null,
    authority_revision: authority?.revision ?? null, allowed: canClear(view, todo),
    case_status: view.caseStatus, todo_state: view.todoState, errors: view.errors };
}

/** Shared live policies consume only authenticated retained execution facts.
 * A crash before a clear/decision is not fabricated into a completion. */
export function projectWorkReplay(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()) {
  const plans = projectPlanEvidence(events);
  const drafts = projectPlanDrafts(events);
  const earned = projectEarnedInputs(events, bodies);
  const start = projectSessionReplaySchemas(events).featureStart.get("work-replay-v1");
  const references = [...plans.references, ...projectExecutionViews(events, bodies).references,
    ...projectCheckerRevisions(events, bodies, (text, redMeans) => classifyRedFailure(text, redMeans).valid)];
  const unsupported = [...plans.unsupported];
  for (const event of events) {
    if (event.name !== "work/clear" && !(event.name === "work/case" && event.payload.status !== undefined)) continue;
    const modern = start !== undefined && event.seq > start;
    if (!modern) {
      if (event.name === "work/clear" && "replay_schema" in event.payload) throw new Error("clear evidence precedes its feature generation");
      unsupported.push(event.seq); continue;
    }
    const prefix = events.filter(row => row.seq < event.seq);
    const draft = event.name === "work/case" && drafts.find(value => value.event.seq < event.seq
      && canonicalJson(event.payload.draft_ref) === canonicalJson({ seq: value.event.seq, hash: value.event.hash }));
    const snapshot = draft ? draft.snapshot : plans.authority.snapshots.filter(row => row.seq < event.seq).at(-1)?.value;
    if (!snapshot) throw new Error(`work decision has no full plan at ${event.seq}`);
    if (event.name === "work/clear") {
      if (event.kind !== "observe" || event.payload.plan !== snapshot.plan.goal.id || typeof event.payload.todo !== "string") throw new Error("clear plan binding mismatch");
      const expected = clearEvidence(snapshot.plan, prefix, event.payload.todo);
      if (!expected.allowed) throw new Error(`unearned clear at ${event.seq}`);
      const { todo: _todo, plan: _plan, ...recorded } = event.payload;
      if (canonicalJson(recorded) !== canonicalJson(expected)) throw new Error(`clear evidence mismatch at ${event.seq}`);
    } else {
      if (event.payload.earned_policy !== "execution-earned-v1") throw new Error(`case lost its execution policy at ${event.seq}`);
      const raw = prefix.find(row => row.seq === event.payload.result_seq && row.name === "tool/result");
      if (event.payload.result_seq !== undefined && (!raw || raw.hash !== event.payload.result_hash)) throw new Error(`case raw result reference mismatch at ${event.seq}`);
      if (event.payload.status === "green" && event.payload.evidence_source !== "protected_observer" && !raw) throw new Error(`green case has no raw execution at ${event.seq}`);
      if (raw && ((event.payload.status === "green" && (raw.payload.exit_code !== 0 || raw.payload.error !== false))
        || (event.payload.status === "red" && event.payload.qualifying_red === true && raw.payload.exit_code !== 1))) {
        throw new Error(`case verdict contradicts raw execution at ${event.seq}`);
      }
    }
    references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(event.payload) });
  }
  for (const draft of drafts) for (const row of [draft.event, ...(draft.result ? [draft.result] : [])]) {
    references.push({ seq: row.seq, name: row.name, digest: evidenceDigest(row.payload) });
  }
  references.sort((a, b) => a.seq - b.seq);
  return { references, unsupported, incomplete: earned.incomplete };
}
