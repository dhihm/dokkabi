import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordedAgentTranscript, writePrivateFileAtomic } from "./agent-transcript.ts";
import type { EventLog } from "./event-log.ts";

export interface CompactionRecovery {
  recovered: boolean;
  needsSeal: boolean;
  startSeq?: number;
}

export function pendingCompactionPath(transcriptPath: string): string {
  return join(dirname(transcriptPath), "agent-compaction.pending.json");
}

export function compactionBackupPath(transcriptPath: string): string {
  return join(dirname(transcriptPath), "agent-transcript.pre-compaction.json");
}

export function beginCompactionTransaction(transcriptPath: string, startSeq: number): void {
  if (!existsSync(transcriptPath)) {
    throw new Error("cannot compact a missing agent transcript");
  }
  const original = readFileSync(transcriptPath, "utf8");
  writePrivateFileAtomic(compactionBackupPath(transcriptPath), original);
  writePrivateFileAtomic(
    pendingCompactionPath(transcriptPath),
    `${JSON.stringify({ version: 1, start_seq: startSeq })}\n`,
  );
}

export function prepareCompactionTransaction(transcriptPath: string, startSeq: number): void {
  if (!existsSync(transcriptPath)) {
    throw new Error("cannot compact a missing agent transcript");
  }
  const original = readFileSync(transcriptPath, "utf8");
  writePrivateFileAtomic(compactionBackupPath(transcriptPath), original);
  writePrivateFileAtomic(
    pendingCompactionPath(transcriptPath),
    `${JSON.stringify({ version: 2, phase: "prepared", start_seq: startSeq })}\n`,
  );
}

export function finishCompactionTransaction(transcriptPath: string): void {
  rmSync(pendingCompactionPath(transcriptPath), { force: true });
}

function parsePendingCompaction(text: string): {
  readonly startSeq: number;
  readonly prepared: boolean;
} {
  const decoded: unknown = JSON.parse(text);
  if (decoded === null || typeof decoded !== "object") {
    throw new Error("invalid pending compaction marker");
  }
  const version = "version" in decoded ? decoded.version : 1;
  const phase = "phase" in decoded ? decoded.phase : undefined;
  const startSeq = "start_seq" in decoded ? decoded.start_seq : undefined;
  const prepared = version === 2 && phase === "prepared";
  if (
    (version !== 1 && !prepared)
    || !Number.isInteger(startSeq)
    || typeof startSeq !== "number"
    || startSeq < 1
  ) {
    throw new Error("invalid pending compaction marker");
  }
  return { startSeq, prepared };
}

/**
 * A process can die after agent.json is replaced but before prompt/seal is
 * appended. A matching marker makes that window recoverable: restore the
 * exact pre-compaction transcript, record the rollback, then let boot close
 * an already-observed drop with a compaction seal.
 */
export function recoverInterruptedCompaction(input: {
  transcriptPath: string;
  log: EventLog;
}): CompactionRecovery {
  const pendingPath = pendingCompactionPath(input.transcriptPath);
  if (!existsSync(pendingPath)) {
    return { recovered: false, needsSeal: false };
  }
  let startSeq: number;
  let prepared: boolean;
  try {
    const pending = parsePendingCompaction(readFileSync(pendingPath, "utf8"));
    startSeq = pending.startSeq;
    prepared = pending.prepared;
  } catch (error) {
    throw new Error(`cannot recover pending compaction: ${error instanceof Error ? error.message : String(error)}`);
  }

  const start = input.log.events.find((event) =>
    event.seq === startSeq && event.name === "compaction/start" && event.payload.reason !== "in_turn"
  );
  const restoreBeforeSeal = () => {
    const recorded = recordedAgentTranscript(input.log);
    if (recorded) {
      writePrivateFileAtomic(input.transcriptPath, `${JSON.stringify(recorded)}\n`);
      return;
    }
    const backupPath = compactionBackupPath(input.transcriptPath);
    if (!existsSync(backupPath)) throw new Error(`pending compaction start_seq=${startSeq} has no matching backup`);
    writePrivateFileAtomic(input.transcriptPath, readFileSync(backupPath, "utf8"));
  };
  if (!start) {
    if (prepared) {
      restoreBeforeSeal();
      finishCompactionTransaction(input.transcriptPath);
      return { recovered: true, needsSeal: false, startSeq };
    }
    throw new Error(`pending compaction start_seq=${startSeq} is not in the EventLog`);
  }
  const after = input.log.events.filter((event) => event.seq > startSeq);
  const committed = after.some((event) => event.name === "prompt/seal" && event.payload.reason === "compaction");
  if (committed) {
    finishCompactionTransaction(input.transcriptPath);
    return { recovered: false, needsSeal: false, startSeq };
  }

  restoreBeforeSeal();
  finishCompactionTransaction(input.transcriptPath);
  const needsSeal = after.some((event) => event.name === "compaction/drop" && event.payload.in_turn !== true);
  input.log.append({
    kind: "observe",
    name: "compaction/end",
    payload: { status: "recovered", start_seq: startSeq, restored_backup: true, needs_seal: needsSeal },
  });
  return { recovered: true, needsSeal, startSeq };
}
