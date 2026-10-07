import { publishAnchored } from "./anchored-publication.ts";
import { tmpdir } from "node:os";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const ARCHIVE_LIMIT = 512 * 1024 * 1024;
export type ArchiveFiles = ReadonlyMap<string, Buffer>;
export function archiveRelativePath(path: string): string {
  if (!path || path.startsWith("/") || /[\\\0\r\n]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("archive path must be canonical and relative");
  return path;
}
function octal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  if (text.length !== length) throw new Error("archive numeric limit exceeded");
  header.write(text, offset, length, "ascii");
}
/** Deterministic regular-file USTAR. No filesystem metadata or extraction
 * authority is delegated to an external process. */
export function encodeArchive(files: ArchiveFiles, executable: ReadonlySet<string> = new Set()): Buffer {
  if (!files.size || files.size > 100000) throw new Error("archive file count invalid");
  const chunks: Buffer[] = []; let bytes = 1024;
  for (const [name, body] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    archiveRelativePath(name);
    const header = Buffer.alloc(512); let leaf = name, prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const slash = Array.from({ length: name.length }, (_, i) => i).reverse().find(i => name[i] === "/" && Buffer.byteLength(name.slice(0, i)) <= 155 && Buffer.byteLength(name.slice(i + 1)) <= 100);
      if (slash === undefined) throw new Error("archive USTAR path length exceeded");
      prefix = name.slice(0, slash); leaf = name.slice(slash + 1);
    }
    bytes += 512 + Math.ceil(body.length / 512) * 512;
    if (bytes > ARCHIVE_LIMIT) throw new Error("archive byte limit exceeded");
    header.write(leaf, 0, 100, "utf8"); octal(header, 100, 8, executable.has(name) ? 0o700 : 0o600); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
    octal(header, 124, 12, body.length); octal(header, 136, 12, 0); header.fill(32, 148, 156); header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii"); header.write(prefix, 345, 155, "utf8");
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, Buffer.from(body), Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks);
}
export function decodeArchive(raw: Buffer): Map<string, Buffer> {
  if (raw.length > ARCHIVE_LIMIT || raw.length < 1024 || raw.length % 512) throw new Error("archive size or alignment invalid");
  const files = new Map<string, Buffer>(), paths = new Set<string>(); let offset = 0, ended = false, metadataPending = false, entries = 0;
  const text = (body: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, body.indexOf(0) < 0 ? body.length : body.indexOf(0)));
  const number = (body: Buffer) => {
    const value = body.toString("ascii").replace(/\0/gu, "").trim();
    if (!/^[0-7]+$/u.test(value)) throw new Error("archive numeric encoding refused");
    const n = Number.parseInt(value, 8); if (!Number.isSafeInteger(n)) throw new Error("archive number out of range"); return n;
  };
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (raw.length - offset < 1024 || !raw.subarray(offset).every(byte => byte === 0)) throw new Error("archive terminal padding invalid");
      ended = true; break;
    }
    const expected = number(header.subarray(148, 156)), copy = Buffer.from(header); copy.fill(32, 148, 156);
    const magic = text(header.subarray(257, 263));
    if (copy.reduce((n, byte) => n + byte, 0) !== expected || !["ustar", "ustar "].includes(magic)) throw new Error("archive header integrity failed");
    const type = header[156];
    if (++entries > 100000) throw new Error("archive entry limit");
    if (type === 120) {
      if (metadataPending) throw new Error("stacked archive metadata refused");
      const size = number(header.subarray(124, 136)), start = offset + 512;
      if (size > 1024 * 1024 || start + size > raw.length) throw new Error("archive metadata limit");
      const body = raw.subarray(start, start + size); let cursor = 0;
      while (cursor < body.length) {
        const space = body.indexOf(32, cursor), sizeText = body.subarray(cursor, space).toString("ascii");
        if (space < cursor || !/^[1-9][0-9]*$/u.test(sizeText)) throw new Error("archive metadata record invalid");
        const length = Number(sizeText), end = cursor + length, equals = body.indexOf(61, space + 1);
        if (!Number.isSafeInteger(length) || end > body.length || end <= space + 1 || equals < space + 2 || equals >= end - 1 || body[end - 1] !== 10) throw new Error("archive metadata bounds invalid");
        const key = body.subarray(space + 1, equals).toString("ascii");
        // Accept only metadata that cannot rename, resize, link or change the
        // interpreted file bytes. Xattrs/timestamps are never restored.
        if (!/^(?:mtime|atime|ctime|(?:LIBARCHIVE|SCHILY)\.xattr\.[A-Za-z0-9._-]+)$/u.test(key)) throw new Error("archive authority-bearing extension refused");
        cursor = end;
      }
      if (!size) throw new Error("empty archive metadata");
      metadataPending = true; offset = start + Math.ceil(size / 512) * 512; continue;
    }
    if (![0, 48, 53].includes(type!)) throw new Error("archive special or extended entry refused");
    metadataPending = false;
    const prefix = magic === "ustar " ? "" : text(header.subarray(345, 500)), leaf = text(header.subarray(0, 100));
    const path = archiveRelativePath((prefix ? prefix + "/" : "") + (type === 53 ? leaf.replace(/\/$/u, "") : leaf));
    if (paths.has(path) || paths.size >= 100000) throw new Error("archive duplicate path or entry limit"); paths.add(path);
    const size = number(header.subarray(124, 136)); offset += 512;
    if (size > ARCHIVE_LIMIT || offset + Math.ceil(size / 512) * 512 > raw.length || (type === 53 && size !== 0)) throw new Error("archive truncated body");
    if (type !== 53) files.set(path, Buffer.from(raw.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || !files.size || metadataPending) throw new Error("archive terminal blocks or files missing");
  for (const name of paths) {
    const parts = name.split("/"); parts.pop();
    while (parts.length) { if (files.has(parts.join("/"))) throw new Error("archive file/directory collision"); parts.pop(); }
  }
  return files;
}
export function readArchive(path: string): Buffer {
  const target = resolve(path), stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARCHIVE_LIMIT) throw new Error("archive input must be a bounded regular file");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
export function publishArchive(path: string, bytes: Buffer): void {
  if (bytes.length > ARCHIVE_LIMIT) throw new Error("archive byte limit exceeded");
  publishAnchored(path, new Map([["payload", bytes]]), new Set(), "file");
}
/** Populate an owned staging tree, validate it, then atomically publish it.
 * A preexisting nonempty destination is never changed, even on refusal. */
export function publishArchiveDirectory(dest: string, files: ArchiveFiles, validate: (staging: string) => void = () => {}, executable: ReadonlySet<string> = new Set()): void {
  const staging = mkdtempSync(join(tmpdir(), "dokkabi-archive-validation-"));
  try {
    const directories = new Set([staging]);
    for (const [name, bytes] of files) {
      archiveRelativePath(name); const path = join(staging, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "wx", executable.has(name) ? 0o700 : 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      for (let dir = dirname(path); dir !== staging; dir = dirname(dir)) directories.add(dir);
    }
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
      const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    validate(staging);
    publishAnchored(dest, files, executable);
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}
