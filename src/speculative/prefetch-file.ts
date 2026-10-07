import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safeRelativeFile } from "./targets.ts";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface FileFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

export interface SourceSnapshot {
  readonly fingerprint: FileFingerprint;
  readonly text: string;
}

export function captureSourceSnapshot(
  root: string,
  path: string,
  maxBytes: number,
  afterOpen?: () => void,
): SourceSnapshot | undefined {
  const opened = openAttachedFile(root, path, maxBytes);
  if (!opened) return undefined;
  try {
    afterOpen?.();
    const bytes = readBounded(opened.fd, maxBytes);
    if (!bytes) return undefined;
    const after = fstatSync(opened.fd, { bigint: true });
    if (!sameStats(opened.stats, after) || BigInt(bytes.byteLength) !== after.size) return undefined;
    return {
      fingerprint: toFingerprint(after),
      text: new TextDecoder().decode(bytes),
    };
  } catch {
    return undefined;
  } finally {
    closeSync(opened.fd);
  }
}

function readBounded(fd: number, maxBytes: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, total);
    if (count === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  return undefined;
}

export function currentFingerprint(
  root: string,
  path: string,
  maxBytes: number,
): FileFingerprint | undefined {
  const opened = openAttachedFile(root, path, maxBytes);
  if (!opened) return undefined;
  try {
    return toFingerprint(opened.stats);
  } finally {
    closeSync(opened.fd);
  }
}

export function sameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint | undefined,
): boolean {
  return right !== undefined && left.device === right.device && left.inode === right.inode
    && left.size === right.size && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
}

export function resultMatchesSnapshot(
  snapshot: SourceSnapshot,
  result: AgentToolResult<unknown>,
): boolean {
  return result.content.length === 1
    && result.content[0]?.type === "text"
    && result.content[0].text === snapshot.text;
}

function openAttachedFile(
  root: string,
  path: string,
  maxBytes: number,
): { readonly fd: number; readonly stats: BigIntStats } | undefined {
  const safe = safeRelativeFile(root, path);
  if (!safe) return undefined;
  const target = resolve(root, safe);
  let fd: number | undefined;
  try {
    fd = openSync(target, READ_FLAGS);
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n || stats.size > BigInt(maxBytes)) return undefined;
    const canonical = realpathSync(target);
    if (!pathInside(root, canonical)) return undefined;
    const attached = statSync(canonical, { bigint: true });
    if (stats.dev !== attached.dev || stats.ino !== attached.ino) return undefined;
    const ownedFd = fd;
    fd = undefined;
    return { fd: ownedFd, stats };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameStats(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function toFingerprint(stats: BigIntStats): FileFingerprint {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedNs: stats.mtimeNs,
    changedNs: stats.ctimeNs,
  };
}
