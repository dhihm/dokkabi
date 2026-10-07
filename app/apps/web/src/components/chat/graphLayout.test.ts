import { describe, expect, it } from "vite-plus/test";
import {
  edgeAnchors,
  edgeLaneAnchor,
  layoutGraph,
  stabilizeLayout,
  type GraphLayoutOptions,
  type GraphNodePosition,
} from "./graphLayout";

/**
 * Pure layout scenarios (docs/internals/dokkabi-graphs-r4.md): finite,
 * non-overlapping, deterministic positions; the recorded source precedes its
 * dependent target; cycles keep every member visible; runtime geometry
 * changes reflow without overlap; polls that add nodes keep old positions.
 */

const geometry: GraphLayoutOptions = {
  direction: "LR",
  nodeWidth: 224,
  nodeHeight: 88,
  rankGap: 64,
  siblingGap: 24,
  canvasPadding: 24,
};

const DAG = {
  mode: "work" as const,
  nodes: [
    { id: "goal", kind: "goal" },
    { id: "todo-a", kind: "todo" },
    { id: "todo-b", kind: "todo" },
    { id: "case-1", kind: "case" },
  ],
  edges: [
    { from: "goal", to: "todo-a" },
    { from: "goal", to: "todo-b" },
    { from: "todo-a", to: "case-1" },
    { from: "todo-b", to: "case-1" },
  ],
};

const expectBoundedAndDisjoint = (
  positions: ReadonlyMap<string, GraphNodePosition>,
  options: GraphLayoutOptions,
  width: number,
  height: number,
): void => {
  const rects = [...positions.values()];
  expect(rects.length).toBeGreaterThan(0);
  for (const position of rects) {
    expect(Number.isFinite(position.x)).toBe(true);
    expect(Number.isFinite(position.y)).toBe(true);
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + options.nodeWidth).toBeLessThanOrEqual(width);
    expect(position.y + options.nodeHeight).toBeLessThanOrEqual(height);
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]!;
      const b = rects[j]!;
      const separate =
        a.x + options.nodeWidth <= b.x ||
        b.x + options.nodeWidth <= a.x ||
        a.y + options.nodeHeight <= b.y ||
        b.y + options.nodeHeight <= a.y;
      expect(separate).toBe(true);
    }
  }
};

describe("graphLayout", () => {
  it("is deterministic: identical input yields identical output", () => {
    const first = layoutGraph(DAG, geometry);
    const second = layoutGraph(DAG, geometry);
    expect([...first.positions.entries()]).toEqual([...second.positions.entries()]);
    expect(first.width).toBe(second.width);
    expect(first.height).toBe(second.height);
  });

  it("places every node in a finite, non-overlapping rectangle inside the extents", () => {
    const result = layoutGraph(DAG, geometry);
    expect(result.positions.size).toBe(DAG.nodes.length);
    expectBoundedAndDisjoint(result.positions, geometry, result.width, result.height);
  });

  it("keeps the recorded source before its dependent target in both directions", () => {
    const lr = layoutGraph(DAG, geometry);
    expect(lr.positions.get("goal")!.x).toBeLessThan(lr.positions.get("todo-a")!.x);
    expect(lr.positions.get("todo-a")!.x).toBeLessThan(lr.positions.get("case-1")!.x);
    const tb = layoutGraph(DAG, { ...geometry, direction: "TB" });
    expect(tb.positions.get("goal")!.y).toBeLessThan(tb.positions.get("todo-a")!.y);
    expect(tb.positions.get("todo-a")!.y).toBeLessThan(tb.positions.get("case-1")!.y);
    // TB measures with its own ruler: the across axis bounds the ranks'
    // widths, the along axis bounds the rank stack.
    expectBoundedAndDisjoint(tb.positions, { ...geometry, direction: "TB" }, tb.width, tb.height);
  });

  it("gives every cycle member its own visible slot in context mode", () => {
    const cycle = {
      mode: "context" as const,
      nodes: ["a", "b", "c", "d"].map((id) => ({ id, kind: "attempt" })),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
        { from: "c", to: "d" },
      ],
    };
    const result = layoutGraph(cycle, geometry);
    expect(result.positions.size).toBe(4);
    expectBoundedAndDisjoint(result.positions, geometry, result.width, result.height);
    // The cycle members share one rank; the downstream node ranks after it.
    const rankOf = (id: string) => result.positions.get(id)!.rank;
    expect(rankOf("a")).toBe(rankOf("b"));
    expect(rankOf("b")).toBe(rankOf("c"));
    expect(rankOf("d")).toBeGreaterThan(rankOf("c"));
  });

  it("applies changed runtime geometry without overlaps", () => {
    const bigger: GraphLayoutOptions = {
      ...geometry,
      direction: "TB",
      nodeWidth: 480,
      nodeHeight: 200,
      rankGap: 240,
      siblingGap: 160,
      canvasPadding: 96,
    };
    const result = layoutGraph(DAG, bigger);
    expectBoundedAndDisjoint(result.positions, bigger, result.width, result.height);
    const previous = layoutGraph(DAG, geometry);
    expect(result.positions.get("goal")!.x).not.toBe(previous.positions.get("goal")!.x);
  });

  it("edgeAnchors leaves and arrives on opposite sides along the flow axis", () => {
    const lr = layoutGraph(DAG, geometry);
    const anchors = edgeAnchors(lr.positions.get("goal")!, lr.positions.get("todo-a")!, geometry);
    expect(anchors.x2).toBeGreaterThanOrEqual(anchors.x1);
    const tb = layoutGraph(DAG, { ...geometry, direction: "TB" });
    const tbAnchors = edgeAnchors(tb.positions.get("goal")!, tb.positions.get("todo-a")!, {
      ...geometry,
      direction: "TB",
    });
    expect(tbAnchors.y2).toBeGreaterThanOrEqual(tbAnchors.y1);
  });

  it("parallel relations sharing endpoints get distinct lanes", () => {
    const from = { x: 0, y: 0, rank: 0, order: 0 };
    const to = { x: 400, y: 0, rank: 1, order: 0 };
    const anchors = edgeAnchors(from, to, geometry);
    const lane0 = edgeLaneAnchor(anchors, 0, 3, 8);
    const lane1 = edgeLaneAnchor(anchors, 1, 3, 8);
    const lane2 = edgeLaneAnchor(anchors, 2, 3, 8);
    // Symmetric perpendicular offsets: outer lanes are equidistant, and no
    // two lanes coincide, so blocked_by/flows never overpaint.
    expect(lane0.y1).toBeLessThan(lane1.y1);
    expect(lane1.y1).toBeLessThan(lane2.y1);
    expect(lane2.y1 - lane1.y1).toBe(lane1.y1 - lane0.y1);
    expect(edgeLaneAnchor(anchors, 0, 1, 8)).toEqual(anchors);
  });
});

describe("stabilizeLayout", () => {
  it("keeps surviving node positions when a poll adds a node", () => {
    const before = layoutGraph(DAG, geometry);
    const withNewNode = layoutGraph(
      {
        ...DAG,
        nodes: [...DAG.nodes, { id: "case-2", kind: "case" }],
        edges: [...DAG.edges, { from: "todo-b", to: "case-2" }],
      },
      geometry,
    );
    const stabilized = stabilizeLayout({
      fresh: withNewNode,
      previous: before.positions,
      reset: false,
      options: geometry,
    });
    for (const node of DAG.nodes) {
      expect(stabilized.positions.get(node.id)).toEqual(before.positions.get(node.id));
    }
    expect(stabilized.positions.has("case-2")).toBe(true);
    expectBoundedAndDisjoint(stabilized.positions, geometry, stabilized.width, stabilized.height);
  });

  it("re-derives every position on reset (geometry change or explicit Reflow)", () => {
    const before = layoutGraph(DAG, geometry);
    const fresh = layoutGraph(DAG, { ...geometry, nodeWidth: 320 });
    const stabilized = stabilizeLayout({
      fresh,
      previous: before.positions,
      reset: true,
      options: { ...geometry, nodeWidth: 320 },
    });
    expect([...stabilized.positions.entries()]).toEqual([...fresh.positions.entries()]);
  });

  it("drops removed nodes while survivors keep their committed slots", () => {
    const before = layoutGraph(DAG, geometry);
    const smaller = layoutGraph(
      { ...DAG, nodes: DAG.nodes.slice(0, 2), edges: DAG.edges.slice(0, 1) },
      geometry,
    );
    const stabilized = stabilizeLayout({
      fresh: smaller,
      previous: before.positions,
      reset: false,
      options: geometry,
    });
    expect(stabilized.positions.size).toBe(2);
    expect(stabilized.positions.get("goal")).toEqual(before.positions.get("goal"));
    expect(stabilized.positions.get("todo-a")).toEqual(before.positions.get("todo-a"));
    expectBoundedAndDisjoint(stabilized.positions, geometry, stabilized.width, stabilized.height);
  });
});
