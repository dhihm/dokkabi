import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { containsSecret } from "../host/redact.ts";
import { BlobStore } from "../host/blob-store.ts";
import { bindRecordedToolOutcome } from "./recorded-output.ts";
import {
  appendSandboxExecutionEvent,
  consumePreparedSandboxExecution,
  spawnPreparedSandbox,
  type SandboxPolicy,
  type SandboxExecutionResult,
} from "../host/sandbox.ts";

export type ExecMode = "live" | "replay";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolExecutionDiagnostics {
  raw_exit_code?: null;
  signal?: string;
  error?: string;
  timed_out?: true;
  max_buffer_exceeded?: true;
  completion_unavailable?: true;
  /** P1 (D58c): processes of the execution's tree the host could not end. */
  survivors?: number;
}

export interface ToolOutcome {
  /** The text the model sees: the surface tool_result. */
  text: string;
  error: boolean;
  exitCode?: number;
  execution?: ToolExecutionDiagnostics;
}

export type ToolRunner = (call: ToolCall) => SandboxExecutionResult;

/** args digest: 16 hex chars. Raw args never reach observe events. */
export function argDigest(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

/** result digest over the text the model saw. */
export function resultDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Replay draws recorded tool results from the log in order. One cursor per
 * replay drive; each call consumes the next matching record.
 */
export class ReplayToolCursor {
  private readonly results: EventRecord[] = [];
  private next = 0;

  constructor(events: readonly EventRecord[], private readonly log?: EventLog) {
    this.results = events.filter((event) => event.name === "tool/result" && event.kind === "surface");
  }

  take(call: ToolCall): ToolOutcome | undefined {
    while (this.next < this.results.length) {
      const event = this.results[this.next]!;
      this.next += 1;
      const tool = typeof event.payload.tool === "string" ? event.payload.tool : "";
      if (tool !== call.name) {
        continue;
      }
      const outcome: ToolOutcome = {
        text: typeof event.payload.text === "string" ? event.payload.text : "",
        error: event.payload.error === true,
        ...(typeof event.payload.exit_code === "number" ? { exitCode: event.payload.exit_code } : {}),
        ...(event.payload.execution === undefined ? {} : { execution: event.payload.execution as ToolExecutionDiagnostics }),
      };
      return this.log ? bindRecordedToolOutcome(outcome, this.log, event) : outcome;
    }
    return undefined;
  }
}

/** True when no event in this log claims a spawn happened (replay invariant). */
export function replayLogHasNoSpawns(events: readonly EventRecord[]): boolean {
  return !events.some((event) => event.name === "sandbox/exec" || event.name === "tool/start");
}

const INLINE_LIMIT = 4000;
/**
 * A long run's verdict is at the end.
 *
 * This kept the first four thousand bytes and dropped the rest. Historically,
 * case machinery read that preview for RED classification, threshold
 * comparison, and measured values. A case that printed progress before its
 * result therefore lost the result — pytest's summary, the `measured:` lines,
 * the assertion — and came back as "runner exited without assertion or
 * declared exception evidence", a broken-looking test that had merely been
 * verbose. One campaign shortened its own heartbeat output to work around
 * this without knowing why. Work cases now authenticate the separately
 * recorded complete body; the model preview remains unchanged.
 *
 * Both ends are kept now, weighted toward the tail, with the drop marked.
 */
const INLINE_HEAD_BYTES = 1_200;
const INLINE_TAIL_BYTES = INLINE_LIMIT - INLINE_HEAD_BYTES;

function safeText(raw: string): string {
  if (containsSecret(raw)) {
    return `[redacted tool output ${raw.length} bytes]`;
  }
  if (raw.length <= INLINE_LIMIT) return raw;
  const head = raw.slice(0, INLINE_HEAD_BYTES);
  const tail = raw.slice(-INLINE_TAIL_BYTES);
  return `${head}\n[dropped ${raw.length - head.length - tail.length} bytes of ${raw.length}; head and tail kept]\n${tail}`;
}

/**
 * THE single live/replay branch point (docs/replay.md): live records the
 * effect, runs inside the sandbox, then lands the surface result and the
 * digest-carrying observe end; replay returns the recorded result and never
 * spawns. A failed append in live cancels the execution (constitution 2).
 */
export function executeTool(input: {
  log: EventLog;
  policy: SandboxPolicy;
  mode: ExecMode;
  call: ToolCall;
  /** live: performs the fenced execution (defaults to the bwrap spawn). */
  run?: ToolRunner;
  /** replay: the recorded timeline to draw from. */
  cursor?: ReplayToolCursor;
  /** Host-selected process ceiling; the case contract retains its budget. */
  timeoutMs?: number;
}): ToolOutcome {
  if (input.mode === "replay") {
    const cursor = input.cursor;
    if (!cursor) {
      throw new Error("replay mode requires a ReplayToolCursor over the recorded log");
    }
    const recorded = cursor.take(input.call);
    if (!recorded) {
      throw new Error(`no recorded result for tool ${input.call.name}; replay cannot invent one`);
    }
    return recorded;
  }

  // live: effect before spawn — a rejected append cancels the execution.
  const prepared = appendSandboxExecutionEvent({
    log: input.log,
    policy: input.policy,
    evidence: {
      kind: "tool",
      tool: input.call.name,
      argsDigest: argDigest(input.call.args),
    },
  });

  const run: ToolRunner =
    input.run ??
    ((call) => {
      const command = commandOf(call);
      return spawnPreparedSandbox(prepared, command, input.timeoutMs);
    });
  if (input.run) consumePreparedSandboxExecution(prepared);
  const raw = run(input.call);
  const diagnostics: ToolExecutionDiagnostics = {
    ...(raw.rawExitCode === null ? { raw_exit_code: null } : {}),
    ...(raw.signal === undefined ? {} : { signal: raw.signal }),
    ...(raw.error === undefined ? {} : { error: raw.error }),
    ...(raw.timedOut ? { timed_out: true } : {}),
    ...(raw.maxBufferExceeded ? { max_buffer_exceeded: true } : {}),
    ...(raw.completionUnavailable ? { completion_unavailable: true } : {}),
    ...((raw.survivors ?? 0) > 0 ? { survivors: raw.survivors } : {}),
  };
  const execution = Object.keys(diagnostics).length > 0 ? { execution: diagnostics } : {};
  const error = raw.exitCode !== 0;
  const combined = `${raw.stdout}${raw.stderr}`.trim();
  const text = safeText(combined || "");

  // Big bodies go to the blob store: the event carries a digest, the JSONL
  // line stays small, and replay reads the blob instead of re-running.
  const withheld = containsSecret(combined);
  let blob: string | undefined;
  if (combined.length > INLINE_LIMIT && !withheld) {
    blob = BlobStore.forSession(input.log.path).put(combined);
  }

  const record = input.log.append({
    kind: "surface",
    name: "tool/result",
    payload: {
      tool: input.call.name,
      id: input.call.id,
      text,
      error,
      exit_code: raw.exitCode,
      ...execution,
      recorded_output: {
        version: 1,
        storage: withheld ? "withheld" : blob ? "blob" : "inline",
      },
      ...(blob ? { blob, blob_bytes: Buffer.byteLength(combined, "utf8") } : {}),
    },
  });
  input.log.append({
    kind: "observe",
    name: "tool/end",
    payload: {
      name: input.call.name,
      id: input.call.id,
      error,
      exit_code: raw.exitCode,
      ...execution,
      duration_ms: "missing",
      result_bytes: text.length,
      args_digest: argDigest(input.call.args),
      result_digest: resultDigest(text),
    },
  });
  return bindRecordedToolOutcome({ text, error, exitCode: raw.exitCode, ...execution }, input.log, record);
}

function commandOf(call: ToolCall): string {
  const args = call.args as { command?: unknown } | null;
  if (args && typeof args === "object" && typeof args.command === "string") {
    return args.command;
  }
  throw new Error(`tool ${call.name} needs a string command argument`);
}
