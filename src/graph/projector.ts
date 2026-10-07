import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import { GraphStore, type GraphEdgeKind } from "./store.ts";

export type AllowedQuery =
  | { name: "impact"; args: { symbol: string } }
  | { name: "path"; args: { a: string; b: string } }
  | { name: "owners"; args: { file: string } }
  | { name: "tests"; args: { symbol: string } }
  | { name: "ready"; args?: Record<string, never> }
  | { name: "red"; args?: Record<string, never> }
  | { name: "missing_scenarios"; args: { todo: string } };

export interface QueryResult {
  query: string;
  resultDigest: string;
  ids: string[];
  graphRev: number;
}

const QUERY_NAMES = new Set(["impact", "path", "owners", "tests", "ready", "red", "missing_scenarios"]);

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * The Projector answers only the allowed queries and returns digest + top-k
 * ids — never file bodies. Same query at the same graph rev with the same
 * digest creates no new event: only new facts append, so the prefix cache
 * survives (docs/graph.md).
 */
export function projectQuery(input: {
  log: EventLog;
  store: GraphStore;
  query: AllowedQuery;
  topK?: number;
}): QueryResult {
  const name = input.query.name;
  if (!QUERY_NAMES.has(name)) {
    throw new Error(`query ${name} is not allowed; use impact, path, owners, tests, ready, red, missing_scenarios`);
  }
  const ids = answer(input.store, input.query).slice(0, input.topK ?? 20);
  const resultDigest = hash16(`${name}\0${JSON.stringify(input.query.args ?? {})}\0${ids.join(",")}\0${input.store.rev}`);
  const key = `${name}\0${JSON.stringify(input.query.args ?? {})}`;
  const last = lastQueryEvent(input.log.events, key);
  if (!last || last.payload.result_digest !== resultDigest) {
    input.log.append({
      kind: "observe",
      name: "graph/query",
      payload: {
        query: key,
        graph_rev: input.store.rev,
        result_digest: resultDigest,
        ids,
      },
    });
  }
  return { query: key, resultDigest, ids, graphRev: input.store.rev };
}

function answer(store: GraphStore, query: AllowedQuery): string[] {
  if (query.name === "impact") {
    const symbol = query.args.symbol;
    const { out, in: incoming } = store.neighbors(symbol);
    const tests = out.filter((id) => id.includes(".test."));
    const files = new Set<string>();
    for (const id of [...out, ...incoming]) {
      if (!id.startsWith("sym:")) {
        files.add(id);
      }
    }
    return [...new Set([symbol, ...tests, ...files])];
  }
  if (query.name === "tests") {
    return store.neighbors(query.args.symbol, ["tested_by"]).out;
  }
  if (query.name === "owners") {
    // First provider: the file's importers own its changes.
    return store.neighbors(query.args.file, ["imports"]).in;
  }
  if (query.name === "path") {
    return shortestPath(store, query.args.a, query.args.b);
  }
  if (query.name === "ready" || query.name === "red" || query.name === "missing_scenarios") {
    // Work-graph queries need the plan; the projector derives them from node
    // kinds + blocked_by edges the provider sealed.
    if (query.name === "ready") {
      return todoIds(store).filter((id) => store.neighbors(id, ["blocked_by"]).out.length === 0);
    }
    if (query.name === "red") {
      return store.nodes.filter((node) => node.kind === "case" && node.digest === "red").map((node) => node.id);
    }
    return todoIds(store).filter((id) => store.neighbors(id, ["specifies"]).out.length === 0);
  }
  return [];
}

function todoIds(store: GraphStore): string[] {
  return store.nodes.filter((node) => node.kind === "todo").map((node) => node.id);
}

function shortestPath(store: GraphStore, a: string, b: string): string[] {
  const prev = new Map<string, string>();
  const queue = [a];
  const seen = new Set([a]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === b) {
      const path = [b];
      let at = b;
      while (at !== a) {
        const parent = prev.get(at);
        if (parent === undefined) {
          return [];
        }
        path.unshift(parent);
        at = parent;
      }
      return path;
    }
    for (const next of store.neighbors(current).out) {
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, current);
        queue.push(next);
      }
    }
  }
  return [];
}

function lastQueryEvent(
  events: readonly { name: string; payload: Record<string, unknown> }[],
  key: string,
): { payload: Record<string, unknown> } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name === "graph/query" && event.payload.query === key) {
      return { payload: event.payload };
    }
  }
  return undefined;
}

export type { GraphEdgeKind };
