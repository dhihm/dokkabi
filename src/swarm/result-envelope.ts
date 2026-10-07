import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { Missing } from "../host/schema.ts";
import type { SwarmChildStatus } from "./events.ts";

export interface SwarmResultEnvelopeV1 {
  readonly format: 1;
  readonly dispatchDigest: string;
  readonly childSession: string;
  readonly status: SwarmChildStatus;
  readonly replayDigest: string | Missing;
  readonly finalHash: string | Missing;
  readonly evidenceDigest: string | Missing;
  readonly graphRev: number | Missing;
  readonly planDigest: string | Missing;
  readonly patchDigest: string | Missing;
  readonly summaryDigest: string | Missing;
}

const HEX = /^[a-f0-9]{64}$/;
const ENVELOPE_KEYS = [
  "childSession",
  "dispatchDigest",
  "evidenceDigest",
  "finalHash",
  "format",
  "graphRev",
  "patchDigest",
  "planDigest",
  "replayDigest",
  "status",
  "summaryDigest",
] as const;

function requireObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("swarm result envelope must be an object");
  }
}

function requireExactKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [...ENVELOPE_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("swarm result envelope has unknown or missing fields");
  }
}

function requireDigestOrMissing(value: unknown, label: string): void {
  if (value !== "missing" && (typeof value !== "string" || !HEX.test(value))) {
    throw new Error(`${label} must be a 64-character lowercase hex digest or missing`);
  }
}

export function assertSwarmResultEnvelope(
  value: unknown,
  expected?: { readonly childSession: string; readonly dispatchDigest: string },
): asserts value is SwarmResultEnvelopeV1 {
  requireObject(value);
  requireExactKeys(value);
  if (value.format !== 1) throw new Error("swarm result envelope format must be 1");
  if (typeof value.dispatchDigest !== "string" || !HEX.test(value.dispatchDigest)) {
    throw new Error("result dispatch digest is invalid");
  }
  if (typeof value.childSession !== "string" || value.childSession.trim().length === 0) {
    throw new Error("result child session is invalid");
  }
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled" &&
    value.status !== "timeout") {
    throw new Error("swarm result status is invalid");
  }
  requireDigestOrMissing(value.replayDigest, "replay digest");
  requireDigestOrMissing(value.finalHash, "final hash");
  requireDigestOrMissing(value.evidenceDigest, "evidence digest");
  requireDigestOrMissing(value.planDigest, "plan digest");
  requireDigestOrMissing(value.patchDigest, "patch digest");
  requireDigestOrMissing(value.summaryDigest, "summary digest");
  if (value.graphRev !== "missing" && (!Number.isSafeInteger(value.graphRev) || Number(value.graphRev) < 0)) {
    throw new Error("graph rev must be a non-negative integer or missing");
  }
  if (expected?.childSession !== undefined && value.childSession !== expected.childSession) {
    throw new Error("result child session does not match dispatch lineage");
  }
  if (expected?.dispatchDigest !== undefined && value.dispatchDigest !== expected.dispatchDigest) {
    throw new Error("result dispatch digest does not match dispatch lineage");
  }
  if (value.status === "completed" && (
    value.replayDigest === "missing" ||
    value.finalHash === "missing" ||
    value.evidenceDigest === "missing" ||
    value.graphRev === "missing" ||
    value.planDigest === "missing" ||
    value.patchDigest === "missing" ||
    value.summaryDigest === "missing"
  )) {
    throw new Error("completed result requires replay, final, evidence, graph, plan, patch, and summary references");
  }
}

export function resultEnvelopeDigest(envelope: SwarmResultEnvelopeV1): string {
  assertSwarmResultEnvelope(envelope);
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}
