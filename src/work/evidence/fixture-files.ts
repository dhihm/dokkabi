import { dlopen, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { closeSync, constants, openSync, opendirSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getSystemErrorName } from "node:util";
import { fixtureStats, fixtureOpenAt, type FixtureStats } from "./fixture-statx.ts";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_BYTES = 1024 ** 3;
const MAX_ENTRIES = 100000;
type Stage = "root-opened" | "parent-opened" | "file-opened" | "file-read" | "directory-opened" | "directory-listed";
type Hooks = { /** Test instrumentation runs without replacing any validation or read. */ hook?: (stage: Stage) => void };
export type FixtureFileRead = { bytes: Buffer; mode: number; identity: string };
export type FixtureDirectoryEntry = { name: string; kind: "file" | "directory"; identity: string };

export class FixtureFileError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ""}`); this.name = "FixtureFileError";
  }
}

/** Read a bounded private regular file through one held, no-follow descriptor. */
export function readFixtureFile(root: string, path: string, options: Hooks & { maxBytes?: number } = {}): FixtureFileRead {
  return withFixtureFileReader(root, readFile => readFile(path, options), options);
}

/** Synchronous acquisition epoch with one anchored root and its current ancestor
 * chain. This reuses traversal, never file bytes, metadata or verdicts. */
export function withFixtureFileReader<T>(root: string,
  operation: (readFile: (path: string, options?: Hooks & { maxBytes?: number }) => FixtureFileRead) => T,
  options: Hooks = {},
): T {
  return withRoot(root, options, anchor => {
    const parents: { name: string; fd: number }[] = [];
    let active = true;
    try {
      return operation((path, options = {}) => {
        if (!active) throw new FixtureFileError("fixture_acquisition_closed");
        const parts = fixtureParts(path), directory = parts.slice(0, -1);
        const maxBytes = options.maxBytes ?? MAX_BYTES;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) throw new FixtureFileError("fixture_file_limit", path);
        let shared = 0;
        while (shared < parents.length && shared < directory.length && parents[shared]!.name === directory[shared]) shared++;
        while (parents.length > shared) closeSync(parents.pop()!.fd);
        for (let index = shared; index < directory.length; index++) {
          const fd = openChild(anchor, parents.at(-1)?.fd ?? anchor.fd, directory[index]!, DIRECTORY_FLAGS);
          parents.push({ name: directory[index]!, fd });
        }
        const parent = parents.at(-1)?.fd ?? anchor.fd;
        options.hook?.("parent-opened");
        const fd = openAt(parent, parts.at(-1)!, FILE_FLAGS);
        try {
          const before = fixtureStats(fd);
          assertChildMount(anchor, before); assertPrivateFile(before, path);
          if (before.size > BigInt(maxBytes)) throw new FixtureFileError("fixture_file_limit", path);
          options.hook?.("file-opened");
          // Reading only the initially admitted size prevents a growing file from
          // extending an unbounded read. One extra byte detects growth at EOF.
          const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
            if (count === 0) break;
            offset += count;
          }
          const extra = readSync(fd, Buffer.alloc(1), 0, 1, offset);
          options.hook?.("file-read");
          const after = fixtureStats(fd);
          if (offset !== bytes.length || extra !== 0) throw new FixtureFileError("fixture_file_changed", path);
          // A same-size rewrite can retain the same filesystem timestamps.
          // Verify the bytes through the held descriptor before accepting them;
          // positioned reads keep both passes independent of the fd's offset.
          verifyFixtureBytes(fd, bytes, path);
          if (!sameFile(before, after) || !sameFile(after, fixtureStats(fd))) throw new FixtureFileError("fixture_file_changed", path);
          return { bytes, mode: Number(before.mode & 0o777n), identity: identity(before) };
        } finally { closeSync(fd); }
      });
    } finally { active = false; while (parents.length) closeSync(parents.pop()!.fd); }
  });
}

function verifyFixtureBytes(fd: number, bytes: Buffer, path: string): void {
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, bytes.length)));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes.length - offset), offset);
    if (count === 0 || !chunk.subarray(0, count).equals(bytes.subarray(offset, offset + count))) {
      throw new FixtureFileError("fixture_file_changed", path);
    }
    offset += count;
  }
  if (readSync(fd, chunk, 0, 1, offset) !== 0) throw new FixtureFileError("fixture_file_changed", path);
}

/** Unlike workspace browsing, fixture acquisition must never hide unsafe entries. */
export function listFixtureDirectory(root: string, path = ".", options: Hooks & { maxEntries?: number } = {}): FixtureDirectoryEntry[] {
  const parts = path === "." ? [] : fixtureParts(path);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_ENTRIES) throw new FixtureFileError("fixture_directory_limit", path);
  return withRoot(root, options, anchor => {
    const directory = openDirectory(anchor, parts);
    try {
      options.hook?.("directory-opened");
      const before = fixtureStats(directory);
      const names = directoryNames(directory, maxEntries);
      options.hook?.("directory-listed");
      const entries = names.map(name => {
        if (!validPart(name)) throw new FixtureFileError("invalid_fixture_path", name);
        const fd = openChild(anchor, directory, name, FILE_FLAGS);
        try {
          const stats = fixtureStats(fd);
          if (stats.isDirectory()) return { name, kind: "directory" as const, identity: identity(stats) };
          assertPrivateFile(stats, name);
          return { name, kind: "file" as const, identity: identity(stats) };
        } finally { closeSync(fd); }
      });
      if (!sameFile(before, fixtureStats(directory))) throw new FixtureFileError("fixture_directory_changed", path);
      return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } finally { closeSync(directory); }
  });
}

type RootAnchor = { fd: number; dev: bigint; mountId?: string };
function withRoot<T>(root: string, options: Hooks, operation: (anchor: RootAnchor) => T): T {
  let fd: number | undefined;
  try {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new FixtureFileError("fixture_platform_unsupported");
    // Callers supply fixtureRoot's canonical absolute directory. Opening every
    // component, including root ancestors, refuses a swapped root symlink.
    if (!isAbsolute(root) || root !== resolve(root) || root === "/" || root.includes("\0")) throw new FixtureFileError("unsafe_workspace");
    fd = openSync("/", DIRECTORY_FLAGS);
    for (const part of root.slice(1).split("/")) {
      const next = openAt(fd, part, DIRECTORY_FLAGS); closeSync(fd); fd = next;
    }
    const stats = fixtureStats(fd);
    const anchor: RootAnchor = { fd, dev: stats.dev, ...(stats.mountId ? { mountId: stats.mountId } : {}) };
    options.hook?.("root-opened");
    return operation(anchor);
  } catch (error) {
    if (error instanceof FixtureFileError) throw error;
    throw new FixtureFileError((error as NodeJS.ErrnoException)?.code ?? "fixture_file_access_failed");
  } finally { if (fd !== undefined) closeSync(fd); }
}

function openDirectory(anchor: RootAnchor, parts: readonly string[]): number {
  let current = openChild(anchor, anchor.fd, ".", DIRECTORY_FLAGS);
  try {
    for (const part of parts) {
      const next = openChild(anchor, current, part, DIRECTORY_FLAGS); closeSync(current); current = next;
    }
    return current;
  } catch (error) { closeSync(current); throw error; }
}

function openChild(anchor: RootAnchor, parent: number, name: string, flags: number): number {
  const fd = openAt(parent, name, flags);
  try {
    assertChildMount(anchor, fixtureStats(fd));
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function assertChildMount(anchor: RootAnchor, stats: FixtureStats): void {
  if (stats.dev !== anchor.dev) throw new FixtureFileError("fixture_mount_boundary");
  if (anchor.mountId !== undefined) {
    if (stats.mountId !== anchor.mountId) throw new FixtureFileError("fixture_mount_boundary");
  }
}

function fixtureParts(path: string): string[] {
  if (!path || isAbsolute(path) || path.length > 4096 || !path.split("/").every(validPart)) throw new FixtureFileError("invalid_fixture_path", path);
  return path.split("/");
}
function validPart(part: string): boolean {
  return part !== "" && part !== "." && part !== ".." && !/[\\/\0:\r\n]/u.test(part) && part.normalize("NFC") === part;
}
function assertPrivateFile(stats: FixtureStats, path: string): void {
  if (!stats.isFile() || stats.nlink !== 1n) throw new FixtureFileError("unsafe_path_type", path);
  if ((stats.mode & 0o7000n) !== 0n) throw new FixtureFileError("unsafe_file_mode", path);
}
function identity(stats: FixtureStats): string { return `${stats.dev}:${stats.ino}`; }
function sameFile(before: FixtureStats, after: FixtureStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.nlink === after.nlink
    && before.uid === after.uid && before.gid === after.gid && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.mountId === after.mountId;
}

function openAt(parent: number, name: string, flags: number): number {
  if (process.platform === "linux") return fixtureOpenAt(parent, name, flags);
  // Pass the owning buffer through FFI; a numeric pointer alone can outlive
  // a temporary pathname allocation when argument evaluation triggers GC.
  const native = darwin(); const fd = native.openat(parent, Buffer.from(name + "\0"), flags | 0x1000000); // Darwin O_CLOEXEC.
  if (fd < 0) throw new FixtureFileError(getSystemErrorName(-native.errno()));
  return fd;
}

function directoryNames(fd: number, maxEntries: number): string[] {
  if (process.platform === "linux") {
    const directory = opendirSync(`/proc/self/fd/${fd}`, { encoding: "latin1", bufferSize: 32 });
    try {
      const names: string[] = [];
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (names.length >= maxEntries) throw new FixtureFileError("fixture_directory_limit");
        names.push(decodeName(Buffer.from(entry.name, "latin1")));
      }
      return names;
    } finally { directory.closeSync(); }
  }
  const native = darwin();
  // fdopendir owns its descriptor. Keep the validated directory fd alive for
  // child opens and transfer a separate descriptor to the directory stream.
  const duplicate = openAt(fd, ".", DIRECTORY_FLAGS);
  const directory = native.fdopendir(duplicate);
  if (directory === null) { const error = native.errno(); closeSync(duplicate); throw new FixtureFileError(getSystemErrorName(-error)); }
  try {
    const names: string[] = [];
    while (true) {
      native.clearErrno(); const entry = native.readdir(directory);
      if (entry === null) {
        const error = native.errno(); if (error !== 0) throw new FixtureFileError(getSystemErrorName(-error));
        return names;
      }
      // Darwin's 64-bit dirent ABI: u64 inode, u64 seek offset, u16
      // record length, u16 name length, u8 type, then the name at byte 21.
      const recordLength = read.u16(entry, 16); const nameLength = read.u16(entry, 18);
      if (nameLength === 0 || nameLength >= 1024 || 21 + nameLength >= recordLength) throw new FixtureFileError("fixture_directory_entry_invalid");
      const name = decodeName(Buffer.from(toArrayBuffer(entry, 21, nameLength)));
      if (name === "." || name === "..") continue;
      if (names.length >= maxEntries) throw new FixtureFileError("fixture_directory_limit");
      names.push(name);
    }
  } finally { if (native.closedir(directory) !== 0) throw new FixtureFileError(getSystemErrorName(-native.errno())); }
}
function decodeName(bytes: Buffer): string {
  const name = bytes.toString("utf8");
  if (!Buffer.from(name).equals(bytes)) throw new FixtureFileError("invalid_fixture_path");
  return name;
}

function loadDarwin() {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) throw new FixtureFileError("fixture_platform_unsupported");
  // The system library is OS-owned; no compiler, downloaded dependency or
  // pathname fallback is needed. Intel Darwin retains versioned inode APIs.
  const suffix = process.arch === "x64" ? "$INODE64" : "";
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    [`fdopendir${suffix}`]: { args: ["i32"], returns: "ptr" },
    [`readdir${suffix}`]: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  const errnoPointer = library.symbols.__error();
  if (errnoPointer === null) { library.close(); throw new FixtureFileError("fixture_native_unavailable"); }
  const errnoView = new Int32Array(toArrayBuffer(errnoPointer, 0, 4));
  return {
    openat: (fd: number, name: Buffer, flags: number): number => library.symbols.openat(fd, name, flags),
    fdopendir: (fd: number): Pointer | null => library.symbols[`fdopendir${suffix}`]!(fd) as Pointer | null,
    readdir: (directory: Pointer): Pointer | null => library.symbols[`readdir${suffix}`]!(directory) as Pointer | null,
    closedir: (directory: Pointer): number => library.symbols.closedir(directory),
    errno: (): number => errnoView[0]!, clearErrno: (): void => { errnoView[0] = 0; },
  };
}
let darwinLibrary: ReturnType<typeof loadDarwin> | undefined;
function darwin(): ReturnType<typeof loadDarwin> { return darwinLibrary ??= loadDarwin(); }
