import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { EventLog } from "./event-log.ts";

/**
 * ONE TOOL-CACHE DIRECTORY PER SESSION (G3, D57g; design memo §121).
 *
 * The session's executions on its own tree share one cache directory, so a
 * second pytest run reads the bytecode the first wrote. It lives OUTSIDE the
 * tree, in a directory the host makes for the (session, tree) pair: a
 * host-owned holder (mode 0700, made by mkdtemp, never a link) with one
 * `cache/` inside. The sandbox grants the session's executions read and
 * write on `cache/` and nothing else in the holder — the session cannot
 * replace, rename or relink the cache it is given — and the tools reach it
 * only through their own environment variables (sandbox-env.ts
 * toolCacheEnvironment). An observation on any other tree — a recheck's or a
 * verifier's copy, a managed checker's snapshot, the base pass — never gets
 * this directory: a cache is derived state the build's executions produced.
 *
 * The cache is not part of the image (it is not the tree); it is a root of
 * the session's writable world, so a link from the tree into it is
 * identified by what it reaches (W1). The holder is removed when the last
 * policy using it is disposed, or when the process exits.
 *
 * CACHES ARE PER ROLE (G3', D57h; design memo §123). The session role above
 * is the only shared one. Every run the host JUDGES — the final case pass,
 * the base pass, the verify step and its preflight, rechecks, verifier
 * copies, managed checkers — takes the "judged" role instead: a holder of
 * its own per policy (never shared, never the session's), whose `cache/` the
 * host empties immediately before and immediately after every execution
 * under that policy (renewJudgedToolCache, called at the spawn seam). So a
 * judged execution starts with an empty cache no other execution — the
 * session's or an earlier judged one — could have written, and a verdict
 * depends only on the tree's content, never on derived state (bytecode,
 * tool caches) an earlier execution produced.
 */

interface Entry {
  readonly holder: string;
  readonly dir: string;
  refs: number;
}

const SESSIONS = new WeakMap<EventLog, Map<string, Entry>>();
const HOLDERS = new Set<string>();
/** The live judged cache directories (G3'): renewed at every execution. */
const JUDGED = new Set<string>();
let exitHook = false;

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** How many session cache directories this process holds (diagnostics). */
export function liveToolCacheCount(): number {
  return HOLDERS.size;
}

/**
 * The session's tool-cache directory for `tree` (its real path), made on
 * first use; `release` gives the lease back. Undefined when the host cannot
 * place one outside the tree (a tree that contains the system temporary
 * directory): the policy then falls back to caches of its own.
 */
/**
 * A fresh host-owned holder with an empty `cache/` inside, outside `treeReal`
 * and not containing it; undefined when the host cannot place one there.
 */
function makeHolder(treeReal: string): { readonly holder: string; readonly dir: string } | undefined {
  const holder = realpathSync(mkdtempSync(join(tmpdir(), "dokkabi-tool-cache-")));
  if (within(treeReal, holder) || within(holder, treeReal)) {
    rmSync(holder, { recursive: true, force: true });
    return undefined;
  }
  const dir = join(holder, "cache");
  mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    rmSync(holder, { recursive: true, force: true });
    return undefined;
  }
  HOLDERS.add(holder);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const path of HOLDERS) rmSync(path, { recursive: true, force: true });
    });
  }
  return { holder, dir };
}

/**
 * The session's tool-cache directory for `tree` (its real path), made on
 * first use; `release` gives the lease back. Undefined when the host cannot
 * place one outside the tree (a tree that contains the system temporary
 * directory): the policy then falls back to caches of its own.
 */
export function acquireSessionToolCache(log: EventLog, tree: string): { readonly dir: string; readonly release: () => void } | undefined {
  let treeReal: string;
  try {
    treeReal = realpathSync(tree);
  } catch {
    return undefined;
  }
  let byTree = SESSIONS.get(log);
  if (byTree === undefined) {
    byTree = new Map();
    SESSIONS.set(log, byTree);
  }
  let entry = byTree.get(treeReal);
  if (entry === undefined) {
    const made = makeHolder(treeReal);
    if (made === undefined) return undefined;
    entry = { holder: made.holder, dir: made.dir, refs: 0 };
    byTree.set(treeReal, entry);
  }
  entry.refs += 1;
  const leased = entry;
  const owner = byTree;
  let released = false;
  return {
    dir: leased.dir,
    release: () => {
      if (released) return;
      released = true;
      leased.refs -= 1;
      if (leased.refs > 0) return;
      if (owner.get(treeReal) === leased) owner.delete(treeReal);
      HOLDERS.delete(leased.holder);
      rmSync(leased.holder, { recursive: true, force: true });
    },
  };
}

/**
 * A judged run's own tool-cache directory for `tree` (G3', D57h): a fresh
 * holder for this one policy, shared with nothing, removed on `release`.
 * Its contents live for one execution only (renewJudgedToolCache).
 * Undefined when the host cannot place one outside the tree.
 */
export function acquireJudgedToolCache(tree: string): { readonly dir: string; readonly release: () => void } | undefined {
  let treeReal: string;
  try {
    treeReal = realpathSync(tree);
  } catch {
    return undefined;
  }
  const made = makeHolder(treeReal);
  if (made === undefined) return undefined;
  JUDGED.add(made.dir);
  let released = false;
  return {
    dir: made.dir,
    release: () => {
      if (released) return;
      released = true;
      JUDGED.delete(made.dir);
      HOLDERS.delete(made.holder);
      rmSync(made.holder, { recursive: true, force: true });
    },
  };
}

/** Whether `dir` is a live judged cache directory (G3'). */
export function isJudgedToolCache(dir: string | undefined): boolean {
  return dir !== undefined && JUDGED.has(dir);
}

/**
 * Empty a judged cache directory (G3'): the host removes `cache/` — whatever
 * an execution left there, links included, never followed — and makes it
 * again, empty, mode 0700. Called immediately before and immediately after
 * every execution under a judged policy, so each execution observes a cache
 * made for it alone. A directory that is not a live judged cache is left
 * alone (the session's is shared by design). Throws when the host cannot
 * make it a plain empty directory again: the execution does not run.
 */
export function renewJudgedToolCache(dir: string | undefined): void {
  if (dir === undefined || !JUDGED.has(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("judged tool-cache directory could not be renewed");
}
