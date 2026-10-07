import { commandTakesArgument, completeSlash, isSlash, looksLikeCliFlag, runSlash } from "./commands.ts";
import type { WidgetId } from "./widgets.ts";
import { KillRing } from "@dokkabi/pi-tui";
import { UndoStack } from "@dokkabi/pi-tui";
import { findWordBackward, findWordForward } from "@dokkabi/pi-tui";
import { takeHeungSignal } from "../work/heung.ts";

/**
 * Board input as a pure state machine.
 *
 * Keeping the key handling out of the terminal loop is what makes it testable:
 * `runDash` only turns bytes into calls, and every binding below is covered by
 * `tests/dash-keymap.test.ts` rather than by driving a pty.
 */

/** Editor-grade backing for the always-open prompt: an undo stack over draft
 * snapshots and an emacs kill ring. Lives on UiState so the keymap stays a
 * pure (state, key) -> state machine — the parts come from the fork
 * (#37 T4), the contract stays the keymap's. */
export interface EditingState {
  undo: UndoStack<string>;
  kills: KillRing;
  /** True right after a kill key; a non-kill edit resets it. Emacs
   * semantics: only consecutive kills accumulate into one ring entry. */
  lastWasKill?: boolean;
  /** The span the last yank inserted, in code points. yank-pop replaces
   * exactly this span (emacs semantics); any other edit clears it. */
  yankSpan?: { from: number; to: number };
}

export interface ModelPickerCandidate {
  value: string;
  summary: string;
  kind?: "route" | "model";
  route?: string;
  section?: "recent" | "favorite" | "vendor" | "catalog";
}

export interface UiState {
  /** A large-carry model switch waiting on the operator's landing choice;
   * the board renders it as the MODEL HANDOFF overlay. */
  handoffPrompt?: import("./handoff-prompt.ts").HandoffConfirmation;
  /** Application-owned drag selection (the mouse triad, D-2026-08-25-98):
   * anchor and head are 0-based screen cells; active while the button is
   * down; the highlighted range survives release until the next press. */
  selection?: { ax: number; ay: number; hx: number; hy: number; active: boolean };
  /** Pane the scroll keys drive. Undefined means the board is unfocused. */
  focus?: WidgetId;
  zoom: boolean;
  debug: boolean;
  help: boolean;
  /** Active search. Set while typing and kept after Enter. */
  query?: string;
  /** The `/` prompt is open. */
  searching: boolean;
  /** The `i` note draft. Undefined means the prompt is closed. */
  input?: string;
  /** Inside a bracketed paste: newlines are text, not a submit. */
  pasting?: boolean;
  /** Rows scrolled back from the tail, per pane. */
  scroll: Partial<Record<WidgetId, number>>;
  /** Result of the last slash command that could not be carried out. */
  notice?: string;
  /** Every notice this session produced, oldest first — capped so a long
   * session cannot grow it without bound. The footer keeps showing only the
   * latest; the ring exists because consecutive failures used to erase each
   * other before anyone read them (#dokkabi-dev#45). */
  notices?: NoticeEntry[];
  /** `/notices` overlay is open over the body. */
  noticesView?: boolean;
  /** Reverse history search is open (`Ctrl+R` on an empty draft). `at`
   * indexes into `history`; undefined means nothing matches yet and `miss`
   * says so explicitly instead of keeping a stale selection visible. */
  histSearch?: { needle: string; at?: number; miss?: boolean };
  /** Per-pane line filters set by `/filter` (#48). */
  filters?: Partial<Record<WidgetId, string>>;
  /** Search match cursor per pane (0-based into the match ring). */
  matchIdx?: Partial<Record<WidgetId, number>>;
  /** The expanded TOOLS failure row, keyed `name:seq` (#51). */
  expandedTool?: string;
  /** Caret position in the draft, counted in code points. */
  cursor?: number;
  /** Notes already sent, newest last — recalled with Ctrl+P/N. */
  history?: string[];
  /** How far back through `history` the operator has walked. */
  historyAt?: number;
  /** Exact unsent input present when history browsing began. It is restored
   * after Down/Ctrl+N walks beyond the newest submitted note. */
  historyDraft?: string;
  /** Editor parts backing undo/kill/yank; created with the board. */
  editing?: EditingState;
  /** A typed control picker is open; its draft never becomes a model note. */
  picker?: "route" | "effort" | "login" | "logout" | "auth-input";
  /** True while the picker seed text is still untouched (hint shading). */
  pickerHint?: boolean;
  /** Candidates the seam or provider prompt supplied for the picker. */
  pickerCandidates?: readonly string[];
  /** Human-readable, secret-free descriptions for picker candidates. */
  pickerSummaries?: Readonly<Record<string, string>>;
  /** Rich metadata used only by the hierarchical model picker. */
  pickerDetails?: readonly ModelPickerCandidate[];
  /** Vendor currently open inside the model picker. */
  pickerRoute?: string;
  /** Highlighted index in the filtered candidate list. */
  pickerAt?: number;
  /** Highlighted index in the slash completion list while a command draft
   * has candidates — the list below the prompt becomes navigable. Any draft
   * edit clears it; only Up/Down set it. */
  slashAt?: number;
  /** Provider prompt text shown as the input title. */
  pickerPrompt?: string;
  /** Mask the draft because it is a provider credential. */
  inputSecret?: boolean;
}

export type UiAction =
  | { type: "quit" }
  | { type: "note"; text: string }
  | { type: "route"; text: string }
  | { type: "model-favorite"; route: string; model: string }
  | { type: "effort"; level: string }
  | { type: "login"; route: string }
  | { type: "logout"; route: string }
  | { type: "auth-input"; text: string }
  | { type: "auth-cancel" }
  | { type: "theme"; name: string }
  | { type: "limits"; refresh?: boolean }
  | { type: "failover"; text: string }
  | { type: "ssh"; text: string }
  | { type: "github-admin"; text: string }
  | { type: "mcp"; text: string }
  | { type: "plugin"; text: string }
  | { type: "permissions"; text: string }
  | { type: "resume"; text: string }
  | { type: "heung"; enabled?: boolean; text?: string }
  | { type: "freeswarm"; text: string }
  | { type: "knowledge"; text: string }
  | { type: "session"; name: string }
  | { type: "layout-save" }
  | { type: "mouse"; enabled?: boolean; mode?: "capture" | "wheel" | "native" }
  | { type: "copy-selection" }
  | { type: "interrupt" };

export interface KeyEnv {
  /** Panes currently on the board, in paint order — the Tab ring. */
  visible: readonly WidgetId[];
  /** Rows of the focused pane, for PgUp / PgDn. */
  viewport: number;
  /** Panes holding a hit for the active search — the n / N ring. */
  matching?: readonly WidgetId[];
  /** Route/model names for the `/model` picker, supplied by the seam. */
  routes?: readonly string[];
  /** The complete reasoning-effort vocabulary for `/effort`. */
  effortLevels?: readonly string[];
  /** Session names for the `/session` completer and usage notice. */
  sessions?: readonly string[];
  /** Match-ring size per pane for the focused pane's query (#51). */
  matchTotals?: Partial<Record<WidgetId, number>>;
  /** Failed tool call keys (`name:seq`) the TOOLS expansion cycles through. */
  toolFailures?: readonly string[];
  routeSummaries?: Readonly<Record<string, string>>;
  modelCandidates?: readonly ModelPickerCandidate[];
  /** Same details, keyed for SlashEnv so completeSlash can offer recent and
   * favorite route/model pairs for `/model <arg>`. */
  modelDetails?: readonly ModelPickerCandidate[];
  /** Metadata-only account names for `/login` and `/logout`. */
  authRoutes?: readonly string[];
  authSummaries?: Readonly<Record<string, string>>;
  /** Injected clock for notice timestamps — replay tests stay deterministic. */
  now?: number;
}

const ESC = "\x1b";
const ETX = "";
const DEL = "";

/** g jumps to the oldest line; the window clamps this to the real length. */
const TOP = Number.MAX_SAFE_INTEGER;

/** Terminal bracketed paste markers. */
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const CTRL_U = "\u0015";
const CTRL_W = "\u0017";
const CTRL_A = "\u0001";
const CTRL_E = "\u0005";
const CTRL_P = "\u0010";
const CTRL_N = "\u000e";
const CTRL_R = "\u0012";
const CTRL_S = "\u0013";
const CTRL_UNDERSCORE = "\u001f";
const CTRL_K = "\u000b";
const CTRL_Y = "\u0019";
const ALT_Y = `${ESC}y`;
const ALT_B = `${ESC}b`;
const ALT_F = `${ESC}f`;
const ALT_D = `${ESC}d`;
/** Notes kept for recall. Long enough for a session, short enough to bound. */
const HISTORY_MAX = 50;

/** One recorded notice: what it said and when it was raised (injected clock —
 * replay tests stay deterministic). */
export interface NoticeEntry {
  text: string;
  at: number;
}

/** Same bound as history: long enough for a session, short enough to bound. */
const NOTICES_MAX = 30;

/** Record a notice in the ring AND on the single-slot footer field. Every
 * notice-raising site goes through here, or the ring drifts from what the
 * operator actually saw. */
export function setNotice(state: UiState, text: string, now = 0): UiState {
  return {
    ...state,
    notice: text,
    notices: [...(state.notices ?? []), { text, at: now }].slice(-NOTICES_MAX),
  };
}

/**
 * Drop the last user-visible character.
 *
 * `slice(0, -1)` cuts one UTF-16 code unit, which leaves half a surrogate
 * pair behind for an emoji. Splitting by code point is the minimum correct
 * unit here.
 */
function dropLastCharacter(text: string): string {
  const glyphs = [...text];
  glyphs.pop();
  return glyphs.join("");
}

/** Drop trailing whitespace and then the word before it. */
function dropLastWord(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const at = trimmed.search(/[^\s]*$/);
  return at <= 0 ? "" : trimmed.slice(0, at);
}

/**
 * A key that is a control byte rather than text. These used to be appended
 * to the draft literally and travelled all the way into the model's prompt.
 */
function isControlKey(key: string): boolean {
  if (key.length !== 1) {
    return false;
  }
  const code = key.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/**
 * Digits follow the order panes appear on the board, so the key an operator
 * guesses is the pane they are looking at. ALERTS is first: it is the pane
 * that matters most and used to be the only one with no direct key.
 */
const DIGIT_PANES: Record<string, WidgetId> = {
  "1": "alerts",
  "2": "plan",
  "3": "stream",
  "4": "events",
  "5": "tools",
  "6": "tokens",
};

export function initialUi(): UiState {
  // The prompt is always open: the board is a surface an operator types into,
  // so every printable key belongs to the text and board actions live behind
  // a slash (commands.ts). Control keys stay board controls.
  return {
    zoom: false,
    debug: false,
    help: false,
    searching: false,
    scroll: {},
    input: "",
    editing: { undo: new UndoStack<string>(), kills: new KillRing() },
  };
}

export function applyKey(state: UiState, key: string, env: KeyEnv): { state: UiState; action?: UiAction } {
  // Typing prompts own every key except their own terminators, so a note
  // containing "q" cannot quit the board.
  if (state.histSearch !== undefined && state.input !== undefined) {
    return histSearchKeys(state, key);
  }
  if (state.input !== undefined) {
    return typing(state, key, "input", env);
  }
  if (state.searching) {
    return typing(state, key, "query", env);
  }
  if (key === "q" || key === "Q" || key === ETX) {
    return { state, action: { type: "quit" } };
  }
  const wheel = parseWheel(key);
  if (wheel !== undefined) {
    return { state: scrollModelStreamBy(state, wheel * 3, env) };
  }
  const selected = mouseSelection(state, key);
  if (selected) {
    return selected;
  }
  switch (key) {
    case "\t":
      return { state: { ...state, focus: cycle(env.visible, state.focus, 1) } };
    case `${ESC}[Z`:
      return { state: { ...state, focus: cycle(env.visible, state.focus, -1) } };
    case "z":
    case "Z": {
      // Pressing z with nothing focused used to do nothing, which reads as a
      // dead key. Zoom the pane an operator most likely meant: the stream,
      // or the first one on the board.
      if (state.focus === undefined) {
        const target = env.visible.includes("stream") ? "stream" : env.visible[0];
        return target === undefined
          ? { state }
          : { state: { ...state, focus: target, zoom: true } };
      }
      return { state: { ...state, zoom: !state.zoom } };
    }
    case "?":
      return { state: { ...state, help: !state.help } };
    case "d":
    case "D":
      return { state: { ...state, debug: !state.debug } };
    case "i":
    case "I":
      return { state: { ...state, input: "" } };
    case "/":
      return { state: { ...state, searching: true, query: "" } };
    case `${ESC}[A`:
      return { state: scrollModelStreamBy(state, 3, env) };
    case `${ESC}[B`:
      return { state: scrollModelStreamBy(state, -3, env) };
    case "k":
      return { state: scrollBy(state, 1, env) };
    case "j":
      return { state: scrollBy(state, -1, env) };
    case `${ESC}[5~`:
      return { state: scrollBy(state, env.viewport, env) };
    case `${ESC}[6~`:
      return { state: scrollBy(state, -env.viewport, env) };
    case "n":
      return { state: hop(state, env, 1) };
    case "N":
      return { state: hop(state, env, -1) };
    case "g":
      return { state: setScroll(state, TOP) };
    case "G":
      return { state: setScroll(state, 0) };
    case "0":
      return { state: { ...state, focus: undefined, zoom: false } };
    case "\r":
    case "\n":
    case "\x7f": {
      const routed = matchOrToolKey(state, key, env);
      return routed ? { state: routed } : { state };
    }
    case ESC:
      // One Esc undoes the innermost mode: overlays, expansion, zoom, search,
      // focus.
      if (state.noticesView) {
        return { state: { ...state, noticesView: false } };
      }
      if (state.help) {
        return { state: { ...state, help: false } };
      }
      if (state.expandedTool !== undefined) {
        return { state: { ...state, expandedTool: undefined } };
      }
      if (state.zoom) {
        return { state: { ...state, zoom: false } };
      }
      if (state.query !== undefined) {
        return { state: { ...state, query: undefined } };
      }
      return { state: { ...state, focus: undefined } };
    default:
      break;
  }
  const pane = DIGIT_PANES[key];
  if (pane) {
    // Same digit twice zooms it: focus and expand without a second key.
    if (state.focus === pane) {
      return { state: { ...state, zoom: !state.zoom } };
    }
    return { state: { ...state, focus: pane, zoom: false } };
  }
  return { state };
}

/**
 * Text entry shared by the note prompt and the search prompt.
 *
 * The previous version appended every key it did not recognise, so a pasted
 * multi-line note submitted on its first newline and then fed the remaining
 * characters to the board as commands — a note containing "q" quit the
 * dashboard and lost the rest of the text.
 */
/** Reverse history search: every key re-ranks the ring instead of editing
 * the draft. Enter commits the selected note into the draft (never sends —
 * the usual flow is tweak-then-send); Esc cancels back to a clean line.
 * Matching is case-insensitive substring, newest match first. */
function histSearchKeys(state: UiState, key: string): { state: UiState; action?: UiAction } {
  const search = state.histSearch!;
  const history = state.history ?? [];
  const find = (from: number, step: 1 | -1): number | undefined => {
    const needle = search.needle.toLowerCase();
    for (let i = from; i >= 0 && i < history.length; i += step) {
      if ((history[i] ?? "").toLowerCase().includes(needle)) {
        return i;
      }
    }
    return undefined;
  };
  if (key === "\r" || key === "\n") {
    if (search.at === undefined) {
      return { state: { ...state, histSearch: undefined } };
    }
    const text = history[search.at] ?? "";
    return {
      state: {
        ...state,
        histSearch: undefined,
        input: text,
        cursor: [...text].length,
        historyAt: undefined,
        historyDraft: undefined,
      },
    };
  }
  if (key === ESC) {
    return { state: { ...state, histSearch: undefined } };
  }
  if (key === CTRL_R || key === CTRL_S) {
    const step: 1 | -1 = key === CTRL_R ? -1 : 1;
    // No selection yet: Ctrl+R starts from the newest note, Ctrl+S from the
    // oldest — each in its own direction.
    const start = search.at === undefined ? (step === -1 ? history.length - 1 : 0) : search.at + step;
    const at = find(start, step);
    return {
      state: { ...state, histSearch: { needle: search.needle, at, miss: at === undefined ? true : undefined } },
    };
  }
  if (key === DEL || key === "\b") {
    const glyphs = [...search.needle];
    glyphs.pop();
    const needle = glyphs.join("");
    const at = needle === "" ? undefined : find(history.length - 1, -1);
    return {
      state: { ...state, histSearch: { needle, at, miss: at === undefined ? true : undefined } },
    };
  }
  if (isControlKey(key)) {
    return { state };
  }
  const needle = search.needle + key;
  const at = find(history.length - 1, -1);
  return {
    state: { ...state, histSearch: { needle, at, miss: at === undefined ? true : undefined } },
  };
}

function typing(
  state: UiState,
  key: string,
  field: "input" | "query",
  env: KeyEnv,
): { state: UiState; action?: UiAction } {
  const current = (field === "input" ? state.input : state.query) ?? "";
  const glyphs = [...current];
  const caret = field === "input" ? clampCaret(state.cursor, glyphs.length) : glyphs.length;
  // Editor-grade bindings push the PREVIOUS draft onto the undo stack right
  // before an edit lands; a submitted note is a log fact and resets the
  // stack with the prompt (D-2026-08-21-32).
  const editing = state.editing ?? { undo: new UndoStack<string>(), kills: new KillRing() };
  const withUndo = (next: string): Partial<UiState> => {
    if (field === "input" && next !== current && state.inputSecret !== true) {
      editing.undo.push(current);
      editing.lastWasKill = false;
      editing.yankSpan = undefined;
    }
    return {};
  };
  const set = (next: string, nextCaret?: number, extra: Partial<UiState> = {}) => ({
    state:
      field === "input"
        ? {
          ...state,
          ...withUndo(next),
          ...extra,
          input: next,
          cursor: nextCaret ?? [...next].length,
          pickerAt: state.picker ? undefined : state.pickerAt,
          pickerHint: state.picker ? false : state.pickerHint,
          // A completion highlight belongs to one exact draft; editing it
          // re-ranks the list, so the highlight cannot survive.
          slashAt: undefined,
        }
        : { ...state, ...extra, query: next },
  });
  const kill = (from: number, to: number, forward: boolean): { state: UiState; action?: UiAction } => {
    const text = glyphs.slice(from, to).join("");
    if (text.length === 0) {
      return { state };
    }
    if (state.inputSecret !== true) {
      editing.kills.push(text, { prepend: !forward, accumulate: editing.lastWasKill === true });
    }
    const result = set(glyphs.slice(0, from).concat(glyphs.slice(to)).join(""), from);
    // After set(): withUndo resets the streak, so a kill re-arms it — the
    // NEXT kill may accumulate, any other edit must not.
    editing.lastWasKill = true;
    return result;
  };

  // Keys that are not text drive the board even while the prompt is open:
  // this is what makes an always-on prompt usable at all.
  if (field === "input" && state.pasting !== true) {
    const board = boardControl(state, key, env, current);
    if (board) {
      return board;
    }
  }
  // Bracketed paste: everything between the markers is literal text, so a
  // pasted newline composes a line instead of submitting the note.
  if (key === PASTE_START) {
    return { state: { ...state, pasting: true } };
  }
  if (key === PASTE_END) {
    return { state: { ...state, pasting: false } };
  }
  if (state.pasting === true) {
    const text =
      field === "query"
        ? key.replaceAll(/[\r\n]+/g, " ")
        : key.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    return insertAt(glyphs, caret, text, set);
  }

  if (key === ESC) {
    if (field === "query") {
      return { state: { ...state, searching: false, query: undefined, pasting: false } };
    }
    if (state.picker !== undefined) {
      if (state.picker === "route" && state.pickerRoute !== undefined) {
        return { state: modelPickerRoot(state) };
      }
      // Picker cancel: back to the plain prompt, nothing chosen.
      const cancellingAuth = state.picker === "auth-input";
      return {
        state: clearPicker(state),
        ...(cancellingAuth ? { action: { type: "auth-cancel" as const } } : {}),
      };
    }
    // A draft in progress is what Esc drops first. An empty prompt then
    // interrupts a busy turn and pops the newest queued note back into the
    // input; the board also peels zoom/help/focus.
    if (current !== "") {
      return {
        state: {
          ...state,
          input: "",
          cursor: 0,
          pasting: false,
          notice: undefined,
          historyAt: undefined,
          historyDraft: undefined,
          slashAt: undefined,
        },
      };
    }
    return { state: clearBoard(state), action: { type: "interrupt" } };
  }
  if (key === `${ESC}[D` && state.picker === "route" && state.pickerRoute !== undefined) {
    return { state: modelPickerRoot(state) };
  }
  if (key === "*" && state.picker === "route") {
    const selected = state.pickerAt === undefined
      ? undefined
      : pickerMatches(state, current)[state.pickerAt];
    if (selected?.kind === "model" && selected.route) {
      const model = selected.name.slice(selected.route.length + 1);
      return { state, action: { type: "model-favorite", route: selected.route, model } };
    }
  }
  if (key === "*" && state.picker === undefined && state.slashAt !== undefined) {
    // The same star as the picker's, on the completion list: it toggles the
    // favorite for the highlighted route/model pair and leaves the draft and
    // highlight in place so browsing continues. Anywhere else the star is text.
    const chosen = completeSlash(current, env, state)[state.slashAt];
    const pair = chosen ? /^model (\S+\/\S+)$/.exec(chosen.name) : undefined;
    if (pair) {
      const value = pair[1]!;
      const at = value.indexOf("/");
      return {
        state,
        action: { type: "model-favorite", route: value.slice(0, at), model: value.slice(at + 1) },
      };
    }
  }
  if (key === "\r" || key === "\n") {
    if (field === "query") {
      return { state: { ...state, searching: false, query: current === "" ? undefined : current } };
    }
    if (state.picker !== undefined) {
      const picker = state.picker;
      const typed = pickerText(picker, current);
      const matches = pickerMatches(state, current);
      const selected = state.pickerAt === undefined ? undefined : matches[state.pickerAt];
      if (picker === "route" && selected?.kind === "route") {
        return {
          state: {
            ...state,
            input: "route ",
            cursor: "route ".length,
            pickerAt: undefined,
            pickerHint: true,
            pickerRoute: selected.route ?? selected.name,
          },
        };
      }
      const choice = selected?.name ?? typed;
      const action: UiAction = picker === "route"
        ? { type: "route", text: choice }
        : picker === "effort"
          ? { type: "effort", level: choice }
        : picker === "login"
          ? { type: "login", route: choice }
          : picker === "logout"
            ? { type: "logout", route: choice }
            : { type: "auth-input", text: choice };
      return {
        state: { ...clearPicker(state), historyAt: undefined, historyDraft: undefined },
        action,
      };
    }
    const text = current.trim();
    if (text.length === 0) {
      return {
        state: {
          ...state,
          input: "",
          cursor: 0,
          historyAt: undefined,
          historyDraft: undefined,
        },
      };
    }
    // A bare CLI flag is shell habit, not a question for the model: answer it
    // on the board instead of spending a turn on it. `--help me with X` is a
    // real request and falls through to the note path.
    if (looksLikeCliFlag(text)) {
      const wantsHelp = /^\s*-{1,2}(h|help|\?)\s*$/iu.test(text);
      return {
        state: {
          ...state,
          input: "",
          cursor: 0,
          historyAt: undefined,
          historyDraft: undefined,
          ...(wantsHelp
            ? { help: true, notice: undefined }
            : { notice: `${text.trim()} is a CLI flag, not a message — press ? or /keys for board help` }),
        },
      };
    }
    // A leading /word is a board command, never a note. A path pasted mid
    // sentence is not — operators quote paths constantly.
    if (isSlash(text)) {
      // A highlighted completion runs instead of the raw draft: Enter means
      // "this one" once the operator has moved onto the list. A provider-level
      // choice stages instead of running — Enter drills into that provider's
      // models (/model) or sign-in methods (/login), mirroring the picker.
      const hits = completeSlash(text, env, state);
      const chosen = state.slashAt !== undefined ? hits[state.slashAt] : undefined;
      if (chosen) {
        const staged = stageCompletionDraft(chosen.name, env);
        if (staged !== undefined) {
          return {
            state: {
              ...state,
              input: staged,
              cursor: [...staged].length,
              slashAt: undefined,
              historyAt: undefined,
              historyDraft: undefined,
            },
          };
        }
      }
      const result = runSlash(state, chosen ? `/${chosen.name}` : text, env);
      if (result.action?.type === "route" && (result.action as { text: string }).text === "") {
        // /model with no argument opens the picker instead of a status
        // print: the operator must be able to see and choose. The draft is
        // seeded with the mode word so completion has a starting point.
        return {
          state: {
            ...result.state,
            input: "route ",
            cursor: "route ".length,
            notice: undefined,
            picker: "route",
            pickerHint: true,
            pickerCandidates: env.routes,
            pickerSummaries: env.routeSummaries,
            pickerDetails: env.modelCandidates,
            pickerRoute: undefined,
            historyAt: undefined,
            historyDraft: undefined,
            slashAt: undefined,
          },
        };
      }
      if (result.action?.type === "effort" && result.action.level === "") {
        const prefix = "effort ";
        return {
          state: {
            ...result.state,
            input: prefix,
            cursor: prefix.length,
            notice: undefined,
            picker: "effort",
            pickerHint: true,
            pickerCandidates: env.effortLevels,
            pickerSummaries: Object.fromEntries((env.effortLevels ?? []).map((level) => [level, `reasoning effort ${level}`])),
            historyAt: undefined,
            historyDraft: undefined,
            slashAt: undefined,
          },
        };
      }
      if ((result.action?.type === "login" || result.action?.type === "logout") && result.action.route === "") {
        const picker = result.action.type;
        const prefix = `${picker} `;
        const candidates = picker === "logout"
          ? env.authRoutes?.filter((candidate) => !candidate.includes("@"))
          : env.authRoutes;
        return {
          state: {
            ...result.state,
            input: prefix,
            cursor: prefix.length,
            notice: undefined,
            picker,
            pickerHint: true,
            pickerCandidates: candidates,
            pickerSummaries: env.authSummaries,
            historyAt: undefined,
            historyDraft: undefined,
            slashAt: undefined,
          },
        };
      }
      const applied = {
        ...result.state,
        input: "",
        cursor: 0,
        historyAt: undefined,
        historyDraft: undefined,
        slashAt: undefined,
      };
      return {
        state:
          result.notice !== undefined
            ? setNotice(applied, result.notice, env.now ?? 0)
            : applied,
        ...(result.action ? { action: result.action } : {}),
      };
    }
    const heung = takeHeungSignal(text);
    if (heung.activated) {
      return {
        state: {
          ...state,
          input: "",
          cursor: 0,
          notice: undefined,
          history: [...(state.history ?? []), text].slice(-HISTORY_MAX),
          historyAt: undefined,
          historyDraft: undefined,
        },
        action: {
          type: "heung",
          enabled: true,
          ...(heung.order ? { text: heung.order } : {}),
        },
      };
    }
    // The prompt reopens empty: it is never closed, only cleared.
    return {
      state: {
        ...state,
        input: "",
        cursor: 0,
        notice: undefined,
        history: [...(state.history ?? []), text].slice(-HISTORY_MAX),
        historyAt: undefined,
        historyDraft: undefined,
      },
      action: { type: "note", text },
    };
  }
  if (key === ETX) {
    return { state, action: { type: "quit" } };
  }
  if (key === DEL || key === "\b") {
    if (caret === 0) {
      return { state };
    }
    return set(glyphs.slice(0, caret - 1).concat(glyphs.slice(caret)).join(""), caret - 1);
  }
  if (field === "input") {
    switch (key) {
      case `${ESC}[3~`:
        // Delete removes what is AFTER the caret.
        return caret >= glyphs.length
          ? { state }
          : set(glyphs.slice(0, caret).concat(glyphs.slice(caret + 1)).join(""), caret);
      case `${ESC}[D`:
        editing.lastWasKill = false;
        return { state: { ...state, cursor: Math.max(0, caret - 1) } };
      case `${ESC}[C`:
        editing.lastWasKill = false;
        return { state: { ...state, cursor: Math.min(glyphs.length, caret + 1) } };
      case CTRL_A:
      case `${ESC}[H`:
        editing.lastWasKill = false;
        return { state: { ...state, cursor: 0 } };
      case CTRL_E:
      case `${ESC}[F`:
        editing.lastWasKill = false;
        return { state: { ...state, cursor: glyphs.length } };
      case CTRL_P:
        return { state: recallHistory(state, current, -1) };
      case CTRL_N:
        return { state: recallHistory(state, current, 1) };
      case CTRL_UNDERSCORE: {
        // Undo restores the previous draft snapshot. This must bypass set():
        // set() pushes the PREVIOUS draft for the next undo, which would
        // immediately re-push what undo just restored (a self-feeding loop
        // observed as undo/redo ping-pong). An empty stack means nothing
        // left to take back.
        const previous = editing.undo.pop();
        if (previous === undefined) {
          return { state };
        }
        return {
          state: { ...state, input: previous, cursor: [...previous].length },
        };
      }
      case CTRL_R: {
        // An empty draft has nothing to undo and everything to recall: the
        // key becomes reverse history search. With text on the line the old
        // undo contract stands — that hierarchy is what keeps Ctrl+R from
        // being stolen from editing (#dokkabi-dev#44). Ctrl+Underscore above
        // stays undo in every state: it never gained a second meaning.
        if (glyphs.length === 0) {
          return { state: { ...state, histSearch: { needle: "" } } };
        }
        const previous = editing.undo.pop();
        if (previous === undefined) {
          return { state };
        }
        return {
          state: { ...state, input: previous, cursor: [...previous].length },
        };
      }
      case CTRL_K:
        // Kill to end of line, into the ring.
        return kill(caret, glyphs.length, true);
      case CTRL_Y: {
        // Yank the most recent kill and remember the span it landed in.
        const text = editing.kills.peek();
        if (text === undefined) {
          return { state };
        }
        const inserted = [...text].length;
        const result = insertAt(glyphs, caret, text, set);
        editing.yankSpan = { from: caret, to: caret + inserted };
        return result;
      }
      case ALT_Y: {
        // Yank-pop (emacs): rotate the ring, then REPLACE the span the last
        // yank inserted with the next-oldest kill. Without the span, a
        // bare rotate+yank would append instead of replacing.
        const span = editing.yankSpan;
        if (span === undefined) {
          return { state };
        }
        editing.kills.rotate();
        const text = editing.kills.peek();
        if (text === undefined) {
          return { state };
        }
        const inserted = [...text].length;
        const next = glyphs.slice(0, span.from).concat([...text], glyphs.slice(span.to)).join("");
        const result = set(next, span.from + inserted);
        // set() cleared the span while recording the undo snapshot; the
        // replacement span must survive for the next yank-pop.
        editing.yankSpan = { from: span.from, to: span.from + inserted };
        return result;
      }
      case ALT_B: {
        const at = findWordBackward(current, caret);
        editing.lastWasKill = false;
        return { state: { ...state, cursor: at } };
      }
      case ALT_F: {
        const at = findWordForward(current, caret);
        editing.lastWasKill = false;
        return { state: { ...state, cursor: at } };
      }
      case ALT_D:
        return kill(caret, findWordForward(current, caret), true);
      case `${ESC}\x7f`:
        return kill(findWordBackward(current, caret), caret, false);
      default:
        break;
    }
  }
  if (key === CTRL_U) {
    // Kill to the start of the line, keeping whatever follows the caret.
    return set(glyphs.slice(caret).join(""), 0);
  }
  if (key === CTRL_W) {
    const before = glyphs.slice(0, caret).join("");
    const kept = dropLastWord(before);
    return set(kept + glyphs.slice(caret).join(""), [...kept].length);
  }
  if (key.startsWith(ESC) || isControlKey(key)) {
    // Arrow keys, CSI sequences, Meta chords (ESC + a character) and stray
    // control bytes are not text. Only a LONE Esc cancels, handled above.
    return { state };
  }
  return insertAt(glyphs, caret, key, set);
}

function insertAt(
  glyphs: readonly string[],
  caret: number,
  text: string,
  set: (next: string, nextCaret?: number) => { state: UiState },
): { state: UiState } {
  const inserted = [...text];
  const next = glyphs.slice(0, caret).concat(inserted, glyphs.slice(caret)).join("");
  return set(next, caret + inserted.length);
}

function clampCaret(cursor: number | undefined, length: number): number {
  if (cursor === undefined) {
    return length;
  }
  return Math.max(0, Math.min(length, cursor));
}

/**
 * Walk the sent-note history without mutating it. The first backward step
 * snapshots the current unsent draft. Going back past the oldest stays there;
 * coming forward past the newest restores that snapshot exactly.
 */
function recallHistory(state: UiState, current: string, step: number): UiState {
  const history = state.history ?? [];
  if (history.length === 0) {
    return state;
  }
  // Down/Ctrl+N has no meaning until a backward step opened a browsing
  // session. In particular it must not erase an ordinary unsent draft.
  if (state.historyAt === undefined && step >= 0) {
    return state;
  }
  const entering = state.historyAt === undefined;
  const at = state.historyAt ?? history.length;
  const next = Math.max(0, Math.min(history.length, at + step));
  if (next === at) {
    return state;
  }
  const historyDraft = entering ? current : (state.historyDraft ?? "");
  if (next >= history.length) {
    return {
      ...state,
      input: historyDraft,
      cursor: [...historyDraft].length,
      historyAt: undefined,
      historyDraft: undefined,
      // The draft changed under a completion highlight; the highlight cannot
      // point into a list ranked for another draft.
      slashAt: undefined,
    };
  }
  const text = history[next]!;
  return {
    ...state,
    input: text,
    cursor: [...text].length,
    historyAt: next,
    historyDraft,
    slashAt: undefined,
  };
}

/**
 * Control keys an always-on prompt hands to the board.
 *
 * Unmodified Up/Down recall submitted notes (same cursor as Ctrl+P/N).
 * Distinct SGR wheel reports scroll MODEL STREAM and never walk that cursor.
 * Alt+Up/Down and page keys scroll the focused pane. Tab completes a command
 * being typed or moves focus otherwise, and Ctrl+C still quits. Everything
 * printable stays text.
 */
function boardControl(
  state: UiState,
  key: string,
  env: KeyEnv,
  draft: string,
): { state: UiState; action?: UiAction } | undefined {
  const wheel = parseWheel(key);
  if (wheel !== undefined) {
    return { state: scrollModelStreamBy(state, wheel * 3, env) };
  }
  const selected = mouseSelection(state, key);
  if (selected) {
    return selected;
  }
  switch (key) {
    case `${ESC}[A`: {
      if (state.picker) return { state: movePicker(state, draft, -1) };
      const completion = moveSlashCompletion(state, draft, env, -1);
      if (completion) return { state: completion };
      return { state: recallHistory(state, draft, -1) };
    }
    case `${ESC}[B`: {
      if (state.picker) return { state: movePicker(state, draft, 1) };
      const completion = moveSlashCompletion(state, draft, env, 1);
      if (completion) return { state: completion };
      return { state: recallHistory(state, draft, 1) };
    }
    case `${ESC}[1;3A`:
      return { state: scrollBy(state, 1, env) };
    case `${ESC}[1;3B`:
      return { state: scrollBy(state, -1, env) };
    case `${ESC}[5~`:
      return { state: scrollBy(state, env.viewport, env) };
    case `${ESC}[6~`:
      return { state: scrollBy(state, -env.viewport, env) };
    case `${ESC}g`: {
      // The prompt owns every letter, so g/G cannot jump on a chat board
      // (field feedback: a 56-turn stream, 714 rows of backlog, no way up).
      // Alt chords are keys, not text: Alt+g heads, Alt+G tails.
      const pane = state.focus ?? env.visible[0];
      return pane ? { state: setScroll({ ...state, focus: pane }, TOP) } : undefined;
    }
    case `${ESC}G`: {
      const pane = state.focus ?? env.visible[0];
      return pane ? { state: setScroll({ ...state, focus: pane }, 0) } : undefined;
    }
    case "\t":
      return { state: completeOrCycle(state, env, draft, 1) };
    case `${ESC}[Z`:
      return { state: completeOrCycle(state, env, draft, -1) };
    case "\r":
    case "\n":
    case "\x7f": {
      // Navigation only on an empty line: with text these keys must stay
      // submit and delete.
      if (draft.trim() !== "") {
        return undefined;
      }
      const routed = matchOrToolKey(state, key, env);
      return routed ? { state: routed } : undefined;
    }
    default:
      return undefined;
  }
}

/** Tab finishes the command being typed, or walks the pane ring. */
function completeOrCycle(state: UiState, env: KeyEnv, draft: string, step: number): UiState {
  if (state.picker !== undefined) {
    // Picker completion: match the text after the mode word against the
    // seam-supplied candidates. One match fills it; several agree as far
    // as they share a prefix; none keeps the text (focus does not steal
    // the key while choosing).
    const typed = pickerText(state.picker, draft);
    const hits = pickerMatches(state, draft).map((candidate) => candidate.name);
    if (hits.length > 0) {
      const shared = commonPrefix(hits);
      const filled = hits.length === 1 ? hits[0]! : shared.length > typed.length ? shared : typed;
      const input = `${pickerPrefix(state.picker)}${filled}`;
      return { ...state, input, cursor: input.length, pickerHint: false, pickerAt: hits.length === 1 ? 0 : state.pickerAt };
    }
    return { ...state, pickerHint: false };
  }
  const options = completeSlash(draft, env, state);
  if (options.length > 0) {
    const names = options.map((option) => option.name);
    // One match completes it; several complete as far as they agree.
    const completed = options.length === 1 ? names[0]! : commonPrefix(names);
    const needsSpace = options.length === 1 && !completed.includes(" ") && takesArgument(completed);
    return { ...state, input: `/${completed}${needsSpace ? " " : ""}`, slashAt: undefined };
  }
  return { ...state, focus: cycle(env.visible, state.focus, step) };
}

export function pickerMatches(
  state: Pick<UiState, "picker" | "pickerCandidates" | "pickerSummaries" | "pickerDetails" | "pickerRoute">,
  draft: string,
): Array<{ name: string; summary: string; kind?: "route" | "model"; route?: string; section?: ModelPickerCandidate["section"] }> {
  if (!state.picker) return [];
  const terms = pickerText(state.picker, draft).toLowerCase().split(/\s+/).filter(Boolean);
  const summaries = state.pickerSummaries ?? {};
  const details: readonly ModelPickerCandidate[] = state.pickerDetails ?? (state.pickerCandidates ?? []).map((value) => ({
    value,
    summary: summaries[value] ?? "",
  }));
  const scoped = state.picker === "route" && state.pickerDetails
    ? state.pickerRoute !== undefined
      ? details.filter((candidate) => candidate.kind === "model" && candidate.section === "catalog" && candidate.route === state.pickerRoute)
      : terms.length === 0
        ? details.filter((candidate) => candidate.section === "recent" || candidate.section === "favorite" || candidate.section === "vendor")
        : details.filter((candidate) => candidate.kind === "model" && candidate.section === "catalog")
    : details;
  return scoped.filter((candidate) => {
    const haystack = `${candidate.value} ${candidate.summary}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).map((candidate) => ({
    name: candidate.value,
    summary: candidate.summary,
    ...(candidate.kind ? { kind: candidate.kind } : {}),
    ...(candidate.route ? { route: candidate.route } : {}),
    ...(candidate.section ? { section: candidate.section } : {}),
  }));
}

function movePicker(state: UiState, draft: string, step: number): UiState {
  const matches = pickerMatches(state, draft);
  if (matches.length === 0) return { ...state, pickerAt: undefined };
  const at = state.pickerAt ?? (step > 0 ? -1 : 0);
  return { ...state, pickerAt: (at + step + matches.length) % matches.length, pickerHint: false };
}

/** Move the slash completion highlight. Same wrap math as the picker so both
 * lists feel like one control; undefined when the draft has no candidates,
 * leaving the key to its next meaning (submitted-note history). */
function moveSlashCompletion(state: UiState, draft: string, env: KeyEnv, step: number): UiState | undefined {
  const hits = completeSlash(draft, env, state);
  if (hits.length === 0) {
    return undefined;
  }
  const at = state.slashAt ?? (step > 0 ? -1 : 0);
  return { ...state, slashAt: (at + step + hits.length) % hits.length };
}

/** The next stage's draft for a provider-level completion: /model gains
 * "route/" and /login gains "route@", so the list below the prompt switches
 * to that provider's models or sign-in methods. Undefined when the choice is
 * already a leaf (no models or methods known) and should run as typed. */
function stageCompletionDraft(name: string, env: KeyEnv): string | undefined {
  const model = /^model ([^\s/@]+)$/.exec(name);
  if (model) {
    const route = model[1]!;
    const hasModels = (env.modelDetails ?? []).some(
      (detail) => detail.kind === "model" && detail.route === route,
    );
    return hasModels ? `/model ${route}/` : undefined;
  }
  const login = /^login ([^\s@]+)$/.exec(name);
  if (login) {
    const route = login[1]!;
    const hasMethods = (env.authRoutes ?? []).some((candidate) => candidate.startsWith(`${route}@`));
    return hasMethods ? `/login ${route}@` : undefined;
  }
  return undefined;
}

function pickerPrefix(picker: NonNullable<UiState["picker"]>): string {
  if (picker === "route") return "route ";
  if (picker === "effort") return "effort ";
  if (picker === "login") return "login ";
  if (picker === "logout") return "logout ";
  return "";
}

function pickerText(picker: NonNullable<UiState["picker"]>, draft: string): string {
  return draft.startsWith(pickerPrefix(picker)) ? draft.slice(pickerPrefix(picker).length).trim() : draft.trim();
}

function clearPicker(state: UiState): UiState {
  return {
    ...state,
    input: "",
    cursor: 0,
    pasting: false,
    notice: undefined,
    picker: undefined,
    pickerHint: undefined,
    pickerCandidates: undefined,
    pickerSummaries: undefined,
    pickerDetails: undefined,
    pickerRoute: undefined,
    pickerAt: undefined,
    pickerPrompt: undefined,
    inputSecret: undefined,
    historyAt: undefined,
    historyDraft: undefined,
  };
}

function modelPickerRoot(state: UiState): UiState {
  return {
    ...state,
    input: "route ",
    cursor: "route ".length,
    pickerRoute: undefined,
    pickerAt: undefined,
    pickerHint: true,
  };
}

function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) {
      i += 1;
    }
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** Commands that read an argument get a trailing space when completed. */
function takesArgument(name: string): boolean {
  return commandTakesArgument(name);
}

/** Esc with an empty draft peels board state back, innermost first. */
/** Enter/Backspace on the board: match-ring navigation while a query is
 * live (#51), then the TOOLS failure expansion. Returns undefined when the
 * key means nothing here so callers fall through — submit, delete, digits. */
function matchOrToolKey(state: UiState, key: string, env: KeyEnv): UiState | undefined {
  if (key !== "\r" && key !== "\n" && key !== "\x7f") {
    return undefined;
  }
  const focus = state.focus;
  const navigating = state.query !== undefined && focus !== undefined;
  if (navigating) {
    const total = env.matchTotals?.[focus] ?? 0;
    if (total === 0) {
      return state;
    }
    if (key === "\r" || key === "\n") {
      const prev = state.matchIdx?.[focus] ?? -1;
      return { ...state, matchIdx: { ...state.matchIdx, [focus]: (prev + 1) % total } };
    }
    const prev = state.matchIdx?.[focus] ?? 0;
    return { ...state, matchIdx: { ...state.matchIdx, [focus]: (prev - 1 + total) % total } };
  }
  if (key !== "\r" || state.focus !== "tools") {
    return undefined;
  }
  const failures = env.toolFailures ?? [];
  if (failures.length === 0) {
    return setNotice(state, "no failed tool calls to expand", env.now ?? 0);
  }
  const at = failures.indexOf(state.expandedTool ?? "");
  return { ...state, expandedTool: failures[(at + 1) % failures.length]! };
}

function clearBoard(state: UiState): UiState {
  if (state.noticesView) {
    return { ...state, noticesView: false };
  }
  if (state.help) {
    return { ...state, help: false };
  }
  if (state.expandedTool !== undefined) {
    return { ...state, expandedTool: undefined };
  }
  if (state.zoom) {
    return { ...state, zoom: false };
  }
  if (state.query !== undefined) {
    return { ...state, query: undefined };
  }
  return { ...state, focus: undefined, notice: undefined };
}

function cycle(visible: readonly WidgetId[], focus: WidgetId | undefined, step: number): WidgetId | undefined {
  if (visible.length === 0) {
    return undefined;
  }
  if (focus === undefined) {
    return step > 0 ? visible[0] : visible[visible.length - 1];
  }
  const at = visible.indexOf(focus);
  if (at < 0) {
    return visible[0];
  }
  // The ring wraps. Leaving focus altogether is Esc or 0, so Tab stays a
  // predictable "next pane" in both directions.
  return visible[(at + step + visible.length) % visible.length];
}

/**
 * Jump to the next pane holding a search hit. Panes, not lines: a hit ten
 * rows down a pane is already on screen, while a hit in a pane the operator
 * is not looking at is the one they cannot find.
 */
function hop(state: UiState, env: KeyEnv, step: number): UiState {
  const ring = env.matching ?? [];
  if (state.query === undefined || ring.length === 0) {
    return state;
  }
  const at = state.focus ? ring.indexOf(state.focus) : -1;
  const next = at < 0 ? (step > 0 ? 0 : ring.length - 1) : (at + step + ring.length) % ring.length;
  return { ...state, focus: ring[next], zoom: false };
}

function scrollBy(state: UiState, delta: number, env: KeyEnv): UiState {
  const pane = state.focus ?? env.visible[0];
  if (!pane) {
    return state;
  }
  const at = state.scroll[pane] ?? 0;
  const next = Math.max(0, at + delta);
  return { ...state, focus: state.focus ?? pane, scroll: { ...state.scroll, [pane]: next } };
}

/**
 * Wheel gestures always belong to MODEL STREAM, independently of keyboard
 * focus. Keeping focus unchanged means Alt+arrows and page keys continue to
 * drive the pane the operator explicitly selected.
 */
function scrollModelStreamBy(state: UiState, delta: number, env: KeyEnv): UiState {
  if (!env.visible.includes("stream")) {
    return state;
  }
  const at = state.scroll.stream ?? 0;
  const next = Math.max(0, at + delta);
  return { ...state, scroll: { ...state.scroll, stream: next } };
}

function setScroll(state: UiState, value: number): UiState {
  const pane = state.focus;
  if (!pane) {
    return state;
  }
  return { ...state, scroll: { ...state.scroll, [pane]: value } };
}

/**
 * SGR mouse report (`CSI < b ; x ; y M`). Button 64 is wheel-up, 65 wheel-down;
 * anything else is not a scroll and is ignored.
 */
type MouseEventKey =
  | { kind: "wheel"; delta: number }
  | { kind: "press"; x: number; y: number }
  | { kind: "drag"; x: number; y: number }
  | { kind: "release"; x: number; y: number };

/** SGR mouse reports. Wheel is 64/65; button 0 press/motion/release carries
 * the application-owned selection (drag capture and wheel capture share the
 * tracking mode, so selection must be ours for the triad to hold). */
function parseMouse(key: string): MouseEventKey | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Math.max(0, Number(match[2]) - 1);
  const y = Math.max(0, Number(match[3]) - 1);
  if (button === 64) return { kind: "wheel", delta: 1 };
  if (button === 65) return { kind: "wheel", delta: -1 };
  if (button === 0 && match[4] === "M") return { kind: "press", x, y };
  if (button === 32 && match[4] === "M") return { kind: "drag", x, y };
  if (button === 0 && match[4] === "m") return { kind: "release", x, y };
  return undefined;
}

/** Selection lifecycle for one mouse report; undefined = not a mouse key. */
function mouseSelection(state: UiState, key: string): { state: UiState; action?: UiAction } | undefined {
  const mouse = parseMouse(key);
  if (!mouse || mouse.kind === "wheel") return undefined;
  if (mouse.kind === "press") {
    return { state: { ...state, selection: { ax: mouse.x, ay: mouse.y, hx: mouse.x, hy: mouse.y, active: true } } };
  }
  if (!state.selection?.active) return { state };
  if (mouse.kind === "drag") {
    return { state: { ...state, selection: { ...state.selection, hx: mouse.x, hy: mouse.y } } };
  }
  const settled = { ...state.selection, hx: mouse.x, hy: mouse.y, active: false };
  const moved = settled.ax !== settled.hx || settled.ay !== settled.hy;
  return {
    state: { ...state, selection: settled },
    ...(moved ? { action: { type: "copy-selection" as const } } : {}),
  };
}

function parseWheel(key: string): number | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(key);
  if (!match) {
    return undefined;
  }
  const button = Number(match[1]);
  if (button === 64) {
    return 1;
  }
  if (button === 65) {
    return -1;
  }
  return undefined;
}
