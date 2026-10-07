import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join, sep } from "node:path";
import { dlopen } from "bun:ffi";
import type { EventLog } from "../host/event-log.ts";
import type { ToolOutcome } from "../tools/execute.ts";
import { resolveRecordedToolOutput, type RecordedOutput } from "../tools/recorded-output.ts";
import { chmodBeneath, lstatBeneath, safeRoot, unlinkBeneath, walkBeneath } from "./link-safe-fs.ts";
import { refusedOutcome, type RunnerOutcome, type RunnerResultAdapter } from "./results/contract.ts";

/**
 * Running a recorded case somewhere that is NOT the live workspace.
 *
 * Two passes need exactly this: the base-tree observation at the conclusion
 * (ledger-base.ts) and the case probe at record time (ledger-probe.ts). Both
 * work in a throwaway `cp -a` copy of the tree, both owe the case the same
 * command in a place whose absolute root differs from the live one, and both
 * read a native adapter's outcome without minting the runner rows the final
 * pass mints. The mechanics live here once so the two passes cannot drift:
 * a case command that is destructive — `rm -rf _build`, `git stash` — must
 * never reach the tree the session is working in.
 */

/** Clone the workspace beside itself inside a private holder directory.
 * `cp -a` keeps the tree byte-faithful (the relocatable environment of D2
 * comes along, which is the point: a case must be able to run there). A
 * policy sealed for the COPY then detects the copy's OWN environment and
 * puts that bin on the child PATH, never the live root's
 * (host/sandbox-env.ts, CASE-PARITY-A). */
export function makeWorkspaceCopy(source: string, holder: string, remainingMs: number | undefined): string {
  const copy = join(holder, "ws");
  // The copy owes its caller the same bound everything else has: the time
  // left before the outer wall, never more than a few minutes.
  const timeoutMs = Math.max(1, Math.min(300_000, remainingMs ?? 300_000));
  const copied = spawnSync("cp", ["-a", source, copy], { timeout: timeoutMs, encoding: "buffer" });
  if (copied.status !== 0 || copied.error || !existsSync(copy)) {
    throw new Error(`the workspace copy could not be made (cp exit ${String(copied.status)}): ${copied.stderr?.toString().slice(0, 200)}`);
  }
  // S1 (D57c): the copy is a tree, never a link. `cp -a` copies a link as
  // the link, so a workspace root that is itself a link — a session under a
  // fence that confines by path can replace the directory it was given —
  // would make the "copy" a way into wherever it points, and every case run
  // "in the copy" would run there.
  let entry;
  try {
    entry = lstatSync(copy);
  } catch {
    entry = undefined;
  }
  if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
    spawnSync("rm", ["-f", copy], { timeout: 30_000 });
    throw new Error("the workspace copy could not be made: the workspace root is not a real directory (a symbolic link is never copied as the tree)");
  }
  return copy;
}

/** Delete the throwaway copy. A mount reported at or under the holder means
 * rm must not run at all (findmnt -R check); otherwise rm -rf, with
 * --one-file-system on the platforms whose rm has it so a stray bind never
 * walks out of the copy. A missing findmnt (non-Linux hosts) is not an
 * error: nothing these passes do creates mounts there. rm never follows a
 * link inside the tree (S1): it removes the link. */
export function removeWorkspaceCopy(holder: string): void {
  if (holdsMount(holder)) return;
  spawnSync("rm", rmArgs(holder), { encoding: "utf8", timeout: 120_000 });
}

/** removeWorkspaceCopy, the rm running while the caller goes on; the promise
 * settles once it is done (E1'': one execution's copy is removed while the
 * next one runs). */
export function removeWorkspaceCopyLater(holder: string): Promise<void> {
  if (holdsMount(holder)) return Promise.resolve();
  try {
    const child = Bun.spawn(["rm", ...rmArgs(holder)], { stdout: "ignore", stderr: "ignore" });
    return child.exited.then(() => undefined, () => undefined);
  } catch {
    removeWorkspaceCopy(holder);
    return Promise.resolve();
  }
}

function holdsMount(holder: string): boolean {
  try {
    const listed = spawnSync("findmnt", ["-rn", "-R", holder], { encoding: "utf8", timeout: 30_000 });
    return (listed.status ?? 0) === 0 && (listed.stdout ?? "").trim().length > 0;
  } catch {
    // findmnt unavailable: nothing mounted by these passes.
    return false;
  }
}

function rmArgs(holder: string): string[] {
  return process.platform === "darwin" ? ["-rf", holder] : ["-rf", "--one-file-system", holder];
}

// --- one pristine copy per execution (E1'', D57c) -------------------------------

/** How an execution's copy was made. */
export type CloneStrategy = "clonefile" | "reflink" | "copy";

/** A pristine copy: made once from the developer's tree, never bound into a
 * sandbox and never run in, and the setuid/setgid files it holds (a clone
 * drops those bits, clonefile(2)). */
export interface PristineCopy {
  readonly copy: string;
  special?: readonly { readonly path: Buffer; readonly mode: number }[];
}

let clonefileSymbol: ((src: Buffer, dst: Buffer, flags: number) => number) | undefined | null;

/** macOS clonefile(2), loaded once from the system library; null where it is
 * not available. */
function clonefileCall(): ((src: Buffer, dst: Buffer, flags: number) => number) | null {
  if (clonefileSymbol !== undefined) return clonefileSymbol;
  clonefileSymbol = null;
  if (process.platform !== "darwin") return null;
  try {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: ["ptr", "ptr", "u32"], returns: "i32" },
    });
    clonefileSymbol = (src, dst, flags) => library.symbols.clonefile(src, dst, flags) as number;
  } catch {
    clonefileSymbol = null;
  }
  return clonefileSymbol;
}

/** CLONE_NOFOLLOW: the source itself is never followed. */
const CLONE_NOFOLLOW = 0x0001;

const cString = (text: string) => Buffer.from(`${text}\u0000`);

/** Every regular file of the pristine copy with a setuid or setgid bit, and
 * its full mode: walked once, never through a link. */
function specialModes(pristine: string): { path: Buffer; mode: number }[] {
  const out: { path: Buffer; mode: number }[] = [];
  const root = safeRoot(pristine, "the pristine copy");
  walkBeneath(root, Buffer.alloc(0), (path, entry) => {
    if (entry.isFile() && (Number(entry.mode) & 0o6000) !== 0) out.push({ path, mode: Number(entry.mode) & 0o7777 });
    return entry.isDirectory();
  });
  return out;
}

/**
 * E1'' (D57c): a fresh copy of `pristine` at `<holder>/ws` for ONE recheck
 * execution, so nothing an earlier execution wrote is there. As cheap as the
 * file system allows while every copy stays its own:
 *   - macOS (APFS): clonefile(2) of the whole tree in one call — copy on
 *     write, so a write to one copy is private to it; the setuid and setgid
 *     bits it drops are given back (through the pinned copy, S1);
 *   - Linux: `cp -a --reflink=auto` — copy on write where the file system
 *     has it, a full copy where it does not;
 *   - otherwise, or when those fail: `cp -a`.
 * Never hard links: a write through one reaches every copy sharing the inode.
 */
export function cloneWorkspaceCopy(pristine: PristineCopy, holder: string, remainingMs: number | undefined): { readonly copy: string; readonly strategy: CloneStrategy } {
  const copy = join(holder, "ws");
  const timeoutMs = Math.max(1, Math.min(300_000, remainingMs ?? 300_000));
  const isDirectory = () => {
    try {
      const entry = lstatSync(copy);
      return entry.isDirectory() && !entry.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const clone = clonefileCall();
  if (clone !== null && clone(cString(pristine.copy), cString(copy), CLONE_NOFOLLOW) === 0 && isDirectory()) {
    pristine.special ??= specialModes(pristine.copy);
    if (pristine.special.length > 0) {
      const root = safeRoot(copy, "the recheck copy");
      for (const item of pristine.special) chmodBeneath(root, item.path, item.mode, "clone");
    }
    return { copy, strategy: "clonefile" };
  }
  if (process.platform === "linux") {
    const reflinked = spawnSync("cp", ["-a", "--reflink=auto", pristine.copy, copy], { timeout: timeoutMs, encoding: "buffer" });
    if (reflinked.status === 0 && !reflinked.error && isDirectory()) return { copy, strategy: "reflink" };
    spawnSync("rm", rmArgs(copy), { timeout: 120_000 });
  }
  const copied = spawnSync("cp", ["-a", pristine.copy, copy], { timeout: timeoutMs, encoding: "buffer" });
  if (copied.status !== 0 || copied.error || !isDirectory()) {
    throw new Error(`the execution's copy could not be made (cp exit ${String(copied.status)}): ${copied.stderr?.toString().slice(0, 200)}`);
  }
  return { copy, strategy: "copy" };
}

/** A copy whose `.git` is a file or a link (a linked worktree) loses it: the
 * copy then has no repository, and nothing run in it reaches the linked one.
 * S1: removed as the file or the link it is, below the pinned copy. Shared by
 * the recheck's pristine copy and a property's per-execution clones (D58). */
export function detachLinkedGit(copy: string): void {
  const root = safeRoot(copy, "the recheck copy");
  const dotGit = Buffer.from(".git");
  const entry = lstatBeneath(root, dotGit, "detach");
  if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) unlinkBeneath(root, dotGit, "detach");
}

/** The live root's absolute spellings: the root itself plus its
 * "~"-abbreviation when the root lies under HOME. */
function liveRootForms(liveRoot: string): string[] {
  const home = process.env.HOME;
  if (home === undefined || !liveRoot.startsWith(home + sep)) return [liveRoot];
  return [liveRoot, `~${liveRoot.slice(home.length)}`];
}

/** Map every occurrence of the live workspace root — and its "~"-abbreviation
 * when the root lies under HOME — that is followed by "/", whitespace, a
 * quote, ")" or the end of the string to the copy root (CASE-PORTABILITY
 * D29): a copy pass owes the case the same command, in a place where the
 * live absolute path does not exist. Returns the translated text and the
 * number of replacements, so the row can record it. */
export function translateLiveRoots(text: string, liveRoot: string, copyRoot: string): { text: string; count: number } {
  let count = 0;
  let translated = text;
  for (const form of liveRootForms(liveRoot)) {
    const pattern = new RegExp(`${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\s"')]|$)`, "gu");
    translated = translated.replace(pattern, () => {
      count += 1;
      return copyRoot;
    });
  }
  return { text: translated, count };
}

/** The adapter outcome of a copy run, read from the recorded tool output the
 * same way the final pass reads it — without appending runner rows: a copy
 * observation is one row, never the `ledger/runner_*` pair that carries the
 * final pass's native evidence. */
export function runnerOutcomeWithoutRows(
  log: EventLog,
  adapter: RunnerResultAdapter,
  outcome: ToolOutcome,
): RunnerOutcome | undefined {
  const recorded: RecordedOutput = resolveRecordedToolOutput(log, outcome);
  if (!recorded.ok && recorded.code !== "process_completion_unavailable") return undefined;
  if (recorded.ok) return adapter.read(recorded.body, recorded.exitCode);
  const source = log.events.find((row) => row.seq === recorded.seq && row.hash === recorded.hash);
  const execution = source?.payload.execution as { timed_out?: boolean; signal?: string } | undefined;
  return execution?.timed_out === true
    ? refusedOutcome("incomplete", "native test process timed out")
    : typeof execution?.signal === "string"
      ? refusedOutcome("cancelled", `native test process ended with ${execution.signal}`)
      : refusedOutcome("execution_unavailable", "native test process did not complete");
}
