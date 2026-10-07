import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostExecutableCandidates } from "./sandbox-executable-locations.ts";

export type SandboxHostExecutableName =
  | "bwrap" | "docker" | "gh" | "git" | "ssh" | "scp" | "rsync" | "python3" | "seatbelt" | "cursor-agent" | "runtime";

/** An identity captured from an open host file, not a caller assertion. */
export interface SandboxHostExecutableSeal {
  readonly name: SandboxHostExecutableName;
  readonly path: string;
  readonly identity: string;
  readonly statIdentity: string;
}

class SandboxExecutableError extends Error {}

export function findAndSealSandboxExecutable(
  name: SandboxHostExecutableName,
  writableRoots: readonly string[],
): SandboxHostExecutableSeal | undefined {
  if (name === "runtime") return undefined;
  for (const candidate of hostExecutableCandidates(name, writableRoots[0])) {
    try {
      return sealCandidate(name, candidate, writableRoots);
    } catch {
      // A missing, malformed, or workspace-controlled candidate is not a
      // backend. Continue only through the host-owned fixed candidate list.
    }
  }
  return undefined;
}

/** Enroll one explicit native host runtime; PATH lookup cannot grant authority. */
export function sealHostRuntimeExecutable(
  candidateAbsolutePath: string,
  writableRoots: readonly string[],
): SandboxHostExecutableSeal {
  if (!isAbsolute(candidateAbsolutePath) || candidateAbsolutePath !== resolve(candidateAbsolutePath) || candidateAbsolutePath.includes("\0")) {
    throw new SandboxExecutableError("sandbox runtime path must be normalized and absolute");
  }
  return sealCandidate("runtime", candidateAbsolutePath, writableRoots);
}

export function requireAndSealSandboxExecutable(
  name: SandboxHostExecutableName,
  writableRoots: readonly string[],
): SandboxHostExecutableSeal {
  const seal = findAndSealSandboxExecutable(name, writableRoots);
  if (!seal) throw new SandboxExecutableError(`${name} executable is unavailable or untrusted`);
  return seal;
}

/** Re-open and hash immediately before constructing an execution argv. */
export function assertSandboxExecutableIdentity(seal: SandboxHostExecutableSeal): void {
  let path: string;
  let fd: number | undefined;
  try {
    path = executablePath(seal.path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    assertExecutableFile(stat, seal.name);
    const bytes = readFileSync(fd);
    assertStableExecutable(fd, stat, bytes);
    if (seal.name === "runtime" || seal.name === "python3") assertNativeRuntime(bytes);
    if (path !== seal.path || executableStatIdentity(stat) !== seal.statIdentity ||
      executableIdentity(path, stat, bytes) !== seal.identity) {
      throw new Error("changed");
    }
  } catch {
    throw new SandboxExecutableError(`${seal.name} executable identity changed after policy seal`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sealCandidate(
  name: SandboxHostExecutableName,
  candidate: string,
  writableRoots: readonly string[],
): SandboxHostExecutableSeal {
  if (!isAbsolute(candidate)) throw new SandboxExecutableError("sandbox executable path must be absolute");
  const roots = writableRoots.flatMap(root => [resolve(root), canonicalWritableRoot(root)]);
  if (roots.some(root => pathWithin(root, candidate))) {
    throw new SandboxExecutableError("sandbox executable cannot live in a writable sandbox root");
  }
  const path = executablePath(candidate);
  // A multi-call shim dispatches on argv0 (OrbStack resolves docker ->
  // xbin/docker-tools after its 2026-08 update). We deliberately execute the
  // sealed realpath, so argv0 becomes the resolved name and the shim refuses:
  // exit 127 `unsupported argv0 "docker-tools"`. Identity is not behavior for
  // such binaries — a candidate whose resolution changes the executable's
  // basename is not this backend. Fail this candidate and continue through
  // the fixed list.
  if (basename(path) !== basename(candidate) && !(name === "python3" && /^python3\.\d+$/.test(basename(path)))) {
    throw new SandboxExecutableError(
      `${name} candidate resolves to a differently-named multi-call binary`,
    );
  }
  if (roots.some((root) => pathWithin(root, path))) {
    throw new SandboxExecutableError("sandbox executable cannot live in a writable sandbox root");
  }

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assertExecutableFile(stat, name);
    const bytes = readFileSync(fd);
    assertStableExecutable(fd, stat, bytes);
    if (name === "runtime" || name === "python3") assertNativeRuntime(bytes);
    const identity = executableIdentity(path, stat, bytes);
    return Object.freeze({ name, path, identity, statIdentity: executableStatIdentity(stat) });
  } finally {
    closeSync(fd);
  }
}

function assertExecutableFile(stat: BigIntStats, name: SandboxHostExecutableName): void {
  if (!stat.isFile() || (stat.mode & 0o111n) === 0n) {
    throw new SandboxExecutableError("sandbox executable is not an executable regular file");
  }
  if (name === "python3" && (stat.mode & 0o022n) !== 0n) throw new SandboxExecutableError("Python interpreter is writable by other users");
  if ((name === "runtime" || name === "python3") && (stat.nlink !== 1n || (stat.mode & 0o7000n) !== 0n)) {
    throw new SandboxExecutableError("sandbox runtime must be a private native executable without special permission bits");
  }
}

function assertStableExecutable(fd: number, before: BigIntStats, bytes: Buffer): void {
  const after = fstatSync(fd, { bigint: true });
  if (executableStatIdentity(before) !== executableStatIdentity(after) || before.nlink !== after.nlink || BigInt(bytes.length) !== before.size) {
    throw new SandboxExecutableError("sandbox executable changed while sealing");
  }
}

function assertNativeRuntime(bytes: Buffer): void {
  const elf = process.platform === "linux" && bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && bytes[4] === 2 && (bytes[5] === 1 || bytes[5] === 2)
    && [2, 3].includes(bytes[5] === 1 ? bytes.readUInt16LE(16) : bytes.readUInt16BE(16));
  if (elf || (process.platform === "darwin" && nativeMachExecutable(bytes))) return;
  throw new SandboxExecutableError("sandbox runtime must be a native executable; scripts and interpreter shims are refused");
}

function nativeMachExecutable(bytes: Buffer): boolean {
  if (bytes.length < 28) return false;
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xfeedface || magic === 0xfeedfacf) return bytes.readUInt32BE(12) === 2;
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) return bytes.readUInt32LE(12) === 2;
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  if (!fat64 && magic !== 0xcafebabe && magic !== 0xbebafeca) return false;
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const count = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
  const stride = fat64 ? 32 : 20;
  if (count === 0 || count > 32 || 8 + count * stride > bytes.length) return false;
  for (let index = 0; index < count; index += 1) {
    const start = 8 + index * stride;
    const offset = fat64 ? Number(little ? bytes.readBigUInt64LE(start + 8) : bytes.readBigUInt64BE(start + 8))
      : little ? bytes.readUInt32LE(start + 8) : bytes.readUInt32BE(start + 8);
    const size = fat64 ? Number(little ? bytes.readBigUInt64LE(start + 16) : bytes.readBigUInt64BE(start + 16))
      : little ? bytes.readUInt32LE(start + 12) : bytes.readUInt32BE(start + 12);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + count * stride || size < 28 || offset + size > bytes.length) return false;
    const slice = bytes.subarray(offset, offset + size); const sliceMagic = slice.readUInt32BE(0);
    if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(sliceMagic) || !nativeMachExecutable(slice)) return false;
  }
  return true;
}

function canonicalWritableRoot(root: string): string {
  let current = resolve(root); const missing: string[] = [];
  while (true) {
    try { return join(realpathSync(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === dirname(current)) throw error;
      missing.unshift(basename(current)); current = dirname(current);
    }
  }
}

function executablePath(candidate: string, links = 0): string {
  if (links >= 40) throw new SandboxExecutableError("sandbox executable symbolic link chain is too long");
  // Bun on Darwin can resolve a regular file to another hardlink's name.
  // Preserve argv0 by canonicalizing directories and following only symlinks.
  const parent = realpathSync(dirname(candidate));
  const path = join(parent, basename(candidate));
  if (!lstatSync(path).isSymbolicLink()) return path;
  const target = readlinkSync(path);
  return executablePath(isAbsolute(target) ? target : `${parent}/${target}`, links + 1);
}

function executableIdentity(path: string, stat: BigIntStats, bytes: Uint8Array): string {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(executableStatIdentity(stat))
    .update("\0")
    .update(bytes)
    .digest("hex");
}

function executableStatIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
