import { experimentDashboardLines } from "./experiment.ts";
import { researchDashboardLines } from "./research.ts";
import { activityBadge, contextLayerBar, headerModelLines, hostBarLine, knowledgeLine, modelBarLine, pluginLine, remoteLine, statusTone, toolsBarLine } from "./cells.ts";
import { speculationDisplay } from "./speculation.ts";
import { completeSlash, isSlash, type SlashEnv } from "./commands.ts";
import { applyLayoutConfig, type LayoutConfig } from "./layout-config.ts";
import { distribute, splitColumns, type Demand, type FlexItem } from "./flex.ts";
import { clip, ellipsize, fmtAge, padTo } from "./glyphs.ts";
import type { DashProjection } from "./project.ts";
import { pickerMatches } from "./keymap.ts";
import { charWidth, Screen, visibleWidth, wrapText, type Tone } from "./screen.ts";
import { layerOf, type LayoutFrame, type Rect, type Region } from "./layout-frame.ts";
import { ALL_WIDGETS, widgetById, type Widget, type WidgetCtx, type WidgetId, type WidgetLine } from "./widgets.ts";
import { alertStrip } from "./graphs.ts";
import { matchCursor } from "./search-cursor.ts";
import { toolDetailLines, toolKey } from "./tool-detail.ts";
import { currentActivity, currentActivityText } from "./activity.ts";
import { pendingOperatorApproval, type PendingOperatorApproval, approvalEventsOf } from "./operator-approval.ts";
import { permissionModeFromEvents } from "../host/permissions.ts";

export interface BoardMeta {
  path: string;
  replay: boolean;
  url?: string;
  color?: boolean;
  cols: number;
  rows: number;
  /** d key: the accounting panes (TOKENS, CONTEXT) are promoted from
   * "shown when rows are spare" to "shown regardless". */
  debug?: boolean;
  /** Focused widget. Its border is lit and the scroll keys drive it. */
  focus?: WidgetId;
  /** z key: the focused widget takes the whole body. A pane name is the
   * pre-redesign form and still works: it focuses that pane and zooms it. */
  zoom?: boolean | "work" | "stream" | "tools";
  /** i key: the operator is typing; the draft owns the footer row. */
  inputDraft?: string;
  /** Live candidates (routes, sessions, effort, accounts) for slash argument
   * completion, so the suggestion box shows what Tab would complete. */
  slashEnv?: SlashEnv;
  /** Reverse history search is open: the prompt row shows the needle and
   * the note it currently points at. */
  histSearch?: { needle: string; at?: number; miss?: boolean; preview?: string };
  /** Per-pane line filters from `/filter` (#48). */
  filters?: Partial<Record<WidgetId, string>>;
  /** Search match cursor per pane (#51). */
  matchIdx?: Partial<Record<WidgetId, number>>;
  /** The expanded TOOLS failure row, keyed `name:seq` (#51). */
  expandedTool?: string;
  /** `/` key: live search. Matching lines light up in every pane. */
  query?: string;
  /** Search entry is open; the footer shows the query being typed. */
  searching?: boolean;
  /** Rows scrolled back from the tail, per widget. */
  scroll?: Partial<Record<WidgetId, number>>;
  /** ? key: the key map covers the body. */
  help?: boolean;
  /** Injected clock so a frame is reproducible under test and replay. */
  now?: number;
  /** Session name for a log opened by path, where the log itself carries no
   * session event to project one from. */
  sessionLabel?: string;
  /** Notes written but not yet drained by the loop. Constitution 6: a queued
   * note is a real state of the world, so it belongs on the board. */
  pendingNotes?: number;
  /** Notes already owned by the current turn but not yet acknowledged. */
  inFlightNotes?: number;
  /** Why the last note could not be written, if it could not. */
  noteError?: string;
  /** Result of the last slash command that could not be carried out. */
  notice?: string;
  /** When the notice was raised (epoch ms) and how long it stays. A notice
   * older than its TTL is not painted — a `copied` toast clears after 10s, an
   * ordinary notice after 30s — so transient chrome stops lingering. */
  noticeAt?: number;
  noticeTtl?: number;
  /** `/notices` overlay is open; the entries render over the body. */
  noticesView?: boolean;
  /** Newest last — the ring as the keymap recorded it. */
  notices?: readonly { text: string; at: number }[];
  /** Caret position within the draft, in code points. */
  inputCursor?: number;
  /** A typed picker is open; provider credentials use the same prompt but
   * stay memory-only and are masked before this renderer sees the draft. */
  picker?: "route" | "effort" | "login" | "logout" | "auth-input";
  pickerCandidates?: readonly string[];
  pickerSummaries?: Readonly<Record<string, string>>;
  pickerDetails?: readonly import("./keymap.ts").ModelPickerCandidate[];
  pickerRoute?: string;
  pickerAt?: number;
  pickerPrompt?: string;
  /** Highlighted completion index for a slash draft — the list below the
   * prompt becomes navigable with the same marker the picker uses. */
  slashAt?: number;
  inputSecret?: boolean;
  /** Operator layout overrides (layout-config.ts). */
  layout?: LayoutConfig;
  /** Live interactive boards interrupt ordinary input for pending authority. */
  permissionPrompt?: boolean;
  /** A large-carry model switch waiting on carry/slim/cancel. */
  handoffPrompt?: import("./handoff-prompt.ts").HandoffConfirmation;
  /** Application-owned drag selection to highlight (0-based screen cells). */
  selection?: { ax: number; ay: number; hx: number; hy: number; active: boolean };
}

/**
 * Header legends, longest first. The board picks the longest that still fits
 * after the age field has taken its room, so a wide terminal names every key
 * and a narrow one still says where the key map lives.
 */
const KEY_HINTS = [
  "q quit  ? keys  tab pane  z zoom  / find  i input  d debug",
  "? keys  tab pane  / find  i input  q quit",
  "? keys  q quit",
  "? keys",
] as const;
const KEY_HINT = KEY_HINTS[0];

/** The key map, also the source of the overlay's height. */
const HELP_KEYS: readonly (readonly [string, string])[] = [
  ["type anything", "compose a note; Enter sends it to the work loop"],
  ["/", "list commands — /zoom alerts, /find qdp, /keys, /quit"],
  ["Tab", "complete a command, or move focus between panes"],
  ["Ctrl+C", "quit"],
  ["↑ / ↓", "recall submitted notes; Down past newest restores the draft"],
  ["wheel", "scroll MODEL STREAM without changing input history"],
  ["Alt+↑ / Alt+↓ · PgUp / PgDn", "scroll the focused pane"],
  ["← / →", "move the caret; Ctrl+A / Ctrl+E jump to the ends"],
  ["Ctrl+P / Ctrl+N", "same history cursor as ↑ / ↓"],
  ["Esc", "clear the draft, then zoom, search and focus"],
  ["Ctrl+U / Ctrl+W", "kill to line start / delete the word before the caret"],
  ["drag", "select, copy on release · /mouse off: native drag"],
];

/**
 * The operator board.
 *
 * Geometry is content-driven (`flex.ts`) rather than ratio-driven: widgets
 * declare what they can fill and the engine hands out exactly that, so the
 * board gets denser as the terminal gets bigger instead of emptier. Chrome is
 * two rows top (identity + model) and one row bottom (keys / input / search).
 */
export function renderDashScreen(view: DashProjection, input: BoardMeta): string {
  const meta = normalizeZoom(input);
  const frame = planLayout(view, meta);
  const screen = new Screen(frame.cols, frame.rows);
  paintFrame(screen, frame, view, meta, meta.now ?? Date.now());
  applySelection(screen, meta.selection);
  return screen.render(meta.color === true);
}

/** Highlight the dragged range, terminal-style row-major between its ends. */
function applySelection(screen: Screen, selection: BoardMeta["selection"]): void {
  if (!selection) return;
  for (const [x, y] of selectionCells(screen.cols, selection)) {
    screen.retone(x, y, "match");
  }
}

function selectionCells(
  cols: number,
  selection: NonNullable<BoardMeta["selection"]>,
): [number, number][] {
  const start = selection.ay < selection.hy || (selection.ay === selection.hy && selection.ax <= selection.hx)
    ? { x: selection.ax, y: selection.ay }
    : { x: selection.hx, y: selection.hy };
  const end = start.x === selection.ax && start.y === selection.ay
    ? { x: selection.hx, y: selection.hy }
    : { x: selection.ax, y: selection.ay };
  const out: [number, number][] = [];
  for (let y = start.y; y <= end.y; y += 1) {
    const from = y === start.y ? start.x : 0;
    const to = y === end.y ? end.x : cols - 1;
    for (let x = from; x <= to; x += 1) out.push([x, y]);
  }
  return out;
}

/** The dragged range's on-screen text, for the OSC 52 clipboard copy. It
 * repaints the same frame the operator saw, so what was highlighted is
 * exactly what copies. */
export function extractSelection(
  view: DashProjection,
  input: BoardMeta,
  selection: NonNullable<BoardMeta["selection"]>,
): string {
  const meta = normalizeZoom(input);
  const frame = planLayout(view, meta);
  const screen = new Screen(frame.cols, frame.rows);
  paintFrame(screen, frame, view, meta, meta.now ?? Date.now());
  const start = selection.ay < selection.hy || (selection.ay === selection.hy && selection.ax <= selection.hx)
    ? { x: selection.ax, y: selection.ay }
    : { x: selection.hx, y: selection.hy };
  const end = start.x === selection.ax && start.y === selection.ay
    ? { x: selection.hx, y: selection.hy }
    : { x: selection.ax, y: selection.ay };
  const rows: string[] = [];
  for (let y = start.y; y <= end.y; y += 1) {
    const from = y === start.y ? start.x : 0;
    const to = y === end.y ? end.x : screen.cols - 1;
    rows.push(screen.rowSlice(y, from, to));
  }
  return rows.join("\n");
}

/**
 * Where everything goes, before anything is drawn.
 *
 * Geometry is computed once, as data (`layout-frame.ts`), so overlap and
 * out-of-bounds are machine-checkable and a board can be dumped and diffed.
 * Nothing here knows about colours or text.
 */
export function planLayout(view: DashProjection, input: BoardMeta): LayoutFrame {
  const meta = normalizeZoom(input);
  const cols = Math.max(1, Math.floor(meta.cols));
  const rows = Math.max(1, Math.floor(meta.rows));
  const now = meta.now ?? Date.now();
  const regions: Region[] = [];

  // Chrome lives under the prompt, where the operator's eye already is. It
  // used to sit in three rows above the panes, which put the numbers as far
  // from the cursor as the board allows and cost the same rows anyway.
  const footerY = rows - 1;
  const statusH = Math.max(0, Math.min(statusHeight(view, cols, rows, meta.replay === true), footerY));
  const statusY = footerY - statusH;
  if (footerY >= 0) {
    regions.push({ id: "chrome:footer", kind: "chrome", rect: { x: 0, y: footerY, w: cols, h: 1 } });
  }
  if (statusH > 0) {
    regions.push({ id: "chrome:status", kind: "chrome", rect: { x: 0, y: statusY, w: cols, h: statusH } });
  }
  const bodyY = 0;
  const available = Math.max(0, statusY - bodyY);
  // The prompt is always open, so it is chrome: it takes rows off the body
  // rather than covering panes the operator is reading.
  const promptH = meta.inputDraft === undefined ? 0 : promptHeight(meta, cols, available);
  // The activity row carries the status verb and the last-event age (proof
  // of life). It stays scoped to boards with the live input surface — the
  // TUI always has one (initialUi input is "") — so attach renders without
  // it keep D-2026-08-24-74's ALERTS-only fallback.
  const activityH = !meta.replay && meta.inputDraft !== undefined ? 1 : 0;
  // The alert strip costs a row only while the current operator turn has
  // something to say (D-2026-08-25-97); a clean board pays nothing.
  const stripH = activityH > 0 && alertStrip(view, now) !== undefined ? 1 : 0;
  if (available > 0) {
    // Field feedback (#37): input chrome sits directly under the MODEL
    // STREAM — one persistent current-activity row, then the NOTE prompt.
    // Its rows are spent inside the body. planBody owns the subtraction:
    // charging them here too would double-bill the input and leave a blank
    // strip above the status rows.
    regions.push(...planBody(view, meta, bodyY, cols, available, now, promptH, activityH + stripH));
  }
  if (meta.help) {
    // An overlay, so the board stays visible behind the key map.
    regions.push(helpRegion(bodyY, cols, available));
  }
  if (meta.noticesView) {
    regions.push(noticesRegion(bodyY, cols, available));
  }
  if (meta.permissionPrompt && !meta.replay && pendingOperatorApproval(approvalEventsOf(view))) {
    regions.push(permissionRegion(bodyY, cols, available));
  }
  if (meta.handoffPrompt && !meta.replay) {
    regions.push(handoffRegion(bodyY, cols, available));
  }
  return { cols, rows, regions };
}

/** Draw a planned frame. Layers paint in order, so an overlay lands last. */
function paintFrame(
  screen: Screen,
  frame: LayoutFrame,
  view: DashProjection,
  meta: BoardMeta,
  now: number,
): void {
  for (const region of [...frame.regions].sort((a, b) => layerOf(a) - layerOf(b))) {
    if (region.id === "chrome:status") {
      paintStatus(screen, view, frame.cols, region.rect.y, region.rect.h, meta);
      continue;
    }
    if (region.id === "chrome:footer") {
      paintFooter(screen, view, meta, region.rect.y, frame.cols);
      continue;
    }
    if (region.id === "overlay:keys") {
      paintHelp(screen, region.rect);
      continue;
    }
    if (region.id === "overlay:notices") {
      paintNotices(screen, region.rect, meta.notices);
      continue;
    }
    if (region.id === "overlay:handoff") {
      paintHandoffPrompt(screen, region.rect, meta.handoffPrompt);
      continue;
    }
    if (region.id === "overlay:permission") {
      paintPermission(screen, region.rect, pendingOperatorApproval(view.events));
      continue;
    }
    if (region.id === "chrome:prompt") {
      paintNote(screen, region.rect, meta, view);
      continue;
    }
    if (region.id === "chrome:alertstrip") {
      paintAlertStrip(screen, region.rect, view, now);
      continue;
    }
    if (region.id === "chrome:activity") {
      paintActivity(screen, region.rect, view, now, lastEventAge(view, meta));
      continue;
    }
    const widget = region.widget ? widgetById(region.widget) : undefined;
    if (widget) {
      paintWidget(screen, widget, view, meta, region, now);
    }
  }
}

/**
 * How long ago the newest event landed. Live boards only: replay draws a
 * recorded past, and its distance from the observer's wall clock is noise.
 */
function lastEventAge(view: DashProjection, meta: BoardMeta): string | undefined {
  if (meta.replay) {
    return undefined;
  }
  const ts = view.events.at(-1)?.ts;
  if (!ts) {
    return undefined;
  }
  const at = Date.parse(ts);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return fmtAge((meta.now ?? Date.now()) - at);
}

/** A bad override costs its own effect, never the board. */
function safeApply(widgets: readonly Widget[], config: LayoutConfig): readonly Widget[] {
  try {
    return applyLayoutConfig(widgets, config);
  } catch {
    return widgets;
  }
}

const LEGACY_PANES: Record<string, WidgetId> = { work: "plan", stream: "stream", tools: "tools" };

/** Accept the pre-redesign `zoom: "stream"` form as focus + zoom. */
function normalizeZoom(meta: BoardMeta): BoardMeta & { zoom?: boolean } {
  if (typeof meta.zoom !== "string") {
    return meta as BoardMeta & { zoom?: boolean };
  }
  return { ...meta, focus: meta.focus ?? LEGACY_PANES[meta.zoom], zoom: true };
}

/**
 * Identity, then the model chrome from `cells.ts`.
 *
 * The chrome keeps `key=value` fields (`model=`, `route=`, `ctx=current/max`)
 * rather than a prettier prose form: the operator greps a screenshot, and
 * docs/observability.md pins those names. What the redesign changes is how
 * many rows they cost — a wide board folds identity and metrics onto one row
 * instead of always spending three.
 */
/**
 * Rows the chrome takes: the title row plus the model tiers. A wide board
 * folds identity and metrics onto one line, so this depends on width too —
 * and it must agree exactly with what `paintHeader` then draws.
 */
function statusHeight(view: DashProjection, cols: number, rows: number, replay: boolean): number {
  if (rows < 8) {
    return 1;
  }
  if (rows < 12) {
    return 2;
  }
  const [identity = "", metrics = "", ...rest] = headerModelLines(view, cols);
  const modelTiers = (visibleWidth(identity) + visibleWidth(metrics) + 4 <= cols ? 1 + rest.length : 2 + rest.length);
  // Replay keeps its DOKKABI identity row; the live board moved identity,
  // permissions, and key hints onto the NOTE title, so its status region is
  // the model tiers alone — one row of chrome reclaimed for the panes.
  return (replay ? 1 : 0) + modelTiers + (view.speculation ? 1 : 0) + experimentDashboardLines(view.experiment, cols).length + researchDashboardLines(view.research, cols).length;
}

function paintStatus(
  screen: Screen,
  view: DashProjection,
  cols: number,
  y0: number,
  height: number,
  meta: BoardMeta,
): void {
  if (height <= 0) {
    return;
  }
  const status = activityBadge(view, meta.now ?? Date.now());
  screen.fill(0, y0, cols, 1, " ", "header");
  const session = view.session === "missing" ? (meta.sessionLabel ?? view.session) : view.session;
  const permission = permissionModeFromEvents(view.index.of("permission/mode"));
  // Live boards moved identity, permissions, and key hints onto the NOTE
  // title, so their status region is model tiers alone, starting at y0.
  // Replay keeps its DOKKABI identity/liveness row and starts tiers below it.
  let modelStartY = y0;
  if (meta.replay) {
    let x = 1;
    const head = `DOKKABI  mode=replay  session=${session}${permission === "bypass" ? "  permissions=bypass" : ""}  `;
    screen.text(1, y0, cols - 2, head, "header");
    x = 1 + visibleWidth(head);
    x += screen.text(x, y0, Math.max(0, cols - 2 - x), `status=${status}`, statusTone(status));
    const age = lastEventAge(view, meta);
    if (age !== undefined) {
      x += screen.text(x, y0, Math.max(0, cols - 2 - x), `  last ${age}`, "header");
    }
    const hint = meta.query
      ? `/${meta.query}`
      : KEY_HINTS.find((candidate) => x + visibleWidth(candidate) + 3 <= cols);
    if (hint && x + visibleWidth(hint) + 3 <= cols) {
      screen.text(cols - visibleWidth(hint) - 1, y0, visibleWidth(hint), hint, meta.query ? "match" : "header");
    }
    modelStartY = y0 + 1;
  }
  const modelRows = height - (modelStartY - y0);
  if (modelRows < 1) {
    return;
  }
  if (modelRows < 2) {
    screen.fill(0, modelStartY, cols, 1, " ", "default");
    screen.text(1, modelStartY, cols - 2, modelBarLine(view), "ember");
    return;
  }
  const [identity = "", metrics = "", ...rest] = headerModelLines(view, cols);
  // Fold identity and metrics together when the row can hold both: two rows
  // of chrome instead of three is two more rows of board.
  const folded = visibleWidth(identity) + visibleWidth(metrics) + 4 <= cols;
  const tiers = folded ? [`${identity}  ${metrics}`, ...rest] : [identity, metrics, ...rest];
  const speculation = speculationDisplay(view.speculation);
  if (speculation) tiers.push(speculation.compact);
  tiers.push(...experimentDashboardLines(view.experiment, cols));
  tiers.push(...researchDashboardLines(view.research, cols));
  let y = modelStartY;
  for (const tier of tiers) {
    if (y > y0 + height - 1) {
      break;
    }
    screen.fill(0, y, cols, 1, " ", "default");
    screen.text(1, y, cols - 2, tier, speculation?.compact === tier ? "muted" : "ember");
    // The occupancy row carries a block gauge; paint its cells as a bar.
    for (let x = 0; x < tier.length && 1 + x < cols - 1; x += 1) {
      const glyph = tier[x]!;
      if (glyph === "█") {
        screen.set(1 + x, y, glyph, "bar");
      } else if (glyph === "░") {
        screen.set(1 + x, y, glyph, "barEmpty");
      }
    }
    // The context bar is a trailing run of · dots; recolour each cell by the
    // layer it represents so the graph reads as system/tools/skills/history,
    // dim like the sparklines rather than a solid fill.
    let dotRun = 0;
    while (dotRun < tier.length && tier[tier.length - 1 - dotRun] === "·") dotRun += 1;
    if (dotRun >= 8) {
      const bar = contextLayerBar(view, dotRun);
      const start = tier.length - dotRun;
      for (let i = 0; i < dotRun && 1 + start + i < cols - 1; i += 1) {
        screen.set(1 + start + i, y, "·", bar.tones[i] ?? "barEmpty");
      }
    }
    y += 1;
  }
}

/** Which widgets go in which column, in paint order. */
function boardWidgets(view: DashProjection, meta: BoardMeta): Widget[] {
  const configured = meta.layout ? safeApply(ALL_WIDGETS, meta.layout) : ALL_WIDGETS;
  return configured.filter((widget) => {
    if (!widget.relevant(view)) {
      return false;
    }
    // A drawer pane restates what the status rows under the prompt already
    // carry — the hit ratio, the token counts, the context gauge. It opens on
    // `d`, when the operator asks for the accounting, and stays shut the rest
    // of the time instead of spending a column to say it twice.
    if (
      widget.drawer === true
      && meta.debug !== true
      && meta.focus !== widget.id
      && widget.pinned?.(view) !== true
    ) {
      return false;
    }
    return true;
  });
}

function planBody(
  view: DashProjection,
  meta: BoardMeta,
  y: number,
  cols: number,
  bodyH: number,
  now: number,
  promptH = 0,
  activityH = 0,
): Region[] {
  const widgets = boardWidgets(view, meta);
  const focus = meta.focus;
  const region = (widget: Widget, rect: { x: number; y: number; w: number; h: number }): Region => ({
    id: `pane:${widget.id}`,
    kind: "pane",
    widget: widget.id,
    focused: widget.id === focus,
    rect,
    // Two rows and two columns of border; a box narrower than that has no
    // interior at all.
    content: { x: rect.x + 1, y: rect.y + 1, w: Math.max(0, rect.w - 2), h: Math.max(0, rect.h - 2) },
  });

  if (meta.zoom && focus) {
    const widget = widgetById(focus);
    if (widget) {
      const inputChromeH = promptH + activityH;
      const zoomH = Math.max(0, bodyH - inputChromeH);
      const out = zoomH >= 3 ? [region(widget, { x: 0, y, w: cols, h: zoomH })] : [];
      placeInputChrome(out, y + zoomH, cols, promptH, activityH);
      return out;
    }
  }

  const columns = splitColumns(cols, meta.layout?.columns);
  const stacked = columns.length === 1;
  // On a board too narrow to split, everything is a band anyway. A bottom
  // band (ALERTS) closes the board after the columns; it never competes
  // above them (field feedback: failures must not push the stream up).
  const bandPool = stacked ? widgets : widgets.filter((widget) => widget.slot === "band");
  // The stream and WORK share one row when the board is wide enough to give
  // each a readable column: the stream ran full width while the ledger — the
  // pane naming the red case and the running command — was pushed off the
  // first screen, so a wide terminal spent its columns on prose margin.
  const splitPair = stacked ? undefined : streamWorkPair(widgets, cols);
  const bands = bandPool.filter((widget) => !widget.bottom && widget.id !== splitPair?.stream.id);
  const bottomBands = bandPool.filter((widget) => widget.bottom);
  const columned = stacked
    ? []
    : widgets.filter((widget) => widget.slot !== "band" && widget.id !== splitPair?.work.id);

  const ctxAt = (widget: Widget, width: number) => ctxFor(widget, view, meta, width - 2, bodyH, now);
  // A band is a box: its own two border rows are part of what it asks for,
  // and the column block brings its children's borders with it. Mixing the
  // two means chrome is counted per item rather than by `distribute`.
  const items: FlexItem<Widget | "columns" | "split">[] = bands.map((widget) => {
    const demand = widget.demand(ctxAt(widget, cols));
    return {
      item: widget,
      priority: widget.priority,
      demand: { min: demand.min + 2, ideal: demand.ideal + 2, grow: demand.grow },
    };
  });
  if (splitPair) {
    // One flex item: the row is as tall as the taller of the two panes wants,
    // and neither can starve the other.
    const streamDemand = splitPair.stream.demand(ctxAt(splitPair.stream, splitPair.streamWidth));
    const workDemand = splitPair.work.demand(ctxAt(splitPair.work, splitPair.workWidth));
    items.push({
      item: "split",
      priority: Math.min(splitPair.stream.priority, splitPair.work.priority),
      demand: {
        min: Math.max(streamDemand.min, workDemand.min) + 2,
        ideal: Math.max(streamDemand.ideal, workDemand.ideal) + 2,
        grow: Math.max(streamDemand.grow, workDemand.grow),
      },
    });
  }
  if (columned.length > 0) {
    // The column block competes for rows as one item, so a full-width band
    // above it cannot starve it and it cannot starve the band.
    items.push({
      item: "columns",
      priority: Math.min(...columned.map((widget) => widget.priority)),
      demand: columnBlockDemand(columned, columns, view, meta, bodyH, now),
    });
  }

  const bottomDemand = bottomBands.reduce(
    (sum, widget) => sum + widget.demand(ctxAt(widget, cols)).ideal + 2,
    0,
  );
  const inputChromeH = promptH + activityH;
  const budget = Math.max(0, bodyH - inputChromeH - bottomDemand);
  const out: Region[] = [];
  let top = y;
  let inputPlaced = inputChromeH === 0;
  for (const slot of distribute(items, budget, 0)) {
    if (slot.item === "split") {
      if (splitPair && slot.rows >= 3) {
        out.push(region(splitPair.stream, { x: 0, y: top, w: splitPair.streamWidth, h: slot.rows }));
        out.push(region(splitPair.work, {
          x: splitPair.streamWidth,
          y: top,
          w: splitPair.workWidth,
          h: slot.rows,
        }));
      }
      top += slot.rows;
      if (!inputPlaced) {
        // The NOTE box reads as the stream's continuation, so it follows the
        // row the stream lives in.
        placeInputChrome(out, top, cols, promptH, activityH);
        top += inputChromeH;
        inputPlaced = true;
      }
      continue;
    }
    if (slot.item === "columns") {
      out.push(...planColumns(columned, columns, view, meta, top, cols, slot.rows, now, region));
      top += slot.rows;
      continue;
    }
    const height = slot.rows;
    if (height >= 3) {
      out.push(region(slot.item, { x: 0, y: top, w: cols, h: height }));
    }
    top += height;
    if (!inputPlaced && slot.item.id === "stream") {
      // The NOTE box reads as the stream's continuation: it takes the rows
      // the stream's box ended on, before any other band opens.
      placeInputChrome(out, top, cols, promptH, activityH);
      top += inputChromeH;
      inputPlaced = true;
    }
  }
  if (!inputPlaced && inputChromeH > 0) {
    // No stream on this board (rare): the prompt still gets its rows,
    // after whatever the budget bought.
    const inputY = Math.min(top, y + bodyH - inputChromeH);
    placeInputChrome(out, inputY, cols, promptH, activityH);
    top += inputChromeH;
  }
  for (const widget of bottomBands) {
    const demand = widget.demand(ctxAt(widget, cols));
    const height = Math.max(0, Math.min(demand.ideal + 2, y + bodyH - top));
    if (height >= 3) {
      out.push(region(widget, { x: 0, y: top, w: cols, h: height }));
    }
    top += height;
  }
  return out;
}

/**
 * The stream and WORK as one row: two thirds of the width for the prose,
 * the remaining third for the ledger. Undefined when either pane is absent
 * or the board is too narrow to give both a readable column — there the
 * old full-width stacking is still the better use of the space.
 */
function streamWorkPair(
  widgets: readonly Widget[],
  cols: number,
): { stream: Widget; work: Widget; streamWidth: number; workWidth: number } | undefined {
  const stream = widgets.find((widget) => widget.id === "stream");
  const work = widgets.find((widget) => widget.id === "plan");
  if (!stream || !work) return undefined;
  const workWidth = cols - Math.floor((cols * 2) / 3);
  const streamWidth = cols - workWidth;
  // Both halves must be genuinely readable before the split is worth it: a
  // 34-column WORK truncates the goal id it exists to show, which is the
  // same "cannot see the information" complaint one pane further along.
  if (workWidth < 40 || streamWidth < 76) return undefined;
  return { stream, work, streamWidth, workWidth };
}

/** Keep the live current-activity explanation directly above NOTE. */
function placeInputChrome(out: Region[], y: number, cols: number, promptH: number, activityH: number): void {
  let top = y;
  if (activityH > 1) {
    // The first of the input-chrome rows is the alert strip; the activity
    // row sits directly above NOTE as always.
    out.push({ id: "chrome:alertstrip", kind: "chrome", rect: { x: 0, y: top, w: cols, h: 1 } });
    top += 1;
    activityH -= 1;
  }
  if (activityH > 0) {
    out.push({ id: "chrome:activity", kind: "chrome", rect: { x: 0, y: top, w: cols, h: activityH } });
    top += activityH;
  }
  if (promptH > 0) {
    out.push({ id: "chrome:prompt", kind: "chrome", rect: { x: 0, y: top, w: cols, h: promptH } });
  }
}

/**
 * Rows the column block wants: enough for its tallest column, since the
 * columns are painted side by side and the block is one row range.
 */
function columnBlockDemand(
  widgets: readonly Widget[],
  columns: readonly { x: number; width: number }[],
  view: DashProjection,
  meta: BoardMeta,
  bodyH: number,
  now: number,
): Demand {
  const buckets = assignColumns(widgets, columns, view, meta, bodyH, now);
  let min = 0;
  let ideal = 0;
  let grow = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i]!;
    if (bucket.length === 0) {
      continue;
    }
    const width = columns[i]!.width;
    let bucketMin = 0;
    let bucketIdeal = 0;
    for (const widget of bucket) {
      const demand = widget.demand(ctxFor(widget, view, meta, width - 2, bodyH, now));
      bucketMin += demand.min + 2;
      bucketIdeal += Math.min(demand.ideal, bodyH) + 2;
      grow = Math.max(grow, demand.grow);
    }
    min = Math.max(min, bucketMin);
    ideal = Math.max(ideal, bucketIdeal);
  }
  // The block grows only as much as its tallest-growing child. The old
  // floor of 1 made a block of capped tails (grow 0) compete for surplus
  // rows its children could never fill — parked as a blank strip between
  // the columns and ALERTS while the stream went hungry (field feedback).
  return { min: Math.max(3, min), ideal: Math.max(3, ideal), grow };
}

function planColumns(
  widgets: readonly Widget[],
  columns: readonly { x: number; width: number }[],
  view: DashProjection,
  meta: BoardMeta,
  y: number,
  cols: number,
  height: number,
  now: number,
  region: (widget: Widget, rect: { x: number; y: number; w: number; h: number }) => Region,
): Region[] {
  if (height < 3) {
    return [];
  }
  const buckets = assignColumns(widgets, columns, view, meta, height, now);
  const live = columns
    .map((column, index) => ({ column, widgets: buckets[index]! }))
    .filter((entry) => entry.widgets.length > 0);
  // A column with nothing to show gives its width back rather than painting a
  // blank box: that is exactly the failure the fixed-ratio board had.
  const spread = reflow(live.map((entry) => entry.column), cols);
  const out: Region[] = [];
  live.forEach((entry, index) => {
    const column = spread[index]!;
    const items: FlexItem<Widget>[] = entry.widgets.map((widget) => ({
      item: widget,
      priority: widget.priority,
      demand: widget.demand(ctxFor(widget, view, meta, column.width - 2, height, now)),
    }));
    let rowTop = y;
    for (const slot of distribute(items, height, 2)) {
      const boxH = slot.rows + 2;
      out.push(region(slot.item, { x: column.x, y: rowTop, w: column.width, h: boxH }));
      rowTop += boxH;
    }
  });
  return out;
}


/**
 * Rows the prompt needs: one per draft line, one per suggestion, plus its
 * frame and hint. Ordinary notes never take more than half the space; an
 * active auth message may use the available body so its URL is not clipped.
 */
function promptHeight(meta: BoardMeta, cols: number, available: number): number {
  if (available < 4) {
    return 0;
  }
  const inner = Math.max(4, cols - 4);
  const draft = displayDraft(meta);
  const authRows = authMessageLines(meta, inner).length;
  const needed = meta.replay
    ? 1
    : authRows +
      noteLines(draft, inner, meta.inputCursor).length +
      completionsFor(meta.inputDraft ?? "", meta).length;
  const maximum = authRows > 0 ? available : Math.floor(available / 2);
  return Math.min(Math.max(4, needed + 3), Math.max(4, maximum));
}

/** Keep provider instructions visible for the lifetime of an auth prompt.
 * OAuth URLs are operational input, not transient toast text, and must wrap
 * instead of being ellipsized to the width of the footer. */
function authMessageLines(meta: BoardMeta, width: number): string[] {
  if (meta.picker !== "auth-input" || !meta.notice) return [];
  return meta.notice.split("\n").flatMap((line) => wrapText(line, width));
}

/**
 * Draft text as display rows, with the caret drawn where it actually is.
 *
 * Appending the block to the end was fine while the caret could only be at
 * the end. Now that it moves, the character under it has to move with it or
 * mid-line editing is blind.
 */
function noteLines(draft: string, width: number, cursor?: number): string[] {
  const glyphs = [...draft];
  const at = cursor === undefined ? glyphs.length : Math.max(0, Math.min(glyphs.length, cursor));
  const withCaret = glyphs.slice(0, at).join("") + "\u2588" + glyphs.slice(at).join("");
  const out: string[] = [];
  for (const paragraph of withCaret.split("\n")) {
    for (const row of wrapText(paragraph, width)) {
      out.push(row);
    }
  }
  return out.length > 0 ? out : ["\u2588"];
}

function paintNote(screen: Screen, rect: Rect, meta: BoardMeta, view: DashProjection): void {
  if (rect.w < 8 || rect.h < 3) {
    return;
  }
  const target = view.session === "missing" ? (meta.sessionLabel ?? "this session") : view.session;
  const titleRoom = Math.max(0, rect.w - 4);
  const title = pickerTitle(meta, target, permissionModeFromEvents(view.index.of("permission/mode")), titleRoom);
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", "default");
  screen.box(rect.x, rect.y, rect.w, rect.h, ellipsize(title, titleRoom), "focus");
  for (let i = 0; i < rect.w; i += 1) {
    relight(screen, rect.x + i, rect.y);
    relight(screen, rect.x + i, rect.y + rect.h - 1);
  }
  for (let j = 0; j < rect.h; j += 1) {
    relight(screen, rect.x, rect.y + j);
    relight(screen, rect.x + rect.w - 1, rect.y + j);
  }
  const inner = Math.max(4, rect.w - 4);
  const bodyRows = Math.max(1, rect.h - 3);
  if (meta.replay) {
    screen.text(rect.x + 2, rect.y + 1, inner, "no running loop to send a note to", "bad");
    screen.text(rect.x + 2, rect.y + rect.h - 2, inner, "Esc close", "muted");
    return;
  }
  const draftRows = meta.histSearch
    ? [histSearchLine(meta.histSearch, inner)]
    : noteLines(displayDraft(meta), inner, meta.inputCursor);
  const authRows = authMessageLines(meta, inner);
  const authRoom = Math.max(0, bodyRows - Math.min(bodyRows, draftRows.length));
  const visibleAuthRows = authRows.slice(0, authRoom);
  const draftRoom = Math.max(1, bodyRows - visibleAuthRows.length);
  const visibleDraftRows = draftRows.slice(-draftRoom);
  const rows = [...visibleAuthRows, ...visibleDraftRows];
  for (let i = 0; i < rows.length; i += 1) {
    screen.text(rect.x + 2, rect.y + 1 + i, inner, rows[i]!, i < visibleAuthRows.length ? "accent" : "default");
  }
  const ghost = slashGhost(meta);
  if (ghost) {
    // Inline preview of exactly what Tab would insert — only once the
    // candidates narrow to one, so the dim tail is a promise, not a guess.
    const last = rows[rows.length - 1]!;
    const used = [...last].length;
    if (used < inner) {
      screen.text(rect.x + 2 + used, rect.y + rows.length, inner - used, ghost, "muted");
    }
  }
  // What the operator can type next, so commands are discovered rather than
  // memorised. This is why board actions moved behind a slash at all.
  const suggestions = completionsFor(meta.inputDraft ?? "", meta);
  let row = rect.y + 1 + rows.length;
  for (let index = 0; index < suggestions.length; index += 1) {
    const suggestion = suggestions[index]!;
    if (row >= rect.y + rect.h - 2) {
      break;
    }
    const selected = suggestion.selected === true;
    const name = meta.picker
      ? `${selected ? "\u203a" : " "} ${suggestion.name}`
      : `${selected ? "\u203a " : ""}/${suggestion.name}`;
    screen.text(rect.x + 2, row, inner, name, selected ? "focus" : "accent");
    screen.text(
      rect.x + 2 + Math.min(inner, name.length + 2),
      row,
      Math.max(0, inner - name.length - 2),
      ellipsize(suggestion.summary, Math.max(0, inner - name.length - 2)),
      "muted",
    );
    row += 1;
  }
  const queued = meta.pendingNotes ?? 0;
  const inFlight = meta.inFlightNotes ?? 0;
  const noteNotice = visibleNotice(meta);
  const deliveryState = [
    queued > 0 ? `${queued} queued` : undefined,
    inFlight > 0 ? `${inFlight} in flight` : undefined,
  ].filter((value): value is string => value !== undefined).join(" \u00b7 ");
  const hint = meta.histSearch
    ? `Enter fill draft \u00b7 Ctrl+R older \u00b7 Ctrl+S newer \u00b7 Esc cancel`
    : meta.picker === "auth-input"
      ? `Enter submit \u00b7 Esc cancel${meta.inputSecret ? " \u00b7 secret input masked" : ""}`
      : meta.picker
        ? "\u2191/\u2193 choose \u00b7 Enter select \u00b7 Tab complete \u00b7 Esc cancel"
        : suggestions.length > 0 && isSlash(meta.inputDraft ?? "")
          ? "\u2191/\u2193 choose \u00b7 Enter run \u00b7 Tab complete \u00b7 Esc cancel"
          : noteNotice
            ? noteNotice
            : `Enter ${isSlash(meta.inputDraft ?? "") ? "run" : "send"} \u00b7 Esc cancel${deliveryState ? ` \u00b7 ${deliveryState}` : ""}`;
  screen.text(
    rect.x + 2,
    rect.y + rect.h - 2,
    inner,
    ellipsize(hint, inner),
    noteNotice && meta.picker !== "auth-input" ? "bad" : "muted",
  );
}

/** Paint the pure current-activity selector; this path never appends an event. */
function paintActivity(
  screen: Screen,
  rect: Rect,
  view: DashProjection,
  now: number,
  lastAge?: string,
): void {
  if (rect.h < 1) {
    return;
  }
  const activity = currentActivity(view, now);
  const tone: Tone = activity.kind === "ssh-approval"
    ? "banner"
    : activity.kind === "tool-loop"
      ? "bad"
      : activity.kind === "agent" && (activity.status === "failed" || activity.status === "error")
        ? "bad"
        : activity.kind === "agent"
          ? "muted"
          : "spin";
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", tone);
  const width = Math.max(0, rect.w - 2);
  // The last-event age is the board's proof of life: it ticks here, where
  // the operator is already looking, instead of in the far header.
  const text = lastAge === undefined
    ? currentActivityText(activity)
    : `${currentActivityText(activity)} · last ${lastAge}`;
  screen.text(rect.x + 1, rect.y, width, ellipsize(text, width), tone);
}

/** The worst current alert, one row, only while there is one. */
/** The notice to paint at `now`, or undefined once it has outlived its TTL. */
export function visibleNotice(meta: Pick<BoardMeta, "notice" | "noticeAt" | "noticeTtl" | "now">, now?: number): string | undefined {
  if (!meta.notice) return undefined;
  if (meta.noticeAt === undefined) return meta.notice;
  const at = now ?? meta.now ?? Date.now();
  const ttl = meta.noticeTtl ?? DEFAULT_NOTICE_TTL_MS;
  return at - meta.noticeAt <= ttl ? meta.notice : undefined;
}

/** copied toast: 10s. Everything else: 30s. */
export const DEFAULT_NOTICE_TTL_MS = 30_000;
export const COPIED_NOTICE_TTL_MS = 10_000;

function paintAlertStrip(screen: Screen, rect: Rect, view: DashProjection, now: number): void {
  if (rect.h < 1) return;
  const strip = alertStrip(view, now);
  if (!strip) return;
  const tone: Tone = strip.bad ? "bad" : "ember";
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", tone);
  const width = Math.max(0, rect.w - 2);
  screen.text(rect.x + 1, rect.y, width, ellipsize(strip.text, width), tone);
}

/** The line reverse search paints over the draft while it is open. */
function histSearchLine(
  search: { needle: string; at?: number; miss?: boolean } & { preview?: string },
  inner: number,
): string {
  const preview = search.preview ?? (search.miss === true ? "no match" : "\u2026");
  return ellipsize(`(rsearch) ${search.needle} \u25b8 ${preview}`, inner);
}

/** The unique completion's remainder, for the dim inline preview. Ambiguous
 * drafts, pickers, secret input, and history search preview nothing. */
function slashGhost(
  meta: Pick<BoardMeta, "inputDraft" | "inputSecret" | "picker" | "histSearch" | "inputCursor" | "slashEnv">,
): string | undefined {
  const draft = meta.inputDraft ?? "";
  if (meta.picker || meta.inputSecret === true || meta.histSearch) return undefined;
  if (meta.inputCursor !== undefined && meta.inputCursor !== [...draft].length) return undefined;
  if (!/^\s*\//.test(draft)) return undefined;
  const body = draft.replace(/^\s*\//, "");
  const options = completeSlash(draft, meta.slashEnv);
  if (options.length !== 1) return undefined;
  const full = options[0]!.name;
  if (full.length <= body.length || !full.toLowerCase().startsWith(body.toLowerCase())) return undefined;
  return full.slice(body.length);
}

/** Command suggestions for the current draft, bounded so the box stays sane. */
function completionsFor(
  draft: string,
  meta: Pick<BoardMeta, "picker" | "pickerCandidates" | "pickerSummaries" | "pickerDetails" | "pickerRoute" | "pickerAt" | "slashAt" | "slashEnv"> = {},
): { name: string; summary: string; selected?: boolean }[] {
  if (meta.picker) {
    const matches = pickerMatches(meta, draft);
    const selected = meta.pickerAt;
    const start = selected === undefined ? 0 : Math.max(0, Math.min(selected - 7, matches.length - 8));
    return matches.slice(start, start + 8).map((candidate, index) => ({
      ...candidate,
      selected: selected === start + index,
    }));
  }
  // Same windowing rule as the picker: the highlighted row stays visible and
  // settles near the top once the list scrolls.
  const hits = completeSlash(draft, meta.slashEnv);
  const selected = meta.slashAt;
  const start = selected === undefined ? 0 : Math.max(0, Math.min(selected - 7, hits.length - 8));
  return hits.slice(start, start + 8).map((candidate, index) => ({
    ...candidate,
    selected: selected === start + index,
  }));
}

function displayDraft(meta: Pick<BoardMeta, "inputDraft" | "inputSecret">): string {
  const draft = meta.inputDraft ?? "";
  return meta.inputSecret ? [...draft].map(() => "\u2022").join("") : draft;
}

function pickerTitle(
  meta: Pick<BoardMeta, "picker" | "pickerPrompt" | "replay" | "query">,
  target: string,
  permission?: string,
  room = 0,
): string {
  if (meta.picker === "route") return "MODEL \u2014 choose route/model";
  if (meta.picker === "effort") return "EFFORT \u2014 choose reasoning level";
  if (meta.picker === "login") return "LOGIN \u2014 choose account";
  if (meta.picker === "logout") return "LOGOUT \u2014 choose account";
  if (meta.picker === "auth-input") return `AUTH \u2014 ${meta.pickerPrompt ?? "provider input"}`;
  // Labelled so "live" is not an unexplained bare word: mode= and session=
  // spell out which is which. Live boards also carry the security badge and
  // the key legend here, so the bottom status row need not repeat them.
  const mode = meta.replay ? "replay" : "live";
  let title = `NOTE \u2192 mode=${mode} \u00b7 session=${target}`;
  if (!meta.replay) {
    if (permission === "bypass") title += " \u00b7 permissions=bypass";
    const hint = KEY_HINTS.find((candidate) => visibleWidth(`${title} \u00b7 ${candidate}`) <= room);
    if (hint) title += ` \u00b7 ${hint}`;
  }
  return title;
}

/** The key map's box, centred over the body. */
function helpRegion(y: number, cols: number, bodyH: number): Region {
  const w = Math.min(Math.max(0, cols - 2), 70);
  const h = Math.min(bodyH, HELP_KEYS.length + 2);
  const x = Math.max(0, Math.floor((cols - w) / 2));
  return { id: "overlay:keys", kind: "overlay", rect: { x, y, w, h }, title: "KEYS" };
}

function noticesRegion(y: number, cols: number, bodyH: number): Region {
  const entries = Math.max(1, NOTICES_OVERLAY_MAX);
  const w = Math.min(Math.max(0, cols - 2), 70);
  const h = Math.min(bodyH, entries + 2);
  const x = Math.max(0, Math.floor((cols - w) / 2));
  return { id: "overlay:notices", kind: "overlay", rect: { x, y, w, h }, title: "NOTICES" };
}

function permissionRegion(y: number, cols: number, bodyH: number): Region {
  const w = Math.min(Math.max(0, cols - 2), 82);
  const h = Math.min(bodyH, 10);
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const top = y + Math.max(0, Math.floor((bodyH - h) / 2));
  return { id: "overlay:permission", kind: "overlay", rect: { x, y: top, w, h }, title: "PERMISSION REQUEST", z: 20 };
}

function handoffRegion(y: number, cols: number, bodyH: number): Region {
  const w = Math.min(Math.max(0, cols - 2), 84);
  const h = Math.min(bodyH, 10);
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const top = y + Math.max(0, Math.floor((bodyH - h) / 2));
  return { id: "overlay:handoff", kind: "overlay", rect: { x, y: top, w, h }, title: "MODEL HANDOFF", z: 21 };
}

function paintHandoffPrompt(
  screen: Screen,
  rect: Rect,
  prompt: BoardMeta["handoffPrompt"],
): void {
  if (!prompt || rect.w < 4 || rect.h < 3) return;
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", "default");
  screen.box(rect.x, rect.y, rect.w, rect.h, "MODEL HANDOFF", "focus");
  const x = rect.x + 2;
  const width = Math.max(0, rect.w - 4);
  const lines: readonly [string, Tone][] = [
    [`Switching to ${prompt.route}/${prompt.model} would carry a large context`, "accent"],
    [`${prompt.afterMessages} messages · ~${prompt.afterTokens} tokens · ~${prompt.percent}% of the advertised ${prompt.contextWindow}-token window`, "default"],
    ["[1] carry everything (full 75% landing budget)", "accent"],
    ["[2] slim — keep the goal and latest turns with a checkpoint summary", "accent"],
    ["[3] cancel and stay on the current model", "accent"],
    ["Advertised windows are unverified; a large carry can be rejected live.", "muted"],
    ["Esc cancels · nothing has switched yet", "muted"],
  ];
  for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
    const [text, tone] = lines[index]!;
    screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
  }
}

function paintPermission(screen: Screen, rect: Rect, pending: PendingOperatorApproval | undefined): void {
  if (!pending || rect.w < 4 || rect.h < 3) return;
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", "default");
  screen.box(rect.x, rect.y, rect.w, rect.h, "PERMISSION REQUEST", "bad");
  const x = rect.x + 2;
  const width = Math.max(0, rect.w - 4);
  if (pending.kind === "github-admin") {
    if (pending.approval.operation === "repo_push") {
      const authorize = pending.approval.authorizeRepository;
      const lines: readonly [string, Tone][] = [
        [authorize
          ? "Authorize repository and push existing commits"
          : "Push existing commits to a private GitHub repository", "bad"],
        [`repo=${pending.approval.repo} · branch=${pending.approval.branch ?? "unavailable"}`, "accent"],
        [`from=${pending.approval.remoteHead?.slice(0, 12) ?? "unavailable"} · to=${pending.approval.localHead?.slice(0, 12) ?? "unavailable"} · commits=${pending.approval.commitCount ?? 0}`, "accent"],
        [`range=${pending.approval.rangeDigest?.slice(0, 12) ?? "unavailable"} · untracked=${pending.approval.untrackedCount ?? 0} not included`, "accent"],
        [authorize
          ? "Approval persistently authorizes pushes to this exact repository."
          : "Only this descendant range is approved; no force, tags, or ref deletion.", "muted"],
        [authorize ? "[1] authorize repository and push" : "[1] push once", "accent"],
        ["[3] deny without changing GitHub", "accent"],
        ...(!authorize ? [["[4] bypass approval prompts for this session", "bad"] as [string, Tone]] : []),
        ["Esc denies · credentials, paths, and commit messages stay out of the log", "muted"],
      ];
      for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
        const [text, tone] = lines[index]!;
        screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
      }
      return;
    }
    if (pending.approval.operation === "repo_publish") {
      const authorize = pending.approval.authorizeRepository;
      const lines: readonly [string, Tone][] = [
        [authorize
          ? "Authorize repository and publish workspace files"
          : "Publish workspace files to a private GitHub repository", "bad"],
        [`repo=${pending.approval.repo} · visibility=private · mode=additive`, "accent"],
        [`source=${pending.approval.sourcePath ?? "unavailable"} · files=${pending.approval.fileCount ?? 0} · bytes=${permissionBytes(pending.approval.totalBytes ?? 0)}`, "accent"],
        [authorize
          ? "Approval persistently authorizes this exact repository, then publishes."
          : "Absent remote paths remain; no force update or deletion is allowed.", "muted"],
        [authorize ? "[1] authorize repository and publish" : "[1] publish once", "accent"],
        ["[3] deny without changing GitHub", "accent"],
        ...(!authorize ? [["[4] bypass approval prompts for this session", "bad"] as [string, Tone]] : []),
        ["Esc denies · credentials and file contents stay out of the log", "muted"],
      ];
      for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
        const [text, tone] = lines[index]!;
        screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
      }
      return;
    }
    if (pending.approval.authorizeOwner) {
      const lines: readonly [string, Tone][] = [
        ["Authorize GitHub owner and create a private repository", "bad"],
        [`owner=${pending.approval.owner ?? "unavailable"}`, "accent"],
        [`repo=${pending.approval.repo} · visibility=private`, "accent"],
        ["Approval persistently adds this owner, then continues this exact request.", "muted"],
        ["[1] authorize owner and create repository", "accent"],
        ["[3] deny without changing owner policy or GitHub", "accent"],
        ["Esc denies · credentials remain in the host gh store", "muted"],
      ];
      for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
        const [text, tone] = lines[index]!;
        screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
      }
      return;
    }
    const lines: readonly [string, Tone][] = [
      ["Private GitHub repository creation is waiting for operator authority", "bad"],
      [`repo=${pending.approval.repo}`, "accent"],
      ["visibility=private", "accent"],
      ["No GitHub mutation has started; credentials remain in the host gh store.", "muted"],
      ["[1] allow once", "accent"],
      ["[3] deny", "accent"],
      ["[4] bypass approval prompts for this session", "bad"],
      ["Esc denies · private-only and safety guards stay enforced", "muted"],
    ];
    for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
      const [text, tone] = lines[index]!;
      screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
    }
    return;
  }
  if (pending.kind === "mcp") {
    const approval = pending.approval;
    const enrollment = approval.operation === "server_enroll";
    const argv = enrollment
      ? [approval.command ?? "unavailable", ...(approval.args ?? [])].join(" ")
      : "";
    const lines: readonly [string, Tone][] = enrollment
      ? [
          [approval.replace ? "Replace an enrolled MCP capability" : "Enroll a new MCP capability", "bad"],
          [`server=${approval.server} · transport=stdio · network=sandbox policy`, "accent"],
          [`exec=${argv}`, "accent"],
          [`credential env names=${approval.envNames?.join(",") || "none"}`, "accent"],
          ["Persistent exact executable/argv authority; filesystem is an empty sandbox.", "muted"],
          ["[1] authorize, persist, connect, and discover tools", "accent"],
          ["[3] deny without saving or starting the server", "accent"],
          ["Esc denies · bypass cannot enroll external code", "muted"],
        ]
      : [
          ["Call an MCP tool", "bad"],
          [`server=${approval.server} · tool=${approval.tool ?? "unavailable"}`, "accent"],
          [`arguments sha256=${approval.argumentDigest?.slice(0, 12) ?? "unavailable"}`, "accent"],
          ["The enrolled server is isolated; the call may still change an external service.", "muted"],
          ["[1] allow this call once", "accent"],
          ["[2] allow this exact server/tool for the session", "accent"],
          ["[3] deny", "accent"],
          ["[4] bypass approval prompts for this session", "bad"],
          ["Esc denies · credential values stay out of arguments and logs", "muted"],
        ];
    for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
      const [text, tone] = lines[index]!;
      screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
    }
    return;
  }
  if (pending.kind === "plugin-install") {
    const approval = pending.approval;
    const lines: readonly [string, Tone][] = [
      [approval.replace ? "Replace a managed skill plugin" : "Install a managed skill plugin", "bad"],
      [`id=${approval.id} · skill=${approval.skillName} · license=${approval.license}`, "accent"],
      [`source=${approval.repository}@${approval.commit.slice(0, 12)} · ${approval.sourcePath}`, "accent"],
      [`files=${approval.fileCount} · bytes=${permissionBytes(approval.totalBytes)} · refs=${approval.referenceCount} · sha256=${approval.packageDigest.slice(0, 12)}`, "accent"],
      ["Persists inert UTF-8 instructions/references only; no third-party code executes.", "muted"],
      ["[1] approve installation and continue the same model call", "accent"],
      ["[3] deny without saving external content", "accent"],
      ["Esc denies · bypass cannot install persistent external instructions", "muted"],
    ];
    for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
      const [text, tone] = lines[index]!;
      screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
    }
    return;
  }
  const approval = pending.approval;
  const isEnroll = approval.detail?.startsWith("enroll") === true;
  const lines: readonly [string, Tone][] = [
    [isEnroll ? "SSH alias enrollment is waiting for operator authority" : "SSH remote execution is waiting for operator authority", "bad"],
    [`target=${approval.target}`, "accent"],
    ...(approval.detail ? [[approval.detail, "accent"] as [string, Tone]] : []),
    [isEnroll ? "Approving writes this alias to your ssh config; the address is not logged." : "No remote process has started; command details remain protected.", "muted"],
    ["[1] allow once", "accent"],
    ["[2] allow this target for the session", "accent"],
    ["[3] deny", "accent"],
    ["[4] bypass approval prompts for this session", "bad"],
    ["Esc denies · sandbox and safety guards stay enforced", "muted"],
  ];
  for (let index = 0; index < lines.length && index < rect.h - 2; index += 1) {
    const [text, tone] = lines[index]!;
    screen.text(x, rect.y + 1 + index, width, ellipsize(text, width), tone);
  }
}

function permissionBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The overlay shows the newest entries only — the ring keeps the history. */
const NOTICES_OVERLAY_MAX = 12;

function paintNotices(screen: Screen, rect: Rect, notices: readonly { text: string; at: number }[] | undefined): void {
  if (rect.w < 4 || rect.h < 3) {
    return;
  }
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", "default");
  screen.box(rect.x, rect.y, rect.w, rect.h, "NOTICES", "focus");
  const inner = Math.max(0, rect.w - 4);
  const rows = Math.max(0, rect.h - 2);
  const list = notices ?? [];
  if (list.length === 0) {
    screen.text(rect.x + 2, rect.y + 1, inner, "no notices yet", "muted");
    return;
  }
  // Newest at the bottom, matching the ring's order; the tail fits the box.
  const visible = list.slice(-rows);
  visible.forEach((entry, index) => {
    screen.text(rect.x + 2, rect.y + 1 + index, inner, ellipsize(entry.text, inner), "bad");
  });
}

/**
 * Place widgets into columns by load, not by a hard-coded slot.
 *
 * `main` (the stream) keeps the widest column. Everything else is packed
 * greedily into whichever remaining column is emptiest, so a short PLAN does
 * not leave a column half blank while EVENTS is starved next to it. Each
 * non-main column also gets at least one elastic widget, so leftover rows go
 * to a scrollable list rather than to whitespace.
 */
function assignColumns(
  widgets: readonly Widget[],
  columns: readonly { x: number; width: number }[],
  view: DashProjection,
  meta: BoardMeta,
  bodyH: number,
  now: number,
): Widget[][] {
  const buckets: Widget[][] = columns.map(() => []);
  // Every box costs two rows of border plus the widget's own minimum. A
  // column stops taking panes once those floors would not fit: one more box
  // then spends more rows on chrome than any of them can fill.
  const paneCap = Math.max(2, Math.floor(bodyH / 5));
  const demandIn = (widget: Widget, columnIndex: number) =>
    widget.demand(ctxFor(widget, view, meta, columns[columnIndex]!.width - 2, bodyH, now));
  const floorOf = (widget: Widget, columnIndex: number): number => demandIn(widget, columnIndex).min + 2;
  /**
   * How many rows a widget really takes off a column's budget. An elastic
   * widget absorbs whatever is left over, so it reserves only its floor —
   * charging it the whole column would leave no room for anything else and
   * is what kept TOKENS and CONTEXT off a board that had rows to spare.
   */
  const reserves = (widget: Widget, columnIndex: number): number => {
    const demand = demandIn(widget, columnIndex);
    return demand.grow > 0 ? demand.min + 2 : Math.min(demand.ideal, bodyH) + 2;
  };

  // `d` says "right now I want the accounting". On a roomy board those panes
  // are already on; on a tight one the key has to outrank something, so it
  // moves TOKENS and CONTEXT ahead of TOOLS, HOST and the ribbon rather than
  // waiting for rows that are not there.
  const isSpare = (widget: Widget) =>
    widget.optional === true && !(meta.debug === true && widget.drawer === true);
  const rank = (widget: Widget) =>
    meta.debug === true && widget.drawer === true ? widget.priority - 4 : widget.priority;
  const required = widgets.filter((widget) => !isSpare(widget));
  const spare = widgets.filter(isSpare);
  const byPriority = (a: Widget, b: Widget) => rank(a) - rank(b);
  if (columns.length === 1) {
    // Take panes in priority order while their floors still fit. A pane that
    // cannot reach its own minimum shows a title and a stub, which is worse
    // than not being there: z zooms it when the operator wants it.
    let spent = 0;
    for (const widget of [...required].sort(byPriority)) {
      const floor = floorOf(widget, 0);
      if (buckets[0]!.length >= paneCap || (buckets[0]!.length > 0 && spent + floor > bodyH)) {
        continue;
      }
      buckets[0]!.push(widget);
      spent += floor;
    }
    return buckets;
  }

  const mainIndex = 1;
  const others = columns.map((_, index) => index).filter((index) => index !== mainIndex);
  const load = columns.map(() => 0);
  const floors = columns.map(() => 0);
  const full = (index: number, widget: Widget) =>
    buckets[index]!.length >= paneCap || floors[index]! + floorOf(widget, index) > bodyH;
  const emptiest = (widget: Widget): number => {
    const open = others.filter((index) => !full(index, widget));
    const pool = open.length > 0 ? open : others;
    let best = pool[0]!;
    for (const index of pool) {
      if (load[index]! < load[best]!) {
        best = index;
      }
    }
    return best;
  };
  const place = (widget: Widget, index: number) => {
    buckets[index]!.push(widget);
    load[index]! += reserves(widget, index);
    floors[index]! += floorOf(widget, index);
  };

  for (const widget of [...required].sort(byPriority)) {
    if (widget.slot === "main") {
      buckets[mainIndex]!.push(widget);
      load[mainIndex]! = bodyH;
      continue;
    }
    // Honour the widget's side: WORK on the left and accounting on the right
    // is a layout an operator can learn. Load balancing only breaks the tie
    // when the preferred column is out of rows.
    const preferred = widget.slot === "side" ? others[0]! : others[others.length - 1]!;
    const target = full(preferred, widget) ? emptiest(widget) : preferred;
    if (full(target, widget) && buckets[target]!.length > 0) {
      continue;
    }
    place(widget, target);
  }
  // Rows still unspoken for buy detail: the optional widgets join, cheapest
  // first, while a column can still show them above their minimum.
  for (const widget of [...spare].sort(byPriority)) {
    const target = emptiest(widget);
    if (full(target, widget)) {
      continue;
    }
    place(widget, target);
  }
  // Paint order inside a column follows priority: alerts before accounting.
  for (const bucket of buckets) {
    bucket.sort(byPriority);
  }
  return buckets;
}

/** Re-spread column widths after empty columns dropped out. */
function reflow(columns: { x: number; width: number }[], cols: number): { x: number; width: number }[] {
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  if (total === cols || columns.length === 0) {
    return columns;
  }
  let x = 0;
  return columns.map((column, index) => {
    const width = index === columns.length - 1 ? cols - x : Math.floor((column.width / total) * cols);
    const out = { x, width };
    x += width;
    return out;
  });
}

function columnFor(widget: Widget, columnCount: number): number {
  if (columnCount === 1) {
    return 0;
  }
  if (columnCount === 2) {
    return widget.slot === "side" ? 0 : 1;
  }
  return widget.slot === "side" ? 0 : widget.slot === "main" ? 1 : 2;
}

function ctxFor(
  widget: Widget,
  view: DashProjection,
  meta: BoardMeta,
  width: number,
  rows: number,
  now: number,
): WidgetCtx {
  return {
    view,
    width: Math.max(1, width),
    rows: Math.max(1, rows),
    focused: meta.focus === widget.id,
    scroll: meta.scroll?.[widget.id] ?? 0,
    query: meta.query,
    filter: meta.filters?.[widget.id],
    now,
  };
}

function paintWidget(
  screen: Screen,
  widget: Widget,
  view: DashProjection,
  meta: BoardMeta,
  region: Region,
  now: number,
): void {
  const { x, y, w, h } = region.rect;
  if (w < 4 || h < 3) {
    return;
  }
  const focused = region.focused === true;
  const ctx = ctxFor(widget, view, meta, w - 2, h - 2, now);
  // A filtered pane must announce it in place: the hidden-count marker sits
  // at the top of a possibly scrolled body and is easy to miss.
  const paneFilter = meta.filters?.[widget.id];
  const title = paneFilter ? `${widget.title(ctx)} · filter:'${paneFilter}'` : widget.title(ctx);
  screen.box(x, y, w, h, ellipsize(title, Math.max(0, w - 4)), focused ? "focus" : "title");
  if (focused) {
    // Relight the frame in the focus tone: which pane the keys drive must be
    // visible without reading the footer.
    for (let i = 0; i < w; i += 1) {
      relight(screen, x + i, y);
      relight(screen, x + i, y + h - 1);
    }
    for (let j = 0; j < h; j += 1) {
      relight(screen, x, y + j);
      relight(screen, x + w - 1, y + j);
    }
    screen.text(x + 2, y, Math.max(0, w - 4), ` ${ellipsize(title, Math.max(0, w - 6))} `, "focus");
  }
  // A title may carry a colour legend, and screen.box paints the whole row in
  // one tone. Repaint the glyphs the widget has an opinion about; box lays the
  // title down at x + 2 behind one leading space.
  const titleTones = widget.titleTones?.(ctx);
  if (titleTones) {
    const shown = ellipsize(title, Math.max(0, w - (focused ? 6 : 4)));
    let col = x + 3 + (focused ? 1 : 0);
    let index = 0;
    for (const glyph of shown) {
      const size = charWidth(glyph);
      if (col + size > x + w - 1) {
        break;
      }
      screen.set(col, y, glyph, titleTones[index] ?? (focused ? "focus" : "title"));
      col += size;
      index += 1;
    }
  }
  const body = region.content ?? { x: x + 1, y: y + 1, w: w - 2, h: h - 2 };
  const lines = [...widget.lines(ctx)];
  // The TOOLS expansion appends its detail block at the tail: inline
  // insertion would fight the scroll window, and the operator asked about
  // this row — keeping it pinned at the bottom of the pane is easier to
  // read than a block that scrolls away.
  if (widget.id === "tools" && meta.expandedTool !== undefined) {
    const row = view.tools.find((candidate) => toolKey(candidate) === meta.expandedTool);
    if (row) {
      lines.push(...toolDetailLines(row).map((text) => ({ text, tone: "muted" as Tone })));
    }
  }
  for (let i = 0; i < body.h; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    paintLine(screen, body.x, body.y + i, body.w, line);
  }
}

function relight(screen: Screen, x: number, y: number): void {
  const glyph = screen.glyphAt(x, y);
  if (glyph && "┌┐└┘─│┬┴├┤┼".includes(glyph)) {
    screen.set(x, y, glyph, "focus");
  }
}

/** Paint one widget line, honouring per-cell chart tones when present. */
function paintLine(screen: Screen, x: number, y: number, width: number, line: WidgetLine): void {
  if (!line.cells) {
    screen.text(x, y, width, clip(line.text, width), line.tone);
    return;
  }
  // Columns and glyphs are not the same count: a Hangul syllable or an emoji
  // takes two cells. Stepping the column by one per glyph overwrote the
  // second half of every wide character.
  let col = 0;
  let index = 0;
  for (const glyph of line.text) {
    const size = charWidth(glyph);
    if (col + size > width) {
      break;
    }
    screen.set(x + col, y, glyph, line.cells[index] ?? line.tone);
    col += size;
    index += 1;
  }
}

/**
 * The note draft, anchored to its end.
 *
 * The draft used to render from its first character, so once it passed the
 * row width the operator was typing off screen with the cursor nowhere in
 * sight. The tail is what is being edited, so the tail is what is shown; a
 * clipped head is marked with a leading ellipsis. Newlines from a paste are
 * shown as `⏎` so a multi-line note still reads as one row.
 */
function paintDraft(screen: Screen, draft: string, y: number, cols: number): void {
  const label = "note> ";
  const hint = "  (Enter send, Esc cancel)";
  const room = Math.max(4, cols - 2 - visibleWidth(label));
  const flat = draft.replaceAll("\n", "⏎");
  const body = `${flat}█`;
  const hintRoom = visibleWidth(body) + visibleWidth(hint) <= room ? hint : "";
  const budget = room - visibleWidth(hintRoom);
  // Keep the end of the draft: that is where the cursor is.
  let shown = body;
  if (visibleWidth(shown) > budget) {
    const glyphs = [...shown];
    let width = 0;
    let cut = glyphs.length;
    while (cut > 0 && width + charWidth(glyphs[cut - 1]!) <= budget - 1) {
      cut -= 1;
      width += charWidth(glyphs[cut]!);
    }
    shown = `…${glyphs.slice(cut).join("")}`;
  }
  let x = 1;
  x += screen.text(x, y, cols - 2, label, "header");
  x += screen.text(x, y, Math.max(0, cols - 1 - x), shown, "header");
  if (hintRoom) {
    screen.text(x, y, Math.max(0, cols - 1 - x), hintRoom, "muted");
  }
}

function paintHelp(screen: Screen, rect: Rect): void {
  if (rect.w < 4 || rect.h < 3) {
    return;
  }
  // box() draws only the frame; an overlay must be opaque or the panes
  // underneath bleed through every unwritten interior cell.
  screen.fill(rect.x, rect.y, rect.w, rect.h, " ", "default");
  screen.box(rect.x, rect.y, rect.w, rect.h, "KEYS", "focus");
  for (let i = 0; i < HELP_KEYS.length && i < rect.h - 2; i += 1) {
    const [key, meaning] = HELP_KEYS[i]!;
    screen.text(rect.x + 2, rect.y + 1 + i, rect.w - 4, padTo(key, 18), "accent");
    screen.text(rect.x + 2 + 18, rect.y + 1 + i, Math.max(0, rect.w - 4 - 18), meaning, "muted");
  }
}

function paintFooter(screen: Screen, view: DashProjection, meta: BoardMeta, y: number, cols: number): void {
  if (y < 0) {
    return;
  }

  if (meta.searching) {
    screen.fill(0, y, cols, 1, " ", "header");
    screen.text(1, y, cols - 2, `/${meta.query ?? ""}█  (Enter keep, Esc clear)`, "match");
    return;
  }
  // The HOST line is chrome, not a pane: a dead sampler must be visible even
  // on a board with no room for a chart (docs/observability.md).
  // No key legend here: the header carries it, and repeating it was what
  // pushed the host numbers off the end of a narrow board.
  const notice = visibleNotice(meta);
  if (notice && meta.inputDraft === undefined) {
    screen.fill(0, y, cols, 1, " ", "banner");
    screen.text(1, y, cols - 2, ellipsize(notice, cols - 2), "banner");
    return;
  }
  if (meta.noteError) {
    screen.fill(0, y, cols, 1, " ", "banner");
    screen.text(1, y, cols - 2, ellipsize(`\u2716 ${meta.noteError}`, cols - 2), "banner");
    return;
  }
  const queued = meta.pendingNotes ?? 0;
  const inFlight = meta.inFlightNotes ?? 0;
  const queueLabel = `note queued ${queued}`;
  const inFlightLabel = `note in flight ${inFlight}`;
  const bits = [
    queued > 0 ? queueLabel : undefined,
    inFlight > 0 ? inFlightLabel : undefined,
    hostBarLine(view),
    toolsBarLine(view),
    remoteLine(view),
    `wiki ${knowledgeLine(view)}`,
    pluginLine(view),
    meta.url,
  ].filter((bit): bit is string => Boolean(bit));
  screen.text(1, y, cols - 2, ellipsize(bits.join("   "), cols - 2), "muted");
  if (queued > 0 || inFlight > 0) {
    // The count is the one thing on this row an operator is waiting on.
    const label = [queued > 0 ? queueLabel : undefined, inFlight > 0 ? inFlightLabel : undefined]
      .filter((value): value is string => value !== undefined)
      .join("   ");
    screen.text(1, y, Math.min(cols - 2, label.length), label, "ember");
  }
  // The match cursor (#51): which of how many hits the focused pane holds.
  // Only while a query is live — otherwise the corner is the host line's.
  if (meta.query !== undefined && meta.focus !== undefined) {
    const widget = widgetById(meta.focus);
    if (widget) {
      const ctx = ctxFor(widget, view, meta, Math.max(20, cols - 2), 4_000, meta.now ?? Date.now());
      const cursor = matchCursor(widget.lines(ctx), meta.query, meta.matchIdx?.[meta.focus]);
      if (cursor.total > 0 && cursor.index !== undefined) {
        const label = `${cursor.index + 1}/${cursor.total}`;
        screen.text(Math.max(1, cols - 2 - label.length), y, cols - 2, label, "match");
      }
    }
  }
}

export { pluginLine };
export type { StreamLine } from "./stream-ast.ts";
