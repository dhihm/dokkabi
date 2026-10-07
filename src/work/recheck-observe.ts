import { writableWorldOf } from "../host/writable-world.ts";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adoptCopyDigests, createDigestCache, workspaceDigest, workspaceListing, type DigestCache, type TreeListing } from "../host/execution-receipt.ts";
import { BaseChanges, loadBaseRecord, type BaseRecord } from "../host/base-record.ts";
import { type CoverageBase } from "../host/coverage.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxPolicy } from "../host/sandbox.ts";
import { expectationRowFields } from "./ledger-check.ts";
import { caseCommandTargets, runCaseOnCopy, type CopyRunWords } from "./ledger-base.ts";
import { clonePropertyExecutor, freshSampleSeed, mintPropertyReceipt, propertyVerdict, runProperty } from "./ledger-property.ts";
import type { LedgerCase } from "./plan-ledger.ts";
import { readBeneath, safeRoot } from "./link-safe-fs.ts";
import { recheckCallId, recheckPropertyReplay, withCommandStart, type RecheckCase, type RecheckObservation, type RecheckRequest } from "./recheck.ts";
import { RecheckInputStore, snapshotRecheckInputs, type RecheckInputsRecord } from "./recheck-inputs.ts";
import { bytesKey } from "./path-bytes.ts";
import { SCRATCH_MANIFEST_DIR, writeScratchManifest, type ScratchManifestRecord } from "./session-scratch.ts";
import { overlayVerifierFileList, type KeptFile } from "./verifier-files.ts";
import {
  cloneWorkspaceCopy,
  detachLinkedGit,
  makeWorkspaceCopy,
  removeWorkspaceCopy,
  removeWorkspaceCopyLater,
  type PristineCopy,
} from "./workspace-copy.ts";

/**
 * RECHECK (D45), the observation: every requested case run on a throwaway
 * `cp -a` copy of the developer's workspace as the fix left it, through the
 * base pass's own runner path (runCaseOnCopy: the same sandbox policy,
 * timeouts, pipefail, native adapters and receipt pair), and for each kept
 * case the D26 target observation against the fix session's base.
 *
 * The live workspace and its git are never written: before any case runs a
 * `.git` that is a link into another repository is removed from the copy, so
 * a case command that runs git cannot reach the developer's repository. The
 * copies are removed afterwards. Never throws: a copy that cannot be made
 * observes every case as `not_runnable` with the reason.
 *
 * THE FIX SESSION'S BASE DECIDES (D57e, C1): every image of the recheck
 * covers what the fix session's base record decides (its captured ignore
 * rules, the paths tracked at its start, the fixed host exclusions) — never
 * the copy's own git, whose index, flags, rules and configuration the fix
 * wrote — and the kept cases' target observation reads which files the fix
 * changed from the host's content diff of that record and the pristine
 * copy's listing (BaseChanges), never `git diff`. A fix without a base
 * record the host can load (B1, D57f: none named, deleted, altered,
 * relocated) is observed as nothing: every case `not_runnable` with the
 * reason, every kept case `tamper_unknown` — open, never counted as
 * untouched. A target whose line counts are unknown counts as tampered (U1).
 *
 * RECHECK-FILES (D47): a verifier's reported cases run with that verifier's
 * kept files overlaid (verifier-files.ts), and a red run whose command could
 * not start (126/127) is observed as `not_runnable`.
 *
 * INPUTS BEFORE THE RUN (D57, E1): right before each case's command starts —
 * its fixtures and stdin materialised from its record — the observer
 * snapshots what that execution runs with besides the product: the scratch
 * its policy binds, the verifier files overlaid onto its copy as they stand
 * then, the materialised stdin (recheck-inputs.ts), into the content-addressed
 * store beside the run's own rounds log, and names the snapshot on the
 * observation (`inputs`). That snapshot, never anything taken after the run,
 * is what a dispute of the case is ruled on.
 *
 * ONE SURFACE, ONE PATH (D57b, E1'): this is the one place a recheck
 * execution is launched (observeRecheck → observeOne → runCaseOnCopy →
 * executeTool), reported and kept cases, check and plain cases alike, and
 * every execution gets its own sandbox policy, made right before it and
 * disposed right after it. The snapshot's surface is read off that policy —
 * the scratch it binds (whole: recheck-inputs.ts), its fence — beside the
 * files overlaid onto the copy and the stdin its run is given, so what the
 * sandbox lets the execution read of what the host bound is what the
 * snapshot holds. A policy of its own also gives each execution a fresh
 * sandbox home and temporary directory (Seatbelt keeps them per policy;
 * bwrap makes them per process).
 *
 * EACH EXECUTION ITS OWN PRISTINE COPY (D57c, E1''): the product copy is no
 * longer shared by the cases of one copy. The developer's tree is copied ONCE
 * into a PRISTINE copy — never bound into a sandbox, never run in — and every
 * execution runs on a fresh copy of it (cloneWorkspaceCopy: a copy-on-write
 * clone where the file system has one, so a write by one execution is
 * private to its copy; never hard links), with only its own verifier's files
 * overlaid, and that copy is removed once the execution is over (while the
 * next one runs). So what an execution reads of the product is the delivered
 * product, and what it reads besides is its own snapshotted inputs: nothing
 * an earlier execution wrote into its copy is readable to a later one, and
 * the snapshot of each execution remains its evidence. Each copy lies at a
 * path of its own: a process an earlier execution left running (Seatbelt
 * confines by path, not by process lifetime) can write only the copy that
 * execution was given. The scratch a check binds is the recording session's
 * own and is not copied: what an earlier execution left there is in the
 * later execution's snapshot (E1'), so it is evidence, not a hidden input.
 *
 * S1 (D57c): the copies are trees a session writes; the host's own
 * operations in them — the overlay, the `.git` detach, the snapshot, the
 * checks of what arrived — are relative to the copy as a root the host pinned
 * (link-safe-fs.ts), never through a link a session placed.
 *
 * THE RECEIPT'S IMAGES ARE READ FROM CONTENT (D57d, I1): the pristine copy is
 * digested once, every file read (workspaceListing), before any execution;
 * each execution's clone then gets a digest cache of its own, adopting the
 * pristine's content digests for the files the host's lstat finds as cloned,
 * keyed by their inode state, change time included, once the file system's
 * clock has moved past every change time recorded (adoptCopyDigests: the
 * ctime fence). The image before the run costs an lstat per file; after it,
 * any file whose inode state moved — a same-size rewrite that put its mtime
 * back included — is read again. git's stat compare decides nothing.
 *
 * A PROPERTY (D58) is observed by the property evaluator, each of its
 * executions exactly as one check execution above: a fresh copy of the
 * pristine tree of its own, its verifier's files overlaid, a policy of its
 * own, its inputs snapshotted right before it starts; the recorded
 * counterexamples first (its recording session's, then every earlier
 * recheck's of the identity), then a fresh sample; each counterexample's
 * generated input snapshotted into the run's own store as its case ended.
 * The row's `inputs` is the first failing execution's snapshot (else the
 * first execution's), and one receipt binds the command and the verdict.
 *
 * SCRATCH MANIFEST (D56): once a case whose source session has a scratch
 * has run, the scratch as the run left it is recorded — a bounded manifest
 * (session-scratch.ts) written beside the run's own rounds log, under
 * `scratch-manifests/`, and named on the observation (`scratch`). Since D57 it
 * is output data only. A case whose run bound that scratch may have changed
 * it, so its manifest is taken afresh; any other case of the same scratch
 * reuses the last one taken.
 */

const RECHECK_WORDS: CopyRunWords = { tree: "the recheck copy", run: "the recheck run" };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What every execution of one observation starts from: the pristine copy of
 * the developer's tree, the fix's changed files against its base (for the
 * kept cases' target observation), where each execution's copy is made, and
 * the pristine's content as the host read it (D57d; absent when it could not
 * be read — each execution's digest then reads its copy whole). */
interface Pristine extends PristineCopy {
  readonly holder: string;
  /** What every image of this recheck covers: the fix session's base. */
  readonly coverage: CoverageBase;
  readonly changed?: BaseChanges;
  /** Why the kept cases' target observation could not be made (U1): each
   * kept case is then tampered-unknown. */
  readonly changedUnknown?: string;
  readonly listing?: TreeListing;
  /** The pristine's own digest cache (D57d): the pristine is never run in, so
   * its image, which a property's receipt binds, costs an lstat per file. */
  readonly digestCache: DigestCache;
  /** The copies still being removed. */
  readonly removals: Promise<void>[];
}

/** The real observation behind the runner's `recheck` seam. Every case runs
 * on a copy of its own (E1''); a reported case's copy has its verifier's kept
 * files overlaid (D47), every other case's has none, so what the build and a
 * fix recorded never sees a verifier's files. The cases run grouped by their
 * verifier, in the order the groups first appear, as they always have. */
export async function observeRecheck(
  request: RecheckRequest,
  context: { readonly workspaceRoot: string },
): Promise<readonly RecheckObservation[]> {
  const { cases } = request;
  if (cases.length === 0) return [];
  // Nothing observed: every kept case's targets are unknown too (U1) — it
  // stays open, never counted as untouched.
  const all = (reason: string): RecheckObservation[] => cases.map((item) => ({
    status: "not_runnable" as const,
    reason,
    ...(item.kind === "reported" ? { verifier_files: 0 } : { tamper_unknown: reason }),
  }));
  const remainingMs = request.deadlineMs - Date.now();
  if (remainingMs <= 0) return all("the run's outer wall left no time to recheck");
  const groups = new Map<string, number[]>();
  cases.forEach((item, index) => {
    const key = item.filesDir ?? "";
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const observations: RecheckObservation[] = new Array(cases.length);
  const scratch = scratchRecorder(join(dirname(request.log.path), SCRATCH_MANIFEST_DIR));
  const store = RecheckInputStore.beside(request.log.path);
  // The fix session's base record decides what every image of this recheck
  // covers and is the base of the kept cases' target observation (C1): one
  // that cannot be loaded makes every observation unknown (B1) — not
  // runnable, with the reason, and every kept case tampered-unknown, never
  // counted as untouched.
  let fixRecord: BaseRecord;
  try {
    if (request.fixBase === undefined) throw new Error("the fix session's log names no base record");
    fixRecord = loadBaseRecord(request.fixBase.dir, request.fixBase.digest);
  } catch (error) {
    const reason = `the fix session's base record cannot be loaded: ${message(error).slice(0, 200)}`;
    return cases.map((item) => ({
      status: "not_runnable" as const,
      reason,
      ...(item.kind === "reported" ? { verifier_files: 0 } : { tamper_unknown: reason }),
    }));
  }
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-recheck-"));
  const removals: Promise<void>[] = [];
  try {
    let pristine: Pristine;
    try {
      pristine = makePristine(request, fixRecord, context, holder, removals);
    } catch (error) {
      return all(`the recheck copy could not be observed: ${message(error).slice(0, 200)}`);
    }
    for (const [filesDir, indices] of groups) {
      for (const index of indices) {
        observations[index] = observeOne(request, cases[index]!, context, filesDir === "" ? undefined : filesDir, scratch, store, pristine);
      }
    }
    return observations;
  } finally {
    await Promise.all(removals);
    removeWorkspaceCopy(holder);
  }
}

/** The pristine copy (E1''): the developer's tree copied once, the fix's
 * changed files read in it, a linked `.git` detached, then its content read
 * once (D57d). Never run in. */
function makePristine(
  request: RecheckRequest,
  record: BaseRecord,
  context: { readonly workspaceRoot: string },
  holder: string,
  removals: Promise<void>[],
): Pristine {
  const place = join(holder, "pristine");
  const copy = makeWorkspaceCopy(context.workspaceRoot, mkdtempSync(`${place}-`), request.deadlineMs - Date.now());
  detachLinkedGit(copy);
  const coverage = record.coverage;
  // The clock of the copies' file system, probed in the holder: the host's
  // own directory, on the copies' device by construction (F3).
  const digestCache = createDigestCache(coverage, { clockDirs: [holder] });
  let listing: TreeListing | undefined;
  let listingError: string | undefined;
  try {
    listing = workspaceListing(copy, digestCache);
  } catch (error) {
    listing = undefined;
    listingError = `the fixed tree could not be read: ${message(error).slice(0, 200)}`;
  }
  // The blobs of the fix's base, when the kept cases' targets need them, from
  // the copy's object store or the developer's (read through the sealed
  // boundary; each held to the base's own digest).
  const changed = listing === undefined || !request.cases.some((item) => item.kind === "kept")
    ? undefined
    : new BaseChanges(record, listing, copy, [copy, context.workspaceRoot]);
  return {
    copy, holder, coverage,
    ...(changed === undefined ? {} : { changed }),
    ...(listingError === undefined ? {} : { changedUnknown: listingError }),
    ...(listing === undefined ? {} : { listing }),
    digestCache,
    removals,
  };
}

/** The manifest of a case's source scratch once the case has run (D56):
 * taken afresh after a case whose run bound that scratch, reused for any
 * other case of it; none for a case whose source session has no scratch.
 * Output data (D57): what the run left, never evidence. */
function scratchRecorder(dir: string): (item: RecheckCase) => { readonly scratch?: ScratchManifestRecord } {
  const taken = new Map<string, ScratchManifestRecord>();
  return (item) => {
    const root = item.sourceScratch ?? item.scratch;
    if (root === undefined) return {};
    let record = item.scratch === undefined ? taken.get(root) : undefined;
    if (record === undefined) {
      record = writeScratchManifest(root, dir);
      taken.set(root, record);
    }
    return { scratch: record };
  };
}

/** What one execution's policy grants of the snapshot's surface (D57b,
 * E1'): its fence — the sandbox backend, `none` with the fence off — and the
 * scratch it binds. Read off the policy the execution runs under, so the
 * snapshot covers what that sandbox binds, never a separate account of it. */
function executionSurface(policy: SandboxPolicy): { readonly fence: string; readonly scratch?: string } {
  return {
    fence: policy.disabled === true ? "none" : policy.backend,
    ...(policy.scratchRoot === undefined ? {} : { scratch: policy.scratchRoot }),
  };
}

/** How many files a keep recorded (D55: by exact path, with its digest) are
 * not in the copy as kept once the overlay is done: not overlaid, gone, or
 * not matching the digest the keep recorded. Read below the pinned copy (S1). */
function keptButNotOverlaid(kept: readonly KeptFile[], overlaid: readonly Buffer[], copy: string): number {
  if (kept.length === 0) return 0;
  const arrived = new Set(overlaid.map(bytesKey));
  let root;
  try {
    root = safeRoot(copy, "the recheck copy");
  } catch {
    return kept.length;
  }
  let missing = 0;
  for (const file of kept) {
    if (!arrived.has(bytesKey(file.path))) {
      missing += 1;
      continue;
    }
    try {
      const bytes = readBeneath(root, file.path, "check");
      if (bytes === undefined || bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) missing += 1;
    } catch {
      missing += 1;
    }
  }
  return missing;
}

/** One execution (E1''): a fresh copy of the pristine tree, its content
 * adopted from the pristine's behind the ctime fence (D57d), its verifier's
 * kept files overlaid when `filesDir` is given, its inputs snapshotted right
 * before it starts, run under a policy of its own; the copy is removed once
 * it is over. */
function observeOne(
  request: RecheckRequest,
  item: RecheckCase,
  context: { readonly workspaceRoot: string },
  filesDir: string | undefined,
  scratchAfter: (item: RecheckCase) => { readonly scratch?: ScratchManifestRecord },
  store: RecheckInputStore,
  pristine: Pristine,
): RecheckObservation {
  const { log } = request;
  const remainingMs = request.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    const reason = "the run's outer wall left no time to recheck";
    return { status: "not_runnable", reason, ...(item.kind === "reported" ? { verifier_files: 0 } : { tamper_unknown: reason }) };
  }
  if (item.property !== undefined) return observeProperty(request, item, context, filesDir, scratchAfter, store, pristine);
  // U1: a target whose counts are unknown is counted as tampered; no
  // observation of the targets at all makes the kept case tampered-unknown.
  const tampered = item.kind !== "kept" || pristine.changed === undefined
    ? undefined
    : caseCommandTargets(context.workspaceRoot, item, pristine.changed)
      .filter((target) => target.test && (target.removed > 0 || target.unknown === true)).length;
  const tamperUnknown = item.kind === "kept" && pristine.changed === undefined
    ? pristine.changedUnknown ?? "the kept case's targets could not be observed"
    : undefined;
  const place = mkdtempSync(join(pristine.holder, "run-"));
  let overlaid: Buffer[] = [];
  const withTargets = () => ({
    ...(tampered === undefined ? {} : { tampered_targets: tampered }),
    ...(tamperUnknown === undefined ? {} : { tamper_unknown: tamperUnknown }),
    ...(item.kind === "reported" ? { verifier_files: overlaid.length } : {}),
  });
  // What this execution runs with besides the product, taken right before it
  // starts (D57, E1'): the surface its own policy grants.
  let inputs: RecheckInputsRecord | undefined;
  const withInputs = () => (inputs === undefined ? {} : { inputs });
  let policy: SandboxPolicy | undefined;
  try {
    const { copy } = cloneWorkspaceCopy(pristine, place, remainingMs);
    // This copy's own record (D57d): what the host cloned holds the
    // pristine's bytes, recorded by each file's inode state before anything
    // else can write the copy — the overlay below included.
    const cache = createDigestCache(pristine.coverage, { clockDirs: [pristine.holder] });
    if (pristine.listing !== undefined) adoptCopyDigests(cache, pristine.listing, copy);
    // The verifier's own files, in THIS copy only (D47), by their exact
    // paths; and how many of the files its keep recorded did not arrive
    // there as kept (D57: an input the failing run should have had and did
    // not).
    overlaid = filesDir === undefined ? [] : overlayVerifierFileList(filesDir, copy);
    const notOverlaid = keptButNotOverlaid(item.filesKept?.files ?? [], overlaid, copy);
    // A policy of this execution's own (D57b): a check case's binds the
    // scratch of the session that recorded it (D48), every other case's
    // none; its sandbox home and temporary directory are fresh.
    const own = createPolicy({ mode: "workspace-write", workspaceRoot: copy, log, toolCache: "judged", ...(item.scratch !== undefined ? { scratchRoot: item.scratch } : {}) });
    policy = own;
    // What this execution can write (W, D57g): its copy, its own home and
    // temporary directory, the scratch it binds.
    cache.world = writableWorldOf(copy, [own]);
    const beforeRun = (prepared: { readonly stdinPath?: string }) => {
      inputs = snapshotRecheckInputs(store, {
        ...executionSurface(own),
        ...(item.kind === "reported" ? {
          copy,
          overlaid,
          keep: {
            kept: item.filesKept !== undefined,
            skipped: item.filesSkipped ?? 0,
            ...(item.filesKept?.reason === undefined ? {} : { reason: item.filesKept.reason }),
            ...(notOverlaid === 0 ? {} : { notOverlaid }),
          },
        } : {}),
        ...(prepared.stdinPath === undefined ? {} : { stdin: prepared.stdinPath }),
      });
    };
    const run = runCaseOnCopy({
      log,
      liveRoots: item.fromRoots,
      copyRoot: copy,
      policy: own,
      cache,
      item,
      callId: recheckCallId(request.round, item.kind, item.source, item.id),
      deadlineMs: request.deadlineMs,
      words: RECHECK_WORDS,
      beforeRun,
    });
    return run.started
      ? withCommandStart({
        status: run.status,
        ...(run.exit_code === undefined ? {} : { exit_code: run.exit_code }),
        ...(run.receipt === undefined ? {} : { receipt: run.receipt }),
        ...(run.reason === undefined ? {} : { reason: run.reason }),
        translated_paths: run.translated_paths,
        ...(run.evaluation === undefined ? {} : expectationRowFields(run.evaluation)),
        ...withTargets(),
        ...scratchAfter(item),
        ...withInputs(),
      })
      : { status: "not_runnable", reason: run.reason, translated_paths: run.translated_paths, ...withTargets(), ...scratchAfter(item) };
  } catch (error) {
    return { status: "not_runnable", reason: `the recheck run failed: ${message(error).slice(0, 200)}`, ...withTargets(), ...scratchAfter(item), ...withInputs() };
  } finally {
    if (policy !== undefined) disposeSandboxPolicy(policy);
    // Removed while the next execution runs; awaited before the observation
    // returns.
    pristine.removals.push(removeWorkspaceCopyLater(place));
  }
}

/** A property case's recheck (D58): the property evaluator over executions
 * each made as one check execution is — a fresh copy of the pristine tree,
 * the verifier's kept files overlaid, a policy of its own binding the
 * recording session's scratch, the inputs snapshotted right before the
 * command starts (E1, E1', E1''). The fixtures, the capture directory and
 * the per-case directories are prepared under a policy of the observation's
 * own whose workspace is an empty directory: what it may write is the
 * scratch, nothing of any tree. */
function observeProperty(
  request: RecheckRequest,
  item: RecheckCase,
  context: { readonly workspaceRoot: string },
  filesDir: string | undefined,
  scratchAfter: (item: RecheckCase) => { readonly scratch?: ScratchManifestRecord },
  store: RecheckInputStore,
  pristine: Pristine,
): RecheckObservation {
  const { log } = request;
  // U1 (D57f), as for a check: a target whose counts are unknown is counted
  // as tampered; no observation of the targets at all makes the kept case
  // tampered-unknown.
  const tampered = item.kind !== "kept" || pristine.changed === undefined
    ? undefined
    : caseCommandTargets(context.workspaceRoot, item, pristine.changed)
      .filter((target) => target.test && (target.removed > 0 || target.unknown === true)).length;
  const tamperUnknown = item.kind === "kept" && pristine.changed === undefined
    ? pristine.changedUnknown ?? "the kept case's targets could not be observed"
    : undefined;
  let overlaidCount = 0;
  const withTargets = () => ({
    ...(tampered === undefined ? {} : { tampered_targets: tampered }),
    ...(tamperUnknown === undefined ? {} : { tamper_unknown: tamperUnknown }),
    ...(item.kind === "reported" ? { verifier_files: overlaidCount } : {}),
  });
  const recorded: LedgerCase = {
    id: item.id,
    command: item.command,
    ...(item.dir === undefined ? {} : { dir: item.dir }),
    ...(item.files === undefined ? {} : { files: item.files }),
    ...(item.property === undefined ? {} : { property: item.property }),
  };
  const holder = mkdtempSync(join(pristine.holder, "property-"));
  const empty = mkdtempSync(join(holder, "host-"));
  let hostPolicy: SandboxPolicy | undefined;
  try {
    hostPolicy = createPolicy({ mode: "workspace-write", workspaceRoot: empty, log, ...(item.scratch !== undefined ? { scratchRoot: item.scratch } : {}) });
    const startedAt = Date.now();
    const imageBefore = workspaceDigest(pristine.copy, pristine.digestCache);
    const unknownBefore = pristine.digestCache.lastUnknown;
    const seqBefore = log.lastSeq;
    // What every execution runs with besides the product, snapshotted once,
    // right before the first of them (D58b V4, V6): each execution sees the
    // fixtures rewritten from the record, its verifier's files overlaid from
    // the same keep and a read-only scratch nothing an earlier execution
    // wrote — the same inputs, so one snapshot, whatever the scratch's size.
    let inputs: RecheckInputsRecord | undefined;
    const observation = runProperty({
      item: recorded,
      policy: hostPolicy,
      treeRoot: pristine.copy,
      replay: recheckPropertyReplay(item, log.events),
      sampleSeed: freshSampleSeed(),
      store,
      keepCounterexamples: false,
      deadlineMs: request.deadlineMs,
      // The spec in the prefix: a defect's bound property and a red case of
      // the same id with another spec are two identities (D58b V3).
      callPrefix: `${recheckCallId(request.round, item.kind, item.source, item.id)}-${item.spec.slice(0, 8)}`,
      executor: (scratch) => clonePropertyExecutor({
        log,
        source: pristine.copy,
        liveRoots: item.fromRoots,
        item: recorded,
        scratch,
        holder,
        deadlineMs: request.deadlineMs,
        remove: (place) => pristine.removals.push(removeWorkspaceCopyLater(place)),
        // Right before the command starts: this execution's verifier files
        // in its own copy (D47), then everything it runs with besides the
        // product, snapshotted (E1, E1').
        prepare: (copy, policy) => {
          const overlaid = filesDir === undefined ? [] : overlayVerifierFileList(filesDir, copy);
          overlaidCount = overlaid.length;
          const notOverlaid = keptButNotOverlaid(item.filesKept?.files ?? [], overlaid, copy);
          inputs ??= snapshotRecheckInputs(store, {
            ...executionSurface(policy),
            ...(item.kind === "reported" ? {
              copy,
              overlaid,
              keep: {
                kept: item.filesKept !== undefined,
                skipped: item.filesSkipped ?? 0,
                ...(item.filesKept?.reason === undefined ? {} : { reason: item.filesKept.reason }),
                ...(notOverlaid === 0 ? {} : { notOverlaid }),
              },
            } : {}),
          });
          return { inputs };
        },
      }),
    });
    const imageAfter = workspaceDigest(pristine.copy, pristine.digestCache);
    const receipt = mintPropertyReceipt({
      log, command: item.command, observation, imageBefore, imageAfter, seqBefore, startedAt,
      unknown: { before: unknownBefore, after: pristine.digestCache.lastUnknown },
    });
    // The status is the verdict of the observation's own fields (D58b V2):
    // an execution that started and ended with 126 or 127 is a violation, so
    // the check path's could-not-start rule is never applied to it.
    return {
      status: propertyVerdict(observation),
      ...(observation.exit_code === undefined ? {} : { exit_code: observation.exit_code }),
      ...(receipt === undefined ? {} : { receipt }),
      ...(observation.reason === undefined ? {} : { reason: observation.reason }),
      translated_paths: observation.translated_paths,
      ...withTargets(),
      ...scratchAfter(item),
      ...(observation.inputs === undefined ? {} : { inputs: observation.inputs }),
      property: observation,
    };
  } catch (error) {
    return { status: "not_runnable", reason: `the recheck run failed: ${message(error).slice(0, 200)}`, ...withTargets(), ...scratchAfter(item) };
  } finally {
    if (hostPolicy !== undefined) disposeSandboxPolicy(hostPolicy);
    pristine.removals.push(removeWorkspaceCopyLater(holder));
  }
}
