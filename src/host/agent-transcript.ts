import { BlobStore } from "./blob-store.ts";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { containsSecretValue } from "./redact.ts";
import type { EventLog } from "./event-log.ts";
import { inputDigest, liveProviderState, recordedProviderState, requireProviderInput } from "./provider-input.ts";

export function agentTranscriptPath(logPath: string): string {
  return join(dirname(logPath), "agent.json");
}

export interface AgentTranscriptFile {
  prefix_hash: string;
  system_prompt_hash?: string;
  tool_schema_hash?: string;
  plugin_manifest_digest?: string;
  model_id: string;
  route: string;
  messages: unknown[];
}

export type AgentTranscriptMismatchReason =
  | "transcript_missing"
  | "transcript_invalid"
  | "empty_transcript"
  | "route_mismatch"
  | "model_mismatch"
  | "system_prompt_mismatch"
  | "tool_schema_mismatch"
  | "plugin_manifest_mismatch"
  | "prefix_hash_mismatch";

export type AgentTranscriptMismatch =
  | "empty_transcript"
  | "route"
  | "model"
  | "system_prompt"
  | "tool_schema"
  | "plugin_manifest"
  | "prefix_hash";

export type AgentTranscriptInspection =
  | { restored: true; messages: unknown[]; file: AgentTranscriptFile; stored_messages: number }
  | {
      restored: false;
      reason: AgentTranscriptMismatchReason;
      mismatches?: readonly AgentTranscriptMismatch[];
      stored_messages: number;
      file?: AgentTranscriptFile;
    };

export interface AgentTranscriptExpectation {
  prefix_hash: string;
  system_prompt_hash?: string;
  tool_schema_hash?: string;
  plugin_manifest_digest?: string;
  model_id: string;
  route: string;
}

/** Crash-safe replacement for session-private state. Callers perform their
 * own content policy before this low-level helper. */
export function writePrivateFileAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function saveAgentTranscript(path: string, file: AgentTranscriptFile): boolean {
  if (!Array.isArray(file.messages) || file.messages.length === 0) {
    return false;
  }
  const body = `${JSON.stringify(file)}\n`;
  if (containsSecretValue(file)) {
    return false;
  }
  writePrivateFileAtomic(path, body);
  return true;
}

export function readAgentTranscriptFile(path: string): AgentTranscriptFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentTranscriptFile;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.messages) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A recovery transaction may read the pre-seal state while compaction is
 * pending. It still obtains both messages and metadata from the ledger. */
export function recordedAgentTranscript(log: EventLog): AgentTranscriptFile | undefined {
  const state = liveProviderState(log), metadata = state.metadata;
  if (!state.ref || !state.messages.length) return;
  requireProviderInput(metadata && typeof metadata.prefix_hash === "string" && typeof metadata.model_id === "string"
    && typeof metadata.route === "string", "recorded cache metadata is incomplete");
  return { ...metadata, prefix_hash: metadata.prefix_hash, model_id: metadata.model_id, route: metadata.route,
    messages: state.messages };
}

/** Rebuild an absent cache from authenticated structured history. An existing
 * cache must agree; silently blessing a cache-only insertion is forbidden. */
export function synchronizeAgentTranscript(log: EventLog, path = agentTranscriptPath(log.path)): void {
  const state = liveProviderState(log);
  if (!state.ref) return;
  requireProviderInput(!state.pending, "transcript compaction is unsettled");
  const existing = readAgentTranscriptFile(path);
  if (existsSync(path)) {
    requireProviderInput(existing && inputDigest(existing.messages) === inputDigest(state.messages), "private transcript cache differs from the log");
    return;
  }
  if (!state.messages.length) return;
  saveAgentTranscript(path, recordedAgentTranscript(log)!);
}

export function loadAgentTranscript(
  path: string,
  expect: AgentTranscriptExpectation,
): unknown[] | undefined {
  const inspected = inspectAgentTranscript(path, expect);
  return inspected.restored ? inspected.messages : undefined;
}

/** Inspect without collapsing operator-actionable mismatch reasons. Legacy
 * transcripts remain resumable when their original three keys still match. */
export function inspectAgentTranscript(
  path: string,
  expect: AgentTranscriptExpectation,
): AgentTranscriptInspection {
  if (!existsSync(path)) {
    return { restored: false, reason: "transcript_missing", stored_messages: 0 };
  }
  let parsed: AgentTranscriptFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as AgentTranscriptFile;
  } catch {
    return { restored: false, reason: "transcript_invalid", stored_messages: 0 };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
    return { restored: false, reason: "transcript_invalid", stored_messages: 0 };
  }
  const stored_messages = parsed.messages.length;
  if (
    typeof parsed.prefix_hash !== "string"
    || typeof parsed.model_id !== "string"
    || typeof parsed.route !== "string"
  ) {
    return { restored: false, reason: "transcript_invalid", stored_messages };
  }
  const failed = (
    reason: AgentTranscriptMismatchReason,
    mismatches: readonly AgentTranscriptMismatch[],
  ): AgentTranscriptInspection => ({
    restored: false,
    reason,
    mismatches,
    stored_messages,
    file: parsed,
  });
  const failures: Array<{ mismatch: AgentTranscriptMismatch; reason: AgentTranscriptMismatchReason }> = [];
  if (stored_messages === 0) failures.push({ mismatch: "empty_transcript", reason: "empty_transcript" });
  if (parsed.route !== expect.route) failures.push({ mismatch: "route", reason: "route_mismatch" });
  if (parsed.model_id !== expect.model_id) failures.push({ mismatch: "model", reason: "model_mismatch" });
  if (expect.system_prompt_hash && parsed.system_prompt_hash && parsed.system_prompt_hash !== expect.system_prompt_hash) {
    failures.push({ mismatch: "system_prompt", reason: "system_prompt_mismatch" });
  }
  if (expect.tool_schema_hash && parsed.tool_schema_hash && parsed.tool_schema_hash !== expect.tool_schema_hash) {
    failures.push({ mismatch: "tool_schema", reason: "tool_schema_mismatch" });
  }
  if (
    expect.plugin_manifest_digest
    && parsed.plugin_manifest_digest
    && parsed.plugin_manifest_digest !== expect.plugin_manifest_digest
  ) {
    failures.push({ mismatch: "plugin_manifest", reason: "plugin_manifest_mismatch" });
  }
  if (parsed.prefix_hash !== expect.prefix_hash) {
    failures.push({ mismatch: "prefix_hash", reason: "prefix_hash_mismatch" });
  }
  if (failures.length > 0) {
    return failed(failures[0]!.reason, failures.map((failure) => failure.mismatch));
  }
  return { restored: true, messages: parsed.messages, file: parsed, stored_messages };
}

/** An owned child may exit between a durable append and private-cache upkeep.
 * Repair only an authenticated ancestor with an appended suffix, never cache-only
 * history, a changed prefix/model, or a transcript transformation. */
export function restoreOwnedAgentTranscript(log: EventLog, expectation: AgentTranscriptExpectation): void {
  requireProviderInput(!log.isReadOnly, "owned transcript repair is unavailable in replay");
  log.refresh();
  const path = agentTranscriptPath(log.path);
  const state = liveProviderState(log);
  // Before its first request a cancelled child can leave logged input but no
  // provider metadata or private cache. There is no derived cache to repair.
  if (!state.metadata && !existsSync(path)) return;
  const target = recordedAgentTranscript(log);
  if (!target) return;
  requireProviderInput(!state.pending, "owned transcript compaction is unsettled");
  const metadata = ({ messages: _messages, ...value }: AgentTranscriptFile) => value;
  const sameMetadata = (left: object, right: object) => inputDigest(left) === inputDigest(right);
  requireProviderInput(sameMetadata(metadata(target), expectation), "owned transcript metadata requires explicit reseed");
  const existing = readAgentTranscriptFile(path);
  let ancestor: { seq: number; hash: string } | null = null;
  if (existsSync(path)) {
    requireProviderInput(existing && sameMetadata(metadata(existing), metadata(target)), "owned cache metadata requires explicit reseed");
    const digest = inputDigest(existing.messages);
    if (digest === inputDigest(target.messages)) return;
    requireProviderInput(existing.messages.length > 0 && existing.messages.length < target.messages.length
      && digest === inputDigest(target.messages.slice(0, existing.messages.length)), "owned cache is not a recorded ancestor");
    const store = BlobStore.forSession(log.path);
    const row = [...log.events].reverse().find(event => {
      if (event.name !== "provider/state" || typeof event.payload.blob !== "string") return false;
      const body = JSON.parse(store.get(event.payload.blob));
      return body.after === digest;
    });
    requireProviderInput(row, "owned cache has no authenticated historical state");
    const prior = recordedProviderState(log, log.events.slice(0, row.seq));
    requireProviderInput(prior.ref?.seq === row.seq && inputDigest(prior.messages) === digest
      && sameMetadata(prior.metadata ?? {}, metadata(existing)), "owned cache historical state differs");
    ancestor = { seq: row.seq, hash: row.hash };
  }
  const receipt = {
    reason: "owned_child_return", ancestor, state: state.ref,
    before: existing ? inputDigest(existing.messages) : null,
    after: inputDigest(target.messages), messages: target.messages.length,
  };
  log.appendDurable({ kind: "effect", name: "work/cache_recovery", payload: receipt });
  try {
    requireProviderInput(saveAgentTranscript(path, target), "owned transcript cache persistence refused");
    log.appendDurable({ kind: "observe", name: "work/cache_recovered", payload: { ...receipt, status: "completed" } });
  } catch (error) {
    log.appendDurable({ kind: "observe", name: "work/cache_recovered", payload: { ...receipt, status: "failed" } });
    throw error;
  }
}
