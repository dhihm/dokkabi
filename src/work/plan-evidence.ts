import { canonicalJson } from "../host/canonical.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import { projectObligations } from "./evidence/obligations.ts";
import { planDigest } from "./digest.ts";
import { semanticPlanDefinitionDigest } from "./semantic-livelock-plan.ts";
import { evidenceDigest } from "./evidence/contract.ts";

/** Task 9's full snapshots remain the sole plan authority. Bind the work
 * projection and every bar observation to its chronological retained identity. */
export function projectPlanEvidence(events: readonly EventRecord[]) {
  const authority = projectObligations(events);
  const start = projectSessionReplaySchemas(events).featureStart.get("work-replay-v1");
  const references: { seq: number; name: string; digest: string }[] = [];
  const unsupported: number[] = [];
  for (const event of events) {
    if (!["work/goal", "work/bars", "work/bars_set"].includes(event.name)) continue;
    if (event.name === "work/goal" && event.payload.digest === "pending") continue;
    if (start === undefined || event.seq < start) { unsupported.push(event.seq); continue; }
    if (event.name === "work/goal") {
      const snapshot = authority.snapshots.filter(row => row.seq < event.seq).at(-1)?.value;
      if (!snapshot || event.payload.authority_digest !== snapshot.digest || event.payload.authority_revision !== snapshot.revision
        || event.payload.scope_seq !== snapshot.scope_seq || event.payload.digest !== planDigest(snapshot.plan)
        || event.payload.semantic_definition_digest !== semanticPlanDefinitionDigest(snapshot.plan)
        || canonicalJson(event.payload.require_red_first) !== canonicalJson(snapshot.plan.require_red_first)) {
        throw new Error(`plan projection differs from full authority at ${event.seq}`);
      }
    }
    // A bars observation is not operator authority. Its exact bytes still
    // affect projection equality, even if it never becomes an adopted plan.
    references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(event.payload) });
  }
  return { authority, references, unsupported };
}
