import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { CHECKPOINT_IMPORT_SCHEMA, checkpointImportReceiptSchemas } from "./provider-input.ts";
import { projectSessionReplaySchemas, type EventRecord } from "./schema.ts";
import type { BlobStore } from "./blob-store.ts";
import { recordedProviderState } from "./provider-input.ts";
import type { EventLog } from "./event-log.ts";

type ImportReceiptName = keyof typeof checkpointImportReceiptSchemas;
export interface CheckpointInputImportReference {
  seq: number;
  name: ImportReceiptName;
  payloadDigest: string;
}
function refuse(): never { throw new Error("checkpoint-input-import replay: invalid receipt binding"); }
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Recorded authority only: never imports input, allocates files or resumes an effect. */
export function projectCheckpointInputImportReferences(events: readonly EventRecord[]): CheckpointInputImportReference[] {
  const refs: CheckpointInputImportReference[] = [];
  const imports = new Map<string, { intent: EventRecord; ready: boolean }>();
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const featureStart = projectSessionReplaySchemas(events).featureStart.get(CHECKPOINT_IMPORT_SCHEMA);
  for (const event of events) {
    if (!event.name.startsWith("branch/import_")) continue;
    if (!Object.hasOwn(checkpointImportReceiptSchemas, event.name) || event.kind !== "observe"
      || featureStart === undefined || event.seq <= featureStart) refuse();
    const name = event.name as ImportReceiptName;
    const parsed = checkpointImportReceiptSchemas[name].safeParse(event.payload);
    if (!parsed.success) refuse();
    const payload = parsed.data;
    if (name === "branch/import_intent") {
      if (imports.has(payload.session)) refuse();
      imports.set(payload.session, { intent: event, ready: false });
    } else {
      const pending = imports.get(payload.session);
      const ready = checkpointImportReceiptSchemas["branch/import_ready"].parse(payload);
      const state = bySeq.get(ready.state_seq);
      if (!pending || pending.ready || !same(pending.intent.payload.source, ready.source)
        || !same(pending.intent.payload.bundle, ready.bundle) || ready.state_seq !== pending.intent.seq + 1
        || event.seq !== ready.state_seq + 1 || state?.kind !== "observe" || state.name !== "provider/state") refuse();
      pending.ready = true;
    }
    refs.push({ seq: event.seq, name, payloadDigest: createHash("sha256").update(canonicalJson(payload)).digest("hex") });
  }
  return refs;
}

/** Verify retained source/input authority as well as ordered receipts. */
export function validateRecordedCheckpointInputImports(log: Pick<EventLog, "path" | "events">, suppliedStore?: BlobStore): void {
  const references = projectCheckpointInputImportReferences(log.events);
  if (references.length > 0) recordedProviderState(log, log.events, suppliedStore);
}
