import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { establishBaseRecord, loadBaseRecord, type BaseRecord } from "../host/base-record.ts";
import { HOST_EXCLUDED_NAMES, unknownCoverage, type CoverageBase } from "../host/coverage.ts";
import { inWritableWorld, sessionWritableWorld, writableWorldOf } from "../host/writable-world.ts";
import { createDigestCache, type DigestCache } from "../host/execution-receipt.ts";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { exactUtf8 } from "./path-bytes.ts";
import { isConventionalTestPath } from "./test-paths.ts";

/**
 * A SESSION'S BASE (D57e, design memo §117 C1; B1, D57f §118): where the
 * host-owned base record is taken, where it is kept, and how it reaches every
 * consumer.
 *
 * TAKEN when the host establishes the session's base — the session's boot:
 * the workspace tools are made (and the ledger loop opens its session)
 * before the first model request, so before the session could write
 * anything (`requireSessionBase`). A base that cannot be established THERE
 * — the session directory lies inside the workspace, the tree cannot be
 * read, the log already shows the session acting — means the session does
 * not start (B1): no code path runs on a fallback listing.
 *
 * KEPT in the session's own directory, `<session dir>/base/` beside the log
 * — outside every tree a session writes. NAMED by one `work/base_record`
 * row carrying its directory and the sha256 of its record file. Every later
 * load (a resumed session, the orchestrator reading a fix stage's log for the
 * recheck, the verifier's keep) is held to that digest; a named record that
 * cannot be read, does not match or is of another version is never re-taken.
 *
 * WHERE A BASE CANNOT BE HAD LATER (the record deleted, altered, relocated,
 * a log that names none), every decision that depends on it is UNKNOWN
 * (B1, U1): the session's images are unknown (never equal to another, so
 * no case is green on them), the require-plan guard takes every path as
 * tracked, the immobility review refuses, the case targets are unknown (a
 * case or guard then counts as tampered), and the recheck observes the fix
 * as not runnable with its kept cases tampered-unknown.
 *
 * REACHES each consumer through the log: the digest cache of every receipt
 * (sessionDigestCache: the bash tool's, the conclusion's, the base pass's,
 * the finish and acceptance checks', the graph loop's case runs) — and so
 * caseGreenOn, which compares those receipts' images with the tree's now; the
 * plan tools' immobility baseline and the require-plan guard (the paths
 * tracked at the base); the conclusion's case targets and the recheck's
 * kept-case tamper decision (BaseChanges of the record and a listing now).
 */

export const BASE_RECORD_ROW = "work/base_record";
export const SESSION_BASE_DIR = "base";

/** Rows that show a session's model already acted: a tool call and what
 * only a tool call leaves behind (the host's own case runs are not the
 * session's acts). */
const ACTED = new Set(["tool/call", "tool/start", "tool/result", "tool/end", "exec/receipt", "work/finish", "work/plan_notice"]);

/** Where a session's base record lives: beside its log. */
export function sessionBaseDir(logPath: string): string {
  return join(dirname(resolve(logPath)), SESSION_BASE_DIR);
}

/** The base record a log names (its last `work/base_record` row with a
 * directory and a digest), or undefined. */
export function recordedBase(events: readonly EventRecord[]): { readonly dir: string; readonly digest: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name !== BASE_RECORD_ROW) continue;
    const { dir, digest } = event.payload as { dir?: unknown; digest?: unknown };
    if (typeof dir === "string" && isAbsolute(dir) && typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)) return { dir, digest };
    return undefined;
  }
  return undefined;
}

/** The base a session needs cannot be had (B1): why. */
export class BaseUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`the session's base record is unavailable: ${reason}`);
    this.name = "BaseUnavailable";
  }
}

/** The base record `events` name, loaded and held to its digest; a
 * BaseUnavailable saying why when none is named or it cannot be read as
 * named. */
export function loadRecordedBase(events: readonly EventRecord[]): BaseRecord | BaseUnavailable {
  const named = recordedBase(events);
  if (named === undefined) {
    const refused = [...events].reverse().find((event) => event.name === BASE_RECORD_ROW)?.payload.refused;
    return new BaseUnavailable(typeof refused === "string" ? refused : "the log names no base record");
  }
  try {
    return loadBaseRecord(named.dir, named.digest);
  } catch (error) {
    return new BaseUnavailable(`the record it names cannot be read as named: ${message(error)}`);
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const MEMO = new WeakMap<EventLog, BaseRecord | BaseUnavailable>();
/** The digest cache the base's own listing warmed, handed to the session's
 * first digest cache (its bash tool's, made at boot) so the tree is not read
 * twice at the session's start. */
const WARM = new WeakMap<EventLog, DigestCache>();

/**
 * The session's base record: the one its log names; else — while the log
 * shows no act of the session yet — established now, into
 * `<session dir>/base/`, and named by a new `work/base_record` row. A
 * BaseUnavailable saying why when it can be neither (B1): the caller takes
 * every decision that needs it as unknown. Never throws.
 */
export function sessionBase(log: EventLog, workspaceRoot: string): BaseRecord | BaseUnavailable {
  const memo = MEMO.get(log);
  if (memo !== undefined) return memo;
  const remember = (record: BaseRecord | BaseUnavailable): BaseRecord | BaseUnavailable => {
    MEMO.set(log, record);
    return record;
  };
  if (log.events.some((event) => event.name === BASE_RECORD_ROW)) return remember(loadRecordedBase(log.events));
  // A read-only view of a session (the dashboard, a replay) is no session's
  // boot: it reads the base the log names and never takes one — nothing it
  // does may reach the disk.
  if (log.isReadOnly) return remember(new BaseUnavailable("a read-only view of the session takes no base"));
  const refuse = (reason: string) => {
    log.append({ kind: "observe", name: BASE_RECORD_ROW, payload: { refused: reason, exclusions: [...HOST_EXCLUDED_NAMES] } });
    return remember(new BaseUnavailable(reason));
  };
  if (log.events.some((event) => ACTED.has(event.name))) return refuse("the session acted before its base was taken");
  let dir = sessionBaseDir(log.path);
  let placed: "session" | "host-temp" = "session";
  let root: string;
  try {
    root = realpathSync(resolve(workspaceRoot));
    if (lstatSync(dirname(resolve(log.path))).isSymbolicLink()) throw new Error("the session directory is a link");
    const sessionReal = realpathSync(dirname(dir));
    const writable = sessionWritableWorld(log, root);
    if (inside(root, sessionReal) || inWritableWorld(writable, sessionReal)) {
      // The session directory lies inside the workspace (the SWE-bench
      // adapter's `.dokkabi-home`): the record may not live there — the
      // session could rewrite it — so it goes to a host-owned directory the
      // host makes for this session in the system temporary directory.
      // W2 (D57g): the session directory there must be one the host made —
      // never adopted as a session may have planted it.
      if (inside(root, sessionReal)) assertHostMadeSessionDir(root, log.path);
      dir = join(hostTempBaseHolder(log.path, root), SESSION_BASE_DIR);
      placed = "host-temp";
    }
  } catch (error) {
    return refuse(`the base cannot be placed outside the workspace: ${message(error)}`);
  }
  const world = sessionWritableWorld(log, root);
  try {
    // The bytes of its conventional test paths are kept whatever git holds:
    // their lost lines decide tampering (D26), and the session may later
    // destroy or redirect its object store.
    const record = establishBaseRecord({ root, dir, keepBytes: (path) => {
      const text = exactUtf8(path);
      return text !== undefined && isConventionalTestPath(text);
    }, onCache: (cache) => WARM.set(log, cache), world });
    const counts: Record<string, number> = { files: 0, links: 0, dirs: 0, regions: 0, unreadable: 0 };
    for (const entry of record.entries.values()) {
      if (entry.kind === "file") counts.files! += 1;
      else if (entry.kind === "symlink") counts.links! += 1;
      else if (entry.kind === "dir") counts.dirs! += 1;
      else if (entry.kind === "state") counts.regions! += 1;
      else counts.unreadable! += 1;
    }
    log.append({ kind: "observe", name: BASE_RECORD_ROW, payload: {
      dir: record.dir,
      digest: record.digest,
      ...(placed === "host-temp" ? { placed, session_dir: realpathSync(dirname(resolve(log.path))) } : {}),
      root,
      ...(record.head === undefined ? {} : { head: record.head }),
      coverage: record.coverage.identity,
      exclusions: [...HOST_EXCLUDED_NAMES],
      ...counts,
      tracked: record.tracked.size,
      ignore_files: record.ignoreFiles.size,
      stored: record.stored.size,
    } });
    return remember(record);
  } catch (error) {
    return refuse(`the base could not be taken: ${message(error)}`);
  }
}

/**
 * W2 (D57g): a session directory the layout puts under the workspace is
 * adopted only as the host made it — every component from the workspace
 * down a real directory (never a link) of the host's own user that no other
 * user may write, the log a regular file with one link, nothing in the
 * directory a link. A directory a session could have planted (a link, a
 * hard-linked log, a link inside) is refused: the session does not start.
 */
function assertHostMadeSessionDir(root: string, logPath: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const rootReal = realpathSync(root);
  const dir = join(realpathSync(dirname(dirname(resolve(logPath)))), basename(dirname(resolve(logPath))));
  let at = rootReal;
  for (const part of relative(rootReal, dir).split("/").filter((item) => item !== "")) {
    at = join(at, part);
    const stat = lstatSync(at);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`the session directory's component ${part} is not a real directory`);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`the session directory's component ${part} is not the host's own`);
  }
  if ((lstatSync(dir).mode & 0o022) !== 0) throw new Error("the session directory may be written by another user");
  const log = lstatSync(resolve(logPath), { throwIfNoEntry: false });
  if (log !== undefined && (!log.isFile() || log.nlink !== 1)) throw new Error("the session log is not a regular file of one link");
  for (const name of readdirSync(dir)) {
    if (lstatSync(join(dir, name)).isSymbolicLink()) throw new Error(`the session directory holds a link (${name})`);
  }
}

/** Host-temp base holders this process made: removed with the session —
 * when the process that ran it exits. */
const HOST_TEMP_HOLDERS = new Set<string>();
let holderCleanup = false;

/**
 * The host-owned directory for the base of a session whose own directory
 * lies inside its workspace (B1, D57f): made exclusively (mkdtemp: mode
 * 0700, never through a link) in the system temporary directory, named by
 * the session's id (the log's directory name) and a hash of its log path;
 * verified to be a real directory of the host's own user outside the
 * workspace; removed when the process exits. Throws when none can be made.
 */
function hostTempBaseHolder(logPath: string, workspace: string): string {
  const temp = realpathSync(tmpdir());
  if (inside(workspace, temp)) throw new Error("the system temporary directory lies inside the workspace");
  const id = basename(dirname(resolve(logPath))).replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 48) || "session";
  const bound = createHash("sha256").update(resolve(logPath)).digest("hex").slice(0, 12);
  const holder = mkdtempSync(join(temp, `dokkabi-base-${id}-${bound}-`));
  const stat = lstatSync(holder);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error("the host-temp base directory is not the host's own");
  }
  HOST_TEMP_HOLDERS.add(holder);
  if (!holderCleanup) {
    holderCleanup = true;
    process.once("exit", () => {
      for (const path of HOST_TEMP_HOLDERS) rmSync(path, { recursive: true, force: true });
    });
  }
  return holder;
}

/** The session's base record, or undefined when it cannot be had (the
 * caller then takes what depends on it as unknown). */
export function sessionBaseRecord(log: EventLog, workspaceRoot: string): BaseRecord | undefined {
  const base = sessionBase(log, workspaceRoot);
  return base instanceof BaseUnavailable ? undefined : base;
}

/** At a session's boot (B1): its base, established before the session's
 * first request — or the session does not start. Throws BaseUnavailable. */
export function requireSessionBase(log: EventLog, workspaceRoot: string): BaseRecord {
  const base = sessionBase(log, workspaceRoot);
  if (base instanceof BaseUnavailable) throw base;
  return base;
}

/** What the session's images cover: its base record's coverage, or an
 * unknown one saying why there is none (B1). */
export function sessionCoverage(log: EventLog, workspaceRoot: string): CoverageBase {
  const base = sessionBase(log, workspaceRoot);
  return base instanceof BaseUnavailable ? unknownCoverage(base.reason) : base.coverage;
}

/** A digest cache for the session's images: its coverage, and its own base
 * directory — host-owned, beside the log — as the first place the file
 * system's clock is probed (F3). */
export function sessionDigestCache(log: EventLog, workspaceRoot: string, clockDirs: readonly string[] = []): DigestCache {
  const base = sessionBase(log, workspaceRoot);
  const world = sessionWritableWorld(log, workspaceRoot);
  if (base instanceof BaseUnavailable) return createDigestCache(unknownCoverage(base.reason), { clockDirs, world });
  const warm = WARM.get(log);
  if (warm !== undefined && clockDirs.length === 0 && warm.base.identity === base.coverage.identity) {
    WARM.delete(log);
    warm.world = world;
    return warm;
  }
  return createDigestCache(base.coverage, { clockDirs: [...clockDirs, base.dir], world });
}

/** A digest cache over the base a log names, read back (a log another
 * process wrote): unknown when it cannot be loaded (B1). */
export function recordedBaseCache(events: readonly EventRecord[], clockDirs: readonly string[] = []): DigestCache {
  const base = loadRecordedBase(events);
  return base instanceof BaseUnavailable
    ? createDigestCache(unknownCoverage(base.reason), { clockDirs, ...worldOfRecordedBase(events) })
    : createDigestCache(base.coverage, { clockDirs: [...clockDirs, base.dir], ...worldOfRecordedBase(events) });
}

/** The world of a session read back from its log in another process: the
 * tree the log's base row names, and that session's own directory when it
 * lies inside the tree (host-owned, W2). Its policies are not known here. */
function worldOfRecordedBase(events: readonly EventRecord[]): { world?: ReturnType<typeof writableWorldOf> } {
  const row = [...events].reverse().find((event) => event.name === BASE_RECORD_ROW)?.payload as { root?: unknown; session_dir?: unknown } | undefined;
  if (typeof row?.root !== "string") return {};
  return { world: writableWorldOf(row.root, [], typeof row.session_dir === "string" ? [row.session_dir] : []) };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
