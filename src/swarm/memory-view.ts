import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import {
  assertNoSecrets,
  collectStrings,
  containsPrivateInfrastructureValue,
} from "../host/redact.ts";

export const SWARM_MEMORY_VIEW_FORMAT = 1 as const;
export const MAX_SWARM_MEMORY_PROVIDERS = 8;
export const MAX_SWARM_MEMORY_VIEW_BYTES = 32_000;
export const MAX_SWARM_MEMORY_SECTION_BYTES = 8_000;
export const MAX_SWARM_MEMORY_CONTENT_BYTES = 10_000;
export const MAX_SWARM_MEMORY_EVIDENCE_DIGESTS = 8;
export const MAX_SWARM_MEMORY_SELECTED_IDS = 16;

const DIGEST = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TRUNCATED_SUFFIX = "\n[memory section truncated by host]";
const RAW_ABSOLUTE_PATH = /(?:file:\/\/\/[^\s"'`)>{\]}]+|(?:^|[\s"'`(=:])(?:~\/|\/(?!\/)[^\s"'`)>{\]}]+|[A-Za-z]:[\\/][^\s"'`)>{\]}]+|\\\\[^\s\\/"'`]+\\[^\s"'`)>{\]}]+))/iu;

export type SwarmMemorySufficiency = "sufficient" | "insufficient";

export interface SwarmMemoryCompileInput {
  readonly repositoryDigest: string;
  readonly sourceSnapshotDigest: string;
  /** Provider query intent. It is never copied into the compiled child view. */
  readonly purpose: string;
}

export interface SwarmMemoryContribution {
  readonly sufficiency: SwarmMemorySufficiency;
  readonly content: string;
  /** Provider-owned immutable revision. Production providers should supply
   * their recorded source/index revision; fixtures may omit it and receive a
   * deterministic evidence-set revision. */
  readonly sourceRevisionDigest?: string;
  /** Ordered stable identities selected by the provider. They live only in
   * the content-addressed view; EventLog/dashboard rows expose the count. */
  readonly selectedIds?: readonly string[];
  readonly evidenceDigests: readonly string[];
}

export type SwarmMemoryContributor = (
  input: SwarmMemoryCompileInput,
) => SwarmMemoryContribution | undefined | Promise<SwarmMemoryContribution | undefined>;

export interface SwarmMemoryProviderContribution {
  readonly providerId: string;
  readonly contribution: SwarmMemoryContribution;
}

export interface SwarmMemorySectionV1 {
  readonly providerId: string;
  readonly sufficiency: SwarmMemorySufficiency;
  readonly content: string;
  readonly contentBytes: number;
  readonly contentDigest: string;
  readonly sourceRevisionDigest: string;
  readonly selectedIds: readonly string[];
  readonly evidenceDigests: readonly string[];
}

export interface SwarmMemoryViewV1 {
  readonly format: typeof SWARM_MEMORY_VIEW_FORMAT;
  readonly repositoryDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly sufficiency: SwarmMemorySufficiency;
  readonly sections: readonly SwarmMemorySectionV1[];
  readonly digest: string;
}

type UnsignedSwarmMemoryViewV1 = Omit<SwarmMemoryViewV1, "digest">;

/**
 * Build the immutable, provider-neutral bytes later bound into child dispatch.
 * Provider order is deliberately left untouched: the registry supplies
 * manifest registration order, while evidence identities are canonicalized.
 */
export function compileSwarmMemoryViewV1(
  input: SwarmMemoryCompileInput,
  contributions: readonly SwarmMemoryProviderContribution[],
): SwarmMemoryViewV1 {
  validateCompileInput(input);
  if (contributions.length > MAX_SWARM_MEMORY_PROVIDERS) {
    throw new Error(`swarm memory provider limit is ${MAX_SWARM_MEMORY_PROVIDERS}`);
  }

  const providerIds = new Set<string>();
  const sections: SwarmMemorySectionV1[] = [];
  let remainingContentBytes = MAX_SWARM_MEMORY_CONTENT_BYTES;

  for (const entry of contributions) {
    assertExactRecord(entry, "swarm memory provider entry", ["providerId", "contribution"]);
    assertSwarmMemoryProviderId(entry.providerId);
    if (providerIds.has(entry.providerId)) {
      throw new Error(`duplicate swarm memory provider ${entry.providerId}`);
    }
    providerIds.add(entry.providerId);

    const contribution = validateContribution(entry.contribution, entry.providerId);
    const normalized = normalizeContent(contribution.content);
    const sectionLimit = Math.min(MAX_SWARM_MEMORY_SECTION_BYTES, remainingContentBytes);
    const bounded = boundedUtf8(normalized, sectionLimit);
    const truncated = bounded !== normalized;
    const contentBytes = Buffer.byteLength(bounded);
    remainingContentBytes -= contentBytes;
    const evidenceDigests = [...new Set(contribution.evidenceDigests)].sort();
    const selectedIds = validateSelectedIds(contribution.selectedIds ?? [], entry.providerId);
    const sourceRevisionDigest = contribution.sourceRevisionDigest ?? sha256(canonicalJson(evidenceDigests));
    assertDigest(sourceRevisionDigest, `provider ${entry.providerId} sourceRevisionDigest`);

    sections.push(Object.freeze({
      providerId: entry.providerId,
      sufficiency: truncated ? "insufficient" : contribution.sufficiency,
      content: bounded,
      contentBytes,
      contentDigest: sha256(bounded),
      sourceRevisionDigest,
      selectedIds: Object.freeze(selectedIds),
      evidenceDigests: Object.freeze(evidenceDigests),
    }));
  }

  const unsigned: UnsignedSwarmMemoryViewV1 = {
    format: SWARM_MEMORY_VIEW_FORMAT,
    repositoryDigest: input.repositoryDigest,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    sufficiency: sections.some((section) => section.sufficiency === "sufficient")
      ? "sufficient"
      : "insufficient",
    sections: Object.freeze(sections),
  };
  const view: SwarmMemoryViewV1 = Object.freeze({
    ...unsigned,
    digest: digestSwarmMemoryViewV1(unsigned),
  });
  validateSwarmMemoryViewV1(view);
  return view;
}

/** Hash only the canonical unsigned body; a view digest never hashes itself. */
export function digestSwarmMemoryViewV1(
  view: UnsignedSwarmMemoryViewV1 | SwarmMemoryViewV1,
): string {
  return sha256(canonicalJson({
    format: view.format,
    repositoryDigest: view.repositoryDigest,
    sourceSnapshotDigest: view.sourceSnapshotDigest,
    sufficiency: view.sufficiency,
    sections: view.sections,
  }));
}

/** Exact, offline validation for a recorded or transported view. */
export function validateSwarmMemoryViewV1(value: unknown): asserts value is SwarmMemoryViewV1 {
  assertExactRecord(value, "SwarmMemoryViewV1", [
    "format",
    "repositoryDigest",
    "sourceSnapshotDigest",
    "sufficiency",
    "sections",
    "digest",
  ]);
  if (value.format !== SWARM_MEMORY_VIEW_FORMAT) throw new Error("invalid swarm memory view format");
  assertDigest(value.repositoryDigest, "repositoryDigest");
  assertDigest(value.sourceSnapshotDigest, "sourceSnapshotDigest");
  assertSufficiency(value.sufficiency, "view");
  assertDigest(value.digest, "digest");
  if (!Array.isArray(value.sections)) throw new Error("swarm memory view sections must be an array");
  if (value.sections.length > MAX_SWARM_MEMORY_PROVIDERS) {
    throw new Error(`swarm memory provider limit is ${MAX_SWARM_MEMORY_PROVIDERS}`);
  }

  const providers = new Set<string>();
  for (const raw of value.sections) {
    assertExactRecord(raw, "swarm memory section", [
      "providerId",
      "sufficiency",
      "content",
      "contentBytes",
      "contentDigest",
      "sourceRevisionDigest",
      "selectedIds",
      "evidenceDigests",
    ]);
    assertSwarmMemoryProviderId(raw.providerId);
    if (providers.has(raw.providerId)) throw new Error(`duplicate swarm memory provider ${raw.providerId}`);
    providers.add(raw.providerId);
    assertSufficiency(raw.sufficiency, `provider ${raw.providerId}`);
    if (typeof raw.content !== "string" || normalizeContent(raw.content) !== raw.content) {
      throw new Error(`swarm memory provider ${raw.providerId} content is not canonical text`);
    }
    const contentBytes = Buffer.byteLength(raw.content);
    if (!Number.isInteger(raw.contentBytes) || raw.contentBytes !== contentBytes) {
      throw new Error(`swarm memory provider ${raw.providerId} content byte count mismatch`);
    }
    if (contentBytes > MAX_SWARM_MEMORY_SECTION_BYTES) {
      throw new Error(`swarm memory provider ${raw.providerId} content exceeds section byte limit`);
    }
    assertDigest(raw.contentDigest, `provider ${raw.providerId} contentDigest`);
    if (raw.contentDigest !== sha256(raw.content)) {
      throw new Error(`swarm memory provider ${raw.providerId} content digest mismatch`);
    }
    assertDigest(raw.sourceRevisionDigest, `provider ${raw.providerId} sourceRevisionDigest`);
    validateSelectedIds(raw.selectedIds, raw.providerId);
    validateEvidenceDigests(raw.evidenceDigests, raw.providerId);
  }

  const totalContentBytes = value.sections.reduce((sum, section) => sum + section.contentBytes, 0);
  if (totalContentBytes > MAX_SWARM_MEMORY_CONTENT_BYTES) {
    throw new Error("swarm memory view content exceeds total byte limit");
  }
  const expectedSufficiency = value.sections.some((section) => section.sufficiency === "sufficient")
    ? "sufficient"
    : "insufficient";
  if (value.sufficiency !== expectedSufficiency) throw new Error("swarm memory view sufficiency mismatch");
  assertSafeMemoryValue(value);
  if (Buffer.byteLength(canonicalJson(value)) > MAX_SWARM_MEMORY_VIEW_BYTES) {
    throw new Error("swarm memory view exceeds canonical byte limit");
  }
  const validated = value as unknown as SwarmMemoryViewV1;
  if (validated.digest !== digestSwarmMemoryViewV1(validated)) {
    throw new Error("swarm memory view digest mismatch");
  }
}

export function assertSwarmMemoryProviderId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new Error("invalid swarm memory provider id");
  }
}

function validateCompileInput(input: SwarmMemoryCompileInput): void {
  assertExactRecord(input, "swarm memory compile input", [
    "repositoryDigest",
    "sourceSnapshotDigest",
    "purpose",
  ]);
  assertDigest(input.repositoryDigest, "repositoryDigest");
  assertDigest(input.sourceSnapshotDigest, "sourceSnapshotDigest");
  if (typeof input.purpose !== "string" || !input.purpose.trim()) {
    throw new Error("swarm memory purpose must be non-empty text");
  }
  assertNoSecrets(input.purpose);
}

function validateContribution(value: unknown, providerId: string): SwarmMemoryContribution {
  assertRecordShape(value, `swarm memory contribution ${providerId}`,
    ["sufficiency", "content", "evidenceDigests"],
    ["sourceRevisionDigest", "selectedIds"]);
  assertSufficiency(value.sufficiency, `provider ${providerId}`);
  if (typeof value.content !== "string") throw new Error(`swarm memory provider ${providerId} content must be text`);
  if (value.sourceRevisionDigest !== undefined) {
    assertDigest(value.sourceRevisionDigest, `provider ${providerId} sourceRevisionDigest`);
  }
  if (value.selectedIds !== undefined) validateSelectedIds(value.selectedIds, providerId);
  validateEvidenceDigests(value.evidenceDigests, providerId, false);
  assertSafeMemoryValue(value);
  return value as unknown as SwarmMemoryContribution;
}

function validateSelectedIds(value: unknown, providerId: string): string[] {
  if (!Array.isArray(value)) throw new Error(`swarm memory provider ${providerId} selected IDs must be an array`);
  if (value.length > MAX_SWARM_MEMORY_SELECTED_IDS) {
    throw new Error(`swarm memory provider ${providerId} selected IDs exceed the limit`);
  }
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}:._-]{0,191}$/u.test(id)) {
      throw new Error(`swarm memory provider ${providerId} selected ID is invalid`);
    }
    if (seen.has(id)) throw new Error(`swarm memory provider ${providerId} selected IDs are not unique`);
    seen.add(id);
    selected.push(id);
  }
  return selected;
}

function validateEvidenceDigests(value: unknown, providerId: string, canonical = true): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`swarm memory provider ${providerId} evidence must be an array`);
  if (value.length > MAX_SWARM_MEMORY_EVIDENCE_DIGESTS) {
    throw new Error(`swarm memory provider ${providerId} evidence exceeds digest limit`);
  }
  for (const digest of value) assertDigest(digest, `provider ${providerId} evidence`);
  if (canonical) {
    const expected = [...new Set(value)].sort();
    if (expected.length !== value.length || expected.some((digest, index) => digest !== value[index])) {
      throw new Error(`swarm memory provider ${providerId} evidence is not canonical`);
    }
  }
}

function assertSafeMemoryValue(value: unknown): void {
  assertNoSecrets(value);
  if (containsPrivateInfrastructureValue(value)) {
    throw new Error("swarm memory content contains a private coordinate");
  }
  if (collectStrings(value).some((text) => RAW_ABSOLUTE_PATH.test(text))) {
    throw new Error("swarm memory content contains a filesystem coordinate");
  }
}

function assertSufficiency(value: unknown, label: string): asserts value is SwarmMemorySufficiency {
  if (value !== "sufficient" && value !== "insufficient") {
    throw new Error(`invalid swarm memory sufficiency for ${label}`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`invalid swarm memory ${label} digest`);
  }
}

function assertExactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid field shape`);
  }
}

function assertRecordShape(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(`${label} has an invalid field shape`);
  }
}

function normalizeContent(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function boundedUtf8(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  if (bytes <= 0) return "";
  const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX);
  if (bytes <= suffixBytes) return utf8Prefix(TRUNCATED_SUFFIX.trimStart(), bytes).trim();
  return `${utf8Prefix(value, bytes - suffixBytes).trimEnd()}${TRUNCATED_SUFFIX}`;
}

function utf8Prefix(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, Math.max(0, bytes)).toString("utf8").replace(/\uFFFD+$/gu, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
