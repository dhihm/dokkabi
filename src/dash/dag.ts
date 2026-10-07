import dagre from "dagre";
import { statusMark } from "./status.ts";
import { visibleWidth } from "./screen.ts";
import type { Todo } from "../work/schema.ts";

const NODE_H = 4;
const MIN_NODE_W = 16;
const MAX_NODE_W = 34;
const RANK_SEP = 3;
const NODE_SEP = 1;

export interface DagFallback {
  reason: "too_many_ranks";
  ranks: number;
  lines: string[];
}

/**
 * Layered DAG render. Node positions come from dagre (Sugiyama layout, the
 * same engine Mermaid uses); only the cell rendering is ours. Left to right,
 * one box per todo, `[state] id` plus title, `>` arrowheads on every edge.
 * When the layered graph cannot fit the given width, returns a compact list
 * instead of a truncated mess — zoom the pane (tmux prefix + z) for the graph.
 */
export function renderTodoDag(
  todos: readonly Todo[],
  state: Record<string, string>,
  cols: number,
): string[] | DagFallback {
  if (todos.length === 0 || cols < 12) {
    return [];
  }
  const ids = new Set(todos.map((todo) => todo.id));
  const ordered = [...todos].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const labels = new Map<string, { head: string; title: string; w: number }>();
  for (const todo of ordered) {
    const head = `${statusMark(state[todo.id] ?? "ready").glyph} ${todo.id}`;
    const title = clip(todo.title, MAX_NODE_W - 2);
    labels.set(todo.id, { head, title, w: 0 });
  }
  const ranks = countRanks(ordered, ids);
  const fit = layoutFit(ordered, labels, cols, ranks);
  // Vertical flow whenever horizontal boxes would clip labels: layers stack
  // top to bottom and each node takes the full pane width.
  const direction = ranks >= 4 || fit.affordable < fit.wanted ? "TB" : "LR";
  const nodeW = nodeWidth(direction, fit, cols);
  if (nodeW === undefined) {
    return compactFallback(ordered, state, ranks, cols);
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: direction, nodesep: NODE_SEP, edgesep: NODE_SEP, ranksep: RANK_SEP, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const todo of ordered) {
    graph.setNode(todo.id, { width: nodeW, height: NODE_H });
  }
  for (const todo of ordered) {
    for (const blocker of todo.blocked_by) {
      if (ids.has(blocker) && blocker !== todo.id) {
        graph.setEdge(blocker, todo.id);
      }
    }
  }
  dagre.layout(graph);

  const placed = ordered.map((todo) => {
    const at = graph.node(todo.id) as { x: number; y: number };
    return {
      id: todo.id,
      x: Math.round(at.x - nodeW / 2),
      y: Math.round(at.y - NODE_H / 2),
    };
  });
  const width = Math.max(...placed.map((node) => node.x)) + nodeW;
  const height = Math.max(...placed.map((node) => node.y)) + NODE_H;
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const topLeft = new Map(placed.map((node) => [node.id, node]));

  for (const todo of ordered) {
    for (const blocker of todo.blocked_by) {
      const src = topLeft.get(blocker);
      const dest = topLeft.get(todo.id);
      if (!src || !dest || src === dest) {
        continue;
      }
      if (direction === "TB") {
        drawEdgeDown(grid, src.x + Math.floor(nodeW / 2), src.y + NODE_H - 1, dest.x + Math.floor(nodeW / 2), dest.y);
      } else {
        drawEdge(grid, src.x + nodeW - 1, src.y + 1, dest.x, dest.y + 1);
      }
    }
  }
  for (const todo of ordered) {
    const at = topLeft.get(todo.id);
    if (!at) {
      continue;
    }
    drawNode(grid, at.x, at.y, nodeW, labels.get(todo.id)!.head, labels.get(todo.id)!.title);
  }

  return grid.map((row) => row.join("").replace(/\s+$/g, ""));
}

function layoutFit(
  ordered: readonly Todo[],
  labels: Map<string, { head: string; title: string; w: number }>,
  cols: number,
  ranks: number,
): { content: number; wanted: number; affordable: number } {
  let content = MIN_NODE_W - 2;
  for (const todo of ordered) {
    const label = labels.get(todo.id)!;
    label.w = Math.max(visibleWidth(label.head), visibleWidth(label.title));
    content = Math.max(content, label.w);
  }
  return {
    content,
    wanted: Math.min(MAX_NODE_W, content + 2),
    affordable: Math.floor((cols + RANK_SEP) / Math.max(1, ranks)) - RANK_SEP,
  };
}

function nodeWidth(
  direction: "LR" | "TB",
  fit: { content: number; wanted: number; affordable: number },
  cols: number,
): number | undefined {
  if (direction === "TB") {
    // Vertical flow uses the full pane width before falling back.
    const wanted = Math.min(cols, fit.content + 2);
    return wanted > cols || wanted < MIN_NODE_W ? undefined : wanted;
  }
  if (fit.affordable < MIN_NODE_W) {
    return undefined;
  }
  return Math.max(MIN_NODE_W, Math.min(fit.wanted, fit.affordable));
}

function countRanks(todos: readonly Todo[], ids: Set<string>): number {
  const rank = new Map<string, number>();
  const walking = new Set<string>();
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const visit = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (walking.has(id)) {
      return 0;
    }
    walking.add(id);
    const blockers = (byId.get(id)?.blocked_by ?? []).filter((item) => ids.has(item));
    const next = blockers.length === 0 ? 0 : 1 + Math.max(...blockers.map(visit));
    walking.delete(id);
    rank.set(id, next);
    return next;
  };
  let max = 0;
  for (const todo of todos) {
    max = Math.max(max, visit(todo.id));
  }
  return max + 1;
}

function compactFallback(
  ordered: readonly Todo[],
  state: Record<string, string>,
  ranks: number,
  cols: number,
): DagFallback {
  const lines = [
    `graph does not fit: ${ranks} ranks need ~${ranks * MIN_NODE_W + (ranks - 1) * RANK_SEP} cols, pane has ${cols}`,
    "zoom this pane (tmux prefix + z) to draw the layered graph",
    "",
  ];
  for (const todo of ordered) {
    const blockers = todo.blocked_by.length > 0 ? `  <- ${todo.blocked_by.join(", ")}` : "";
    lines.push(`${statusMark(state[todo.id] ?? "ready").glyph} ${todo.id} — ${clip(todo.title, cols - 24)}${blockers}`);
  }
  return { reason: "too_many_ranks", ranks, lines };
}

function clip(text: string, max: number): string {
  if (max <= 1) {
    return "";
  }
  return visibleWidth(text) <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function drawNode(
  grid: string[][],
  x: number,
  y: number,
  w: number,
  head: string,
  title: string,
): void {
  const last = x + w - 1;
  put(grid, x, y, "┌");
  put(grid, last, y, "┐");
  put(grid, x, y + NODE_H - 1, "└");
  put(grid, last, y + NODE_H - 1, "┘");
  for (let row = y + 1; row < y + NODE_H - 1; row += 1) {
    put(grid, x, row, "│");
    put(grid, last, row, "│");
  }
  for (let col = x + 1; col < last; col += 1) {
    put(grid, col, y, "─");
    put(grid, col, y + NODE_H - 1, "─");
  }
  write(grid, x + 1, y + 1, last - x - 1, head);
  write(grid, x + 1, y + 2, last - x - 1, title);
}

export function drawEdge(grid: string[][], x0: number, y0: number, x1: number, y1: number): void {
  if (x1 <= x0 + 1) {
    put(grid, Math.max(0, x1), y1, ">");
    return;
  }
  const mid = Math.max(x0 + 1, Math.min(x1 - 1, x0 + Math.max(1, Math.floor((x1 - x0) / 2))));
  for (let x = x0 + 1; x <= mid; x += 1) {
    markH(grid, x, y0);
  }
  if (y1 !== y0) {
    const step = y1 > y0 ? 1 : -1;
    markCorner(grid, mid, y0, y1 > y0 ? "┐" : "┘");
    for (let y = y0 + step; y !== y1; y += step) {
      markV(grid, mid, y);
    }
    markCorner(grid, mid, y1, y1 > y0 ? "└" : "┌");
  }
  for (let x = mid + (y1 === y0 ? 0 : 1); x < x1; x += 1) {
    markH(grid, x, y1);
  }
  put(grid, Math.max(0, x1 - 1), y1, ">");
}

function drawEdgeDown(grid: string[][], x0: number, y0: number, x1: number, y1: number): void {
  if (y1 <= y0 + 1) {
    return;
  }
  const mid = Math.max(y0 + 1, Math.min(y1 - 1, y0 + Math.max(1, Math.floor((y1 - y0) / 2))));
  for (let y = y0 + 1; y <= mid; y += 1) {
    markV(grid, x0, y);
  }
  if (x1 !== x0) {
    const step = x1 > x0 ? 1 : -1;
    markCorner(grid, x0, mid, x1 > x0 ? "└" : "┘");
    for (let x = x0 + step; x !== x1; x += step) {
      markH(grid, x, mid);
    }
    markCorner(grid, x1, mid, x1 > x0 ? "┐" : "┌");
  }
  for (let y = mid + (x1 === x0 ? 0 : 1); y < y1; y += 1) {
    markV(grid, x1, y);
  }
  put(grid, x1, Math.max(0, y1 - 1), "v");
}

function markH(grid: string[][], x: number, y: number): void {
  const prev = get(grid, x, y);
  if (prev === "│" || prev === "┐" || prev === "┘" || prev === "┌" || prev === "└" || prev === "┤" || prev === "├") {
    put(grid, x, y, "┼");
    return;
  }
  if (prev === " " || prev === "─" || prev === ">") {
    put(grid, x, y, "─");
  }
}

function markV(grid: string[][], x: number, y: number): void {
  const prev = get(grid, x, y);
  if (prev === "─" || prev === ">") {
    put(grid, x, y, "┼");
    return;
  }
  if (prev === " " || prev === "│") {
    put(grid, x, y, "│");
  }
}

function markCorner(grid: string[][], x: number, y: number, glyph: string): void {
  const prev = get(grid, x, y);
  if (prev === " " || prev === "─" || prev === "│" || prev === ">") {
    put(grid, x, y, glyph);
  }
}

function write(grid: string[][], x: number, y: number, maxWidth: number, text: string): void {
  let col = 0;
  for (const glyph of text) {
    const width = visibleWidth(glyph);
    if (width <= 0) {
      continue;
    }
    if (col + width > maxWidth) {
      break;
    }
    put(grid, x + col, y, glyph);
    if (width === 2) {
      // A wide glyph already occupies both columns on screen; leave the
      // second grid cell empty so the joined line does not gain a space.
      putEmpty(grid, x + col + 1, y);
    }
    col += width;
  }
}

function putEmpty(grid: string[][], x: number, y: number): void {
  const row = grid[y];
  if (!row || x < 0 || x >= row.length) {
    return;
  }
  row[x] = "";
}

function put(grid: string[][], x: number, y: number, glyph: string): void {
  const row = grid[y];
  if (!row || x < 0 || x >= row.length) {
    return;
  }
  row[x] = glyph;
}

function get(grid: string[][], x: number, y: number): string {
  return grid[y]?.[x] ?? " ";
}
