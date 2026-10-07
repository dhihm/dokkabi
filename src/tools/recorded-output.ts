import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { canonicalJson } from "../host/canonical.ts";
import { EventLog } from "../host/event-log.ts";
import { openHeldBlobTarget } from "../host/probe-target.ts";
import { containsSecret } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";
import type { ToolOutcome } from "./execute.ts";

export type RecordedOutputRefusal =
  | "record_unbound"
  | "record_mismatch"
  | "record_metadata_invalid"
  | "process_completion_unavailable"
  | "output_withheld"
  | "output_unavailable"
  | "blob_integrity"
  | "output_size_mismatch"
  | "legacy_inline_unqualified";

export type RecordedOutput =
  | {
    readonly ok: true;
    readonly body: string;
    readonly error: boolean;
    readonly exitCode: number;
    readonly seq: number;
    readonly hash: string;
    readonly storage: "inline" | "blob";
    readonly byteEncoding: "utf8" | "legacy_utf16";
    readonly utf8Bytes: number;
  }
  | {
    readonly ok: false;
    readonly code: RecordedOutputRefusal;
    readonly seq?: number;
    readonly hash?: string;
  };

interface RecordedOutputBinding {
  readonly log: EventLog;
  readonly seq: number;
  readonly hash: string;
  readonly canonicalRecord: string;
}

interface RecordedResultState {
  readonly error: boolean;
  readonly exitCode: number;
  readonly identity: { readonly seq: number; readonly hash: string };
}

interface BlobResolution {
  readonly log: EventLog;
  readonly digest: string;
  readonly declaredBytes: number;
  readonly legacy: boolean;
  readonly result: RecordedResultState;
}

const RECORDED_OUTPUT = Symbol("dokkabi.recorded-output");

export function bindRecordedToolOutcome(
  outcome: ToolOutcome,
  log: EventLog,
  record: EventRecord,
): ToolOutcome {
  const binding = Object.freeze({
    log,
    seq: record.seq,
    hash: record.hash,
    canonicalRecord: canonicalJson(record),
  });
  Object.defineProperty(outcome, RECORDED_OUTPUT, {
    value: binding,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(outcome);
}

export function resolveRecordedToolOutput(log: EventLog, outcome: ToolOutcome): RecordedOutput {
  const descriptor = Object.getOwnPropertyDescriptor(outcome, RECORDED_OUTPUT);
  const binding = descriptor?.value as RecordedOutputBinding | undefined;
  if (!binding) return { ok: false, code: "record_unbound" };
  const identity = { seq: binding.seq, hash: binding.hash };
  if (binding.log !== log || descriptor?.enumerable || descriptor?.writable || descriptor?.configurable) {
    return { ok: false, code: "record_mismatch", ...identity };
  }

  let durable: EventRecord | undefined;
  try {
    const verified = new EventLog(log.path, { readOnly: true });
    const current = log.events.find((event) => event.seq === binding.seq);
    durable = verified.events.find((event) => event.seq === binding.seq);
    if (
      !current
      || !durable
      || current.hash !== binding.hash
      || durable.hash !== binding.hash
      || canonicalJson(current) !== binding.canonicalRecord
      || canonicalJson(durable) !== binding.canonicalRecord
    ) {
      return { ok: false, code: "record_mismatch", ...identity };
    }
  } catch {
    return { ok: false, code: "record_mismatch", ...identity };
  }

  if (durable.kind !== "surface" || durable.name !== "tool/result") {
    return { ok: false, code: "record_mismatch", ...identity };
  }
  const payload = durable.payload;
  const recordedExitCode = payload.exit_code;
  if (
    typeof payload.text !== "string"
    || typeof payload.error !== "boolean"
    || typeof recordedExitCode !== "number"
    || !Number.isSafeInteger(recordedExitCode)
    || payload.error !== (recordedExitCode !== 0)
    || outcome.text !== payload.text
    || outcome.error !== payload.error
    || outcome.exitCode !== recordedExitCode
  ) {
    return { ok: false, code: "record_metadata_invalid", ...identity };
  }
  if (payload.execution !== undefined || outcome.execution !== undefined) {
    if (!isExecutionDiagnostics(payload.execution)
      || canonicalJson(payload.execution) !== canonicalJson(outcome.execution)) {
      return { ok: false, code: "record_metadata_invalid", ...identity };
    }
    return { ok: false, code: "process_completion_unavailable", ...identity };
  }
  const result = { error: payload.error, exitCode: recordedExitCode, identity };
  const state = payload.recorded_output;
  if (state === undefined) {
    return resolveLegacyBlob(log, payload, result);
  }
  if (!isRecordedOutputState(state)) {
    return { ok: false, code: "record_metadata_invalid", ...identity };
  }
  if (state.storage === "withheld") {
    if (payload.blob !== undefined || payload.blob_bytes !== undefined) {
      return { ok: false, code: "record_metadata_invalid", ...identity };
    }
    return { ok: false, code: "output_withheld", ...identity };
  }
  if (state.storage === "inline") {
    if (payload.blob !== undefined || payload.blob_bytes !== undefined) {
      return { ok: false, code: "record_metadata_invalid", ...identity };
    }
    if (containsSecret(payload.text)) return { ok: false, code: "output_withheld", ...identity };
    return {
      ok: true,
      body: payload.text,
      error: payload.error,
      exitCode: recordedExitCode,
      ...identity,
      storage: "inline",
      byteEncoding: "utf8",
      utf8Bytes: Buffer.byteLength(payload.text, "utf8"),
    };
  }
  if (typeof payload.blob !== "string" || !isByteCount(payload.blob_bytes)) {
    return { ok: false, code: "record_metadata_invalid", ...identity };
  }
  return resolveBlob({
    log,
    digest: payload.blob,
    declaredBytes: payload.blob_bytes,
    legacy: false,
    result,
  });
}

function resolveLegacyBlob(
  log: EventLog,
  payload: Readonly<Record<string, unknown>>,
  result: RecordedResultState,
): RecordedOutput {
  if (payload.blob === undefined && payload.blob_bytes === undefined) {
    return { ok: false, code: "legacy_inline_unqualified", ...result.identity };
  }
  if (typeof payload.blob !== "string" || !isByteCount(payload.blob_bytes)) {
    return { ok: false, code: "record_metadata_invalid", ...result.identity };
  }
  return resolveBlob({
    log,
    digest: payload.blob,
    declaredBytes: payload.blob_bytes,
    legacy: true,
    result,
  });
}

function resolveBlob(input: BlobResolution): RecordedOutput {
  const { identity } = input.result;
  let held: ReturnType<typeof openHeldBlobTarget>;
  try {
    held = openHeldBlobTarget(input.digest, input.log);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    return { ok: false, code: message.includes("integrity") ? "blob_integrity" : "output_unavailable", ...identity };
  }
  try {
    try {
      const bytes = Buffer.alloc(held.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(held.fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const returned = bytes.subarray(0, offset);
      if (
        offset !== held.byteLength
        || createHash("sha256").update(returned).digest("hex") !== input.digest.toLowerCase()
      ) {
        return { ok: false, code: "blob_integrity", ...identity };
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(returned);
      } catch {
        return { ok: false, code: "blob_integrity", ...identity };
      }
      const utf8Bytes = Buffer.byteLength(body, "utf8");
      const byteEncoding = input.declaredBytes === utf8Bytes
        ? "utf8"
        : input.legacy && input.declaredBytes === body.length
          ? "legacy_utf16"
          : undefined;
      if (!byteEncoding) return { ok: false, code: "output_size_mismatch", ...identity };
      if (containsSecret(body)) return { ok: false, code: "output_withheld", ...identity };
      return {
        ok: true,
        body,
        error: input.result.error,
        exitCode: input.result.exitCode,
        ...identity,
        storage: "blob",
        byteEncoding,
        utf8Bytes,
      };
    } catch {
      return { ok: false, code: "output_unavailable", ...identity };
    }
  } finally {
    held.close();
  }
}

function isRecordedOutputState(value: unknown): value is { readonly version: 1; readonly storage: "inline" | "blob" | "withheld" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 2
    && "version" in value
    && value.version === 1
    && "storage" in value
    && (value.storage === "inline" || value.storage === "blob" || value.storage === "withheld");
}

function isByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

/** Every retained field describes an observed incomplete or unqualified process outcome. */
function isExecutionDiagnostics(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, field]) => {
    if (key === "raw_exit_code") return field === null;
    if (key === "signal") return typeof field === "string" && field.length > 0;
    if (key === "error") return typeof field === "string";
    return (key === "timed_out" || key === "max_buffer_exceeded" || key === "completion_unavailable") && field === true;
  });
}
