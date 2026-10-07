import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "./event-log.ts";
import { containsSecret, redactText } from "./redact.ts";

/**
 * Why a run ended when nothing else says.
 *
 * A long autonomous run died after thirteen minutes with an empty stdout log,
 * no crash report, and no terminal event: nothing anywhere recorded the
 * reason. The uncaught-exception and unhandled-rejection handlers existed only
 * on the dashboard command, whose own comment observes that a silent death is
 * undebuggable. That applies more sharply to a work run, which is the one that
 * runs unattended for hours.
 *
 * The reason goes next to the session rather than into a shared temp file, so
 * it belongs to the run that produced it, and into the EventLog as well so the
 * board and replay agree on how the run ended.
 */

export type TerminalFailureKind = "uncaught" | "rejection" | "signal" | "exit";

export function terminalFailurePath(dir: string): string {
  return join(dir, "terminal-failure.log");
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Record a terminal failure. Never throws: a crash handler that crashes leaves
 * the operator with less than nothing.
 */
export function recordTerminalFailure(input: {
  readonly scope: string;
  readonly kind: TerminalFailureKind;
  readonly reason: unknown;
  readonly dir: string;
  readonly log?: EventLog;
  readonly now?: () => string;
}): void {
  const stamp = (() => {
    try {
      return input.now ? input.now() : new Date().toISOString();
    } catch {
      return "unknown-time";
    }
  })();
  const detail = redactText(describe(input.reason));
  try {
    mkdirSync(input.dir, { recursive: true });
    appendFileSync(
      terminalFailurePath(input.dir),
      `${stamp} ${input.scope} ${input.kind} ${detail}\n`,
      "utf8",
    );
  } catch {
    // An unwritable directory is not a reason to lose the process twice.
  }
  try {
    // The stack may still hold a credential the redactor does not know; the
    // file keeps the detail, the durable log takes a placeholder.
    const safe = containsSecret(detail) ? "[redacted terminal failure detail]" : detail.slice(0, 2000);
    input.log?.append({
      kind: "observe",
      name: "session/crash",
      payload: { scope: input.scope, kind: input.kind, reason: safe },
    });
  } catch {
    // Same reason.
  }
}

/**
 * A process that simply stops throws nothing, so nothing above catches it.
 * Recorded only when the run never reached its own completion, since a normal
 * finish must stay quiet.
 */
export function recordUnexpectedExit(input: {
  readonly scope: string;
  readonly dir: string;
  readonly code: number | null;
  readonly completed: boolean;
  readonly log?: EventLog;
}): void {
  if (input.completed) return;
  recordTerminalFailure({
    scope: input.scope,
    kind: "exit",
    reason: `process exited before the run finished (code=${input.code ?? "unknown"})`,
    dir: input.dir,
    ...(input.log ? { log: input.log } : {}),
  });
}

/**
 * Install the handlers for a command that must not die silently. Returns a
 * disposer, and a way for the run to say it finished on purpose.
 */
export function installTerminalDiagnostics(input: {
  readonly scope: string;
  readonly dir: string;
  readonly log?: EventLog;
}): (() => void) & { markCompleted: () => void } {
  const onUncaught = (error: unknown): void => {
    recordTerminalFailure({ ...input, kind: "uncaught", reason: error });
    process.exitCode = 1;
  };
  const onRejection = (reason: unknown): void => {
    recordTerminalFailure({ ...input, kind: "rejection", reason });
    process.exitCode = 1;
  };
  // A signal kills the process without throwing, so nothing above sees it.
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (name: string) => (): void => {
    recordTerminalFailure({ ...input, kind: "signal", reason: name });
    process.exitCode = 1;
    process.exit(1);
  };
  const signalHandlers = signals.map((name) => [name, onSignal(name)] as const);
  let completed = false;
  // Neither a signal nor an exception: the process just stops. Without this the
  // quietest failure of all leaves no trace anywhere.
  const onExit = (code: number): void => {
    recordUnexpectedExit({ ...input, code, completed });
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  for (const [name, handler] of signalHandlers) process.on(name, handler);
  process.on("exit", onExit);
  const dispose = (): void => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    process.off("exit", onExit);
  };
  return Object.assign(dispose, {
    markCompleted: (): void => {
      completed = true;
    },
  });
}
