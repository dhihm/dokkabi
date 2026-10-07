import { z } from "zod";
import { readFixtureFile, listFixtureDirectory } from "./fixture-files.ts";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EventLog } from "../../host/event-log.ts";
import { BlobStore } from "../../host/blob-store.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { HOST_FIXED_CHECKER_ENVIRONMENT } from "../../host/sandbox-env.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const fixturePathSchema = z.string().min(1).refine(path => {
  if (isAbsolute(path) || /[\\\0:\r\n]/u.test(path) || path.normalize("NFC") !== path) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}, "fixture path must be a normalized relative path");
const role = z.enum(["entrypoint", "helper", "config", "import", "discovery"]);
export const fixtureFileSchema = z.object({ path: fixturePathSchema, role, sha256: digest, bytes: z.number().int().nonnegative(), mode: z.number().int().min(0).max(0o777), blob: digest, blob_bytes: z.number().int().positive() }).strict();
export const fixtureManifestSchema = z.object({
  schema_version: z.literal(1), id: z.string().min(1), workspace: z.string().min(1), visibility: z.enum(["visible", "hidden"]),
  purpose: z.enum(["deployment_checker", "observer"]).optional(),
  scope: z.literal("acceptance").optional(),
  files: z.array(fixtureFileSchema).min(1),
  directories: z.array(z.object({ path: fixturePathSchema, mode: z.number().int().min(0).max(0o777) }).strict()),
  discovery_roots: z.array(fixturePathSchema),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()),
  environment_absent: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
  commands: z.array(z.string().min(1)).min(1),
  excluded_candidate_roots: z.array(fixturePathSchema),
  absent_paths: z.array(fixturePathSchema),
}).strict();
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
export type FixtureFile = z.infer<typeof fixtureFileSchema>;
export type FixtureClosure = {
  id: string; workspace: string; sourceRoot?: string; visibility: "visible" | "hidden";
  scope?: "acceptance";
  purpose?: "deployment_checker" | "observer";
  files: readonly { path: string; role: FixtureFile["role"] }[];
  discoveryRoots?: readonly string[];
  environment: Readonly<Record<string, string>>;
  commands: readonly string[];
  excludedCandidateRoots?: readonly string[];
  absentPaths?: readonly string[];
};
export const fixtureHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const FIXTURE_BODY_EVENTS = new Set(["fixture/source", "fixture/enrolled", "fixture/candidate", "fixture/preparation", "fixture/environment"]);

export class FixturePreparationError extends Error {
  readonly status = "evaluator_error" as const;
  constructor(readonly code: string, detail?: string) { super(`evaluator_error: ${code}${detail ? `: ${detail}` : ""}`); this.name = "FixturePreparationError"; }
}
export function fixtureRoot(workspace: string): string {
  const path = resolve(workspace);
  if (lstatSync(path).isSymbolicLink()) throw new FixturePreparationError("unsafe_workspace");
  const root = realpathSync(path);
  if (root === "/" || !lstatSync(root).isDirectory()) throw new FixturePreparationError("unsafe_workspace");
  return root;
}
export function fixtureTarget(root: string, raw: string, allowMissing = false): string {
  const path = fixturePathSchema.parse(raw); const target = join(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new FixturePreparationError("path_escape", path);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    let st;
    try { st = lstatSync(cursor); } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) throw new FixturePreparationError("unsafe_path_type", path);
  }
  return target;
}
export function recordFixtureBody(log: EventLog, name: string, body: unknown, payload: Record<string, unknown> = {}): string {
  if (log.isReadOnly) throw new FixturePreparationError("replay_cannot_prepare");
  const text = canonicalJson(body);
  return BlobStore.forSession(log.path).putAndAppend(log, { kind: "observe", name, payload }, text);
}
export function validateFixtureManifest(raw: unknown): FixtureManifest {
  const manifest = fixtureManifestSchema.parse(raw);
  const folded = new Set<string>();
  const components = new Map<string, string>();
  for (const file of manifest.files) {
    ownFixturePath(components, file.path);
    const key = file.path.toLowerCase();
    if (folded.has(key)) throw new FixturePreparationError("path_collision", file.path);
    folded.add(key);
  }
  for (const file of manifest.files) for (const other of manifest.files) {
    if (file.path !== other.path && other.path.startsWith(file.path + "/")) throw new FixturePreparationError("file_directory_collision");
  }
  if (!manifest.files.some(file => file.role === "entrypoint")) throw new FixturePreparationError("entrypoint_missing");
  if (new Set(manifest.commands).size !== manifest.commands.length) throw new FixturePreparationError("duplicate_command");
  const directories = new Set<string>();
  for (const directory of manifest.directories) {
    ownFixturePath(components, directory.path);
    if (directories.has(directory.path)) throw new FixturePreparationError("duplicate_directory");
    directories.add(directory.path);
    if (manifest.files.some(file => directory.path === file.path || directory.path.startsWith(file.path + "/"))) throw new FixturePreparationError("file_directory_collision");
  }
  for (const path of [...manifest.discovery_roots, ...manifest.excluded_candidate_roots, ...manifest.absent_paths]) ownFixturePath(components, fixturePathSchema.parse(path));
  for (const path of manifest.discovery_roots) if (!directories.has(path)) throw new FixturePreparationError("discovery_directory_missing");
  const requiredPaths = [...manifest.files.map(file => file.path), ...manifest.directories.map(directory => directory.path)];
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i += 1) if (!directories.has(parts.slice(0, i).join("/"))) throw new FixturePreparationError("checker_directory_missing");
  }
  for (const excluded of [...manifest.excluded_candidate_roots, ...manifest.absent_paths]) if (requiredPaths.some(path => path === excluded || path.startsWith(excluded + "/"))) throw new FixturePreparationError("excluded_checker");
  if (manifest.environment_absent.some(key => key in manifest.environment)) throw new FixturePreparationError("environment_binding_conflict");
  if (manifest.absent_paths.some(path => manifest.files.some(file => file.path === path || file.path.startsWith(path + "/")))) throw new FixturePreparationError("absent_path_conflict");
  for (const excluded of manifest.excluded_candidate_roots) if (manifest.files.some(file => file.path === excluded || file.path.startsWith(excluded + "/"))) throw new FixturePreparationError("excluded_checker");
  return manifest;
}

/** The enrollment a checker closure would make, with every refusal it can
 * make, read-only: nothing is stored or appended (#230 round 5, B0 — a boot's
 * prepare phase calls this; its commit phase enrolls what it returns). */
export interface PreparedFixtureEnrollment {
  readonly root: string;
  readonly manifest: FixtureManifest;
  readonly bodies: readonly { readonly path: string; readonly text: string }[];
}

/** Only a trusted host provider enrolls a complete checker closure before candidate work. */
export function enrollFixture(log: EventLog, input: FixtureClosure): { digest: string; manifest: FixtureManifest } {
  return commitFixtureEnrollment(log, prepareFixtureEnrollment(log, input));
}

export function commitFixtureEnrollment(log: EventLog, prepared: PreparedFixtureEnrollment): { digest: string; manifest: FixtureManifest } {
  const { root, manifest, bodies } = prepared;
  const store = BlobStore.forSession(log.path);
  for (const body of bodies) {
    const blob = store.put(body.text);
    log.append({ kind: "observe", name: "fixture/source", payload: { fixture_id: manifest.id, workspace: root, path: body.path, visibility: manifest.visibility, blob, blob_bytes: Buffer.byteLength(body.text) } });
  }
  const hash = recordFixtureBody(log, "fixture/enrolled", manifest, { fixture_id: manifest.id, workspace: root, visibility: manifest.visibility });
  return { digest: hash, manifest };
}

export function prepareFixtureEnrollment(log: EventLog, input: FixtureClosure): PreparedFixtureEnrollment {
  const { root, manifest, bodies } = acquireFixtureClosure(input);
  if (log.events.some(e => e.name === "fixture/enrolled" && e.payload.workspace === root && e.payload.fixture_id === input.id)) throw new FixturePreparationError("fixture_already_enrolled");
  return { root, manifest, bodies };
}

/** The descriptor-safe acquisition every enrollment path shares: the
 * complete closure re-read from the trusted source with every gate —
 * discovery, modes, identities, absences — and the manifest it pins. */
function acquireFixtureClosure(input: FixtureClosure): { root: string; manifest: FixtureManifest; bodies: { path: string; text: string }[] } {
  const root = fixtureRoot(input.workspace); const sourceRoot = fixtureRoot(input.sourceRoot ?? input.workspace); const selected = new Map(input.files.map(file => [file.path, file.role]));
  if (selected.size !== input.files.length) throw new FixturePreparationError("duplicate_path");
  const directories = new Map<string, number>();
  const directory = (path: string): void => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      const st = lstatSync(fixtureTarget(sourceRoot, parent));
      if (!st.isDirectory() || (st.mode & 0o7000) !== 0) throw new FixturePreparationError("unsafe_directory_mode", parent);
      directories.set(parent, st.mode & 0o777);
    }
  };
  const walk = (path: string): void => {
    const target = fixtureTarget(sourceRoot, path); const st = lstatSync(target);
    if (st.isDirectory()) { directory(path); for (const entry of listFixtureDirectory(sourceRoot, path)) walk(path + "/" + entry.name); }
    else if (!selected.has(path)) selected.set(path, "discovery");
  };
  for (const path of input.discoveryRoots ?? []) walk(path);
  const bodies: { path: string; text: string }[] = [];
  const files = [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([path, fileRole]) => {
    if (path.includes("/")) directory(path.slice(0, path.lastIndexOf("/")));
    const target = fixtureTarget(sourceRoot, path); const st = lstatSync(target);
    if (!st.isFile() || (st.mode & 0o7000) !== 0) throw new FixturePreparationError("unsafe_file_mode", path);
    const acquired = readFixtureFile(sourceRoot, path); const bytes = acquired.bytes;
    if (`${st.dev}:${st.ino}` !== acquired.identity || bytes.length !== st.size) throw new FixturePreparationError("source_changed", path);
    const text = canonicalJson({ encoding: "base64", data: bytes.toString("base64") }); bodies.push({ path, text });
    return { path, role: fileRole, sha256: fixtureHash(bytes), bytes: bytes.length, mode: acquired.mode, blob: fixtureHash(text), blob_bytes: Buffer.byteLength(text) };
  });
  for (const path of input.absentPaths ?? []) {
    try { lstatSync(fixtureTarget(sourceRoot, path, true)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new FixturePreparationError("expected_absent_path_exists", path);
  }
  const manifest = validateFixtureManifest({ schema_version: 1, id: input.id, workspace: root, visibility: input.visibility, ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.scope ? { scope: input.scope } : {}), files, directories: [...directories].sort(([a], [b]) => a.localeCompare(b)).map(([path, mode]) => ({ path, mode })), discovery_roots: [...input.discoveryRoots ?? []], environment: { ...input.environment }, environment_absent: ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTEST_ADDOPTS", "PYTEST_PLUGINS", "PYTEST_DISABLE_PLUGIN_AUTOLOAD"].filter(key => !(key in input.environment)), commands: [...input.commands], excluded_candidate_roots: [...input.excludedCandidateRoots ?? []], absent_paths: [...input.absentPaths ?? []] });
  return { root, manifest, bodies };
}

export function readFixtureEnrollment(log: EventLog, workspace: string): { digest: string; manifest: FixtureManifest } | undefined {
  const root = fixtureRoot(workspace);
  const events = log.events.filter(e => e.name === "fixture/enrolled" && e.payload.workspace === root);
  if (!events.length) return undefined;
  if (events.length !== 1) throw new FixturePreparationError("ambiguous_fixture_enrollment");
  const event = events[0]!; const hash = digest.parse(event.payload.blob);
  if (log.events.some(e => e.name === "fixture/revoked" && e.seq > event.seq && e.payload.fixture_digest === hash)) throw new FixturePreparationError("fixture_revoked");
  const body = BlobStore.forSession(log.path).get(hash);
  if (Buffer.byteLength(body) !== event.payload.blob_bytes) throw new FixturePreparationError("manifest_size_mismatch");
  const manifest = validateFixtureManifest(JSON.parse(body));
  if (manifest.workspace !== root || manifest.id !== event.payload.fixture_id || manifest.visibility !== event.payload.visibility) throw new FixturePreparationError("manifest_binding_mismatch");
  return { digest: hash, manifest };
}

export function readFixtureBytes(log: EventLog, file: FixtureFile): Buffer {
  const body = BlobStore.forSession(log.path).get(file.blob);
  if (Buffer.byteLength(body) !== file.blob_bytes) throw new FixturePreparationError("source_blob_size", file.path);
  const parsed = z.object({ encoding: z.literal("base64"), data: z.string() }).strict().parse(JSON.parse(body));
  const bytes = Buffer.from(parsed.data, "base64");
  if (bytes.toString("base64") !== parsed.data || bytes.length !== file.bytes || fixtureHash(bytes) !== file.sha256) throw new FixturePreparationError("source_blob_mismatch", file.path);
  return bytes;
}

/** A boot's prepared catalog authority (R8-06j3): the closure freshly
 * acquired from the trusted source and — when the session already retains
 * exactly that enrollment — the retained descriptor the commit phase must
 * return unchanged instead of enrolling again. */
export interface PreparedBootFixtureEnrollment {
  readonly root: string;
  readonly manifest: FixtureManifest;
  readonly bodies: readonly { readonly path: string; readonly text: string }[];
  readonly retained?: { readonly digest: string; readonly manifest: FixtureManifest };
}

const bootFixturePreparations = new WeakMap<PreparedBootFixtureEnrollment, string>();

function pinBootPreparation(prepared: PreparedBootFixtureEnrollment): PreparedBootFixtureEnrollment {
  bootFixturePreparations.set(prepared, fixtureHash(canonicalJson(prepared)));
  return prepared;
}

/** The complete pinned manifest must be the retained one — identity, bytes,
 * modes, commands, environment, discovery, absences, exclusions — not just
 * the fields a caller might think suffice. */
function retainedMatchesClosure(expected: FixtureManifest, retained: { digest: string; manifest: FixtureManifest }): boolean {
  return expected.id === retained.manifest.id
    && expected.workspace === retained.manifest.workspace
    && retained.digest === fixtureHash(canonicalJson(expected))
    && canonicalJson(retained.manifest) === canonicalJson(expected);
}

/** The retained source bodies are the authority a reused boot restores;
 * every one of them is validated, none assumed. */
function validateRetainedSources(log: EventLog, manifest: FixtureManifest): void {
  for (const file of manifest.files) readFixtureBytes(log, file);
}

/** One fixture identity binds one workspace per session: a boot that finds
 * its catalog's fixture retained for another workspace refuses rather than
 * enroll a second binding of the same checker. */
function refuseMovedFixture(log: EventLog, root: string, id: string): void {
  for (const event of log.events) {
    if (event.name !== "fixture/enrolled" || event.payload.fixture_id !== id || event.payload.workspace === root) continue;
    throw new FixturePreparationError("fixture_workspace_changed", `${String(event.payload.workspace)} -> ${root}`);
  }
}

/** The acceptance-catalog boot's prepare phase: reacquire the complete
 * expected closure from the trusted source with every current gate, then
 * read the session's single active retained enrollment. No retention is
 * the original first acquisition; an exact retention with intact bodies is
 * reuse, returned with no write; anything else — changed catalog, changed
 * or moved enrollment, revoked or ambiguous authority, damaged bodies — is
 * a typed refusal (#230 round 5, B0; R8-06j3). */
export function prepareBootFixtureEnrollment(log: EventLog, input: FixtureClosure): PreparedBootFixtureEnrollment {
  const { root, manifest, bodies } = acquireFixtureClosure(input);
  log.refresh();
  const retained = readFixtureEnrollment(log, root);
  if (!retained) { refuseMovedFixture(log, root, input.id); return pinBootPreparation({ root, manifest, bodies }); }
  if (!retainedMatchesClosure(manifest, retained)) throw new FixturePreparationError("fixture_enrollment_changed");
  validateRetainedSources(log, retained.manifest);
  return pinBootPreparation({ root, manifest, bodies, retained });
}

/** The acceptance-catalog boot's commit phase: a reused authority is
 * returned exactly as retained — no put, no append, no re-enrollment —
 * after the log is reread fresh and the active enrollment's identity,
 * complete pinned manifest, digest and source bodies are checked again. A
 * first acquisition commits through the original path only while its
 * absence assumption still holds; authority that changed in between
 * refuses rather than append a duplicate or a silent replacement. */
export function commitBootFixtureEnrollment(log: EventLog, prepared: PreparedBootFixtureEnrollment): { digest: string; manifest: FixtureManifest } {
  const pinned = bootFixturePreparations.get(prepared);
  if (pinned === undefined || pinned !== fixtureHash(canonicalJson(prepared))) throw new FixturePreparationError("fixture_preparation_changed");
  log.refresh();
  const active = readFixtureEnrollment(log, prepared.root);
  if (prepared.retained) {
    if (!active) throw new FixturePreparationError("fixture_enrollment_missing");
    if (active.digest !== prepared.retained.digest || !retainedMatchesClosure(prepared.manifest, active)) throw new FixturePreparationError("fixture_enrollment_changed");
    validateRetainedSources(log, active.manifest);
    return active;
  }
  if (active) throw new FixturePreparationError("fixture_already_enrolled");
  refuseMovedFixture(log, prepared.root, prepared.manifest.id);
  return commitFixtureEnrollment(log, prepared);
}

/** Component spelling is shared by the manifest, discovery policy and candidate tree. */
export function ownFixturePath(owners: Map<string, string>, path: string): void {
  fixturePathSchema.parse(path);
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/"), key = prefix.toLowerCase(), previous = owners.get(key);
    if (previous !== undefined && previous !== prefix) throw new FixturePreparationError("path_collision", path);
    owners.set(key, prefix);
  }
}
export function assertFixtureEnvironment(manifest: FixtureManifest, env: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(manifest.environment)) if (env[key] !== value) throw new FixturePreparationError("checker_environment_changed", key);
  // A key required absent may carry only the host's own fixed value (the G3
  // cache redirect, sandbox-env.ts); any other value is unenrolled.
  for (const key of manifest.environment_absent) if (env[key] !== undefined && env[key] !== HOST_FIXED_CHECKER_ENVIRONMENT[key]) throw new FixturePreparationError("checker_environment_unenrolled", key);
}
