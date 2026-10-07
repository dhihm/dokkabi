import { conditionRemoves } from "../../eval/experiment/condition.ts";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { FIXTURE_BODY_EVENTS, fixtureHash, fixturePathSchema, ownFixturePath, assertFixtureEnvironment, validateFixtureManifest, type FixtureManifest } from "./fixture-manifest.ts";
import type { FixturePreparationReceipt } from "./fixture-prepare.ts";
import type { EvidenceBodies } from "./projection.ts";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const countSchema = z.number().int().nonnegative().safe();
const reasonSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
const visibilitySchema = z.enum(["visible", "hidden"]);
const pointer = { blob: digestSchema, blob_bytes: countSchema };
const sourcePayloadSchema = z.strictObject({ ...pointer, fixture_id: z.string().min(1), workspace: z.string().min(1), visibility: visibilitySchema, path: fixturePathSchema });
const enrollmentPayloadSchema = z.strictObject({ ...pointer, fixture_id: z.string().min(1), workspace: z.string().min(1), visibility: visibilitySchema });
const preparingSchema = z.strictObject({ workspace: z.string().min(1), fixture_digest: digestSchema, visibility: visibilitySchema, command: z.string().min(1), checker_protection: z.literal("ablated").optional() });
const candidatePayloadSchema = z.strictObject({ ...pointer, preparing_seq: countSchema, fixture_digest: digestSchema });
const candidateSchema = z.array(z.strictObject({ path: fixturePathSchema, sha256: digestSchema, bytes: countSchema, mode: z.number().int().min(0).max(0o777) })).max(100000);
const preparationSchema = z.strictObject({
  schema_version: z.literal(1), preparing_seq: countSchema.nullable(), status: z.enum(["prepared", "evaluator_error"]), fixture_digest: digestSchema.nullable(),
  workspace: z.string().min(1), visibility: visibilitySchema, command: z.string(),
  attempted_paths: z.array(fixturePathSchema), completed_paths: z.array(fixturePathSchema), bytes_written: countSchema,
  bytes_verified: countSchema, write_attempts: z.array(z.strictObject({ path: fixturePathSchema, bytes_written: countSchema, status: z.enum(["completed", "failed"]) })),
  checker_protection: z.literal("ablated").optional(),
  candidate_digest: digestSchema.nullable(), reason_code: reasonSchema.optional(), cleanup_reason_code: reasonSchema.optional(),
});
const preparationPayloadSchema = z.strictObject({ ...pointer, status: z.enum(["prepared", "evaluator_error"]), fixture_digest: digestSchema.nullable(), visibility: visibilitySchema, bytes_written: countSchema, bytes_verified: countSchema, cleanup_reason_code: reasonSchema.optional(), attempted_count: countSchema, completed_count: countSchema, reason_code: reasonSchema.optional() });
const executionSchema = z.strictObject({ status: z.literal("evaluator_error"), reason_code: reasonSchema, reason: z.string().min(1) });
const revokedSchema = z.strictObject({ fixture_digest: digestSchema, fixture_id: z.string().min(1), workspace: z.string().min(1) });
const environmentPayloadSchema = z.strictObject({ ...pointer, preparation_ref: digestSchema });
const environmentSchema = z.strictObject({ preparation_ref: digestSchema, environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()) });
const cleanupSchema = z.strictObject({ status: z.enum(["completed", "evaluator_error"]), preparation_ref: digestSchema, reason_code: reasonSchema.optional() });
const integritySchema = z.strictObject({ status: z.enum(["passed", "evaluator_error"]), preparation_ref: digestSchema, reason_code: reasonSchema.optional() });
const sourceSchema = z.strictObject({ encoding: z.literal("base64"), data: z.string() });

export type FixtureReference = { readonly seq: number; readonly name: string; readonly payload: Readonly<Record<string, unknown>> };
export const isFixtureEvent = (name: string): boolean => name.startsWith("fixture/");
export class FixtureReplayError extends Error {
  constructor(readonly code: string) { super(`fixture replay refused: ${code}`); this.name = "FixtureReplayError"; }
}
function fail(code: string): never { throw new FixtureReplayError(code); }
function parse<T>(schema: z.ZodType<T>, raw: unknown, stage: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) return fail(`${stage}_schema_invalid`);
  return result.data;
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function prefix(paths: readonly string[], expected: readonly string[]): boolean { return paths.length <= expected.length && paths.every((path, index) => path === expected[index]); }
function checkReason(status: string, reason: string | undefined): void {
  if ((status === "evaluator_error") !== (reason !== undefined)) fail("error_reason_invalid");
}

/** Authenticate supplied bodies and causal observations without acquiring files or executing any provider. */
export function projectFixtures(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()): { preparations: FixturePreparationReceipt[]; references: FixtureReference[] } {
  const references: FixtureReference[] = [], preparations: FixturePreparationReceipt[] = [];
  const sources = new Map<string, { payload: z.infer<typeof sourcePayloadSchema>; bytes: Buffer; consumed: boolean }>();
  const enrollments = new Map<string, FixtureManifest>(), workspaces = new Set<string>();
  const pending = new Map<number, z.infer<typeof preparingSchema>>(), candidates = new Map<number, string>();
  const prepared = new Map<string, { closed: boolean; cleaned: boolean; fixtureDigest: string; ablated: boolean }>();
  const revoked = new Set<string>();
  let previousSeq = -1;
  for (const event of events) {
    if (!isFixtureEvent(event.name)) continue;
    if (event.seq <= previousSeq) fail("event_order_invalid");
    previousSeq = event.seq;
    if (event.kind !== "observe") fail("observe_event_required");
    references.push({ seq: event.seq, name: event.name, payload: structuredClone(event.payload) });
    if (event.name === "fixture/execution") {
      const body = parse(executionSchema, event.payload, "execution");
      const prefix = `evaluator_error: ${body.reason_code}`;
      if (!preparations.length || (body.reason !== prefix && !body.reason.startsWith(prefix + ": "))) fail("execution_refusal_mismatch");
      continue;
    }
    if (event.name === "fixture/revoked") {
      const body = parse(revokedSchema, event.payload, "revoked"), manifest = enrollments.get(body.fixture_digest);
      if (!manifest || manifest.id !== body.fixture_id || manifest.workspace !== body.workspace || revoked.has(body.fixture_digest)) fail("revoked_enrollment_mismatch");
      revoked.add(body.fixture_digest);
      continue;
    }
    if (event.name === "fixture/preparing") {
      const body = parse(preparingSchema, event.payload, "preparing"), manifest = enrollments.get(body.fixture_digest);
      if (revoked.has(body.fixture_digest)) fail("preparing_fixture_revoked");
      if (!manifest || manifest.workspace !== body.workspace || manifest.visibility !== body.visibility || !manifest.commands.includes(body.command)) fail("preparing_enrollment_mismatch");
      if ((body.checker_protection === "ablated") !== (body.visibility === "visible" && manifest.purpose !== "observer" && conditionRemoves(events.filter(row => row.seq < event.seq), "managed_tests"))) fail("preparing_experiment_policy_mismatch");
      pending.set(event.seq, body);
      continue;
    }
    if (event.name === "fixture/cleanup" || event.name === "fixture/integrity") {
      const body = event.name === "fixture/cleanup" ? parse(cleanupSchema, event.payload, "cleanup") : parse(integritySchema, event.payload, "integrity");
      checkReason(body.status, body.reason_code);
      const receipt = prepared.get(body.preparation_ref);
      if (!receipt || receipt.cleaned || (event.name === "fixture/integrity" && receipt.closed)) fail(`${event.name.slice(8)}_preparation_missing_or_closed`);
      if (event.name === "fixture/integrity" && revoked.has(receipt.fixtureDigest) && (body.status !== "evaluator_error" || body.reason_code !== "fixture_revoked")) fail("integrity_fixture_revoked");
      if (event.name === "fixture/cleanup") { receipt.closed = true; receipt.cleaned = body.status === "completed"; }
      continue;
    }
    if (!FIXTURE_BODY_EVENTS.has(event.name)) fail("unknown fixture event");
    const { blob, blob_bytes } = event.payload;
    if (typeof blob !== "string" || !bodies.has(blob)) fail("body_blob_missing");
    const raw = bodies.get(blob);
    let bytes: string;
    try { bytes = canonicalJson(raw); } catch { return fail("body_blob_integrity_mismatch"); }
    if (fixtureHash(bytes) !== blob || Buffer.byteLength(bytes) !== blob_bytes) fail("body_blob_integrity_mismatch");
    if (event.name === "fixture/source") {
      const payload = parse(sourcePayloadSchema, event.payload, "source"), source = parse(sourceSchema, raw, "source");
      const content = Buffer.from(source.data, "base64");
      if (content.toString("base64") !== source.data) fail("source_encoding_invalid");
      const key = canonicalJson([payload.workspace, payload.fixture_id, payload.path]);
      if (sources.has(key)) fail("source_duplicate");
      sources.set(key, { payload, bytes: content, consumed: false });
    } else if (event.name === "fixture/enrolled") {
      const payload = parse(enrollmentPayloadSchema, event.payload, "enrollment");
      let manifest: FixtureManifest;
      try { manifest = validateFixtureManifest(raw); } catch { return fail("manifest_schema_invalid"); }
      if (payload.fixture_id !== manifest.id || payload.workspace !== manifest.workspace || payload.visibility !== manifest.visibility) fail("enrollment_binding_mismatch");
      if (workspaces.has(manifest.workspace) || enrollments.has(blob)) fail("enrollment_duplicate");
      for (const file of manifest.files) {
        const source = sources.get(canonicalJson([manifest.workspace, manifest.id, file.path]));
        if (!source || source.consumed || source.payload.visibility !== manifest.visibility || source.payload.blob !== file.blob || source.payload.blob_bytes !== file.blob_bytes) fail("source_enrollment_link_mismatch");
        if (source.bytes.length !== file.bytes || fixtureHash(source.bytes) !== file.sha256) fail("source_content_integrity_mismatch");
        source.consumed = true;
      }
      workspaces.add(manifest.workspace); enrollments.set(blob, manifest);
    } else if (event.name === "fixture/candidate") {
      const payload = parse(candidatePayloadSchema, event.payload, "candidate"), files = parse(candidateSchema, raw, "candidate");
      const start = pending.get(payload.preparing_seq);
      if (!start || start.fixture_digest !== payload.fixture_digest || candidates.has(payload.preparing_seq)) fail("candidate_preparing_link_mismatch");
      const paths = new Set<string>(); let totalBytes = 0;
      const manifest = enrollments.get(start.fixture_digest)!, components = new Map<string, string>();
      for (const path of [...manifest.files.map(file => file.path), ...manifest.directories.map(directory => directory.path), ...manifest.discovery_roots, ...manifest.absent_paths, ...manifest.excluded_candidate_roots]) ownFixturePath(components, path);
      for (const file of files) {
        try { ownFixturePath(components, file.path); } catch { return fail("candidate_path_collision"); }
        const path = file.path.toLowerCase();
        if (paths.has(path) || manifest.excluded_candidate_roots.some(root => file.path === root || file.path.startsWith(root + "/"))) fail("candidate_path_collision_or_excluded");
        paths.add(path); totalBytes += file.bytes;
      }
      for (const path of paths) {
        const parts = path.split("/"); parts.pop();
        while (parts.length) { if (paths.has(parts.join("/"))) fail("candidate_path_collision"); parts.pop(); }
      }
      if (totalBytes > 1024 ** 3) fail("candidate_snapshot_limit");
      candidates.set(payload.preparing_seq, blob);
    } else if (event.name === "fixture/environment") {
      const payload = parse(environmentPayloadSchema, event.payload, "environment"), body = parse(environmentSchema, raw, "environment");
      const receipt = prepared.get(body.preparation_ref);
      if (payload.preparation_ref !== body.preparation_ref || !receipt || receipt.closed || revoked.has(receipt.fixtureDigest)) fail("environment_preparation_missing_or_closed");
      try { if (!receipt.ablated) assertFixtureEnvironment(enrollments.get(receipt.fixtureDigest)!, body.environment); } catch { return fail("environment_binding_mismatch"); }
    } else if (event.name === "fixture/preparation") {
      const payload = parse(preparationPayloadSchema, event.payload, "preparation"), body = parse(preparationSchema, raw, "preparation");
      checkReason(body.status, body.reason_code);
      if (body.cleanup_reason_code !== undefined && (body.status !== "evaluator_error" || body.preparing_seq === null)) fail("preparation_cleanup_reason_invalid");
      if (payload.status !== body.status || payload.fixture_digest !== body.fixture_digest || payload.visibility !== body.visibility || payload.reason_code !== body.reason_code
        || payload.bytes_written !== body.bytes_written || payload.bytes_verified !== body.bytes_verified || payload.cleanup_reason_code !== body.cleanup_reason_code || payload.attempted_count !== body.attempted_paths.length || payload.completed_count !== body.completed_paths.length) fail("preparation_summary_mismatch");
      const manifest = body.fixture_digest === null ? undefined : enrollments.get(body.fixture_digest);
      if (body.fixture_digest !== null && (!manifest || manifest.workspace !== body.workspace)) fail("preparation_enrollment_mismatch");
      if (body.preparing_seq === null) {
        if (body.status !== "evaluator_error" || body.candidate_digest !== null || body.attempted_paths.length || body.completed_paths.length || body.write_attempts.length || body.bytes_written !== 0 || body.bytes_verified !== 0) fail("preparation_preflight_accounting_invalid");
      } else {
        const start = pending.get(body.preparing_seq);
        if (!manifest || !start || !same(start, { workspace: body.workspace, fixture_digest: body.fixture_digest, visibility: body.visibility, command: body.command, ...(body.checker_protection ? { checker_protection: body.checker_protection } : {}) })) fail("preparation_pending_link_mismatch");
        const candidate = candidates.get(body.preparing_seq) ?? null;
        if (body.candidate_digest !== candidate || (body.attempted_paths.length > 0 && candidate === null)) fail("preparation_candidate_link_mismatch");
        const paths = body.checker_protection === "ablated" ? [] : manifest.files.map(file => file.path);
        if (!prefix(body.attempted_paths, paths) || !prefix(body.completed_paths, body.attempted_paths) || body.attempted_paths.length - body.completed_paths.length > 1) fail("preparation_path_accounting_invalid");
        const completedBytes = manifest.files.slice(0, body.completed_paths.length).reduce((sum, file) => sum + file.bytes, 0);
        if (body.write_attempts.length !== body.attempted_paths.length) fail("preparation_write_accounting_invalid");
        let writtenBytes = 0;
        for (const [index, attempt] of body.write_attempts.entries()) {
          const file = manifest.files[index]!;
          const completed = index < body.completed_paths.length;
          if (attempt.path !== file.path || attempt.status !== (completed ? "completed" : "failed") || attempt.bytes_written > file.bytes || (completed && attempt.bytes_written !== file.bytes)) fail("preparation_write_accounting_invalid");
          writtenBytes += attempt.bytes_written;
        }
        if (body.bytes_written !== writtenBytes || body.bytes_verified !== completedBytes) fail("preparation_bytes_accounting_invalid");
        if (body.status === "prepared" && (candidate === null || !same(body.completed_paths, paths))) fail("preparation_incomplete");
        pending.delete(body.preparing_seq);
      }
      if (body.status === "prepared") {
        if (prepared.has(blob)) fail("preparation_duplicate");
        prepared.set(blob, { closed: false, cleaned: false, fixtureDigest: body.fixture_digest!, ablated: body.checker_protection === "ablated" });
      }
      preparations.push(body);
    } else {
      fail("unknown fixture event");
    }
  }
  if (pending.size || [...sources.values()].some(source => !source.consumed)) fail("preparation_or_source_incomplete");
  return { preparations, references };
}
