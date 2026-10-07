import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { containsSecret } from "../host/redact.ts";
import { gitTrackedState } from "../host/git-view.ts";
import { ScratchError } from "./scratch-error.ts";
import {
  assertTestPath,
  createPromotedFile,
  listScratchEntries,
  pruneEmptyScratchDirectories,
  readScratchSource,
  removeSameEntry,
  safeRelativePath,
  scratchEntryAt,
  workspaceEntryAt,
  type ScratchEntry,
} from "./scratch-path.ts";
import {
  prepareScratchPlan,
  promotedCaseCommand,
  type ScratchCaseAttachment,
} from "./scratch-plan.ts";

export interface PromoteScratchInput {
  readonly workspaceRoot: string;
  readonly source: string;
  readonly target: string;
  readonly log: EventLog;
  readonly attach?: ScratchCaseAttachment;
}

export interface PromoteScratchResult {
  readonly source: string;
  readonly target: string;
  readonly bytes: number;
  readonly digest: string;
  readonly sourceRemoved: boolean;
  readonly caseId?: string;
}

export interface CleanScratchInput {
  readonly workspaceRoot: string;
  readonly log: EventLog;
  readonly dryRun?: boolean;
  readonly all?: boolean;
}

export interface CleanScratchResult {
  readonly eligible: number;
  readonly removed: number;
  readonly keptTracked: number;
  readonly bytesFreed: number;
  readonly manifestDigest: string;
}

export function promoteScratch(input: PromoteScratchInput): PromoteScratchResult {
  const source = safeRelativePath(input.workspaceRoot, input.source);
  const target = safeRelativePath(input.workspaceRoot, input.target);
  assertTestPath(target);
  const content = readScratchSource(input.workspaceRoot, source);
  if (containsSecret(content.text)) {
    throw new ScratchError("secret_detected", "scratch promotion refused: source contains secret-shaped material");
  }
  const command = promotedCaseCommand(target);
  const prepared = input.attach
    ? prepareScratchPlan(input.workspaceRoot, target, command, input.attach)
    : undefined;
  input.log.append({
    kind: "effect",
    name: "scratch/promote",
    payload: {
      source,
      target,
      bytes: content.bytes.byteLength,
      sha256: content.digest,
      ...(prepared ? { case_id: prepared.caseId } : {}),
    },
  });

  let targetEntry: ScratchEntry | undefined;
  try {
    createPromotedFile(input.workspaceRoot, target, content.bytes);
    targetEntry = workspaceEntryAt(input.workspaceRoot, target);
    if (!targetEntry || targetEntry.kind !== "file") {
      throw new ScratchError("invalid_target", "promotion target disappeared after creation");
    }
    prepared?.write();
  } catch (error) {
    if (targetEntry) removeSameEntry(input.workspaceRoot, targetEntry);
    const failure = scratchFailure(error);
    input.log.append({
      kind: "observe",
      name: "scratch/promote_result",
      payload: { status: "failed", code: failure.code, source, target },
    });
    throw failure;
  }

  let sourceRemoved = false;
  const currentSource = scratchEntryAt(input.workspaceRoot, source);
  if (currentSource && currentSource.dev === content.dev && currentSource.ino === content.ino) {
    sourceRemoved = removeSameEntry(input.workspaceRoot, currentSource);
    pruneEmptyScratchDirectories(input.workspaceRoot, [source]);
  }
  const result: PromoteScratchResult = {
    source,
    target,
    bytes: content.bytes.byteLength,
    digest: content.digest,
    sourceRemoved,
    ...(prepared ? { caseId: prepared.caseId } : {}),
  };
  input.log.append({
    kind: "observe",
    name: "scratch/promote_result",
    payload: {
      status: "promoted",
      source,
      target,
      bytes: result.bytes,
      sha256: result.digest,
      source_removed: result.sourceRemoved,
      ...(result.caseId ? { case_id: result.caseId } : {}),
    },
  });
  return result;
}

export function cleanScratch(input: CleanScratchInput): CleanScratchResult {
  const discovered = input.all === true
    ? listScratchEntries(input.workspaceRoot)
    : sessionScratchEntries(input.workspaceRoot, input.log.events);
  const tracked: ScratchEntry[] = [];
  const eligible: ScratchEntry[] = [];
  for (const entry of discovered) {
    const state = gitTrackedState({ root: input.workspaceRoot, path: entry.path });
    if (state.status === "unavailable") {
      throw new ScratchError("git_unavailable", "Git tracked-file status is unavailable; scratch cleanup refused");
    }
    if (state.status === "tracked") tracked.push(entry);
    else eligible.push(entry);
  }
  const manifestDigest = createHash("sha256")
    .update(eligible.map((entry) => `${entry.path}\0${entry.dev}:${entry.ino}\0${entry.bytes}`).sort().join("\n"))
    .digest("hex");
  input.log.append({
    kind: "effect",
    name: "scratch/clean",
    payload: {
      scope: input.all === true ? "all" : "session",
      dry_run: input.dryRun === true,
      eligible: eligible.length,
      kept_tracked: tracked.length,
      manifest_sha256: manifestDigest,
    },
  });

  let removed = 0;
  let bytesFreed = 0;
  try {
    if (input.dryRun !== true) {
      for (const entry of eligible) {
        removeSameEntry(input.workspaceRoot, entry);
        removed += 1;
        bytesFreed += entry.bytes;
      }
      pruneEmptyScratchDirectories(input.workspaceRoot, eligible.map((entry) => entry.path));
    }
  } catch (error) {
    const failure = scratchFailure(error);
    input.log.append({
      kind: "observe",
      name: "scratch/clean_result",
      payload: { status: "failed", code: failure.code, removed, bytes_freed: bytesFreed },
    });
    throw failure;
  }
  const result: CleanScratchResult = {
    eligible: eligible.length,
    removed,
    keptTracked: tracked.length,
    bytesFreed,
    manifestDigest,
  };
  input.log.append({
    kind: "observe",
    name: "scratch/clean_result",
    payload: {
      status: input.dryRun === true ? "previewed" : "cleaned",
      eligible: result.eligible,
      removed: result.removed,
      kept_tracked: result.keptTracked,
      bytes_freed: result.bytesFreed,
      manifest_sha256: result.manifestDigest,
    },
  });
  return result;
}

function sessionScratchEntries(workspaceRoot: string, events: readonly EventRecord[]): ScratchEntry[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.name !== "tool/call") continue;
    if (event.payload.name !== "write" && event.payload.name !== "edit") continue;
    const args = event.payload.args;
    if (typeof args !== "object" || args === null) continue;
    const raw = Reflect.get(args, "path");
    if (typeof raw !== "string") continue;
    const candidate = raw.startsWith("/testbed/") ? raw.slice("/testbed/".length) : raw;
    try {
      const path = safeRelativePath(workspaceRoot, candidate);
      if (path.startsWith("work/scratch/")) paths.add(path);
    } catch (error) {
      if (!(error instanceof ScratchError)) throw error;
    }
  }
  const entries: ScratchEntry[] = [];
  for (const path of paths) {
    const entry = scratchEntryAt(workspaceRoot, path);
    if (entry) entries.push(entry);
  }
  return entries;
}

function scratchFailure(error: unknown): ScratchError {
  if (error instanceof ScratchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ScratchError("filesystem_changed", message);
}
