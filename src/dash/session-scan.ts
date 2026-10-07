import { existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../host/event-log.ts";
import type { ModelUsage } from "../host/schema.ts";
import type { SwarmChildStatus } from "../swarm/events.ts";
import {
  projectSwarmReferences,
  type SwarmParentBindingReference,
} from "../swarm/reference-validation.ts";
import { isSwarmRole } from "../swarm/routes.ts";
import type { SessionRelation } from "./session-tree.ts";

export interface SessionRow {
  id: string;
  events: number;
  bytes: number;
  lastTs: number;
  status: string;
  goal: string;
  contextUsed: number | "missing";
  contextWindow: number | "missing";
  compactions: number;
  turns: number;
  inSum: number | "missing";
  outSum: number | "missing";
  lastError: string | undefined;
  finalized?: boolean;
  patchDigest?: string;
}

/** One route/model's accounting inside one session, folded while scanning.
 * Compact on purpose: the scan cache retains these for every session, so the
 * shape stays proportional to models, not to requests. */
export interface SessionModelRollup {
  session: string;
  route: string;
  model: string;
  requests: number;
  okRequests: number;
  inputSum: number;
  inputSeen: boolean;
  outputSum: number;
  outputSeen: boolean;
  reasoningSum: number;
  reasoningSeen: boolean;
  cacheReadSum: number;
  cacheReadSeen: boolean;
  cacheWriteSum: number;
  cacheWriteSeen: boolean;
  hitRatioSum: number;
  hitRatioSeen: number;
  failures: Record<string, number>;
  /** UTC YYYY-MM-DD → that day's requests and tokens. */
  days: Record<string, { requests: number; input: number; output: number }>;
  lastTs: number;
  lastStatus: string | undefined;
}

export interface SessionIndex {
  rows: SessionRow[];
  relations: SessionRelation[];
  parentBindings: SwarmParentBindingReference[];
  rollups: SessionModelRollup[];
}

interface CacheEntry {
  stamp: string;
  row: SessionRow;
  relations: SessionRelation[];
  parentBindings: SwarmParentBindingReference[];
  rollups: SessionModelRollup[];
}

const cache = new Map<string, CacheEntry>();

function emptyRow(id: string, bytes = 0): SessionRow {
  return {
    id,
    events: 0,
    bytes,
    lastTs: 0,
    status: "missing",
    goal: "",
    contextUsed: "missing",
    contextWindow: "missing",
    compactions: 0,
    turns: 0,
    inSum: "missing",
    outSum: "missing",
    lastError: undefined,
  };
}

function isChildStatus(value: unknown): value is SwarmChildStatus {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "timeout";
}

function relationOpen(id: string, seq: number, payload: Record<string, unknown>): SessionRelation | undefined {
  const parentId = payload.parent_session;
  const childId = payload.child_session;
  const role = payload.role;
  const route = payload.route;
  if (parentId !== id || typeof childId !== "string" || typeof role !== "string" || !isSwarmRole(role) ||
    typeof route !== "string") {
    return undefined;
  }
  return { parentId, childId, role, route, openSeq: seq };
}

function acceptanceRelations(id: string, seq: number, payload: Record<string, unknown>): SessionRelation[] {
  if (payload.action !== "accept") return [];
  const route = typeof payload.route === "string" ? payload.route : "inherited";
  const pairs = [
    [payload.spec_session, "accept-spec"],
    [payload.verifier_session, "accept"],
  ] as const;
  return pairs.flatMap(([childId, role]) => typeof childId === "string"
    ? [{ parentId: id, childId, role, route, openSeq: seq }]
    : []);
}

function foldSessionModelUsage(
  rollups: Map<string, SessionModelRollup>,
  session: string,
  usage: ModelUsage,
  at: number,
): void {
  const key = `${usage.route}/${usage.model}`;
  let entry = rollups.get(key);
  if (!entry) {
    entry = {
      session,
      route: usage.route,
      model: usage.model,
      requests: 0,
      okRequests: 0,
      inputSum: 0,
      inputSeen: false,
      outputSum: 0,
      outputSeen: false,
      reasoningSum: 0,
      reasoningSeen: false,
      cacheReadSum: 0,
      cacheReadSeen: false,
      cacheWriteSum: 0,
      cacheWriteSeen: false,
      hitRatioSum: 0,
      hitRatioSeen: 0,
      failures: {},
      days: {},
      lastTs: at,
      lastStatus: undefined,
    };
    rollups.set(key, entry);
  }
  entry.requests += 1;
  if (typeof usage.status === "string") {
    entry.failures[usage.status] = (entry.failures[usage.status] ?? 0) + 1;
  } else {
    entry.okRequests += 1;
  }
  const add = (value: number | "missing", sum: "inputSum" | "outputSum" | "reasoningSum" | "cacheReadSum" | "cacheWriteSum", seen: "inputSeen" | "outputSeen" | "reasoningSeen" | "cacheReadSeen" | "cacheWriteSeen"): void => {
    if (typeof value !== "number") return;
    entry![sum] += value;
    entry![seen] = true;
  };
  add(usage.input_tokens, "inputSum", "inputSeen");
  add(usage.output_tokens, "outputSum", "outputSeen");
  add(usage.reasoning_tokens, "reasoningSum", "reasoningSeen");
  add(usage.cache_read_tokens, "cacheReadSum", "cacheReadSeen");
  add(usage.cache_write_tokens, "cacheWriteSum", "cacheWriteSeen");
  if (typeof usage.hit_ratio === "number") {
    entry.hitRatioSum += usage.hit_ratio;
    entry.hitRatioSeen += 1;
  }
  if (at >= entry.lastTs) {
    entry.lastTs = at;
    entry.lastStatus = typeof usage.status === "string" ? usage.status : undefined;
  }
  if (at > 0) {
    const day = new Date(at).toISOString().slice(0, 10);
    const bucket = entry.days[day] ?? (entry.days[day] = { requests: 0, input: 0, output: 0 });
    bucket.requests += 1;
    if (typeof usage.input_tokens === "number") bucket.input += usage.input_tokens;
    if (typeof usage.output_tokens === "number") bucket.output += usage.output_tokens;
  }
}

function scanSession(id: string, logPath: string, stats: Stats): CacheEntry {
  const row = emptyRow(id, stats.size);
  const relations = new Map<string, SessionRelation>();
  const rollups = new Map<string, SessionModelRollup>();
  let inSeen = false;
  let outSeen = false;
  let inSum = 0;
  let outSum = 0;
  let lastUsageSeq = -1;
  let reliefSeq = -1;
  let reliefTokens: number | undefined;
  let events;
  try {
    events = new EventLog(logPath, { readOnly: true }).events;
  } catch {
    row.status = "corrupt";
    row.lastError = "invalid EventLog";
    return { stamp: `${stats.size}:${stats.mtimeMs}`, row, relations: [], parentBindings: [], rollups: [] };
  }
  for (const event of events) {
    row.events += 1;
    const at = Date.parse(event.ts);
    if (!Number.isNaN(at)) row.lastTs = Math.max(row.lastTs, at);
    if (event.name === "model/usage") lastUsageSeq = event.seq;
    if (event.name === "compaction/drop" && event.payload.in_turn !== true) {
      reliefSeq = event.seq;
      reliefTokens = typeof event.payload.kept_tokens === "number" ? event.payload.kept_tokens : reliefTokens;
      row.compactions += 1;
    }
    if (event.name === "agent/status" && typeof event.payload.status === "string") {
      row.status = event.payload.status;
      row.lastError = typeof event.payload.error === "string" ? event.payload.error : undefined;
    }
    if (event.name === "work/goal" && typeof event.payload.statement === "string") row.goal = event.payload.statement;
    if (event.name === "agent/step" && event.payload.phase === "turn_start") row.turns += 1;
    if (event.name === "swarm/child_open") {
      const relation = relationOpen(id, event.seq, event.payload);
      if (relation && !relations.has(relation.childId)) relations.set(relation.childId, relation);
    }
    if (event.name === "work/step") {
      for (const relation of acceptanceRelations(id, event.seq, event.payload)) {
        if (!relations.has(relation.childId)) relations.set(relation.childId, relation);
      }
    }
    if (event.name === "work/accept") {
      for (const [sessionKey, digestKey] of [
        ["spec_session", "spec_digest"],
        ["verifier_session", "verifier_digest"],
      ] as const) {
        const childId = event.payload[sessionKey];
        const relation = typeof childId === "string" ? relations.get(childId) : undefined;
        if (relation && relation.status === undefined) {
          relation.status = "completed";
          relation.replayDigest = typeof event.payload[digestKey] === "string"
            ? event.payload[digestKey]
            : undefined;
        }
      }
    }
    if (event.name === "swarm/child_close" && typeof event.payload.child_session === "string") {
      const relation = relations.get(event.payload.child_session);
      if (relation && isChildStatus(event.payload.status) && relation.status === undefined) {
        relation.status = event.payload.status;
        relation.replayDigest = typeof event.payload.replay_digest === "string" ? event.payload.replay_digest : undefined;
      } else if (relation?.status !== undefined) {
        relation.relationError = "duplicate_close";
      }
    }
    if (event.name === "swarm/finalized") {
      row.finalized = true;
      row.patchDigest = typeof event.payload.patch_digest === "string" ? event.payload.patch_digest : undefined;
    }
    const usage = event.observe?.model_usage;
    if (usage) {
      if (typeof usage.context_used === "number") row.contextUsed = usage.context_used;
      if (typeof usage.context_window === "number") row.contextWindow = usage.context_window;
      if (typeof usage.input_tokens === "number") { inSum += usage.input_tokens; inSeen = true; }
      if (typeof usage.output_tokens === "number") { outSum += usage.output_tokens; outSeen = true; }
      if (typeof usage.route === "string" && typeof usage.model === "string" && usage.route && usage.model) {
        foldSessionModelUsage(rollups, id, usage, Number.isNaN(at) ? 0 : at);
      }
    }
  }
  if (inSeen) row.inSum = inSum;
  if (outSeen) row.outSum = outSum;
  if (reliefSeq > lastUsageSeq && reliefTokens !== undefined) row.contextUsed = reliefTokens;
  let parentBindings: SwarmParentBindingReference[] = [];
  try {
    const references = projectSwarmReferences(events);
    parentBindings = references.parentBindings;
    for (const reference of references.dispatches) {
      const relation = relations.get(reference.child_session);
      if (relation) relation.dispatchDigest = reference.contract_digest;
    }
    for (const reference of references.results) {
      const relation = relations.get(reference.child_session);
      if (relation) {
        relation.resultEnvelopeDigest = reference.envelope_digest;
        relation.resultIntegrity = "ok";
      }
    }
  } catch {
    for (const event of events) {
      if (event.name === "swarm/dispatch" && typeof event.payload.child_session === "string") {
        const relation = relations.get(event.payload.child_session);
        if (relation) relation.contractIntegrity = "mismatch";
      }
      if (event.name === "swarm/result" && typeof event.payload.child_session === "string") {
        const relation = relations.get(event.payload.child_session);
        if (relation) relation.resultIntegrity = "mismatch";
      }
    }
  }
  return { stamp: `${stats.size}:${stats.mtimeMs}`, row, relations: [...relations.values()], parentBindings, rollups: [...rollups.values()] };
}

export function listSessionIndex(sessionsRoot: string): SessionIndex {
  if (!existsSync(sessionsRoot)) return { rows: [], relations: [], parentBindings: [], rollups: [] };
  const rows: SessionRow[] = [];
  const relations: SessionRelation[] = [];
  const parentBindings: SwarmParentBindingReference[] = [];
  const rollups: SessionModelRollup[] = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const logPath = join(sessionsRoot, entry.name, "events.jsonl");
    let stats: Stats | undefined;
    try { stats = statSync(logPath); } catch { stats = undefined; }
    if (!stats) {
      rows.push(emptyRow(entry.name));
      continue;
    }
    const stamp = `${stats.size}:${stats.mtimeMs}`;
    let result = cache.get(logPath);
    if (!result || result.stamp !== stamp) {
      result = scanSession(entry.name, logPath, stats);
      cache.set(logPath, result);
    }
    rows.push(result.row);
    relations.push(...result.relations.map((relation) => ({ ...relation })));
    parentBindings.push(...result.parentBindings);
    rollups.push(...result.rollups.map((rollup) => ({ ...rollup, days: { ...rollup.days } })));
  }
  for (const relation of relations) {
    if (relation.contractIntegrity !== "mismatch") {
      if (!relation.dispatchDigest) {
        relation.contractIntegrity = "missing";
      } else {
        const bindings = parentBindings.filter((binding) => binding.child_session === relation.childId);
        relation.contractIntegrity = bindings.length === 0
          ? "missing"
          : bindings.length === 1 && bindings[0]!.parent_session === relation.parentId &&
              bindings[0]!.parent_open_seq === relation.openSeq &&
              bindings[0]!.contract_digest === relation.dispatchDigest
            ? "ok"
            : "mismatch";
      }
    }
    relation.resultIntegrity ??= relation.resultEnvelopeDigest ? "ok" : "missing";
  }
  rows.sort((a, b) => b.lastTs - a.lastTs || a.id.localeCompare(b.id));
  return { rows, relations, parentBindings, rollups };
}

export function listSessions(sessionsRoot: string): SessionRow[] {
  return listSessionIndex(sessionsRoot).rows;
}
