import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../host/blob-store.ts";
import type { EventLog } from "../../host/event-log.ts";
import { spawnSealedHostGit } from "../../host/git-authority.ts";
import { captureWorktreeSnapshot } from "../../swarm/worktree.ts";
import { assertPatchDiffV1, type PatchDiffV1 } from "../artifacts/step.ts";
import type { GateInput, GateResult } from "./registry.ts";

/**
 * The v1 ground-truth gate (#77): a recorded `patch_diff_v1` must be the
 * whole and exact patch standing in the workspace.
 *
 * Two facts have to hold, and each needs its own check:
 *
 *  1. **The patch is complete.** Replay it into a temporary index over the
 *     recorded `base_tree` and compare the resulting tree to `final_tree`.
 *     A reverse `--check` alone would NOT catch this — a diff that omits a
 *     file the step also changed still un-applies cleanly, because its own
 *     hunks match. Only rebuilding the tree exposes the omission.
 *  2. **The workspace is where the artifact says.** Compare the live tree
 *     to `final_tree`.
 *
 * The replay runs in a scratch `GIT_INDEX_FILE`, never against the live
 * worktree: the step's edits are already applied there, so a forward
 * `git apply` would fail for entirely the wrong reason.
 */
export function verifyPatchApplies(log: EventLog, input: GateInput): GateResult {
  const store = BlobStore.forSession(log.path);
  let body: unknown;
  try {
    body = JSON.parse(store.get(input.artifact.blob));
  } catch {
    return { status: "fail", reasonCode: "artifact_unreadable" };
  }
  try {
    assertPatchDiffV1(body);
  } catch (error) {
    return {
      status: "fail",
      reasonCode: "artifact_invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const diff: PatchDiffV1 = body;
  const patch = input.artifact.sourceBlob === undefined ? "" : store.get(input.artifact.sourceBlob);

  let liveTree: string;
  try {
    liveTree = captureWorktreeSnapshot(input.workspaceRoot).tree;
  } catch (error) {
    return {
      status: "fail",
      reasonCode: "workspace_unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (liveTree !== diff.final_tree) {
    return { status: "fail", reasonCode: "final_tree_mismatch" };
  }

  if (patch.length === 0) {
    // `git apply` exits 128 on an empty patch, so a step that legitimately
    // changed nothing must be recognised before the replay, not refused by
    // it. An empty patch and a non-empty file list contradict each other.
    return diff.files.length === 0 && diff.base_tree === diff.final_tree
      ? { status: "pass", reasonCode: "empty_step" }
      : { status: "fail", reasonCode: "patch_missing" };
  }

  const indexRoot = mkdtempSync(join(tmpdir(), "dokkabi-gate-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(indexRoot, "index") };
    const read = spawnSealedHostGit(input.workspaceRoot, ["read-tree", diff.base_tree], { extraEnv: env });
    if (read.exitCode !== 0) {
      return { status: "fail", reasonCode: "base_tree_unreadable", detail: read.stderr.toString() };
    }
    const check = spawnSealedHostGit(
      input.workspaceRoot,
      ["apply", "--cached", "--check", "--binary", "-"],
      { input: patch, extraEnv: env },
    );
    if (check.exitCode !== 0) {
      return { status: "fail", reasonCode: "patch_does_not_apply", detail: check.stderr.toString() };
    }
    const applied = spawnSealedHostGit(
      input.workspaceRoot,
      ["apply", "--cached", "--binary", "-"],
      { input: patch, extraEnv: env },
    );
    if (applied.exitCode !== 0) {
      return { status: "fail", reasonCode: "patch_does_not_apply", detail: applied.stderr.toString() };
    }
    const written = spawnSealedHostGit(input.workspaceRoot, ["write-tree"], { extraEnv: env });
    if (written.exitCode !== 0) {
      return { status: "fail", reasonCode: "patch_tree_unwritable", detail: written.stderr.toString() };
    }
    if (written.stdout.toString().trim() !== diff.final_tree) {
      // The patch applies but does not rebuild what the artifact declares —
      // the recorded diff is incomplete or the workspace moved past it.
      return { status: "fail", reasonCode: "patch_does_not_rebuild_tree" };
    }
  } finally {
    rmSync(indexRoot, { recursive: true, force: true });
  }
  return { status: "pass", reasonCode: "patch_applies" };
}
