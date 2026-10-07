import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BlobStore } from "./blob-store.ts";
import { canonicalJson } from "./canonical.ts";
import type { EventLog } from "./event-log.ts";
import type { SandboxPolicy } from "./sandbox.ts";
import { policyDigest } from "./sandbox.ts";
import { toolCacheRootOf } from "./sandbox-env.ts";
import { withFixtureFileReader } from "../work/evidence/fixture-files.ts";
import { validateExecutionImage, type ExecutionImage, type ImageEntry } from "../work/evidence/execution-view.ts";
import { assertNoOwnedResourceMounts } from "./owned-resource-mounts.ts";
import { imageMtime, restoreImageMtime } from "./execution-image-time.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const within = (root: string, path: string) => path === root || path.startsWith(root + "/");
const MAX_IMAGE_BYTES = 1024 ** 3, MAX_IMAGE_ENTRIES = 100000;
export class ExecutionViewError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ExecutionViewError"; }
}
const fail = (code: string): never => { throw new ExecutionViewError(code); };

/** Each regular file is read through the existing held-descriptor acquisition.
 * Complete directory/link manifests are checked again before admission. */
function scan(root: string, store: BlobStore, retain: boolean, limits: { bytes: number; entries: number }): ImageEntry[] {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail("execution_image_root_invalid");
  return withFixtureFileReader(root, read => {
    const out: ImageEntry[] = [];
    const walk = (path: string): void => {
      if (++limits.entries > MAX_IMAGE_ENTRIES) fail("execution_image_entry_limit");
      const full = path === "." ? root : join(root, path), stat = lstatSync(full);
      if ((stat.mode & 0o7000) !== 0) fail("execution_image_special_mode");
      if (stat.isDirectory()) {
        if (realpathSync(full) !== full) fail("execution_image_directory_changed");
        out.push({ path, kind: "directory", mode: stat.mode & 0o777, mtime_ns: imageMtime(full) });
        for (const name of readdirSync(full).sort()) {
          if (!name || /[\\\0\r\n]/u.test(name) || name.normalize("NFC") !== name) fail("execution_image_path_invalid");
          walk(path === "." ? name : path + "/" + name);
        }
      } else if (stat.isSymbolicLink()) {
        out.push({ path, kind: "symlink", target: readlinkSync(full) });
      } else if (stat.isFile()) {
        limits.bytes += stat.size;
        if (limits.bytes > MAX_IMAGE_BYTES) fail("execution_image_byte_limit");
        const acquired = read(path, { maxBytes: MAX_IMAGE_BYTES - limits.bytes + stat.size });
        if (acquired.identity !== `${stat.dev}:${stat.ino}` || acquired.bytes.length !== stat.size || acquired.mode !== (stat.mode & 0o777)) fail("execution_image_source_changed");
        const text = canonicalJson({ encoding: "base64", data: acquired.bytes.toString("base64") });
        const blob = retain ? store.put(text) : hash(text);
        out.push({ path, kind: "file", mode: acquired.mode, mtime_ns: imageMtime(full), bytes: acquired.bytes.length, sha256: hash(acquired.bytes), blob, blob_bytes: Buffer.byteLength(text) });
      } else fail("execution_image_file_type");
    };
    walk(".");
    return out;
  });
}

export function captureExecutionImage(log: EventLog, policy: SandboxPolicy): { digest: string; manifest: ExecutionImage } {
  const store = BlobStore.forSession(log.path), roots = [policy.workspaceRoot,
    ...(policy.gitCommonDir && !within(policy.workspaceRoot, policy.gitCommonDir) ? [policy.gitCommonDir] : [])];
  const logTarget = existsSync(log.path) ? realpathSync(log.path) : join(realpathSync(dirname(log.path)), basename(log.path));
  if (roots.some(root => within(root, logTarget) || within(root, join(dirname(logTarget), "blobs")))) fail("execution_image_log_inside_source");
  if (existsSync(join(policy.workspaceRoot, ".git")) && !lstatSync(join(policy.workspaceRoot, ".git")).isDirectory() && !policy.gitCommonDir) fail("execution_image_git_metadata_unavailable");
  const limits = { bytes: 0, entries: 0 };
  const manifest = validateExecutionImage({ schema_version: 1, workspace: policy.workspaceRoot, base_policy: policyDigest(policy),
    runtime: hash(readFileSync(policy.runtimeExecutable)), environment: { ...policy.childEnv },
    // The policy's private roots, its judged tool cache among them (G3',
    // D57h): the same roles the case environment contract names.
    private_roots: { ...(policy.sandboxHome ? { home: policy.sandboxHome } : {}), ...(policy.sandboxTemp ? { temp: policy.sandboxTemp } : {}),
      tool_cache: toolCacheRootOf(policy) },
    trees: roots.map(target => ({ target, entries: scan(target, store, true, limits) })) });
  const readable = [...roots, "/usr", "/bin", "/lib", "/lib64", ...policy.toolchainRoots];
  for (const tree of manifest.trees) for (const item of tree.entries) if (item.kind === "symlink") {
    const target = resolve(dirname(join(tree.target, item.path)), item.target);
    if (!readable.some(root => within(root, target))) fail("execution_image_link_escape");
  }
  assertImageSources(manifest, store, roots);
  const seen = new Set<string>(), sources: { blob: string; blob_bytes: number }[] = [];
  for (const tree of manifest.trees) for (const file of tree.entries) if (file.kind === "file" && !seen.has(file.blob)) {
    const text = store.get(file.blob);
    sources.push({ blob: file.blob, blob_bytes: Buffer.byteLength(text) });
    seen.add(file.blob);
  }
  // Bodies are authenticated above on every capture. Their prior log records
  // remain the retention authority; only new bodies need another observation.
  // Use one append transaction instead of one filesystem lock per source file.
  log.appendBatch(() => {
    const retained = new Map<string, number>();
    for (const row of log.events) if (row.name === "execution_view/source") {
      const blob = String(row.payload.blob), bytes = Number(row.payload.blob_bytes);
      if (retained.has(blob) && retained.get(blob) !== bytes) fail("execution_image_source_record_changed");
      retained.set(blob, bytes);
    }
    return sources.flatMap(payload => {
      if (!retained.has(payload.blob)) return [{ kind: "observe" as const, name: "execution_view/source", payload }];
      if (retained.get(payload.blob) !== payload.blob_bytes) fail("execution_image_source_record_changed");
      return [];
    });
  });
  // Append hooks may change source bytes; no image is admitted from that epoch.
  assertImageSources(manifest, store, roots);
  const digest = store.putAndAppend(log, { kind: "observe", name: "execution_view/image", payload: { schema_version: 1, files: limits.entries, bytes: limits.bytes } }, canonicalJson(manifest));
  return { digest, manifest };
}

export function assertImageSources(image: ExecutionImage, store: BlobStore, roots: readonly string[]): void {
  const limits = { bytes: 0, entries: 0 };
  for (const [i, tree] of image.trees.entries()) if (canonicalJson(scan(roots[i]!, store, false, limits)) !== canonicalJson(tree.entries)) fail("execution_image_source_changed");
}

/** A final source observation does not append or alter the candidate. Retain
 * its complete tree digest in the caller's atomic currentness observation. */
export function observeImageTrees(image: ExecutionImage, store: BlobStore): string {
  const limits = { bytes: 0, entries: 0 };
  const trees = image.trees.map(tree => ({ target: tree.target, entries: scan(tree.target, store, false, limits) }));
  assertImageSources({ ...image, trees }, store, trees.map(tree => tree.target));
  return hash(canonicalJson(trees));
}

export type ExecutionImageResource = Readonly<{ root: string; owner: string }>;
export type MaterializedExecutionImage = Readonly<{ digest: string; workspace: string; runtime: string; resource: ExecutionImageResource; mappings: readonly Readonly<{ source: string; target: string }>[] }>;
const MATERIALIZED = new WeakMap<MaterializedExecutionImage, { root: string; image: ExecutionImage; store: BlobStore }>();

export function materializeExecutionImage(log: EventLog, digest: string, manifest: ExecutionImage): MaterializedExecutionImage {
  if (hash(canonicalJson(manifest)) !== digest) fail("execution_image_digest_mismatch");
  const image = validateExecutionImage(manifest);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dokkabi-execution-image-")));
  try {
    chmodSync(root, 0o700);
    if (image.trees.some(tree => within(tree.target, root) || within(root, tree.target))) fail("execution_image_storage_overlap");
    const owner = canonicalJson({ schema_version: 1, session: hash(resolve(log.path)), image: digest, pid: process.pid });
    writeFileSync(join(root, "owner.json"), owner, { mode: 0o600, flag: "wx" });
    const mappings = materializeExecutionImageInto(log, digest, image, root);
    const value = Object.freeze({ digest, workspace: image.workspace, runtime: image.runtime, resource: Object.freeze({ root, owner: hash(owner) }), mappings });
    MATERIALIZED.set(value, { root, image, store: BlobStore.forSession(log.path) }); assertMaterializedExecutionImage(value);
    return value;
  } catch (error) { removePrivateImage(root); throw error; }
}

/** Write the validated trees of one image into an already allocated owned
 * empty root: tree i becomes root/<i>, exactly the disposable resource
 * layout. The caller owns the root's allocation and its owner descriptor;
 * only the numbered tree directories belong to this writer. R8-02 persistent
 * workspaces materialize their derived standalone image here — there is no
 * second tree walker. */
export function materializeExecutionImageInto(
  log: EventLog,
  digest: string,
  manifest: ExecutionImage,
  root: string,
): Readonly<readonly Readonly<{ source: string; target: string }>[]> {
  if (hash(canonicalJson(manifest)) !== digest) fail("execution_image_digest_mismatch");
  const image = validateExecutionImage(manifest), store = BlobStore.forSession(log.path);
  const stat = lstatSync(root);
  if (realpathSync(root) !== root || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail("execution_image_root_invalid");
  const mappings = image.trees.map((tree, index) => {
    const source = join(root, String(index)); mkdirSync(source, { mode: 0o700 });
    for (const item of tree.entries) {
      const dest = item.path === "." ? source : join(source, item.path);
      if (item.kind === "directory") { if (item.path !== ".") mkdirSync(dest, { mode: 0o700 }); }
      else if (item.kind === "symlink") symlinkSync(item.target, dest);
      else {
        const text = store.get(item.blob), body = JSON.parse(text);
        const bytes = Buffer.from(body.data, "base64");
        if (body.encoding !== "base64" || bytes.toString("base64") !== body.data || Buffer.byteLength(text) !== item.blob_bytes || bytes.length !== item.bytes || hash(bytes) !== item.sha256) fail("execution_image_body_changed");
        writeImageFile(dest, bytes); chmodSync(dest, item.mode); restoreImageMtime(dest, item.mtime_ns);
      }
    }
    for (const item of [...tree.entries].reverse()) if (item.kind === "directory") {
      const path = item.path === "." ? source : join(source, item.path);
      restoreImageMtime(path, item.mtime_ns); chmodSync(path, item.mode);
    }
    return Object.freeze({ source, target: tree.target });
  });
  return Object.freeze(mappings);
}

/** A newly created file has no old tail to truncate. Bun's path-based writer
 * truncates after writing; avoid that extra operation on disposable images. */
function writeImageFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("execution_image_write_incomplete");
      offset += count;
    }
  } finally { closeSync(fd); }
}

export function assertMaterializedExecutionImage(value: MaterializedExecutionImage): void {
  const state = MATERIALIZED.get(value);
  if (!state) throw new ExecutionViewError("execution_image_capability_invalid");
  if (realpathSync(state.root) !== state.root || (lstatSync(state.root).mode & 0o777) !== 0o700) fail("execution_image_capability_invalid");
  if (hash(readFileSync(join(state.root, "owner.json"))) !== value.resource.owner) fail("execution_image_owner_changed");
  assertImageSources(state.image, state.store, value.mappings.map(row => row.source));
}

export function disposeMaterializedExecutionImage(value: MaterializedExecutionImage): void {
  const state = MATERIALIZED.get(value); if (!state) return;
  removePrivateImage(state.root); MATERIALIZED.delete(value);
}

/** Only authenticated private resources of this log can be recovered. A live
 * PID is conservatively retained, including a reused PID; never guessed dead. */
export function recoverExecutionImage(log: EventLog, resource: ExecutionImageResource, image: string): "removed" | "active" {
  const root = resource.root;
  if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith("dokkabi-execution-image-") || resolve(root) !== root) fail("execution_image_recovery_path");
  if (!existsSync(root)) return "removed";
  const stat = lstatSync(root), ownerPath = join(root, "owner.json"), ownerStat = lstatSync(ownerPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 ||
    !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1 || ownerStat.uid !== stat.uid || (ownerStat.mode & 0o777) !== 0o600) fail("execution_image_recovery_owner");
  const bytes = readFileSync(ownerPath), owner = JSON.parse(bytes.toString());
  if (hash(bytes) !== resource.owner || owner.schema_version !== 1 || owner.session !== hash(resolve(log.path)) || owner.image !== image || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail("execution_image_recovery_binding");
  try { process.kill(owner.pid, 0); return "active"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "active"; }
  removePrivateImage(root);
  return "removed";
}

function removePrivateImage(root: string): void {
  const unlock = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) unlock(join(path, name));
    }
  };
  if (existsSync(root)) {
    assertNoOwnedResourceMounts(root);
    unlock(root);
    assertNoOwnedResourceMounts(root);
    rmSync(root, { recursive: true, force: true });
  }
}
