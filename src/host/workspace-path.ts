import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type WorkspaceEntryKind = "file" | "directory" | "other";

export interface WorkspaceEntry {
  readonly name: string;
  readonly kind: WorkspaceEntryKind;
  readonly identity: string;
}

/**
 * What the read-only inspection helpers need from a workspace root: a listing
 * that never shows a symlink, file reads limited to private regular files,
 * and a directory check. Linux keeps every step on file descriptors; the
 * portable anchor keeps the same rules on pathnames.
 */
export interface WorkspaceAnchor {
  readonly root: string;
  list(path?: string): WorkspaceEntry[];
  readFile(path: string): Uint8Array;
  assertDirectory(path?: string): void;
  /**
   * The entry kind at one in-workspace path, following nothing: a symlink
   * anywhere on the way refuses (ELOOP), a missing component reports ENOENT,
   * and a file used as an intermediate component reports ENOTDIR.
   */
  kind(path?: string): WorkspaceEntryKind;
  close(): void;
}

/** The anchor this host can provide. */
export function openWorkspaceAnchor(root: string, platform: NodeJS.Platform = process.platform): WorkspaceAnchor {
  return platform === "linux" ? new WorkspacePathAnchor(root) : new PortableWorkspaceAnchor(root);
}

/**
 * The same view on pathnames, for hosts without /proc/self/fd.
 *
 * Every component is lstat'ed and a symlink anywhere on the way refuses, so
 * an inspection cannot be pointed outside the root through a link. What it
 * cannot promise is that the object checked is the object then read — a
 * rename between the two calls is not caught. On these hosts the sandbox,
 * not this class, is the boundary; the tools that bind to it say so.
 */
export class PortableWorkspaceAnchor implements WorkspaceAnchor {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
    if (!statSync(this.root).isDirectory() || this.root === "/") {
      throw new Error("workspace path anchor requires a non-root directory");
    }
  }

  close(): void {}

  list(path = "."): WorkspaceEntry[] {
    const directory = this.resolveInside(path);
    if (!lstatSync(directory).isDirectory()) throw new Error("workspace path is not a directory");
    const entries: WorkspaceEntry[] = [];
    for (const name of readdirSync(directory)) {
      if (name.includes("\0") || name === "." || name === "..") continue;
      try {
        const stats = lstatSync(join(directory, name));
        if (stats.isSymbolicLink()) continue;
        if (stats.isFile() && !isPrivateRegularFile(stats)) continue;
        entries.push({ name, kind: entryKind(stats), identity: `${stats.dev}:${stats.ino}` });
      } catch {
        // A disappearing entry or a permission failure is not a workspace
        // object this view can expose.
      }
    }
    return entries;
  }

  readFile(path: string): Uint8Array {
    const file = this.resolveInside(path);
    if (!isPrivateRegularFile(lstatSync(file))) throw new Error("workspace path is not a private regular file");
    return readFileSync(file);
  }

  assertDirectory(path = "."): void {
    if (!lstatSync(this.resolveInside(path)).isDirectory()) throw new Error("workspace path is not a directory");
  }

  kind(path = "."): WorkspaceEntryKind {
    return entryKind(lstatSync(this.resolveInside(path)));
  }

  private resolveInside(path: string): string {
    let current = this.root;
    for (const part of workspaceParts(path)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        // The code lets callers classify the refusal without parsing text.
        throw Object.assign(new Error("workspace path crosses a symlink"), { code: "ELOOP" });
      }
    }
    return current;
  }
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const EXISTING_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * An fd-relative workspace capability for Linux hosts.
 *
 * Every component is opened from the preceding directory descriptor with
 * O_NOFOLLOW. A rename can therefore make an operation fail or select another
 * object below the already-open root, but it cannot redirect the operation to
 * a symlink outside that root. `/proc/self/fd` is used only as Node's openat
 * spelling; the descriptor, not a previously checked pathname, is authority.
 */
export class WorkspacePathAnchor implements WorkspaceAnchor {
  readonly root: string;
  private rootFd: number | undefined;
  private readonly rootMountId: string;

  constructor(root: string) {
    if (process.platform !== "linux") {
      throw new Error("fd-anchored workspace paths require Linux /proc/self/fd");
    }
    this.root = realpathSync(resolve(root));
    if (!statSync(this.root).isDirectory() || this.root === "/") {
      throw new Error("workspace path anchor requires a non-root directory");
    }
    const rootFd = openSync(this.root, DIRECTORY_FLAGS);
    try {
      this.rootMountId = linuxMountIdForFd(rootFd);
      this.rootFd = rootFd;
    } catch (error) {
      closeSync(rootFd);
      throw error;
    }
  }

  close(): void {
    if (this.rootFd === undefined) return;
    closeSync(this.rootFd);
    this.rootFd = undefined;
  }

  /** Open a private regular file and keep its inode stable for a multi-step
   * tool call. Multi-link files are omitted/refused: a pathname outside the
   * workspace could otherwise name the same inode without crossing a symlink. */
  openFile(path: string, writable = false, hook?: (stage: "parent-opened", parentFd: number) => void): WorkspaceFileHandle {
    const parts = workspaceParts(path);
    if (parts.length === 0) throw new Error("workspace file path is required");
    const { parentFd, name } = this.openParent(parts, false);
    try {
      hook?.("parent-opened", parentFd);
      const fd = this.openOnRootMount(
        childPath(parentFd, name),
        (writable ? constants.O_RDWR : constants.O_RDONLY)
          | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stats = fstatSync(fd);
      if (!isPrivateRegularFile(stats)) {
        closeSync(fd);
        if (stats.isDirectory()) {
          throw Object.assign(new Error("workspace path is a directory"), { code: "EISDIR" });
        }
        throw new Error("workspace path is not a private regular file");
      }
      return new WorkspaceFileHandle(fd, path, stats);
    } finally {
      closeSync(parentFd);
    }
  }

  readFile(path: string): Uint8Array {
    const handle = this.openFile(path);
    try {
      return handle.read();
    } finally {
      handle.close();
    }
  }

  /** Create or replace one regular file without following any path component. */
  writeFile(path: string, content: string | Uint8Array): void {
    const parts = workspaceParts(path);
    if (parts.length === 0) throw new Error("workspace file path is required");
    const { parentFd, name } = this.openParent(parts, true);
    let fd: number | undefined;
    try {
      try {
        fd = this.openOnRootMount(
          childPath(parentFd, name),
          constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (nodeCode(error) !== "ENOENT") throw error;
        fd = this.openOnRootMount(
          childPath(parentFd, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            | constants.O_NONBLOCK | constants.O_NOFOLLOW,
          0o644,
        );
      }
      if (!isPrivateRegularFile(fstatSync(fd))) {
        throw new Error("workspace path is not a private regular file");
      }
      // Validation precedes the first mutation. In particular, an external
      // hardlink is never truncated merely because its workspace alias opened.
      ftruncateSync(fd, 0);
      writeAll(fd, content);
    } finally {
      if (fd !== undefined) closeSync(fd);
      closeSync(parentFd);
    }
  }

  /** Create one NEW regular file (O_CREAT|O_EXCL, no component followed):
   * anything already at the name — a file, a link, a FIFO — is EEXIST and
   * nothing is written (#221 M2). Missing parents are made. `written` runs
   * once the bytes are in. Returns the new file's identity. */
  createFileExclusive(path: string, content: Uint8Array, written?: () => void): string {
    const parts = workspaceParts(path);
    if (parts.length === 0) throw new Error("workspace file path is required");
    const { parentFd, name } = this.openParent(parts, true);
    let fd: number | undefined;
    try {
      fd = this.openOnRootMount(
        childPath(parentFd, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        0o644,
      );
      writeAll(fd, content);
      written?.();
      const stats = fstatSync(fd);
      return `${stats.dev}:${stats.ino}`;
    } finally {
      if (fd !== undefined) closeSync(fd);
      closeSync(parentFd);
    }
  }

  /** List children proven by no-follow opens. Symlinks disappear from views. */
  list(path = "."): WorkspaceEntry[] {
    const directoryFd = this.openDirectory(path);
    try {
      const entries: WorkspaceEntry[] = [];
      for (const name of readdirSync(fdPath(directoryFd))) {
        if (name.includes("\0") || name === "." || name === "..") continue;
        let childFd: number | undefined;
        try {
          childFd = this.openOnRootMount(childPath(directoryFd, name), EXISTING_FLAGS);
          const stats = fstatSync(childFd);
          if (stats.isFile() && !isPrivateRegularFile(stats)) continue;
          entries.push({ name, kind: entryKind(stats), identity: `${stats.dev}:${stats.ino}` });
        } catch {
          // A symlink, socket, disappearing entry, or permission failure is
          // not a workspace object that this capability can safely expose.
        } finally {
          if (childFd !== undefined) closeSync(childFd);
        }
      }
      return entries;
    } finally {
      closeSync(directoryFd);
    }
  }

  assertDirectory(path = "."): void {
    const fd = this.openDirectory(path);
    closeSync(fd);
  }

  kind(path = "."): WorkspaceEntryKind {
    let fd: number;
    try {
      fd = this.openAny(path);
    } catch (error) {
      // A socket cannot be opened at all; it is still not a file or directory.
      if (nodeCode(error) === "ENXIO") return "other";
      throw error;
    }
    try {
      return entryKind(fstatSync(fd));
    } finally {
      closeSync(fd);
    }
  }

  private openAny(path: string): number {
    const parts = workspaceParts(path);
    let current = this.duplicateRoot();
    try {
      for (const part of parts) {
        // No O_DIRECTORY here: the final component may be a file.
        const next = this.openOnRootMount(childPath(current, part), EXISTING_FLAGS);
        closeSync(current);
        current = next;
      }
      return current;
    } catch (error) {
      closeSync(current);
      throw error;
    }
  }

  private openDirectory(path: string): number {
    const parts = workspaceParts(path);
    let current = this.duplicateRoot();
    try {
      for (const part of parts) {
        const next = this.openOnRootMount(childPath(current, part), DIRECTORY_FLAGS);
        closeSync(current);
        current = next;
      }
      return current;
    } catch (error) {
      closeSync(current);
      throw error;
    }
  }

  private openParent(parts: readonly string[], create: boolean): { parentFd: number; name: string } {
    const name = parts.at(-1)!;
    let current = this.duplicateRoot();
    try {
      for (const part of parts.slice(0, -1)) {
        let next: number;
        try {
          next = this.openOnRootMount(childPath(current, part), DIRECTORY_FLAGS);
        } catch (error) {
          if (!create || nodeCode(error) !== "ENOENT") throw error;
          try {
            mkdirSync(childPath(current, part), { mode: 0o755 });
          } catch (mkdirError) {
            if (nodeCode(mkdirError) !== "EEXIST") throw mkdirError;
          }
          next = this.openOnRootMount(childPath(current, part), DIRECTORY_FLAGS);
        }
        closeSync(current);
        current = next;
      }
      return { parentFd: current, name };
    } catch (error) {
      closeSync(current);
      throw error;
    }
  }

  private duplicateRoot(): number {
    if (this.rootFd === undefined) throw new Error("workspace path anchor is closed");
    // The proc entry itself is a trusted magic link to our already-open fd.
    // Make it an intermediate component (`/.`) so O_NOFOLLOW still applies to
    // the addressed directory rather than rejecting the proc magic link.
    return this.openOnRootMount(`${fdPath(this.rootFd)}/.`, DIRECTORY_FLAGS);
  }

  private openOnRootMount(path: string, flags: number, mode?: number): number {
    const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
    try {
      assertLinuxMountId(this.rootMountId, fd);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
}

export class WorkspaceFileHandle {
  private fd: number | undefined;

  constructor(
    fd: number,
    readonly path: string,
    private stats: Stats,
  ) {
    this.fd = fd;
  }

  info(): WorkspaceEntry & { readonly size: number; readonly mtimeMs: number } {
    const stats = this.currentStats();
    return {
      name: this.path.split("/").at(-1) ?? this.path,
      kind: entryKind(stats),
      identity: `${stats.dev}:${stats.ino}`,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  read(): Uint8Array {
    const fd = this.requireFd();
    const chunks: Buffer[] = [];
    let position = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      position += count;
    }
    return Buffer.concat(chunks);
  }

  replace(content: string | Uint8Array): void {
    const fd = this.requireFd();
    ftruncateSync(fd, 0);
    writeAll(fd, content);
    this.stats = fstatSync(fd);
  }

  detach(): { readonly fd: number; readonly stats: Stats } {
    const fd = this.requireFd();
    const stats = this.currentStats();
    this.fd = undefined;
    return { fd, stats };
  }

  close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }

  private currentStats(): Stats {
    this.stats = fstatSync(this.requireFd());
    return this.stats;
  }

  private requireFd(): number {
    if (this.fd === undefined) throw new Error("workspace file handle is closed");
    return this.fd;
  }
}

/**
 * Expand the `~` spelling that model-visible output carries after home-path
 * normalization (host/redact.ts), so the path the model read back is usable
 * as tool input. Only a bare `~` or a `~/…` prefix expands, against the host
 * process's real home directory; `~other/…` is a different account's home and
 * stays untouched. Containment is the caller's existing check: an expansion
 * that lands outside the workspace is refused there like any absolute path.
 */
export function expandHomePath(target: string, homeDir: string = homedir()): string {
  if (target === "~") return homeDir;
  if (!target.startsWith("~/")) return target;
  return join(homeDir, target.slice(2));
}

/** Convert an already lexically confined absolute tool path to helper input. */
export function workspaceRelativePath(root: string, target: string): string {
  const expanded = expandHomePath(target);
  if (!isAbsolute(expanded)) return expanded;
  const canonicalRoot = realpathSync(resolve(root));
  const absolute = resolve(expanded);
  const rel = relative(canonicalRoot, absolute);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return rel || ".";
  throw new Error("path escapes the workspace");
}

/** Parse the kernel-owned mount identity used for an already-open fd. */
export function parseLinuxMountId(fdinfo: string): string {
  const matches = [...fdinfo.matchAll(/^mnt_id:\s*([1-9][0-9]*)\s*$/gmu)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error("Linux fdinfo is missing one canonical mount identity");
  }
  return matches[0][1];
}

export function linuxMountIdForFd(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("invalid workspace file descriptor");
  return parseLinuxMountId(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
}

export function assertLinuxMountId(expected: string, fd: number): void {
  if (!/^[1-9][0-9]*$/u.test(expected) || linuxMountIdForFd(fd) !== expected) {
    throw new Error("workspace path crosses a mount boundary");
  }
}

function workspaceParts(path: string): string[] {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new Error("workspace path must be relative");
  }
  const parts = path.split(/[\\/]/u).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("workspace path escapes its root");
  return parts;
}

function fdPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}

function childPath(fd: number, name: string): string {
  return `${fdPath(fd)}/${name}`;
}

function entryKind(stats: Stats): WorkspaceEntryKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

function isPrivateRegularFile(stats: Stats): boolean {
  return stats.isFile() && stats.nlink === 1;
}

function writeAll(fd: number, content: string | Uint8Array): void {
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  }
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}
