import { HANDOFF_CAUTION_TOKENS } from "./model-handoff.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { deriveMessages } from "./derive-messages.ts";
import type { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";
import { writeWorkPlan } from "../work/decompose.ts";
import { currentPlanPath } from "../work/graph.ts";
import { readPlanFromLog } from "../work/log.ts";
import { replaceProviderMessages, liveProviderState, inputReference, inputDigest,
  recordedProviderState, requireProviderInput } from "./provider-input.ts";
import {
  readAgentTranscriptFile,
  saveAgentTranscript,
  synchronizeAgentTranscript,
  type AgentTranscriptExpectation,
  type AgentTranscriptMismatch,
  type AgentTranscriptMismatchReason,
} from "./agent-transcript.ts";

export interface ReseedMessagesResult {
  messages: AgentMessage[];
  source_messages: number;
  dropped_messages: number;
  truncated: boolean;
}

export interface SessionReseedResult extends ReseedMessagesResult {
  reseed_id: string;
  saved: boolean;
}

/**
 * The fresh-start contract: a plain start carries NO prior context — only an
 * explicit resume restores it. A stale agent.json from an earlier run would
 * otherwise be silently rejoined by the live agent (hash match → 895 restored
 * messages on what the operator meant as a new task). This archives it aside
 * to agent.json.prev (recoverable, never destroyed) and records the decision
 * on the log; the live agent then finds no transcript and starts clean. A
 * second fresh start with nothing to archive must not clobber the archive.
 */
export function freshStartArchive(input: {
  log: EventLog;
  transcriptPath: string;
}): { archived: boolean; messages: number } {
  synchronizeAgentTranscript(input.log, input.transcriptPath);
  const stored = readAgentTranscriptFile(input.transcriptPath);
  const previous = liveProviderState(input.log);
  const previousHead = previous.ref ? inputReference(input.log.events.at(-1)!) : undefined;
  const messages = stored?.messages.length ?? 0;
  let archived = false;
  if (stored && existsSync(input.transcriptPath)) {
    renameSync(input.transcriptPath, `${input.transcriptPath}.prev`);
    archived = true;
  }
  input.log.append({
    kind: "observe",
    name: "session/fresh_start",
    payload: {
      archived_messages: messages,
      ...(archived ? { archive: "agent.json.prev" } : {}),
      ...(archived && previousHead ? { provider_previous_head: previousHead } : {}),
    },
  });
  if (liveProviderState(input.log).ref) replaceProviderMessages(input.log, [], "session/fresh_start");
  return { archived, messages };
}

/**
 * Bytes per token for sizing the reseed byte budget. English BPE runs ~4
 * bytes/token, but Korean/mixed markup ran ~2.3 live and a byte budget built
 * on 4 let a 131k-token cap decode to 158k tokens — the exact overshoot the
 * operator hit. Sizing on the CJK/mixed floor (2.3, rounded down) keeps a
 * reseed under the token cap for any content; the tradeoff is keeping slightly
 * less English history, and the EventLog holds everything the bound drops.
 */
export const RESEED_BYTES_PER_TOKEN = 2.3;

/**
 * Restore a fresh-start archive so resume carries the real prior conversation,
 * not a reconstruction of the whole (multi-run, cross-task) log. When a plain
 * start archived agent.json to agent.json.prev, an explicit resume should pick
 * that clean transcript back up rather than reseeding the polluted log. Only
 * restores when the live transcript is absent — an existing agent.json is
 * never overwritten. Returns true when it restored the archive.
 */
export function restoreArchivedTranscript(transcriptPath: string, log?: EventLog): boolean {
  const archivePath = `${transcriptPath}.prev`;
  if (existsSync(transcriptPath)) return false;
  let archivedMessages: unknown[] | undefined;
  let sourceHead: { seq: number; hash: string } | undefined;
  if (log) {
    const current = liveProviderState(log);
    if (current.ref && current.messages.length > 0) return false;
    const archived = [...log.events].reverse().find(event => event.name === "session/fresh_start" && event.payload.archive === "agent.json.prev");
    if (current.ref && !archived) return false;
    if (current.ref || archived?.payload.provider_previous_head) {
      const head = archived?.payload.provider_previous_head as { seq: number; hash: string } | undefined;
      requireProviderInput(head && log.events.some(event => event.seq === head.seq && event.hash === head.hash), "archive has no recorded history boundary");
      const state = recordedProviderState(log, log.events.filter(event => event.seq <= head.seq));
      const cache = readAgentTranscriptFile(archivePath);
      requireProviderInput(state.ref && !state.pending && (!existsSync(archivePath)
        || (cache && inputDigest(cache.messages) === inputDigest(state.messages))), "archived cache differs from recorded history");
      archivedMessages = state.messages;
      sourceHead = head;
    }
  }
  if (!archivedMessages && !existsSync(archivePath)) return false;
  try {
    if (existsSync(archivePath)) renameSync(archivePath, transcriptPath);
    if (log && archivedMessages) replaceProviderMessages(log, archivedMessages, "session/resume_archive", { source_head: sourceHead });
    if (log && archivedMessages) synchronizeAgentTranscript(log, transcriptPath);
    return true;
  } catch {
    return false;
  }
}

export function sessionReseedMaxBytes(
  systemPrompt: string,
  toolSchemas: readonly unknown[],
  contextWindow: number,
): number {
  const prefixBytes = Buffer.byteLength(systemPrompt) + Buffer.byteLength(JSON.stringify(toolSchemas));
  // Advertised windows are unverified: a reseed sized to an advertised-1M
  // model rebuilt the exact ~350k payload whose invalid_request the operator
  // was escaping (2,140/2,140 messages kept, next request failed
  // identically). Land reseeds under the same caution line as manual
  // handoffs; the EventLog keeps everything the bound drops.
  const window = Math.min(contextWindow, HANDOFF_CAUTION_TOKENS);
  return Math.max(1_024, Math.floor(window * RESEED_BYTES_PER_TOKEN * 0.7) - prefixBytes);
}

/** Record explicit reseed authority before replacing the private transcript. */
export function reseedAgentTranscript(input: {
  log: EventLog;
  transcriptPath: string;
  expectation: AgentTranscriptExpectation;
  maxBytes: number;
  reason: AgentTranscriptMismatchReason | "operator_requested";
  mismatches?: readonly AgentTranscriptMismatch[];
}): SessionReseedResult {
  const reseed = buildReseedMessages(input.log.events, { maxBytes: input.maxBytes });
  const reseedId = randomUUID();
  input.log.append({
    kind: "effect",
    name: "session/reseed",
    payload: {
      reseed_id: reseedId,
      reason: input.reason,
      ...(input.mismatches ? { mismatches: input.mismatches } : {}),
      source_messages: reseed.source_messages,
      kept_messages: reseed.messages.length,
      dropped_messages: reseed.dropped_messages,
      truncated: reseed.truncated,
      target_prefix_hash: input.expectation.prefix_hash,
    },
  });
  replaceProviderMessages(input.log, reseed.messages, "session/reseed", { reseed_id: reseedId,
    max_bytes: input.maxBytes, metadata: input.expectation });
  let saved = false;
  try {
    saved = reseed.messages.length > 0 && saveAgentTranscript(input.transcriptPath, {
      ...input.expectation,
      messages: reseed.messages,
    });
  } catch {
    saved = false;
  }
  input.log.append({
    kind: "observe",
    name: "session/reseed_result",
    payload: { reseed_id: reseedId, status: saved ? "saved" : "failed" },
  });
  return { ...reseed, reseed_id: reseedId, saved };
}

/**
 * Rebuild safe, provider-neutral history under a new frozen prefix.
 *
 * EventLog tool surfaces are deliberately represented as labeled user text;
 * they are evidence, not reconstructed provider tool-call/result pairs.
 */
export function buildReseedMessages(
  events: readonly EventRecord[],
  options: { maxBytes: number },
): ReseedMessagesResult {
  const source = deriveMessages(events);
  const candidates = source.map((message) => ({
    role: "user",
    content: [{
      type: "text",
      // A host-context frame (#227) is labelled as such, never as a prior
      // operator line.
      text: `[prior ${message.name === "context" ? "host context" : message.role}${message.role === "tool" ? `:${message.name}` : ""}] ${message.text}`,
    }],
  } as AgentMessage));
  const kept: AgentMessage[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const next = [candidates[index]!, ...kept];
    if (Buffer.byteLength(JSON.stringify(next)) <= options.maxBytes) {
      kept.unshift(candidates[index]!);
      continue;
    }
    if (kept.length > 0) break;
    const candidate = candidates[index]! as { role: "user"; content: Array<{ type: "text"; text: string }> };
    const original = candidate.content[0]!.text;
    const suffix = "\n[prior surface truncated by host]";
    let low = 0;
    let high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const value = [{ ...candidate, content: [{ type: "text", text: `${original.slice(0, middle)}${suffix}` }] }];
      if (Buffer.byteLength(JSON.stringify(value)) <= options.maxBytes) low = middle;
      else high = middle - 1;
    }
    const value = { ...candidate, content: [{ type: "text", text: `${original.slice(0, low)}${suffix}` }] } as AgentMessage;
    if (Buffer.byteLength(JSON.stringify([value])) <= options.maxBytes) kept.push(value);
    break;
  }
  return {
    messages: kept,
    source_messages: source.length,
    dropped_messages: source.length - kept.length,
    truncated: kept.length < source.length,
  };
}

/** Reconstruct the ignored live work-plan file from append-only graph facts.
 * The effect precedes the write, and an invalid historical graph fails closed. */
export function restoreWorkGraph(
  log: EventLog,
  workspaceRoot: string,
): "existing" | "restored" | "missing" {
  // A model-loop session has no work graph: the plan file is graph-loop
  // state, and resurrecting it here would pull stage policy back into a loop
  // that left it behind. The work/loop event seals the loop identity at boot.
  if (log.events.some((event) => event.name === "work/loop" && event.payload.loop === "model")) return "missing";
  const path = currentPlanPath(workspaceRoot);
  if (existsSync(path)) return "existing";
  const plan = readPlanFromLog(log.events);
  if (!plan) return "missing";
  const restoreId = randomUUID();
  log.append({
    kind: "effect",
    name: "session/work_restore",
    payload: { restore_id: restoreId, source: "event-log", todos: plan.todos.length, cases: plan.cases.length },
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeWorkPlan(path, plan);
    log.append({ kind: "observe", name: "session/work_restore_result", payload: { restore_id: restoreId, status: "restored" } });
    return "restored";
  } catch {
    log.append({ kind: "observe", name: "session/work_restore_result", payload: { restore_id: restoreId, status: "failed" } });
    return "missing";
  }
}
