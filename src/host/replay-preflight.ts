import { foldRecoveryEpisodes } from "./recovery.ts";
import { validateRecordedBranchWorkspaces } from "./branch-workspace-replay.ts";
import { validateRecordedCheckpointInputImports } from "./checkpoint-input-import-replay.ts";
import { validateRecordedBranchCheckpoints } from "./branch-checkpoint-replay.ts";
import { validateRecordedBranchDecisions } from "./branch-decision.ts";
import { validateRecordedBranchRuntime } from "../chat/desktop-branch-runtime.ts";
import { validateRecordedBranchContext } from "../context-graph/branch-context.ts";
import { BlobIntegrityError, collectReferencedBlobs, BlobStore } from "./blob-store.ts";
import type { EventLog } from "./event-log.ts";
import {
  validateRecordedSwarmMemoryBindings,
  validateRecordedSwarmMemoryViews,
} from "../swarm/memory-transport.ts";
import { validateRecordedMaekQueries } from "../maek/query-envelope.ts";
import { validateRecordedSourceReads } from "./result-source.ts";
import { validateRecordedReadBatches } from "./read-batch.ts";
import { validateRecordedEarlyReads } from "./received-calls.ts";

export class MissingBlobError extends Error {
  readonly code = "missing_blob" as const;
  constructor(
    readonly digest: string,
    readonly seq: number,
  ) {
    super(
      `Error: Missing blob for digest sha256:${digest.slice(0, 7)}... referenced at event seq #${seq}\nReplay aborted (fail-closed).`,
    );
    this.name = "MissingBlobError";
  }
}

export class CorruptBlobError extends Error {
  readonly code = "corrupt_blob" as const;
  constructor(
    readonly digest: string,
    readonly seq: number,
  ) {
    super(
      `Error: Corrupt blob for digest sha256:${digest.slice(0, 7)}... referenced at event seq #${seq}\nReplay aborted (fail-closed).`,
    );
    this.name = "CorruptBlobError";
  }
}

/** Fail closed if any payload.blob is absent from the session store. */
export function assertReplayBlobs(log: Pick<EventLog, "path" | "events">, store?: BlobStore): void {
  const blobs = store ?? BlobStore.forSession(log.path);
  const needed = collectReferencedBlobs(log.events);
  for (const digest of needed) {
    const event = log.events.find((item) => item.payload.blob === digest);
    if (!blobs.has(digest)) {
      throw new MissingBlobError(digest, event?.seq ?? 0);
    }
    try {
      blobs.get(digest);
    } catch (error) {
      if (error instanceof BlobIntegrityError) {
        throw new CorruptBlobError(digest, event?.seq ?? 0);
      }
      throw error;
    }
  }
  foldRecoveryEpisodes(log.events);
  validateRecordedBranchCheckpoints(log, blobs);
  validateRecordedBranchWorkspaces(log, blobs);
  validateRecordedCheckpointInputImports(log, blobs);
  validateRecordedBranchContext(log, blobs);
  validateRecordedBranchDecisions(log, blobs);
  validateRecordedBranchRuntime(log, blobs);
  validateRecordedSourceReads(log.events, blobs);
  validateRecordedReadBatches(log.events);
  validateRecordedEarlyReads(log.events);
  validateRecordedMaekQueries(log.events, blobs);
  validateRecordedSwarmMemoryViews(log, blobs);
  validateRecordedSwarmMemoryBindings(log, blobs);
}
