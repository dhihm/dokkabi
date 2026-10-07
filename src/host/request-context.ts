import type { EventLog } from "./event-log.ts";
import { ContextFrameError, recordContextFrame, storeFrameBytes } from "./context-frame.ts";
import { appendProviderContext, ProviderInputError } from "./provider-input.ts";
import { assertNoSecrets, containsSecret, containsSecretValue } from "./redact.ts";
import type { RequestContextContributionRegistry, RequestContextInput } from "../loader/types.ts";

/**
 * #227 CG-04 — apply the request-context registry at one provider-request
 * preparation boundary (design memo §129 G4, §130 F1/F2).
 *
 * The loop calls this at every boundary (initial, after a tool batch, resume,
 * retry) with the durable transcript the next request will carry. Each
 * contribution returns a decision; this function is the only writer:
 *
 * - `record`: check the frame against every guard its rows and its transcript
 *   message will meet, then store the exact bytes (put, read back, fsync),
 *   append the `context/frame` row and — for a presented frame — its
 *   `context/surface` row in one durable batch, then put the frame into the
 *   transcript in place of the one it carried (`append_context` with
 *   `replaces`: exactly one live frame).
 * - `present`: put an already recorded frame into the transcript (a crash
 *   left it prepared).
 * - `none`: nothing.
 *
 * A frame a guard refuses is never stored (nothing credential-shaped reaches
 * the disk); a frame that cannot be stored or appended records
 * `context/degraded` and the request proceeds WITHOUT a new frame — the
 * session is never stuck on its own reference data. Shadow frames are
 * recorded and never presented, so the provider input is byte-identical to
 * the feature being off. Returns the transcript the request carries, or
 * undefined when it is unchanged.
 */
export function applyRequestContext(
  log: EventLog,
  registry: RequestContextContributionRegistry | undefined,
  input: RequestContextInput,
): unknown[] | undefined {
  if (!registry || !registry.active() || log.isReadOnly) return undefined;
  const started = performance.now();
  const decisions = registry.prepare(input);
  if (decisions.every((item) => item.decision.action === "none")) {
    noteWork(log, performance.now() - started);
    return undefined;
  }
  // No whole-transcript re-digest here: the frame replaces positions of the
  // DURABLE transcript, and admission holds the request's messages to it
  // (a transcript that diverged is refused there, as before).
  let messages: unknown[] = [...input.messages];
  let changed = false;
  for (const { contribution, decision: first } of decisions) {
    let decision = first;
    if (decision.action === "none") continue;
    const degrade = (reason: "frame_store_failed" | "frame_refused", detail: string, guard: string | null) => {
      contribution.degraded?.(reason, input.boundary, detail, guard);
    };
    if (decision.action === "record") {
      const refused = frameRefusal(decision.payload, decision.text, decision.present);
      if (refused !== undefined) {
        // §132 F2': the refusal is recorded with the refusing guard, and the
        // frame that replaces the previous one says so — no stale frame
        // stays live. Nothing of the refused frame is stored.
        degrade("frame_refused", `frame ${decision.frameId} refused before storage`, refused);
        const fallback = contribution.refused?.(input, refused);
        if (fallback === undefined || fallback.action !== "record" || frameRefusal(fallback.payload, fallback.text, fallback.present) !== undefined) {
          if(input.boundary==="completion")throw new ContextFrameError("Completion context unavailable; task remains incomplete");
          continue;
        }
        decision = fallback;
      }
      try {
        storeFrameBytes(log, decision.text);
      } catch (error) {
        degrade("frame_store_failed", error instanceof Error ? error.message : "frame bytes could not be stored", null);
        if(input.boundary==="completion")throw new ContextFrameError("Completion context unavailable; task remains incomplete");
        continue;
      }
      recordContextFrame(log, { frameId: decision.frameId, payload: decision.payload, text: decision.text, present: decision.present, boundary: input.boundary });
      if (!decision.present) continue;
    }
    let appended: ReturnType<typeof appendProviderContext>;
    try {
      appended = appendProviderContext(log, decision.frameId);
    } catch (error) {
      if (!(error instanceof ProviderInputError) && !(error instanceof ContextFrameError)) throw error;
      degrade(error instanceof ContextFrameError ? "frame_store_failed" : "frame_refused", error.message, error instanceof ContextFrameError ? null : "provider_input_guard");
      if(input.boundary==="completion")throw new ContextFrameError("Completion context unavailable; task remains incomplete");
      continue;
    }
    // The frame's `appended` stage, named only once the transcript carries it.
    log.append({ kind: "observe", name: "context/presented", payload: {
      schema: "context-graph-v1", stage: "appended", state: appended.state, frames: [decision.frameId],
    } });
    const dropped = new Set(appended.replaces);
    messages = [...messages.filter((_, index) => !dropped.has(index)), appended.message];
    changed = true;
  }
  noteWork(log, performance.now() - started);
  return changed ? messages : undefined;
}

/** The guard that refuses a frame, or undefined: the same guards its rows
 * and its transcript message will meet (the frame credential guard, the
 * EventLog's secret boundary), run BEFORE anything is stored. */
export function frameRefusal(payload: Record<string, unknown>, text: string, present: boolean): string | undefined {
  if (containsSecret(text) || containsSecretValue({ role: "user", content: [{ type: "text", text }] })) return "frame_credential_guard";
  try {
    assertNoSecrets({ payload, name: "context/frame" });
    if (present) assertNoSecrets({ payload: { text }, name: "context/surface" });
  } catch {
    return "event_log_secret_boundary";
  }
  return undefined;
}

/** Diagnostic only: the wall time of each boundary's request-context work
 * (prepare + guards + store + record + transcript append), per log. */
const works = new WeakMap<EventLog, number[]>();
function noteWork(log: EventLog, ms: number): void {
  let list = works.get(log);
  if (!list) works.set(log, list = []);
  list.push(ms);
}
export function requestContextWork(log: EventLog): readonly number[] {
  return [...(works.get(log) ?? [])];
}
