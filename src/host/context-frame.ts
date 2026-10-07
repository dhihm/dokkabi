import { contributionFrameSchema, HOST_CONTEXT_FRAME_SCHEMA } from "./context-contribution.ts";
import { CONTEXT_GRAPH_SCHEMA, frameRowSchema } from "../context-graph/types.ts";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { BlobStore } from "./blob-store.ts";
import type { EventLog } from "./event-log.ts";
import { sessionReplayFeatureGenerationIndex, type EventRecord } from "./schema.ts";

/**
 * #227 CG-04 — the host's side of a context frame: the exact bytes, the rows
 * that make them model-visible, and the recorder binding.
 *
 * A contribution (plugins/context-graph.ts) decides WHAT a frame says; only
 * this module records it. The rendered bytes are stored in the session's
 * BlobStore, read back and fsynced; then ONE durable batch appends the
 * `context/frame` row (the typed frame, whose `payload.blob` roots the body
 * for GC) and — when the frame is to be presented — the host-origin
 * `context/surface` row that carries the same bytes as surface text. Only
 * then does provider-input append the frame to the transcript
 * (`append_context`, which checks the text against that surface row). A
 * provider request whose transcript carries a frame is refused unless the
 * frame's surface row exists, its digest matches the bytes and its blob is
 * still on disk with the same bytes (assertContextFrameBindings).
 *
 * A frame is `prepared` when its row exists, `appended` once the transcript
 * carries it, `dispatched` when a request carrying it was handed to the send
 * path, and `responded` when that request was answered. Only the last two are
 * presentation; a crash after `prepared` is never read as "the model saw it".
 */

export const CONTEXT_FRAME_MARKER = "[dokkabi context frame ";

export class ContextFrameError extends Error {
  readonly code = "context_frame_unrecordable";
  constructor(reason: string) {
    super(`context-frame: ${reason}`);
    this.name = "ContextFrameError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The frame id a transcript message carries, or undefined when it is not a
 * frame message. */
export function contextFrameIdOf(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "user") return undefined;
  const text = messageText(value.content);
  if (text === undefined || !text.startsWith(CONTEXT_FRAME_MARKER)) return undefined;
  const match = /^cf-[0-9]+/u.exec(text.slice(CONTEXT_FRAME_MARKER.length));
  return match?.[0];
}

export function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
    ? (part as { text: string }).text : "")).join("\n");
}

/** The frame ids the transcript carries, in order. */
export function contextFramesIn(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const id = contextFrameIdOf(message);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** A recorded surface: a REFERENCE to the frame's bytes (§132 B2) — the
 * blob digest and size; the bytes live once, in the blob store. */
export interface RecordedSurface {
  readonly frameId: string;
  readonly ref: { seq: number; hash: string };
  readonly digest: string;
  readonly bytes: number;
  readonly ts: string;
}

/** The surface rows of one log, indexed incrementally (the same prefix guard
 * as the other live projections). */
interface SurfaceIndex { consumed: number; head: string | undefined; readonly byFrame: Map<string, RecordedSurface>; readonly frameIds: Set<string>; contributionsEnabled: boolean }
const indexes = new WeakMap<EventLog, SurfaceIndex>();

export function recordedSurfaces(log: EventLog): ReadonlyMap<string, RecordedSurface> {
  const events = log.events;
  let index = indexes.get(log);
  if (index && !(index.consumed <= events.length && (index.consumed === 0 || events[index.consumed - 1]?.hash === index.head))) {
    index = undefined;
  }
  index ??= { consumed: 0, head: undefined, byFrame: new Map(), frameIds: new Set(), contributionsEnabled: false };
  for (let at = index.consumed; at < events.length; at += 1) {
    const event = events[at]!;
    if (event.name === "session/open") {
      const features = event.payload.replay_features;
      index.contributionsEnabled = sessionReplayFeatureGenerationIndex(features) !== undefined &&
        Array.isArray(features) && features.includes(HOST_CONTEXT_FRAME_SCHEMA);
    }
    if (event.name === "context/frame") {
      const frame = event.payload.frame;
      const id = frame && typeof frame === "object" ? (frame as { id?: unknown }).id : event.payload.frame_id;
      if (typeof id === "string") index.frameIds.add(id);
    }
    if (event.name === "context/surface" && event.kind === "surface" && typeof event.payload.frame_id === "string"
      && typeof event.payload.blob === "string" && typeof event.payload.blob_bytes === "number"
      && !index.byFrame.has(event.payload.frame_id)) {
      index.byFrame.set(event.payload.frame_id, { frameId: event.payload.frame_id, ref: { seq: event.seq, hash: event.hash },
        digest: event.payload.blob, bytes: event.payload.blob_bytes, ts: event.ts });
    }
    index.consumed = at + 1;
    index.head = event.hash;
  }
  indexes.set(log, index);
  return index.byFrame;
}

/** The model message a recorded surface becomes: the exact bytes its blob
 * holds (read and checked against the digest the surface names) as one text
 * part, timestamped with the surface row's own time (replay rebuilds it). */
export function contextFrameMessage(log: EventLog, surface: RecordedSurface): { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number } {
  let text: string;
  try { text = BlobStore.forSession(log.path).get(surface.digest); } catch { throw new ContextFrameError(`frame ${surface.frameId} body is missing`); }
  if (sha256(text) !== surface.digest || Buffer.byteLength(text) !== surface.bytes) throw new ContextFrameError(`frame ${surface.frameId} body differs`);
  const timestamp = Date.parse(surface.ts);
  return { role: "user", content: [{ type: "text", text }], timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
}

/** Store the frame's bytes: put, read back, fsync. Any failure is a
 * ContextFrameError — the caller records it and ends the preparation. */
export function storeFrameBytes(log: EventLog, text: string): { digest: string; bytes: number } {
  try {
    const store = BlobStore.forSession(log.path);
    const digest = store.put(text);
    if (digest !== sha256(text) || store.get(digest) !== text) throw new Error("read-back differs");
    fsyncPath(store.pathOf(digest));
    return { digest, bytes: Buffer.byteLength(text) };
  } catch (error) {
    throw new ContextFrameError(`frame bytes could not be stored (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
  }
}

/** Append the frame and optional surface in one durable batch. Selection
 * payloads retain their original schema; other contributions receive a host
 * delivery envelope with their original payload kept as opaque content. */
export function recordContextFrame(log: EventLog, input: {
  readonly frameId: string;
  readonly payload: Record<string, unknown>;
  readonly text: string;
  readonly present: boolean;
  readonly boundary?: "initial" | "tool_batch" | "resume" | "retry" | "completion";
}): { frame: EventRecord; surface?: EventRecord } {
  if (log.isReadOnly) throw new ContextFrameError("a read-only log cannot record a frame");
  recordedSurfaces(log);
  const index = indexes.get(log)!;
  if (index.frameIds.has(input.frameId)) throw new ContextFrameError("frame id is already recorded");
  const digest = sha256(input.text);
  if (input.payload.blob !== digest || input.payload.blob_bytes !== Buffer.byteLength(input.text)) {
    throw new ContextFrameError("frame row does not name its bytes");
  }
  const head = log.events.at(-1);
  let payload: Record<string, unknown>;
  if (input.payload.schema === CONTEXT_GRAPH_SCHEMA) {
    const parsed = frameRowSchema.safeParse(input.payload);
    if (!parsed.success || parsed.data.frame.id !== input.frameId) {
      throw new ContextFrameError("selection frame does not match its declared contract");
    }
    payload = input.payload;
  } else {
    if (head === undefined) throw new ContextFrameError("a contribution needs a recorded source head");
    if (!index.contributionsEnabled) {
      throw new ContextFrameError("a contribution needs its sealed replay feature generation");
    }
    if (contextFrameIdOf({ role: "user", content: input.text }) !== input.frameId) {
      throw new ContextFrameError("contribution body does not name its declared frame");
    }
    if (input.boundary === undefined) throw new ContextFrameError("a contribution needs its actual request boundary");
    const parsed = contributionFrameSchema.safeParse({
      schema: HOST_CONTEXT_FRAME_SCHEMA,
      frame: { id: input.frameId, sourceHead: { seq: head.seq, hash: head.hash } },
      mode: input.present ? "on" : "shadow", boundary: input.boundary,
      blob: digest, blob_bytes: Buffer.byteLength(input.text), contribution: input.payload,
    });
    if (!parsed.success) throw new ContextFrameError("contribution delivery descriptor does not match its contract");
    payload = parsed.data;
  }
  const surfacePayload = (frame: EventRecord) => ({
    schema: "context-graph-v1", frame_id: input.frameId, frame: { seq: frame.seq, hash: frame.hash },
    origin: "host_context", blob: digest, blob_bytes: Buffer.byteLength(input.text),
  });
  // One durable transaction: the surface row names the frame row's hash,
  // which the projected batch hands it from the same transaction.
  const rows = log.appendProjectedBatchDurable(
    () => [
      { kind: "observe", name: "context/frame", payload },
      ...(input.present ? [{ kind: "surface" as const, name: "context/surface", payload: {} }] : []),
    ],
    (row, prefix) => row.name === "context/surface"
      ? [{ ...row, payload: surfacePayload(prefix.at(-1)!) }]
      : [row],
  );
  return input.present ? { frame: rows[0]!, surface: rows[1]! } : { frame: rows[0]! };
}

/** The recorder binding (G4, C12; §130 F1). Admission already requires the
 * request's messages to equal the durable transcript, and the transcript
 * accepts a frame only as the exact bytes of its surface row, replacing every
 * earlier one. What remains: the request carries at most ONE recorded frame,
 * and that frame's blob is still on disk, byte-identical — one blob read per
 * request, whatever the session's length. A user message that merely starts
 * like a frame but is no recorded frame (an operator pasting one) is
 * ordinary text, never a refusal. */
export function assertContextFrameBindings(log: EventLog, messages: readonly unknown[], refuse: (reason: string) => never): void {
  const started = performance.now();
  try { checkBindings(log, messages, refuse); } finally {
    let list = bindingTimes.get(log);
    if (!list) bindingTimes.set(log, list = []);
    list.push(performance.now() - started);
  }
}

/** Diagnostic only: the wall time of each admission's binding check. */
const bindingTimes = new WeakMap<EventLog, number[]>();
export function contextBindingWork(log: EventLog): readonly number[] {
  return [...(bindingTimes.get(log) ?? [])];
}

function checkBindings(log: EventLog, messages: readonly unknown[], refuse: (reason: string) => never): void {
  let surfaces: ReadonlyMap<string, RecordedSurface> | undefined;
  let live: { id: string; surface: RecordedSurface } | undefined;
  for (const message of messages) {
    const id = contextFrameIdOf(message);
    if (id === undefined) continue;
    surfaces ??= recordedSurfaces(log);
    const surface = surfaces.get(id);
    const text = messageText((message as { content?: unknown }).content) ?? "";
    if (!surface || sha256(text) !== surface.digest) continue;
    if (live !== undefined) refuse(`the request carries more than one live context frame (${live.id}, ${id})`);
    live = { id, surface };
  }
  if (live === undefined) return;
  const store = BlobStore.forSession(log.path);
  let stored: string | undefined;
  try { stored = store.has(live.surface.digest) ? store.get(live.surface.digest) : undefined; } catch { stored = undefined; }
  if (stored === undefined || sha256(stored) !== live.surface.digest) refuse(`context frame ${live.id} body is missing or differs in the blob store`);
}

/** Frames whose presentation (dispatch and answer) is already recorded. */
const presentedOnce = new WeakMap<EventLog, Set<string>>();

/** The request most recently dispatched with frames, per log, so its answer
 * can be recorded as the `responded` stage. */
const dispatched = new WeakMap<EventLog, { request: { seq: number; hash: string }; frames: string[] }>();

/** Record that the admitted request `request` carrying `messages` was handed
 * to the send path. A no-op when it carries no frame. */
export function recordContextDispatch(log: EventLog, request: { seq: number; hash: string } | undefined, messages: readonly unknown[]): void {
  dispatched.delete(log);
  if (request === undefined) return;
  const surfaces = recordedSurfaces(log);
  const frames = contextFramesIn(messages).filter((id) => surfaces.has(id)).slice(-1);
  if (frames.length === 0) return;
  // §132 B2: a frame's presentation is recorded once — its first dispatch
  // and first answer; a later request carrying the same live frame adds no
  // row.
  let seen = presentedOnce.get(log);
  if (!seen) presentedOnce.set(log, seen = new Set());
  if (seen.has(frames[0]!)) return;
  log.append({ kind: "observe", name: "context/presented", payload: {
    schema: "context-graph-v1", stage: "dispatched", request, frames, stop: null,
  } });
  dispatched.set(log, { request, frames });
}

/** Record that the last dispatched request with frames was answered. A
 * transport failure or an abort is not an answer: the marker is cleared and
 * the frames stay `dispatched`. */
export function recordContextResponse(log: EventLog, stop: string, answered: boolean): void {
  const last = dispatched.get(log);
  if (!last) return;
  dispatched.delete(log);
  if (!answered) return;
  let seen = presentedOnce.get(log);
  if (!seen) presentedOnce.set(log, seen = new Set());
  seen.add(last.frames[0]!);
  log.append({ kind: "observe", name: "context/presented", payload: {
    schema: "context-graph-v1", stage: "responded", request: last.request, frames: last.frames, stop: stop.slice(0, 32) || null,
  } });
}
