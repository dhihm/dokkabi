import { EARNED_START, EARNED_END, EARNED_CURRENT } from "./earned.ts";
import { MEASUREMENT_BODY_EVENTS } from "./measurement-projection.ts";
import { BlobStore } from "../../host/blob-store.ts";
import type { EventLog } from "../../host/event-log.ts";
import { FIXTURE_BODY_EVENTS } from "./fixture-manifest.ts";
import { EVIDENCE_BODY_EVENTS, type EvidenceBodies } from "./projection.ts";
import { ACCEPTANCE_BODY_EVENTS } from "./acceptance-contract.ts";
import { PROVIDER_BODY_EVENTS } from "../../host/provider-input.ts";
import { EXECUTION_VIEW_BODY_EVENTS } from "./execution-view.ts";

/** File acquisition is outside the pure replay projection and authenticates stored bytes. */
export function readEvidenceBodies(log: Pick<EventLog, "path" | "events">, suppliedStore?: BlobStore): EvidenceBodies {
  const bodies = new Map<string, unknown>();
  // One store handle: a body stored as parts (D53) shares its parts with the
  // session's other bodies, and the handle reads each checked part once.
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  const experimentCases = log.events.some(event => event.name === "experiment/case_policy");
  const nativeResults = new Set(log.events.filter(event => event.name === "work/runner_result").map(event => event.payload.result_seq));
  for (const event of log.events) {
    // Context bytes are plaintext, unlike the structured evidence envelopes.
    // Acquisition authenticates their blobs before pure replay can claim them.
    if ((event.name === "context/frame" || event.name === "context/surface") && typeof event.payload.blob === "string") {
      if (!bodies.has(event.payload.blob)) bodies.set(event.payload.blob, store.get(event.payload.blob));
      continue;
    }
    if ((experimentCases || nativeResults.has(event.seq)) && event.name === "tool/result" && typeof event.payload.blob === "string") {
      bodies.set(event.payload.blob, store.get(event.payload.blob));
      continue;
    }
    if (![EARNED_START, EARNED_END, EARNED_CURRENT].includes(event.name) && !EVIDENCE_BODY_EVENTS.has(event.name) && !FIXTURE_BODY_EVENTS.has(event.name) && !MEASUREMENT_BODY_EVENTS.has(event.name) && !ACCEPTANCE_BODY_EVENTS.has(event.name) && !PROVIDER_BODY_EVENTS.has(event.name) && !EXECUTION_VIEW_BODY_EVENTS.has(event.name)) continue;
    if (event.name === EARNED_END && event.payload.blob === undefined && event.payload.status === "refused") continue;
    const blob = event.payload.blob;
    if (typeof blob !== "string") throw new Error("evidence body blob missing");
    if (!bodies.has(blob)) bodies.set(blob, JSON.parse(store.get(blob)));
  }
  return bodies;
}
