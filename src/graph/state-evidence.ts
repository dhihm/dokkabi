import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../host/canonical.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";

const nodeKind = z.enum(["symbol", "file", "test", "gate", "claim", "goal", "todo", "scenario", "case"]);
const edgeKind = z.enum(["calls", "imports", "tested_by", "writes", "observed_at", "decomposes", "blocked_by", "specifies", "verifies", "covers"]);
const nodeSchema = z.strictObject({ kind: nodeKind, id: z.string(), file: z.string().optional(), digest: z.string().optional() });
const edgeSchema = z.strictObject({ kind: edgeKind, from: z.string(), to: z.string() });
const mutationSchema = z.strictObject({ add: z.array(nodeSchema).optional(), remove: z.array(z.string()).optional(), edges: z.array(edgeSchema).optional(), dropEdges: z.array(edgeSchema).optional() });
export type GraphNodeKind = z.infer<typeof nodeKind>;
export type GraphEdgeKind = z.infer<typeof edgeKind>;
export type GraphNode = z.infer<typeof nodeSchema>;
export type GraphEdge = z.infer<typeof edgeSchema>;
export type GraphMutation = z.infer<typeof mutationSchema>;
export interface GraphState { rev: number; nodes: GraphNode[]; edges: GraphEdge[] }
export const emptyGraphState = (): GraphState => ({ rev: 0, nodes: [], edges: [] });
export const graphStateDigest = (state: GraphState): string => hash(canonicalJson(state));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const edgeKey = (edge: GraphEdge): string => canonicalJson([edge.from, edge.kind, edge.to]);

/** Keep mutation array order: repeated IDs use the last value, and graph query
 * tie ordering follows insertion order. Neither order can be sorted away. */
export function prepareGraphMutation(state: GraphState, input: GraphMutation) {
  const mutation = mutationSchema.parse(input);
  const next = apply(state, mutation);
  const payload = { state_schema: 1, prev: state.rev, next: next.rev, rev: next.rev,
    mutation, mutation_digest: hash(canonicalJson(mutation)),
    before_digest: graphStateDigest(state), state_digest: graphStateDigest(next),
    ...legacyMutationProjection(mutation) };
  return { state: next, payload };
}
function apply(state: GraphState, mutation: GraphMutation): GraphState {
  const nodes = new Map(state.nodes.map(node => [node.id, { ...node }]));
  for (const id of mutation.remove ?? []) nodes.delete(id);
  for (const node of mutation.add ?? []) nodes.set(node.id, { ...node });
  const dropped = new Set((mutation.dropEdges ?? []).map(edgeKey));
  const edges = new Map(state.edges.filter(edge => !dropped.has(edgeKey(edge))).map(edge => [edgeKey(edge), { ...edge }]));
  for (const edge of mutation.edges ?? []) if (!edges.has(edgeKey(edge))) edges.set(edgeKey(edge), { ...edge });
  return { rev: state.rev + 1, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Compatibility fields retain their historical encoding and digest. The new
 * typed mutation is authoritative; replay checks the sparse projection too. */
export function legacyMutationProjection(mutation: GraphMutation) {
  return {
    delta_digest: hash(JSON.stringify([
      (mutation.add ?? []).map(node => [node.kind, node.id, node.file ?? "", node.digest ?? ""]).sort(),
      (mutation.remove ?? []).slice().sort(),
      (mutation.edges ?? []).map(edge => [edge.from, edge.kind, edge.to]).sort(),
      (mutation.dropEdges ?? []).map(edge => [edge.from, edge.kind, edge.to]).sort(),
    ])).slice(0, 16),
    added_nodes: (mutation.add ?? []).map(node => ({ id: node.id, digest: node.digest ?? null })),
    removed_nodes: mutation.remove ?? [],
    added_edges: (mutation.edges ?? []).map(edge => `${edge.from}-${edge.kind}->${edge.to}`),
    dropped_edges: (mutation.dropEdges ?? []).map(edge => `${edge.from}-${edge.kind}->${edge.to}`),
  };
}

export function projectGraphState(events: readonly EventRecord[]) {
  const start = projectSessionReplaySchemas(events).featureStart.get("graph-state-v1");
  let state = emptyGraphState();
  const mutations: { seq: number; prev: number; next: number; mutation_digest: string; before_digest: string; state_digest: string }[] = [];
  const unsupported: number[] = [];
  for (const event of events) {
    if (event.name !== "graph/apply") continue;
    const modern = start !== undefined && event.seq > start;
    const p = event.payload;
    if (!modern) {
      if (["state_schema", "mutation", "mutation_digest", "before_digest", "state_digest"].some(key => key in p)) throw new Error("graph state evidence precedes its feature generation");
      state = legacyApply(state, p); unsupported.push(event.seq); continue;
    }
    if (event.kind !== "observe" || p.state_schema !== 1 || !p.mutation) throw new Error(`graph state evidence missing at ${event.seq}`);
    const prepared = prepareGraphMutation(state, p.mutation as GraphMutation);
    for (const [key, expected] of Object.entries(prepared.payload)) {
      if (canonicalJson(p[key]) !== canonicalJson(expected)) throw new Error(`graph ${key} mismatch at ${event.seq}`);
    }
    state = prepared.state;
    mutations.push({ seq: event.seq, prev: p.prev as number, next: p.next as number,
      mutation_digest: p.mutation_digest as string, before_digest: p.before_digest as string, state_digest: p.state_digest as string });
  }
  return { state, mutations, unsupported };
}

/** Historical sparse rows cannot recover kinds/files or ambiguous edge IDs.
 * Preserve that historical behavior but explicitly exclude it from coverage. */
function legacyApply(state: GraphState, p: Record<string, unknown>): GraphState {
  const array = (raw: unknown): unknown[] => Array.isArray(raw) ? raw : [];
  const edges = (raw: unknown): GraphEdge[] => array(raw).flatMap(value => {
    const match = typeof value === "string" ? /^(.+)-([a-z_]+)->(.+)$/.exec(value) : null;
    return match ? [{ kind: match[2] as GraphEdgeKind, from: match[1]!, to: match[3]! }] : [];
  });
  const add = array(p.added_nodes).flatMap(raw => {
    const entry = typeof raw === "string" ? { id: raw } : raw as { id?: unknown; digest?: unknown } | null;
    if (!entry || typeof entry.id !== "string") return [];
    const id = entry.id;
    const kind: GraphNodeKind = id.startsWith("sym:") ? "symbol" : id.startsWith("goal-") ? "goal"
      : id.startsWith("todo-") ? "todo" : id.startsWith("scn-") ? "scenario" : id.startsWith("case-") ? "case"
      : id.startsWith("tests/") || id.endsWith(".test.ts") ? "test" : "file";
    return [{ kind, id, ...(typeof entry.digest === "string" && entry.digest ? { digest: entry.digest } : {}) }];
  });
  const next = apply(state, { add, remove: array(p.removed_nodes).filter((id): id is string => typeof id === "string"), edges: edges(p.added_edges), dropEdges: edges(p.dropped_edges) });
  next.rev = Math.max(state.rev, typeof p.next === "number" ? p.next : state.rev + 1);
  return next;
}
