import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ALL_WIDGETS, type Widget, type WidgetId, type WidgetSlot } from "./widgets.ts";

/**
 * Operator layout overrides.
 *
 * `planLayout` already answers "where does everything go" as data
 * (D-2026-08-20-12), but only ever produced it. This is the other direction:
 * a small file that says which panes an operator wants, in what order, and on
 * which side — so a placement change is editing data rather than code.
 *
 * It is deliberately small. Rows still come from what a widget can fill
 * (`flex.ts`), because a hand-written height is stale the moment the content
 * changes. What an operator genuinely knows is *what they care about*, and
 * that is order, visibility and side.
 *
 * A broken file never takes the board down: it is a convenience, and the
 * board is how a run is watched.
 */

export interface LayoutConfig {
  /** Panes first, most important first. Unnamed panes keep their order after. */
  order?: WidgetId[];
  /** Panes to leave off entirely. */
  hidden?: WidgetId[];
  /** Move a pane to another column group. */
  slots?: Partial<Record<WidgetId, WidgetSlot>>;
  /** Force a column count instead of deriving it from the width. */
  columns?: number;
}

const KNOWN = new Set<string>(ALL_WIDGETS.map((widget) => widget.id));
const SLOTS = new Set<string>(["band", "side", "main", "aux"]);

export function layoutConfigPath(env: NodeJS.Dict<string> = process.env): string {
  const home = env.DOKKABI_HOME ?? join(env.HOME ?? "", ".dokkabi");
  return join(home, "layout.json");
}

export function readLayoutConfig(env: NodeJS.Dict<string> = process.env): LayoutConfig {
  try {
    return parseLayoutConfig(readFileSync(layoutConfigPath(env), "utf8"));
  } catch {
    // Missing, unreadable or malformed: the board runs on its own layout.
    return {};
  }
}

/** The exact bytes `/layout save` puts on disk — stable so a saved file is
 * diffable and the roundtrip contract is testable. */
export function serializeLayout(config: LayoutConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Persist overrides atomically: a crash mid-write must never leave the
 * operator's layout file half-written, because the board reads it on every
 * start. */
export function saveLayoutConfig(path: string, config: LayoutConfig): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeLayout(config));
  renameSync(tmp, path);
}

/** Hot-reload decision (#dokkabi-dev#49): reload exactly when a fresh mtime
 * exists and differs from the cached one. Equal means the file was touched
 * without changing; undefined means there is nothing to stat yet. */
export function reloadNeeded(cached: number | undefined, fresh: number | undefined): boolean {
  return fresh !== undefined && fresh !== cached;
}

export function parseLayoutConfig(text: string): LayoutConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`layout.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("layout.json must be an object");
  }
  const input = raw as Record<string, unknown>;
  const config: LayoutConfig = {};
  if (input.order !== undefined) {
    config.order = paneList(input.order, "order");
  }
  if (input.hidden !== undefined) {
    config.hidden = paneList(input.hidden, "hidden");
  }
  if (input.slots !== undefined) {
    if (typeof input.slots !== "object" || input.slots === null || Array.isArray(input.slots)) {
      throw new Error("layout.json: slots must be an object of pane → band|side|main|aux");
    }
    const slots: Partial<Record<WidgetId, WidgetSlot>> = {};
    for (const [pane, slot] of Object.entries(input.slots as Record<string, unknown>)) {
      if (!KNOWN.has(pane)) {
        throw new Error(`layout.json: no pane called "${pane}"`);
      }
      if (typeof slot !== "string" || !SLOTS.has(slot)) {
        throw new Error(`layout.json: slot for "${pane}" must be band, side, main or aux`);
      }
      slots[pane as WidgetId] = slot as WidgetSlot;
    }
    config.slots = slots;
  }
  if (input.columns !== undefined) {
    const columns = input.columns;
    if (typeof columns !== "number" || !Number.isInteger(columns) || columns < 1 || columns > 4) {
      throw new Error("layout.json: columns must be a whole number from 1 to 4");
    }
    config.columns = columns;
  }
  return config;
}

function paneList(value: unknown, field: string): WidgetId[] {
  if (!Array.isArray(value)) {
    throw new Error(`layout.json: ${field} must be a list of pane names`);
  }
  return value.map((pane) => {
    if (typeof pane !== "string" || !KNOWN.has(pane)) {
      throw new Error(`layout.json: no pane called "${String(pane)}" in ${field}`);
    }
    return pane as WidgetId;
  });
}

/**
 * Apply a config to the widget set.
 *
 * Order is not only position: priority decides which panes survive a short
 * board, so a pane the operator put first is also the last one dropped.
 * Widgets are copied, never mutated — a config must not leak into the next
 * board or into another test.
 */
export function applyLayoutConfig(widgets: readonly Widget[], config: LayoutConfig): Widget[] {
  const hidden = new Set(config.hidden ?? []);
  const kept = widgets.filter((widget) => !hidden.has(widget.id));
  if (kept.length === 0) {
    throw new Error("layout.json hides every pane; the board would be empty");
  }
  const order = config.order ?? [];
  const rank = new Map<WidgetId, number>();
  order.forEach((pane, index) => rank.set(pane, index));
  const sorted = [...kept].sort((a, b) => {
    const left = rank.get(a.id);
    const right = rank.get(b.id);
    if (left !== undefined && right !== undefined) {
      return left - right;
    }
    // Named panes come first; the rest keep the board's own order.
    if (left !== undefined) {
      return -1;
    }
    if (right !== undefined) {
      return 1;
    }
    return widgets.indexOf(a) - widgets.indexOf(b);
  });
  return sorted.map((widget, index) => {
    const slot = config.slots?.[widget.id];
    const named = rank.has(widget.id);
    return {
      ...widget,
      ...(slot ? { slot } : {}),
      // Named panes take the front of the priority range so they outlive the
      // rest when rows run short; unnamed ones keep their relative standing.
      priority: named ? index : widget.priority + order.length,
    };
  });
}
