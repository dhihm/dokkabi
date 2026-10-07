/**
 * Bounded canonical byte windows of one retained row (pure).
 *
 * The body of a selected row is never fetched or concatenated whole. One
 * displayed window covers a requested byte range [start, start + WINDOW) and
 * is read as ONE bounded range request with a 3-byte overlap on both sides
 * (at most 32768 bytes). The overlap lets the decoder widen the window to the
 * enclosing UTF-8 character boundaries: an arbitrary byte offset may split a
 * character, which is not corruption — no byte inside the window is dropped
 * and no replacement character is produced. Consecutive windows are exactly
 * contiguous (next starts at the displayed end, previous ends at the
 * displayed start).
 *
 * Every range response is re-checked locally before it is decoded: its own
 * chunk digest, the requested row cursor, the pinned prefix, the requested
 * offset and limit, the descriptor's exact length and body digest, and the
 * nextOffset arithmetic. Any mismatch fails closed with no text. A checked
 * range is still only range integrity — never a whole-record or chain proof;
 * that requires the explicit streamed verification.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  WORKBENCH_RECORD_BODY_MAX_BYTES,
  type ProviderWorkbenchRecordBody,
  type ProviderWorkbenchRecordBodyResult,
  type ProviderWorkbenchRecordVerificationResult,
  type RecordCompanionBodyWindow,
  type RecordCompanionVerification,
  type WorkbenchRecordAsOf,
  type WorkbenchRecordBodyExpected,
  type WorkbenchRecordCursor,
} from "@t3tools/contracts";

/** Longest UTF-8 continuation run after a lead byte. */
export const RECORD_BODY_UTF8_OVERLAP = 3;
/** Nominal displayed window: one request including both overlaps is <= 32768. */
export const RECORD_BODY_WINDOW_BYTES =
  WORKBENCH_RECORD_BODY_MAX_BYTES - 2 * RECORD_BODY_UTF8_OVERLAP;
/** Explicit whole-row verification refuses rows beyond 64 MiB. */
export const RECORD_VERIFY_MAX_BYTES = 64 * 1_048_576;

export interface RecordBodyWindowPlan {
  /** Requested window start (clamped into the row). */
  readonly start: number;
  /** Requested window end (exclusive, clamped). */
  readonly end: number;
  /** The single range request: offset and limit (limit <= 32768). */
  readonly fetchOffset: number;
  readonly fetchLimit: number;
}

/** Clamp a requested start into [0, totalBytes - 1]. */
export function clampRecordBodyStart(start: number, totalBytes: number): number {
  if (!Number.isFinite(start) || start <= 0) return 0;
  return Math.min(Math.floor(start), Math.max(0, totalBytes - 1));
}

/** The one bounded request that serves the window starting at `start`. */
export function planRecordBodyWindow(start: number, totalBytes: number): RecordBodyWindowPlan {
  const clamped = clampRecordBodyStart(start, totalBytes);
  const end = Math.min(totalBytes, clamped + RECORD_BODY_WINDOW_BYTES);
  const fetchOffset = Math.max(0, clamped - RECORD_BODY_UTF8_OVERLAP);
  const fetchEnd = Math.min(totalBytes, end + RECORD_BODY_UTF8_OVERLAP);
  return { start: clamped, end, fetchOffset, fetchLimit: fetchEnd - fetchOffset };
}

export function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Strict canonical base64: atob tolerates whitespace and missing padding, so
 * the decoded bytes must re-encode to exactly the wire string. Null when the
 * value is not canonical.
 */
export function decodeBase64Bytes(data: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return encodeBase64Bytes(bytes) === data ? bytes : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

const sameCursor = (left: WorkbenchRecordCursor, right: WorkbenchRecordCursor): boolean =>
  left.seq === right.seq && left.hash === right.hash && left.generation === right.generation;

const sameAsOf = (left: WorkbenchRecordAsOf, right: WorkbenchRecordAsOf): boolean =>
  sameCursor(left, right) && left.sessionId === right.sessionId;

/** Closed cursor identity at genesis and at the source's first retained row. */
export function recordCursorIdentityError(cursor: WorkbenchRecordCursor): string | null {
  if (
    cursor.seq === 0 &&
    (cursor.hash !== "0".repeat(64) || cursor.generation !== "0".repeat(64))
  ) {
    return "A genesis cursor must carry the zero hash and generation.";
  }
  if (cursor.seq === 1 && cursor.hash !== cursor.generation) {
    return "A first-row cursor's hash must be its source generation.";
  }
  return null;
}

/** The exact request one window read answers. */
export interface RecordBodyWindowRequest {
  readonly row: WorkbenchRecordCursor;
  readonly asOf: WorkbenchRecordAsOf;
  readonly expected: WorkbenchRecordBodyExpected;
  readonly start: number;
}

/**
 * Local integrity of one range response against its own request and the
 * selected descriptor; null when exact. Checks range identity only.
 */
export function recordBodyChunkError(input: {
  readonly request: RecordBodyWindowRequest;
  readonly plan: RecordBodyWindowPlan;
  readonly body: ProviderWorkbenchRecordBody;
  readonly bytes: Uint8Array;
}): string | null {
  const { request, plan, body, bytes } = input;
  for (const cursor of [request.row, request.asOf, body.sessionCursor, body.gatewayCursor]) {
    const identityError = recordCursorIdentityError(cursor);
    if (identityError !== null) return identityError;
  }
  if (!sameCursor(body.row, request.row)) {
    return `The range answers row ${body.row.seq}, not the selected row ${request.row.seq}.`;
  }
  if (!sameAsOf(body.asOf, request.asOf)) {
    return "The range answers a different pinned prefix than the selected one.";
  }
  if (
    body.sessionCursor.sessionId !== request.asOf.sessionId ||
    body.sessionCursor.generation !== request.asOf.generation ||
    body.sessionCursor.seq < request.asOf.seq
  ) {
    return "The range's session head does not extend the pinned prefix.";
  }
  if (
    body.sessionCursor.seq === request.asOf.seq &&
    body.sessionCursor.hash !== request.asOf.hash
  ) {
    return "The range's session head at the pinned seq carries a different hash than the pin.";
  }
  if (request.row.generation !== request.asOf.generation) {
    return "The selected row names a different source generation than its pin.";
  }
  if (request.row.seq === 1 && request.row.hash !== request.asOf.generation) {
    return "The first row's hash is not the source generation.";
  }
  if (request.row.seq > request.asOf.seq) {
    return "The selected row lies beyond the pinned prefix.";
  }
  if (request.row.seq === request.asOf.seq && request.row.hash !== request.asOf.hash) {
    return "The selected row at the pinned seq carries a different hash than the pin.";
  }
  if (body.totalBytes !== request.expected.byteLength) {
    return `The range reports ${body.totalBytes} canonical bytes; the descriptor names ${request.expected.byteLength}.`;
  }
  if (body.bodyDigest !== request.expected.bodyDigest) {
    return "The range reports a different body digest than the selected descriptor.";
  }
  if (body.offset !== plan.fetchOffset) {
    return `The range starts at byte ${body.offset}, not the requested ${plan.fetchOffset}.`;
  }
  if (bytes.length === 0 || bytes.length > plan.fetchLimit) {
    return `The range carries ${bytes.length} bytes for a ${plan.fetchLimit}-byte request.`;
  }
  const end = body.offset + bytes.length;
  if (end > body.totalBytes) {
    return "The range extends beyond the row's canonical end.";
  }
  if ((body.nextOffset === null) !== (end === body.totalBytes)) {
    return "The range's nextOffset does not match its own end.";
  }
  if (body.nextOffset !== null && body.nextOffset !== end) {
    return `The range's nextOffset (${body.nextOffset}) is not its own end (${end}).`;
  }
  if (body.nextOffset !== null && bytes.length !== plan.fetchLimit) {
    return `A non-final range carries ${bytes.length} bytes instead of the requested ${plan.fetchLimit}.`;
  }
  if (sha256Hex(bytes) !== body.chunkDigest) {
    return "The range bytes do not match their chunk digest.";
  }
  return null;
}

const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A decoded window, or the explicit reason it cannot be shown. */
export type RecordBodyWindowDecode =
  | { readonly ok: true; readonly window: Extract<RecordCompanionBodyWindow, { status: "window" }> }
  | { readonly ok: false; readonly reason: string };

/**
 * Decode the planned window from one checked range. The window widens to the
 * enclosing UTF-8 boundaries using the overlap bytes. The wire guard requires
 * the exact requested range before decoding; no shortened nonfinal response
 * can be accepted as a displayed window.
 */
export function decodeRecordBodyWindow(input: {
  readonly request: RecordBodyWindowRequest;
  readonly plan: RecordBodyWindowPlan;
  readonly bodyOffset: number;
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly bodyDigest: string;
}): RecordBodyWindowDecode {
  const { plan, bytes, bodyOffset, totalBytes } = input;
  const fetchedEnd = bodyOffset + bytes.length;
  let startIndex = plan.start - bodyOffset;
  if (startIndex < 0 || startIndex >= bytes.length) {
    return { ok: false, reason: "The range does not cover the requested window start." };
  }
  let steps = 0;
  while (isContinuation(bytes[startIndex]) && startIndex > 0 && steps < RECORD_BODY_UTF8_OVERLAP) {
    startIndex -= 1;
    steps += 1;
  }
  if (isContinuation(bytes[startIndex])) {
    return { ok: false, reason: "The canonical bytes are not valid UTF-8 at the window start." };
  }
  let endIndex = Math.min(plan.end, fetchedEnd) - bodyOffset;
  let forward = 0;
  while (endIndex < bytes.length && isContinuation(bytes[endIndex])) {
    endIndex += 1;
    forward += 1;
    if (forward > RECORD_BODY_UTF8_OVERLAP) {
      return { ok: false, reason: "The canonical bytes are not valid UTF-8 at the window end." };
    }
  }
  if (endIndex === bytes.length && fetchedEnd < totalBytes) {
    // The byte after the range is unseen: keep the last character only when
    // its lead byte's width shows it is complete inside the range.
    let lead = bytes.length - 1;
    let back = 0;
    while (lead > startIndex && isContinuation(bytes[lead]) && back < RECORD_BODY_UTF8_OVERLAP) {
      lead -= 1;
      back += 1;
    }
    const byte = bytes[lead] ?? 0;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (lead + width > bytes.length) endIndex = lead;
  }
  if (endIndex <= startIndex) {
    return { ok: false, reason: "The range holds no complete character inside the window." };
  }
  let text: string;
  try {
    text = fatalDecoder.decode(bytes.subarray(startIndex, endIndex));
  } catch {
    return { ok: false, reason: "The canonical bytes are not valid UTF-8 inside the window." };
  }
  const start = bodyOffset + startIndex;
  const end = bodyOffset + endIndex;
  return {
    ok: true,
    window: {
      status: "window",
      row: input.request.row,
      requestedStart: plan.start,
      start,
      end,
      totalBytes,
      bodyDigest: input.bodyDigest,
      text,
      startExtended: start < plan.start,
      endExtended: end > plan.end,
      leadingOmitted: start > 0,
      trailingOmitted: end < totalBytes,
    },
  };
}

/** The result one body-window read resolves to (validated, decoded). */
export type RecordBodyWindowReadResult =
  | {
      readonly status: "available";
      readonly window: Extract<RecordCompanionBodyWindow, { status: "window" }>;
    }
  | { readonly status: "unavailable" | "unsupported"; readonly reason: string };

/** Thrown (as the read's typed failure) when a range fails its local checks. */
export class RecordBodyIntegrityError extends Error {
  override readonly name = "RecordBodyIntegrityError";
}

/** Validate and decode one wire result for its request; throws on refusal. */
export function resolveRecordBodyWindowRead(
  request: RecordBodyWindowRequest,
  result: ProviderWorkbenchRecordBodyResult,
): RecordBodyWindowReadResult {
  if (result.status !== "available") {
    return {
      status: result.status,
      reason:
        result.reason ??
        (result.status === "unsupported"
          ? "This gateway has no bounded record body reader."
          : "The record body is not available right now."),
    };
  }
  if (result.body === undefined) {
    throw new RecordBodyIntegrityError(
      "The source reported an available range without a payload; refusing to render it.",
    );
  }
  const plan = planRecordBodyWindow(request.start, request.expected.byteLength);
  const bytes = decodeBase64Bytes(result.body.data);
  if (bytes === null) {
    throw new RecordBodyIntegrityError("The range data is not canonical base64.");
  }
  const error = recordBodyChunkError({ request, plan, body: result.body, bytes });
  if (error !== null) throw new RecordBodyIntegrityError(error);
  const decoded = decodeRecordBodyWindow({
    request,
    plan,
    bodyOffset: result.body.offset,
    bytes,
    totalBytes: result.body.totalBytes,
    bodyDigest: result.body.bodyDigest,
  });
  if (!decoded.ok) throw new RecordBodyIntegrityError(decoded.reason);
  return { status: "available", window: decoded.window };
}

/** Next window start (the displayed end), or null at the row's end. */
export function nextRecordBodyStart(window: { readonly end: number; readonly totalBytes: number }) {
  return window.end < window.totalBytes ? window.end : null;
}

/** Previous window start: the window that ends exactly at the displayed start. */
export function previousRecordBodyStart(window: { readonly start: number }): number | null {
  return window.start > 0 ? Math.max(0, window.start - RECORD_BODY_WINDOW_BYTES) : null;
}

/** Last window start of a row. */
export function lastRecordBodyStart(totalBytes: number): number {
  return Math.max(0, totalBytes - RECORD_BODY_WINDOW_BYTES);
}

// --- Explicit whole-row verification binding ---

export interface RecordVerificationRequest {
  readonly row: WorkbenchRecordCursor;
  readonly asOf: WorkbenchRecordAsOf;
  readonly expected: WorkbenchRecordBodyExpected;
}

/** Refusal before any request: rows beyond the explicit 64 MiB bound. */
export function recordVerificationRefusal(expected: WorkbenchRecordBodyExpected): string | null {
  return expected.byteLength > RECORD_VERIFY_MAX_BYTES
    ? `Whole-record verification is limited to ${RECORD_VERIFY_MAX_BYTES} bytes; this row spans ${expected.byteLength}.`
    : null;
}

/**
 * Bind one verification result to the selected row/pin/descriptor. An exact
 * verdict that names another row, pin, length or digest is a failure — the
 * proof never transfers to a different selection.
 */
export function resolveRecordVerification(
  request: RecordVerificationRequest,
  result: ProviderWorkbenchRecordVerificationResult,
): RecordCompanionVerification {
  if (result.status !== "available") {
    return {
      status: "failed",
      row: request.row,
      reason:
        result.reason ??
        (result.status === "unsupported"
          ? "This gateway cannot verify whole retained records."
          : "Verification is not available right now."),
    };
  }
  const verification = result.verification;
  if (verification === undefined) {
    return {
      status: "failed",
      row: request.row,
      reason: "The source reported a verification without a verdict; nothing is proven.",
    };
  }
  if (
    !sameCursor(verification.row, request.row) ||
    !sameAsOf(verification.asOf, request.asOf) ||
    verification.totalBytes !== request.expected.byteLength ||
    verification.bodyDigest !== request.expected.bodyDigest ||
    verification.chunks < Math.ceil(request.expected.byteLength / WORKBENCH_RECORD_BODY_MAX_BYTES)
  ) {
    return {
      status: "failed",
      row: request.row,
      reason: "The verification result does not bind the selected row, pin and descriptor.",
    };
  }
  return { status: "exact", verification };
}
