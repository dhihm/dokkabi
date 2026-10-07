import type { OwnedWorkResourceRegistry } from "../loader/types.ts";
import { existsSync } from "node:fs";
import { EventLog } from "../host/event-log.ts";
import { sessionLogPath } from "../host/paths.ts";
import type { EventRecord } from "../host/schema.ts";
import { redactText } from "../host/redact.ts";
import { readHeungControl, takeHeungSignal, writeHeungControl } from "../work/heung.ts";
import type { PermissionMode } from "../host/permissions.ts";
import { OperatorAbortError } from "./turn-failure.ts";
import { takeRalphPlanSignal } from "../work/ralph-plan-signal.ts";
import type { ChatFrontendMessageRef } from "./frontend.ts";
import {
  createWorkAdmissionCoordinator,
  newWorkAdmissionCorrelation,
  OWNED_WORK_ADMISSION_ENV,
} from "./work-admission.ts";

export type InteractiveTurnStarter = (
  text: string,
  onAccepted: (message?: ChatFrontendMessageRef) => void,
) => Promise<void> | void;

export interface ChatTurnRouter {
  startTurn: InteractiveTurnStarter;
  abort(): void;
  control(enabled?: boolean): string;
}

export function createChatTurnRouter(input: {
  sessionDir: string;
  startChat: InteractiveTurnStarter;
  startWork: InteractiveTurnStarter;
  abortChat?: () => void;
  startRalphPlan?: InteractiveTurnStarter;
  defaultEnabled?: boolean;
}): ChatTurnRouter {
  let abortCurrent: (() => void) | undefined;
  return {
    startTurn: (text, onAccepted) => {
      const ralph = takeRalphPlanSignal(text);
      if (ralph.activated && input.startRalphPlan) {
        abortCurrent = undefined;
        return input.startRalphPlan(ralph.order, onAccepted);
      }
      // A saved session control, explicit off included, wins over an invocation
      // signal; with none saved the canonical anchored activation itself selects
      // work. The raw text reaches the child untouched — it owns normalization
      // and durable input receipt — and activation alone persists no control.
      const saved = readHeungControl(input.sessionDir);
      if (saved ?? (takeHeungSignal(text).activated || input.defaultEnabled === true)) {
        abortCurrent = undefined;
        return input.startWork(text, onAccepted);
      }
      abortCurrent = () => input.abortChat?.();
      return input.startChat(text, onAccepted);
    },
    abort() {
      (abortCurrent ?? input.abortChat)?.();
    },
    control(next) {
      if (next !== undefined) writeHeungControl(input.sessionDir, next);
      const selected = readHeungControl(input.sessionDir);
      if (selected === undefined) {
        return `HEUNG=${input.defaultEnabled === true ? "on" : "off"} (default)`;
      }
      return `HEUNG=${selected ? "on" : "off"}`;
    },
  };
}

export interface HeungWorkRequest {
  readonly argv: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string;
}

export type HeungWorkExit =
  | { readonly kind: "completed" }
  | { readonly kind: "incomplete"; readonly status: string }
  | { readonly kind: "failed"; readonly reason?: string };

/** A nonzero process status is ambiguous: the work CLI uses it for an honest
 * bounded incomplete outcome as well as an uncaught child failure. Only a
 * matching host-recorded terminal result can downgrade it from failure. */
export function classifyHeungWorkExit(
  exitCode: number,
  events: readonly EventRecord[],
  afterSeq: number,
): HeungWorkExit {
  if (exitCode === 0) return { kind: "completed" };
  const terminal = [...events].reverse().find(
    (event) => event.seq > afterSeq && event.name === "work/run_result",
  );
  if (
    !terminal
    || terminal.payload.outcome !== "incomplete"
    || terminal.payload.exit_code !== exitCode
    || typeof terminal.payload.status !== "string"
    || !/^[a-z0-9_-]{1,40}$/i.test(terminal.payload.status)
  ) {
    const failure = [...events].reverse().find(
      (event) =>
        event.seq > afterSeq
        && event.name === "agent/status"
        && event.payload.status === "failed"
        && typeof event.payload.error === "string",
    );
    const reason = typeof failure?.payload.error === "string"
      ? redactText(failure.payload.error).replace(/\s+/g, " ").trim().slice(0, 240)
      : "";
    return reason ? { kind: "failed", reason } : { kind: "failed" };
  }
  return { kind: "incomplete", status: terminal.payload.status };
}

export function heungWorkRequest(input: {
  sessionId: string;
  workspaceRoot: string;
  route: string;
  model?: string;
  effort?: string;
  text: string;
  cliPath?: string;
  permissionMode?: PermissionMode;
}): HeungWorkRequest {
  const argv = [
    process.execPath,
    input.cliPath ?? process.argv[1] ?? "src/cli.ts",
    "work",
    // HEUNG and Ralph Plan run on the gated graph planner; the CLI default is
    // the ledger (D43).
    "--planner",
    "host",
    "--session",
    input.sessionId,
    "--route",
    input.route,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.permissionMode ? ["--permission-mode", input.permissionMode] : []),
    "--heung",
    "--order-stdin",
  ];
  return {
    argv,
    env: { ...process.env, DOKKABI_WORKSPACE: input.workspaceRoot },
    stdin: input.text,
  };
}

export function ralphPlanWorkRequest(input: {
  sessionId: string;
  workspaceRoot: string;
  route: string;
  model?: string;
  effort?: string;
  text: string;
  cliPath?: string;
  permissionMode?: PermissionMode;
  maxPlanPasses?: number;
}): HeungWorkRequest {
  const argv = [
    process.execPath,
    input.cliPath ?? process.argv[1] ?? "src/cli.ts",
    "work",
    // HEUNG and Ralph Plan run on the gated graph planner; the CLI default is
    // the ledger (D43).
    "--planner",
    "host",
    "--session",
    input.sessionId,
    "--route",
    input.route,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.permissionMode ? ["--permission-mode", input.permissionMode] : []),
    ...(input.maxPlanPasses ? ["--max-plan-passes", String(input.maxPlanPasses)] : []),
    "--ralph-plan-only",
    "--decision",
    "work",
    "--order-stdin",
  ];
  return {
    argv,
    env: { ...process.env, DOKKABI_WORKSPACE: input.workspaceRoot },
    stdin: input.text,
  };
}

export interface StartedWorkProcess {
  abort(): void;
  readonly done: Promise<void>;
}

/** Cancellation during asynchronous release must never launch a child. */
export function startWithOwnedWorkResources(
  launch: () => StartedWorkProcess,
  resources?: OwnedWorkResourceRegistry,
): StartedWorkProcess {
  if (!resources) return launch();
  let child: StartedWorkProcess | undefined;
  let aborted = false;
  return {
    abort() { aborted = true; child?.abort(); },
    done: resources.run(async () => {
      if (aborted) throw new OperatorAbortError();
      child = launch();
      await child.done;
      if (aborted) throw new OperatorAbortError();
    }),
  };
}

export function startHeungWork(
  input: Parameters<typeof heungWorkRequest>[0] & { resources?: OwnedWorkResourceRegistry },
  onAccepted: (message?: ChatFrontendMessageRef) => void,
): StartedWorkProcess {
  return startWithOwnedWorkResources(() => startOwnedWorkProcess({
    request: heungWorkRequest(input),
    sessionId: input.sessionId,
    onAccepted,
    label: "HEUNG",
  }), input.resources);
}

export async function launchHeungWork(
  input: Parameters<typeof heungWorkRequest>[0] & { resources?: OwnedWorkResourceRegistry },
  onAccepted: (message?: ChatFrontendMessageRef) => void,
): Promise<void> {
  return startHeungWork(input, onAccepted).done;
}

export function startRalphPlanWork(
  input: Parameters<typeof ralphPlanWorkRequest>[0] & { resources?: OwnedWorkResourceRegistry },
  onAccepted: (message?: ChatFrontendMessageRef) => void,
): StartedWorkProcess {
  return startWithOwnedWorkResources(() => startOwnedWorkProcess({
    request: ralphPlanWorkRequest(input),
    sessionId: input.sessionId,
    onAccepted,
    label: "Ralph Plan",
  }), input.resources);
}

export async function launchRalphPlanWork(
  input: Parameters<typeof ralphPlanWorkRequest>[0] & { resources?: OwnedWorkResourceRegistry },
  onAccepted: (message?: ChatFrontendMessageRef) => void,
): Promise<void> {
  return startRalphPlanWork(input, onAccepted).done;
}

/** Start one owned work child under the private admission protocol. The
 * child's genuine durable operator input — verified against a fresh session
 * read — is what acceptance means; spawn alone accepts nothing, and a child
 * that exits before that admission (exit 0 included) rejects honestly. */
export function startOwnedWorkProcess(input: {
  request: HeungWorkRequest;
  sessionId: string;
  onAccepted: (message?: ChatFrontendMessageRef) => void;
  label: string;
}): StartedWorkProcess {
  const { request, sessionId, onAccepted, label } = input;
  const logPath = sessionLogPath(sessionId);
  const before = existsSync(logPath) ? new EventLog(logPath, { readOnly: true }).events : [];
  const boundary = {
    seq: before.at(-1)?.seq ?? 0,
    hash: before.at(-1)?.hash ?? "",
  };
  const correlation = newWorkAdmissionCorrelation();
  const coordinator = createWorkAdmissionCoordinator({
    correlation,
    sessionId,
    stdinText: request.stdin,
    logPath,
    boundary,
    onAdmitted: (message) => onAccepted(message),
  });
  const child = Bun.spawn(request.argv, {
    env: { ...request.env, [OWNED_WORK_ADMISSION_ENV]: correlation },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    serialization: "json",
    ipc: (message, subprocess) => coordinator.handleMessage(message, subprocess),
    onDisconnect: (): void => coordinator.handleDisconnect(child),
  });
  let aborted = false;
  let inputFailure: unknown;
  try {
    child.stdin.write(request.stdin);
    child.stdin.end();
  } catch (error) {
    coordinator.abort();
    child.kill();
    inputFailure = error;
  }
  return {
    abort() {
      aborted = true;
      coordinator.abort();
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    },
    done: (async () => {
      const exitCode = await child.exited;
      if (inputFailure !== undefined) throw inputFailure;
      if (aborted) throw new OperatorAbortError();
      const settlement = await coordinator.settlement();
      if (aborted) throw new OperatorAbortError();
      if (settlement.kind === "refused") {
        throw settlement.error instanceof Error
          ? settlement.error
          : new Error(
            `${label} work child was refused admission: ${settlement.reason}`,
          );
      }
      if (settlement.kind === "unadmitted") {
        throw new Error(
          `${label} work child exited before its operator input was admitted`,
        );
      }
      const outcome = classifyHeungWorkExit(exitCode, readSessionEvents(logPath), boundary.seq);
      if (outcome.kind === "failed") {
        throw new Error(
          outcome.reason
            ? `${label} work process failed: ${outcome.reason}`
            : `${label} work process failed; inspect the session alerts and work evidence`,
        );
      }
    })(),
  };
}

function readSessionEvents(path: string): readonly EventRecord[] {
  if (!existsSync(path)) return [];
  try {
    return new EventLog(path, { readOnly: true }).events;
  } catch {
    // A terminal result cannot be trusted when the EventLog is unreadable.
    return [];
  }
}
