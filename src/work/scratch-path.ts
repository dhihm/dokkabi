import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ScratchError } from "./scratch-error.ts";

export const SCRATCH_ROOT = "work/scratch";
export const SCRATCH_FILE_BYTES_MAX = 1024 * 1024;
export const SCRATCH_ENTRY_MAX = 4096;

export interface ScratchFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ScratchEntry extends ScratchFileIdentity {
  readonly path: string;
  readonly bytes: number;
  readonly kind: "file" | "link";
}

export interface ScratchSource extends ScratchFileIdentity {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly digest: string;
}

export function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const root = realpathSync(resolve(workspaceRoot));
  if (root === "/" || !lstatSync(root).isDirectory()) {
    throw new ScratchError("invalid_path", "scratch workspace must be a non-root directory");
  }
  return root;
}

export function safeRelativePath(root: string, input: string): string {
  if (!input || input.includes("\0") || Buffer.byteLength(input) > 1_024) {
    throw new ScratchError("invalid_path", "scratch path must be a non-empty workspace path");
  }
  const canonicalRoot = canonicalWorkspaceRoot(root);
  const absolute = resolve(canonicalRoot, input);
  const rel = relative(canonicalRoot, absolute).replaceAll("\\", "/");
  if (!rel || rel.startsWith("../") || isAbsolute(rel) || !/^[A-Za-z0-9._/-]+$/u.test(rel)) {
    throw new ScratchError("invalid_path", "scratch path must stay inside the workspace and use safe characters");
  }
  return rel;
}

export function assertScratchPath(path: string): void {
  if (!path.startsWith(`${SCRATCH_ROOT}/`)) {
    throw new ScratchError("invalid_source", `scratch source must be below ${SCRATCH_ROOT}/`);
  }
}

export function assertTestPath(path: string): void {
  const parts = path.split("/");
  if (!parts.includes("tests") && !parts.includes("testing")) {
    throw new ScratchError("invalid_target", "scratch promotion target must be a test path");
  }
}

export function readScratchSource(root: string, path: string): ScratchSource {
  assertScratchPath(path);
  const absolute = safeAbsolutePath(root, path, false);
  const before = privateFileStats(absolute);
  if (before.size > SCRATCH_FILE_BYTES_MAX) {
    throw new ScratchError("resource_limit", `scratch probe exceeds ${SCRATCH_FILE_BYTES_MAX} bytes`);
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = fstatSync(fd);
    assertSamePrivateFile(before, held);
    const canonical = realpathSync(absolute);
    if (canonical !== absolute) throw new ScratchError("invalid_source", "scratch source changed during open");
    const bytes = readFileSync(fd);
    if (bytes.byteLength !== held.size) {
      throw new ScratchError("filesystem_changed", "scratch source changed while it was read");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ScratchError("invalid_source", "scratch probe must be valid UTF-8 text");
      }
      throw error;
    }
    return {
      bytes,
      text,
      digest: createHash("sha256").update(bytes).digest("hex"),
      dev: held.dev,
      ino: held.ino,
    };
  } finally {
    closeSync(fd);
  }
}

export function createPromotedFile(root: string, path: string, content: Uint8Array): void {
  const absolute = safeAbsolutePath(root, path, true);
  if (existsSync(absolute)) throw new ScratchError("target_exists", `promotion target already exists: ${path}`);
  const fd = openSync(
    absolute,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o644,
  );
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new ScratchError("invalid_target", "promotion target is not a private regular file");
    }
    let offset = 0;
    while (offset < content.byteLength) {
      offset += writeSync(fd, content, offset, content.byteLength - offset, offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function removeSameEntry(root: string, entry: ScratchFileIdentity & { readonly path: string }): boolean {
  const absolute = safeAbsolutePath(root, entry.path, false);
  const current = lstatSync(absolute);
  if (current.dev !== entry.dev || current.ino !== entry.ino) {
    throw new ScratchError("filesystem_changed", `scratch entry changed before removal: ${entry.path}`);
  }
  unlinkSync(absolute);
  return true;
}

export function listScratchEntries(root: string): ScratchEntry[] {
  const canonicalRoot = canonicalWorkspaceRoot(root);
  const scratch = join(canonicalRoot, SCRATCH_ROOT);
  if (!existsSync(scratch)) return [];
  const entries: ScratchEntry[] = [];
  walk(scratch, SCRATCH_ROOT, entries);
  return entries;
}

export function scratchEntryAt(root: string, path: string): ScratchEntry | undefined {
  assertScratchPath(path);
  return workspaceEntryAt(root, path);
}

export function workspaceEntryAt(root: string, path: string): ScratchEntry | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(safeAbsolutePath(root, path, false));
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() && !stats.isSymbolicLink()) return undefined;
  return {
    path,
    bytes: stats.isFile() ? stats.size : 0,
    kind: stats.isFile() ? "file" : "link",
    dev: stats.dev,
    ino: stats.ino,
  };
}

export function pruneEmptyScratchDirectories(root: string, paths: readonly string[]): void {
  const canonicalRoot = canonicalWorkspaceRoot(root);
  const candidates = new Set<string>();
  for (const path of paths) {
    let current = dirname(path);
    while (current.startsWith(`${SCRATCH_ROOT}/`)) {
      candidates.add(current);
      current = dirname(current);
    }
  }
  for (const path of [...candidates].sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(join(canonicalRoot, path));
    } catch (error) {
      const code = nodeCode(error);
      if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
    }
  }
}

function walk(absolute: string, relativePath: string, entries: ScratchEntry[]): void {
  assertDirectory(absolute);
  for (const name of readdirSync(absolute)) {
    if (entries.length >= SCRATCH_ENTRY_MAX) {
      throw new ScratchError("resource_limit", `scratch cleanup exceeds ${SCRATCH_ENTRY_MAX} entries`);
    }
    const childAbsolute = join(absolute, name);
    const childRelative = `${relativePath}/${name}`;
    const stats = lstatSync(childAbsolute);
    if (stats.isDirectory()) walk(childAbsolute, childRelative, entries);
    else if (stats.isFile() || stats.isSymbolicLink()) {
      entries.push({
        path: childRelative,
        bytes: stats.isFile() ? stats.size : 0,
        kind: stats.isFile() ? "file" : "link",
        dev: stats.dev,
        ino: stats.ino,
      });
    }
  }
}

function safeAbsolutePath(root: string, path: string, createParent: boolean): string {
  const canonicalRoot = canonicalWorkspaceRoot(root);
  const rel = safeRelativePath(canonicalRoot, path);
  const parts = rel.split("/");
  let current = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!createParent) throw new ScratchError("invalid_path", `scratch parent does not exist: ${part}`);
      mkdirSync(current, { mode: 0o755 });
    }
    assertDirectory(current);
  }
  return join(canonicalRoot, rel);
}

function assertDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ScratchError("invalid_path", "scratch path crosses a non-directory or symbolic link");
  }
}

function privateFileStats(path: string): Stats {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.nlink !== 1 || stats.isSymbolicLink()) {
    throw new ScratchError("invalid_source", "scratch source must be a private regular file");
  }
  return stats;
}

function assertSamePrivateFile(before: Stats, held: Stats): void {
  if (!held.isFile() || held.nlink !== 1 || before.dev !== held.dev || before.ino !== held.ino) {
    throw new ScratchError("filesystem_changed", "scratch source changed while it was opened");
  }
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}
