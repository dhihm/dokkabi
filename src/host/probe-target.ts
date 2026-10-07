import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { EventLog } from "./event-log.ts";
import { BlobStore } from "./blob-store.ts";
import { storedName } from "./blob-parts.ts";
import { WorkspacePathAnchor, expandHomePath } from "./workspace-path.ts";
import { directoryPathError, missingPathError, outsideWorkspaceError } from "./path-error.ts";
import { credentialPathRefusal, isSecretWorkspaceTarget } from "./workspace-secrets.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** What probe_log streams, so a directory refusal can say it. */
const PROBE_NEEDS = "probe_log needs a file or a blob:<digest> reference";

export interface HeldTargetFile {
  readonly fd: number;
  readonly byteLength: number;
  readonly close: () => void;
}

export type TargetTraversalHook = (stage: "parent-opened", parentFd: number) => void;

function sanitizeTargetHint(target: string): string {
  if (target.length <= 48) return target;
  return `${target.slice(0, 24)}...${target.slice(-16)}`;
}

/** Open a held file descriptor for a session blob, verifying SHA-256 integrity against the digest. */
export function openHeldBlobTarget(digest: string, log?: EventLog): HeldTargetFile {
  const safeDigest = sanitizeTargetHint(digest);
  if (!SHA256_HEX.test(digest)) throw new Error(`invalid blob digest: ${safeDigest}`);
  if (!log) throw new Error(`cannot resolve blob:${safeDigest} without an active session log`);
  const store = BlobStore.forSession(log.path);
  let blobPath = store.pathOf(digest), scratch: string | undefined;
  if (!existsSync(blobPath)) {
    if (!store.hasParts(digest)) throw new Error(`blob not found: ${safeDigest}`);
    // A body stored as parts (D53) is reassembled — checked against its
    // digest — into a private file that is unlinked once its descriptor is
    // held; the bytes are checked against the digest again below.
    let body: string;
    try { body = store.get(digest); } catch {
      throw new Error(`blob integrity check failed: expected ${safeDigest}`);
    }
    scratch = mkdtempSync(join(tmpdir(), "dokkabi-probe-blob-"));
    blobPath = join(scratch, "body");
    writeFileSync(blobPath, body, { mode: 0o600, flag: "wx" });
  }
  let fd: number;
  try {
    fd = openSync(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err: unknown) {
    throw new Error(`cannot open blob:${safeDigest}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  const stats = fstatSync(fd);
  if (!stats.isFile()) {
    closeSync(fd);
    throw new Error(`blob:${safeDigest} is not a regular file`);
  }
  const hash = createHash("sha256");
  const buf = Buffer.alloc(64 * 1024);
  let bytesRead = 0;
  let totalBytes = 0;
  let position = 0;
  while ((bytesRead = readSync(fd, buf, 0, buf.length, position)) > 0) {
    hash.update(buf.subarray(0, bytesRead));
    totalBytes += bytesRead;
    position += bytesRead;
  }
  const actualDigest = hash.digest("hex");
  if (actualDigest.toLowerCase() !== digest.toLowerCase()) {
    closeSync(fd);
    throw new Error(`blob integrity check failed: expected ${safeDigest}, found ${actualDigest}`);
  }
  let closed = false;
  return {
    fd,
    byteLength: totalBytes,
    close: () => {
      if (closed) return;
      closed = true;
      try { closeSync(fd); } catch {}
    },
  };
}

/**
 * Open a held file descriptor for a workspace path, verifying lexical containment,
 * held directory descriptor anchoring against rename-to-symlink swaps,
 * and private single-link regular file identity.
 */
export function openHeldWorkspaceTarget(
  target: string,
  workspaceRoot: string,
  hook?: TargetTraversalHook,
): HeldTargetFile {
  const hint = sanitizeTargetHint(target);
  const canonicalRoot = realpathSync(resolve(workspaceRoot));
  // A `~/…` target is the home-normalized spelling tool output carries; it
  // expands against the operator's home and is then held to the same
  // containment check as any absolute path.
  const expanded = expandHomePath(target);
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(canonicalRoot, expanded);
  const rel = relative(canonicalRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw outsideWorkspaceError("probe_log", hint);
  }
  if (isSecretWorkspaceTarget(canonicalRoot, resolved)) throw credentialPathRefusal();
  // The workspace root itself is inside, and it is a directory.
  if (rel === "") {
    throw directoryPathError("probe_log", hint, PROBE_NEEDS);
  }

  if (process.platform === "linux") {
    const anchor = new WorkspacePathAnchor(canonicalRoot);
    try {
      const handle = anchor.openFile(rel, false, hook);
      const { fd, stats } = handle.detach();
      let closed = false;
      return {
        fd,
        byteLength: stats.size,
        close: () => {
          if (closed) return;
          closed = true;
          try { closeSync(fd); } catch {}
        },
      };
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") throw missingPathError("probe_log", hint);
      if (err instanceof Error && "code" in err && err.code === "EISDIR") throw directoryPathError("probe_log", hint, PROBE_NEEDS);
      throw new Error(`cannot open workspace file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      anchor.close();
    }
  }

  // Portable descriptor-anchored walk: hold descriptors for root and each parent directory,
  // then re-verify inode and symlink state after opening to preclude parent-swap races.
  const heldDirFds: number[] = [];
  const dirPaths: string[] = [];
  try {
    const rootFd = openSync(canonicalRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
    heldDirFds.push(rootFd);
    dirPaths.push(canonicalRoot);

    const parts = rel.split("/").filter(Boolean);
    let curr = canonicalRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      curr = join(curr, parts[i]!);
      let lstats;
      try { lstats = lstatSync(curr); } catch { throw missingPathError("probe_log", hint); }
      if (lstats.isSymbolicLink()) throw new Error(`workspace path crosses a symlink: ${hint}`);
      const dirFd = openSync(curr, constants.O_RDONLY | constants.O_NOFOLLOW);
      heldDirFds.push(dirFd);
      dirPaths.push(curr);
    }

    hook?.("parent-opened", heldDirFds[heldDirFds.length - 1]!);

    // Verify held directory descriptors still match live parent before open
    for (let i = 0; i < heldDirFds.length; i++) {
      const fdStat = fstatSync(heldDirFds[i]!);
      let checkStat;
      try { checkStat = lstatSync(dirPaths[i]!); } catch { throw new Error(`parent directory swapped during traversal: ${hint}`); }
      if (checkStat.isSymbolicLink() || fdStat.dev !== checkStat.dev || fdStat.ino !== checkStat.ino) {
        throw new Error(`parent directory swapped during traversal: ${hint}`);
      }
    }

    let fileLstats;
    try { fileLstats = lstatSync(resolved); } catch { throw missingPathError("probe_log", hint); }
    if (fileLstats.isSymbolicLink()) throw new Error(`workspace path crosses a symlink: ${hint}`);
    const fileFd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    // Re-verify after open: no directory was swapped to a symlink
    for (let i = 0; i < heldDirFds.length; i++) {
      const fdStat = fstatSync(heldDirFds[i]!);
      let checkStat;
      try { checkStat = lstatSync(dirPaths[i]!); } catch {
        closeSync(fileFd);
        throw new Error(`parent directory swapped during traversal: ${hint}`);
      }
      if (checkStat.isSymbolicLink() || fdStat.dev !== checkStat.dev || fdStat.ino !== checkStat.ino) {
        closeSync(fileFd);
        throw new Error(`parent directory swapped during traversal: ${hint}`);
      }
    }

    const fileFstats = fstatSync(fileFd);
    let recheckFile;
    try { recheckFile = lstatSync(resolved); } catch {
      closeSync(fileFd);
      throw missingPathError("probe_log", hint);
    }
    if (
      recheckFile.isSymbolicLink() ||
      fileFstats.dev !== recheckFile.dev ||
      fileFstats.ino !== recheckFile.ino ||
      !fileFstats.isFile() ||
      fileFstats.nlink !== 1
    ) {
      closeSync(fileFd);
      if (!recheckFile.isSymbolicLink() && fileFstats.isDirectory()) {
        throw directoryPathError("probe_log", hint, PROBE_NEEDS);
      }
      throw new Error(`target is not a private regular file: ${hint}`);
    }

    let closed = false;
    return {
      fd: fileFd,
      byteLength: fileFstats.size,
      close: () => {
        if (closed) return;
        closed = true;
        try { closeSync(fileFd); } catch {}
      },
    };
  } finally {
    for (const dfd of heldDirFds) {
      try { closeSync(dfd); } catch {}
    }
  }
}

/** Resolves and opens a held descriptor for the target, validating integrity and containment. */
/** The blob digest a probe target names, exactly as `openHeldProbeTarget`
 * classifies it (a `blob:` prefix or a bare 64-hex string), or undefined for
 * a workspace path. One classifier, so an authority check made on the
 * digest cannot be bypassed by another spelling of the same target. */
export function probeTargetDigest(target: string): string | undefined {
  if (target.startsWith("blob:")) return target.slice(5).trim();
  if (SHA256_HEX.test(target.trim())) return target.trim();
  return undefined;
}

export function openHeldProbeTarget(
  target: string,
  workspaceRoot: string,
  log?: EventLog,
  hook?: TargetTraversalHook,
): HeldTargetFile {
  const digest = probeTargetDigest(target);
  if (digest) return openHeldBlobTarget(digest, log);
  return openHeldWorkspaceTarget(target, workspaceRoot, hook);
}

/** Resolves a probe target string for callers needing path canonicalization (e.g. tests). */
export function resolveProbeTarget(target: string, workspaceRoot: string, log?: EventLog, hook?: TargetTraversalHook): string {
  const held = openHeldProbeTarget(target, workspaceRoot, log, hook);
  held.close();
  if (target.startsWith("blob:") || SHA256_HEX.test(target.trim())) {
    const digest = target.startsWith("blob:") ? target.slice(5).trim() : target.trim();
    const store = BlobStore.forSession(log!.path);
    return store.hasParts(digest) ? store.fileOf(storedName(digest, "manifest")) : store.pathOf(digest);
  }
  const root = realpathSync(resolve(workspaceRoot));
  const expanded = expandHomePath(target);
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  return realpathSync(resolved);
}
