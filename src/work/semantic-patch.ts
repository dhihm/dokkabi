import { hostWorkTreeListing } from "../host/host-index.ts";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import {
  captureInPlaceDelta,
  captureWorktreeSnapshot,
  releaseWorktreeSnapshot,
  type WorktreeDelta,
  type WorktreeSnapshot,
} from "../swarm/worktree.ts";
import { relativeFiles } from "./artifacts/build.ts";
import { planDigest } from "./digest.ts";
import type { WorkPlan } from "./schema.ts";

export const MINOR_PATCH_MAX_FILES = 2;
export const MINOR_PATCH_MAX_CHANGED_LINES = 16;
const SNAPSHOT_MAX_FILES = 20_000;
const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface SemanticPatchSummary {
  readonly changedLines: number;
  readonly footprintDigest: string;
  readonly minor: boolean;
}

export interface SemanticAttemptPatch {
  readonly log: EventLog;
  readonly plan: WorkPlan;
  readonly todo: string;
  readonly cases: readonly string[];
  readonly patch: string;
  readonly patchDigest: string;
  readonly files: readonly string[];
  readonly stepId?: string;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

export function summarizeSemanticPatch(
  patch: string,
  files: readonly string[],
): SemanticPatchSummary {
  let changedLines = 0;
  let file = "missing";
  const footprints = new Set<string>();
  let binary = false;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = createHash("sha256").update(line).digest("hex").slice(0, 16);
      footprints.add(file);
      inHunk = false;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      const context = hunk[2]?.trim();
      footprints.add(`${file}:${context || `line-${hunk[1]}`}`);
      inHunk = true;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      changedLines += 1;
    }
  }
  if (patch.length === 0) footprints.add("no-change");
  if (binary) changedLines = Math.max(changedLines, MINOR_PATCH_MAX_CHANGED_LINES + 1);
  const footprintDigest = createHash("sha256")
    .update([...footprints].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return {
    changedLines,
    footprintDigest,
    minor: files.length <= MINOR_PATCH_MAX_FILES
      && changedLines <= MINOR_PATCH_MAX_CHANGED_LINES,
  };
}

export function appendSemanticAttemptPatch(input: SemanticAttemptPatch): void {
  const summary = summarizeSemanticPatch(input.patch, input.files);
  input.log.append({
    kind: "observe",
    name: "work/attempt_patch",
    payload: {
      todo: input.todo,
      cases: [...input.cases].sort(),
      plan_digest: planDigest(input.plan),
      patch_digest: input.patchDigest,
      footprint_digest: summary.footprintDigest,
      files_count: input.files.length,
      changed_lines: summary.changedLines,
      minor: summary.minor,
      ...(input.stepId ? { step_id: input.stepId } : {}),
    },
  });
}

function recordUnavailable(log: EventLog, todo: string, phase: string): void {
  log.append({
    kind: "observe",
    name: "livelock/evidence",
    payload: { todo, status: "unavailable", phase },
  });
}

function assertSemanticSnapshotBudget(workspaceRoot: string): void {
  const root = realpathSync(resolve(workspaceRoot));
  // I2 (D57g): the inputs are what the host lists (its own walk, the tree's
  // rules as the host evaluates them), never git's index.
  const files = hostWorkTreeListing(root).map((entry) => entry.path.toString());
  if (files.length > SNAPSHOT_MAX_FILES) throw new Error("semantic snapshot file limit exceeded");
  let totalBytes = 0;
  for (const file of files) {
    const path = resolve(root, file);
    const fromRoot = relative(root, path);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)
      || isAbsolute(fromRoot)) throw new Error("semantic snapshot path escaped workspace");
    const stats = lstatSync(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error("semantic snapshot input is not a file");
    }
    if (stats.size > SNAPSHOT_MAX_FILE_BYTES) {
      throw new Error("semantic snapshot file limit exceeded");
    }
    totalBytes += stats.size;
    if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) {
      throw new Error("semantic snapshot byte limit exceeded");
    }
  }
}

export function captureSemanticAttempt(
  log: EventLog,
  workspaceRoot: string,
  todo: string,
): WorktreeSnapshot | undefined {
  try {
    assertSemanticSnapshotBudget(workspaceRoot);
    return captureWorktreeSnapshot(workspaceRoot, { runtimeArtifacts: false, isolatedObjects: true });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    recordUnavailable(log, todo, "capture_start");
    return undefined;
  }
}

export function appendCapturedSemanticAttempt(input: {
  readonly log: EventLog;
  readonly plan: WorkPlan;
  readonly todo: string;
  readonly cases: readonly string[];
  readonly workspaceRoot: string;
  readonly base: WorktreeSnapshot | undefined;
}): void {
  if (!input.base) return;
  try {
    assertSemanticSnapshotBudget(input.workspaceRoot);
    const delta: WorktreeDelta = captureInPlaceDelta(input.base, input.workspaceRoot, { allowHeadChange: true });
    appendSemanticAttemptPatch({
      ...input,
      patch: delta.patch,
      patchDigest: delta.patchDigest,
      files: relativeFiles(delta.patch, input.workspaceRoot),
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    recordUnavailable(input.log, input.todo, "capture_end");
  } finally {
    releaseWorktreeSnapshot(input.base);
  }
}

export function discardCapturedSemanticAttempt(base: WorktreeSnapshot | undefined): void {
  if (base) releaseWorktreeSnapshot(base);
}
