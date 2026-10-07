import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { EventLog } from "../host/event-log.ts";
import {
  blobGcLines,
  compactionLines,
  maekLine,
  eventLines,
  hostLines,
  toolLines,
  toolMaxLines,
  toolSlowLines,
  usagePaneLines,
  workDetailLines,
  workHeaderLines,
} from "./cells.ts";
import { renderTodoDag } from "./dag.ts";
import { followLog } from "./follow.ts";
import { alertLines, drawHostCharts, tokenStackLines } from "./graphs.ts";
import { listModelLedger, modelsPaneLines } from "./model-ledger.ts";
import { sessionsRootPaneLines } from "./sessions.ts";
import { projectDash, type DashProjection } from "./project.ts";
import { Screen, wrapText, type Tone } from "./screen.ts";
import { toneForLine } from "./status.ts";
import { ttyPaintSequence } from "./tty-paint.ts";

export const PANE_CELLS = ["work", "dag", "sessions", "models", "tokens", "host", "tools", "events", "alerts"] as const;
export type PaneCell = (typeof PANE_CELLS)[number];

export function isPaneCell(value: string): value is PaneCell {
  return (PANE_CELLS as readonly string[]).includes(value);
}

export interface PaneMeta {
  path: string;
  replay: boolean;
  cols: number;
  rows: number;
  color?: boolean;
  /** Sessions root for the sessions cell; derived from path when absent. */
  sessionsRoot?: string;
}

/** Content lines for one cell. Every value is projected from the EventLog. */
export function paneLines(
  view: DashProjection,
  cell: PaneCell,
  cols: number,
  sessionsRoot?: string,
): string[] {
  const width = Math.max(10, cols - 2);
  switch (cell) {
    case "work":
      return [
        ...workHeaderLines(view).flatMap((row) => wrapText(row, width)),
        ...workDetailLines(view).flatMap((row) => wrapText(row, width)),
      ];
    case "dag": {
      const plan = view.plan;
      if (!plan || plan.todos.length === 0) {
        return ["no plan in log  work/goal missing"];
      }
      const state: Record<string, string> = {};
      for (const row of view.work.todos) {
        state[row.id] = row.state;
      }
      const drawn = renderTodoDag(plan.todos, state, width);
      return Array.isArray(drawn) ? drawn : drawn.lines;
    }
    case "tokens":
      return [
        // The dedicated tokens pane IS the debug drawer: full counters.
        ...usagePaneLines(view, { debug: true }),
        "",
        ...tokenStackLines(view.requests, Math.min(48, width)),
      ];
    case "host":
      return [...hostLines(view), ""];
    case "tools":
      return [
        ...toolMaxLines(view),
        ...toolSlowLines(view),
        ...toolLines(view, 6),
        ...compactionLines(view, 2),
        ...blobGcLines(view, 2),
        ...(maekLine(view) ? [maekLine(view)] : []),
      ];
    case "events":
      return eventLines(view, 40);
    case "sessions":
      return sessionsRootPaneLines(sessionsRoot ?? "", width);
    case "models":
      return modelsPaneLines(listModelLedger(sessionsRoot ?? ""), width, Date.now());
    case "alerts": {
      const lines = alertLines(view);
      return lines.length === 0 ? ["none"] : lines;
    }
  }
}

export function renderPaneScreen(view: DashProjection, cell: PaneCell, meta: PaneMeta): string {
  const cols = Math.max(1, Math.floor(meta.cols));
  const rows = Math.max(1, Math.floor(meta.rows));
  const screen = new Screen(cols, rows);
  const mode = meta.replay ? "replay" : "live";
  screen.fill(0, 0, cols, 1, " ", "header");
  screen.text(
    1,
    0,
    cols - 2,
    `${cell.toUpperCase()}  mode=${mode}  session=${view.session}  status=${view.work.agentStatus}`,
    "header",
  );
  const lines = paneLines(view, cell, cols, meta.sessionsRoot ?? dirname(dirname(meta.path))).slice(0, Math.max(0, rows - 2));
  for (let i = 0; i < lines.length; i += 1) {
    screen.text(1, 1 + i, cols - 2, ` ${lines[i]}`, paneLineTone(cell, lines[i]!));
  }
  if (cell === "host") {
    const startY = 1 + lines.length;
    drawHostCharts(screen, 1, startY, cols - 2, rows - 1 - startY, view);
  }
  screen.text(1, rows - 1, cols - 2, `q quit  log=${meta.path}`, "muted");
  return screen.render(meta.color === true);
}

function paneLineTone(cell: PaneCell, line: string): Tone {
  if (cell === "alerts") {
    if (line === "none") {
      return "ok";
    }
    return line.startsWith("host_missing") || line.startsWith("compaction_unsealed") ? "bad" : "ember";
  }
  const marked = toneForLine(line);
  if (marked) {
    return marked;
  }
  if (line.startsWith("hit=") || line.includes("hit=") || /\breq\d+\b/.test(line)) {
    return "ember";
  }
  if (line === "(empty)" || line === "(none)" || line.startsWith("missing")) {
    return "muted";
  }
  if (line.startsWith("slow ") || line.includes("err=1")) {
    return "bad";
  }
  return "default";
}

/** Render one pane cell and follow the log until quit. */
export async function runPane(options: {
  cell: PaneCell;
  path: string;
  replay: boolean;
  once?: boolean;
}): Promise<void> {
  if (!existsSync(options.path)) {
    throw new Error(`no EventLog at ${options.path}`);
  }
  const tty = Boolean(process.stdout.isTTY) && !options.once;
  let closed = false;
  let stopFollow = () => {};
  const onResize = () => requestPaint();
  const restore = () => {
    if (closed) {
      return;
    }
    closed = true;
    stopFollow();
    try {
      if (tty && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // ignore
    }
    if (process.stdin.readable) {
      process.stdin.pause();
    }
    process.stdin.removeAllListeners("data");
    process.stdout.removeListener("resize", onResize);
    if (tty) {
      process.stdout.write("\x1b[?25h\x1b[?7h\x1b[?1049l\r\n");
    }
  };

  if (tty) {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
  }

  const onSigint = () => {
    restore();
    process.exit(0);
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  let scheduled = false;
  const requestPaint = () => {
    if (closed || scheduled) {
      return;
    }
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (!closed) {
        paint();
      }
    });
  };

  const paint = () => {
    try {
      const log = new EventLog(options.path);
      const view = projectDash(log.events);
      if (tty) {
        const cols = process.stdout.columns ?? 80;
        const rows = process.stdout.rows ?? 24;
        const frame = renderPaneScreen(view, options.cell, { ...options, cols, rows, color: true });
        process.stdout.write(ttyPaintSequence(frame, cols, rows, process.env.DOKKABI_NO_SYNC !== "1"));
        return;
      }
      const lines = paneLines(view, options.cell, 118, dirname(dirname(options.path)));
      const chartRows = options.cell === "host" ? 8 : 0;
      process.stdout.write(
        `${renderPaneScreen(view, options.cell, {
          ...options,
          cols: 120,
          rows: lines.length + 3 + chartRows,
          color: false,
        })}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (tty) {
        process.stdout.write(`\x1b[H\x1b[JDOKKABI  pane ${options.cell} read failed\nerror     ${message}\n`);
        return;
      }
      process.stderr.write(`pane ${options.cell} read failed: ${message}\n`);
    }
  };

  paint();
  if (options.once) {
    restore();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
    return;
  }
  if (!process.stdout.isTTY) {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => {
        restore();
        resolve();
      });
    });
    return;
  }

  process.stdout.on("resize", onResize);
  stopFollow = followLog(options.path, () => requestPaint());
  await new Promise<void>((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === "Q" || key === "\u0003") {
        restore();
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigint);
        resolve();
      }
    });
  });
}
