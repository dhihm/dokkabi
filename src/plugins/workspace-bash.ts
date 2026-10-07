import { EXEC_MARKER_ENV, endMarkedProcesses, registerLiveWriter } from "../host/live-writers.ts";
import { EXECUTION_CAPABILITY_ENV, endExecutionMembership, type ExecutionMembership } from "../host/execution-membership.ts";
import {
  createBashTool,
  NodeExecutionEnv,
  type AgentTool,
} from "@earendil-works/pi-agent-core/node";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { EventLog } from "../host/event-log.ts";
import {
  appendPolicyEvent,
  appendSandboxExecutionEvent,
  beginSandboxExecution,
  consumePreparedSandboxExecution,
  createReadOnlyPolicyFrom,
  endSandboxExecution,
  disposeSandboxPolicy,
  policyDigest,
  prepareSandboxExecution,
  writeWrapperScript,
  type SandboxPolicy,
} from "../host/sandbox.ts";
import {
  createDigestCache,
  mintReceipt,
  workspaceDigest,
  workspaceListing,
  type TreeListing,
  type DigestCache,
  type ExecutionReceiptViews,
} from "../host/execution-receipt.ts";
import { unknownCoverage } from "../host/coverage.ts";
import { sessionDigestCache } from "../work/session-base.ts";
import { recordSessionReceiptCommand } from "../work/judged-run.ts";

type WorkspaceBashInput = {
  readonly workspaceRoot: string;
  readonly policy: SandboxPolicy;
  readonly log?: EventLog;
  readonly onDerivedPolicyDisposed?: (policy: SandboxPolicy) => void;
  /** Fresh-image execution for `isolated: true` calls; resolved lazily so a
   * session without execution views simply falls back to the live workspace. */
  readonly views?: () => ExecutionReceiptViews | undefined;
  /** Whether to announce the receipt id as the first line of the tool result.
   * The receipt row is always minted; the line is shown only where a consumer
   * (`finish`, `propose_plan`) can cite it, so ordinary sessions keep their
   * exact v1 output. */
  readonly announceReceipt?: () => boolean;
  /** The name of this tool's wrapper script (default `sandbox-sh`). Every
   * live bash tool owns a wrapper of its own: two tools bound to one log
   * share its directory, and a second tool writing the same wrapper name
   * would silently put its policy under the first tool's commands. */
  readonly shellName?: string;
};

type BashParams = {
  readonly command: string;
  readonly timeout?: number;
  readonly background?: boolean;
  readonly isolated?: boolean;
};

/** Per-session receipt state (interfaces-v2.md §1): the digest cache makes
 * every image cheap — an unchanged file costs an lstat — so the image before
 * each call is always a fresh digest of the tree (I1, D57d): nothing a write
 * tool, a background process or an earlier call did between two calls can
 * leave a stale image standing, however it set a file's size and mtime. The
 * cache covers what the session's base decides (C1, D57e): taken when the
 * tool is made — the session's boot, before its first model request. */
type BashReceiptState = {
  readonly cache: DigestCache;
};

type BashObservation = {
  readonly observer: "bash_wait" | "bash_probe";
  readonly probeId?: string;
  readonly attempt?: number;
};

type BashResultState = "completed" | "timed_out" | "detached";

interface BashJob {
  readonly handle: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  readonly done: Promise<void>;
  finish(): boolean;
  output: string;
  outputBytes: number;
  exitCode?: number;
  status: "running" | "completed" | "timed_out" | "killed" | "failed";
  timeout?: ReturnType<typeof setTimeout>;
  /** G2 (D57g): the job's environment marker, and the end of its
   * registration as a live writer of the tree (absent under a read-only
   * policy, which cannot write W). */
  readonly marker: string;
  endWriter?: () => void;
}

export interface WorkspaceBashTools {
  tools: AgentTool[];
  dispose(): void;
}

class BashParamsError extends Error {}
class BashTimeoutCapError extends Error {}

const HOST_WRAPPER_ROOTS = new Map<string, string>();
const ACTIVE_BASH_RUNTIMES = new Set<BashJobRuntime>();
const BACKGROUND_OUTPUT_LIMIT = 64 * 1024;
const BACKGROUND_JOB_LIMIT = 32;
const OBSERVATION_OUTPUT_LIMIT = 16 * 1024;
const OBSERVATION_CAPTURE_LIMIT = 4 * 1024 * 1024;
const OBSERVATION_PROCESS_CAPTURE_LIMIT = 32 * 1024 * 1024;
const OBSERVATION_CONCURRENCY_LIMIT = 16;
let activeObservationCaptures = 0;
let observationCaptureBytes = 0;
const WAIT_INTERVAL_DEFAULT_MS = 5_000;
const WAIT_INTERVAL_MAX_MS = 60_000;
const WAIT_DEADLINE_MAX_MS = 24 * 60 * 60 * 1_000;
const PROBE_TIMEOUT_DEFAULT_SECONDS = 30;
const PROBE_TIMEOUT_MAX_SECONDS = 3_600;
export const LIVE_BASH_TIMEOUT_DEFAULT_SECONDS = 120;
export const LIVE_BASH_TIMEOUT_MAX_SECONDS = 600;
const PROBE_BATCH_LIMIT = 16;
const BASH_OBSERVATION = Symbol("dokkabi.bash-observation");
let wrapperSequence = 0;
/** The wrapper scripts live bash tools own, by path, with the digest of the
 * policy written there: a wrapper is never rebound under another policy
 * while its owner is live. */
const BOUND_WRAPPERS = new Map<string, string>();
process.once("exit", () => {
  for (const runtime of ACTIVE_BASH_RUNTIMES) runtime.dispose();
  ACTIVE_BASH_RUNTIMES.clear();
  for (const root of HOST_WRAPPER_ROOTS.values()) {
    rmSync(root, { recursive: true, force: true });
  }
  HOST_WRAPPER_ROOTS.clear();
});

export function createWorkspaceBashTool(input: WorkspaceBashInput): AgentTool {
  return createWorkspaceBashTools(input).tools[0]!;
}

export function createWorkspaceBashTools(input: WorkspaceBashInput): WorkspaceBashTools {
  const runtime = new BashJobRuntime(input.log);
  ACTIVE_BASH_RUNTIMES.add(runtime);
  const receiptState: BashReceiptState = {
    cache: input.log ? sessionDigestCache(input.log, input.workspaceRoot) : createDigestCache(unknownCoverage("no session log names a base")),
  };
  const shellName = input.shellName ?? "sandbox-sh";
  const wrappers: string[] = [];
  const primary = bindBash(input, input.policy, shellName, runtime, receiptState, wrappers);
  // Its live receipts record their listings (the plan hooks read them, D57g).
  if (input.log) Object.defineProperty(primary, RECORDS_RECEIPT_LISTINGS, { value: true, enumerable: true });
  let bash: AgentTool = primary;
  let ownedDerivedPolicy: SandboxPolicy | undefined;
  if (input.policy.mode === "read-only") {
    bash = primary;
  } else {
    const decomposePolicy = createReadOnlyPolicyFrom(input.policy);
    ownedDerivedPolicy = decomposePolicy;
    let decompose: AgentTool;
    try {
      decompose = bindBash(input, decomposePolicy, input.shellName === undefined ? "sandbox-decompose-sh" : `${shellName}-decompose`, runtime, receiptState, wrappers);
    } catch (error) {
      for (const path of wrappers) BOUND_WRAPPERS.delete(path);
      disposeSandboxPolicy(decomposePolicy);
      input.onDerivedPolicyDisposed?.(decomposePolicy);
      throw error;
    }
    let activeMode: SandboxPolicy["mode"] = input.policy.mode;
    bash = {
      ...primary,
      description: `${primary.description} During decompose, commands run in a read-only workspace; use write/edit for tests/ and work/.`,
      execute: (toolCallId, params, signal, onUpdate) => {
        const selected =
          process.env.DOKKABI_WORK_PHASE === "decompose"
            ? { tool: decompose, policy: decomposePolicy }
            : { tool: primary, policy: input.policy };
        if (selected.policy.mode !== activeMode) {
          if (input.log) {
            appendPolicyEvent(input.log, selected.policy);
          }
          activeMode = selected.policy.mode;
        }
        return selected.tool.execute(toolCallId, params, signal, onUpdate);
      },
    };
  }
  let disposed = false;
  return {
    tools: [
      bash,
      createBashPollTool(runtime),
      createBashKillTool(runtime),
      createBashWaitTool(bash),
      createBashProbeTool(bash),
    ],
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
      ACTIVE_BASH_RUNTIMES.delete(runtime);
      for (const path of wrappers) BOUND_WRAPPERS.delete(path);
      if (ownedDerivedPolicy) {
        disposeSandboxPolicy(ownedDerivedPolicy);
        input.onDerivedPolicyDisposed?.(ownedDerivedPolicy);
        ownedDerivedPolicy = undefined;
      }
    },
  };
}

function bindBash(
  input: WorkspaceBashInput,
  policy: SandboxPolicy,
  shellName: string,
  runtime: BashJobRuntime,
  receiptState: BashReceiptState,
  wrappers: string[],
): AgentTool {
  let shellPath = secureWrapperPath(input.workspaceRoot, input.log?.path, shellName);
  const digest = policyDigest(policy);
  const owner = BOUND_WRAPPERS.get(shellPath);
  if (owner !== undefined && owner !== digest) {
    // A tool that named its wrapper collides by its caller's choice: refused.
    if (input.shellName !== undefined) {
      throw new Error(`a live bash tool already owns the wrapper ${shellName} under another policy; give this tool a shellName of its own`);
    }
    // A tool that took the default name beside a log another live tool of the
    // same log already owns (a second boot of the session in this process:
    // each boot's policy is its own) gets a wrapper of its own in a
    // host-owned directory, as a tool without a log does — never the first
    // tool's, which stays under the first tool's policy.
    shellPath = hostOwnedWrapperPath(input.workspaceRoot, shellName);
  }
  writeWrapperScript(policy, shellPath);
  BOUND_WRAPPERS.set(shellPath, digest);
  wrappers.push(shellPath);
  const outerEnv = policy.backend === "docker"
    ? policy.dockerHostEnv
    : policy.childEnv;
  if (!outerEnv) {
    throw new Error("Docker workspace bash requires a sealed host connection environment");
  }
  const env = new NodeExecutionEnv({
    cwd: input.workspaceRoot,
    shellPath,
    shellEnv: {
      ...(policy.backend === "docker" ? outerEnv : {}),
      DOKKABI_SANDBOX_WORKSPACE: policy.workspaceRoot,
      DOKKABI_SANDBOX_MODE: policy.mode,
      ...(policy.mode === "read-only"
        ? {
            HYPOTHESIS_STORAGE_DIRECTORY: "/tmp/hypothesis",
            PYTHONDONTWRITEBYTECODE: "1",
          }
        : {}),
    },
  });
  let callMarker = randomUUID();
  let callMembership: ExecutionMembership | undefined;
  const raw = createBashTool({
    prepare: (execution) => {
      execution.cwd = input.workspaceRoot;
      execution.inheritEnv = false;
      // G2 (D57g): every process of this call carries its marker; G2'
      // (D57h): the wrapper gives the call's profile its capability.
      execution.env = {
        ...outerEnv,
        [EXEC_MARKER_ENV]: callMarker,
        ...(callMembership === undefined ? {} : { [EXECUTION_CAPABILITY_ENV]: callMembership.capability }),
      };
    },
  });
  return {
    name: raw.name,
    label: raw.label,
    description: `${raw.description} Set background=true to return an opaque handle immediately, then use bash_poll or bash_kill. For several independent read-only diagnostics, prefer one bash_probe call over sequential single commands; to wait for a condition, prefer bash_wait over repeated checks.`,
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds; omitted commands still use the session default",
      })),
      background: Type.Optional(Type.Boolean({ description: "Return a detached handle immediately" })),
      isolated: Type.Optional(Type.Boolean({
        description: "Run in a fresh, isolated image of the workspace instead of the live workspace, where the sandbox backend supports execution images",
      })),
    }, { additionalProperties: false }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const parsed = parseBashParams(params);
      const observation = readBashObservation(params);
      const timeout = parsed.timeout ?? LIVE_BASH_TIMEOUT_DEFAULT_SECONDS;
      if (parsed.background && policy.backend !== "bwrap" && policy.backend !== "seatbelt" && policy.backend !== "none") {
        throw new BashParamsError("background bash requires a host process-group backend");
      }
      const handle = parsed.background ? runtime.nextHandle() : undefined;
      const evidence = {
        kind: "workspace-bash",
        background: parsed.background === true,
        ...(handle ? { handle } : {}),
        ...(observation
          ? {
              observer: observation.observer,
              ...(observation.probeId ? { probeId: observation.probeId } : {}),
              ...(observation.attempt === undefined ? {} : { attempt: observation.attempt }),
            }
          : {}),
      } as const;
      const prepared = input.log
        ? appendSandboxExecutionEvent({ log: input.log, policy, evidence })
        : prepareSandboxExecution(policy);
      consumePreparedSandboxExecution(prepared);
      if (observation) {
        return executeObservationCommand({
          command: parsed.command,
          timeout,
          cwd: input.workspaceRoot,
          shellPath,
          env: outerEnv,
          signal,
          policy,
        });
      }
      if (parsed.background) {
        if (signal?.aborted) {
          return bashStateResult("completed", "bash state=completed cancelled=true", {
            cancelled: true,
          });
        }
        return runtime.start({
          handle: handle!,
          command: parsed.command,
          timeout,
          cwd: input.workspaceRoot,
          shellPath,
          env: outerEnv,
          // G2 (D57g): a job under a policy that can write the tree is a
          // live writer until it ends; a read-only one never blocks.
          writes: policy.mode !== "read-only" ? policy.workspaceRoot : undefined,
          seatbelt: policy.backend === "seatbelt",
          // G2' (D57h): the job's own capability; its members end with it.
          membership: beginSandboxExecution(policy),
        });
      }
      // Isolated opt-in (interfaces-v2.md §1): a fresh execution image where
      // the backend supports one; otherwise fall back to the live workspace
      // and say so in the result text.
      let isolatedNote: string | undefined;
      if (parsed.isolated && input.log) {
        const isolated = runIsolated({
          views: input.views?.(),
          log: input.log,
          command: parsed.command,
          timeoutMs: timeout * 1000,
        });
        if (isolated.status === "ran") return isolated.result;
        isolatedNote = `\nisolated execution unavailable (${isolated.reason}); ran in the live workspace`;
      }
      // The sandbox/exec effect row appended above binds this dispatch; the
      // receipt's result row references it (same lookup the old verify used).
      const execRow = input.log
        ? input.log.events.filter((row) => row.name === "sandbox/exec" && row.payload.digest === prepared.digest).at(-1)
        : undefined;
      const receipts = input.log && execRow
        ? beginLiveReceipt({
            log: input.log,
            workspaceRoot: input.workspaceRoot,
            state: receiptState,
            execRef: { seq: execRow.seq, hash: execRow.hash },
          })
        : undefined;
      // R1' (#223): pi's bash keeps the UNREDACTED full output of a
      // truncated run in a temp file and names it in the text. The path is
      // learned structurally (the progress details), the file is deleted,
      // and the reference is removed before anything stores or shows it.
      let fullOutputPath: string | undefined;
      let cleanupUnverified = false;
      const trackedUpdate: typeof onUpdate = (update) => {
        const path = (update?.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
        if (typeof path === "string" && path.length > 0) fullOutputPath = path;
        onUpdate?.(update);
      };
      try {
        const marker = randomUUID();
        const result = await (async () => {
          // G2' (D57h): this call's capability (Seatbelt); undefined where
          // the kernel check is unavailable or the backend has a namespace.
          const membership = beginSandboxExecution(policy);
          try {
            callMarker = marker;
            callMembership = membership;
            return await raw.execute(
              toolCallId,
              { command: parsed.command, timeout },
              signal,
              trackedUpdate,
              { env },
            );
          } finally {
            if (callMembership === membership) callMembership = undefined;
            // G2 (D57g), G2' (D57h): the call is over only when nothing of
            // it can still write — on Seatbelt every process its profile
            // confines, whatever it did to its session, environment, parent
            // or argv, is ended (and one that remains keeps the tree's
            // images unknown) before the after-image is taken. Where the
            // kernel check is unavailable, the marker scan stands in.
            if (membership !== undefined) {
              try {
                if (endSandboxExecution(policy, membership) > 0) {
                  throw new Error("execution cleanup remains unverified");
                }
              } catch (error) {
                cleanupUnverified = true;
                throw error;
              }
            } else if (policy.backend === "seatbelt") endMarkedProcesses(marker);
          }
        })();
        const reported = (result.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
        if (typeof reported === "string" && reported.length > 0) fullOutputPath = reported;
        if (fullOutputPath) {
          const path = fullOutputPath;
          discardFullOutput(path);
          result.content = result.content.map((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
            ? { ...part, text: withoutFullOutputPath(part.text, path) }
            : part);
          if (result.details && typeof result.details === "object") delete (result.details as { fullOutputPath?: unknown }).fullOutputPath;
        }
        const output = resultText(result.content);
        let receiptId: string | undefined;
        if (receipts) receiptId = finishLiveReceipt(receipts, { command: parsed.command, exitCode: 0, stdout: output, stderr: "" });
        const details = result.details && typeof result.details === "object"
          ? result.details as Record<string, unknown>
          : {};
        // #223: the whole output goes on to the host's delivery step, which
        // redacts it, stores the safe bytes as a recorded source and bounds
        // what the model sees. A tool-side clamp here would discard the
        // middle before anything could keep it.
        const clampedContent = result.content;
        return {
          ...result,
          content: withReceiptLine(clampedContent, input.announceReceipt?.() ? receiptId : undefined, isolatedNote),
          details: {
            ...details,
            ...(receiptId ? { receipt: receiptId } : {}),
            state: "completed" satisfies BashResultState,
          },
        };
      } catch (error) {
        // Refusal is still an execution outcome. Retain the unknown after-image
        // from the live-writer registry instead of losing the result/receipt.
        if (cleanupUnverified && receipts) {
          finishLiveReceipt(receipts, {
            command: parsed.command,
            exitCode: 125,
            stdout: "",
            stderr: "execution cleanup remains unverified",
          });
        }
        if (fullOutputPath) {
          discardFullOutput(fullOutputPath);
          if (error instanceof Error) error.message = withoutFullOutputPath(error.message, fullOutputPath);
        }
        if (!isBashTimeout(error)) {
          // A non-zero exit still mints its receipt (RED-case evidence needs
          // exit codes != 0 on record); the thrown error keeps its exact v1
          // message. pi's bash tool exposes no structured output on failure —
          // it throws `Error(output + "Command exited with code N")` — so the
          // receipt binds the output text exactly as the tool result records
          // it, which is also what the model sees.
          if (receipts && error instanceof Error) {
            const exit = error.message.match(/Command exited with code\s+(\d+)/i);
            if (exit?.[1]) {
              finishLiveReceipt(receipts, {
                command: parsed.command,
                exitCode: Number(exit[1]),
                stdout: error.message.replace(/\n*Command exited with code\s+\d+\s*$/i, ""),
                stderr: "",
              });
            }
          }
          throw error;
        }
        // A timed-out command may have mutated the tree unobserved: the next
        // call digests the tree afresh, as every call does.
        return bashStateResult(
          "timed_out",
          `bash state=timed_out cancelled=true timeout_seconds=${timeout}`,
          { cancelled: true },
        );
      }
    },
  };
}

// --- execution receipts (interfaces-v2.md §1) --------------------------------

interface LiveReceiptContext {
  log: EventLog;
  workspaceRoot: string;
  state: BashReceiptState;
  execRef: { seq: number; hash: string };
  imageBefore: string;
  unknownBefore: readonly string[];
  listingBefore: TreeListing;
  startedAt: number;
}

/** The image the command is about to run on: a fresh digest of the tree
 * (I1, D57d) — the host's own record of each file's inode state, change time
 * included, is what makes it cheap, never a scan of forgeable size and mtime. */
function beginLiveReceipt(input: {
  log: EventLog;
  workspaceRoot: string;
  state: BashReceiptState;
  execRef: { seq: number; hash: string };
}): LiveReceiptContext {
  // The listing (not only the image): the plan hooks read the tracked
  // paths' states off it — one walk per image, no second walk (D57g).
  const listingBefore = workspaceListing(input.workspaceRoot, input.state.cache);
  const imageBefore = listingBefore.image;
  const unknownBefore = input.state.cache.lastUnknown;
  return { log: input.log, workspaceRoot: input.workspaceRoot, state: input.state, execRef: input.execRef, imageBefore, unknownBefore, listingBefore, startedAt: Date.now() };
}

/** The listings of the last live receipt a session's bash minted: what its
 * two images were made of (the plan hooks' tracked signature reads them),
 * bound to that receipt's id. */
const LAST_RECEIPT_LISTINGS = new WeakMap<EventLog, { readonly receipt: string; readonly before: TreeListing; readonly after: TreeListing }>();

/** Marks a bash tool whose live receipts record their listings here; a
 * wrapper that spreads the tool keeps the mark. */
export const RECORDS_RECEIPT_LISTINGS: unique symbol = Symbol("dokkabi.recordsReceiptListings");

/** Whether `tool` records its live receipts' listings (lastReceiptListings). */
export function recordsReceiptListings(tool: object): boolean {
  return (tool as { [RECORDS_RECEIPT_LISTINGS]?: unknown })[RECORDS_RECEIPT_LISTINGS] === true;
}

/** The before and after listings of the live bash receipt `receipt` (its
 * id), when it is the session's last one; undefined otherwise. */
export function lastReceiptListings(log: EventLog, receipt: string): { readonly before: TreeListing; readonly after: TreeListing } | undefined {
  const last = LAST_RECEIPT_LISTINGS.get(log);
  return last !== undefined && last.receipt === receipt ? last : undefined;
}

/** Digest the tree after the process ended and mint the live-workspace
 * receipt. */
function finishLiveReceipt(
  context: LiveReceiptContext,
  outcome: { command: string; exitCode: number; stdout: string; stderr: string },
): string {
  const listingAfter = workspaceListing(context.workspaceRoot, context.state.cache);
  const imageAfter = listingAfter.image;
  const { id } = mintReceipt({
    log: context.log,
    image_before: context.imageBefore,
    image_after: imageAfter,
    command: outcome.command,
    exit_code: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    duration_ms: Date.now() - context.startedAt,
    isolation: "live-workspace",
    digest_kind: "workspace-tree",
    exec_ref: context.execRef,
    unknown: { before: context.unknownBefore, after: context.state.cache.lastUnknown },
  });
  LAST_RECEIPT_LISTINGS.set(context.log, { receipt: id, before: context.listingBefore, after: listingAfter });
  // V7 (D57i): the host may judge this exact command again at finish.
  recordSessionReceiptCommand(context.log, id, outcome.command);
  return id;
}

/** Fresh-image execution for `isolated: true`, exactly as the removed
 * `verify` tool ran it; falls back to the live workspace with a reason. */
function runIsolated(input: {
  views: ExecutionReceiptViews | undefined;
  log: EventLog;
  command: string;
  timeoutMs: number;
}): { status: "ran"; result: ReturnType<typeof bashStateResult> } | { status: "fallback"; reason: string } {
  if (!input.views) return { status: "fallback", reason: "execution_views_capability_missing" };
  const startedAt = Date.now();
  const captured = input.views.capture();
  if (captured.status !== "retained") return { status: "fallback", reason: captured.reason };
  const run = input.views.execute({ image: captured.digest, command: input.command, timeoutMs: input.timeoutMs });
  if (run.status !== "executed") return { status: "fallback", reason: run.reason };
  const { id } = mintReceipt({
    log: input.log,
    image_before: captured.digest,
    image_after: captured.digest,
    command: input.command,
    exit_code: run.process.exitCode,
    stdout: run.process.stdout,
    stderr: run.process.stderr,
    duration_ms: Date.now() - startedAt,
    isolation: "fresh-image",
    digest_kind: "execution-image",
    exec_ref: run.result,
  });
  recordSessionReceiptCommand(input.log, id, input.command);
  const output = `${run.process.stdout}${run.process.stderr}`;
  return {
    status: "ran",
    // Bounded by the host's delivery step, which keeps the whole output as a
    // recorded source (#223).
    result: bashStateResult("completed", `receipt ${id}\nexit ${run.process.exitCode} in ${Date.now() - startedAt} ms\n${output.trim()}`),
  };
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
    ? String((part as { text?: unknown }).text ?? "")
    : "").join("");
}

/** pi's truncation note names the temp file holding the unredacted output. */
function withoutFullOutputPath(text: string, path: string): string {
  return text.split(`Full output: ${path}`).join("the full output was not kept");
}

function discardFullOutput(path: string): void {
  // Only pi's own capture file (`bash-*.log`, a regular file) is deleted.
  if (!/^bash-.*\.log$/.test(basename(path))) return;
  try {
    if (lstatSync(path).isFile()) rmSync(path, { force: true });
  } catch { /* already gone; the reference is removed either way */ }
}

function withReceiptLine<T extends { type: string; text?: unknown }>(
  content: T[],
  receiptId: string | undefined,
  note: string | undefined,
): T[] {
  if (receiptId === undefined && note === undefined) return content;
  return content.map((part, index) => {
    if (index > 0 || part.type !== "text") return part;
    const prefix = receiptId === undefined ? "" : `receipt ${receiptId}\n`;
    return { ...part, text: `${prefix}${String(part.text ?? "")}${note ?? ""}` } as T;
  });
}

class BashJobRuntime {
  private readonly jobs = new Map<string, BashJob>();

  constructor(private readonly log?: EventLog) {}

  nextHandle(): string {
    return `bash-${randomUUID()}`;
  }

  async start(input: {
    handle: string;
    command: string;
    timeout?: number;
    cwd: string;
    shellPath: string;
    env: Readonly<Record<string, string>>;
    writes?: string;
    seatbelt?: boolean;
    membership?: ExecutionMembership;
  }) {
    this.evictCompleted();
    if (this.jobs.size >= BACKGROUND_JOB_LIMIT) {
      this.observe("bash/job_failed", { handle: input.handle, reason: "job_limit" });
      return bashStateResult("completed", "bash state=completed error=job_limit", { error: "job_limit" });
    }
    let child: ChildProcess;
    const marker = randomUUID();
    try {
      child = spawn(input.shellPath, ["-c", input.command], {
        cwd: input.cwd,
        env: {
          ...input.env,
          [EXEC_MARKER_ENV]: marker,
          ...(input.membership === undefined ? {} : { [EXECUTION_CAPABILITY_ENV]: input.membership.capability }),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      this.observe("bash/job_failed", { handle: input.handle, reason: "spawn_failed" });
      return bashStateResult("completed", "bash state=completed error=spawn_failed", { error: "spawn_failed" });
    }
    let resolveDone = () => {};
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    let settled = false;
    const job: BashJob = {
      handle: input.handle,
      child,
      startedAt: Date.now(),
      done,
      finish() {
        if (settled) return false;
        settled = true;
        resolveDone();
        return true;
      },
      output: "",
      outputBytes: 0,
      status: "running",
      marker,
      ...(input.writes === undefined ? {} : { endWriter: registerLiveWriter(input.writes, input.handle, `background job ${input.handle} can still write the tree`) }),
    };
    const seatbelt = input.seatbelt === true;
    const membership = input.membership;
    const endJob = job.finish.bind(job);
    job.finish = () => {
      const first = endJob();
      if (first) {
        // Whatever of it outlived the job ends with it (G2): every process
        // its profile confines (G2', D57h); one that remains stays a live
        // writer until it is gone. The marker scan where the kernel check
        // is unavailable.
        try {
          if (membership !== undefined && endExecutionMembership(membership, input.writes).remaining.length > 0) {
            job.status = "failed"; job.exitCode = 1;
          } else if (membership === undefined && seatbelt) {
            endMarkedProcesses(marker); job.status = "failed"; job.exitCode = 1;
          }
        } catch { job.status = "failed"; job.exitCode = 1; }
        job.endWriter?.();
      }
      return first;
    };
    this.jobs.set(job.handle, job);
    let spawned = false;
    let resolveSpawn = (_ready: boolean) => {};
    const spawnReady = new Promise<boolean>((resolvePromise) => {
      resolveSpawn = resolvePromise;
    });
    const append = (chunk: unknown) => appendJobOutput(job, chunk);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () => {
      if (job.status === "running") job.status = "failed";
      if (!spawned) {
        job.finish();
        resolveSpawn(false);
        return;
      }
      this.finishJob(job);
    });
    child.once("spawn", () => {
      spawned = true;
      resolveSpawn(true);
    });
    child.once("close", (code) => {
      job.exitCode = typeof code === "number" ? code : undefined;
      if (job.status === "running") job.status = "completed";
      this.finishJob(job);
    });
    if (input.timeout !== undefined) {
      job.timeout = setTimeout(() => {
        if (job.status !== "running") return;
        job.status = "timed_out";
        killChildProcess(job.child);
      }, input.timeout * 1000);
    }
    const ready = await spawnReady;
    if (!ready) {
      if (job.timeout) clearTimeout(job.timeout);
      this.jobs.delete(job.handle);
      this.observe("bash/job_failed", { handle: input.handle, reason: "spawn_failed" });
      return bashStateResult("completed", "bash state=completed error=spawn_failed", {
        error: "spawn_failed",
      });
    }
    try {
      this.observe("bash/job_started", {
        handle: job.handle,
        state: publicJobState(job),
        ready: true,
      });
    } catch (error) {
      job.status = "killed";
      killChildProcess(job.child);
      job.finish();
      this.jobs.delete(job.handle);
      throw error;
    }
    return job.status === "running"
      ? bashStateResult("detached", `bash state=detached handle=${job.handle}`, {
          handle: job.handle,
        })
      : bashJobResult(job, publicJobState(job));
  }

  poll(handle: string) {
    const job = this.jobs.get(handle);
    if (!job) {
      return bashStateResult("completed", "bash state=completed error=unknown_handle", {
        handle,
        error: "unknown_handle",
      });
    }
    const state = publicJobState(job);
    this.observe("bash/job_polled", { handle, state });
    return bashJobResult(job, state);
  }

  async kill(handle: string) {
    this.effect("bash/job_kill", { handle });
    const job = this.jobs.get(handle);
    if (!job) {
      return bashStateResult("completed", "bash state=completed error=unknown_handle", {
        handle,
        error: "unknown_handle",
      });
    }
    if (job.status === "running") {
      job.status = "killed";
      killChildProcess(job.child);
      await Promise.race([job.done, Bun.sleep(1_000)]);
    }
    return bashJobResult(job, publicJobState(job));
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.timeout) clearTimeout(job.timeout);
      if (job.status === "running") {
        try {
          this.effect("bash/job_kill", { handle: job.handle, reason: "dispose" });
        } catch {
          // Cleanup cannot leave a child alive merely because its log closed.
        }
        job.status = "killed";
        killChildProcess(job.child);
      }
      job.finish();
    }
    this.jobs.clear();
  }

  private finishJob(job: BashJob): void {
    if (!job.finish()) return;
    if (job.timeout) {
      clearTimeout(job.timeout);
      job.timeout = undefined;
    }
    this.observeAsync("bash/job_completed", {
      handle: job.handle,
      state: publicJobState(job),
      exit_code: job.exitCode ?? "missing",
      duration_ms: Math.max(0, Date.now() - job.startedAt),
      output_bytes: job.outputBytes,
    });
  }

  private evictCompleted(): void {
    if (this.jobs.size < BACKGROUND_JOB_LIMIT) return;
    for (const [handle, job] of this.jobs) {
      if (job.status !== "running") {
        this.jobs.delete(handle);
        if (this.jobs.size < BACKGROUND_JOB_LIMIT) return;
      }
    }
  }

  private effect(name: string, payload: Record<string, unknown>): void {
    this.log?.append({ kind: "effect", name, payload });
  }

  private observe(name: string, payload: Record<string, unknown>): void {
    this.log?.append({ kind: "observe", name, payload });
  }

  private observeAsync(name: string, payload: Record<string, unknown>): void {
    try {
      this.log?.append({ kind: "observe", name, payload });
    } catch {
      // Completion callbacks must still reap the child when the session log
      // has already closed or failed its own append boundary.
    }
  }
}

function createBashPollTool(runtime: BashJobRuntime): AgentTool {
  return {
    name: "bash_poll",
    label: "bash poll",
    description: "Poll an opaque background bash handle and return its bounded output and lifecycle state.",
    parameters: Type.Object({ handle: Type.String() }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      return runtime.poll((params as { handle: string }).handle);
    },
  };
}

function createBashKillTool(runtime: BashJobRuntime): AgentTool {
  return {
    name: "bash_kill",
    label: "bash kill",
    description: "Cancel a background bash job owned by this session.",
    parameters: Type.Object({ handle: Type.String() }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      return runtime.kill((params as { handle: string }).handle);
    },
  };
}

function createBashWaitTool(bash: AgentTool): AgentTool {
  return {
    name: "bash_wait",
    label: "bash wait",
    description: "Run a sandboxed probe until its stdout matches a regular expression or a monotonic deadline expires. Polling does not request the model again, and a deadline stops observation only.",
    parameters: Type.Object({
      probe: Type.String({ description: "Sandboxed command whose stdout is tested" }),
      until: Type.String({ minLength: 1, maxLength: 512, description: "JavaScript regular expression matched against probe stdout" }),
      interval_ms: Type.Optional(Type.Number({ minimum: 10, maximum: WAIT_INTERVAL_MAX_MS, description: "Milliseconds between probes; defaults to 5000" })),
      deadline_ms: Type.Number({ minimum: 1, maximum: WAIT_DEADLINE_MAX_MS, description: "Total monotonic deadline in milliseconds" }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal) {
      const parsed = parseWaitParams(params);
      const matcher = compileWaitPattern(parsed.until);
      const startedAt = performance.now();
      const deadlineAt = startedAt + parsed.deadlineMs;
      let attempt = 0;
      let last: ObservedCommandOutcome | undefined;
      while (true) {
        if (signal?.aborted) {
          return waitResult(false, "cancelled", elapsedSince(startedAt), attempt, last);
        }
        const remainingMs = deadlineAt - performance.now();
        if (remainingMs <= 0) {
          return waitResult(false, "deadline", elapsedSince(startedAt), attempt, last);
        }
        attempt += 1;
        const observed = await executeObservedBash({
          bash,
          toolCallId: `${toolCallId}:wait:${attempt}`,
          command: parsed.probe,
          timeout: Math.max(0.001, remainingMs / 1_000),
          signal,
          observation: { observer: "bash_wait", attempt },
        });
        if (matcher.test(observed.stdout)) {
          return waitResult(true, undefined, elapsedSince(startedAt), attempt, observed);
        }
        // A final probe can consume the remaining deadline while the sandbox
        // starts. Its typed timeout string is not probe stdout; retain the
        // latest completed observation instead.
        if (observed.state === "completed" || last === undefined) {
          last = observed;
        }
        if (signal?.aborted) {
          return waitResult(false, "cancelled", elapsedSince(startedAt), attempt, last);
        }
        const afterProbeMs = deadlineAt - performance.now();
        if (afterProbeMs <= 0) {
          return waitResult(false, "deadline", elapsedSince(startedAt), attempt, last);
        }
        const slept = await waitForInterval(Math.min(parsed.intervalMs, afterProbeMs), signal);
        if (!slept) {
          return waitResult(false, "cancelled", elapsedSince(startedAt), attempt, last);
        }
      }
    },
  };
}

export function createBashProbeTool(bash: AgentTool): AgentTool {
  const alternatives = Type.Union([
    Type.Object({
      probes: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$", description: "Stable result id" }),
        command: Type.String({ description: "Sandboxed command" }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: PROBE_BATCH_LIMIT }),
      parallel: Type.Optional(Type.Boolean({ description: "Run commands concurrently; defaults to true" })),
      timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: PROBE_TIMEOUT_MAX_SECONDS })),
    }, { additionalProperties: false }),
    Type.Object({
      command: Type.String({ minLength: 1, description: "One sandboxed probe; result id is command" }),
      timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: PROBE_TIMEOUT_MAX_SECONDS })),
    }, { additionalProperties: false }),
  ]);

  return {
    name: "bash_probe",
    label: "bash probe",
    description: "Run up to 16 independent sandboxed commands in one tool call and return stable id-keyed stdout, exit code, state, and duration. Commands run in parallel by default. For one probe, command is an accepted shorthand. Keep file reads bounded; recover omitted output with probe_log rather than rerunning broad searches.",
    parameters: Type.Object({
      probes: Type.Optional(alternatives.anyOf[0].properties.probes),
      parallel: Type.Optional(alternatives.anyOf[0].properties.parallel),
      timeout: Type.Optional(alternatives.anyOf[0].properties.timeout),
      command: Type.Optional(alternatives.anyOf[1].properties.command),
    }, { additionalProperties: false, anyOf: alternatives.anyOf }),
    async execute(toolCallId, params, signal) {
      const parsed = parseProbeParams(params);
      const run = (probe: { id: string; command: string }) => executeObservedBash({
        bash,
        toolCallId: `${toolCallId}:probe:${probe.id}`,
        command: probe.command,
        timeout: parsed.timeout,
        signal,
        observation: { observer: "bash_probe", probeId: probe.id },
      });
      let entries: Array<[string, ObservedCommandOutcome]>;
      if (parsed.parallel) {
        entries = await Promise.all(parsed.probes.map(async (probe) => [probe.id, await run(probe)] as const));
      } else {
        entries = [];
        for (const probe of parsed.probes) {
          entries.push([probe.id, await run(probe)]);
        }
      }
      const results = Object.fromEntries(entries);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        details: { results, ...(entries.some(([, result]) => result.producer_truncated) ? { producer_truncated: true } : {}) },
      };
    },
  };
}

interface ObservedCommandOutcome {
  producer_truncated?: true;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  ms: number;
  state: "completed" | "timed_out" | "cancelled";
  error?: true;
}

async function executeObservedBash(input: {
  bash: AgentTool;
  toolCallId: string;
  command: string;
  timeout: number;
  signal?: AbortSignal;
  observation: BashObservation;
}): Promise<ObservedCommandOutcome> {
  const startedAt = performance.now();
  try {
    const result = await input.bash.execute(
      input.toolCallId,
      observedBashParams(input.command, input.timeout, input.observation),
      input.signal,
    );
    const details = result.details && typeof result.details === "object"
      ? result.details as Record<string, unknown>
      : {};
    const state = details.state === "timed_out"
      ? "timed_out" as const
      : details.state === "cancelled"
        ? "cancelled" as const
        : "completed" as const;
    const exitCode = typeof details.exit_code === "number" ? details.exit_code : null;
    return {
      stdout: typeof details.stdout === "string" ? details.stdout : toolResultText(result),
      stderr: typeof details.stderr === "string" ? details.stderr : "",
      ...(details.producer_truncated === true ? { producer_truncated: true as const } : {}),
      exit_code: exitCode,
      ms: elapsedSince(startedAt),
      state,
      ...(state !== "completed" || exitCode !== 0 ? { error: true as const } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exit = message.match(/Command exited with code\s+(\d+)/i);
    const stdout = message.replace(/\n*Command exited with code\s+\d+\s*$/i, "");
    return {
      stdout: boundedObservationText(stdout),
      stderr: "",
      exit_code: exit?.[1] ? Number(exit[1]) : 1,
      ms: elapsedSince(startedAt),
      state: "completed",
      error: true,
    };
  }
}

function executeObservationCommand(input: {
  command: string;
  timeout?: number;
  cwd: string;
  shellPath: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  policy: SandboxPolicy;
}) {
  if (input.signal?.aborted) {
    return Promise.resolve(observationCommandResult({
      state: "cancelled",
      stdout: "",
      stderr: "",
      exitCode: null,
    }));
  }
  if (activeObservationCaptures >= OBSERVATION_CONCURRENCY_LIMIT) {
    return Promise.resolve(observationCommandResult({ state: "cancelled", stdout: "Observation concurrency limit exceeded.", stderr: "", exitCode: null, producerTruncated: true }));
  }
  let child: ChildProcess;
  // G2' (D57h): an observation's processes end with it too.
  const membership = beginSandboxExecution(input.policy);
  activeObservationCaptures++;
  try {
    child = spawn(input.shellPath, ["-c", input.command], {
      cwd: input.cwd,
      env: { ...input.env, ...(membership === undefined ? {} : { [EXECUTION_CAPABILITY_ENV]: membership.capability }) },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    activeObservationCaptures--;
    endSandboxExecution(input.policy, membership);
    return Promise.resolve(observationCommandResult({
      state: "completed",
      stdout: "",
      stderr: "spawn failed",
      exitCode: null,
    }));
  }
  return new Promise<ReturnType<typeof observationCommandResult>>((resolvePromise) => {
    // Keep the entire capture outside the workspace. The host delivery path
    // redacts and stores it, then projects the model view; previews never bound
    // the producer capture. Private files are removed on every completion path.
    let captureRoot: string | undefined;
    let stdoutPath = "", stderrPath = "";
    let stdoutFd: number | undefined, stderrFd: number | undefined;
    try {
      captureRoot = mkdtempSync(join(tmpdir(), "dokkabi-probe-capture-"));
      stdoutPath = join(captureRoot, "stdout"); stderrPath = join(captureRoot, "stderr");
      stdoutFd = openSync(stdoutPath, "wx", 0o600);
      stderrFd = openSync(stderrPath, "wx", 0o600);
    } catch {
      try { if (stdoutFd !== undefined) closeSync(stdoutFd); } catch { /* Preserve the capture failure result. */ }
      try { if (captureRoot) rmSync(captureRoot, { recursive: true, force: true }); } catch { /* Cleanup must not prevent cancellation. */ }
      killChildProcess(child);
      activeObservationCaptures--;
      try { endSandboxExecution(input.policy, membership); } catch { /* Failure stays explicit below. */ }
      resolvePromise(observationCommandResult({ state: "cancelled", stdout: "Complete output capture unavailable; no successful observation was recorded.", stderr: "", exitCode: null, producerTruncated: true }));
      return;
    }
    let captureFailed = false;
    let captureBudgetExceeded = false;
    let capturedBytes = 0;
    let terminal: "running" | "timed_out" | "cancelled" = "running";
    let settled = false;
    const capture = (fd: number, chunk: Buffer) => {
      if (captureFailed) return;
      try {
        if (chunk.length > OBSERVATION_CAPTURE_LIMIT - capturedBytes ||
            chunk.length > OBSERVATION_PROCESS_CAPTURE_LIMIT - observationCaptureBytes) {
          captureBudgetExceeded = true;
          throw new Error("observation capture byte limit exceeded");
        }
        capturedBytes += chunk.length;
        observationCaptureBytes += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const written = writeSync(fd, chunk, offset, chunk.length - offset);
          if (written <= 0) throw new Error("capture write made no progress");
          offset += written;
        }
      } catch {
        captureFailed = true;
        terminal = "cancelled";
        killChildProcess(child);
      }
    };
    const appendStdout = (chunk: Buffer) => capture(stdoutFd!, chunk);
    const appendStderr = (chunk: Buffer) => capture(stderrFd!, chunk);
    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", appendStderr);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      activeObservationCaptures--;
      observationCaptureBytes -= capturedBytes;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      try { if (endSandboxExecution(input.policy, membership) > 0) captureFailed = true; }
      catch { captureFailed = true; }
      let stdout = "", stderr = "";
      try {
        for (const fd of [stdoutFd!, stderrFd!]) {
          try { closeSync(fd); } catch { captureFailed = true; }
        }
        if (!captureFailed) {
          stdout = readFileSync(stdoutPath, "utf8");
          stderr = readFileSync(stderrPath, "utf8");
        }
      } catch { captureFailed = true; }
      finally {
        try { if (captureRoot) rmSync(captureRoot, { recursive: true, force: true }); }
        catch { captureFailed = true; }
      }
      resolvePromise(observationCommandResult({
        state: captureFailed ? "cancelled" : terminal === "running" ? "completed" : terminal,
        producerTruncated: captureFailed,
        stdout: captureFailed
          ? captureBudgetExceeded
            ? "Observation capture byte limit exceeded; incomplete output is not successful evidence."
            : "Complete output capture failed; original bytes are unavailable."
          : stdout,
        stderr,
        exitCode: captureFailed ? null : exitCode,
      }));
    };
    const onAbort = () => {
      if (terminal !== "running") return;
      terminal = "cancelled";
      killChildProcess(child);
    };
    const timer = input.timeout === undefined
      ? undefined
      : setTimeout(() => {
          if (terminal !== "running") return;
          terminal = "timed_out";
          killChildProcess(child);
        }, input.timeout * 1_000);
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(typeof code === "number" ? code : null));
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function observationCommandResult(input: {
  producerTruncated?: boolean;
  state: "completed" | "timed_out" | "cancelled";
  stdout: string;
  stderr: string;
  exitCode: number | null;
}) {
  return {
    content: [{ type: "text" as const, text: input.stdout }],
    details: {
      state: input.state,
      stdout: input.stdout,
      stderr: input.stderr,
      exit_code: input.exitCode,
      ...(input.producerTruncated ? { producer_truncated: true } : {}),
    },
  };
}

function observedBashParams(
  command: string,
  timeout: number,
  observation: BashObservation,
): BashParams & { [BASH_OBSERVATION]: BashObservation } {
  return { command, timeout, [BASH_OBSERVATION]: observation };
}

function readBashObservation(value: unknown): BashObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = Reflect.get(value, BASH_OBSERVATION);
  if (!candidate || typeof candidate !== "object") return undefined;
  const observer = Reflect.get(candidate, "observer");
  if (observer !== "bash_wait" && observer !== "bash_probe") return undefined;
  const probeId = Reflect.get(candidate, "probeId");
  const attempt = Reflect.get(candidate, "attempt");
  return {
    observer,
    ...(typeof probeId === "string" ? { probeId } : {}),
    ...(typeof attempt === "number" ? { attempt } : {}),
  };
}

function waitResult(
  matched: boolean,
  reason: "deadline" | "cancelled" | undefined,
  elapsedMs: number,
  attempts: number,
  last: ObservedCommandOutcome | undefined,
) {
  const details = matched
    ? {
        matched: true,
        elapsed_ms: elapsedMs,
        attempts,
        stdout: last?.stdout ?? "",
        exit_code: last?.exit_code ?? null,
      }
    : {
        matched: false,
        reason: reason ?? "deadline",
        elapsed_ms: elapsedMs,
        attempts,
        last_stdout: last?.stdout ?? "",
        exit_code: last?.exit_code ?? null,
      };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function parseWaitParams(value: unknown): {
  probe: string;
  until: string;
  intervalMs: number;
  deadlineMs: number;
} {
  if (!value || typeof value !== "object") {
    throw new BashParamsError("bash_wait parameters must be an object");
  }
  const probe = Reflect.get(value, "probe");
  const until = Reflect.get(value, "until");
  const interval = Reflect.get(value, "interval_ms");
  const deadline = Reflect.get(value, "deadline_ms");
  if (typeof probe !== "string" || probe.trim() === "") {
    throw new BashParamsError("bash_wait probe must be a non-empty string");
  }
  if (typeof until !== "string" || until.length === 0 || until.length > 512) {
    throw new BashParamsError("bash_wait until must be a 1-512 character regular expression");
  }
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline < 1 ||
    deadline > WAIT_DEADLINE_MAX_MS) {
    throw new BashParamsError("bash_wait deadline_ms must be between 1 and 86400000");
  }
  const intervalMs = interval === undefined ? WAIT_INTERVAL_DEFAULT_MS : interval;
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 10 ||
    intervalMs > WAIT_INTERVAL_MAX_MS) {
    throw new BashParamsError("bash_wait interval_ms must be between 10 and 60000");
  }
  return { probe, until, intervalMs, deadlineMs: deadline };
}

function compileWaitPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "m");
  } catch {
    throw new BashParamsError("bash_wait until must be a valid regular expression");
  }
}

function parseProbeParams(value: unknown): {
  probes: Array<{ id: string; command: string }>;
  parallel: boolean;
  timeout: number;
} {
  if (!value || typeof value !== "object") {
    throw new BashParamsError("bash_probe parameters must be an object");
  }
  const command = Reflect.get(value, "command");
  if (command !== undefined && Reflect.get(value, "probes") !== undefined) throw new BashParamsError("bash_probe accepts either command or probes, not both");
  const rawProbes = command === undefined ? Reflect.get(value, "probes") : [{ id: "command", command }];
  const parallel = Reflect.get(value, "parallel");
  const rawTimeout = Reflect.get(value, "timeout");
  if (!Array.isArray(rawProbes) || rawProbes.length === 0 || rawProbes.length > PROBE_BATCH_LIMIT) {
    throw new BashParamsError("bash_probe requires between 1 and 16 probes");
  }
  if (parallel !== undefined && typeof parallel !== "boolean") {
    throw new BashParamsError("bash_probe parallel must be a boolean");
  }
  const timeout = rawTimeout === undefined ? PROBE_TIMEOUT_DEFAULT_SECONDS : rawTimeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 ||
    timeout > PROBE_TIMEOUT_MAX_SECONDS) {
    throw new BashParamsError("bash_probe timeout must be greater than 0 and at most 3600 seconds");
  }
  const seen = new Set<string>();
  const probes = rawProbes.map((probe) => {
    if (!probe || typeof probe !== "object") {
      throw new BashParamsError("bash_probe entries must be objects");
    }
    const id = Reflect.get(probe, "id");
    const command = Reflect.get(probe, "command");
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) ||
      id === "constructor" || id === "prototype" || id === "__proto__") {
      throw new BashParamsError("bash_probe ids must be unique safe identifiers up to 64 characters");
    }
    if (seen.has(id)) {
      throw new BashParamsError(`bash_probe id ${id} is duplicated`);
    }
    if (typeof command !== "string" || command.trim() === "") {
      throw new BashParamsError(`bash_probe command ${id} must be a non-empty string`);
    }
    seen.add(id);
    return { id, command };
  });
  return { probes, parallel: parallel !== false, timeout };
}

function waitForInterval(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(elapsed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(0, milliseconds));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedObservationText(value: string): string {
  return appendBoundedText("", value, OBSERVATION_OUTPUT_LIMIT);
}

function appendBoundedText(current: string, chunk: unknown, limit: number): string {
  const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const safe = `${current}${raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")}`;
  const bytes = Buffer.from(safe);
  if (bytes.length <= limit) return safe;
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function publicJobState(job: BashJob): BashResultState {
  if (job.status === "running") return "detached";
  if (job.status === "timed_out") return "timed_out";
  return "completed";
}

function bashJobResult(job: BashJob, state: BashResultState) {
  const flags = [
    `bash state=${state}`,
    `handle=${job.handle}`,
    ...(job.exitCode === undefined ? [] : [`exit_code=${job.exitCode}`]),
    ...(job.status === "killed" ? ["killed=true"] : []),
    ...(job.status === "failed" ? ["error=spawn_failed"] : []),
  ].join(" ");
  return bashStateResult(state, job.output ? `${job.output}\n\n${flags}` : flags, {
    handle: job.handle,
    ...(job.exitCode === undefined ? {} : { exit_code: job.exitCode }),
    ...(job.status === "killed" ? { killed: true } : {}),
    ...(job.status === "timed_out" ? { cancelled: true } : {}),
  });
}

function bashStateResult(
  state: BashResultState,
  text: string,
  details: Record<string, unknown> = {},
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { state, ...details },
  };
}

function appendJobOutput(job: BashJob, chunk: unknown): void {
  const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const safe = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  job.outputBytes += Buffer.byteLength(safe);
  job.output = `${job.output}${safe}`;
  if (Buffer.byteLength(job.output) > BACKGROUND_OUTPUT_LIMIT) {
    job.output = Buffer.from(job.output).subarray(-BACKGROUND_OUTPUT_LIMIT).toString("utf8");
  }
}

function killChildProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the child never became a process-group leader.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

function isBashTimeout(error: unknown): boolean {
  return error instanceof Error && /\bCommand timed out after\b/.test(error.message);
}

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function privateHostDirectory(workspace: string, candidate: string): string | undefined {
  try {
    const canonical = realpathSync(candidate);
    const stat = statSync(canonical);
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isDirectory() || !owned || (stat.mode & 0o077) !== 0 || pathInside(workspace, canonical)) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function secureWrapperPath(workspaceRoot: string, logPath: string | undefined, shellName: string): string {
  const workspace = realpathSync(resolve(workspaceRoot));
  if (logPath) {
    const logDirectory = privateHostDirectory(workspace, dirname(logPath));
    if (logDirectory) return join(logDirectory, shellName);
  }
  return hostOwnedWrapperPath(workspace, shellName);
}

/**
 * A model can rewrite every byte in a writable workspace. A no-log tool must
 * therefore place its executable wrapper in a fresh host-owned directory,
 * and fail closed if the host has configured its temp root inside that
 * workspace.
 */
function hostOwnedWrapperPath(workspaceRoot: string, shellName: string): string {
  const workspace = realpathSync(resolve(workspaceRoot));
  const candidates = [...new Set([tmpdir(), "/tmp", "/var/tmp"].map((path) => resolve(path)))];
  for (const candidate of candidates) {
    let base: string;
    try {
      base = realpathSync(candidate);
    } catch {
      continue;
    }
    if (pathInside(workspace, base)) continue;
    let wrapperRoot = HOST_WRAPPER_ROOTS.get(base);
    try {
      if (!wrapperRoot) {
        wrapperRoot = mkdtempSync(join(base, "dokkabi-wrapper-"));
        chmodSync(wrapperRoot, 0o700);
        HOST_WRAPPER_ROOTS.set(base, wrapperRoot);
      }
      const canonicalRoot = privateHostDirectory(workspace, wrapperRoot);
      if (!canonicalRoot) {
        throw new Error("temporary wrapper directory is not host-owned and private");
      }
      wrapperSequence += 1;
      return join(canonicalRoot, `${wrapperSequence}-${shellName}`);
    } catch {
      if (wrapperRoot && HOST_WRAPPER_ROOTS.get(base) === wrapperRoot) {
        HOST_WRAPPER_ROOTS.delete(base);
        rmSync(wrapperRoot, { recursive: true, force: true });
      }
    }
  }
  throw new Error("no private host temp directory exists outside the workspace for the sandbox wrapper");
}

export function boundBashTimeout(
  tool: AgentTool,
  options: {
    readonly defaultSeconds: number;
    readonly maxSeconds: number;
    readonly allowBackground: boolean;
  },
): AgentTool {
  const { defaultSeconds, maxSeconds, allowBackground } = options;
  if (!Number.isFinite(defaultSeconds) || defaultSeconds <= 0) {
    throw new BashTimeoutCapError("bash timeout default must be a positive finite number");
  }
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new BashTimeoutCapError("bash timeout cap must be a positive finite number");
  }
  if (defaultSeconds > maxSeconds) {
    throw new BashTimeoutCapError("bash timeout default cannot exceed the cap");
  }
  const original = tool.execute.bind(tool);
  const boundDescription = defaultSeconds === maxSeconds
    ? `${tool.description} Commands are capped at ${maxSeconds} seconds.`
    : `${tool.description} Commands default to ${defaultSeconds} seconds and are capped at ${maxSeconds} seconds.`;
  return {
    ...tool,
    description: boundDescription,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const parsed = parseBashParams(params);
      if (parsed.background && !allowBackground) {
        throw new BashTimeoutCapError("background bash is unavailable in a timeout-capped review session");
      }
      const timeout =
        parsed.timeout === undefined ? defaultSeconds : Math.min(parsed.timeout, maxSeconds);
      const observation = readBashObservation(params);
      return original(
        toolCallId,
        {
          ...parsed,
          timeout,
          ...(observation ? { [BASH_OBSERVATION]: observation } : {}),
        },
        signal,
        onUpdate,
      );
    },
  };
}

export function capBashTimeout(tool: AgentTool, maxSeconds: number): AgentTool {
  return boundBashTimeout(tool, {
    defaultSeconds: maxSeconds,
    maxSeconds,
    allowBackground: false,
  });
}

function parseBashParams(value: unknown): BashParams {
  if (typeof value !== "object" || value === null) {
    throw new BashParamsError("bash parameters must be an object");
  }
  const command = Reflect.get(value, "command");
  const timeout = Reflect.get(value, "timeout");
  const background = Reflect.get(value, "background");
  const isolated = Reflect.get(value, "isolated");
  if (typeof command !== "string") {
    throw new BashParamsError("bash command must be a string");
  }
  if (background !== undefined && typeof background !== "boolean") {
    throw new BashParamsError("bash background must be a boolean");
  }
  if (isolated !== undefined && typeof isolated !== "boolean") {
    throw new BashParamsError("bash isolated must be a boolean");
  }
  const flags = {
    ...(background === undefined ? {} : { background }),
    ...(isolated === undefined ? {} : { isolated }),
  };
  if (timeout === undefined) {
    return { command, ...flags };
  }
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new BashParamsError("bash timeout must be a positive number");
  }
  return { command, timeout, ...flags };
}
