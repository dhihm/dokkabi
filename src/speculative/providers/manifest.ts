import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tier1ExecutionAuthority, Tier1ProviderLimits } from "./types.ts";

export interface ManifestLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxMs: number;
}

export interface DependencyProof {
  readonly digest: string;
  readonly validate: () => boolean;
}

export const manifestLimits = (limits?: Tier1ProviderLimits): ManifestLimits => ({
  maxFiles: bounded(limits?.maxFiles, 2_048, 8_192),
  maxBytes: bounded(limits?.maxDependencyBytes, 8 * 1_024 * 1_024, 64 * 1_024 * 1_024),
  maxMs: bounded(limits?.maxValidateMs, 50, 250),
});

export function canonicalWorkspaceRoot(root: string): string {
  const canonical = realpathSync(resolve(root));
  if (canonical === sep || !lstatSync(canonical).isDirectory()) {
    throw new TypeError("Tier 1 workspace root must be a non-root directory");
  }
  return canonical;
}

export function fileProof(
  root: string,
  target: string,
  limits: ManifestLimits,
  authority?: Tier1ExecutionAuthority,
  hooks?: { readonly beforeOpen?: () => void; readonly afterStat?: () => void; readonly afterRead?: (bytes: number) => void },
): DependencyProof | undefined {
  if (!safeInside(root, target)) return undefined;
  return stableProof((bounded) => {
    const current = safeInside(root, target);
    hooks?.beforeOpen?.();
    return current ? scanFile(current, bounded, root, hooks?.afterStat, hooks?.afterRead) : undefined;
  }, limits, authority);
}

export function treeProof(
  root: string,
  target: string,
  mode: "inspect" | "git",
  limits: ManifestLimits,
  authority?: Tier1ExecutionAuthority,
): DependencyProof | undefined {
  if (!safeInside(root, target)) return undefined;
  return stableProof((bounded) => {
    const current = safeInside(root, target);
    return current ? scanTree(current, mode, bounded) : undefined;
  }, limits, authority);
}

function stableProof(
  scan: (bounded: ManifestLimits) => string | undefined,
  limits: ManifestLimits,
  authority?: Tier1ExecutionAuthority,
): DependencyProof | undefined {
  const first = scan(limits);
  const second = scan(limits);
  if (!first || first !== second) return undefined;
  const executable = authority ? scanExecutable(authority.executablePath, limits) : "";
  if (authority && (!executable || !authority.environmentDigest || !safeAuthority(authority))) return undefined;
  const digest = hash(`${first}\0${executable}\0${authority?.environmentDigest ?? ""}`);
  return {
    digest,
    validate: () => {
      const started = performance.now();
      if (authority && !safeAuthority(authority)) return false;
      const bounded = authority ? { ...limits, maxMs: Math.max(1, limits.maxMs / 2) } : limits;
      const current = scan(bounded);
      if (!current) return false;
      const currentExecutable = authority ? scanExecutable(authority.executablePath, bounded) : "";
      return (!authority || Boolean(currentExecutable))
        && performance.now() - started <= limits.maxMs
        && hash(`${current}\0${currentExecutable}\0${authority?.environmentDigest ?? ""}`) === digest;
    },
  };
}

function scanFile(path: string, limits: ManifestLimits, allowedRoot?: string, afterStat?: () => void, afterRead?: (bytes: number) => void): string | undefined {
  const deadline = performance.now() + limits.maxMs;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || (allowedRoot !== undefined && before.nlink !== 1) || before.size > limits.maxBytes) return undefined;
    const canonical = realpathSync(path);
    if ((allowedRoot && !isInside(allowedRoot, canonical)) || !sameFile(before, statSync(canonical))) return undefined;
    afterStat?.();
    const capacity = Math.min(limits.maxBytes + 1, before.size + 1);
    const bytes = Buffer.allocUnsafe(capacity);
    let length = 0;
    while (length < capacity) {
      const count = readSync(fd, bytes, length, capacity - length, length);
      if (count === 0) break;
      length += count;
    }
    afterRead?.(length);
    const after = fstatSync(fd);
    if (length !== before.size || length > limits.maxBytes || performance.now() > deadline || !sameFile(before, after)) return undefined;
    return hash(`F\0${after.dev}\0${after.ino}\0${after.mode}\0${hash(bytes.subarray(0, length))}`);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function scanExecutable(path: string, limits: ManifestLimits): string | undefined {
  try {
    const canonical = realpathSync(resolve(path));
    const file = scanFile(canonical, limits);
    return file ? hash(`${canonical}\0${file}`) : undefined;
  } catch {
    return undefined;
  }
}

function scanTree(root: string, mode: "inspect" | "git", limits: ManifestLimits): string | undefined {
  const deadline = performance.now() + limits.maxMs;
  const rows: string[] = [];
  let entries = 0;
  let bytes = 0;
  const visit = (directory: string, shown: string): boolean => {
    if (performance.now() > deadline) return false;
    let names: string[];
    let directoryFd: number | undefined;
    try {
      directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stats = fstatSync(directoryFd);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
      const canonical = realpathSync(directory);
      if (!isInside(root, canonical) || !sameFile(stats, statSync(canonical))) return false;
      names = readdirSync(directory).sort();
      if (!sameFile(stats, statSync(realpathSync(directory)))) return false;
    } catch {
      return false;
    } finally {
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
    rows.push(`D\0${shown}\0${names.join("\0")}`);
    for (const name of names) {
      if (mode === "inspect" && (name === ".git" || name === "node_modules")) continue;
      entries += 1;
      if (entries > limits.maxFiles || performance.now() > deadline) return false;
      const absolute = join(directory, name);
      const relativePath = shown ? `${shown}/${name}` : name;
      let before: Stats;
      try { before = lstatSync(absolute); } catch {
        return false;
      }
      if (before.isSymbolicLink()) { rows.push(`L\0${relativePath}`); continue; }
      if (before.isDirectory()) { if (!visit(absolute, relativePath)) return false; continue; }
      if (!before.isFile() || before.nlink !== 1) { rows.push(`O\0${relativePath}\0${before.mode}\0${before.nlink}`); continue; }
      bytes += before.size;
      if (bytes > limits.maxBytes) return false;
      const file = scanFile(absolute, { ...limits, maxBytes: limits.maxBytes - bytes + before.size }, root);
      if (!file) return false;
      rows.push(`F\0${relativePath}\0${file}`);
    }
    try { return readdirSync(directory).sort().join("\0") === names.join("\0"); } catch {
      return false;
    }
  };
  return visit(root, "") && performance.now() <= deadline ? hash(rows.join("\n")) : undefined;
}

function safeInside(root: string, target: string): string | undefined {
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  let current = root;
  try {
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return undefined;
    }
    return absolute;
  } catch {
    return undefined;
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}

function safeAuthority(authority: Tier1ExecutionAuthority): boolean {
  try { return authority.validate() === true; } catch {
    return false;
  }
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), ceiling)
    : fallback;
}
