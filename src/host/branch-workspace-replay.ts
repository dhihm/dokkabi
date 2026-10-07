import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import {
  BRANCH_WORKSPACE_SCHEMA,
  branchWorkspaceReceiptSchemas,
  validateBranchWorkspaceLifecycle,
  verifyRetainedBranchWorkspace,
  type BranchWorkspaceReceiptName,
} from "./branch-workspace.ts";
import { BlobStore } from "./blob-store.ts";
import type { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";

/** R8-02 replay: ordered lifecycle references for the replay contract, plus
 * the cold retained-evidence verification replay preflight runs. Pure
 * projection over the log and its blob store — replay never allocates a
 * workspace, removes a resource, reads a live root or starts a process.
 * The lifecycle rules themselves are the one closed validator the host
 * writer already enforced before any row landed. */

export interface BranchWorkspaceReference {
  seq: number;
  name: BranchWorkspaceReceiptName;
  payloadDigest: string;
}

/** Recorded lifecycle only, validated by the shared closed validator: one
 * intent/terminal/release/closure sequence per session identifier, bound to
 * the governing session identity and written only under the
 * `branch-workspace-v1` replay feature generation. Incomplete intents stay
 * visible as references while remaining unknown outcomes. */
export function projectBranchWorkspaceReferences(events: readonly EventRecord[]): BranchWorkspaceReference[] {
  const lifecycle = validateBranchWorkspaceLifecycle(events);
  return lifecycle.ordered.map(({ row, name, payload }) => ({
    seq: row.seq,
    name,
    payloadDigest: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
  }));
}

/** Verify every recorded ready workspace from retained evidence alone: the
 * authenticated source bundle, the original and derived image digests with
 * their body digests, the deterministic transformation, the exact historical
 * model metadata, the recorded policy and the deterministic owner receipt.
 * No filesystem root, no spawn, no allocation; orphan or duplicate terminals
 * refuse in the shared lifecycle validator. */
export function validateRecordedBranchWorkspaces(log: Pick<EventLog, "path" | "events">, suppliedStore?: BlobStore): void {
  const lifecycle = validateBranchWorkspaceLifecycle(log.events);
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  for (const row of lifecycle.ordered) {
    if (row.name !== "branch/workspace_ready") continue;
    verifyRetainedBranchWorkspace(log.events, store, row.payload as Parameters<typeof verifyRetainedBranchWorkspace>[2], row.row.seq);
  }
}

// The schema constant stays referenced here so the replay module's feature
// wiring cannot drift from the receipt contract it projects.
export const BRANCH_WORKSPACE_REPLAY_SCHEMA = BRANCH_WORKSPACE_SCHEMA;
export { branchWorkspaceReceiptSchemas };
