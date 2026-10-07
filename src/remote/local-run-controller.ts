import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { EventLog } from "../host/event-log.ts";
import { sessionDir, sessionLogPath } from "../host/paths.ts";
import { runsFromProcesses } from "../host/run-discovery.ts";
import { logPathOf } from "../host/run-registry.ts";
import { operatorInboxPath, pushOperatorMessage } from "../work/inbox.ts";
import { parseGateDecision } from "../work/prompt.ts";
import { remoteMessages, type RemoteLocale } from "./locale.ts";
import type {
  RemoteRunController,
  RemoteRunHandle,
  RemoteRunResult,
  RemoteRunSnapshot,
} from "./types.ts";
import { RemoteStateError } from "./types.ts";

export interface RemoteChildProcessRequest {
  readonly cliPath: string;
  readonly sessionId: string;
  readonly text: string;
  readonly workspaceRoot: string;
}

export interface RemoteChildProcess {
  readonly exited: Promise<number>;
  readonly pid: number;
  kill(): boolean;
}

interface LocalRemoteRunControllerInput {
  readonly cliPath: string;
  readonly locale?: RemoteLocale;
  readonly recover?: (sessionId: string) => RemoteChildProcess | undefined;
  readonly spawn?: (request: RemoteChildProcessRequest) => RemoteChildProcess;
  readonly workspaceRoot: string;
}

type ActiveRun = Readonly<{
  process: RemoteChildProcess;
  requestId: string;
  sessionId: string;
}>;

export function createLocalRemoteRunController(
  input: LocalRemoteRunControllerInput,
): RemoteRunController {
  const recover = input.recover ?? recoverRemoteChild;
  const spawn = input.spawn ?? spawnRemoteChild;
  const cancelled = new Set<string>();
  let active: ActiveRun | undefined;

  return {
    snapshot(): RemoteRunSnapshot {
      return active
        ? { kind: "running", requestId: active.requestId, sessionId: active.sessionId }
        : { kind: "idle" };
    },
    async start(request): Promise<RemoteRunHandle> {
      if (active) throw new RemoteStateError("start remote run", `request ${active.requestId} is active`);
      const sessionId = remoteSessionId(request.requestId);
      const process = recover(sessionId) ?? spawn({
        cliPath: input.cliPath,
        sessionId,
        text: request.text,
        workspaceRoot: input.workspaceRoot,
      });
      active = { process, requestId: request.requestId, sessionId };
      const completion = process.exited.then((code): RemoteRunResult => {
        const wasCancelled = cancelled.delete(request.requestId);
        if (active?.requestId === request.requestId) active = undefined;
        if (wasCancelled) return { kind: "cancelled" };
        if (code !== 0) return { kind: "failed", reason: `Dokkabi work exited with code ${code}` };
        return {
          kind: "completed",
          summary: childSummary(sessionId, request.requestId, input.locale),
        };
      });
      return { completion, requestId: request.requestId, sessionId };
    },
    async attach(request): Promise<void> {
      const current = active;
      if (!current) throw new RemoteStateError("attach remote note", "no active run");
      pushOperatorMessage(operatorInboxPath(sessionDir(current.sessionId)), request.text);
    },
    async cancel(requestId): Promise<boolean> {
      const current = active;
      if (!current || current.requestId !== requestId) return false;
      cancelled.add(requestId);
      return current.process.kill();
    },
  };
}

function remoteSessionId(requestId: string): string {
  const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 20);
  return `remote-${digest}`;
}

export function childSummary(
  sessionId: string,
  requestId: string,
  locale: RemoteLocale = "en",
): string {
  const fallback = remoteMessages(locale).workComplete;
  const path = sessionLogPath(sessionId);
  if (!existsSync(path)) return fallback;
  const log = new EventLog(path);
  for (let index = log.events.length - 1; index >= 0; index -= 1) {
    const event = log.events[index];
    if (event?.name === "assistant/message" && typeof event.payload.text === "string") {
      const speech = parseGateDecision(event.payload.text).speech.trim();
      if (speech.length > 0) return speech;
    }
  }
  return fallback;
}

function spawnRemoteChild(request: RemoteChildProcessRequest): RemoteChildProcess {
  const child = Bun.spawn(
    [
      process.execPath,
      request.cliPath,
      "work",
      // A remote work request runs the gated graph planner it always ran; the
      // CLI default is the ledger (D43).
      "--planner",
      "host",
      "--session",
      request.sessionId,
      "--workspace",
      request.workspaceRoot,
      request.text,
    ],
    {
      cwd: request.workspaceRoot,
      env: process.env,
      stderr: "ignore",
      stdout: "ignore",
    },
  );
  return {
    exited: child.exited,
    kill() {
      child.kill();
      return true;
    },
    pid: child.pid,
  };
}

function recoverRemoteChild(sessionId: string): RemoteChildProcess | undefined {
  const expectedLog = sessionLogPath(sessionId);
  const run = runsFromProcesses().find(
    (candidate) => candidate.session === sessionId && logPathOf(candidate) === expectedLog,
  );
  if (!run) return undefined;
  return {
    exited: waitForProcessExit(run.pid),
    kill() {
      try {
        process.kill(run.pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
    pid: run.pid,
  };
}

function waitForProcessExit(pid: number): Promise<number> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(timer);
        resolve(0);
      }
    }, 1000);
    timer.unref?.();
  });
}
