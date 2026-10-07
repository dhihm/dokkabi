import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaneCell } from "../dash/pane.ts";

export type BoardLayoutName = "grid" | "focus" | "tall";

export type TmuxRunner = (
  argv: string[],
  options?: { inherit?: boolean },
) => { exitCode: number; stdout: string };

export interface BoardPaneSpec {
  cell: PaneCell;
  /** Pane this one splits. Undefined only for the first pane. */
  from?: PaneCell;
  split?: "h" | "v";
  /** Size percentage passed to split-window -p. */
  percent: number;
}

export const BOARD_LAYOUTS: Record<BoardLayoutName, readonly BoardPaneSpec[]> = {
  grid: [
    { cell: "dag", percent: 0 },
    { cell: "tokens", from: "dag", split: "h", percent: 38 },
    { cell: "host", from: "tokens", split: "v", percent: 50 },
    { cell: "tools", from: "dag", split: "v", percent: 34 },
    { cell: "events", from: "tools", split: "h", percent: 55 },
  ],
  focus: [
    { cell: "dag", percent: 0 },
    { cell: "tokens", from: "dag", split: "v", percent: 34 },
    { cell: "host", from: "tokens", split: "h", percent: 75 },
    { cell: "tools", from: "host", split: "h", percent: 66 },
    { cell: "events", from: "tools", split: "h", percent: 50 },
  ],
  tall: [
    { cell: "dag", percent: 0 },
    { cell: "tokens", from: "dag", split: "h", percent: 45 },
    { cell: "host", from: "tokens", split: "v", percent: 66 },
    { cell: "tools", from: "host", split: "v", percent: 50 },
    { cell: "events", from: "dag", split: "v", percent: 40 },
    { cell: "sessions", from: "events", split: "h", percent: 40 },
  ],
};

export function boardSessionName(sessionId: string): string {
  return `dokkabi-${sessionId}`;
}

/**
 * Deterministic tmux argv sequence: one detached session whose first process is
 * the first pane, one split per remaining pane, then pane titles and borders.
 * Pane targets use `{{pane:CELL}}` placeholders because tmux renumbers pane
 * indices by layout position; runBoard resolves them to stable pane ids (%N).
 */
export function buildTmuxScript(input: {
  session: string;
  layout: BoardLayoutName;
  paneCommand: (cell: PaneCell) => string[];
}): string[][] {
  const specs = BOARD_LAYOUTS[input.layout];
  if (!specs) {
    throw new Error(`unknown board layout ${input.layout}. Use grid, focus, or tall.`);
  }
  const name = boardSessionName(input.session);
  const [first, ...rest] = specs;
  if (!first) {
    throw new Error(`board layout ${input.layout} has no panes`);
  }
  const script: string[][] = [
    ["tmux", "new-session", "-d", "-s", name, "-n", "dokkabi", ...input.paneCommand(first.cell)],
  ];
  const spawned = new Set<PaneCell>([first.cell]);
  for (const spec of rest) {
    if (!spec.from || !spawned.has(spec.from)) {
      throw new Error(`board layout ${input.layout}: pane ${spec.cell} splits an unknown pane`);
    }
    if (!spec.split) {
      throw new Error(`board layout ${input.layout}: pane ${spec.cell} has no split direction`);
    }
    script.push([
      "tmux",
      "split-window",
      `-${spec.split}`,
      "-p",
      String(spec.percent),
      "-t",
      `{{pane:${spec.from}}}`,
      ...input.paneCommand(spec.cell),
    ]);
    spawned.add(spec.cell);
  }
  for (const spec of specs) {
    script.push(["tmux", "select-pane", "-t", `{{pane:${spec.cell}}}`, "-T", spec.cell]);
  }
  script.push(["tmux", "set-option", "-t", name, "pane-border-status", "top"]);
  script.push(["tmux", "set-option", "-t", name, "pane-border-format", " #{pane_title} "]);
  return script;
}

export interface BoardResult {
  session: string;
  created: boolean;
  attached: boolean;
}

const BOARD_REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function paneProcessArgv(
  cell: PaneCell,
  input: { sessionId?: string; replayPath?: string },
): string[] {
  const cli = resolve(BOARD_REPO_ROOT, "src", "cli.ts");
  return [
    process.execPath,
    cli,
    "pane",
    cell,
    ...(input.replayPath ? ["--replay", input.replayPath] : ["--session", input.sessionId ?? "live"]),
  ];
}

/**
 * Create (or reuse) the tmux board session and attach to it. Fails closed with
 * a clear message when tmux is missing; the single-screen `dokkabi dash`
 * remains the no-tmux dashboard.
 */
export async function runBoard(input: {
  sessionId?: string;
  layout: BoardLayoutName;
  attach: boolean;
  replayPath?: string;
  run?: TmuxRunner;
}): Promise<BoardResult> {
  const run: TmuxRunner =
    input.run ??
    ((argv, options) => {
      const result = Bun.spawnSync(argv, {
        stdio: options?.inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout?.toString() ?? "" };
    });
  const probe = run(["tmux", "-V"]);
  if (probe.exitCode !== 0) {
    throw new Error(
      "tmux is not installed or not on PATH. Install tmux or use `dokkabi dash` for the single-screen dashboard.",
    );
  }
  const sessionId = input.sessionId ?? "live";
  const session = boardSessionName(sessionId);
  const exists = run(["tmux", "has-session", "-t", session]).exitCode === 0;
  let created = false;
  if (!exists) {
    const paneCommand = (cell: PaneCell): string[] => paneProcessArgv(cell, input);
    const script = buildTmuxScript({ session: sessionId, layout: input.layout, paneCommand });
    const spawnCells = BOARD_LAYOUTS[input.layout].map((spec) => spec.cell);
    const paneIds = new Map<PaneCell, string>();
    let spawnIndex = 0;
    for (const argv of script) {
      const resolved = argv.map((token) => resolvePaneToken(token, paneIds));
      const result = run(resolved);
      if (result.exitCode !== 0) {
        throw new Error(`tmux ${argv[1]} failed with exit ${result.exitCode}`);
      }
      if (argv[1] === "new-session" || argv[1] === "split-window") {
        const cell = spawnCells[spawnIndex];
        spawnIndex += 1;
        // split-window without -d makes the new pane the active pane.
        const paneId = run(["tmux", "display-message", "-p", "-t", `${session}:0`, "#{pane_id}"]).stdout.trim();
        if (cell) {
          paneIds.set(cell, paneId);
        }
      }
    }
    created = true;
  }
  let attached = false;
  if (input.attach) {
    const result = run(["tmux", "attach-session", "-t", session], { inherit: true });
    if (result.exitCode !== 0) {
      throw new Error(`tmux attach-session failed with exit ${result.exitCode}`);
    }
    attached = true;
  }
  return { session, created, attached };
}

const PANE_TOKEN = /^\{\{pane:([a-z]+)\}\}$/;

function resolvePaneToken(token: string, paneIds: Map<PaneCell, string>): string {
  const match = PANE_TOKEN.exec(token);
  if (!match) {
    return token;
  }
  const cell = match[1] as PaneCell;
  const paneId = paneIds.get(cell);
  if (paneId === undefined) {
    throw new Error(`board pane ${cell} was not spawned before it was targeted`);
  }
  return paneId;
}
