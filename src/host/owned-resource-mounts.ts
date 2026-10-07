import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Mount-table inspection for owned resource removal (R8-02).
 *
 * Removing a directory tree that carries a mount point — including a
 * same-device bind mount — would either fail halfway or un-cover whatever is
 * mounted beneath it. Cleanup therefore reads the operating system's own
 * mount table and refuses BEFORE any traversal or removal, and again
 * immediately before the removal itself.
 *
 * The parsers are pure so an injected table can be unit-tested; the
 * production assertion reads its own table through the absolute platform
 * reader and accepts no caller input. A table that is empty, malformed or
 * carries a non-absolute mount point never means "no mounts": it fails
 * closed. Unavailable or unsupported inspection fails closed too. */

export class OwnedResourceMountError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OwnedResourceMountError";
  }
}

function fail(code: string): never {
  throw new OwnedResourceMountError(code);
}

/** Decode the octal escapes `/proc/self/mountinfo` uses in its fields:
 * \040 space, \011 tab, \134 backslash. */
export function decodeMountInfoField(value: string): string {
  return value.replace(/\\(040|011|134)/gu, (_match, code: string) =>
    code === "040" ? " " : code === "011" ? "\t" : "\\");
}

function absoluteMountPoint(point: string): string {
  if (!point.startsWith("/") || point.includes("\0")) fail("mount_table_line_invalid");
  return point;
}

/** Parse `/proc/self/mountinfo` text into its mount points. Field 5 of each
 * record is the mount point; every bind mount — same device or not — is its
 * own record, so a bound descendant is visible here. An empty table, a
 * malformed record or a non-absolute mount point refuses: none of them ever
 * means "nothing is mounted". */
export function parseMountInfoTable(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(" ");
    if (fields.length < 6 || !line.includes(" - ")) fail("mount_table_line_invalid");
    points.push(absoluteMountPoint(decodeMountInfoField(fields[4]!)));
  }
  if (points.length === 0) fail("mount_table_empty");
  return points;
}

/** Parse macOS `/sbin/mount` output (`<source> on <mount point> (<options>)`)
 * into its mount points. Sources and mount points may contain spaces, but
 * exactly one ` on ` delimiter may appear in the head: with two or more, a
 * source containing " on " cannot be told from a mount point containing it,
 * and the line refuses rather than guessing which side owns the descendant
 * path. An empty table, a malformed line or a non-absolute mount point
 * refuses: none of them ever means "nothing is mounted". */
export function parseMountCommandTable(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^(.*) \(([^()]*)\)$/u.exec(line);
    if (!match || match[1] === undefined || match[1] === "") fail("mount_table_line_invalid");
    const head = match[1];
    const at = head.indexOf(" on ");
    if (at < 0 || head.indexOf(" on ", at + 1) >= 0) fail("mount_table_line_invalid");
    const source = head.slice(0, at);
    const point = head.slice(at + 4);
    if (source === "") fail("mount_table_line_invalid");
    points.push(absoluteMountPoint(point));
  }
  if (points.length === 0) fail("mount_table_empty");
  return points;
}

/** The mount points at or below `root` — exactly the mounts whose removal
 * boundary the resource tree would cross. */
export function mountsBelow(root: string, points: readonly string[]): string[] {
  return points.filter(point => point === root || point.startsWith(root + "/"));
}

function parseTable(platform: NodeJS.Platform, text: string): string[] {
  if (platform === "linux") return parseMountInfoTable(text);
  if (platform === "darwin") return parseMountCommandTable(text);
  return fail("mount_table_platform_unsupported");
}

/** Read this process's own mount table. Linux reads /proc/self/mountinfo;
 * macOS runs the absolute /sbin/mount with a minimal environment. Every
 * other platform, and any unavailable or failed read, fails closed. */
export function readOwnMountTable(): string[] {
  if (process.platform === "linux") {
    let text: string;
    try {
      text = readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return fail("mount_table_unavailable");
    }
    return parseTable("linux", text);
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/sbin/mount", [], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return fail("mount_table_unavailable");
    }
    return parseTable("darwin", result.stdout);
  }
  return fail("mount_table_platform_unsupported");
}

/** Refuse when any mount sits at or below the owned resource root. This is
 * the production check: the table is read here, never supplied by a caller,
 * and an unreadable, empty or unsupported table is a refusal, not a skip. */
export function assertNoOwnedResourceMounts(root: string): void {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) {
    fail("mount_table_root_invalid");
  }
  const covering = mountsBelow(root, readOwnMountTable());
  if (covering.length > 0) fail("resource_mount_active");
}
