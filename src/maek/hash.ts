import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { DecisionRecord, DecisionType, FaultRecord, MaekRowKind, MaekSource } from "./types.ts";

export const DECISION_TYPES = new Set<DecisionType>([
  "FIX_BUG",
  "ADD_TEST",
  "REFACTOR",
  "REJECT",
  "COMPLETE_WORK",
]);

export function isDecisionType(value: unknown): value is DecisionType {
  return (
    value === "FIX_BUG" ||
    value === "ADD_TEST" ||
    value === "REFACTOR" ||
    value === "REJECT" ||
    value === "COMPLETE_WORK"
  );
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function digestQuery(kind: string, query: string, options: unknown): string {
  return sha256(canonicalJson({ kind, query, options: options ?? null }));
}

export function digestRows(rows: unknown): string {
  return sha256(canonicalJson(rows));
}

export function observationId(kind: MaekRowKind, source: MaekSource): string {
  return `${kind}-${sha256(canonicalJson({
    kind,
    session_id: source.session_id,
    seq_start: source.seq_start,
    seq_end: source.seq_end,
    source_hash: source.source_hash,
  }))}`;
}

export function asDecision(row: Record<string, unknown>): DecisionRecord {
  const type = row.decision_type;
  if (!isDecisionType(type)) {
    throw new Error(`unknown decision_type ${String(type)}`);
  }
  return {
    decision_id: String(row.decision_id),
    session_id: String(row.session_id),
    turn_id: Number(row.turn_id),
    symbol_id: row.symbol_id === null || row.symbol_id === undefined ? undefined : String(row.symbol_id),
    decision_type: type,
    rationale: String(row.rationale),
    constraints: readConstraints(row.constraints),
  };
}

export function asFault(row: Record<string, unknown>): FaultRecord {
  const commandDigest = row.command_digest === null || row.command_digest === undefined
    ? undefined
    : requiredDigest(row.command_digest, "command_digest");
  const exitCode = row.exit_code === null || row.exit_code === undefined
    ? "missing"
    : requiredInteger(row.exit_code, "exit_code");
  return {
    fault_id: requiredString(row.fault_id, "fault_id"),
    command: stringIncludingEmpty(row.command, "command"),
    ...(commandDigest ? { command_digest: commandDigest } : {}),
    exit_code: exitCode,
    fault_excerpt: requiredString(row.fault_excerpt, "fault_excerpt"),
    blob_digest: requiredDigest(row.blob_digest, "blob_digest"),
  };
}

function readConstraints(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("invalid MAEK decision constraints JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid MAEK decision constraints object");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid MAEK ${field}`);
  return value;
}

function stringIncludingEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`invalid MAEK ${field}`);
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  const digest = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`invalid MAEK ${field}`);
  return digest;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`invalid MAEK ${field}`);
  return value;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 8;
  }
  return Math.max(1, Math.min(32, Math.floor(limit)));
}
