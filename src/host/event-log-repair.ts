import { constants } from "node:fs";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { sha256Hex } from "./event-log.ts";
import { GENESIS_HASH, type EventRecord } from "./schema.ts";

export interface EventLogRepairResult {
  total: number;
  kept: number;
  removed: number;
  head_seq: number;
  head_hash: string;
  dry_run: boolean;
}

interface ChainNode {
  record: EventRecord;
  line: string;
  parent?: ChainNode;
  depth: number;
}

/**
 * Recover a forked JSONL log only when one valid hash-chain head is uniquely
 * longest. The original bytes are copied with COPYFILE_EXCL before replacement;
 * ties, invalid records, and an existing backup all fail closed.
 *
 * Callers must stop session writers before invoking this operator repair.
 */
export function repairForkedEventLog(input: {
  path: string;
  backupPath: string;
  dryRun?: boolean;
}): EventLogRepairResult {
  const raw = readFileSync(input.path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("refusing fork repair while the EventLog has a torn tail");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const byHash = new Map<string, ChainNode>();
  const nodes: ChainNode[] = [];
  for (const line of lines) {
    const record = JSON.parse(line) as EventRecord;
    const { hash, ...unsigned } = record;
    if (typeof hash !== "string" || sha256Hex(canonicalJson(unsigned)) !== hash) {
      throw new Error(`refusing fork repair: invalid event hash at seq ${String(record.seq)}`);
    }
    const parent = record.prev_hash === GENESIS_HASH ? undefined : byHash.get(record.prev_hash);
    const reachable = record.prev_hash === GENESIS_HASH
      ? record.seq === 1
      : parent !== undefined && record.seq === parent.record.seq + 1;
    if (!reachable) throw new Error(`refusing fork repair: unreachable event at seq ${record.seq}`);
    const node: ChainNode = { record, line, ...(parent ? { parent } : {}), depth: (parent?.depth ?? 0) + 1 };
    if (byHash.has(hash)) throw new Error(`refusing fork repair: duplicate hash at seq ${record.seq}`);
    byHash.set(hash, node);
    nodes.push(node);
  }
  const depth = Math.max(0, ...nodes.map((node) => node.depth));
  const heads = nodes.filter((node) => node.depth === depth);
  if (heads.length !== 1) throw new Error(`refusing fork repair: longest chain is not unique (${heads.length} heads)`);
  const kept: ChainNode[] = [];
  for (let node: ChainNode | undefined = heads[0]; node; node = node.parent) kept.push(node);
  kept.reverse();
  const head = kept.at(-1);
  const result: EventLogRepairResult = {
    total: nodes.length,
    kept: kept.length,
    removed: nodes.length - kept.length,
    head_seq: head?.record.seq ?? 0,
    head_hash: head?.record.hash ?? GENESIS_HASH,
    dry_run: input.dryRun === true,
  };
  if (input.dryRun) return result;

  copyFileSync(input.path, input.backupPath, constants.COPYFILE_EXCL);
  const temporary = join(dirname(input.path), `.events-repair-${process.pid}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${kept.map((node) => node.line).join("\n")}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, input.path);
  return result;
}
