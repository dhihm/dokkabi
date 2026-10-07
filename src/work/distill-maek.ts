import type { EventLog } from "../host/event-log.ts";
import { createMaekService } from "../maek/service.ts";
import { distillCampaignState } from "./distill.ts";

/**
 * MAEK projection for a distilled session (issue #117). Kept in its own
 * module so the pure distill projection — and any CLI that only needs it —
 * stays free of the native DuckDB dependency.
 *
 * The projection's completion is recorded independently of the distill
 * summary (`distill/maek_indexed`, keyed by the campaign input digest): a
 * failed or skipped load can be retried, and a retry of a distilled prefix
 * still performs its missing MAEK work instead of reporting success.
 */

/** True when the campaign head already has a successful `distill/maek_indexed` row. */
export function maekIndexedForCampaign(log: EventLog, sessionId: string): boolean {
  const state = distillCampaignState(log, sessionId);
  return log.events.some(
    (event) => event.name === "distill/maek_indexed" && event.payload.input_digest === state.input_digest,
  );
}

/**
 * Load the session's fault, resolution, and do-not-retry decision evidence
 * into its MAEK store and record the projection. Throws when the projection
 * failed — the caller must fail, not report success.
 */
export async function distillMaekIngest(input: {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly dbPath: string;
}): Promise<number> {
  const state = distillCampaignState(input.log, input.sessionId);
  const since = input.log.events.length;
  const maek = createMaekService({
    log: input.log,
    sessionId: input.sessionId,
    dbPath: input.dbPath,
  });
  try {
    await maek.ingest();
    // The service converts an initialization failure into a silent 0; the
    // maek/*_failed row it appends on the way down is the honest signal.
    const failure = input.log.events
      .slice(since)
      .find((event) => event.name.startsWith("maek/") && event.name.endsWith("_failed"));
    if (failure) {
      throw new Error(
        `MAEK projection failed during distill (${failure.name}: ${String(failure.payload.stage ?? failure.payload.status)})`,
      );
    }
    const ready = [...input.log.events.slice(since)].reverse().find((event) => event.name === "maek/ready");
    const rows = typeof ready?.payload.rows === "number" ? ready.payload.rows : 0;
    input.log.append({
      kind: "observe",
      name: "distill/maek_indexed",
      payload: { input_digest: state.input_digest, rows, head_seq: state.head_seq },
    });
    return rows;
  } finally {
    await maek.close();
  }
}
