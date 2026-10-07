import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { bootSession, defaultManifestPath } from "../boot.ts";
import { EventLog } from "../host/event-log.ts";
import { readConfig } from "../host/config.ts";
import { dokkabiHome, resolveWorkspaceSessionId, sessionDir, sessionLogPath } from "../host/paths.ts";
import type { HostSampler } from "../plugins/host-sampler.ts";
import { logPathOf, openableRuns, runIsLive, type RunRecord } from "../host/run-registry.ts";
import { bindPlanFile, defaultWorkPlanPath } from "../work/log.ts";
import { readHeungControl, resolveHeung, writeHeungControl } from "../work/heung.ts";
import { listenDash } from "./http.ts";
import { runDash } from "./tui.ts";
import { buildModelPickerCandidates } from "../chat/model-picker.ts";
import { hostedModelCatalogs } from "../plugins/model-catalog.ts";
import { createHostedModels } from "../plugins/hosted-models.ts";
import { readModelPreferences, toggleModelFavorite } from "../host/model-preferences.ts";
import { selectDefaultModel } from "./model-default.ts";

export const DEFAULT_SESSION = "live";

/**
 * SWE runs open one session per instance (context resets between instances).
 * A bare `swe` board request follows the newest `swe-*` session instead of
 * erroring or showing a stale one.
 */
export function resolveSweSession(requested: string, home: string): string {
  if (requested !== "swe") {
    return requested;
  }
  const sessionsDir = join(home, "sessions");
  let candidates: { name: string; mtime: number; finished: boolean }[] = [];
  try {
    candidates = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const logPath = join(sessionsDir, entry.name, "events.jsonl");
        if (!existsSync(logPath)) {
          return { name: entry.name, mtime: 0, finished: false };
        }
        return {
          name: entry.name,
          mtime: statSync(logPath).mtimeMs,
          finished: logFinishedRun(logPath),
        };
      })
      .filter((entry) => entry.mtime > 0);
  } catch {
    return requested;
  }
  const exact = candidates.find((entry) => entry.name === requested);
  if (exact && candidates.every((entry) => entry.name === requested || entry.mtime <= exact.mtime)) {
    return requested;
  }
  const pool = candidates
    .filter((entry) => entry.name === requested || entry.name.startsWith(`${requested}-`))
    .sort((a, b) => b.mtime - a.mtime);
  // A run without swe/result yet is the live one: follow it even when a
  // finished session's mtime keeps moving (observer noise), so the board
  // never ping-pongs between two sessions.
  const live = pool.filter((entry) => !entry.finished);
  return (live[0] ?? pool[0])?.name ?? requested;
}

/** True when the session log carries swe/result — the run finished. */
function logFinishedRun(logPath: string): boolean {
  try {
    const text = readFileSync(logPath, "utf8");
    return text.includes('"swe/result"');
  } catch {
    return false;
  }
}


export type SessionRequest =
  | { kind: "session"; sessionId: string }
  | { kind: "log"; path: string }
  | { kind: "missing-path"; path: string };

/**
 * What `--session VALUE` actually names.
 *
 * The flag takes an id, but a path is what an operator gets from tab
 * completion, and the old failure pasted that path under `sessions/` and
 * reported the nonsense it built. A value that looks like a path is treated
 * as one: inside DOKKABI_HOME it resolves back to its id, outside it opens
 * as a log.
 */
export function resolveSessionRequest(requested: string, home: string): SessionRequest {
  const looksLikePath = requested.includes(sep) || requested.startsWith("~");
  if (!looksLikePath) {
    return { kind: "session", sessionId: requested };
  }
  const expanded = requested.startsWith("~")
    ? join(process.env.HOME ?? "", requested.slice(1))
    : requested;
  const full = isAbsolute(expanded) ? expanded : resolve(expanded);
  const logPath = basename(full) === "events.jsonl" ? full : join(full, "events.jsonl");
  if (!existsSync(logPath)) {
    return { kind: "missing-path", path: requested };
  }
  // A log under this home is a session: keep the id so plan binding, the
  // operator inbox and session rollover all keep working.
  const sessionsRoot = join(home, "sessions");
  const dir = dirname(logPath);
  if (dirname(dir) === sessionsRoot) {
    return { kind: "session", sessionId: basename(dir) };
  }
  return { kind: "log", path: logPath };
}

/**
 * Session names close to what was asked for. Instance ids are long
 * (`swe-astropy__astropy-14182`) and get retyped from memory, so a shared
 * run of digits or a shared prefix counts for more than edit distance.
 */
export function nearestSessions(requested: string, available: readonly string[], take = 3): string[] {
  const want = requested.toLowerCase();
  const digits = want.match(/\d{3,}/g) ?? [];
  const scored = available
    .map((name) => {
      const lower = name.toLowerCase();
      let score = 0;
      for (const run of digits) {
        if (lower.includes(run)) {
          score += 10 + run.length;
        }
      }
      if (lower.includes(want) || want.includes(lower)) {
        score += 6;
      }
      const shared = commonPrefix(lower, want);
      if (shared >= 3) {
        score += shared;
      }
      return { name, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, take).map((row) => row.name);
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

/**
 * A recorded run carrying this session id, in any home.
 *
 * `dash --list` names runs from every home it knows about, so every name it
 * prints has to be openable by `--session <that name>`. Without this the
 * listing advertises sessions the flag then refuses.
 */
export function runForSession(
  session: string,
  env: NodeJS.Dict<string> = process.env,
): RunRecord | undefined {
  const matches = openableRuns(env).filter((run) => run.session === session);
  return matches.find(runIsLive) ?? matches[0];
}

/**
 * The run worth opening when the operator named none: a live process first,
 * then the most recent log that still exists. Runs under this home win ties
 * so the plain `--session live` path keeps working.
 */
function newestRun(home: string): RunRecord | undefined {
  const runs = openableRuns();
  if (runs.length === 0) {
    return undefined;
  }
  const live = runs.filter(runIsLive);
  const pool = live.length > 0 ? live : runs;
  return pool.find((run) => run.home === home) ?? pool[0];
}

/** Watch a log that is not a session of this home. Live, not replay. */
async function observeLog(
  path: string,
  sessionId: string,
  input: { once?: boolean; listen?: boolean },
): Promise<{ url?: string; path: string; sessionId: string }> {
  let url: string | undefined;
  let server: { stop: () => void } | undefined;
  if (input.listen !== false) {
    const http = listenDash({ path, replay: false });
    url = http.url;
    server = http.server;
  }
  try {
    await runDash({
      path,
      replay: false,
      url,
      once: input.once,
      sessionLabel: sessionId,
      onHeung: (enabled) => controlHeung(dirname(path), enabled),
    });
  } finally {
    server?.stop();
  }
  return { url, path, sessionId };
}

/** Session ids under a home, sorted. Empty when the home has none. */
function listSessions(home: string): string[] {
  try {
    return readdirSync(join(home, "sessions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function startDash(input: {
  repoRoot: string;
  sessionId?: string;
  workspaceRoot: string;
  replayPath?: string;
  planPath?: string;
  once?: boolean;
  listen?: boolean;
}): Promise<{ url?: string; path: string; sessionId: string }> {
  if (input.replayPath) {
    const path = input.replayPath;
    if (!existsSync(path)) {
      throw new Error(`no EventLog at ${path}`);
    }
    let url: string | undefined;
    let server: { stop: () => void } | undefined;
    if (input.listen !== false) {
      const http = listenDash({ path, replay: true });
      url = http.url;
      server = http.server;
    }
    await runDash({ path, replay: true, url, once: input.once });
    server?.stop();
    return { url, path, sessionId: input.sessionId ?? "replay" };
  }

  const home = dokkabiHome();
  // With no --session, follow the newest run that left a breadcrumb. A SWE
  // campaign writes under a throwaway DOKKABI_HOME and deletes it afterwards,
  // so an operator otherwise has to find the home and the instance id by
  // hand for every instance.
  const followed = input.sessionId === undefined ? newestRun(home) : undefined;
  // Else this workspace's latest session, for the workspace the dash was
  // given (resolved the way `dokkabi work` resolves it, D49).
  const request = resolveSessionRequest(input.sessionId ?? followed?.session ?? resolveWorkspaceSessionId(input.workspaceRoot), home);
  if (followed && followed.home !== home) {
    // Another home's live run: observe its log directly. Not a replay — the
    // run is still appending and the board must follow it.
    return observeLog(logPathOf(followed), followed.session, input);
  }
  if (request.kind === "log") {
    // A log outside this home cannot be booted as a session: open it the way
    // `--replay` would, rather than refusing a file the operator can see.
    let url: string | undefined;
    let server: { stop: () => void } | undefined;
    if (input.listen !== false) {
      const http = listenDash({ path: request.path, replay: true });
      url = http.url;
      server = http.server;
    }
    await runDash({ path: request.path, replay: true, url, once: input.once });
    server?.stop();
    return { url, path: request.path, sessionId: basename(dirname(request.path)) };
  }
  if (request.kind === "missing-path") {
    // The path is wrong, but its last segment usually still names the run the
    // operator had in mind, so suggest from that rather than only refusing.
    const near = nearestSessions(basename(request.path.replace(/\/+$/, "")), listSessions(home));
    const lead = near.length > 0 ? ` Did you mean --session ${near.join(", or ")}?` : "";
    throw new Error(
      `no EventLog at ${request.path} (read as a path because it contains '${sep}').${lead} Pass a session id, or --replay PATH for a log elsewhere.`,
    );
  }
  const requestedSession = request.sessionId;
  // Per-instance swe sessions: a bare `swe` follows the newest run.
  const sessionId = resolveSweSession(requestedSession, home);
  // Never boot a phantom session for the board: a missing log means the
  // operator pointed at the wrong home, and an all-"missing" board lies.
  const logPath = join(sessionDir(sessionId), "events.jsonl");
  if (!existsSync(sessionDir(sessionId))) {
    // Not under this home, but the registry may know which home has it —
    // that is how a SWE instance's session is reachable by its own name.
    const elsewhere = runForSession(sessionId);
    if (elsewhere) {
      return observeLog(logPathOf(elsewhere), elsewhere.session, input);
    }
    const available = listSessions(home);
    if (requestedSession === "swe" && sessionId === "swe") {
      throw new Error(
        `no SWE campaign yet under ${home}/sessions (no swe-* EventLog). Start one with bun scripts/run-swe-instance.ts, then dash --session swe follows the newest swe-*.${
          available.length > 0 ? ` available: ${available.join(", ")}.` : " no sessions there yet."
        }`,
      );
    }
    if (available.length === 0) {
      throw new Error(`no session '${sessionId}' at ${logPath}: no sessions under ${home}/sessions yet.`);
    }
    // Lead with the names worth retyping. The full list is long enough that
    // an operator stops reading before reaching the one they meant.
    // Suggest from the registry too: those names are openable.
    const known = [...new Set([...available, ...openableRuns().map((run) => run.session)])].sort();
    const near = nearestSessions(sessionId, known);
    const lead = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "";
    throw new Error(
      `no session '${sessionId}' under ${home}/sessions.${lead}\nall sessions: ${available.join(", ")}`,
    );
  }
  const { ctx, runtime } = await bootSession({
    sessionId,
    workspaceRoot: input.workspaceRoot,
    manifestPath: defaultManifestPath(input.repoRoot),
    repoRoot: input.repoRoot,
    readOnly: true,
  });
  let planRetry: ReturnType<typeof setInterval> | undefined;
  let server: { stop: () => void } | undefined;
  try {
  // The WORK cell shows the plan of the workspace being observed — a probe
  // checkout, not the Dokkabi repo's own leftover plan (probe 7b dashboard).
  const planPath = input.planPath ?? defaultWorkPlanPath(input.workspaceRoot);
  // Probe plans are unsealed mid-flight; an unreadable plan must not kill the
  // board — events still flow, WORK just shows missing until the seal lands.
  let planBound = false;
  const tryBindPlan = () => {
    if (planBound) {
      return;
    }
    try {
      bindPlanFile(ctx.log, planPath);
      planBound = true;
    } catch {
      // plan not readable yet; the retry interval below keeps trying
    }
  };
  tryBindPlan();
  planRetry =
    planBound || input.once === true
      ? undefined
      : setInterval(() => {
          tryBindPlan();
          if (planBound) {
            clearInterval(planRetry);
          }
        }, 2_000);
  planRetry?.unref?.();
  const sampler = ctx.get<HostSampler>("host");
  sampler.start(5000);

  const path = ctx.log.path;
  let url: string | undefined;
  if (input.listen !== false) {
    const http = listenDash({ path, replay: false });
    url = http.url;
    server = http.server;
  }
  await runDash({
    path: ctx.log.path,
    replay: false,
    url,
    once: input.once,
    planPath,
    // The board re-resolves the newest run session every paint: a running
    // dash hops to a rolled-over swe-<instance> session without restart.
    resolvePath: () => sessionLogPath(resolveSweSession(requestedSession, dokkabiHome())),
    // `/model` opens the same arrow-key picker here as in chat. Without these
    // seams the board fell back to bare route names with no summaries, and on
    // an attached board it showed nothing at all — the operator saw an empty
    // list and assumed the command was broken (dash/model-default.ts).
    ...(ctx.llm
      ? {
          onModelCandidates: () => buildModelPickerCandidates({
            routes: [...ctx.llm!.routes.entries()]
              .filter(([name]) => name !== "replay")
              .map(([name, route]) => ({
                name,
                provider: route.providerId,
                ...(route.defaultModelId() ? { defaultModel: route.defaultModelId()! } : {}),
              })),
            catalogs: hostedModelCatalogs(createHostedModels()),
            selection: { route: ctx.llm!.activeName, model: ctx.llm!.activeModelId ?? ctx.llm!.active().defaultModelId() },
            preferences: readModelPreferences(),
          }),
          onRoute: (choice: string) => selectDefaultModel({ choice, llm: ctx.llm! }),
          onModelFavorite: (route: string, model: string) =>
            toggleModelFavorite({ route, model })
              ? `favorite added ${route}/${model}`
              : `favorite removed ${route}/${model}`,
        }
      : {}),
    onHeung: (enabled) => {
      const livePath = sessionLogPath(resolveSweSession(requestedSession, dokkabiHome()));
      return controlHeung(dirname(livePath), enabled);
    },
  });
  return { url, path, sessionId };
  } finally {
    try {
      if (planRetry) {
        clearInterval(planRetry);
      }
      server?.stop();
    } finally {
      await runtime.dispose();
    }
  }
}

function controlHeung(sessionDirectory: string, enabled?: boolean): string {
  if (enabled !== undefined) writeHeungControl(sessionDirectory, enabled);
  const current = readHeungControl(sessionDirectory);
  if (current === undefined) {
    const config = readConfig();
    const effective = resolveHeung({ config: config.heung, legacyConfig: config.crunchmode });
    return `HEUNG=${effective ? "on" : "off"} (default)`;
  }
  return `HEUNG=${current ? "on" : "off"}`;
}

export function openLog(path: string): EventLog {
  return new EventLog(path);
}
