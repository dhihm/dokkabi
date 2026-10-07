import { resolve } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { readCodeObserverState } from "../code-evolution/observer-state.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({ seq: z.number().int().positive(), hash: digest });
export const codeSelectionSchema = reference.extend({ digest });
const publication = z.strictObject({
  header: z.object({ sessionId: z.string(), workspaceKey: digest }).passthrough(),
  blob: digest,
  blob_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
  graphDigest: digest,
});

/** Metadata names recorded publications, not a claim that their bodies remain
 * available. Only an explicit exact read qualifies the retained material. */
export async function readWorkbenchCode(input: {
  log: EventLog;
  workspaceRoot: string;
  sessionId: string;
  afterSeq: number | undefined;
  resnapshot: boolean;
  selection: unknown;
}) {
  const rows = input.log.events.filter((row) => row.name === "code/version");
  if (rows.length > 32) throw new Error("Code publication index exceeds retained version bound");
  const workspaceKey = createHash("sha256").update(resolve(input.workspaceRoot)).digest("hex");
  const versions = rows.map((row: EventRecord) => {
    const payload = publication.parse(row.payload);
    if (
      row.kind !== "observe" ||
      payload.header.sessionId !== input.sessionId ||
      payload.header.workspaceKey !== workspaceKey
    )
      throw new Error("Code publication ownership mismatch");
    return {
      reference: {
        sessionId: input.sessionId,
        version: { seq: row.seq, hash: row.hash },
        digest: payload.blob,
      },
      bytes: payload.blob_bytes,
      graphDigest: payload.graphDigest,
    };
  });
  let body: { reference: (typeof versions)[number]["reference"]; text: string } | null = null;
  if (input.selection !== undefined) {
    const selection = codeSelectionSchema.parse(input.selection);
    const selected = versions.find(
      (v) =>
        v.reference.version.seq === selection.seq &&
        v.reference.version.hash === selection.hash &&
        v.reference.digest === selection.digest,
    );
    if (!selected) throw new Error("Code selection is not an owned retained publication");
    // Lazy load only for selected bodies. Index reads do not load a parser or
    // inspect files; E1-03 stays the sole implementation-identity authority.
    const { CodeEvolutionVersionService } = await import("../host/code-evolution-versions.ts");
    const service = new CodeEvolutionVersionService({
      log: input.log,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
    });
    try {
      const result = service.read(selected.reference);
      const text = canonicalJson(result.value);
      if (Buffer.byteLength(text, "utf8") !== selected.bytes)
        throw new Error("Code body size mismatch");
      body = { reference: result.reference, text };
    } finally {
      service.revoke();
    }
  }
  return {
    versions,
    body,
    observer: readCodeObserverState(input.log.events, input.sessionId, input.workspaceRoot),
    resnapshot: input.resnapshot,
    changed: input.resnapshot || rows.some((row) => row.seq > (input.afterSeq ?? 0)) ||
      input.log.events.some(row => row.name.startsWith("code/observer_") && row.seq > (input.afterSeq ?? 0)),
  };
}
