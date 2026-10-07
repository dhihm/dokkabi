import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { archiveRelativePath, decodeArchive, encodeArchive, publishArchive, publishArchiveDirectory, readArchive } from "../../host/safe-archive.ts";
import { logCheckpointSchema, snapshotSessionBytes, type SessionSnapshot } from "./checkpoint.ts";
import { durableResearchFile, researchContains, researchHash, researchRead } from "./environment.ts";
import { sha256Schema } from "./schema.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const path = z.string().refine(value => { try { archiveRelativePath(value); return true; } catch { return false; } });
const reference = z.strictObject({ relation: id, artifact: id });
export const researchArchivePlanSchema = z.strictObject({ schema_version: z.literal(1), id,
  artifacts: z.array(z.strictObject({ id, path, sha256: sha256Schema,
    kind: z.enum(["log", "blob", "specification", "checker", "receipt", "source", "license", "data"]),
    format: z.enum(["opaque", "reference-envelope"]), references: z.array(reference) })).min(1).max(10000),
  sessions: z.array(z.strictObject({ id, log: id, role: z.enum(["parent", "child", "spec", "verifier"]), parent: id.nullable(),
    terminal_receipt: id.nullable() })).min(1).max(64) });
export type ResearchArchivePlan = z.infer<typeof researchArchivePlanSchema>;
export const researchCheckpointSchema = z.strictObject({ schema_version: z.literal(1), kind: z.literal("original-research-checkpoint"),
  scope: z.enum(["stable-prefix", "terminal"]), plan_path: path, plan_sha256: sha256Schema,
  artifacts: z.array(z.strictObject({ id, path, sha256: sha256Schema, bytes: z.number().int().nonnegative(), executable: z.boolean() })),
  sessions: z.array(z.strictObject({ id, log: id, checkpoint: logCheckpointSchema })) });
export type ResearchCheckpoint = z.infer<typeof researchCheckpointSchema>;
export const artifactJson = (value: unknown): Buffer => Buffer.from(canonicalJson(value) + "\n");
const parse = (body: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));

/** Physical containment matters: a lexical sibling through a symlink is not
 * an independent reference. The caller must additionally deny candidate writes
 * to this location with its sandbox; a path check cannot confer that authority. */
export function assertExternalArtifact(root: string, output: string): string {
  const source = physicalPath(root), target = resolve(output), physical = physicalPath(target);
  if (researchContains(source, physical) || researchContains(physical, source)) throw new Error("artifact reference/output must be disjoint from source");
  return target;
}
function physicalPath(input: string): string {
  const target = resolve(input);
  let existing = target; const suffix: string[] = [];
  for (;;) {
    try { lstatSync(existing); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(basename(existing)); existing = dirname(existing);
    }
  }
  if (lstatSync(existing).isSymbolicLink()) throw new Error("artifact location symlink refused");
  return resolve(realpathSync(existing), ...suffix);
}
function privateRead(root: string, relative: string): Buffer {
  if (lstatSync(join(root, relative)).nlink !== 1) throw new Error("aliased research input refused");
  return researchRead(root, relative);
}
export function readResearchCheckpoint(anchorPath: string): ResearchCheckpoint {
  return researchCheckpointSchema.parse(parse(privateRead(dirname(resolve(anchorPath)), basename(anchorPath))));
}

/** Acquire all cooperating session locks in path order, then read and re-read
 * the entire declared closure. No caller receives a partial success. */
export function withResearchSnapshot<T>(rootInput: string, planPath: string, scope: ResearchCheckpoint["scope"],
  consume: (snapshot: { plan: ResearchArchivePlan; checkpoint: ResearchCheckpoint; files: Map<string, Buffer> }) => T): T {
  const root = realpathSync(rootInput), planBytes = privateRead(root, archiveRelativePath(planPath));
  const plan = researchArchivePlanSchema.parse(parse(planBytes)), artifacts = new Map(plan.artifacts.map(row => [row.id, row]));
  const paths = new Set(plan.artifacts.map(row => row.path)), sessions = new Map(plan.sessions.map(row => [row.id, row]));
  if (artifacts.size !== plan.artifacts.length || paths.size !== plan.artifacts.length || paths.has(planPath)
    || sessions.size !== plan.sessions.length || new Set(plan.sessions.map(row => row.log)).size !== plan.sessions.length) throw new Error("duplicate archive identity or path");
  const roots = plan.sessions.filter(row => row.role === "parent");
  if (roots.length !== 1 || roots[0]!.parent !== null) throw new Error("archive requires one session root");
  const ordered = [...plan.sessions].sort((a, b) => { const x = artifacts.get(a.log)?.path ?? a.log, y = artifacts.get(b.log)?.path ?? b.log; return x < y ? -1 : x > y ? 1 : 0; });
  const snapshots = new Map<string, SessionSnapshot>();
  const acquire = (index: number): T => {
    if (index < ordered.length) {
      const session = ordered[index]!, log = artifacts.get(session.log);
      if (log?.kind !== "log") throw new Error("session log unavailable");
      privateRead(root, log.path);
      return snapshotSessionBytes(join(root, log.path), snapshot => { snapshots.set(session.id, snapshot); return acquire(index + 1); });
    }
    const files = new Map<string, Buffer>([[planPath, planBytes]]);
    let totalBytes = planBytes.length;
    for (const artifact of plan.artifacts) {
      const bytes = privateRead(root, artifact.path);
      totalBytes += bytes.length;
      if (totalBytes > 256 * 1024 * 1024) throw new Error("research bundle byte limit exceeded");
      if (researchHash(bytes) !== artifact.sha256) throw new Error("archive artifact digest mismatch");
      files.set(artifact.path, bytes);
      if (artifact.format === "reference-envelope") {
        const body = parse(bytes) as { references?: unknown };
        if (!body || canonicalJson(body.references ?? null) !== canonicalJson(artifact.references)) throw new Error("archive envelope references differ from inventory");
      }
      if (new Set(artifact.references.map(ref => canonicalJson(ref))).size !== artifact.references.length) throw new Error("duplicate archive reference");
    }
    // The declared dependency graph is bounded and must be acyclic. Native log
    // links and blob paths below are checked independently of these declarations.
    const pending = new Map(plan.artifacts.map(row => [row.id, new Set(row.references.map(ref => ref.artifact))]));
    for (const refs of pending.values()) for (const ref of refs) if (!artifacts.has(ref)) throw new Error("archive reference unavailable");
    while (pending.size) {
      const leaves = [...pending].filter(([, refs]) => !refs.size).map(([key]) => key);
      if (!leaves.length) throw new Error("cyclic archive references");
      for (const leaf of leaves) { pending.delete(leaf); for (const refs of pending.values()) refs.delete(leaf); }
    }
    if (plan.artifacts.filter(row => row.kind === "log").length !== sessions.size) throw new Error("unassigned archive log");
    for (const session of plan.sessions) {
      const artifact = artifacts.get(session.log)!, snapshot = snapshots.get(session.id)!;
      if (!files.get(artifact.path)!.equals(snapshot.bytes)) throw new Error("archive session changed during acquisition");
      const visited = new Set([session.id]); let parent = session.parent;
      while (parent !== null) {
        const next = sessions.get(parent);
        if (!next || visited.has(parent)) throw new Error("invalid archive session ancestry");
        visited.add(parent); parent = next.parent;
      }
      if (!visited.has(roots[0]!.id)) throw new Error("disconnected archive session");
      for (const [relative, body] of snapshot.files) {
        if (relative === "events.jsonl") continue;
        const blobPath = dirname(artifact.path) === "." ? relative : `${dirname(artifact.path)}/${relative}`;
        const blob = plan.artifacts.find(row => row.path === blobPath);
        if (blob?.kind !== "blob" || !files.get(blobPath)?.equals(body)
          || !artifact.references.some(ref => ref.relation === "blob" && ref.artifact === blob.id)) throw new Error("native blob closure unavailable");
      }
      for (const event of snapshot.events) {
        if (event.name === "session/open" && event.payload.session_id !== undefined && event.payload.session_id !== session.id) throw new Error("archive session identity mismatch");
        if (event.name === "session/parent" && (event.payload.parent_session !== session.parent || event.payload.child_session !== session.id)) throw new Error("native parent binding differs from archive ancestry");
        const links: { id: unknown; role?: string; hash?: unknown; digest?: unknown }[] = [];
        if (["work/accept", "work/step"].includes(event.name)) for (const role of ["spec", "verifier"] as const) {
          if (event.payload[`${role}_session`] !== undefined) links.push({ id: event.payload[`${role}_session`], role,
            hash: event.payload[`${role}_log_hash`], digest: event.payload[`${role}_digest`] });
        }
        if (event.name.startsWith("swarm/") && event.payload.child_session !== undefined) links.push({ id: event.payload.child_session,
          hash: event.name === "swarm/child_close" ? event.payload.final_hash : undefined,
          digest: event.name === "swarm/child_close" ? event.payload.replay_digest : undefined });
        if (event.name.startsWith("swarm/") && event.payload.reviewer_session !== undefined) links.push({ id: event.payload.reviewer_session });
        if (event.name === "work/step_session") links.push({ id: event.payload.child_session, hash: event.payload.final_hash, digest: event.payload.replay_digest });
        for (const link of links) {
          const child = typeof link.id === "string" ? sessions.get(link.id) : undefined, childLog = child && snapshots.get(child.id);
          if (!child || child.parent !== session.id || (link.role && child.role !== link.role) || !childLog
            || (link.hash !== undefined && link.hash !== childLog.checkpoint.tail_chain)
            || (link.digest !== undefined && link.digest !== childLog.checkpoint.dimensions.projection_sha256)
            || !artifact.references.some(ref => ref.artifact === child.log)) throw new Error("native child/spec/verifier closure mismatch");
        }
      }
      if (scope === "terminal") {
        const terminal = snapshot.events.at(-1);
        if (!terminal || !["work/run_result", "session/close"].includes(terminal.name)) {
          const receipt = session.terminal_receipt && artifacts.get(session.terminal_receipt);
          if (!receipt || receipt.kind !== "receipt") throw new Error("terminal checkpoint requires a terminal observation");
          const observed = z.strictObject({ schema_version: z.literal(1), kind: z.literal("archive-process-exit"), session: id,
            log_sha256: sha256Schema, exit_code: z.number().int().nullable(), signal: z.string().nullable(), references: z.array(reference) }).parse(parse(files.get(receipt.path)!));
          if (observed.session !== session.id || observed.log_sha256 !== snapshot.checkpoint.raw_sha256
            || (observed.exit_code === null && observed.signal === null)
            || !observed.references.some(ref => ref.artifact === session.log)) throw new Error("terminal process observation mismatch");
        }
      }
    }
    const checkpoint: ResearchCheckpoint = { schema_version: 1, kind: "original-research-checkpoint", scope, plan_path: planPath,
      plan_sha256: researchHash(planBytes), artifacts: plan.artifacts.map(row => ({ id: row.id, path: row.path, sha256: row.sha256, bytes: files.get(row.path)!.length, executable: (lstatSync(join(root, row.path)).mode & 0o111) !== 0 })),
      sessions: plan.sessions.map(row => ({ id: row.id, log: row.log, checkpoint: snapshots.get(row.id)!.checkpoint })) };
    for (const [path, bytes] of files) if (!privateRead(root, path).equals(bytes)) throw new Error("research source grew or changed during acquisition");
    const result = consume({ plan, checkpoint, files });
    for (const [path, bytes] of files) if (!privateRead(root, path).equals(bytes)) throw new Error("research source changed while snapshot was held");
    for (const file of checkpoint.artifacts) if (((lstatSync(join(root, file.path)).mode & 0o111) !== 0) !== file.executable) throw new Error("research executable mode changed while snapshot was held");
    return result;
  };
  return acquire(0);
}

export function retainResearchCheckpoint(input: { root: string; planPath: string; anchorPath: string; scope: ResearchCheckpoint["scope"] }): ResearchCheckpoint {
  const anchor = assertExternalArtifact(input.root, input.anchorPath);
  return withResearchSnapshot(input.root, input.planPath, input.scope, snapshot => { durableResearchFile(anchor, artifactJson(snapshot.checkpoint)); return snapshot.checkpoint; });
}
export function withAnchoredResearch<T>(root: string, anchorPath: string, consume: (snapshot: { plan: ResearchArchivePlan; checkpoint: ResearchCheckpoint; files: Map<string, Buffer> }) => T): T {
  assertExternalArtifact(root, anchorPath); const anchor = readResearchCheckpoint(anchorPath), original = artifactJson(anchor);
  return withResearchSnapshot(root, anchor.plan_path, anchor.scope, snapshot => {
    if (!artifactJson(snapshot.checkpoint).equals(original) || !artifactJson(readResearchCheckpoint(anchorPath)).equals(original)) throw new Error("original research checkpoint mismatch");
    return consume(snapshot);
  });
}
function archiveFiles(snapshot: { checkpoint: ResearchCheckpoint; files: Map<string, Buffer> }): Map<string, Buffer> {
  return new Map([["checkpoint.json", artifactJson(snapshot.checkpoint)], ...[...snapshot.files].map(([path, bytes]) => [`bundle/${path}`, bytes] as [string, Buffer])]);
}
function executables(checkpoint: ResearchCheckpoint, prefix = ""): Set<string> {
  return new Set(checkpoint.artifacts.filter(row => row.executable).map(row => prefix + row.path));
}
export function packResearchArchive(input: { root: string; anchorPath: string; archivePath: string }) {
  assertExternalArtifact(input.root, input.archivePath);
  return withAnchoredResearch(input.root, input.anchorPath, snapshot => {
    const bytes = encodeArchive(archiveFiles(snapshot), executables(snapshot.checkpoint, "bundle/")); publishArchive(input.archivePath, bytes);
    return { status: "retained" as const, archive_sha256: researchHash(bytes), checkpoint_sha256: researchHash(artifactJson(snapshot.checkpoint)), scope: snapshot.checkpoint.scope };
  });
}
export function unpackResearchArchive(input: { archivePath: string; anchorPath: string; destDir: string }) {
  assertExternalArtifact(input.destDir, input.archivePath);
  assertExternalArtifact(input.destDir, input.anchorPath);
  const raw = readArchive(input.archivePath), files = decodeArchive(raw), checkpoint = readResearchCheckpoint(input.anchorPath), expected = artifactJson(checkpoint);
  if (!encodeArchive(files, executables(checkpoint, "bundle/")).equals(raw)) throw new Error("research archive must use canonical metadata-free encoding");
  if (!files.get("checkpoint.json")?.equals(expected)) throw new Error("archive does not match external checkpoint");
  const payload = new Map<string, Buffer>();
  for (const [path, bytes] of files) if (path !== "checkpoint.json") {
    if (!path.startsWith("bundle/")) throw new Error("unindexed archive member"); payload.set(path.slice(7), bytes);
  }
  publishArchiveDirectory(input.destDir, payload, staging => withAnchoredResearch(staging, input.anchorPath, snapshot => {
    const exact = archiveFiles(snapshot);
    if (exact.size !== files.size || [...exact].some(([path, bytes]) => !files.get(path)?.equals(bytes))) throw new Error("archive closure mismatch");
  }), executables(checkpoint));
  return { status: "reconstructed" as const, checkpoint_sha256: researchHash(expected) };
}
/** The receipt certifies a current comparison, never permission to delete a
 * live home later. The trusted supervisor must keep writers stopped throughout
 * an actual cleanup; this function intentionally performs no deletion. */
export function checkResearchCleanup(input: { root: string; anchorPath: string; archivePath: string }) {
  return withAnchoredResearch(input.root, input.anchorPath, snapshot => {
    if (snapshot.checkpoint.scope !== "terminal") throw new Error("stable-prefix archive is not eligible for terminal cleanup");
    const raw = readArchive(input.archivePath), files = decodeArchive(raw), exact = archiveFiles(snapshot);
    if (!encodeArchive(files, executables(snapshot.checkpoint, "bundle/")).equals(raw)) throw new Error("research archive must use canonical metadata-free encoding");
    if (files.size !== exact.size || [...exact].some(([path, bytes]) => !files.get(path)?.equals(bytes))) throw new Error("archive closure differs from original checkpoint");
    return { status: "eligible-at-check" as const, source_deleted: false, archive_sha256: researchHash(raw),
      checkpoint_sha256: researchHash(artifactJson(snapshot.checkpoint)), requirement: "supervisor must keep all writers stopped until cleanup" };
  });
}
