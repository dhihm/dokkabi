import { describe, expect, it } from "vite-plus/test";
import {
  layoutGraph,
  stabilizeLayout,
  edgeAnchors,
  edgeLaneAnchor,
  type GraphLayoutOptions,
} from "./graphLayout";

const geometry: GraphLayoutOptions = {
  direction: "LR",
  nodeWidth: 224,
  nodeHeight: 88,
  rankGap: 64,
  siblingGap: 24,
  canvasPadding: 24,
};
const chain = {
  mode: "work" as const,
  nodes: [
    { id: "goal", kind: "goal" },
    { id: "todo", kind: "todo" },
    { id: "case", kind: "case" },
  ],
  edges: [
    { from: "goal", to: "todo" },
    { from: "todo", to: "case" },
  ],
};

describe("independent graph layout acceptance", () => {
  it("LR places the recorded source before its dependent target", () => {
    const result = layoutGraph(chain, geometry);
    expect(result.positions.get("goal")!.x).toBeLessThan(result.positions.get("todo")!.x);
    expect(result.positions.get("todo")!.x).toBeLessThan(result.positions.get("case")!.x);
  });
  it("TB places the recorded source above its dependent target", () => {
    const result = layoutGraph(chain, { ...geometry, direction: "TB" });
    expect(result.positions.get("goal")!.y).toBeLessThan(result.positions.get("todo")!.y);
    expect(result.positions.get("todo")!.y).toBeLessThan(result.positions.get("case")!.y);
  });
  it("SCC condensation keeps every actual member visible without overlapping", () => {
    const nodes = ["attempt", "lesson", "retry", "observation"].map((id) => ({
      id,
      kind: "attempt",
    }));
    const result = layoutGraph(
      {
        mode: "context",
        nodes,
        edges: [
          { from: "attempt", to: "lesson" },
          { from: "lesson", to: "retry" },
          { from: "retry", to: "attempt" },
          { from: "retry", to: "observation" },
        ],
      },
      geometry,
    );
    expect(result.positions.size).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) {
      const a = result.positions.get(nodes[i]!.id)!;
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      expect(a.x + geometry.nodeWidth).toBeLessThanOrEqual(result.width);
      expect(a.y + geometry.nodeHeight).toBeLessThanOrEqual(result.height);
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = result.positions.get(nodes[j]!.id)!;
        const separate =
          a.x + geometry.nodeWidth <= b.x ||
          b.x + geometry.nodeWidth <= a.x ||
          a.y + geometry.nodeHeight <= b.y ||
          b.y + geometry.nodeHeight <= a.y;
        expect(separate).toBe(true);
      }
    }
  });
});

describe("independent changing-topology view preferences", () => {
  it("keeps surviving positions when an earlier-sorting node arrives and resets on reflow", () => {
    const before = layoutGraph(
      { mode: "context", nodes: [{ id: "z", kind: "lesson" }], edges: [] },
      geometry,
    );
    const fresh = layoutGraph(
      {
        mode: "context",
        nodes: [
          { id: "a", kind: "lesson" },
          { id: "z", kind: "lesson" },
        ],
        edges: [],
      },
      geometry,
    );
    const stable = stabilizeLayout({
      fresh,
      previous: before.positions,
      reset: false,
      options: geometry,
    });
    expect(stable.positions.get("z")).toEqual(before.positions.get("z"));
    const a = stable.positions.get("a")!;
    const z = stable.positions.get("z")!;
    expect(
      a.x + geometry.nodeWidth <= z.x ||
        z.x + geometry.nodeWidth <= a.x ||
        a.y + geometry.nodeHeight <= z.y ||
        z.y + geometry.nodeHeight <= a.y,
    ).toBe(true);
    expect(a.x + geometry.nodeWidth).toBeLessThanOrEqual(stable.width);
    expect(a.y + geometry.nodeHeight).toBeLessThanOrEqual(stable.height);
    const reset = stabilizeLayout({
      fresh,
      previous: stable.positions,
      reset: true,
      options: geometry,
    });
    expect(reset.positions).toEqual(fresh.positions);
  });
  it("gives separate lanes to ordering and artifact flow over the same endpoints", () => {
    const layout = layoutGraph(chain, geometry);
    const base = edgeAnchors(
      layout.positions.get("goal")!,
      layout.positions.get("todo")!,
      geometry,
    );
    const ordering = edgeLaneAnchor(base, 0, 2, 8);
    const artifact = edgeLaneAnchor(base, 1, 2, 8);
    expect(ordering).not.toEqual(artifact);
    expect(Object.values(ordering).every(Number.isFinite)).toBe(true);
    expect(Object.values(artifact).every(Number.isFinite)).toBe(true);
  });
});
