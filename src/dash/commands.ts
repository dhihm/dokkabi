import type { ModelPickerCandidate, UiAction, UiState } from "./keymap.ts";
import type { WidgetId } from "./widgets.ts";
import { currentThemeName, themeNames } from "./theme.ts";

/**
 * Slash commands.
 *
 * The board's keys and the note prompt want the same characters: typing "1"
 * into a note must not focus a pane. Modal input solves that today, but the
 * prompt is meant to become always-on, and then every printable key belongs
 * to the text. So board actions move behind a leading slash, where they can
 * never collide with prose, and they announce themselves through completion
 * instead of having to be memorised.
 */

export interface SlashResult {
  state: UiState;
  action?: UiAction;
  /** Shown to the operator when the command could not be carried out. */
  notice?: string;
}

export interface SlashCommand {
  name: string;
  summary: string;
  /** Extra spellings that resolve to this command. */
  aliases?: readonly string[];
  /** Candidates for what is typed after the command word. Declaring this is
   * what makes Tab complete arguments — commands without one keep the
   * word-itself suggestion and nothing more. */
  completeArgs?: (args: string, env?: SlashEnv, state?: UiState) => readonly Completion[];
  run(state: UiState, args: string, env: SlashEnv): SlashResult;
}

export interface SlashEnv {
  visible: readonly WidgetId[];
  viewport: number;
  routes?: readonly string[];
  effortLevels?: readonly string[];
  /** Session names for the `/session` completer and usage notice. */
  sessions?: readonly string[];
  routeSummaries?: Readonly<Record<string, string>>;
  authRoutes?: readonly string[];
  authSummaries?: Readonly<Record<string, string>>;
  /** Hierarchical picker details (recent/favorite route/model pairs) so
   * `/model` argument completion can offer concrete models, not just routes. */
  modelDetails?: readonly ModelPickerCandidate[];
}

/**
 * Pane names an operator would type. The board shows WORK and MODEL STREAM
 * while the widget ids are `plan` and `stream`, and nobody pluralises
 * consistently, so both readings resolve.
 */
const PANE_NAMES: Record<string, WidgetId> = {
  alert: "alerts",
  alerts: "alerts",
  work: "plan",
  plan: "plan",
  todo: "plan",
  todos: "plan",
  stream: "stream",
  model: "stream",
  reply: "stream",
  event: "events",
  events: "events",
  tool: "tools",
  tools: "tools",
  token: "tokens",
  tokens: "tokens",
  timeline: "timeline",
  context: "context",
};

export function paneNamed(name: string): WidgetId | undefined {
  return PANE_NAMES[name.trim().toLowerCase()];
}

/**
 * The spelling to suggest for each pane — the word the board actually shows,
 * so completion teaches the label rather than an internal id or an alias.
 */
const PANE_CANONICAL: readonly { spelling: string; pane: WidgetId }[] = [
  { spelling: "alerts", pane: "alerts" },
  { spelling: "work", pane: "plan" },
  { spelling: "stream", pane: "stream" },
  { spelling: "events", pane: "events" },
  { spelling: "tools", pane: "tools" },
  { spelling: "tokens", pane: "tokens" },
  { spelling: "timeline", pane: "timeline" },
  { spelling: "context", pane: "context" },
];

/** Every accepted pane spelling. */
export function paneSpellings(): string[] {
  return Object.keys(PANE_NAMES).sort();
}

/** A leading `/word` — not a path pasted into the middle of a note. */
// Hangul joins ASCII in command names so `/두레` works like `/freeswarm`;
// paths (`/tmp/...`) still fail the word-boundary check and stay prose.
export function isSlash(text: string): boolean {
  return /^\s*\/[\p{Script=Hangul}a-zA-Z][\p{Script=Hangul}a-zA-Z-]*(\s|$)/u.test(text);
}

/**
 * A bare CLI-style flag typed into the prompt (`--help`, `-h`, `--version`).
 * These are habits from the shell, not questions for the model — one reached
 * the model live and burned a turn answering "--help" as prose. The board
 * answers them itself. Only a LONE flag counts: "--help me understand this"
 * is a real request and stays a note.
 */
export function looksLikeCliFlag(text: string): boolean {
  return /^\s*-{1,2}[A-Za-z][A-Za-z-]*\s*$/u.test(text);
}

export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\s*\/([\p{Script=Hangul}a-zA-Z][\p{Script=Hangul}a-zA-Z-]*)\s*([\s\S]*)$/u.exec(text);
  if (!match) {
    return undefined;
  }
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}

function focusPane(state: UiState, pane: WidgetId, zoom: boolean): SlashResult {
  return { state: { ...state, focus: pane, zoom } };
}

function paneCommand(name: string, pane: WidgetId, summary: string): SlashCommand {
  // The same command closes what it opened (operator report: /alerts had no
  // off switch), mirroring the digit-key toggle.
  return {
    name,
    summary,
    run: (state) =>
      state.focus === pane
        ? { state: { ...state, focus: undefined, zoom: false } }
        : focusPane(state, pane, false),
  };
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "zoom",
    summary: "expand one pane full-screen — /zoom alerts",
    completeArgs: (args) => {
      // Match on any accepted spelling, but suggest the one the board shows.
      const out: Completion[] = [];
      for (const entry of PANE_CANONICAL) {
        const matches =
          entry.spelling.startsWith(args) ||
          paneSpellings().some((spelling) => spelling.startsWith(args) && paneNamed(spelling) === entry.pane);
        if (matches) {
          out.push({ name: `zoom ${entry.spelling}`, summary: `expand the ${entry.spelling.toUpperCase()} pane` });
        }
      }
      return out;
    },
    run: (state, args, env) => {
      if (args === "") {
        const target = state.focus ?? (env.visible.includes("stream") ? "stream" : env.visible[0]);
        return target === undefined
          ? { state, notice: "nothing to zoom" }
          : { state: { ...state, focus: target, zoom: true } };
      }
      const pane = paneNamed(args);
      return pane === undefined
        ? { state, notice: `no pane called "${args}"` }
        : focusPane(state, pane, true);
    },
  },
  paneCommand("alerts", "alerts", "focus the ALERTS pane"),
  paneCommand("work", "plan", "focus the WORK pane"),
  paneCommand("stream", "stream", "focus MODEL STREAM"),
  paneCommand("events", "events", "focus the EVENTS pane"),
  paneCommand("tools", "tools", "focus the TOOLS pane"),
  paneCommand("tokens", "tokens", "focus the TOKENS pane"),
  {
    name: "find",
    summary: "highlight matching lines everywhere — /find qdp",
    run: (state, args) => ({
      state: { ...state, searching: false, query: args === "" ? undefined : args },
    }),
  },
  {
    name: "debug",
    summary: "bring TOKENS and CONTEXT forward",
    run: (state) => ({ state: { ...state, debug: !state.debug } }),
  },
  {
    name: "keys",
    summary: "show the key map",
    aliases: ["help"],
    run: (state) => ({ state: { ...state, help: !state.help } }),
  },
  {
    // The footer shows only the latest notice; this overlay is where the ones
    // it erased go to be read (#dokkabi-dev#45).
    name: "notices",
    summary: "show recent notices",
    run: (state) => ({ state: { ...state, noticesView: !state.noticesView } }),
  },
  {
    name: "back",
    summary: "clear focus, zoom and search",
    run: (state) => ({ state: { ...state, focus: undefined, zoom: false, query: undefined, help: false } }),
  },
  {
    name: "model",
    summary: "search or set any route/model — /model",
    completeArgs: (args, env) => {
      // Two stages, mirroring the hierarchical picker: providers first, the
      // chosen provider's models after it. Stage two is the argument naming
      // a route ("openrouter" or "openrouter/…"); Enter seeds that stage in
      // the keymap, so completion and the picker teach the same path.
      const text = args.trim().toLowerCase();
      const routes = env?.routes ?? [];
      const details = env?.modelDetails ?? [];
      const provider = routes.find((route) => {
        const lower = route.toLowerCase();
        return text === lower || text.startsWith(`${lower}/`);
      });
      if (provider !== undefined) {
        const rest = text.slice(provider.length + 1);
        const seen = new Set<string>();
        return details
          .filter((detail) => detail.kind === "model" && detail.route === provider)
          .sort((left, right) => sectionRank(left.section) - sectionRank(right.section))
          .filter((detail) => {
            if (seen.has(detail.value)) return false;
            seen.add(detail.value);
            return true;
          })
          .filter((detail) => detail.value.slice(provider.length + 1).toLowerCase().startsWith(rest))
          .map((detail) => ({ name: `model ${detail.value}`, summary: detail.summary }));
      }
      return routes
        .filter((route) => route.toLowerCase().startsWith(text))
        .map((route) => ({ name: `model ${route}`, summary: env?.routeSummaries?.[route] ?? `set ${route}` }));
    },
    run: (state, args) => ({ state, action: { type: "route", text: args.trim() } }),
  },
  {
    name: "effort",
    summary: "show or set reasoning effort — /effort high",
    completeArgs: (args, env) => (env?.effortLevels ?? [])
      .filter((level) => level.startsWith(args))
      .map((level) => ({ name: `effort ${level}`, summary: `set reasoning effort to ${level}` })),
    run: (state, args) => ({ state, action: { type: "effort", level: args.trim() } }),
  },
  {
    name: "limits",
    summary: "show model quota windows; refresh explicitly — /limits refresh",
    aliases: ["quota"],
    completeArgs: (args) => [
      { name: "limits refresh", summary: "refresh provider-reported quota before showing it" },
    ].filter((candidate) => candidate.name.slice("limits ".length).startsWith(args)),
    run: (state, args) => {
      const command = args.trim().toLowerCase();
      if (command === "") return { state, action: { type: "limits" } };
      if (command === "refresh") return { state, action: { type: "limits", refresh: true } };
      return { state, notice: "usage: /limits [refresh]" };
    },
  },
  {
    name: "failover",
    summary: "show or set explicit model failover — /failover off",
    completeArgs: (args) => [
      { name: "failover status", summary: "show primary, active, quota and policy state" },
      { name: "failover off", summary: "stop on the active model's error" },
      { name: "failover on", summary: "arm an already configured automatic policy" },
      { name: "failover ask", summary: "ask before an approved route/model switch" },
      { name: "failover auto", summary: "switch through an explicit candidate list" },
      { name: "failover auto free-only", summary: "use provider-verified free candidates only" },
      { name: "failover approve", summary: "approve the waiting candidate" },
      { name: "failover reject", summary: "reject the waiting transition" },
      { name: "failover configure", summary: "show or apply the complete versioned policy" },
    ].filter((candidate) => candidate.name.slice("failover ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "failover", text: args.trim() } }),
  },
  {
    name: "ssh",
    summary: "show or resolve a pending SSH approval — /ssh status",
    completeArgs: (args) => [
      { name: "ssh status", summary: "show SSH availability and pending approval" },
      { name: "ssh approve once", summary: "allow only the waiting remote command" },
      { name: "ssh approve session", summary: "allow that logical target for this chat session" },
      { name: "ssh deny", summary: "deny the waiting command without starting SSH" },
    ].filter((candidate) => candidate.name.slice("ssh ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "ssh", text: args.trim() } }),
  },
  {
    name: "github-admin",
    summary: "manage private repository owners and approvals — /github-admin status",
    completeArgs: (args) => [
      { name: "github-admin status", summary: "show owner policy and private repository approval state" },
      { name: "github-admin allow OWNER", summary: "persistently authorize an account or organization" },
      { name: "github-admin remove OWNER", summary: "revoke persistent repository-creation authority" },
      { name: "github-admin allow-repo OWNER/REPO", summary: "persistently authorize workspace publishing to one private repository" },
      { name: "github-admin remove-repo OWNER/REPO", summary: "revoke workspace publishing authority for one repository" },
      { name: "github-admin allow-push-repo OWNER/REPO", summary: "persistently authorize current-branch pushes to one private repository" },
      { name: "github-admin remove-push-repo OWNER/REPO", summary: "revoke current-branch push authority for one repository" },
      { name: "github-admin approve once", summary: "allow only the waiting private repository creation" },
      { name: "github-admin deny", summary: "deny the waiting creation without mutating GitHub" },
    ].filter((candidate) => candidate.name.slice("github-admin ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "github-admin", text: args.trim() } }),
  },
  {
    name: "mcp",
    summary: "inspect, approve, or revoke MCP capabilities — /mcp status",
    completeArgs: (args) => [
      { name: "mcp status", summary: "show enrolled servers and pending capability requests" },
      { name: "mcp approve once", summary: "approve the waiting enrollment or one tool call" },
      { name: "mcp approve session", summary: "approve the waiting exact server/tool for this chat session" },
      { name: "mcp deny", summary: "deny the waiting request without starting the external action" },
      { name: "mcp remove NAME", summary: "revoke and disconnect one enrolled MCP server" },
    ].filter((candidate) => candidate.name.slice("mcp ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "mcp", text: args.trim() } }),
  },
  {
    name: "plugin",
    summary: "inspect, approve, or remove managed skill plugins — /plugin status",
    completeArgs: (args) => [
      { name: "plugin status", summary: "show installed managed skills and a pending install" },
      { name: "plugin approve once", summary: "approve the exact waiting skill installation" },
      { name: "plugin deny", summary: "deny without persisting external content" },
      { name: "plugin remove ID", summary: "remove one installed managed skill and its exact stored bytes" },
    ].filter((candidate) => candidate.name.slice("plugin ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "plugin", text: args.trim() } }),
  },
  {
    name: "permissions",
    summary: "show or set session approval mode — /permissions status",
    completeArgs: (args) => [
      { name: "permissions status", summary: "show approval mode and sandbox enforcement" },
      { name: "permissions ask", summary: "require operator approval for gated actions" },
      { name: "permissions bypass", summary: "skip approval prompts for this session only" },
    ].filter((candidate) => candidate.name.slice("permissions ".length).startsWith(args)),
    run: (state, args) => {
      const command = args.trim().toLowerCase();
      if (command === "" || command === "status" || command === "ask" || command === "bypass") {
        return { state, action: { type: "permissions", text: command || "status" } };
      }
      return { state, notice: "usage: /permissions [status|ask|bypass]" };
    },
  },
  {
    name: "resume",
    summary: "inspect or rebuild saved context — /resume --reseed",
    completeArgs: (args) => [
      { name: "resume status", summary: "inspect compatibility with the current model surface" },
      { name: "resume --reseed", summary: "rebuild bounded context from durable session history" },
    ].filter((candidate) => candidate.name.slice("resume ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "resume", text: args.trim() } }),
  },
  {
    name: "login",
    summary: "show accounts or run provider sign-in — /login",
    completeArgs: (args, env) => {
      // Two stages like /model: providers first, the chosen provider's
      // sign-in methods (route@oauth, route@api_key) once the argument
      // carries the @ that separates them.
      const text = args.trim().toLowerCase();
      return (env?.authRoutes ?? [])
        .filter((route) => route.includes("@") === text.includes("@"))
        .filter((route) => route.toLowerCase().startsWith(text))
        .map((route) => ({ name: `login ${route}`, summary: env?.authSummaries?.[route] ?? "provider login" }));
    },
    run: (state, args) => ({ state, action: { type: "login", route: args.trim() } }),
  },
  {
    name: "logout",
    summary: "remove a stored provider credential — /logout",
    completeArgs: (args, env) =>
      (env?.authRoutes ?? [])
        .filter((route) => !route.includes("@"))
        .filter((route) => route.toLowerCase().startsWith(args))
        .map((route) => ({ name: `logout ${route}`, summary: env?.authSummaries?.[route] ?? "provider logout" })),
    run: (state, args) => ({ state, action: { type: "logout", route: args.trim() } }),
  },
  {
    // Representation-layer only: a theme change never touches the observed
    // log, so unlike every other stateful command this one is allowed to act
    // in attach and replay modes too. Validation happens here so the loop
    // handler can apply without re-judging (#dokkabi-dev#50).
    name: "theme",
    summary: "show or set the board theme — /theme nord",
    completeArgs: (args) =>
      themeNames()
        .filter((candidate) => candidate.startsWith(args))
        .map((candidate) => ({ name: `theme ${candidate}`, summary: `switch the board theme to ${candidate}` })),
    run: (state, args) => {
      const name = args.trim();
      if (name === "") {
        return {
          state,
          notice: `theme: ${currentThemeName()} (candidates: ${themeNames().join(", ")})`,
        };
      }
      const known = themeNames().some((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (!known) {
        return {
          state,
          notice: `unknown theme "${name}" — candidates: ${themeNames().join(", ")}`,
        };
      }
      return { state, action: { type: "theme", name } };
    },
  },
  {
    name: "heung",
    summary: "show or control bounded completion — /heung on",
    completeArgs: (args) => [
      { name: "heung on", summary: "keep planning remaining work until done" },
      { name: "heung off", summary: "stop after the current wave" },
    ].filter((candidate) => candidate.name.slice("heung ".length).startsWith(args)),
    run: (state, args) => {
      const value = args.trim().toLowerCase();
      if (value === "") return { state, action: { type: "heung" } };
      if (value === "on") return { state, action: { type: "heung", enabled: true } };
      if (value === "off") return { state, action: { type: "heung", enabled: false } };
      return { state, notice: "usage: /heung [on|off]" };
    },
  },
  {
    name: "freeswarm",
    aliases: ["두레"],
    summary: "run the free-model role pipeline — /두레 <task>",
    run: (state, args) => {
      const task = args.trim();
      if (task === "") return { state, notice: "usage: /두레 <task> (alias /freeswarm) — free-model role pipeline" };
      return { state, action: { type: "freeswarm", text: task } };
    },
  },
  {
    name: "wiki",
    aliases: ["knowledge"],
    summary: "show or search the configured knowledge vault — /wiki search cache",
    completeArgs: (args) => [
      { name: "wiki status", summary: "show safe vault status" },
      { name: "wiki search", summary: "search durable knowledge" },
      { name: "wiki lint", summary: "show ontology lint totals" },
      { name: "wiki profiles", summary: "list safe profile aliases" },
      { name: "wiki select", summary: "select an existing profile alias" },
      { name: "wiki verify", summary: "verify the active profile safely" },
      { name: "wiki init", summary: "create and attach a local vault" },
      { name: "wiki attach", summary: "attach an existing Git or Obsidian vault" },
    ].filter((candidate) => candidate.name.slice("wiki ".length).startsWith(args)),
    run: (state, args) => ({ state, action: { type: "knowledge", text: args.trim() } }),
  },
  {
    // The default keeps drag selection native (D-2026-08-25-91); this is the
    // live opt-in for wheel capture, so the choice no longer needs a restart.
    name: "mouse",
    summary: "wheel scroll and terminal-native drag (default) — /mouse capture|native",
    completeArgs: (args) => [
      { name: "mouse wheel", summary: "wheel scrolls the stream, drag stays the terminal's (default)" },
      { name: "mouse capture", summary: "the app owns drag too — selects and copies via OSC 52" },
      { name: "mouse native", summary: "the terminal owns the mouse entirely; no wheel capture" },
      { name: "mouse status", summary: "show the current mouse mode" },
    ].filter((candidate) => candidate.name.slice("mouse ".length).startsWith(args)),
    run: (state, args) => {
      const value = args.trim().toLowerCase();
      if (value === "" || value === "status") return { state, action: { type: "mouse" } };
      // `on`/`off` kept: they are in muscle memory and in older notes.
      if (value === "capture" || value === "on") {
        return { state, action: { type: "mouse", enabled: true, mode: "capture" } };
      }
      if (value === "wheel") return { state, action: { type: "mouse", enabled: true, mode: "wheel" } };
      if (value === "native" || value === "off") {
        return { state, action: { type: "mouse", enabled: false, mode: "native" } };
      }
      return { state, notice: "usage: /mouse [wheel|capture|native|status]" };
    },
  },
  {
    name: "quit",
    summary: "close the board",
    aliases: ["q", "exit"],
    run: (state) => ({ state, action: { type: "quit" } }),
  },
  {
    // Switching what the board watches (#47). The loop resolves the name and
    // refuses on an interactive board — the note seam belongs to another
    // session.
    name: "session",
    summary: "switch the watched session — /session <name>",
    completeArgs: (args, env) =>
      (env?.sessions ?? [])
        .filter((candidate) => candidate.startsWith(args))
        .map((candidate) => ({ name: `session ${candidate}`, summary: `watch session ${candidate}` })),
    run: (state, args, env) => {
      const name = args.trim();
      if (name === "") {
        const known = env.sessions?.length ? ` — ${env.sessions.join(", ")}` : "";
        return { state, notice: `usage: /session <name>${known}` };
      }
      return { state, action: { type: "session", name } };
    },
  },
  {
    // Per-pane line filter (#48): the needle applies to the focused pane,
    // `off` clears it. Filtering is not searching — it removes lines instead
    // of lighting them.
    name: "filter",
    summary: "keep only matching lines in the focused pane — /filter zeta, /filter off",
    run: (state, args) => {
      const text = args.trim();
      if (text === "") {
        return { state, notice: "usage: /filter <text> — clears with /filter off" };
      }
      if (state.focus === undefined) {
        return { state, notice: "focus a pane first (Tab or /zoom)" };
      }
      if (text.toLowerCase() === "off") {
        const filters = { ...state.filters };
        delete filters[state.focus];
        return { state: { ...state, filters } };
      }
      return { state: { ...state, filters: { ...state.filters, [state.focus]: text } } };
    },
  },
  {
    // Persists the operator overrides to layout.json (#49). The loop owns the
    // write; replay boards refuse there because a recorded past is not the
    // place to persist preferences.
    name: "layout",
    summary: "persist the pane layout — /layout save",
    completeArgs: (args) =>
      args === "" || "save".startsWith(args)
        ? [{ name: "layout save", summary: "write the current layout overrides to layout.json" }]
        : [],
    run: (state, args) => {
      if (args.trim().toLowerCase() !== "save") {
        return { state, notice: "usage: /layout save" };
      }
      return { state, action: { type: "layout-save" } };
    },
  },
];

const BY_NAME = new Map<string, SlashCommand>();
for (const command of SLASH_COMMANDS) {
  BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    BY_NAME.set(alias, command);
  }
}

/** Whether completing `/name` should append a space: the command declares
 * argument completions, or takes free text the operator types next. */
export function commandTakesArgument(name: string): boolean {
  const command = BY_NAME.get(name.toLowerCase());
  if (!command) return false;
  return command.completeArgs !== undefined || command.name === "find" || command.name === "filter";
}

export function runSlash(state: UiState, text: string, env: SlashEnv): SlashResult {
  const parsed = parseSlash(text);
  if (!parsed) {
    return { state, notice: "not a command" };
  }
  const command = BY_NAME.get(parsed.name);
  if (!command) {
    return { state, notice: `unknown command /${parsed.name} — /keys lists them` };
  }
  return command.run(state, parsed.args, env);
}

export interface Completion {
  name: string;
  summary: string;
}

/**
 * Suggestions for what is typed so far. `/zoom al` completes pane names, not
 * command names, because that is the word the operator is in the middle of.
 *
 * Command words match by prefix first, then by subsequence once at least two
 * characters are typed — `/fs` reaches freeswarm without hiding the fact that
 * prefix matches come first. Argument stages stay prefix-only: their
 * candidates are declared per command and subsequence noise there buys
 * nothing.
 */
export function completeSlash(text: string, env?: SlashEnv, state?: UiState): readonly Completion[] {
  if (!/^\s*\//.test(text)) {
    return [];
  }
  const body = text.replace(/^\s*\//, "");
  const spaceAt = body.indexOf(" ");
  if (spaceAt === -1) {
    const lower = body.toLowerCase();
    // An exact command word that declares argument completions: completing
    // the word with itself adds nothing, so surface its arguments instead.
    const exact = lower === "" ? undefined : BY_NAME.get(lower);
    if (exact?.completeArgs) {
      return exact.completeArgs("", env, state);
    }
    const prefix = SLASH_COMMANDS.filter((command) => command.name.startsWith(lower));
    const fuzzy = [...lower].length >= 2
      ? SLASH_COMMANDS.filter((command) => !command.name.startsWith(lower) && isSubsequence(lower, command.name))
      : [];
    return [...prefix, ...fuzzy].map((command) => ({
      name: command.name,
      summary: command.summary,
    }));
  }
  const name = body.slice(0, spaceAt).toLowerCase();
  const argPrefix = body.slice(spaceAt + 1).trim().toLowerCase();
  const command = BY_NAME.get(name);
  if (!command?.completeArgs) {
    return [];
  }
  return command.completeArgs(argPrefix, env, state);
}

/** Every needle character appears in order somewhere in the haystack. */
function isSubsequence(needle: string, haystack: string): boolean {
  const wanted = [...needle.toLowerCase()];
  let at = 0;
  for (const glyph of haystack.toLowerCase()) {
    if (at < wanted.length && glyph === wanted[at]) {
      at += 1;
    }
  }
  return at >= wanted.length;
}

/** Stage-two model order: favorites the operator starred, then what they
 * recently used, then the catalog. Lower sorts first. */
function sectionRank(section: string | undefined): number {
  if (section === "favorite") return 0;
  if (section === "recent") return 1;
  return 2;
}
