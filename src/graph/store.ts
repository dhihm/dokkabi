import type { EventLog } from "../host/event-log.ts";
import { currentSessionSchemaPayload, projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import { emptyGraphState, prepareGraphMutation, projectGraphState,
  type GraphEdge, type GraphEdgeKind, type GraphMutation, type GraphNode } from "./state-evidence.ts";
export type { GraphNodeKind, GraphEdgeKind, GraphNode, GraphEdge, GraphMutation } from "./state-evidence.ts";

export interface AppliedMutation { prev: number; next: number; deltaDigest: string }

/** The live graph publishes only states whose full typed mutation is durable. */
export class GraphStore {
  private state = emptyGraphState();
  private nodesById = new Map<string, GraphNode>();
  private lastGraphHash: string | undefined;
  get rev(): number { return this.state.rev; }
  get nodes(): GraphNode[] { return this.state.nodes.map(node => ({ ...node })); }
  get edges(): GraphEdge[] { return this.state.edges.map(edge => ({ ...edge })); }
  hasNode(id: string): boolean { return this.nodesById.has(id); }
  fileNode(relativePath: string): GraphNode | undefined {
    const node = this.nodesById.get(relativePath);
    return node ? { ...node } : undefined;
  }

  applyMutation(log: EventLog, mutation: GraphMutation): AppliedMutation {
    const prepared = prepareGraphMutation(this.state, mutation);
    const records = log.appendBatchDurable(() => {
      // Validate under the writer lock, after EventLog refreshes its durable
      // head. Another store cannot silently overwrite a newer graph revision.
      const latest = [...log.events].reverse().find(event => event.name === "graph/apply");
      if (latest?.hash !== this.lastGraphHash) throw new Error("graph mutation refused: stale store");
      const activation = projectSessionReplaySchemas(log.events).featureStart.has("graph-state-v1") ? []
        : [{ kind: "observe" as const, name: "session/open", payload: currentSessionSchemaPayload() }];
      return [...activation, { kind: "observe", name: "graph/apply", payload: prepared.payload }];
    });
    this.state = prepared.state;
    this.nodesById = new Map(this.state.nodes.map(node => [node.id, node]));
    this.lastGraphHash = records.at(-1)!.hash;
    return { prev: prepared.payload.prev, next: prepared.payload.next, deltaDigest: prepared.payload.delta_digest };
  }

  static fromEvents(events: readonly EventRecord[]): GraphStore {
    const store = new GraphStore();
    store.state = projectGraphState(events).state;
    store.nodesById = new Map(store.state.nodes.map(node => [node.id, node]));
    store.lastGraphHash = [...events].reverse().find(event => event.name === "graph/apply")?.hash;
    return store;
  }

  neighbors(id: string, kinds?: GraphEdgeKind[]): { out: string[]; in: string[] } {
    const allow = kinds ? new Set(kinds) : undefined;
    const out: string[] = [], incoming: string[] = [];
    for (const edge of this.state.edges) {
      if (edge.from === id && (!allow || allow.has(edge.kind))) out.push(edge.to);
      if (edge.to === id && (!allow || allow.has(edge.kind))) incoming.push(edge.from);
    }
    return { out, in: incoming };
  }
}
