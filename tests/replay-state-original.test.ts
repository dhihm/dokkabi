import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/host/event-log.ts";
import { GraphStore, type GraphNode } from "../src/graph/store.ts";
import { replayContract, replayDigest } from "../src/host/replay.ts";

const root = mkdtempSync(join(tmpdir(), "dokkabi-replay-original-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const logFor = (name: string) => EventLog.create(join(root, name, "events.jsonl"));

test("original: graph roundtrip retains full typed nodes and structured edges", () => {
  const log = logFor("roundtrip"), store = new GraphStore();
  store.applyMutation(log, {
    add: [
      { id: "opaque", kind: "symbol", file: "src/a.ts", digest: "abc" },
      { id: "b-imports->c", kind: "gate", file: "tests/check.ts", digest: "" },
    ],
    edges: [{ from: "opaque", to: "b-imports->c", kind: "tested_by" }],
  });
  const rebuilt = GraphStore.fromEvents(log.events);
  expect({ nodes: rebuilt.nodes, edges: rebuilt.edges, rev: rebuilt.rev })
    .toEqual({ nodes: store.nodes, edges: store.edges, rev: store.rev });
});

test("original: refused durable append leaves the live graph unchanged", () => {
  const log = logFor("refusal"), store = new GraphStore();
  store.applyMutation(log, { add: [{ id: "a", kind: "file" }] });
  const before = { nodes: store.nodes, edges: store.edges, rev: store.rev };
  const reader = new EventLog(log.path, { readOnly: true });
  expect(() => store.applyMutation(reader, { remove: ["a"], add: [{ id: "b", kind: "test" }] })).toThrow();
  expect({ nodes: store.nodes, edges: store.edges, rev: store.rev }).toEqual(before);
});

test("original: graph cannot be mutated through input or getter aliases", () => {
  const log = logFor("aliases"), store = new GraphStore();
  const node: GraphNode = { id: "a", kind: "file", digest: "original" };
  store.applyMutation(log, { add: [node], edges: [{ from: "a", to: "a", kind: "calls" }] });
  node.digest = "caller-change";
  store.nodes[0]!.file = "getter-change";
  store.fileNode("a")!.kind = "test";
  store.edges[0]!.to = "other";
  expect(store.nodes).toEqual([{ id: "a", kind: "file", digest: "original" }]);
  expect(store.edges).toEqual([{ from: "a", to: "a", kind: "calls" }]);
});

test("original: equal graph revisions do not hide changed graph content from checkpoints", () => {
  const first = logFor("first"), second = logFor("second");
  new GraphStore().applyMutation(first, { add: [{ id: "opaque", kind: "symbol", file: "src/a.ts", digest: "a" }] });
  new GraphStore().applyMutation(second, { add: [{ id: "opaque", kind: "symbol", file: "src/b.ts", digest: "b" }] });
  expect(replayDigest(replayContract(second.events))).not.toBe(replayDigest(replayContract(first.events)));
});
