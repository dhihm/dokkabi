import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson } from "../../host/canonical.ts";
import { collectReferencedBlobs } from "../../host/blob-store.ts";
import { assembleBody, manifestBodyDigest, type PartsSource } from "../../host/blob-parts.ts";
import { auditReplay, parseReplayEvents } from "../../host/replay-audit.ts";
import { renderEvalJsonl } from "../export.ts";
import { expandExperimentManifest, readBundleFile, sourceDigest } from "./manifest.ts";
import { reconcileAttempts, type IssueSink, type RetainedSource } from "./attempts.ts";
import { artifactSchema, exclusionSchema, externalEnvelopeSchema, exitValueSchema, harnessValueSchema, inventorySchema,
  journalValueSchema, labelValueSchema, oracleValueSchema, type Artifact, type CollectionIssue, type CollectionState } from "./schema.ts";

const utf8 = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const externalKinds = new Set(["process_exit", "oracle_result", "label", "harness_result", "journal"]);
export type ArtifactRow = { source_index: number; id: string | null; status: "retained" | "invalid"; observed_sha256: string | null; source: unknown };

/** Sources are immutable inputs. Collection emits derived rows and refusals,
 * never a synthetic host event or a corrected source result. */
export function collectExperiment(manifestPath: string, inventoryPath = join(dirname(manifestPath), "attempts.json")) {
  const root = resolve(dirname(manifestPath));
  const manifestFile = readBundleFile(root, basename(manifestPath)), manifestHash = sourceDigest(manifestFile.bytes);
  const { manifest, scheduled: schedule } = expandExperimentManifest(JSON.parse(utf8(manifestFile.bytes)));
  const issues: CollectionIssue[] = [];
  const issue: IssueSink = (code, location, context = {}) => issues.push({ code, location, scheduled_key: null, attempt_id: null, artifact_id: null, ...context });
  let rawInventory: unknown = null, inventoryHash: string | null = null;
  let inventoryFile: ReturnType<typeof readBundleFile> | undefined;
  try {
    inventoryFile = readBundleFile(dirname(resolve(inventoryPath)), basename(inventoryPath));
    inventoryHash = sourceDigest(inventoryFile.bytes); rawInventory = JSON.parse(utf8(inventoryFile.bytes));
  } catch { issue("inventory_unreadable", "inventory"); }
  const parsed = inventorySchema.safeParse(rawInventory), inventory = parsed.success ? parsed.data : undefined;
  if (!inventory) issue("invalid_inventory", "inventory");
  if (inventory && inventory.manifest_sha256 !== manifestHash) issue("manifest_digest_mismatch", "inventory.manifest_sha256");
  const artifactRows: ArtifactRow[] = [], sources = new Map<string, RetainedSource>();
  const descriptors = new Map<string, Artifact>(), locations = new Map<string, number[]>();
  const retainedFiles: { path: string; sha256: string }[] = [{ path: manifestFile.path, sha256: manifestHash }];
  if (inventoryFile && inventoryHash) retainedFiles.push({ path: inventoryFile.path, sha256: inventoryHash });
  const rawArtifacts = [...manifest.sources, ...(inventory?.artifacts ?? [])];
  for (const [index, raw] of rawArtifacts.entries()) {
    const decoded = artifactSchema.safeParse(raw), row: ArtifactRow = { source_index: index, id: decoded.success ? decoded.data.id : null,
      status: "invalid", observed_sha256: null, source: raw };
    artifactRows.push(row);
    if (!decoded.success) { issue("invalid_artifact", `artifacts[${index}]`); continue; }
    const artifact = decoded.data, context = { artifact_id: artifact.id };
    locations.set(artifact.id, [...(locations.get(artifact.id) ?? []), index]); descriptors.set(artifact.id, artifact);
    try {
      const file = readBundleFile(root, artifact.path); row.observed_sha256 = sourceDigest(file.bytes);
      // Even corrupt readable bytes are retained under their observed digest.
      retainedFiles.push({ path: file.path, sha256: row.observed_sha256 });
      if (row.observed_sha256 !== artifact.sha256) { issue("artifact_digest_mismatch", `artifacts[${index}]`, context); continue; }
      const source: RetainedSource = { artifact, path: file.path };
      if (artifact.kind === "dokkabi_log" && artifact.source.system !== "dokkabi") throw new Error("native source has external identity");
      if (artifact.kind === "dokkabi_log") source.events = parseReplayEvents(utf8(file.bytes));
      if (externalKinds.has(artifact.kind)) {
        const body = externalEnvelopeSchema.parse(JSON.parse(utf8(file.bytes)));
        if (artifact.source.system !== "external" || body.kind !== artifact.kind || canonicalJson(body.source) !== canonicalJson(artifact.source)
          || canonicalJson(body.references) !== canonicalJson(artifact.references)) throw new Error("external envelope differs from descriptor");
        const valueSchema = body.kind === "process_exit" ? exitValueSchema : body.kind === "oracle_result" ? oracleValueSchema
          : body.kind === "label" ? labelValueSchema : body.kind === "harness_result" ? harnessValueSchema : journalValueSchema;
        valueSchema.parse(body.value); source.body = body;
      }
      row.status = "retained"; sources.set(artifact.id, source);
    } catch (error) { issue((error as { code?: string }).code === "ENOENT" ? "artifact_missing" : "artifact_invalid", `artifacts[${index}]`, context); }
  }
  const invalidate = (id: string, code: string) => {
    sources.delete(id);
    for (const index of locations.get(id) ?? []) artifactRows[index]!.status = "invalid";
    issue(code, "artifacts", { artifact_id: id });
  };
  for (const [id, indices] of locations) if (indices.length > 1) invalidate(id, "duplicate_artifact");
  for (const [id, source] of sources) {
    const refs = source.artifact.references;
    if (new Set(refs.map(ref => canonicalJson(ref))).size !== refs.length) invalidate(id, "duplicate_artifact_reference");
  }
  const dependents = new Map<string, Set<string>>();
  for (const [id, artifact] of descriptors) for (const ref of artifact.references) {
    if (!dependents.has(ref.artifact)) dependents.set(ref.artifact, new Set());
    dependents.get(ref.artifact)!.add(id);
  }
  const propagate = () => {
    const queue = [...descriptors.keys()].filter(id => !sources.has(id));
    for (const [id, source] of sources) if (source.artifact.references.some(ref => !sources.has(ref.artifact))) { invalidate(id, "transitive_reference_unavailable"); queue.push(id); }
    for (let index = 0; index < queue.length; index++) for (const parent of dependents.get(queue[index]!) ?? []) {
      if (sources.has(parent)) { invalidate(parent, "transitive_reference_unavailable"); queue.push(parent); }
    }
  };
  propagate();
  // Topological closure validation avoids unbounded recursion on supplied data.
  const degree = new Map([...sources].map(([id, source]) => [id, new Set(source.artifact.references.map(ref => ref.artifact)).size]));
  const ready = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) for (const parent of dependents.get(ready[index]!) ?? []) {
    if (!degree.has(parent)) continue;
    const next = degree.get(parent)! - 1; degree.set(parent, next); if (next === 0) ready.push(parent);
  }
  for (const [id, count] of degree) if (count > 0) invalidate(id, "cyclic_artifact_reference");
  for (const [id, source] of sources) {
    if (!source.events) continue;
    try {
      const bodies = new Map<string, unknown>();
      // A body stored as parts (D53) has no whole-body artifact: its manifest,
      // lists and parts are blob artifacts of this log, each checked against
      // its own digest, and the reassembly against the body's digest.
      let parts: PartsSource | undefined;
      const partsOf = (): PartsSource => {
        if (parts) return parts;
        const content = new Map<string, string>(), manifests = new Map<string, string>();
        for (const ref of source.artifact.references) {
          const blob = ref.relation === "blob" ? sources.get(ref.artifact) : undefined;
          if (blob?.artifact.kind !== "blob") continue;
          const bytes = readBundleFile(root, blob.artifact.path).bytes;
          if (sourceDigest(bytes) !== blob.artifact.sha256) throw new Error("native blob changed");
          const text = utf8(bytes), described = manifestBodyDigest(text);
          if (described) manifests.set(described, text); else content.set(blob.artifact.sha256, text);
        }
        return parts = { manifest: digest => manifests.get(digest), list: digest => content.get(digest), part: digest => content.get(digest) };
      };
      for (const digest of collectReferencedBlobs(source.events)) {
        const matches = source.artifact.references.filter(ref => ref.relation === "blob" && sources.get(ref.artifact)?.artifact.sha256 === digest);
        let text: string;
        if (matches.length === 0 && partsOf().manifest(digest) !== undefined) text = assembleBody(digest, partsOf());
        else {
          if (matches.length !== 1) throw new Error("native blob is absent or ambiguous");
          const blob = sources.get(matches[0]!.artifact)!;
          if (blob.artifact.kind !== "blob") throw new Error("native blob has wrong kind");
          const bytes = readBundleFile(root, blob.artifact.path).bytes;
          if (sourceDigest(bytes) !== digest) throw new Error("native blob changed");
          text = utf8(bytes);
        }
        const rawTool = source.events.some(event => event.name === "experiment/case_policy")
          && source.events.some(event => event.name === "tool/result" && event.payload.blob === digest);
        if (rawTool) bodies.set(digest, text);
        else { try { bodies.set(digest, JSON.parse(text)); } catch { bodies.set(digest, text); } }
      }
      const audit = auditReplay(source.events, bodies);
      source.replay = { structural: audit.structural.status, semantic: audit.semantic.status,
        digest: audit.projection.digest ?? null, unsupported: audit.semantic.unsupported };
      if (audit.structural.status !== "passed" || audit.semantic.status === "failed") throw new Error("native replay failed");
    } catch { invalidate(id, "native_replay_or_closure_failed"); }
  }
  propagate();
  const reconciled = reconcileAttempts(inventory?.attempts ?? [], schedule, sources, issue);
  const scheduleByKey = new Map(schedule.map(row => [row.key, row]));
  const attemptsBySchedule = new Map<string, typeof reconciled.attempts>();
  for (const row of reconciled.attempts) if (row.scheduled_key) {
    if (!attemptsBySchedule.has(row.scheduled_key)) attemptsBySchedule.set(row.scheduled_key, []);
    attemptsBySchedule.get(row.scheduled_key)!.push(row);
  }
  const assignedLogs = new Set(reconciled.sessions.map(row => row.log));
  const assignedAttempts = new Map<string, Set<string>>();
  for (const row of reconciled.attempts) if (row.id && row.scheduled_key) {
    if (!assignedAttempts.has(row.id)) assignedAttempts.set(row.id, new Set());
    assignedAttempts.get(row.id)!.add(row.scheduled_key);
  }
  for (const [id, source] of sources) {
    if (source.events && !assignedLogs.has(id)) issue("unassigned_native_log", "artifacts", { artifact_id: id });
    if (source.body?.attempt_id !== null && source.body?.attempt_id !== undefined
      && !assignedAttempts.get(source.body.attempt_id)?.has(source.body.scheduled_key)) {
      issue("unassigned_external_result", "artifacts", { artifact_id: id, attempt_id: source.body.attempt_id, scheduled_key: source.body.scheduled_key });
    }
  }
  const exclusions = new Map<string, { reason: string; artifact: string }>();
  for (const [index, raw] of (inventory?.exclusions ?? []).entries()) {
    const decoded = exclusionSchema.safeParse(raw), location = `exclusions[${index}]`;
    if (!decoded.success) { issue("invalid_exclusion", location); continue; }
    const exclusion = decoded.data, source = sources.get(exclusion.artifact), scheduled = scheduleByKey.get(exclusion.scheduled_key);
    if (exclusions.has(exclusion.scheduled_key)) issue("duplicate_exclusion", location, { scheduled_key: exclusion.scheduled_key });
    const body = source?.body;
    if (!scheduled || source?.artifact.kind !== "journal" || !body || body.attempt_id !== null
      || body.scheduled_key !== scheduled.key || journalValueSchema.parse(body.value).reason !== exclusion.reason
      || body.references.filter(ref => ref.relation === "scope" && ref.artifact === scheduled.scope).length !== 1) {
      issue("exclusion_source_mismatch", location, { scheduled_key: exclusion.scheduled_key }); continue;
    }
    exclusions.set(exclusion.scheduled_key, { reason: exclusion.reason, artifact: exclusion.artifact });
  }
  const scheduled = schedule.map(row => {
    const attempts = attemptsBySchedule.get(row.key) ?? [], primary = attempts.filter(attempt => attempt.ordinal === 1);
    const exclusion = exclusions.get(row.key) ?? null;
    let state: CollectionState = !inventory ? "missing" : attempts.length === 0 ? "never_started" : primary.length === 1 ? primary[0]!.state
      : attempts.some(attempt => attempt.state === "corrupt") ? "corrupt" : "duplicate";
    if (attempts.some(attempt => attempt.state === "duplicate")) state = "duplicate";
    if (!attempts.length && !exclusion) issue("scheduled_run_never_started", "schedule", { scheduled_key: row.key });
    if (state !== "complete" && !(exclusion && state === "never_started")) issue("scheduled_run_incomplete", "schedule", { scheduled_key: row.key });
    return { ...row, state: exclusion ? "excluded" as const : state, execution_state: state, exclusion, attempt_count: attempts.length,
      primary_attempt: primary.length === 1 ? primary[0]!.id : null, oracle: primary.length === 1 ? primary[0]!.oracle : "unknown" as const };
  });
  // A fresh read detects source drift during collection without changing input.
  for (const file of retainedFiles) try {
    if (sourceDigest(readBundleFile(dirname(file.path), basename(file.path)).bytes) !== file.sha256) issue("source_changed_during_collection", "sources");
  } catch { issue("source_changed_during_collection", "sources"); }
  const references = rawArtifacts.flatMap((raw, source_index) => {
    const parsed = artifactSchema.safeParse(raw);
    return parsed.success ? parsed.data.references.map((ref, reference_index) => ({ source_index, reference_index, source: parsed.data.id, ...ref })) : [];
  });
  return { schema_version: 1 as const, manifest_sha256: manifestHash, inventory_sha256: inventoryHash,
    publishable: issues.length === 0, denominator: scheduled.length, scheduled, ...reconciled, artifacts: artifactRows, references, issues,
    inputs: { manifest: JSON.parse(utf8(manifestFile.bytes)) as unknown, inventory: rawInventory }, retainedFiles };
}

export type ExperimentCollection = ReturnType<typeof collectExperiment>;

/** A successful marker is written last. SQL and normalized rows are caches;
 * retained input bytes are sufficient to derive them again. */
export async function writeExperimentCollection(result: ExperimentCollection, out: string): Promise<void> {
  mkdirSync(out, { recursive: false, mode: 0o700 });
  const write = (name: string, value: unknown) => writeFileSync(join(out, name), canonicalJson(value) + "\n", { flag: "wx", mode: 0o600 });
  try {
    mkdirSync(join(out, "sources"), { mode: 0o700 });
    const copied = new Set<string>();
    for (const source of result.retainedFiles) {
      const bytes = readBundleFile(dirname(source.path), basename(source.path)).bytes;
      if (sourceDigest(bytes) !== source.sha256) throw new Error("source changed before retention");
      if (!copied.has(source.sha256)) writeFileSync(join(out, "sources", source.sha256), bytes, { flag: "wx", mode: 0o600 });
      copied.add(source.sha256);
    }
    write("inputs.json", result.inputs);
    for (const table of ["scheduled", "attempts", "sessions", "artifacts", "references", "issues"] as const) {
      writeFileSync(join(out, `${table}.jsonl`), renderEvalJsonl(result[table]), { flag: "wx", mode: 0o600 });
    }
    await rebuildExperimentCache(result, join(out, "collection.duckdb"));
    write("summary.json", { schema_version: result.schema_version, manifest_sha256: result.manifest_sha256, inventory_sha256: result.inventory_sha256,
      publishable: result.publishable, denominator: result.denominator, attempts: result.attempts.length, sessions: result.sessions.length,
      artifacts: result.artifacts.length, issues: result.issues.length, retained_source_sha256: [...copied].sort(),
      claim: "Collection completeness only; retained-source consistency does not authenticate original history, oracle truth or research readiness." });
  } catch (error) { write("failure.json", { status: "refused", reason: error instanceof Error ? error.message : String(error) }); throw error; }
}

export async function rebuildExperimentCache(result: ExperimentCollection, path: string): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(path), connection = await instance.connect();
  try {
    await connection.run(readFileSync(new URL("../../../analysis/schema.sql", import.meta.url), "utf8"));
    await connection.run("BEGIN TRANSACTION");
    for (const row of result.scheduled) await connection.run("INSERT INTO scheduled VALUES (?, ?, ?, ?, ?)", [row.key, row.state, row.primary_attempt, row.oracle, canonicalJson(row)]);
    for (const row of result.attempts) await connection.run("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?)", [row.source_index, row.id, row.scheduled_key, row.ordinal, row.state, canonicalJson(row)]);
    for (const row of result.sessions) await connection.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)", [row.attempt_source_index, row.source_index, row.id, row.log, canonicalJson(row)]);
    for (const row of result.artifacts) await connection.run("INSERT INTO artifacts VALUES (?, ?, ?, ?)", [row.source_index, row.id, row.status, canonicalJson(row)]);
    for (const [index, row] of result.references.entries()) await connection.run("INSERT INTO artifact_references VALUES (?, ?, ?, ?)", [index, row.source, row.artifact, canonicalJson(row)]);
    for (const [index, row] of result.issues.entries()) await connection.run("INSERT INTO issues VALUES (?, ?, ?)", [index, row.code, canonicalJson(row)]);
    await connection.run(readFileSync(new URL("../../../analysis/reconcile.sql", import.meta.url), "utf8"));
    const reader = await connection.runAndReadAll("SELECT scheduled_key, attempt_count, session_count FROM reconciliation ORDER BY scheduled_key");
    const actual = reader.getRowObjects().map(row => ({ key: row.scheduled_key, attempts: Number(row.attempt_count), sessions: Number(row.session_count) }));
    const sessionCounts = new Map<string, number>();
    for (const row of result.sessions) sessionCounts.set(row.scheduled_key, (sessionCounts.get(row.scheduled_key) ?? 0) + 1);
    const expected = result.scheduled.map(row => ({ key: row.key, attempts: row.attempt_count, sessions: sessionCounts.get(row.key) ?? 0 }));
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("SQL reconciliation cardinality differs from scheduled input");
    await connection.run("COMMIT");
  } finally { connection.closeSync(); instance.closeSync(); }
}
