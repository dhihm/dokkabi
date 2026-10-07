/**
 * Remote working-tree change detection.
 *
 * Dokkabi renders a diff for local edit/write calls, but a model working on
 * another machine changes files through shell commands — so nothing in the
 * harness could say what actually moved there. A `git diff` is not decoration:
 * it is how an operator confirms the fix is the fix, and the blind spot is
 * where a fabricated test harness went unnoticed.
 *
 * The file-level signal is close to free (`git diff --numstat` measured at
 * 0.01s on the remote, plus one ~100ms round trip). The patch body is not —
 * a 41KB working tree would cost ~12k tokens every probe — so the caller
 * fetches hunks only for the paths this module reports as changed.
 */

export interface NumstatEntry {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** git reports `-\t-` for a binary file; there are no line counts to show. */
  readonly binary?: boolean;
}

/** Parse `git diff --numstat`. A malformed row is skipped, never thrown on. */
export function parseNumstat(text: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // Exactly two tabs matter: a path may itself contain spaces, and git only
    // quotes it when it holds a tab or control character.
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const addedRaw = line.slice(0, first);
    const removedRaw = line.slice(first + 1, second);
    const path = line.slice(second + 1).trim();
    if (!path) continue;
    if (addedRaw === "-" && removedRaw === "-") {
      entries.push({ path, added: 0, removed: 0, binary: true });
      continue;
    }
    const added = Number(addedRaw);
    const removed = Number(removedRaw);
    if (!Number.isInteger(added) || !Number.isInteger(removed)) continue;
    entries.push({ path, added, removed });
  }
  return entries;
}

function key(entry: NumstatEntry): string {
  return entry.binary ? "bin" : `${entry.added}/${entry.removed}`;
}

/**
 * Paths whose diff against HEAD moved between two probes — what this call
 * changed. A file reverted to HEAD counts: disappearing from the diff is
 * itself a change the operator should see. With no prior probe, every dirty
 * path is reported, so the first look shows the standing state.
 */
export function changedPaths(
  before: readonly NumstatEntry[] | undefined,
  after: readonly NumstatEntry[],
): string[] {
  const previous = new Map((before ?? []).map((entry) => [entry.path, key(entry)]));
  const changed: string[] = [];
  for (const entry of after) {
    if (previous.get(entry.path) !== key(entry)) changed.push(entry.path);
    previous.delete(entry.path);
  }
  // Whatever remains was dirty before and is clean now.
  for (const path of previous.keys()) changed.push(path);
  return changed;
}

/**
 * alias → remote workspace, read from a work plan's cases. A case that names
 * both the host it runs on and the directory holding its code has already told
 * the harness where to look for changes; asking the operator to declare it a
 * second time would just be a way to get it wrong.
 */
export function remoteWorkspacesFromPlan(plan: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const cases = (plan as { cases?: unknown })?.cases;
  if (!Array.isArray(cases)) return out;
  for (const entry of cases) {
    if (!entry || typeof entry !== "object") continue;
    const { host, dir } = entry as { host?: unknown; dir?: unknown };
    if (typeof host !== "string" || typeof dir !== "string") continue;
    if (!host.trim() || !dir.trim()) continue;
    // First declaration wins: a later case disagreeing about the same host is
    // a plan bug, and silently switching directories mid-run would hide it.
    if (Object.hasOwn(out, host)) continue;
    Object.defineProperty(out, host, {
      configurable: true,
      enumerable: true,
      value: dir,
      writable: true,
    });
  }
  return out;
}

/**
 * How one row of a rendered remote diff should be toned.
 *
 * The rule used to be "anything not starting with '-' is an addition", which
 * painted the per-file stat rows with the added-line background and turned the
 * whole block into one lavender wash. A summary is not an addition and a file
 * header is not content.
 */
export function diffRowTone(row: string): "diffAdd" | "diffDel" | "lane" | "muted" {
  if (row.startsWith("+")) return "diffAdd";
  if (row.startsWith("-")) return "diffDel";
  if (row.startsWith("── ")) return "lane";
  return "muted";
}

const DEFAULT_MAX_PER_FILE = 6;
const DEFAULT_MAX_TOTAL = 24;

/**
 * Body rows for a patch: a header per file, then that file's changed lines.
 *
 * git's own `+++`/`---` markers are dropped — they are file headers wearing
 * content's clothes, and letting them through means two rows of every patch
 * are miscoloured. The budget is per file as well as overall, because a flat
 * cap was swallowed whole by whichever file git happened to print first and
 * every later file rendered as nothing at all.
 */
export function hunkRows(
  patch: string,
  limits: { readonly maxPerFile?: number; readonly maxTotal?: number },
): string[] {
  const maxPerFile = limits.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxTotal = limits.maxTotal ?? DEFAULT_MAX_TOTAL;
  const rows: string[] = [];
  let file: string | undefined;
  let shown = 0;
  let skipped = 0;
  const flush = (): void => {
    if (skipped > 0) rows.push(`  …(+${skipped} more lines)`);
    skipped = 0;
  };
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(?:.+?) b\/(.+)$/u.exec(line);
    if (header?.[1]) {
      flush();
      file = header[1];
      shown = 0;
      continue;
    }
    if (/^(\+\+\+|---)/u.test(line)) continue;
    if (!/^[+-]/u.test(line)) continue;
    if (rows.length >= maxTotal) break;
    if (shown === 0 && file) rows.push(`── ${file}`);
    if (shown >= maxPerFile) {
      skipped += 1;
      continue;
    }
    rows.push(line);
    shown += 1;
  }
  flush();
  return rows;
}
