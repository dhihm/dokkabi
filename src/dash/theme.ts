import type { Tone } from "./screen.ts";

/**
 * Semantic theme engine (issue #27, tier 3). Cells and panes speak in
 * semantic tones (Tone); a theme maps each tone to ANSI. Swapping themes
 * changes every color without touching any pane markup. Selection:
 * DOKKABI_THEME env (dokkabi | slate | nord), default dokkabi — the
 * palette the board has always worn.
 */
export type WebTokens = {
  readonly bg: string;
  readonly bg2: string;
  readonly line: string;
  readonly ink: string;
  readonly muted: string;
  readonly ember: string;
  readonly ok: string;
  readonly bad: string;
  readonly idle: string;
};

export interface DokkabiTheme {
  name: string;
  tones: Record<Tone, string>;
  web: WebTokens;
}

const DOKKABI: DokkabiTheme = {
  name: "dokkabi",
  tones: {
    default: "",
    muted: "\x1b[38;5;245m",
    ember: "\x1b[38;5;215m",
    ok: "\x1b[38;5;108m",
    bad: "\x1b[38;5;167m",
    title: "\x1b[38;5;180m",
    box: "\x1b[38;5;240m",
    header: "\x1b[48;5;236m\x1b[38;5;223m",
    banner: "\x1b[48;5;52m\x1b[38;5;217m",
    bar: "\x1b[38;5;215m",
    barEmpty: "\x1b[38;5;238m",
    lane: "\x1b[38;5;109m",
    emberDim: "\x1b[38;5;130m",
    titleDim: "\x1b[38;5;137m",
    laneDim: "\x1b[38;5;66m",
    badDim: "\x1b[38;5;52m",
    okDim: "\x1b[38;5;65m",
    chartInput: "\x1b[38;5;201m",
    chartInputDim: "\x1b[38;5;90m",
    chartModel: "\x1b[38;5;226m",
    chartModelDim: "\x1b[38;5;94m",
    chartTool: "\x1b[38;5;51m",
    chartToolDim: "\x1b[38;5;30m",
    chartBad: "\x1b[38;5;196m",
    chartBadDim: "\x1b[38;5;52m",
    thought: "\x1b[3m\x1b[38;5;242m",
    user: "\x1b[1m\x1b[38;5;250m",
    spin: "\x1b[38;5;222m",
    diffAdd: "\x1b[48;5;189m\x1b[38;5;60m",
    diffDel: "\x1b[48;5;230m\x1b[38;5;94m",
    match: "\x1b[48;5;222m\x1b[38;5;235m",
    focus: "\x1b[38;5;215m",
    accent: "\x1b[1m\x1b[38;5;223m",
    strong: "\x1b[1m\x1b[38;5;230m",
    emph: "\x1b[3m\x1b[38;5;250m",
    link: "\x1b[4m\x1b[38;5;109m",
  },
  web: {
    bg: "#0b0d10",
    bg2: "#12161c",
    line: "#242a33",
    ink: "#e6e1d6",
    muted: "#8b8578",
    ember: "#e8a54b",
    ok: "#7d9b74",
    bad: "#e85d4c",
    idle: "#6f7c8a",
  },
};

const SLATE: DokkabiTheme = {
  name: "slate",
  tones: {
    default: "",
    muted: "\x1b[38;5;244m",
    ember: "\x1b[38;5;110m",
    ok: "\x1b[38;5;71m",
    bad: "\x1b[38;5;160m",
    title: "\x1b[38;5;152m",
    box: "\x1b[38;5;238m",
    header: "\x1b[48;5;234m\x1b[38;5;153m",
    banner: "\x1b[48;5;88m\x1b[38;5;224m",
    bar: "\x1b[38;5;110m",
    barEmpty: "\x1b[38;5;236m",
    lane: "\x1b[38;5;66m",
    emberDim: "\x1b[38;5;60m",
    titleDim: "\x1b[38;5;66m",
    laneDim: "\x1b[38;5;23m",
    badDim: "\x1b[38;5;52m",
    okDim: "\x1b[38;5;22m",
    chartInput: "\x1b[38;5;201m",
    chartInputDim: "\x1b[38;5;90m",
    chartModel: "\x1b[38;5;226m",
    chartModelDim: "\x1b[38;5;94m",
    chartTool: "\x1b[38;5;51m",
    chartToolDim: "\x1b[38;5;30m",
    chartBad: "\x1b[38;5;196m",
    chartBadDim: "\x1b[38;5;52m",
    thought: "\x1b[3m\x1b[38;5;240m",
    user: "\x1b[1m\x1b[38;5;252m",
    spin: "\x1b[38;5;117m",
    diffAdd: "\x1b[48;5;189m\x1b[38;5;60m",
    diffDel: "\x1b[48;5;230m\x1b[38;5;94m",
    match: "\x1b[48;5;117m\x1b[38;5;235m",
    focus: "\x1b[38;5;110m",
    accent: "\x1b[1m\x1b[38;5;153m",
    strong: "\x1b[1m\x1b[38;5;189m",
    emph: "\x1b[3m\x1b[38;5;249m",
    link: "\x1b[4m\x1b[38;5;66m",
  },
  web: {
    bg: "#0c1116",
    bg2: "#141b22",
    line: "#24303a",
    ink: "#d7e0e8",
    muted: "#7d8b96",
    ember: "#6ea8c9",
    ok: "#5f9a6c",
    bad: "#d04a4a",
    idle: "#6f7c8a",
  },
};

const NORD: DokkabiTheme = {
  name: "nord",
  tones: {
    default: "",
    muted: "\x1b[38;5;60m",
    ember: "\x1b[38;5;179m",
    ok: "\x1b[38;5;108m",
    bad: "\x1b[38;5;131m",
    title: "\x1b[38;5;110m",
    box: "\x1b[38;5;59m",
    header: "\x1b[48;5;237m\x1b[38;5;189m",
    banner: "\x1b[48;5;95m\x1b[38;5;224m",
    bar: "\x1b[38;5;109m",
    barEmpty: "\x1b[38;5;238m",
    lane: "\x1b[38;5;73m",
    emberDim: "\x1b[38;5;136m",
    titleDim: "\x1b[38;5;60m",
    laneDim: "\x1b[38;5;23m",
    badDim: "\x1b[38;5;52m",
    okDim: "\x1b[38;5;65m",
    chartInput: "\x1b[38;5;201m",
    chartInputDim: "\x1b[38;5;90m",
    chartModel: "\x1b[38;5;226m",
    chartModelDim: "\x1b[38;5;94m",
    chartTool: "\x1b[38;5;51m",
    chartToolDim: "\x1b[38;5;30m",
    chartBad: "\x1b[38;5;196m",
    chartBadDim: "\x1b[38;5;52m",
    thought: "\x1b[3m\x1b[38;5;60m",
    user: "\x1b[1m\x1b[38;5;153m",
    spin: "\x1b[38;5;153m",
    diffAdd: "\x1b[48;5;189m\x1b[38;5;60m",
    diffDel: "\x1b[48;5;230m\x1b[38;5;94m",
    match: "\x1b[48;5;153m\x1b[38;5;236m",
    focus: "\x1b[38;5;110m",
    accent: "\x1b[1m\x1b[38;5;189m",
    strong: "\x1b[1m\x1b[38;5;231m",
    emph: "\x1b[3m\x1b[38;5;251m",
    link: "\x1b[4m\x1b[38;5;73m",
  },
  web: {
    bg: "#2e3440",
    bg2: "#3b4252",
    line: "#434c5e",
    ink: "#eceff4",
    muted: "#81a1c1",
    ember: "#ebcb8b",
    ok: "#a3be8c",
    bad: "#bf616a",
    idle: "#88c0d0",
  },
};

const THEMES: Record<string, DokkabiTheme> = {
  dokkabi: DOKKABI,
  slate: SLATE,
  nord: NORD,
};

export function themeByName(name: string | undefined): DokkabiTheme {
  return THEMES[(name ?? "").toLowerCase()] ?? DOKKABI;
}

/** Runtime override set by `/theme` (#dokkabi-dev#50). Undefined means the
 * env decides. Representation-layer only — it never touches the log, so it
 * is allowed in attach and replay modes. */
let overrideName: string | undefined;

/** Point the board at a named theme until {@link resetActiveTheme}.
 *
 * Args:
 *   name: A theme name; case-insensitive like every other theme spelling.
 *
 * Returns:
 *   true when the name is known and the override was applied, false when the
 *   name names nothing — callers surface that as a notice rather than a
 *   silent no-op or a silent fallback to dokkabi.
 */
export function setActiveTheme(name: string): boolean {
  const key = (name ?? "").toLowerCase();
  if (!THEMES[key]) {
    return false;
  }
  overrideName = key;
  return true;
}

/** Hand theme selection back to the environment. Test isolation and any
 * future "follow config again" path share this exit. */
export function resetActiveTheme(): void {
  overrideName = undefined;
}

export function activeTheme(env: NodeJS.Dict<string> = process.env): DokkabiTheme {
  if (overrideName !== undefined) {
    return themeByName(overrideName);
  }
  return themeByName(env.DOKKABI_THEME);
}

/** The name of whichever theme {@link activeTheme} would hand out — the
 * override's name when one is set, else the env's resolved name. Bare
 * `/theme` prints this as "current" so the operator can tell an override
 * from the startup default. */
export function currentThemeName(env: NodeJS.Dict<string> = process.env): string {
  return activeTheme(env).name;
}

export function themeNames(): string[] {
  return Object.keys(THEMES);
}
