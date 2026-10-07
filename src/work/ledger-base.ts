import { hostWorkTreeListing, withHostBuiltIndex } from "../host/host-index.ts";
import { writableWorldOf } from "../host/writable-world.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import { projectEnvironmentDirs } from "../host/environment-facts.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import { createDigestCache, mintReceipt, workspaceDigest, workspaceListing, type DigestCache } from "../host/execution-receipt.ts";
import { BaseChanges, type LineCounts } from "../host/base-record.ts";
import { BaseUnavailable, loadRecordedBase, sessionCoverage, sessionDigestCache } from "./session-base.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxPolicy } from "../host/sandbox.ts";
import type { EventRecord } from "../host/schema.ts";
import { executeTool, type ToolOutcome } from "../tools/execute.ts";
import { caseLaunch } from "./case-launch.ts";
import { matchingCaseRunner } from "./case-runners.ts";
import { isConventionalTestPath } from "./test-paths.ts";
import { caseTimeoutSeconds } from "./case-timeout.ts";
import { LEDGER_PLANNER } from "./ledger-label.ts";
import { ensureDirBeneath, LinkSafetyError, lstatBeneath, renameBeneath, rmdirBeneath, safeRoot, unlinkBeneath, type SafeRoot } from "./link-safe-fs.ts";
import { bytesKey, bytesOfKey, exactUtf8 } from "./path-bytes.ts";
import { completeCheckRun, discardCheckRun, expectationRowFields, isCheckCase, prepareCheckRun, processTreeSurvived, type CheckEvaluation } from "./ledger-check.ts";
import {
  clonePropertyExecutor,
  freshSampleSeed,
  isPropertyCase,
  mintPropertyReceipt,
  propertyRowFields,
  propertyVerdict,
  recordedPropertyReplay,
  runProperty,
  sessionPropertyStore,
  type PropertyObservation,
  type PropertyReplay,
} from "./ledger-property.ts";
import { scratchOption } from "./ledger-probe.ts";
import { LEDGER_MIRROR_PATH, projectLedger, revisionCases, type LedgerCase } from "./plan-ledger.ts";
import { makeWorkspaceCopy, removeWorkspaceCopy, runnerOutcomeWithoutRows, translateLiveRoots } from "./workspace-copy.ts";

/**
 * The base-tree observation (LABEL-EVIDENCE C1, design A): after the final
 * observations are recorded, the host also runs every NON-GUARD case once on
 * a throwaway copy of the workspace whose tracked files are restored to the
 * session's base commit, whose tracked test files the session changed are
 * then put back as the session left them (D42, keepTrackedTestsOnBase), and
 * whose untracked, session-authored product files are then removed (D34,
 * pruneUntrackedOnBase): the base tree is the base commit plus the session's
 * tests plus what a case needs in order to run. This is what turns "the case
 * reproduces" into "the case demonstrates a change": a case red on the base tree and green on the
 * final tree is the model's own work made visible, while a case green on
 * both trees was never evidence of anything.
 *
 * The same file carries the D26 target observation: the files each case's
 * and guard's command points at that the session changed against its base,
 * recorded as paths and line counts (never content) so the label can report
 * evidence that was read off a file the session itself rewrote.
 *
 * Nothing here gates anything. The base pass records one `ledger/case_base` row
 * per non-guard case (green | red | not_runnable) with the receipt pattern
 * the final observations use, never throws — a copy that cannot be made or a
 * base that cannot be resolved records `not_runnable` for every non-guard
 * case — and never touches the real workspace: the restore happens only in
 * the copy, which is deleted afterwards. Guards are not run on base: they
 * are standing invariants expected green throughout, not evidence.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The workspace's HEAD commit through the sealed host git boundary;
 * undefined whenever git cannot answer (no repository, no commits, untrusted
 * metadata). Read-only, so it is safe to call on the real workspace. */
export function workspaceHeadRef(root: string): string | undefined {
  try {
    const head = spawnSealedHostGit(root, ["rev-parse", "HEAD"], { timeoutMs: 60_000 });
    if ((head.exitCode ?? 1) !== 0) return undefined;
    const ref = head.stdout.toString().trim();
    return /^[0-9a-f]{40}$/u.test(ref) ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** The base commit recorded at session open (`work/ledger_session`
 * `base_ref`), when the log carries one. Every recording made before this
 * field existed reads undefined here. */
export function recordedBaseRef(events: readonly EventRecord[]): string | undefined {
  for (const event of events) {
    if (event.name !== "work/ledger_session") continue;
    const ref = event.payload.base_ref;
    if (typeof ref === "string" && /^[0-9a-f]{40}$/u.test(ref)) return ref;
  }
  return undefined;
}

/** The base a base-tree observation restores to: the recorded session base
 * when the log carries one (the commit as the harness froze the task, taken
 * at session open so a model that commits mid-session does not become its
 * own base), else the workspace HEAD now — a session that never commits is
 * standing on its base. */
export function resolveLedgerBaseRef(events: readonly EventRecord[], workspaceRoot: string): string | undefined {
  return recordedBaseRef(events) ?? workspaceHeadRef(workspaceRoot);
}

// --- conclusion-time target observation (D26, design A) ----------------------
//
// The files a session changed against its base can turn a green guard or a
// red→green case into something weaker: evidence read off a file the session
// itself rewrote. The observation below is data, never a gate: one
// `ledger/case_targets` row per case AND guard, carrying only the paths of
// the command's targets that changed and their added/removed line counts.
// The label decides what those rows mean (ledger-label.ts); nothing here
// refuses or rewrites anything, and the real workspace is only read.

/** One changed target of one case: the workspace-relative path, the counts of
 * the diff's `+` and `-` lines against the session base (a modified line
 * counts on both sides; a pure addition counts only on `added`), and whether
 * the path is a conventional test path (D32) — decided here, at observation
 * time, so the label never consults the registry and stays a pure function of
 * the log (I7). */
export interface LedgerCaseTarget {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly test: boolean;
  /** The line counts could not be read (the base's bytes or the file's now):
   * a decision that needs them never takes the change as harmless (C1). */
  readonly unknown?: true;
}

/** Which paths a session changed, and each one's line counts against its
 * base: the host's content diff of its base record and a listing now
 * (BaseChanges, C1) — the shape caseCommandTargets reads. */
export interface ChangedFiles {
  get(path: string): LineCounts | undefined;
}

/** File-name suffixes that make a bare command token path-like even without
 * a `/` (the same conservative shapes the reproducibility findings accept). */
const PATHY_EXTENSIONS: readonly string[] = [
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".sh", ".bash",
  ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift",
  ".php", ".pl", ".lua", ".sql", ".json", ".yaml", ".yml", ".toml", ".md", ".txt",
];

/**
 * The files the session behind `events` changed, with each file's added and
 * removed line counts (C1, D57e): the host's content diff of the base record
 * the session took at its start and the host's listing of `root` now under
 * that base's coverage — never `git diff`, whose index, flags, ignore rules
 * and configuration the session writes. Line counts are git's numstat
 * (`--ignore-space-at-eol`, D42 B2) of the base's bytes and the bytes now,
 * both read by the host and compared outside any repository; a file whose
 * base bytes the host cannot give back is marked unknown. `objectRoots`: the
 * trees whose object stores may hold the base's blobs (each blob held to the
 * base's digest). A BaseUnavailable saying why when the session has no base
 * record the host can load (B1): every decision that needs the change set is
 * then unknown.
 */
export function sessionChangedFiles(
  events: readonly EventRecord[],
  root: string,
  objectRoots: readonly string[] = [root],
  clockDirs: readonly string[] = [],
  /** A digest cache already over this base (the conclusion's own): what it
   * holds is not read again. */
  cache?: DigestCache,
): BaseChanges | BaseUnavailable {
  const record = loadRecordedBase(events);
  if (record instanceof BaseUnavailable) return record;
  try {
    const own = cache !== undefined && cache.base.identity === record.coverage.identity
      ? cache
      : createDigestCache(record.coverage, { clockDirs: [...clockDirs, record.dir] });
    return new BaseChanges(record, workspaceListing(root, own), root, objectRoots);
  } catch (error) {
    return new BaseUnavailable(`the tree could not be read against it: ${message(error).slice(0, 200)}`);
  }
}

/** The command's path-like argument tokens: those that contain a `/` or end
 * in a source/test extension, carrying no flag, variable, assignment,
 * absolute or home prefix — the reproducibility findings' conservative rules.
 * An absolute token under the workspace root passes (D29): it is relativized
 * downstream, so a case naming its targets absolutely still gets its rows. */
function pathLikeTokens(command: string, workspaceRoot: string): string[] {
  const tokens: string[] = [];
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^['"]/, "").replace(/['"]$/, "").split("::")[0] ?? "";
    if (token === "") continue;
    if (!token.includes("/") && !PATHY_EXTENSIONS.some((extension) => token.endsWith(extension))) continue;
    const absoluteUnderRoot = token === workspaceRoot || token.startsWith(workspaceRoot + sep);
    if (token.startsWith("-") || token.startsWith("$") || token.startsWith("~") || token.includes("=")) continue;
    if (token.startsWith("/") && !absoluteUnderRoot) continue;
    tokens.push(token);
  }
  return tokens;
}

/** A token as a workspace-relative path, resolved from the workspace root and
 * (when the case names one) its own directory — the two places the conclusion
 * runs the command from. An absolute token under the root is relativized
 * first (D29). undefined when the path leaves the workspace. */
function workspaceRelativePath(workspaceRoot: string, fromDirs: readonly string[], token: string): string | undefined {
  let cleaned = token.replace(/^\.\//u, "");
  if (cleaned.startsWith(workspaceRoot + sep)) cleaned = cleaned.slice(workspaceRoot.length + 1);
  for (const base of fromDirs) {
    const absolute = resolve(base, cleaned);
    if (absolute === workspaceRoot || !absolute.startsWith(workspaceRoot + sep)) continue;
    const rel = relative(workspaceRoot, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    return rel;
  }
  return undefined;
}

/**
 * The changed targets of one case command (D26): the command's path-like
 * arguments — and the test file a registered runner declares for it — that
 * resolve inside the workspace and appear in `changed`, paths and line counts
 * only. The registry's own declaration of the file the command's runner tests
 * still brings that file into the target list — a runner can name a test the
 * command spells as a module path — but it no longer decides the mark: a
 * target is a TEST file when its PATH is a conventional test path (D32),
 * whether or not a registered runner claims the command. A repository that
 * brings its own runner still runs tests, and the registry's declaration was
 * only ever marked when the path was conventional as well, so the path rule
 * covers the old one exactly. A product or data file a command names is the
 * check's subject — the work itself — and stays `test: false`. Pure over its
 * inputs; shared by the conclusion's target rows and the verify-rounds
 * recheck (D45), so the two cannot drift.
 */
export function caseCommandTargets(
  workspaceRoot: string,
  item: { readonly command?: unknown; readonly dir?: string },
  changed: ChangedFiles,
): LedgerCaseTarget[] {
  const command = typeof item.command === "string" ? item.command : "";
  const fromDirs = [workspaceRoot, ...(item.dir !== undefined && item.dir !== "" ? [resolve(workspaceRoot, item.dir)] : [])];
  const targets: LedgerCaseTarget[] = [];
  const seen = new Set<string>();
  const runnerTestFile = command === "" ? undefined : matchingCaseRunner(command)?.testFile(command);
  const testFilePath = runnerTestFile === undefined ? undefined : workspaceRelativePath(workspaceRoot, fromDirs, runnerTestFile);
  const record = (rel: string): void => {
    if (seen.has(rel)) return;
    const counts = changed.get(rel);
    if (counts === undefined) return;
    seen.add(rel);
    targets.push({
      path: rel,
      added: counts.added,
      removed: counts.removed,
      test: isConventionalTestPath(rel),
      ...(counts.unknown === true ? { unknown: true as const } : {}),
    });
  };
  if (testFilePath !== undefined) record(testFilePath);
  if (command !== "") {
    for (const token of pathLikeTokens(command, workspaceRoot)) {
      const rel = workspaceRelativePath(workspaceRoot, fromDirs, token);
      if (rel !== undefined) record(rel);
    }
  }
  return targets;
}

/** Record one `ledger/case_targets` row per case and guard: the command's
 * targets that the session changed against its base, paths and line counts
 * only. Which files changed is the host's content diff of the session's base
 * record and the tree now (C1, D57e: sessionChangedFiles). Runs after the
 * final observations, never throws, and writes nothing to the workspace. A
 * session whose base record cannot be loaded (B1, D57f) records each row
 * with `unknown` saying why and no targets: the label counts such a case or
 * guard as tampered (U1), never as untouched. */
export function observeLedgerCaseTargets(input: { log: EventLog; workspaceRoot: string; changes?: BaseChanges | BaseUnavailable }): void {
  const cases = observableCases(input.log.events);
  if (cases.length === 0) return;
  const changed = input.changes ?? sessionChangedFiles(input.log.events, input.workspaceRoot);
  for (const item of cases) {
    // V5' (D58c): a case whose data its targets cannot be read from gets no
    // row — the label keeps its prior rule for it — and never stops the pass.
    let targets: LedgerCaseTarget[] = [];
    if (!(changed instanceof BaseUnavailable)) {
      try {
        targets = caseCommandTargets(input.workspaceRoot, item, changed);
      } catch {
        continue;
      }
    }
    input.log.append({ kind: "observe", name: "ledger/case_targets", payload: {
      planner: LEDGER_PLANNER,
      case: item.id,
      guard: item.guard === true,
      ...(changed instanceof BaseUnavailable ? { targets: [], unknown: changed.reason } : { targets }),
    } });
  }
}

/** The recorded ledger's cases a pass observes (V5'): objects with a text id,
 * whatever else a hand-written graph holds; none when its cases are not a
 * list. */
export function observableCases(events: readonly EventRecord[]): LedgerCase[] {
  return revisionCases(projectLedger(events));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The whole base pass. Runs only after the final observations are recorded
 * (final evidence is never contaminated), reads only the recorded ledger,
 * and never throws. */
export function observeLedgerCasesOnBase(input: {
  log: EventLog;
  workspaceRoot: string;
  /** The run's outer wall, when the caller knows one; every base run is
   * bounded by the time left before it, exactly as the final pass is. */
  deadlineMs?: number;
  /** The session's change set against its base record (C1), when the
   * caller has it (else it is taken here): the tracked tests it changed are
   * set aside even when the session hid the change from its index. A base
   * that cannot be loaded makes the base pass unobservable (B1). */
  changes?: BaseChanges | BaseUnavailable;
}): void {
  const { log } = input;
  const cases = observableCases(log.events).filter((item) => item.guard !== true);
  if (cases.length === 0) return;
  const notRunnableAll = (reason: string): void => {
    for (const item of cases) {
      log.append({ kind: "observe", name: "ledger/case_base", payload: {
        case: item.id,
        planner: LEDGER_PLANNER,
        command: item.command,
        status: "not_runnable",
        reason,
      } });
    }
  };
  const changes = input.changes ?? sessionChangedFiles(log.events, input.workspaceRoot);
  if (changes instanceof BaseUnavailable) {
    notRunnableAll(`the base tree cannot be observed: ${changes.message}`);
    return;
  }
  const baseRef = resolveLedgerBaseRef(log.events, input.workspaceRoot);
  if (baseRef === undefined) {
    notRunnableAll("the base tree cannot be resolved: the workspace carries no readable base commit");
    return;
  }
  const remainingMs = input.deadlineMs === undefined ? undefined : input.deadlineMs - Date.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    notRunnableAll("the run's outer wall left no time to observe the base tree");
    return;
  }
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-ledger-base-"));
  try {
    const copy = makeWorkspaceCopy(input.workspaceRoot, holder, remainingMs);
    // The session's tracked test files are read off the copy BEFORE the
    // restore — the copy is still the live workspace's final state then —
    // and set aside inside the holder, never in the live workspace.
    // The tests tracked in the base commit that the session changed by
    // content (C1): set aside whatever the copy's index says of them.
    const record = changes.record;
    const hidden = record.head !== baseRef
      ? []
      : [...changes.changedKeys.keys()]
        .map((key) => exactUtf8(bytesOfKey(key)))
        .filter((path): path is string => path !== undefined && isConventionalTestPath(path)
          && record.tracked.get(bytesKey(Buffer.from(path)))?.headOid !== undefined);
    const setAside = setAsideTrackedTests(copy, baseRef, join(holder, "kept-tests"), hidden);
    if (!setAside.ok) {
      notRunnableAll(setAside.reason);
      return;
    }
    const restored = restoreTrackedToBase(copy, baseRef);
    if (!restored.ok) {
      notRunnableAll(restored.reason);
      return;
    }
    // The session's tests stand on the base tree (D42): a new test added to
    // an existing test file must run against base product code and fail
    // there, exactly as an untracked new test file does (D34).
    const kept = keepTrackedTestsOnBase(copy, setAside.entries);
    if (!kept.ok) {
      notRunnableAll(kept.reason);
      return;
    }
    // The base tree is the base commit plus the session's tests plus what a
    // case needs in order to run (D34): the session's own product files leave
    // the copy before anything is digested or executed, so `copy_digest` is
    // the tree the cases ran on. The tracked tests just put back are not the
    // prune's to count: they are already on the row as tracked_kept_tests.
    const pruned = pruneUntrackedOnBase(copy, baseRef, new Set(setAside.entries.map((entry) => entry.path)));
    if (!pruned.ok) {
      notRunnableAll(pruned.reason);
      return;
    }
    const counts: BaseTreeCounts = { ...pruned.counts, tracked_kept_tests: kept.count };
    // The base tree's images cover what the session's base decides (C1),
    // the clock probed in the holder, the host's own directory on the copy's
    // device (F3).
    const cache = createDigestCache(sessionCoverage(log, input.workspaceRoot), { clockDirs: [holder] });
    const copyDigest = workspaceDigest(copy, cache);
    let policy: SandboxPolicy | undefined;
    try {
      for (const item of cases) {
        if (policy === undefined) {
          policy = createPolicy({ mode: "workspace-write", workspaceRoot: copy, log, toolCache: "judged", ...scratchOption(log, input.workspaceRoot) });
          // What the base runs can write (W, D57g).
          cache.world = writableWorldOf(copy, [policy]);
        }
        try {
          observeOneBaseCase({ log, liveRoot: input.workspaceRoot, copyRoot: copy, policy, cache, item, baseRef, copyDigest, counts, deadlineMs: input.deadlineMs });
        } catch (error) {
          log.append({ kind: "observe", name: "ledger/case_base", payload: {
            case: item.id, planner: LEDGER_PLANNER, command: item.command, base_ref: baseRef,
            ...counts,
            status: "not_runnable", reason: `the base run failed: ${message(error).slice(0, 200)}`,
          } });
        }
      }
    } finally {
      if (policy) disposeSandboxPolicy(policy);
    }
  } catch (error) {
    notRunnableAll(`the base tree could not be observed: ${message(error).slice(0, 200)}`);
  } finally {
    removeWorkspaceCopy(holder);
  }
}

/** In the COPY only: tracked files become the base tree again — the tracked
 * test files the session changed were set aside first and come back after
 * (keepTrackedTestsOnBase). Untracked
 * files are left standing here and decided by pruneUntrackedOnBase below —
 * a session-authored test against base source should fail, which is the
 * observation, but a session-authored product file would make the base tree
 * the final tree.
 *
 * The index the copy came with decides nothing (C1, D57e): `reset --hard`
 * honoured its skip-worktree and assume-unchanged flags, so a session that
 * deleted or broke a base file and flagged it kept it deleted or broken on
 * the "base" tree — a case red there for the session's own doing. The base
 * commit is read into a FRESH index (`read-tree`, no flag survives), every
 * file of it written out (`checkout-index -a -f`), and HEAD moved to it,
 * through the sealed boundary. What the copy's old index tracked beyond the
 * base is untracked now and decided by the prune. */
function restoreTrackedToBase(copy: string, baseRef: string): { ok: true } | { ok: false; reason: string } {
  // I2 (D57g): the fresh index is the host's own, in a host-owned temporary
  // directory, for the whole restore — never the copy's.
  const indexDir = mkdtempSync(join(tmpdir(), "dokkabi-base-index-"));
  try {
    for (const args of [["read-tree", baseRef], ["checkout-index", "-a", "-f"], ["update-ref", "-m", "dokkabi: base tree", "HEAD", baseRef]]) {
      const run = spawnSealedHostGit(copy, args, { timeoutMs: 120_000, extraEnv: { GIT_INDEX_FILE: join(indexDir, "index") } });
      if ((run.exitCode ?? 1) !== 0) {
        const detail = `${run.stdout.toString()}${run.stderr.toString()}`.trim().slice(0, 200);
        return { ok: false, reason: `the copy could not be restored to base ${baseRef.slice(0, 12)}: ${detail}` };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `the copy's git metadata is not trusted: ${message(error).slice(0, 200)}` };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** One tracked test path the session changed against the base, as the copy
 * held it before the restore: `aside` is where its final content waits in
 * the holder, or undefined when the session deleted the path. */
interface SetAsideTest {
  readonly path: string;
  readonly aside: string | undefined;
}

/**
 * In the COPY only, BEFORE the restore: every TRACKED path that is a
 * conventional test path (the same predicate the prune uses) and that differs
 * between the base commit and the session's final state — modified, added and
 * tracked (staged or committed after base), or deleted — is listed, and the
 * final file is moved into the holder so the restore cannot overwrite it.
 *
 * Why (D42): in an existing repository a new test is usually added to an
 * EXISTING test file. `reset --hard` put that file back to base, the case ran
 * the old tests, was green on both trees, and red→green evidence was
 * impossible for the most ordinary change there is. D34 already kept
 * untracked tests for the same reason; a tracked test file the session
 * changed must stand on the base tree the same way. Product files are not
 * touched here: they stay at base.
 *
 * The listing is `git diff --name-only --no-renames -z <base>` in the copy —
 * the copy is still the live workspace's final state, and its git metadata is
 * its own, so nothing is written to the live workspace or its git. A path
 * the copy no longer holds is the session's deletion.
 */
function setAsideTrackedTests(
  copy: string,
  baseRef: string,
  holder: string,
  /** Base-tracked tests the session changed by content (C1): set aside even
   * when the copy's index hides the change. */
  hidden: readonly string[] = [],
): { ok: true; entries: SetAsideTest[] } | { ok: false; reason: string } {
  let listed: ReturnType<typeof spawnSealedHostGit>;
  try {
    // I2 (D57g): the copy as the HOST lists it, staged into an index of the
    // host's own, against the base — never the copy's index. Paths the base
    // tracks that the session modified, retyped or deleted.
    listed = withHostBuiltIndex(copy, (env) => spawnSealedHostGit(copy, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=MDT", "-z", baseRef], { timeoutMs: 120_000, extraEnv: env }), { writeObjects: false, timeoutMs: 120_000 });
  } catch (error) {
    return { ok: false, reason: `the copy's changed tracked files could not be listed: ${message(error).slice(0, 200)}` };
  }
  if ((listed.exitCode ?? 1) !== 0) {
    const detail = `${listed.stdout.toString()}${listed.stderr.toString()}`.trim().slice(0, 200);
    return { ok: false, reason: `the copy's changed tracked files could not be listed: ${detail}` };
  }
  // The copy is a tree a session wrote, and the holder the host's own: each
  // path is moved as the entry it is, never through a link (S1, D57c).
  let roots: { readonly copy: SafeRoot; readonly holder: SafeRoot };
  try {
    roots = { copy: safeRoot(copy, "the base copy"), holder: safeRoot(holder, "the set-aside directory", { create: 0o700 }) };
  } catch (error) {
    return { ok: false, reason: `the base copy could not be used: ${message(error).slice(0, 200)}` };
  }
  const entries: SetAsideTest[] = [];
  const paths = [...new Set([...listed.stdout.toString().split("\u0000"), ...hidden])];
  for (const path of paths) {
    if (path === "" || path === LEDGER_MIRROR_PATH || !isConventionalTestPath(path)) continue;
    const absolute = resolve(copy, path);
    if (!absolute.startsWith(copy + sep)) continue;
    let kind: "file" | "missing" | "other";
    try {
      const entry = lstatBeneath(roots.copy, Buffer.from(path), "set aside");
      kind = entry === undefined ? "missing" : entry.isFile() || entry.isSymbolicLink() ? "file" : "other";
    } catch (error) {
      // Reached only through a link or something that is not a directory:
      // not a test file of the copy.
      if (!(error instanceof LinkSafetyError) || error.code === "root") return { ok: false, reason: `a session test file could not be read in the copy: ${message(error).slice(0, 200)}` };
      kind = "other";
    }
    // A path that became a directory is not a test file the session wrote;
    // whatever lies under it is untracked and decided by the prune.
    if (kind === "other") continue;
    if (kind === "missing") {
      entries.push({ path, aside: undefined });
      continue;
    }
    const aside = String(entries.length);
    try {
      renameBeneath(roots.copy, Buffer.from(path), roots.holder, Buffer.from(aside), { operation: "set aside" });
    } catch (error) {
      return { ok: false, reason: `a session test file could not be set aside in the copy: ${message(error).slice(0, 200)}` };
    }
    entries.push({ path, aside: join(holder, aside) });
  }
  return { ok: true, entries };
}

/** In the COPY only, AFTER the restore and before the prune: each tracked
 * test path set aside takes the session's final state again — its final
 * content (mode and symlink kept, since the file is moved, not rewritten), or
 * its absence when the session deleted it. Returns how many paths that was. */
function keepTrackedTestsOnBase(
  copy: string,
  entries: readonly SetAsideTest[],
): { ok: true; count: number } | { ok: false; reason: string } {
  for (const entry of entries) {
    const rel = Buffer.from(entry.path);
    try {
      // Every step below the copy as a root the host pinned (S1): a link a
      // session put in a directory's place refuses the keep, never followed.
      const copyRoot = safeRoot(copy, "the base copy");
      if (entry.aside === undefined) {
        unlinkBeneath(copyRoot, rel, "keep");
        continue;
      }
      // The restore may have left a base file in the way (replaced) or
      // removed the directory an added test lived in (recreated).
      const parent = dirname(entry.path);
      if (parent !== "." && parent !== "") ensureDirBeneath(copyRoot, Buffer.from(parent), 0o755, "keep");
      const standing = lstatBeneath(copyRoot, rel, "keep");
      if (standing !== undefined && !standing.isDirectory()) unlinkBeneath(copyRoot, rel, "keep");
      renameBeneath(safeRoot(dirname(entry.aside), "the set-aside directory"), Buffer.from(entry.aside.slice(dirname(entry.aside).length + 1)), copyRoot, rel, { operation: "keep" });
    } catch (error) {
      return { ok: false, reason: `a session test file could not be kept on the base tree: ${message(error).slice(0, 200)}` };
    }
  }
  return { ok: true, count: entries.length };
}

/** The three counts one base pass's prune leaves on every row it writes
 * (D34): how many untracked paths the copy lost, and how many it kept because
 * they are conventional test paths or lie inside a project environment.
 * Counts only, never a path — the row says what happened to the tree without
 * carrying what the session wrote. */
export interface BasePruneCounts {
  readonly untracked_removed: number;
  readonly untracked_kept_tests: number;
  readonly untracked_kept_environment: number;
}

/** Everything one base pass says about its tree on every row it writes: the
 * prune's three counts plus how many tracked test paths the session changed
 * and the copy kept in their final state (D42) — counts only, never a path. */
export interface BaseTreeCounts extends BasePruneCounts {
  readonly tracked_kept_tests: number;
}

/**
 * In the COPY only, after the restore and the tracked keep: the base tree is
 * the base commit plus the session's tests plus what a case needs in order to
 * run — nothing the session authored as product.
 *
 * Restoring tracked files was not enough. Everything a session created
 * untracked survived into the "base" tree, so a greenfield session — an empty
 * repository where every product file is new — reverted nothing at all: the
 * base tree WAS the final tree, every case was green there, red→green
 * evidence was impossible, and the label could only ever say done_unverified
 * (real-work trial, 2026-09-21). The same hole is latent wherever a fix adds
 * a NEW product module.
 *
 * So every untracked, NON-IGNORED path is removed unless (a) it is a
 * conventional test path — the session's own test must stand on the base tree
 * and honestly fail there — or (b) it lies inside a project environment the
 * marker scan detects, which is the interpreter the case calls. Ignored paths
 * are untouched, exactly as `git clean -fd` without `-x` leaves them; an
 * environment is usually ignored anyway. Directories the removals empty go
 * with them.
 *
 * Nothing gates: a listing or a removal that fails is reported the way every
 * other base-pass failure is, as `not_runnable` with a reason.
 */
function pruneUntrackedOnBase(
  copy: string,
  baseRef: string,
  keptTracked: ReadonlySet<string>,
): { ok: true; counts: BasePruneCounts } | { ok: false; reason: string } {
  let listed: { stdout: Buffer };
  try {
    // I2 (D57g): what the copy holds that the base does not track, from the
    // host's own listing under the copy's rules as the host evaluates them —
    // never git's index or ignore machinery.
    const tracked = spawnSealedHostGit(copy, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", baseRef], { timeoutMs: 120_000 });
    if ((tracked.exitCode ?? 1) !== 0) {
      return { ok: false, reason: `the copy's untracked files could not be listed: ${tracked.stderr.toString().trim().slice(0, 200)}` };
    }
    const atBase = new Set(tracked.stdout.toString("latin1").split("\u0000"));
    const untracked = hostWorkTreeListing(copy).map((entry) => entry.path).filter((path) => !atBase.has(path.toString("latin1")));
    listed = { stdout: Buffer.concat(untracked.flatMap((path) => [path, Buffer.alloc(1)])) };
  } catch (error) {
    return { ok: false, reason: `the copy's untracked files could not be listed: ${message(error).slice(0, 200)}` };
  }
  const environmentDirs = projectEnvironmentDirs(copy);
  const emptied = new Set<string>();
  let removed = 0;
  let keptTests = 0;
  let keptEnvironment = 0;
  for (const path of listed.stdout.toString().split("\u0000")) {
    if (path === "") continue;
    // The host's own mirror of the ledger is not the session's work: it is
    // left where it is and counted in nothing, so the counts on the row are
    // the session's own files and only those.
    if (path === LEDGER_MIRROR_PATH) continue;
    // A test the session added to the index or committed after base is
    // untracked again once the restore resets the index; it was put back as
    // a tracked kept test and is counted there, not twice.
    if (keptTracked.has(path)) continue;
    // The environment is asked about first: a file under a venv or a
    // node_modules is the interpreter's, whatever its name looks like.
    if (environmentDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))) {
      keptEnvironment += 1;
      continue;
    }
    if (isConventionalTestPath(path)) {
      keptTests += 1;
      continue;
    }
    const absolute = resolve(copy, path);
    // git lists repository-relative paths; anything that resolves outside the
    // copy is not the copy's to touch, and is left where it is.
    if (!absolute.startsWith(copy + sep)) continue;
    try {
      // Removed as the entry it is, below the copy as a root the host pinned
      // (S1): never through a link a session put in a directory's place.
      unlinkBeneath(safeRoot(copy, "the base copy"), Buffer.from(path), "prune");
    } catch (error) {
      return { ok: false, reason: `a session-authored file could not be removed from the copy: ${message(error).slice(0, 200)}` };
    }
    removed += 1;
    for (let dir = dirname(path); dir !== "." && dir !== sep && dir !== ""; dir = dirname(dir)) emptied.add(dir);
  }
  // Deepest first, and rmdir only ever removes an EMPTY real directory: a
  // kept test file or environment keeps every directory above it.
  for (const dir of [...emptied].sort((left, right) => right.length - left.length)) {
    try {
      rmdirBeneath(safeRoot(copy, "the base copy"), Buffer.from(dir), "prune");
    } catch {
      // Not empty, already gone, or a link: the entry stays, which is correct.
    }
  }
  return { ok: true, counts: {
    untracked_removed: removed,
    untracked_kept_tests: keptTests,
    untracked_kept_environment: keptEnvironment,
  } };
}

/** The words a copy pass's `not_runnable` reasons use for its tree and its
 * run: the base pass's are "the base tree" / "the base run". */
export interface CopyRunWords {
  readonly tree: string;
  readonly run: string;
}

const BASE_WORDS: CopyRunWords = { tree: "the base tree", run: "the base run" };

/** What one case run on a throwaway copy observed: either it never started
 * (`started: false`, a reason) or the full observation the row carries. */
export type CopyCaseRun =
  | { readonly started: false; readonly translated_paths: number; readonly reason: string }
  | {
    readonly started: true;
    readonly translated_paths: number;
    readonly status: "green" | "red" | "not_runnable";
    readonly image: string;
    readonly changed: boolean;
    readonly evidence: "native_result" | "exit_code" | "expectations" | "property";
    readonly exit_code?: number;
    readonly duration_ms: number;
    readonly receipt?: string;
    readonly reason?: string;
    /** A `check` case's expectation results (D48). */
    readonly evaluation?: CheckEvaluation;
    /** A `property` case's run (D58). */
    readonly property?: PropertyObservation;
  };

/**
 * One recorded case command on a throwaway copy: the same runner path and
 * pipefail semantics the final observation uses, the same receipt pair, the
 * declared case budget tightened to the outer wall, and every spelling in
 * `liveRoots` mapped to the copy root first. It appends only the execution
 * and receipt rows; the caller writes the observation row. Shared by the base
 * pass and the verify-rounds recheck (D45), so the two cannot drift.
 */
export function runCaseOnCopy(input: {
  log: EventLog;
  /** The absolute roots the recorded command and dir may spell, mapped to
   * the copy root (longest first, so no root rewrites inside another). */
  liveRoots: readonly string[];
  copyRoot: string;
  policy: SandboxPolicy;
  cache: DigestCache;
  /** The recorded case. One that carries `check` fields (D48) is run and
   * judged through the shared check evaluator, with its fixtures written into
   * the scratch the policy binds. */
  item: {
    readonly id?: string;
    readonly command?: unknown;
    readonly dir?: string;
    readonly timeout_ms?: number;
    readonly stdin?: LedgerCase["stdin"];
    readonly files?: LedgerCase["files"];
    readonly expect?: LedgerCase["expect"];
    readonly property?: LedgerCase["property"];
  };
  callId: string;
  deadlineMs?: number;
  words?: CopyRunWords;
  /** A `property` case's recorded counterexamples, replayed first (D58),
   * and how many lie past the replay cap (D58b V1); the base pass reads them
   * off its log. */
  replay?: PropertyReplay;
  /** Called once the run is prepared — a check's fixtures and stdin
   * materialised from its record — and right before its command starts, and
   * only when it starts (D57: the recheck snapshots the execution's inputs
   * here). Not called for a case that is not started. */
  beforeRun?: (prepared: { readonly stdinPath?: string }) => void;
}): CopyCaseRun {
  const { log, item } = input;
  const words = input.words ?? BASE_WORDS;
  const recorded = typeof item.command === "string" ? item.command : "";
  const command = recorded.trim();
  const roots = [...new Set(input.liveRoots)].sort((left, right) => right.length - left.length);
  const translate = (text: string): { text: string; count: number } => {
    let count = 0;
    let translated = text;
    for (const root of roots) {
      const step = translateLiveRoots(translated, root, input.copyRoot);
      translated = step.text;
      count += step.count;
    }
    return { text: translated, count };
  };
  const translatedCommand = translate(command);
  const translatedDir = item.dir === undefined ? undefined : translate(item.dir);
  const translatedPaths = translatedCommand.count + (translatedDir?.count ?? 0);
  if (command === "") return { started: false, translated_paths: translatedPaths, reason: "case command is empty" };
  // The same wall discipline the final pass keeps: the declared case budget,
  // tightened to whatever is left before the outer wall, never a hang.
  const declaredMs = caseTimeoutSeconds(item) * 1_000;
  const remainingMs = input.deadlineMs === undefined ? undefined : input.deadlineMs - Date.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    return { started: false, translated_paths: translatedPaths, reason: `the run's outer wall left no time to run this case on ${words.tree}` };
  }
  const wallBound = remainingMs !== undefined && remainingMs < declaredMs;
  const timeoutMs = wallBound ? Math.max(1, Math.floor(remainingMs)) : declaredMs;
  // A property case (D58): the property evaluator, every execution on a
  // fresh copy of this copy of its own (E1''); one receipt for the run.
  if (isPropertyCase(item)) {
    return runPropertyOnCopy({ ...input, item: { ...item, id: item.id ?? "", command }, translatedPaths });
  }
  const check = isCheckCase(item);
  const runner = check ? undefined : matchingCaseRunner(command);
  const adapter = runner?.resultAdapter;
  const startedAt = Date.now();
  const imageBefore = workspaceDigest(input.copyRoot, input.cache);
  const unknownBefore = input.cache.lastUnknown;
  // The executed shell runs the SAME command in the copy: any live-root
  // spelling in the dir or command was mapped to the copy root above, and the
  // dir is entered as path data (case-launch.ts). The recorded bytes
  // (command, receipt) stay the model's.
  const launchedDir = translatedDir?.text ?? item.dir;
  const launched = caseLaunch(launchedDir, translatedCommand.text);
  const prepared = check
    ? prepareCheckRun({ item: { ...item, id: item.id ?? "", command }, policy: input.policy, launched, treeRoot: input.copyRoot })
    : undefined;
  if (prepared !== undefined && !prepared.ok) return { started: false, translated_paths: translatedPaths, reason: prepared.reason };
  // Recorded bytes unchanged; only the executed shell honors pipefail, so a
  // piped runner contributes its own exit code here exactly as at the final
  // pass — replay of a recorded session is unaffected.
  const executed = `set -o pipefail; ${prepared?.ok ? prepared.run.wrapped : adapter ? adapter.command(launched) : launched}`;
  const seqBefore = log.lastSeq;
  let outcome: ToolOutcome;
  try {
    input.beforeRun?.(prepared?.ok && prepared.run.stdinPath !== undefined ? { stdinPath: prepared.run.stdinPath } : {});
    outcome = executeTool({
      log,
      policy: input.policy,
      mode: "live",
      call: { id: input.callId, name: "bash", args: { command: executed } },
      timeoutMs,
    });
  } catch (error) {
    if (prepared?.ok) discardCheckRun(prepared.run);
    throw error;
  }
  const evaluation = prepared?.ok
    ? completeCheckRun({ run: prepared.run, exitCode: outcome.exitCode, treeRoot: input.copyRoot })
    : undefined;
  const imageAfter = workspaceDigest(input.copyRoot, input.cache);
  let receipt: string | undefined;
  if (outcome.exitCode !== undefined) {
    const execRow = log.events.filter((event) => event.name === "sandbox/exec" && event.seq > seqBefore).at(-1);
    receipt = mintReceipt({
      log,
      image_before: imageBefore,
      image_after: imageAfter,
      command: recorded,
      exit_code: outcome.exitCode,
      stdout: outcome.text,
      stderr: "",
      duration_ms: Date.now() - startedAt,
      isolation: "live-workspace",
      digest_kind: "workspace-tree",
      exec_ref: execRow ? { seq: execRow.seq, hash: execRow.hash } : null,
      names: { result: "verify/result", receipt: "verify/receipt" },
      unknown: { before: unknownBefore, after: input.cache.lastUnknown },
    }).id;
  }
  const native = adapter ? runnerOutcomeWithoutRows(log, adapter, outcome) : undefined;
  const unrunnable = outcome.exitCode === undefined
    ? `the case process did not complete on ${words.tree}`
    : outcome.execution?.timed_out === true
      ? wallBound
        ? `${words.run} was cut off by the run's outer wall`
        : `${words.run} reached its declared backstop`
      : outcome.execution?.completion_unavailable === true
        ? `${words.run} reported no completion`
        : processTreeSurvived(outcome)
          ?? evaluation?.unjudged;
  const green = unrunnable === undefined
    && (evaluation !== undefined ? evaluation.green : adapter ? native?.green === true : outcome.exitCode === 0);
  const status = unrunnable !== undefined ? "not_runnable" : green ? "green" : "red";
  const reason = unrunnable ?? (!green && native?.reason ? native.reason : undefined);
  return {
    started: true,
    translated_paths: translatedPaths,
    status,
    image: imageBefore,
    changed: imageBefore !== imageAfter,
    evidence: evaluation !== undefined ? "expectations" : adapter ? "native_result" : "exit_code",
    ...(outcome.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}),
    duration_ms: Date.now() - startedAt,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(evaluation !== undefined ? { evaluation } : {}),
  };
}

/** One property case on a copy (D58): the copy is never run in — every
 * execution runs on a fresh copy of it of its own — and one receipt binds the
 * command, the verdict and the last execution. */
function runPropertyOnCopy(input: {
  log: EventLog;
  liveRoots: readonly string[];
  copyRoot: string;
  policy: SandboxPolicy;
  cache: DigestCache;
  item: LedgerCase;
  callId: string;
  deadlineMs?: number;
  replay?: PropertyReplay;
  translatedPaths: number;
}): CopyCaseRun {
  const { log, item } = input;
  const startedAt = Date.now();
  const imageBefore = workspaceDigest(input.copyRoot, input.cache);
  const unknownBefore = input.cache.lastUnknown;
  const seqBefore = log.lastSeq;
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-property-copy-"));
  let observation: PropertyObservation;
  try {
    observation = runProperty({
      item,
      policy: input.policy,
      treeRoot: input.copyRoot,
      replay: input.replay ?? { refs: [], overflow: 0 },
      sampleSeed: freshSampleSeed(),
      store: sessionPropertyStore(log),
      keepCounterexamples: false,
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      callPrefix: input.callId,
      executor: (scratch) => clonePropertyExecutor({
        log, source: input.copyRoot, liveRoots: input.liveRoots, item, scratch, holder,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      }),
    });
  } finally {
    removeWorkspaceCopy(holder);
  }
  const imageAfter = workspaceDigest(input.copyRoot, input.cache);
  const receipt = mintPropertyReceipt({
    log, command: item.command, observation, imageBefore, imageAfter, seqBefore, startedAt,
    unknown: { before: unknownBefore, after: input.cache.lastUnknown },
  });
  return {
    started: true,
    translated_paths: Math.max(input.translatedPaths, observation.translated_paths),
    // The verdict of the observation's own fields (D58b V2).
    status: propertyVerdict(observation),
    image: imageBefore,
    changed: imageBefore !== imageAfter,
    evidence: "property",
    ...(observation.exit_code !== undefined ? { exit_code: observation.exit_code } : {}),
    duration_ms: Date.now() - startedAt,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    property: observation,
  };
}

/** One non-guard case on the copy (runCaseOnCopy), recorded as
 * `ledger/case_base` — never a verdict on the work. */
function observeOneBaseCase(input: {
  log: EventLog;
  liveRoot: string;
  copyRoot: string;
  policy: SandboxPolicy;
  cache: DigestCache;
  item: LedgerCase;
  baseRef: string;
  copyDigest: string;
  /** What the tracked keep and the prune did to this copy, repeated on every
   * row of the pass. */
  counts: BaseTreeCounts;
  deadlineMs?: number;
}): void {
  const { log, item } = input;
  const run = runCaseOnCopy({
    log,
    liveRoots: [input.liveRoot],
    copyRoot: input.copyRoot,
    policy: input.policy,
    cache: input.cache,
    item,
    callId: `ledger-base-case-${sha256(item.id).slice(0, 16)}`,
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(isPropertyCase(item) ? { replay: recordedPropertyReplay(log.events, item.id) } : {}),
  });
  const commonFields = {
    case: item.id,
    planner: LEDGER_PLANNER,
    command: item.command,
    base_ref: input.baseRef,
    copy_digest: input.copyDigest,
    translated_paths: run.translated_paths,
    ...input.counts,
  };
  if (!run.started) {
    log.append({ kind: "observe", name: "ledger/case_base", payload: { ...commonFields, status: "not_runnable", reason: run.reason } });
    return;
  }
  log.append({ kind: "observe", name: "ledger/case_base", payload: {
    ...commonFields,
    status: run.status,
    image: run.image,
    changed: run.changed,
    evidence: run.evidence,
    ...(run.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
    duration_ms: run.duration_ms,
    ...(run.receipt !== undefined ? { receipt: run.receipt } : {}),
    ...(run.reason !== undefined ? { reason: run.reason } : {}),
    ...(run.evaluation !== undefined ? expectationRowFields(run.evaluation) : {}),
    ...(run.property !== undefined ? propertyRowFields(run.property) : {}),
  } });
}
