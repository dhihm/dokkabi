import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { EventLog } from "../host/event-log.ts";
import { redactText } from "../host/redact.ts";
import type { NoteDelivery } from "../chat/frontend.ts";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { openProviderUrl } from "../auth/terminal.ts";
import { tuiAuthViewMessage, TuiAuthSession, type TuiAuthView } from "../auth/tui.ts";
import { operatorInboxPath, pendingNoteState, popOperatorMessage, pushOperatorMessage } from "../work/inbox.ts";
import { COPIED_NOTICE_TTL_MS, DEFAULT_NOTICE_TTL_MS, extractSelection, renderDashScreen } from "./board.ts";
import { applyKey, initialUi, setNotice, type UiAction, type UiState } from "./keymap.ts";
import { ttyPaintSequence, createTtyPainter } from "./tty-paint.ts";
import { followLog } from "./follow.ts";
import { bindPlanFile, lastPlanDigest, readPlanFromLog } from "../work/log.ts";
import { EventIndex } from "./event-index.ts";
import { dueToReproject } from "./project-pace.ts";
import { projectDash, type DashProjection } from "./project.ts";
import { renderDashText } from "./render.ts";
import { BOARD_KEEP_FULL_RECORDS, TailLog } from "./tail-log.ts";
import { TelemetryTail, telemetryPathFor } from "../host/telemetry-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { setActiveTheme } from "./theme.ts";
import { bellAllowed, bellEvents, bellSequence } from "./bell.ts";
import { resolveSessionTarget, sessionSwitchAllowed } from "./session-switch.ts";
import { toolKey } from "./tool-detail.ts";
import { listSessions } from "./sessions.ts";
import { dokkabiHome } from "../host/paths.ts";
import { createKeySource } from "./key-source.ts";
import { readLayoutConfig, layoutConfigPath, reloadNeeded, saveLayoutConfig, type LayoutConfig } from "./layout-config.ts";
import { ALL_WIDGETS, type WidgetId } from "./widgets.ts";
import { routePermissionInput } from "./permission.ts";
import { isHandoffConfirmation, routeHandoffPromptInput, type HandoffConfirmation } from "./handoff-prompt.ts";

export interface DashPickerCandidate {
  value: string;
  summary: string;
  kind?: "route" | "model";
  route?: string;
  section?: "recent" | "favorite" | "vendor" | "catalog";
}

export interface DashViewOptions {
  path: string;
  /** Live boards re-resolve the log each paint: per-instance swe sessions
   * roll over mid-watch and the board follows the newest run. */
  resolvePath?: () => string;
  /** Workspace plan for an in-memory bind when the log carries no plan
   * events (dev sessions). Never written to the observed log. */
  planPath?: string;
  replay: boolean;
  url?: string;
  color?: boolean;
  /** Session name when the board was pointed at a log path rather than an id. */
  sessionLabel?: string;
  /**
   * Interactive mode (#37): route submitted notes to the in-process kernel
   * instead of staging them into the operator inbox. Undefined keeps the
   * attach-mode behaviour: notes wait in the inbox for a running loop.
   * Returning "inbox" shows the operator the note staged for a busy
   * kernel; the durable record stays the EventLog.
   */
  onNote?: (text: string) => NoteDelivery;
  /**
   * Empty-prompt Esc: abort the running turn and restore the newest queued
   * note into the input.
   */
  onInterrupt?: () => { aborted: boolean; restored?: string };
  /**
   * Interactive mode (#37): `/model` from the board. The seam owns route
   * selection (llm.select lives in the kernel); returning a string shows it
   * as a transient notice. Undefined (attach boards) shows "unavailable".
   */
  /** A selection answers with a line, or with the confirmation a large carry
   * needs first — the handler below tests for exactly that. */
  onRoute?: (route: string) => string | HandoffConfirmation | void | Promise<string | HandoffConfirmation | void>;
  /**
   * Interactive mode (#37): `/model` picker candidates — route names and
   * model ids. Undefined (attach boards) leaves the picker working
   * against an empty list (typing still commits).
   */
  onRoutes?: () => readonly string[];
  /** Rich route/model candidates. This supersedes onRoutes for live chat but
   * the older string seam remains for attach integrations. */
  onModelCandidates?: () => readonly DashPickerCandidate[];
  /** Provider accounts and login-method choices. Values contain no secrets. */
  onAuthCandidates?: () => readonly DashPickerCandidate[];
  /** Provider-owned authentication; prompt values stay in the interaction. */
  onLogin?: (route: string, interaction: AuthInteraction) => Promise<string>;
  /** Remove one provider credential and return a display-safe status. */
  onLogout?: (route: string) => Promise<string>;
  /** Live HEUNG control. Undefined only on replay or observer-only boards. */
  onHeung?: (enabled?: boolean) => string;
  /** /두레: launch the free-model role pipeline in the background. */
  onFreeswarm?: (task: string) => string;
  /** Safe knowledge status/search/lint seam for the live board. */
  onKnowledge?: (command: string) => string | Promise<string>;
  /** Sanitized provider quota status. Never returns credential material. */
  onLimits?: (options?: { refresh?: boolean }) => string | Promise<string>;
  /** Read or update the explicit failover policy. */
  onFailover?: (command: string) => string | Promise<string>;
  /** Inspect or resolve an operator-owned SSH approval request. */
  onSsh?: (command: string) => string | Promise<string>;
  /** Inspect or resolve an approved-owner private repository request. */
  onGithubAdmin?: (command: string) => string | Promise<string>;
  /** Inspect, resolve, or revoke an MCP capability request. */
  onMcp?: (command: string) => string | Promise<string>;
  /** Inspect, resolve, or revoke a managed skill installation. */
  onPlugin?: (command: string) => string | Promise<string>;
  /** Inspect or update this process's approval policy. */
  onPermissions?: (command: string) => string | Promise<string>;
  /** Inspect or explicitly reseed the current live chat transcript. */
  onResume?: (command: string) => string | Promise<string>;
  /** Read or update the live session's reasoning effort. */
  onEffort?: (level?: string) => string | Promise<string>;
  /** Toggle one public route/model reference in persistent favorites. */
  onModelFavorite?: (route: string, model: string) => string | Promise<string>;
}

export function renderDash(
  events: Parameters<typeof projectDash>[0],
  meta: DashViewOptions,
): string {
  return renderDashText(projectDash(events), meta);
}

/**
 * Alt-screen, cursor off, wrap off.
 *
 * Mouse reporting is ON by default with SGR button+motion tracking: distinct
 * wheel reports scroll MODEL STREAM, plain arrows keep input history, and an
 * unmodified drag drives the APPLICATION-OWNED selection — highlighted on
 * the board and copied to the clipboard via OSC 52 on release (the mouse
 * triad, D-2026-08-25-98; tests/mouse-triad-contract.test.ts pins all three
 * gestures at once). `/mouse off` or `DOKKABI_MOUSE=0` falls back to
 * terminal-native drag for OSC-52-less terminals, at the cost of wheel
 * capture. Apple Terminal (no OSC 52 at all) starts in that native mode by
 * default; `DOKKABI_MOUSE=1` forces capture anywhere. Alternate-scroll is
 * never pushed: it would turn the wheel into
 * the Up/Down bytes that prompt history owns.
 */
/**
 * Three modes, because the two the board had were a false choice.
 *
 * `1002` is button-event tracking: it reports motion while a button is held,
 * which is precisely what the terminal needs in order to run its own
 * selection, so asking for it takes the native drag away. That was the whole
 * cost of capture -- and losing the native drag to gain the wheel is a bad
 * trade when the app's own selection is the thing the operator does not like.
 *
 * `1000` reports presses and releases only. The wheel is a press (SGR button
 * 64/65), so it still arrives; drag motion does not, so a terminal that runs
 * its own selection can keep running it. Whether a given terminal does is a
 * property of that terminal, so this is a mode to try, not a promise.
 */
const MOUSE_CAPTURE = "\x1b[?1002h\x1b[?1006h";
const MOUSE_WHEEL = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const MOUSE_ON = MOUSE_CAPTURE;

export type MouseMode = "capture" | "wheel" | "native";

export function mouseSequence(mode: MouseMode): string {
  if (mode === "capture") return MOUSE_CAPTURE;
  if (mode === "wheel") return MOUSE_WHEEL;
  return MOUSE_OFF;
}
/** Bracketed paste: the terminal wraps pasted text in 200~/201~ so a pasted
 * newline can be told apart from the operator pressing Enter. */
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
/** Kitty keyboard protocol flag 1 (disambiguate): Escape arrives as CSI 27 u
 * with no timeout guessing; ctrl/alt chords arrive as CSI-u and the key
 * source translates them back to legacy keys. Terminals without the
 * protocol ignore the push. */
const KITTY_ON = "\x1b[>1u";
const KITTY_OFF = "\x1b[<u";
const ENTER_TTY = "\x1b[?1049h\x1b[?25l\x1b[?7l" + PASTE_ON + KITTY_ON;
const LEAVE_TTY = KITTY_OFF + PASTE_OFF + "\x1b[?25h\x1b[?7h\x1b[?1049l\r\n";

/**
 * Whether the terminal honours OSC 52 clipboard writes. Apple Terminal never
 * implemented the sequence: a drag-copy there reports "copied" while the
 * clipboard stays empty, and capture simultaneously eats the native
 * selection — both copy paths die at once.
 */
export function osc52Supported(env: NodeJS.Dict<string> = process.env): boolean {
  return env.TERM_PROGRAM !== "Apple_Terminal";
}

export function mouseReportingEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return mouseModeFor(env) !== "native";
}

/**
 * What the board asks the terminal for, before the operator says otherwise.
 *
 * It used to ask for button+motion tracking everywhere OSC 52 works, which
 * bought the wheel and the app's own selection and cost the terminal's. That
 * was a bad trade: the operator wants the drag their terminal gives them
 * everywhere else, and the app's imitation of it is what they noticed.
 *
 * `wheel` asks for presses and releases only. The wheel is a press, so it
 * still arrives; motion is not requested, so a terminal that runs its own
 * selection keeps running it. `DOKKABI_MOUSE=1` restores full capture,
 * `DOKKABI_MOUSE=0` hands the mouse back entirely, and `/mouse` switches
 * between all three without a restart.
 */
export function mouseModeFor(env: NodeJS.Dict<string> = process.env): MouseMode {
  if (env.DOKKABI_MOUSE === "0") return "native";
  if (env.DOKKABI_MOUSE === "1") return "capture";
  if (env.DOKKABI_MOUSE === "wheel") return "wheel";
  return "wheel";
}

/** Exact terminal input-mode lifecycle, exposed for a PTY-free contract test. */
export function ttyInputModes(mouseReporting: boolean): { enter: string; leave: string } {
  return {
    enter: `${ENTER_TTY}${mouseReporting ? mouseSequence(mouseModeFor()) : ""}`,
    leave: `${mouseReporting ? MOUSE_OFF : ""}${LEAVE_TTY}`,
  };
}

export async function runDash(options: DashViewOptions & { once?: boolean }): Promise<void> {
  // Replay points at an explicit file and must exist. A live observer may
  // open before the watched session writes its first event: it renders empty
  // and followLog repaints when events land.
  if (options.replay && !existsSync(options.path)) {
    throw new Error(`no EventLog at ${options.path}`);
  }
  const tty = Boolean(process.stdout.isTTY) && !options.once;
  const stdinTty = Boolean(process.stdin.isTTY) && tty;
  const mouseReporting = mouseReportingEnabled();
  const startMode = mouseModeFor();
  const inputModes = ttyInputModes(mouseReporting);
  // Live /mouse toggle state; the exit restore follows this, not the boot value.
  let mouseMode: MouseMode = startMode;
  let mouseOn = mouseReporting;
  let closed = false;
  let stopFollow = () => {};
  let stopHop = () => {};
  let keySource: ReturnType<typeof createKeySource> | undefined;
  const onResize = () => requestPaint(true);
  const restore = () => {
    if (closed) {
      return;
    }
    closed = true;
    stopFollow();
    stopHop();
    // Flush a held key (lone ESC, torn sequence) before the listeners go,
    // so teardown never swallows a keypress the operator already made.
    keySource?.dispose();
    try {
      if (stdinTty) {
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
      process.stdout.write(ttyInputModes(mouseOn).leave);
    }
  };

  if (tty) {
    process.stdout.write(inputModes.enter);
  }

  const shutdown = Promise.withResolvers<void>();
  const onSigint = () => shutdown.resolve();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  // A busy run appends dozens of events per second; painting on every one
  // makes the board strobe (operator report: eye strain). Coalesce paints to
  // at most one per PAINT_INTERVAL_MS with a trailing call so the last event
  // always lands.
  // 100 ms matches one spinner glyph, so the live heartbeat animates at
  // paint cadence instead of sampling a 250 ms glyph at 200 ms.
  const PAINT_INTERVAL_MS = 100;
  let scheduled = false;
  let lastPaintAt = 0;
  const requestPaint = (force = false) => {
    if (closed || scheduled) {
      return;
    }
    scheduled = true;
    // The interval exists to stop the LOG from strobing the board: a busy run
    // appends dozens of events a second and painting on each one is what made
    // an operator's eyes hurt. It was applied to operator input too, which
    // capped scrolling at ten frames a second -- a wheel flick sends a notch
    // per click and the board dropped most of them, which reads as a stutter.
    //
    // `force` means the operator did something, so it draws on the next turn
    // of the event loop. A burst of notches still costs one paint: the
    // `scheduled` guard above collapses them.
    const wait = force ? 0 : Math.max(0, PAINT_INTERVAL_MS - (Date.now() - lastPaintAt));
    setTimeout(() => {
      scheduled = false;
      if (!closed) {
        lastPaintAt = Date.now();
        paint(force);
      }
    }, wait);
  };

  let ui: UiState = initialUi();
  // Differential painter per board run; the resize callback repaints via
  // requestPaint(true) and the painter re-baselines on the new size.
  const painter = createTtyPainter(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  // Layout starts from the file and follows it (#dokkabi-dev#49): each paint
  // stats the file once, and only a CHANGED mtime re-reads — an untouched
  // file costs one stat, not a parse.
  let layout: LayoutConfig = readLayoutConfig();
  let layoutMtime: number | undefined = (() => {
    try {
      return statSync(layoutConfigPath()).mtimeMs;
    } catch {
      return undefined;
    }
  })();
  const pollLayout = (): LayoutConfig => {
    let fresh: number | undefined;
    try {
      fresh = statSync(layoutConfigPath()).mtimeMs;
    } catch {
      return layout;
    }
    if (reloadNeeded(layoutMtime, fresh)) {
      layoutMtime = fresh;
      layout = readLayoutConfig();
    }
    return layout;
  };
  // Session switching (#dokkabi-dev#47): undefined means "watch what the
  // options said" (including the swe rollover follow). An explicit switch
  // wins over both until the process ends.
  let switched: { path: string; label: string } | undefined;
  // The session the note will go to, captured when the prompt OPENS. A
  // `--session swe` board re-resolves its path as instances roll over, so
  // resolving at Enter time delivered a note about instance A into B's inbox.
  let noteTarget: string | undefined;
  let noteError: string | undefined;
  // Incremental reader per observed path: a repaint on an idle log costs a
  // stat, not a full parse and hash-verify of every record.
  const readers = new Map<string, TailLog>();
  // Telemetry (progress/host) lives in a sibling stream that grows on its own
  // cadence; a size gate re-reads it only when it moved, and drives a repaint
  // even when the content log is idle (a ticking generation is telemetry).
  const telemetryTails = new Map<string, TelemetryTail>();
  const telemetryReaders = new Map<string, { size: number; records: readonly EventRecord[] }>();
  let cached: { path: string; view: DashProjection; events: number } | undefined;
  let lastFrame = "";
  // Bell bookkeeping (#dokkabi-dev#46): the projection the previous paint grew
  // out of, and when each distinct cause last rang. Memory only — a restart
  // forgetting a throttle is harmless; ringing twice five minutes apart is fine.
  let prevBellView: DashProjection | undefined;
  const bellLastRang = new Map<string, number>();
  const BELL_THROTTLE_MS = 5_000;
  // The wall clock when the current notice text first appeared, so the board
  // can retire it after its TTL. Stamped whenever the text changes.
  let noticeText: string | undefined;
  let noticeStampedAt = 0;
  const stampNotice = (text: string | undefined): number => {
    if (text !== noticeText) {
      noticeText = text;
      noticeStampedAt = Date.now();
    }
    return noticeStampedAt;
  };

  // Session names for the /session completer and usage notice, scanned once
  // at board start and refreshed after each switch — a per-paint scan would
  // walk the whole sessions directory sixty times a second.
  let sessionNames: readonly string[] = listSessions(dokkabiHome()).slice(0, 12).map((row) => row.id);
  const refreshSessionNames = (): void => {
    sessionNames = listSessions(dokkabiHome()).slice(0, 12).map((row) => row.id);
  };

  const indexes = new Map<string, EventIndex>();
  let lastProjectAt = 0;
  let lastProjectMs = 0;
  /** The whole last frame, projection and widgets together. */
  let lastFrameMs = 0;

  const projectionFor = (path: string): DashProjection => {
    let reader = readers.get(path);
    if (!reader) {
      // The board renders a tail, so it does not hold every record's text:
      // `text`, `thinking`, `args` and `raw` past the window were 33.7MB of an
      // 89MB live log with nothing able to read them.
      reader = new TailLog(path, BOARD_KEEP_FULL_RECORDS);
      readers.set(path, reader);
    }
    const { events, changed } = reader.poll();
    const telemetry = telemetryFor(path);
    if (!changed && !telemetry.changed && cached && cached.path === path) {
      return cached.view;
    }
    // A changed log does not oblige an immediate re-projection.
    //
    // `projectDash` walks the WHOLE log about sixty times over, so its cost is
    // the session's whole history: measured at 145ms on a live 93MB log of
    // 115,000 events, against a 100ms paint interval. A run appending events
    // continuously therefore made every paint changed, every paint cost more
    // than the interval it was meant to fit, and the board spent all of its
    // time projecting -- which is why the spinner only advanced when a chunk
    // of text did (both waited on the same projection) and why a mouse drag
    // took seconds to register.
    //
    // The paint stays at its interval and repaints from the last view; the
    // projection is what gets throttled, to a share of what it costs. A cheap
    // log still projects every paint; an expensive one projects between
    // paints, and the board keeps answering the keyboard either way.
    if (
      cached && cached.path === path
      && !dueToReproject({
        now: Date.now(),
        lastAt: lastProjectAt,
        lastMs: Math.max(lastProjectMs, lastFrameMs),
      })
    ) {
      return cached.view;
    }
    let source: readonly Parameters<typeof projectDash>[0][number][] = events;
    const logPlan = readPlanFromLog(events);
    const pendingEmptyLogPlan = logPlan?.todos.length === 0 && lastPlanDigest(events) === "pending";
    if (options.planPath && existsSync(options.planPath) && (logPlan === undefined || pendingEmptyLogPlan)) {
      // Dev sessions carry the plan on disk, not in the log. The bind happens
      // on a throwaway in-memory handle: the observed log is never touched.
      try {
        const scratch = new EventLog(path, { readOnly: true });
        bindPlanFile(scratch, options.planPath);
        source = scratch.events;
      } catch {
        // unsealed/invalid plan: the board tolerates a missing plan
      }
    }
    const startedAt = Date.now();
    // The reader is incremental and now the projection is too: the index folds
    // only what arrived, so events already bucketed are never looked at again.
    // It is only valid for the array it was folded from -- a plan bound from
    // disk projects a different array, and that one builds its own.
    let index = indexes.get(path);
    if (!index) {
      index = new EventIndex();
      indexes.set(path, index);
    }
    const view = source === events
      ? projectDash(source, telemetry.records, index.fold(source))
      : projectDash(source, telemetry.records);
    lastProjectMs = Date.now() - startedAt;
    lastProjectAt = Date.now();
    cached = { path, view, events: events.length };
    return view;
  };

  /** Read the sibling telemetry tail, re-reading only when the file grew. */
  const telemetryFor = (path: string): { records: readonly EventRecord[]; changed: boolean } => {
    const telemetryPath = telemetryPathFor(path);
    let size = -1;
    try {
      size = statSync(telemetryPath).size;
    } catch {
      size = -1;
    }
    const cachedTel = telemetryReaders.get(path);
    if (cachedTel && cachedTel.size === size) {
      return { records: cachedTel.records, changed: false };
    }
    // Incremental: bytes already parsed are never read again. Re-reading the
    // whole tail each time the file grew was 26MB of garbage a second on a
    // live run, and a live run writes telemetry continuously.
    let tail = telemetryTails.get(path);
    if (!tail) {
      tail = new TelemetryTail(telemetryPath);
      telemetryTails.set(path, tail);
    }
    const records = size < 0 ? [] : tail.read();
    telemetryReaders.set(path, { size, records });
    return { records, changed: true };
  };

  const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  // Candidates for the prompt's slash suggestion box: the same live data the
  // key loop hands Tab, gathered only while a slash draft is open so idle
  // paints stay free of catalog calls.
  const slashCompletionEnv = () => {
    const draft = ui.input;
    if (draft === undefined || !/^\s*\//.test(draft)) return undefined;
    const modelCandidates = options.onModelCandidates?.() ??
      (options.onRoutes?.() ?? []).map((value) => ({ value, summary: "" }));
    const authCandidates = options.onAuthCandidates?.() ?? [];
    return {
      visible: visiblePanes(cached?.view),
      viewport: Math.max(1, (process.stdout.rows ?? 24) - 6),
      routes: modelCandidates.map((candidate) => candidate.value),
      routeSummaries: Object.fromEntries(modelCandidates.map((candidate) => [candidate.value, candidate.summary])),
      modelDetails: modelCandidates,
      effortLevels: EFFORT_LEVELS,
      sessions: sessionNames,
      authRoutes: authCandidates.map((candidate) => candidate.value),
      authSummaries: Object.fromEntries(authCandidates.map((candidate) => [candidate.value, candidate.summary])),
    };
  };

  const paint = (force = false) => {
    const paintStartedAt = Date.now();
    try {
      const path = switched?.path ?? options.resolvePath?.() ?? options.path;
      const view = projectionFor(path);
      if (tty && bellAllowed({ replay: options.replay === true, disabled: process.env.DOKKABI_BELL === "off" })) {
        for (const bellEvent of bellEvents(prevBellView, view)) {
          const key = `${bellEvent.kind}:${bellEvent.label}`;
          const now = Date.now();
          const last = bellLastRang.get(key);
          if (last !== undefined && now - last < BELL_THROTTLE_MS) {
            continue;
          }
          bellLastRang.set(key, now);
          // BEL reaches every terminal; OSC 9 reaches the desktop
          // notification on terminals that speak it and is ignored by those
          // that do not.
          process.stdout.write(bellSequence(bellEvent));
        }
      }
      prevBellView = view;
      if (tty) {
        // Hot-reload the operator layout (#dokkabi-dev#49): one stat per
        // paint; only a changed mtime costs a re-read.
        pollLayout();
        const cols = process.stdout.columns ?? 80;
        const rows = process.stdout.rows ?? 24;
        const noteState = pendingNoteState(dirname(path));
        const frame = renderDashScreen(view, {
          ...options,
          path,
          cols,
          rows,
          color: true,
          debug: ui.debug,
          focus: ui.focus,
          zoom: ui.zoom,
          help: ui.help,
          query: ui.query,
          searching: ui.searching,
          inputDraft: ui.input,
          slashEnv: slashCompletionEnv(),
          filters: ui.filters,
          matchIdx: ui.matchIdx,
          expandedTool: ui.expandedTool,
          sessionLabel: switched?.label ?? options.sessionLabel,
          histSearch: ui.histSearch
            ? {
                needle: ui.histSearch.needle,
                at: ui.histSearch.at,
                miss: ui.histSearch.miss === true,
                preview: ui.histSearch.at !== undefined ? (ui.history ?? [])[ui.histSearch.at] : undefined,
              }
            : undefined,
          picker: ui.picker,
          pickerCandidates: ui.pickerCandidates,
          pickerSummaries: ui.pickerSummaries,
          pickerDetails: ui.pickerDetails,
          pickerRoute: ui.pickerRoute,
          pickerAt: ui.pickerAt,
          pickerPrompt: ui.pickerPrompt,
          slashAt: ui.slashAt,
          inputSecret: ui.inputSecret,
          inputCursor: ui.cursor,
          scroll: ui.scroll,
          pendingNotes: noteState.queued,
          inFlightNotes: noteState.inFlight,
          noteError,
          notice: ui.notice,
          noticeAt: stampNotice(ui.notice),
          noticeTtl: ui.notice?.startsWith("copied") ? COPIED_NOTICE_TTL_MS : DEFAULT_NOTICE_TTL_MS,
          layout,
          permissionPrompt: options.onSsh !== undefined || options.onGithubAdmin !== undefined,
          handoffPrompt: ui.handoffPrompt,
          selection: ui.selection,
        });
        // An identical frame is not worth the bytes: a live spinner still
        // differs, so animation is unaffected and an idle board goes quiet.
        if (!force && frame === lastFrame) {
          return;
        }
        lastFrame = frame;
        // Differential (#37 T4): only the rows that changed since the last
        // painted frame are written; first paint and resizes paint all. The
        // encoding rules are ttyPaintSequence's — wrap off, CUP rows, last
        // cell unwritten, sync (2026) around the batch.
        process.stdout.write(painter.paint(frame, cols, rows));
        return;
      }
      process.stdout.write(`${renderDashText(view, { ...options, color: false })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (tty) {
        // Even the failure screen keeps the top bar: a bare error page reads
        // as "the dashboard lost its header" to the operator.
        process.stdout.write(
          `\x1b[H\x1b[JDOKKABI  mode=${options.replay ? "replay" : "live"}  status=render_failed  q quit\nerror     ${message}\n(repainting on next event)\n`,
        );
        return;
      }
      process.stderr.write(`dash read failed: ${message}\n`);
    }
      // What a frame really costs: the projection AND the widget bodies it
    // invalidates. Pacing on the projection alone under-counted by more than
    // half -- 68ms measured against 162ms actually spent -- so the board
    // scheduled five frames a second it could not afford and pegged a core.
    lastFrameMs = Date.now() - paintStartedAt;
  };

  paint(true);
  if (options.once) {
    restore();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
    return;
  }
  if (!process.stdout.isTTY) {
    if (options.url) {
      process.stdout.write(`\nOperator board: ${options.url}  (q or Ctrl+C to quit)\n`);
    }
    // Keep the loop alive even when stdin is closed/drained (some terminal
    // multiplexers): a repainting 2s timer beats an instant silent exit.
    const keepAlive = setInterval(() => requestPaint(), 2_000);
    try {
      await shutdown.promise;
    } finally {
      clearInterval(keepAlive);
      restore();
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigint);
    }
    return;
  }

  process.stdout.on("resize", onResize);
  stopFollow = followLog(options.path, () => requestPaint());
  // Session rollover: file events arrive on the OLD path, so a periodic
  // repaint lets resolvePath hop the board to the newest run's log. The same
  // timer drives the spinner and elapsed clock between events, so it runs at
  // the paint interval.
  const hop = setInterval(() => requestPaint(), PAINT_INTERVAL_MS);
  stopHop = () => clearInterval(hop);
  let cancelInteractive = () => {};
  try {
  await Promise.race([new Promise<void>((resolve) => {
    if (stdinTty) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    // stdin is bytes; decoding, sequence completeness, bracketed paste and
    // the escape timeout live in the @dokkabi/pi-tui StdinBuffer behind
    // createKeySource (#37 T4). The keymap contract is unchanged: plain key
    // strings, PASTE_START/body/PASTE_END for pastes.
    let activeAuth: { session: TuiAuthSession; abort: AbortController } | undefined;
    let currentAuthView: TuiAuthView | undefined;
    cancelInteractive = () => {
      activeAuth?.abort.abort();
      activeAuth?.session.cancel();
      activeAuth = undefined;
    };
    const clearAuthInput = () => {
      if (ui.picker !== "auth-input") return;
      ui = {
        ...ui,
        input: "",
        cursor: 0,
        picker: undefined,
        pickerHint: undefined,
        pickerCandidates: undefined,
        pickerSummaries: undefined,
        pickerDetails: undefined,
        pickerRoute: undefined,
        pickerAt: undefined,
        pickerPrompt: undefined,
        inputSecret: undefined,
      };
    };
    const showAuthView = (view: TuiAuthView | undefined) => {
      currentAuthView = view;
      if (!view) {
        clearAuthInput();
        requestPaint(true);
        return;
      }
      const message = tuiAuthViewMessage(view);
      if (message) {
        ui = { ...ui, notice: message };
      }
      if (view.prompt) {
        const candidates = view.candidates?.map((candidate) => candidate.value);
        const summaries = Object.fromEntries(
          (view.candidates ?? []).map((candidate) => [candidate.value, redactText(candidate.summary)]),
        );
        ui = {
          ...ui,
          input: "",
          cursor: 0,
          notice: message ?? ui.notice,
          picker: "auth-input",
          pickerHint: true,
          pickerCandidates: candidates,
          pickerSummaries: summaries,
          pickerAt: undefined,
          pickerPrompt: redactText(view.prompt),
          inputSecret: view.secret === true,
        };
      }
      requestPaint(true);
    };
    const source = createKeySource((batch) => {
      let quit = false;
      for (const key of batch) {
        const modelCandidates = options.onModelCandidates?.() ??
          (options.onRoutes?.() ?? []).map((value) => ({ value, summary: "" }));
        const authCandidates = options.onAuthCandidates?.() ?? [];
        const env = {
          visible: visiblePanes(cached?.view),
          viewport: Math.max(1, (process.stdout.rows ?? 24) - 6),
          matching: matchingPanes(cached?.view, ui.query, process.stdout.columns ?? 80),
          routes: modelCandidates.map((candidate) => candidate.value),
          effortLevels: EFFORT_LEVELS,
          routeSummaries: Object.fromEntries(modelCandidates.map((candidate) => [candidate.value, candidate.summary])),
          modelCandidates,
          modelDetails: modelCandidates,
          authRoutes: authCandidates.map((candidate) => candidate.value),
          authSummaries: Object.fromEntries(authCandidates.map((candidate) => [candidate.value, candidate.summary])),
          sessions: sessionNames,
          matchTotals:
            ui.query !== undefined && ui.focus !== undefined && cached?.view
              ? { [ui.focus]: countMatches(cached.view, ui.focus, ui.query, process.stdout.columns ?? 80) }
              : undefined,
          toolFailures: cached?.view.tools.filter((row) => row.error).map(toolKey),
          now: Date.now(),
        };
        const wasTyping = ui.input !== undefined;
        let state = ui;
        let action: UiAction | undefined;
        const permissionInput = routePermissionInput(
          cached?.view.events ?? [],
          key,
          options.onSsh !== undefined || options.onGithubAdmin !== undefined,
        );
        const handoffInput = permissionInput.captured
          ? { captured: false as const }
          : routeHandoffPromptInput(ui.handoffPrompt, key);
        if (permissionInput.captured) {
          action = permissionInput.action;
          if (!action) {
            ui = setNotice(ui, "permission request waiting — choose a listed action or Esc", Date.now());
            continue;
          }
        } else if (handoffInput.captured) {
          if (!handoffInput.action && !handoffInput.dismiss) {
            ui = setNotice(ui, "model handoff waiting — choose 1 carry, 2 slim, or Esc", Date.now());
            requestPaint(true);
            continue;
          }
          ui = { ...ui, handoffPrompt: undefined };
          state = ui;
          if (handoffInput.dismiss) {
            ui = setNotice(ui, "model switch cancelled — nothing changed", Date.now());
            requestPaint(true);
            continue;
          }
          action = handoffInput.action;
        } else {
          ({ state, action } = applyKey(ui, key, env));
        }
        if (!wasTyping && state.input !== undefined) {
          // Prompt just opened: pin its destination now.
          noteTarget = dirname(options.resolvePath?.() ?? options.path);
        }
        ui = state;
        if (action?.type === "quit") {
          quit = true;
          break;
        }
        if (action?.type === "route") {
          if (options.onRoute) {
            ui = { ...ui, notice: action.text ? "selecting model…" : "reading model selection…" };
            void Promise.resolve().then(() => options.onRoute?.(action.text)).then((message) => {
              noteError = undefined;
              if (isHandoffConfirmation(message)) {
                // A large carry opens the MODEL HANDOFF modal instead of a
                // footer notice an operator could read as an error.
                ui = { ...ui, handoffPrompt: message, notice: undefined };
              } else if (typeof message === "string" && message.length > 0) {
                ui = { ...ui, notice: redactText(message) };
              }
            }).catch((error) => {
              noteError = `route not set: ${redactText(error instanceof Error ? error.message : String(error))}`;
            }).finally(() => requestPaint(true));
          } else {
            ui = { ...ui, notice: "route control is chat-mode only — start with dokkabi chat" };
          }
        }
        if (action?.type === "model-favorite") {
          if (!options.onModelFavorite) {
            ui = setNotice(ui, "model favorites are chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onModelFavorite?.(action.route, action.model)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
              const refreshed = options.onModelCandidates?.();
              if (refreshed && ui.picker === "route") {
                ui = {
                  ...ui,
                  pickerCandidates: refreshed.map((candidate) => candidate.value),
                  pickerSummaries: Object.fromEntries(refreshed.map((candidate) => [candidate.value, candidate.summary])),
                  pickerDetails: refreshed,
                };
              }
            }).catch((error) => {
              ui = setNotice(ui, `favorite not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "limits") {
          if (!options.onLimits) {
            ui = setNotice(ui, "model limits are chat-mode only — start with dokkabi chat", Date.now());
          } else {
            ui = setNotice(ui, "reading model limits…", Date.now());
            void Promise.resolve().then(() => options.onLimits?.({ refresh: action.refresh === true })).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `limits unavailable: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "effort") {
          if (!options.onEffort) {
            ui = setNotice(ui, "effort control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onEffort?.(action.level || undefined)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `effort not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "failover") {
          if (!options.onFailover) {
            ui = setNotice(ui, "failover control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onFailover?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `failover not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "ssh") {
          if (!options.onSsh) {
            ui = setNotice(ui, "SSH control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onSsh?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `SSH approval not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "github-admin") {
          if (!options.onGithubAdmin) {
            ui = setNotice(ui, "GitHub administration control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onGithubAdmin?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `GitHub administration approval not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "mcp") {
          if (!options.onMcp) {
            ui = setNotice(ui, "MCP control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onMcp?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `MCP approval not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "plugin") {
          if (!options.onPlugin) {
            ui = setNotice(ui, "managed plugin control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onPlugin?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `managed plugin approval not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "permissions") {
          if (!options.onPermissions) {
            ui = setNotice(ui, "permission control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            void Promise.resolve().then(() => options.onPermissions?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `permission mode not changed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "resume") {
          if (!options.onResume) {
            ui = setNotice(ui, "resume control is chat-mode only — start with dokkabi chat", Date.now());
          } else {
            ui = setNotice(ui, "inspecting saved context…", Date.now());
            void Promise.resolve().then(() => options.onResume?.(action.text)).then((message) => {
              if (typeof message === "string") ui = setNotice(ui, redactText(message), Date.now());
            }).catch((error) => {
              ui = setNotice(ui, `resume failed: ${redactText(error instanceof Error ? error.message : String(error))}`, Date.now());
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "session") {
          const interactive = options.onNote !== undefined || options.onRoute !== undefined;
          if (!sessionSwitchAllowed({ interactive })) {
            ui = setNotice(
              ui,
              "cannot switch sessions on a chat-attached board — the note seam belongs to its own session",
              Date.now(),
            );
          } else {
            const target = resolveSessionTarget(action.name, dokkabiHome());
            if (target.ok) {
              switched = { path: target.path, label: target.label };
              // A new session is a new world: viewing state resets, operator
              // context (history, notices) survives.
              ui = setNotice(
                { ...ui, scroll: {}, focus: undefined, zoom: false, query: undefined, filters: {}, matchIdx: {}, expandedTool: undefined },
                `switched to ${target.label}`,
                Date.now(),
              );
              refreshSessionNames();
            } else {
              ui = setNotice(ui, target.reason, Date.now());
            }
          }
        }
        if (action?.type === "layout-save") {
          if (options.replay) {
            ui = setNotice(ui, "layout save is unavailable in replay mode", Date.now());
          } else {
            try {
              saveLayoutConfig(layoutConfigPath(), layout);
              ui = setNotice(ui, `layout saved to ${layoutConfigPath()}`, Date.now());
            } catch (error) {
              ui = setNotice(ui, `layout not saved: ${error instanceof Error ? error.message : String(error)}`, Date.now());
            }
          }
        }
        if (action?.type === "login") {
          if (!options.onLogin) {
            ui = { ...ui, notice: "account login is chat-mode only — start with dokkabi chat" };
          } else if (activeAuth) {
            ui = { ...ui, notice: "an account login is already in progress" };
          } else {
            const abort = new AbortController();
            const session = new TuiAuthSession({ onView: showAuthView, openUrl: openProviderUrl, signal: abort.signal });
            activeAuth = { session, abort };
            ui = { ...ui, notice: `starting provider login for ${action.route}…` };
            void Promise.resolve().then(() => options.onLogin?.(action.route, session)).then((message) => {
              if (message === undefined) throw new Error("account login became unavailable");
              ui = { ...ui, notice: redactText(message) };
              noteError = undefined;
            }).catch((error) => {
              ui = { ...ui, notice: redactText(error instanceof Error ? error.message : String(error)) };
            }).finally(() => {
              session.cancel();
              if (activeAuth?.session === session) {
                activeAuth = undefined;
                clearAuthInput();
              }
              requestPaint(true);
            });
          }
        }
        if (action?.type === "logout") {
          if (!options.onLogout) {
            ui = { ...ui, notice: "account logout is chat-mode only — start with dokkabi chat" };
          } else {
            ui = { ...ui, notice: `removing provider credential for ${action.route}…` };
            void Promise.resolve().then(() => options.onLogout?.(action.route)).then((message) => {
              if (message === undefined) throw new Error("account logout became unavailable");
              ui = { ...ui, notice: redactText(message) };
              noteError = undefined;
            }).catch((error) => {
              ui = { ...ui, notice: redactText(error instanceof Error ? error.message : String(error)) };
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "auth-input") {
          if (!activeAuth) {
            ui = { ...ui, notice: "no authentication prompt is waiting" };
          } else {
            try {
              activeAuth.session.submit(action.text);
            } catch (error) {
              ui = { ...ui, notice: redactText(error instanceof Error ? error.message : String(error)) };
              if (currentAuthView?.prompt) showAuthView(currentAuthView);
            }
          }
        }
        if (action?.type === "auth-cancel") {
          activeAuth?.abort.abort();
          activeAuth?.session.cancel();
          activeAuth = undefined;
          ui = { ...ui, notice: "authentication cancelled" };
        }
        if (action?.type === "copy-selection") {
          const selection = ui.selection;
          if (selection && cached?.view) {
            const text = extractSelection(cached.view, {
              ...options,
              path: switched?.path ?? options.resolvePath?.() ?? options.path,
              cols: process.stdout.columns ?? 80,
              rows: process.stdout.rows ?? 24,
              inputDraft: ui.input,
              now: Date.now(),
            } as never, selection);
            if (text.length > 0 && tty) {
              // OSC 52: the terminal owns the clipboard; base64 keeps every
              // glyph intact. Terminals without OSC 52 use /mouse off.
              process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
              const copied = `copied ${[...text].length} chars`;
              ui = setNotice(
                ui,
                osc52Supported()
                  ? copied
                  : `${copied} — this terminal ignores OSC 52; /mouse off restores native copy`,
                Date.now(),
              );
            }
          }
          requestPaint(true);
          continue;
        }
        if (action?.type === "mouse") {
          const says: Record<MouseMode, string> = {
            capture: "mouse=capture — wheel scrolls MODEL STREAM; the app owns drag (OSC 52 copy)",
            wheel: "mouse=wheel — wheel scrolls MODEL STREAM; drag stays the terminal's",
            native: "mouse=native — the terminal owns the mouse; wheel is not captured",
          };
          const next = action.mode ?? (action.enabled === undefined
            ? mouseMode
            : action.enabled ? "capture" : "native");
          if (next !== mouseMode) {
            mouseMode = next;
            mouseOn = next !== "native";
            // Clear every mode before setting one: a terminal left in 1002
            // while 1000 is requested keeps reporting motion.
            if (tty) process.stdout.write(MOUSE_OFF + mouseSequence(mouseMode));
          }
          ui = setNotice(state, says[mouseMode], Date.now());
          requestPaint(true);
          continue;
        }
        if (action?.type === "theme") {
          // Representation-layer only: a theme change never touches the
          // observed log, so unlike route/note this acts in attach and replay
          // modes too — no seam, no ownership question. Validation already ran
          // in the command; setActiveTheme can only refuse an unknown name.
          if (setActiveTheme(action.name)) {
            ui = { ...ui, notice: `theme set to ${action.name.toLowerCase()}` };
          } else {
            ui = { ...ui, notice: `unknown theme "${action.name}"` };
          }
        }
        if (action?.type === "freeswarm") {
          if (!options.onFreeswarm) {
            ui = { ...ui, notice: "두레 control needs a live chat session — run dokkabi chat" };
          } else {
            try {
              ui = { ...ui, notice: redactText(options.onFreeswarm(action.text)) };
            } catch (error) {
              ui = { ...ui, notice: redactText(error instanceof Error ? error.message : String(error)) };
            }
          }
          requestPaint(true);
        }
        if (action?.type === "heung") {
          let heungAccepted = false;
          if (options.onHeung) {
            try {
              ui = { ...ui, notice: options.onHeung(action.enabled) };
              noteError = undefined;
              heungAccepted = true;
            } catch (error) {
              noteError = `HEUNG control failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else {
            ui = { ...ui, notice: "HEUNG control needs a live work board" };
          }
          if (heungAccepted && action.text) {
            if (options.onNote) {
              try {
                const delivery = options.onNote(action.text);
                noteError = undefined;
                if (delivery === "inbox") {
                  ui = { ...ui, notice: "HEUNG=on; note staged for the next turn" };
                }
              } catch (error) {
                noteError = `note not delivered: ${error instanceof Error ? error.message : String(error)}`;
              }
            } else {
              const sessionDir = noteTarget ?? dirname(options.resolvePath?.() ?? options.path);
              try {
                pushOperatorMessage(operatorInboxPath(sessionDir), action.text);
                noteError = undefined;
                ui = { ...ui, notice: "HEUNG=on; note staged for the next turn" };
              } catch (error) {
                noteError = `note not saved: ${error instanceof Error ? error.message : String(error)}`;
              }
            }
            noteTarget = undefined;
          }
        }
        if (action?.type === "knowledge") {
          if (!options.onKnowledge) {
            ui = { ...ui, notice: "knowledge control is unavailable — configure it with dokkabi knowledge init" };
          } else {
            ui = { ...ui, notice: "reading knowledge vault…" };
            void Promise.resolve().then(() => options.onKnowledge?.(action.text)).then((message) => {
              if (message === undefined) throw new Error("knowledge control became unavailable");
              ui = { ...ui, notice: redactText(message) };
              noteError = undefined;
            }).catch((error) => {
              noteError = `knowledge command failed: ${redactText(error instanceof Error ? error.message : String(error))}`;
            }).finally(() => requestPaint(true));
          }
        }
        if (action?.type === "interrupt") {
          const sessionDir = noteTarget ?? dirname(options.resolvePath?.() ?? options.path);
          const result = options.onInterrupt
            ? options.onInterrupt()
            : { aborted: false, restored: popOperatorMessage(operatorInboxPath(sessionDir)) };
          const restored = result.restored;
          if (typeof restored === "string" && restored.length > 0) {
            ui = {
              ...ui,
              input: restored,
              cursor: [...restored].length,
              historyAt: undefined,
              historyDraft: undefined,
              notice: result.aborted
                ? "turn cancelled · queued note restored"
                : "queued note restored",
            };
          } else if (result.aborted) {
            ui = { ...ui, notice: "turn cancelled" };
          }
        }
        if (action?.type === "note") {
          if (options.onNote) {
            try {
              const delivery = options.onNote(action.text);
              noteError = undefined;
              if (delivery === "inbox") {
                ui = { ...ui, notice: "note staged (kernel busy) — rides the next turn" };
              }
            } catch (error) {
              noteError = `note not delivered: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else {
            const sessionDir = noteTarget ?? dirname(options.resolvePath?.() ?? options.path);
            try {
              pushOperatorMessage(operatorInboxPath(sessionDir), action.text);
              noteError = undefined;
            } catch (error) {
              // A failed write used to escape the stdin handler as an uncaught
              // exception, killing the board and leaving the terminal in raw
              // mode inside the alt-screen.
              noteError = `note not saved: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          noteTarget = undefined;
        }
      }
      if (quit) {
        resolve();
        return;
      }
      requestPaint(true);
    });
    keySource = source;
    process.stdin.on("data", (chunk) => source.push(chunk as Uint8Array));
  }), shutdown.promise]);
  } finally {
    cancelInteractive();
    restore();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
  }
}

/** Panes whose body holds the active search term — the n / N ring. */
function matchingPanes(
  view: DashProjection | undefined,
  query: string | undefined,
  cols: number,
): WidgetId[] {
  if (!view || !query) {
    return [];
  }
  const width = Math.max(20, Math.floor(cols / 3) - 2);
  return ALL_WIDGETS.filter((widget) => {
    if (!widget.relevant(view)) {
      return false;
    }
    // A generous row budget: the hit may be far off the visible tail, and the
    // point of n is to reach exactly those.
    const lines = widget.lines({ view, width, rows: 4_000, focused: false, scroll: 0, query, now: 0 });
    return lines.some((line) => line.match === true);
  }).map((widget) => widget.id);
}

/** How many query hits one pane holds — the match ring's size for the
 * cycling keys (#51). Same line pipeline matchingPanes uses. */
function countMatches(
  view: DashProjection,
  widgetId: WidgetId,
  query: string,
  cols: number,
): number {
  const widget = ALL_WIDGETS.find((candidate) => candidate.id === widgetId);
  if (!widget || !widget.relevant(view)) {
    return 0;
  }
  const width = Math.max(20, Math.floor(cols / 3) - 2);
  const lines = widget.lines({ view, width, rows: 4_000, focused: false, scroll: 0, query, now: 0 });
  return lines.filter((line) => line.match === true).length;
}

/** The Tab ring: panes actually on the board for this projection. */
function visiblePanes(view: DashProjection | undefined): WidgetId[] {
  if (!view) {
    return ALL_WIDGETS.map((widget) => widget.id);
  }
  return ALL_WIDGETS.filter((widget) => widget.relevant(view)).map((widget) => widget.id);
}
