/**
 * Pure graph layout for the recorded Work/Context panels (Dokkabi R4).
 *
 * Deterministic layered layout: Work ranks derive from the canonical
 * relations (contains/blocked_by/flows over a DAG); Context first condenses
 * strongly connected components so real cycles stay visible while every node
 * in a cycle still gets its own non-overlapping slot. A node's rank is its
 * longest distance FROM a root (no predecessors), so the recorded source of
 * a relation always sits before/above its dependent target in the configured
 * direction. Positions are FINITE, NON-OVERLAPPING view preferences — never
 * execution instructions, never truth. Identical input always yields
 * identical output, so node positions are stable across polls/refreshes.
 */

export interface GraphLayoutNodeInput {
  readonly id: string;
  readonly kind: string;
}

export interface GraphLayoutEdgeInput {
  readonly from: string;
  readonly to: string;
}

export interface GraphLayoutOptions {
  readonly direction: "LR" | "TB";
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly rankGap: number;
  readonly siblingGap: number;
  readonly canvasPadding: number;
}

export interface GraphNodePosition {
  /** Top-left corner in world coordinates (CSS pixels). */
  readonly x: number;
  readonly y: number;
  readonly rank: number;
  /** Slot inside the rank; unique per node, deterministic. */
  readonly order: number;
}

export interface GraphLayoutResult {
  readonly positions: ReadonlyMap<string, GraphNodePosition>;
  readonly width: number;
  readonly height: number;
  /** Edge-less node ids (informational; they still receive positions). */
  readonly isolatedNodeIds: readonly string[];
}

/**
 * Longest distance from any root over a condensation DAG given as a
 * predecessor adjacency. Sources (no predecessors) rank 0; every successor
 * rank grows by one, so `from` ranks strictly below `to` along each edge.
 * The recursion is bounded by the unit count; a cycle that slipped through
 * condensation resolves defensively instead of recursing forever.
 */
function longestDistanceFromRoots(
  unitIds: readonly string[],
  predecessors: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const memo = new Map<string, number>();
  const depth = (id: string, visiting: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const previous of predecessors.get(id) ?? []) {
      best = Math.max(best, depth(previous, visiting) + 1);
    }
    visiting.delete(id);
    memo.set(id, best);
    return best;
  };
  const out = new Map<string, number>();
  for (const id of unitIds) {
    out.set(id, depth(id, new Set()));
  }
  return out;
}

/**
 * Tarjan strongly connected components over the layout graph. Iterative to
 * stay bounded on large inputs; deterministic ordering by input adjacency.
 */
export function stronglyConnectedComponents(
  nodeIds: readonly string[],
  edges: readonly GraphLayoutEdgeInput[],
): string[][] {
  const successors = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (!successors.has(edge.from) || !successors.has(edge.to)) continue;
    successors.get(edge.from)!.push(edge.to);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const root of nodeIds) {
    if (index.has(root)) continue;
    // Iterative Tarjan: explicit frame stack mirrors the recursive calls.
    const frames: Array<{ id: string; nextIndex: number }> = [{ id: root, nextIndex: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const children = successors.get(frame.id) ?? [];
      if (frame.nextIndex < children.length) {
        const child = children[frame.nextIndex]!;
        frame.nextIndex += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          frames.push({ id: child, nextIndex: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(child)!));
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!;
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Deterministic layered positions. `mode: "context"` condenses SCCs first
 * (cycle members share one rank but each keeps a unique adjacent slot — the
 * RELATIONS stay untouched; only positions are affected); `mode: "work"`
 * ranks the DAG directly. Every node receives a finite, non-overlapping
 * rectangle inside the returned world extents.
 */
export function layoutGraph(
  input: {
    readonly nodes: readonly GraphLayoutNodeInput[];
    readonly edges: readonly GraphLayoutEdgeInput[];
    readonly mode: "work" | "context";
  },
  options: GraphLayoutOptions,
): GraphLayoutResult {
  const nodeIds = input.nodes.map((node) => node.id);
  const idSet = new Set(nodeIds);
  const edges = input.edges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to));
  const rankUnits: string[] = [];
  const unitMembers = new Map<string, readonly string[]>();
  const memberUnit = new Map<string, string>();
  if (input.mode === "context") {
    const components = stronglyConnectedComponents(nodeIds, edges).map((component) =>
      [...component].sort(),
    );
    for (const component of components) {
      const unit = component.length === 1 ? component[0]! : `scc:${component.join("+")}`;
      rankUnits.push(unit);
      unitMembers.set(unit, component);
      for (const member of component) memberUnit.set(member, unit);
    }
  } else {
    for (const id of nodeIds) {
      rankUnits.push(id);
      unitMembers.set(id, [id]);
      memberUnit.set(id, id);
    }
  }
  // Condensation adjacency (self edges dropped) in BOTH directions: ranks
  // follow predecessors so sources precede targets.
  const unitSuccessors = new Map<string, string[]>(rankUnits.map((unit) => [unit, []]));
  const unitPredecessors = new Map<string, string[]>(rankUnits.map((unit) => [unit, []]));
  for (const edge of edges) {
    const from = memberUnit.get(edge.from);
    const to = memberUnit.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    unitSuccessors.get(from)!.push(to);
    unitPredecessors.get(to)!.push(from);
  }
  const unitRanks = longestDistanceFromRoots(rankUnits, unitPredecessors);
  // Deterministic ordering: by (rank, unit id); a barycenter pass would also
  // be deterministic but the sorted order is the stable minimum.
  const orderedUnits = [...rankUnits].sort(
    (left, right) =>
      (unitRanks.get(left) ?? 0) - (unitRanks.get(right) ?? 0) || left.localeCompare(right),
  );
  // Rank slots are per MEMBER, not per unit: an SCC's members sit adjacent in
  // one rank, each with its own slot, so cycles stay grouped without overlap.
  const positions = new Map<string, GraphNodePosition>();
  const membersByRank = new Map<number, string[]>();
  for (const unit of orderedUnits) {
    const rank = unitRanks.get(unit) ?? 0;
    const list = membersByRank.get(rank) ?? [];
    list.push(...unitMembers.get(unit)!);
    membersByRank.set(rank, list);
  }
  let maxRank = 0;
  let maxPerRank = 0;
  for (const [rank, members] of membersByRank) {
    maxRank = Math.max(maxRank, rank);
    maxPerRank = Math.max(maxPerRank, members.length);
    members.forEach((member, orderInRank) => {
      positions.set(member, { x: 0, y: 0, rank, order: orderInRank });
    });
  }
  // Coordinate assignment along the configured direction. LR advances ranks
  // across x; TB advances ranks down y. Both axes stay finite for any
  // finite options and node count.
  const horizontal = options.direction === "LR";
  const alongStep = (horizontal ? options.nodeWidth : options.nodeHeight) + options.rankGap;
  const acrossStep = (horizontal ? options.nodeHeight : options.nodeWidth) + options.siblingGap;
  for (const [id, position] of positions) {
    const along = options.canvasPadding + position.rank * alongStep;
    const across = options.canvasPadding + position.order * acrossStep;
    positions.set(
      id,
      horizontal ? { ...position, x: along, y: across } : { ...position, x: across, y: along },
    );
  }
  // World extent per axis: ranks own the along axis, member slots own the
  // across axis — computed per direction so TB is not measured with LR's
  // ruler (an overlap-free canvas must bound the axis each direction fills).
  const rankAxisExtent =
    (maxRank + 1) * (horizontal ? options.nodeWidth : options.nodeHeight) +
    maxRank * options.rankGap;
  const memberAxisExtent =
    maxPerRank * (horizontal ? options.nodeHeight : options.nodeWidth) +
    Math.max(0, maxPerRank - 1) * options.siblingGap;
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const isolatedNodeIds = nodeIds.filter((id) => !connected.has(id)).sort();
  const width = options.canvasPadding * 2 + (horizontal ? rankAxisExtent : memberAxisExtent);
  const height = options.canvasPadding * 2 + (horizontal ? memberAxisExtent : rankAxisExtent);
  return {
    positions,
    width,
    height,
    isolatedNodeIds,
  };
}

/** World-space anchor points for an edge between two node rectangles. */
export function edgeAnchors(
  from: GraphNodePosition,
  to: GraphNodePosition,
  options: GraphLayoutOptions,
): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } {
  const horizontal = options.direction === "LR";
  const fromCenterX = from.x + options.nodeWidth / 2;
  const fromCenterY = from.y + options.nodeHeight / 2;
  const toCenterX = to.x + options.nodeWidth / 2;
  const toCenterY = to.y + options.nodeHeight / 2;
  if (horizontal) {
    // Leave from the right side, arrive at the left side; same-rank/back
    // edges (cycles) route around via the bottom/top sides so both anchors
    // stay visible.
    if (to.x >= from.x + options.nodeWidth) {
      return { x1: from.x + options.nodeWidth, y1: fromCenterY, x2: to.x, y2: toCenterY };
    }
    return { x1: fromCenterX, y1: from.y + options.nodeHeight, x2: toCenterX, y2: to.y };
  }
  if (to.y >= from.y + options.nodeHeight) {
    return { x1: fromCenterX, y1: from.y + options.nodeHeight, x2: toCenterX, y2: to.y };
  }
  return { x1: from.x + options.nodeWidth, y1: fromCenterY, x2: to.x, y2: toCenterY };
}

/**
 * Perpendicular lane offset for one edge among all edges sharing its
 * endpoint pair: parallel relations (for example blocked_by and flows over
 * the same nodes) stay visibly distinct instead of overpainting. The middle
 * lane (offset 0) is the plain anchor line.
 */
export function edgeLaneAnchor(
  anchors: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  lane: number,
  laneCount: number,
  spacing: number,
): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } {
  if (laneCount <= 1) return anchors;
  const dx = anchors.x2 - anchors.x1;
  const dy = anchors.y2 - anchors.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0 || !Number.isFinite(length)) return anchors;
  // Unit perpendicular, scaled by the edge's symmetric lane offset.
  const offset = (lane - (laneCount - 1) / 2) * spacing;
  const px = (-dy / length) * offset;
  const py = (dx / length) * offset;
  return {
    x1: anchors.x1 + px,
    y1: anchors.y1 + py,
    x2: anchors.x2 + px,
    y2: anchors.y2 + py,
  };
}

const rectanglesOverlap = (
  a: GraphNodePosition,
  b: GraphNodePosition,
  options: GraphLayoutOptions,
): boolean =>
  a.x < b.x + options.nodeWidth &&
  b.x < a.x + options.nodeWidth &&
  a.y < b.y + options.nodeHeight &&
  b.y < a.y + options.nodeHeight;

/**
 * Poll-stable positions over a changed topology: surviving nodes keep their
 * previously committed positions (view preference), and nodes new to this
 * poll take their fresh deterministic slots, nudged along the across axis
 * until free of every placed rectangle — so a poll that adds records never
 * reshuffles the canvas the operator is reading. `reset` discards the
 * previous positions (geometry change or an explicit Reflow): everything is
 * re-derived from the pure layered layout. Pure and deterministic: same
 * inputs, same output; camera/selection are untouched here.
 */
export function stabilizeLayout(input: {
  readonly fresh: GraphLayoutResult;
  readonly previous: ReadonlyMap<string, GraphNodePosition>;
  readonly reset: boolean;
  readonly options: GraphLayoutOptions;
}): GraphLayoutResult {
  const { fresh, previous, reset, options } = input;
  const positions = new Map<string, GraphNodePosition>();
  if (!reset) {
    for (const id of fresh.positions.keys()) {
      const kept = previous.get(id);
      if (kept !== undefined) positions.set(id, kept);
    }
  }
  const acrossStep =
    (options.direction === "LR" ? options.nodeHeight : options.nodeWidth) + options.siblingGap;
  const nudgeBound = fresh.positions.size + previous.size + 1;
  const placed = [...positions.values()];
  for (const [id, freshPosition] of fresh.positions) {
    if (positions.has(id)) continue;
    let candidate = freshPosition;
    let nudges = 0;
    while (
      nudges < nudgeBound &&
      placed.some((entry) => rectanglesOverlap(entry, candidate, options))
    ) {
      candidate =
        options.direction === "LR"
          ? { ...candidate, order: candidate.order + 1, y: candidate.y + acrossStep }
          : { ...candidate, order: candidate.order + 1, x: candidate.x + acrossStep };
      nudges += 1;
    }
    positions.set(id, candidate);
    placed.push(candidate);
  }
  // Extents bound every FINAL rectangle (kept and nudged), plus padding.
  let maxWidth = 0;
  let maxHeight = 0;
  for (const position of positions.values()) {
    maxWidth = Math.max(maxWidth, position.x + options.nodeWidth);
    maxHeight = Math.max(maxHeight, position.y + options.nodeHeight);
  }
  return {
    positions,
    width: options.canvasPadding + maxWidth,
    height: options.canvasPadding + maxHeight,
    isolatedNodeIds: fresh.isolatedNodeIds,
  };
}
