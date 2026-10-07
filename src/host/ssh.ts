import { publishAnchored } from "./anchored-publication.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { tmpdir, userInfo } from "node:os";
import type { EventLog } from "./event-log.ts";
import type { SandboxHostExecutableSeal } from "./sandbox-executable.ts";
import {
  assertSandboxExecutableIdentity,
  findAndSealSandboxExecutable,
} from "./sandbox-executable.ts";
import {
  containsPrivateInfrastructure,
  containsPrivateInfrastructureValue,
  containsSecretValue,
  redactText,
  normalizeHomePaths,
} from "./redact.ts";
import type { PrerequisiteRegistry } from "../prerequisite/registry.ts";
import type { PermissionController } from "./permissions.ts";
import { knownAliasesHint, SSH_ALIAS_PATTERN } from "./ssh-aliases.ts";
import { enrollSshAlias, maskAddress, parseAddress } from "./ssh-enroll.ts";
import {
  assertSshWarmupTransportIdentity,
  SshWarmupTransportAuthority,
} from "./ssh-warmup-authority.ts";
import {
  changedPaths,
  hunkRows,
  parseNumstat,
  remoteWorkspacesFromPlan,
  type NumstatEntry,
} from "./ssh-remote-diff.ts";
import { describeWaitProgress, waitHasStalled, waitStallMs } from "./ssh-wait-progress.ts";
import { probeWithLiveness, splitLiveness } from "./ssh-wait-liveness.ts";
import { WorkspacePathAnchor } from "./workspace-path.ts";
import { approvalRelayEnabled, waitForOperatorDecision } from "./approval-relay.ts";

const SSH_ALIAS = SSH_ALIAS_PATTERN;
const SSH_COMMAND_MAX_BYTES = 16 * 1024;
/** Multiline remote work rides stdin, not shell quoting. Script cap is for
 * command payload size; output cap is larger to capture full worker stderr
 * (e.g. load_model failures, flashinfer, model_provider traces) instead of
 * scheduler aggregate only. */
const SSH_SCRIPT_MAX_BYTES = 64 * 1024;
const SSH_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const SSH_TIMEOUT_DEFAULT_SECONDS = 120;
/**
 * The ceiling for one sealed remote command.
 *
 * It was ten minutes while the case system let a case declare an hour
 * (case-timeout.ts), and the two never met until an enablement whose cases
 * load twenty gigabytes declared thirty minutes: every one of them came back
 * `refused reason=timeout_invalid` in the same second, before a single remote
 * process started, and the plan could not seal. A case that says how long its
 * work honestly takes is the mechanism that exists to prevent exactly that
 * kind of dead run, so the transport now accepts what a case may declare.
 * Longer work still belongs in a background job watched by `op=wait`, whose
 * deadline is a day.
 */
export const SSH_TIMEOUT_MAX_SECONDS = 3_600;
/** op=wait polling bounds, mirroring bash_wait so remote and local waits read
 * the same. Interval floors keep a runaway loop from hammering the host. */
const SSH_WAIT_INTERVAL_DEFAULT_MS = 5_000;
const SSH_WAIT_INTERVAL_MIN_MS = 10;
const SSH_WAIT_INTERVAL_MAX_MS = 60_000;
const SSH_WAIT_DEADLINE_MAX_MS = 24 * 60 * 60 * 1_000;
/** Each poll caps at this to bound a single hung probe within the loop. */
const SSH_WAIT_PROBE_TIMEOUT_SECONDS = 30;
/** How a call notices its link died instead of spending its whole budget
 * looking busy. Three unanswered probes at this spacing end it (~45s). */
const SSH_KEEPALIVE_INTERVAL_SECONDS = 15;
const SSH_KEEPALIVE_COUNT_MAX = 3;
/** Remote diff probe bounds. numstat measured at 0.01s on the host, so the
 * budget is the round trip; the caps keep the patch body from costing more
 * tokens than the output it annotates. */
const REMOTE_DIFF_TIMEOUT_MS = 15_000;
/** A destination safety probe is intentionally short. A stalled probe must
 * refuse the write rather than consume the transfer's entire timeout. */
const REMOTE_PUT_PREFLIGHT_TIMEOUT_MS = 15_000;
const REMOTE_ATOMIC_PUT_MAX_BYTES = 16 * 1024 * 1024;
const SSH_TRANSFER_MAX_FILES = 4_096;
const SSH_TRANSFER_MAX_ENTRIES = 8_192;
const SSH_TRANSFER_MAX_DEPTH = 64;
/** Separates the two answers the diff probe collects in one crossing. */
const DIFF_PROBE_MARK = "__DOKKABI_REV__";
const REMOTE_DIFF_MAX_FILES = 6;
const REMOTE_DIFF_MAX_LINES = 24;

/** How many questions one batch may ask. Mirrors the local shell's batch cap:
 * enough to collect a phase's worth of state in one turn, small enough that a
 * refusal or a hung host stays legible. */
export const SSH_BATCH_LIMIT = 16;
const SSH_BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

export interface SshBatchProbe {
  readonly id: string;
  readonly target: string;
  readonly command?: string;
  readonly script?: string;
  readonly timeout?: number;
}

export interface SshBatchRequest {
  readonly probes: readonly SshBatchProbe[];
  readonly parallel?: boolean;
}

export interface SshBatchOutcome {
  readonly target: string;
  readonly text: string;
  readonly ms: number;
  readonly error?: true;
}

/**
 * Why a batch cannot be run, or undefined when it can. Shape only — each
 * command still faces every guard on its own, so this rejects nothing an
 * individual call would have been allowed to do.
 */
export function batchRefusal(request: SshBatchRequest): string | undefined {
  const probes = request.probes;
  if (!Array.isArray(probes) || probes.length === 0) return "batch_requires_probes";
  if (probes.length > SSH_BATCH_LIMIT) return `batch_over_${SSH_BATCH_LIMIT}_probes`;
  const seen = new Set<string>();
  for (const probe of probes) {
    if (typeof probe?.id !== "string" || !SSH_BATCH_ID.test(probe.id)) return "batch_probe_id_invalid";
    // Results come back keyed by id, so a duplicate would silently drop an
    // answer the caller asked for.
    if (seen.has(probe.id)) return "batch_probe_id_duplicated";
    seen.add(probe.id);
    if (typeof probe.target !== "string" || probe.target.length === 0) return "batch_probe_requires_target";
    const hasCommand = typeof probe.command === "string" && probe.command.length > 0;
    const hasScript = typeof probe.script === "string" && probe.script.length > 0;
    if (!hasCommand && !hasScript) return "batch_probe_requires_command_or_script";
  }
  return undefined;
}

export type SshApprovalScope = "once" | "session" | "bypass";
export type SshExecutionState = "completed" | "timed_out" | "cancelled" | "spawn_failed";

/** Opaque, service-owned proof that one exact SSH operation was approved. */
export class SshApprovedOperation {
  private constructor() {}

  static issueForService(): SshApprovedOperation {
    return Object.freeze(new SshApprovedOperation());
  }
}

export type SshApprovalPreparation =
  | { readonly ok: true; readonly approval: SshApprovedOperation; readonly discard: () => void }
  | { readonly ok: false; readonly result: SshToolResult };

export interface SshRunnerInput {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly signal?: AbortSignal;
  /** Delivered verbatim to the remote command's stdin; quoting never touches it. */
  readonly stdin?: string;
  readonly target: string;
  readonly timeoutMs: number;
}

export interface SshRunnerResult {
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly state: SshExecutionState;
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly truncated: boolean;
}

export type SshRunner = (input: SshRunnerInput) => Promise<SshRunnerResult>;

/** A sealed scp/rsync invocation. argv is built by the tool — never by the
 * model — and spawned without a shell, so path and alias strings are inert. */
export interface SshTransferRunnerInput {
  readonly engine: "scp" | "rsync";
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export type SshTransferRunner = (input: SshTransferRunnerInput) => Promise<SshRunnerResult>;

interface RemoteWorkspacePlanSnapshot {
  readonly ok: boolean;
  readonly mappings: Readonly<Record<string, string>>;
}

function readRemoteWorkspacePlan(workspaceRoot: string): RemoteWorkspacePlanSnapshot {
  try {
    const planPath = join(workspaceRoot, "work", "current.json");
    return {
      ok: true,
      mappings: remoteWorkspacesFromPlan(JSON.parse(readFileSync(planPath, "utf8")) as unknown),
    };
  } catch {
    return { ok: false, mappings: {} };
  }
}

export type SshTransferRequest =
  | Readonly<{ op: "put"; target: string; local: string; remote: string; recursive?: boolean; timeout?: number }>
  | Readonly<{ op: "get"; target: string; local: string; remote: string; recursive?: boolean; timeout?: number }>
  | Readonly<{ op: "copy"; source_target: string; source_remote: string; dest_target: string; dest_remote: string; recursive?: boolean; timeout?: number }>
  | Readonly<{ op: "sync"; target: string; local: string; remote: string; direction: "up" | "down"; delete?: boolean; timeout?: number }>;

export interface SshToolResult {
  readonly error: boolean;
  readonly text: string;
}

export interface SshService {
  control(command: string): string;
  dispose(): void;
  execute(
    input: Readonly<{ target: string; command: string; script?: string; timeout?: number }>,
    signal?: AbortSignal,
  ): Promise<SshToolResult>;
  requestOperationApproval(
    input: Readonly<{ target: string; command: string; script?: string; timeout?: number }>,
    transport: SshWarmupTransportAuthority,
    signal?: AbortSignal,
  ): Promise<SshApprovalPreparation>;
  executeApproved(
    input: Readonly<{
      request: Readonly<{ target: string; command: string; script?: string; timeout?: number }>;
      approval: SshApprovedOperation;
      runner: SshRunner;
      transport: SshWarmupTransportAuthority;
    }>,
    signal?: AbortSignal,
  ): Promise<SshToolResult>;
  warmupTransport(alias: string): SshWarmupTransportAuthority | undefined;
  /** Several independent remote commands in one call, results keyed by id. */
  batch(input: SshBatchRequest, signal?: AbortSignal): Promise<SshToolResult>;
  waitFor(
    input: Readonly<{ target: string; probe: string; until: string; interval?: number; deadline: number; pid?: number }>,
    signal?: AbortSignal,
  ): Promise<SshToolResult>;
  transfer(input: SshTransferRequest, signal?: AbortSignal): Promise<SshToolResult>;
  /** Operator-approved alias enrollment: write alias→address to the operator's
   * ssh config after an approval popup (or under bypass). The address never
   * enters the EventLog — only the alias name. */
  enroll(input: Readonly<{ alias: string; address: string }>, signal?: AbortSignal): Promise<SshToolResult>;
  setInteractiveApproval(enabled: boolean): void;
}

interface PendingApproval {
  readonly allowSession: boolean;
  readonly requestId: string;
  readonly target: string;
  readonly resolve: (scope: SshApprovalScope | "deny" | "cancelled") => void;
  removeAbort?: () => void;
  settled: boolean;
}

interface ApprovedOperationState {
  readonly digest: string;
  readonly scope: SshApprovalScope;
  readonly transportIdentity: string;
  removeAbort?: () => void;
  valid: boolean;
}

export function createSshService(input: {
  readonly log: EventLog;
  readonly workspaceRoot: string;
  readonly prerequisites?: PrerequisiteRegistry;
  readonly executable?: SandboxHostExecutableSeal;
  readonly scp?: SandboxHostExecutableSeal;
  readonly rsync?: SandboxHostExecutableSeal;
  /** When false, transfer engines come only from the injected seals above —
   * no host discovery. Tests use it to force a genuinely absent engine. */
  readonly sealEngines?: boolean;
  readonly runner?: SshRunner;
  readonly transferRunner?: SshTransferRunner;
  readonly assertExecutable?: (seal: SandboxHostExecutableSeal) => void;
  readonly hostEnv?: NodeJS.Dict<string>;
  readonly permissions?: PermissionController;
  /** alias → remote git workspace. Declaring one turns on the remote diff
   * probe for that host; without it no extra round trip is spent. */
  readonly remoteWorkspaces?: Readonly<Record<string, string>>;
}): SshService {
  const executable = input.executable ?? findAndSealSandboxExecutable("ssh", [input.workspaceRoot]);
  const discover = input.sealEngines !== false;
  const scpExecutable = input.scp ?? (discover ? findAndSealSandboxExecutable("scp", [input.workspaceRoot]) : undefined);
  const rsyncExecutable = input.rsync ?? (discover ? findAndSealSandboxExecutable("rsync", [input.workspaceRoot]) : undefined);
  const transferRunner = input.transferRunner ?? runTransfer;
  const assertExecutable = input.assertExecutable ?? assertSandboxExecutableIdentity;
  const hostEnv = sshHostEnvironment(input.hostEnv ?? process.env);
  const runner = input.runner ?? runSsh;
  const sessionAllowed = new Set<string>();
  let interactive = false;
  let pending: PendingApproval | undefined;
  let disposed = false;
  let requestSequence = input.log.events.filter((event) => event.name === "ssh/approval_requested").length;
  const approvedOperations = new WeakMap<SshApprovedOperation, ApprovedOperationState>();
  const activeApprovedOperations = new Set<SshApprovedOperation>();
  const warmupTransports = new WeakSet<SshWarmupTransportAuthority>();

  // alias → remote git workspace, and the last numstat seen there. Empty until
  // the operator (or a work plan's case dir) declares one: with no declared
  // workspace there is nothing to probe and no extra round trip is spent.
  const remoteWorkspaces = new Map(Object.entries(input.remoteWorkspaces ?? {}));
  const explicitlyConfiguredRemoteWorkspaces = new Map(remoteWorkspaces);
  const remoteWorkspaceTargetsFromPlan = new Set<string>();
  const revokedRemoteWorkspaceTargets = new Set<string>();
  const lastNumstat = new Map<string, NumstatEntry[]>();

  const refreshRemoteWorkspace = (target: string): string | undefined => {
    const snapshot = readRemoteWorkspacePlan(input.workspaceRoot);
    if (snapshot.ok) {
      const planned = Object.hasOwn(snapshot.mappings, target) ? snapshot.mappings[target] : undefined;
      if (planned !== undefined) {
        remoteWorkspaces.set(target, planned);
        remoteWorkspaceTargetsFromPlan.add(target);
        revokedRemoteWorkspaceTargets.delete(target);
        return planned;
      }
      if (remoteWorkspaceTargetsFromPlan.has(target)) {
        const configured = explicitlyConfiguredRemoteWorkspaces.get(target);
        if (configured === undefined) {
          remoteWorkspaces.delete(target);
          revokedRemoteWorkspaceTargets.add(target);
        } else {
          remoteWorkspaces.set(target, configured);
          revokedRemoteWorkspaceTargets.delete(target);
        }
      }
    } else if (remoteWorkspaceTargetsFromPlan.has(target)) {
      const configured = explicitlyConfiguredRemoteWorkspaces.get(target);
      if (configured === undefined) {
        remoteWorkspaces.delete(target);
        revokedRemoteWorkspaceTargets.add(target);
      } else {
        remoteWorkspaces.set(target, configured);
        revokedRemoteWorkspaceTargets.delete(target);
      }
    }
    return remoteWorkspaces.get(target);
  };

  /**
   * One extra round trip after an exec: `git diff --numstat` is 0.01s on the
   * remote, so the file-level signal is close to free. The patch body is not,
   * so hunks are fetched only for the paths that moved in THIS call and are
   * capped — the full working tree would cost thousands of tokens per probe.
   */
  const probeRemoteDiff = async (target: string, signal?: AbortSignal): Promise<void> => {
    const dir = refreshRemoteWorkspace(target);
    if (!dir || !executable || disposed || signal?.aborted) return;
    const dirWord = remotePathShellWord(dir);
    if (dirWord === undefined) return;
    const run = async (command: string): Promise<string | undefined> => {
      try {
        const probe = await runner({
          command,
          env: hostEnv,
          executable: executable.path,
          signal,
          target,
          timeoutMs: REMOTE_DIFF_TIMEOUT_MS,
        });
        return probe.state === "completed" && probe.exitCode === 0 ? probe.stdout : undefined;
      } catch {
        return undefined;
      }
    };
    // Both answers ride one round trip. This probe runs after remote work and
    // costs a full crossing of the network each time — measured at a three
    // second median, slower than the median remote command it follows — so a
    // second crossing to learn the revision is worth more than the bytes it
    // saves on the tree that has not moved.
    const probed = await run(`git -C ${dirWord} diff --numstat; echo ${DIFF_PROBE_MARK}; git -C ${dirWord} rev-parse HEAD`);
    if (probed === undefined) return;
    const [numstat, headLine] = splitAtMark(probed, DIFF_PROBE_MARK);
    const after = parseNumstat(numstat);
    const before = lastNumstat.get(target);
    lastNumstat.set(target, after);
    const changed = changedPaths(before, after);
    if (changed.length === 0) return;
    // The revision plus the dirty-tree digest identify what the host is
    // actually running, so a green recorded against one of them can be told
    // apart from the code that came after.
    const head = headLine.trim() || undefined;
    const revision = head
      ? `${head.slice(0, 12)}:${createHash("sha256").update(numstat).digest("hex").slice(0, 12)}`
      : undefined;
    const paths = changed.slice(0, REMOTE_DIFF_MAX_FILES);
    const patch = await run(
      `git -C ${dirWord} diff --unified=1 -- ${paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ")}`,
    );
    const hunks = patch === undefined
      ? []
      : hunkRows(normalizeHomePaths(redactText(patch)), { maxTotal: REMOTE_DIFF_MAX_LINES });
    const safeHunks = hunks.filter((line) => !containsPrivateInfrastructure(line));
    input.log.append({
      kind: "observe",
      name: "ssh/diff",
      payload: {
        target,
        ...(revision ? { revision } : {}),
        files: after
          .filter((entry) => paths.includes(entry.path))
          .map((entry) => ({
            path: entry.path,
            added: entry.added,
            removed: entry.removed,
            ...(entry.binary ? { binary: true } : {}),
          })),
        ...(changed.length > paths.length ? { more_files: changed.length - paths.length } : {}),
        ...(safeHunks.length > 0 ? { hunks: safeHunks } : {}),
      },
    });
  };

  /**
   * Several independent remote commands in one tool call.
   *
   * A long run issued 291 tool calls and never more than one per turn, so
   * every remote question — however small — cost a full model round trip.
   * Eighty-eight of those calls did under a second of remote work between
   * them, spread across twenty stretches of consecutive turns; the harness
   * spent thirteen minutes of wall clock to collect four seconds of answers.
   * The local shell already had the batching shape (bash_probe); the remote
   * path, where the overwhelming share of tool time actually goes, did not.
   *
   * Every command keeps its own alias check, approval, sealed argv and log
   * pair — a batch is a way to ask several questions at once, never a way to
   * ask one that would be refused alone. The remote-workspace probe runs once
   * per target at the end rather than once per command, because it is a round
   * trip in its own right and the batch exists to remove round trips.
   */
  const runBatch = async (
    request: SshBatchRequest,
    signal?: AbortSignal,
  ): Promise<SshToolResult> => {
    if (disposed) return { error: true, text: "ssh state=unavailable reason=service_disposed" };
    if (!executable) return { error: true, text: "ssh state=unavailable reason=executable_missing" };
    const refusal = batchRefusal(request);
    if (refusal) return { error: true, text: `ssh state=refused reason=${refusal}` };
    const run = async (probe: SshBatchProbe): Promise<[string, SshBatchOutcome]> => {
      const startedAt = performance.now();
      const result = await runExec({
        target: probe.target,
        command: probe.command ?? "",
        ...(probe.script === undefined ? {} : { script: probe.script }),
        ...(probe.timeout === undefined ? {} : { timeout: probe.timeout }),
      }, signal, { withDiff: false });
      return [probe.id, {
        target: probe.target,
        text: result.text,
        ms: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(result.error ? { error: true as const } : {}),
      }];
    };
    // Only one approval can be waiting at a time, so probes fired together at
    // an unapproved target would cancel each other with "already waiting".
    // Until every target is settled, the batch goes one at a time and each
    // probe gets its own answer from the operator.
    const settled = input.permissions?.current() === "bypass"
      || request.probes.every((probe) => sessionAllowed.has(probe.target));
    let entries: [string, SshBatchOutcome][];
    if (request.parallel === false || !settled) {
      entries = [];
      for (const probe of request.probes) entries.push(await run(probe));
    } else {
      entries = await Promise.all(request.probes.map(run));
    }
    // One probe per target, after the work, so the operator still sees what
    // moved without paying for the sight once per command.
    for (const target of new Set(request.probes.map((probe) => probe.target))) {
      await probeRemoteDiff(target, signal);
    }
    const results = Object.fromEntries(entries);
    return {
      error: entries.some(([, outcome]) => outcome.error === true),
      text: JSON.stringify(results, null, 2),
    };
  };

  const setPrerequisite = (status: "ready" | "waiting_operator" | "unavailable", reason: string): void => {
    input.prerequisites?.update("ssh_access", status, reason);
  };
  setPrerequisite(executable ? "ready" : "unavailable", executable ? "available" : "executable_missing");

  const resolvePending = (
    decision: SshApprovalScope | "deny" | "cancelled",
    reason: "operator" | "permission_mode" | "signal" | "interactive_closed" | "disposed",
  ): void => {
    const current = pending;
    if (!current || current.settled) return;
    if (reason === "operator" || reason === "permission_mode") {
      input.log.append({
        kind: "effect",
        name: "ssh/approval_decision",
        payload: {
          request_id: current.requestId,
          decision: decision === "deny" ? "deny" : "approve",
          ...(decision === "once" || decision === "session" || decision === "bypass" ? { scope: decision } : {}),
          target: current.target,
        },
      });
    }
    current.settled = true;
    current.removeAbort?.();
    if (decision === "session") sessionAllowed.add(current.target);
    input.log.append({
      kind: "observe",
      name: "ssh/approval_resolved",
      payload: {
        request_id: current.requestId,
        status: decision === "once" || decision === "session" || decision === "bypass" ? "approved" : decision,
        reason,
        target: current.target,
        ...(decision === "once" || decision === "session" || decision === "bypass" ? { scope: decision } : {}),
      },
    });
    pending = undefined;
    setPrerequisite(executable ? "ready" : "unavailable", executable ? "available" : "executable_missing");
    current.resolve(decision);
  };

  const requestApproval = async (
    target: string,
    commandDigest: string,
    signal?: AbortSignal,
    options?: Readonly<{ detail?: string; allowSession?: boolean }>,
  ): Promise<SshApprovalScope | "deny" | "cancelled" | "not_interactive"> => {
    if (input.permissions?.current() === "bypass") return "bypass";
    if (sessionAllowed.has(target)) return "session";
    requestSequence += 1;
    const requestId = `ssh-${requestSequence}`;
    input.log.append({
      kind: "observe",
      name: "ssh/approval_requested",
      // `detail` is a pre-masked, display-only string (e.g. an enroll's masked
      // address); it passes the same guards as any surfaced value.
      payload: { request_id: requestId, target, command_digest: commandDigest, ...(options?.detail ? { detail: options.detail } : {}) },
    });
    if (!interactive) {
      if (!approvalRelayEnabled()) {
        input.log.append({
          kind: "observe",
          name: "ssh/approval_resolved",
          payload: { request_id: requestId, target, status: "unavailable", reason: "not_interactive" },
        });
        return "not_interactive";
      }
      // No operator in front of this process: park the request beside the
      // session log and wait for `dokkabi approve` (approval-relay.ts).
      setPrerequisite("waiting_operator", "operator_approval_required");
      const outcome = await waitForOperatorDecision({
        logPath: input.log.path,
        kind: "ssh",
        requestId,
        target,
        summary: options?.detail ?? `ssh ${target} command ${commandDigest.slice(0, 12)}`,
        ...(signal ? { signal } : {}),
      });
      setPrerequisite(executable ? "ready" : "unavailable", executable ? "available" : "executable_missing");
      if (outcome === "once" || outcome === "session") {
        const scope = outcome === "session" && options?.allowSession !== false ? "session" : "once";
        if (scope === "session") sessionAllowed.add(target);
        input.log.append({
          kind: "effect",
          name: "ssh/approval_decision",
          payload: { request_id: requestId, decision: "approve", scope, target },
        });
        input.log.append({
          kind: "observe",
          name: "ssh/approval_resolved",
          payload: { request_id: requestId, target, status: "approved", reason: "operator", scope },
        });
        return scope;
      }
      if (outcome === "deny") {
        input.log.append({
          kind: "effect",
          name: "ssh/approval_decision",
          payload: { request_id: requestId, decision: "deny", target },
        });
        input.log.append({
          kind: "observe",
          name: "ssh/approval_resolved",
          payload: { request_id: requestId, target, status: "deny", reason: "operator" },
        });
        return "deny";
      }
      input.log.append({
        kind: "observe",
        name: "ssh/approval_resolved",
        payload: {
          request_id: requestId,
          target,
          status: outcome === "cancelled" ? "cancelled" : "unavailable",
          reason: outcome === "cancelled" ? "signal" : "operator_timeout",
        },
      });
      return outcome === "cancelled" ? "cancelled" : "not_interactive";
    }
    if (pending) {
      input.log.append({
        kind: "observe",
        name: "ssh/approval_resolved",
        payload: { request_id: requestId, target, status: "cancelled", reason: "request_already_waiting" },
      });
      return "cancelled";
    }
    setPrerequisite("waiting_operator", "operator_approval_required");
    return new Promise((resolve) => {
      const next: PendingApproval = {
        allowSession: options?.allowSession !== false,
        requestId,
        resolve,
        settled: false,
        target,
      };
      if (signal) {
        const onAbort = () => resolvePending("cancelled", "signal");
        signal.addEventListener("abort", onAbort, { once: true });
        next.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      pending = next;
      if (signal?.aborted) resolvePending("cancelled", "signal");
    });
  };

  const removePermissionListener = input.permissions?.onChange((mode) => {
    if (mode === "bypass") resolvePending("bypass", "permission_mode");
  });

  const consumeApprovedOperation = (
    approval: SshApprovedOperation,
    digest: string,
    transport: SshWarmupTransportAuthority,
  ): { readonly ok: true; readonly scope: SshApprovalScope } | { readonly ok: false; readonly reason: string } => {
    const state = approvedOperations.get(approval);
    if (!state?.valid) return { ok: false, reason: "approved_operation_invalid" };
    state.valid = false;
    state.removeAbort?.();
    activeApprovedOperations.delete(approval);
    if (!warmupTransports.has(transport) || state.transportIdentity !== transport.identity || state.digest !== digest) {
      return { ok: false, reason: "approved_operation_mismatch" };
    }
    try {
      assertSshWarmupTransportIdentity(transport);
    } catch {
      return { ok: false, reason: "approved_transport_changed" };
    }
    return { ok: true, scope: state.scope };
  };

  const registerWarmupTransport = (alias: string): SshWarmupTransportAuthority | undefined => {
    if (disposed || !executable || !SSH_ALIAS.test(alias)) return undefined;
    const home = hostEnv.HOME;
    if (!home) return undefined;
    try {
      const transport = SshWarmupTransportAuthority.registerForService({
        alias,
        configPath: join(home, ".ssh", "config"),
        env: hostEnv,
        executable,
        reportCleanupFailure: () => input.log.append({
          kind: "observe",
          name: "ssh/warmup_cleanup_failed",
          payload: { target: alias, state: "cleanup_failed" },
        }),
      });
      warmupTransports.add(transport);
      return transport;
    } catch {
      return undefined;
    }
  };

  /**
   * One remote command, with every guard the tool surface promises: alias
   * validation, approval, the sealed argv, and the log pair.
   *
   * withDiff is false only when a caller will probe the remote workspace
   * itself once for the whole group. The probe costs a full round trip at
   * the far end — measured at three seconds against a median remote call of
   * under three — so running it once per command in a batch would cost more
   * than the batch saves.
   */
  const runExec = async (
    request: Readonly<{ target: string; command: string; script?: string; timeout?: number }>,
    signal: AbortSignal | undefined,
    options: Readonly<{
      withDiff: boolean;
      prepared?: Readonly<{
        approval: SshApprovedOperation;
        runner: SshRunner;
        transport: SshWarmupTransportAuthority;
      }>;
    }>,
  ): Promise<SshToolResult> => {
    if (disposed) return { error: true, text: "ssh state=unavailable reason=service_disposed" };
    if (!executable) return { error: true, text: "ssh state=unavailable reason=executable_missing" };
    const parsed = parseSshRequest(request);
    if (!parsed.ok) {
      // A malformed target is the model groping for a name the operator
      // already chose; answer with the roster so one refusal is enough.
      const hint = parsed.reason === "target_must_be_operator_ssh_alias"
        ? ` ${knownAliasesHint(hostEnv)}`
        : "";
      return { error: true, text: `ssh state=refused reason=${parsed.reason}${hint}` };
    }
    const commandDigest = createHash("sha256")
      .update(parsed.command)
      .update("\0")
      .update(parsed.script ?? "")
      .digest("hex");
    const nativeTransport = options.prepared ? undefined : registerWarmupTransport(parsed.target);
    const consumed = options.prepared
      ? consumeApprovedOperation(
        options.prepared.approval,
        approvedRequestDigest(parsed),
        options.prepared.transport,
      )
      : undefined;
    if (consumed && !consumed.ok) {
      return { error: true, text: `ssh state=refused reason=${consumed.reason}; no remote process started` };
    }
    const approval = consumed?.scope ?? await requestApproval(parsed.target, commandDigest, signal);
    if (approval === "not_interactive") {
      return {
        error: true,
        text: "ssh state=approval_required reason=interactive_approval_unavailable; no operator answered — approve with dokkabi approve --session ID REQUEST once|session|deny (dokkabi approvals lists them), use Dokkabi chat, or restart with --permission-mode bypass",
      };
    }
    if (approval === "deny" || approval === "cancelled") {
      return { error: true, text: `ssh state=${approval === "deny" ? "denied" : "cancelled"}; no remote process started` };
    }
    if (signal?.aborted) return { error: true, text: "ssh state=cancelled; no remote process started" };
    assertExecutable(executable);
    if (nativeTransport) {
      try { assertSshWarmupTransportIdentity(nativeTransport); }
      catch { return { error: true, text: "ssh state=refused reason=transport_changed; no remote process started" }; }
    }
    input.log.append({
      kind: "effect",
      name: "ssh/exec",
      payload: {
        target: parsed.target,
        command_digest: commandDigest,
        approval_scope: approval,
        timeout_seconds: parsed.timeout,
        ...(parsed.script === undefined ? {} : { script_bytes: Buffer.byteLength(parsed.script) }),
      },
    });
    const runnerStartedAt = performance.now();
    let result: SshRunnerResult;
    try {
      const runnerInput: SshRunnerInput = {
        command: parsed.command,
        env: hostEnv,
        executable: executable.path,
        signal,
        ...(parsed.script === undefined ? {} : { stdin: parsed.script }),
        target: parsed.target,
        timeoutMs: parsed.timeout * 1_000,
      };
      const selectedRunner = options.prepared?.runner ?? input.runner;
      result = selectedRunner
        ? await selectedRunner(runnerInput)
        : await runSsh(runnerInput, selectServiceSshConfigPath({
          serviceHome: hostEnv.HOME,
          osAccountHome: userInfo().homedir,
          registeredConfigPath: nativeTransport?.configPath,
        }));
    } catch {
      result = emptyRunnerResult("spawn_failed", runnerStartedAt);
    }
    const publicState = sshPublicState(result);
    input.log.append({
      kind: "observe",
      name: "ssh/result",
      payload: {
        target: parsed.target,
        state: publicState,
        exit_code: result.exitCode ?? "missing",
        stdout_bytes: result.stdoutBytes,
        stderr_bytes: result.stderrBytes,
        truncated: result.truncated,
        duration_ms: result.durationMs,
      },
    });
    if (publicState === "alias_unresolved") {
      return {
        error: true,
        text: `ssh state=alias_unresolved target=${parsed.target} ${knownAliasesHint(hostEnv)}`,
      };
    }
    const output = safeSshOutput(result.stdout, result.stderr);
    const error = result.state !== "completed" || result.exitCode !== 0;
    // A remote file change is otherwise invisible: the local edit/write diff
    // never fires for work done over ssh. Probe the declared workspace so
    // the operator can see what actually moved on the other machine.
    if (options.withDiff) await probeRemoteDiff(parsed.target, signal);
    return {
      error,
      text: [
        `ssh target=${parsed.target} state=${result.state} exit_code=${result.exitCode ?? "missing"}${result.truncated ? " truncated=true" : ""}`,
        output,
      ].filter(Boolean).join("\n"),
    };
  };

  return {
    control(command) {
      const normalized = command.trim().toLowerCase().replace(/\s+/gu, " ");
      if (normalized === "" || normalized === "status") {
        if (!executable) return "ssh unavailable: trusted OpenSSH executable not found";
        if (!pending) {
          const approval = input.permissions?.current() === "bypass" ? "bypass" : "idle";
          return `ssh transport=host_openssh executable=present approval=${approval} granted=${sessionAllowed.size} sandbox=enforced`;
        }
        return `SSH transport=host_openssh executable=present approval=pending granted=${sessionAllowed.size} target=${pending.target} sandbox=enforced — /ssh approve once | /ssh approve session | /ssh deny`;
      }
      if (normalized === "approve once") {
        if (!pending) throw new Error("no SSH approval is waiting");
        resolvePending("once", "operator");
        return "SSH approved once; the pending command is continuing";
      }
      if (normalized === "approve session") {
        if (!pending) throw new Error("no SSH approval is waiting");
        const target = pending.target;
        const scope = pending.allowSession ? "session" : "once";
        resolvePending(scope, "operator");
        return scope === "session"
          ? `SSH approved for target ${target} in this session; the pending command is continuing`
          : "SSH approved once; the exact pending operation is continuing";
      }
      if (normalized === "deny") {
        if (!pending) throw new Error("no SSH approval is waiting");
        resolvePending("deny", "operator");
        return "SSH request denied; no remote process was started";
      }
      throw new Error("usage: /ssh [status|approve once|approve session|deny]");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      interactive = false;
      resolvePending("cancelled", "disposed");
      sessionAllowed.clear();
      for (const approval of activeApprovedOperations) {
        const state = approvedOperations.get(approval);
        if (state) {
          state.valid = false;
          state.removeAbort?.();
        }
      }
      activeApprovedOperations.clear();
      removePermissionListener?.();
    },
    execute(request, signal) {
      return runExec(request, signal, { withDiff: true });
    },
    async requestOperationApproval(request, transport, signal) {
      if (disposed) return { ok: false, result: { error: true, text: "ssh state=unavailable reason=service_disposed" } };
      if (!executable) return { ok: false, result: { error: true, text: "ssh state=unavailable reason=executable_missing" } };
      const parsed = parseSshRequest(request);
      if (!parsed.ok) {
        const hint = parsed.reason === "target_must_be_operator_ssh_alias" ? ` ${knownAliasesHint(hostEnv)}` : "";
        return { ok: false, result: { error: true, text: `ssh state=refused reason=${parsed.reason}${hint}` } };
      }
      if (!warmupTransports.has(transport) || transport.alias !== parsed.target ||
        transport.executable.identity !== executable.identity) {
        return { ok: false, result: { error: true, text: "ssh state=refused reason=warmup_transport_mismatch; no remote process started" } };
      }
      try {
        assertSshWarmupTransportIdentity(transport);
        assertExecutable(transport.executable);
      } catch {
        return { ok: false, result: { error: true, text: "ssh state=refused reason=warmup_transport_changed; no remote process started" } };
      }
      const commandDigest = createHash("sha256").update(parsed.command).update("\0").update(parsed.script ?? "").digest("hex");
      const outcome = await requestApproval(parsed.target, commandDigest, signal, { allowSession: false });
      if (outcome === "not_interactive") {
        return { ok: false, result: { error: true, text: "ssh state=approval_required reason=interactive_approval_unavailable; no operator answered — approve with dokkabi approve --session ID REQUEST once|session|deny (dokkabi approvals lists them), use Dokkabi chat, or restart with --permission-mode bypass" } };
      }
      if (outcome === "deny" || outcome === "cancelled" || signal?.aborted || disposed) {
        const state = outcome === "deny" ? "denied" : "cancelled";
        return { ok: false, result: { error: true, text: `ssh state=${state}; no remote process started` } };
      }
      assertExecutable(executable);
      const approval = SshApprovedOperation.issueForService();
      const state: ApprovedOperationState = {
        digest: approvedRequestDigest(parsed),
        scope: outcome,
        transportIdentity: transport.identity,
        valid: true,
      };
      const discard = (): void => {
        state.valid = false;
        state.removeAbort?.();
        activeApprovedOperations.delete(approval);
      };
      if (signal) {
        const onAbort = (): void => discard();
        signal.addEventListener("abort", onAbort, { once: true });
        state.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      approvedOperations.set(approval, state);
      activeApprovedOperations.add(approval);
      return { ok: true, approval, discard };
    },
    executeApproved(approved, signal) {
      return runExec(approved.request, signal, {
        withDiff: true,
        prepared: {
          approval: approved.approval,
          runner: approved.runner,
          transport: approved.transport,
        },
      });
    },
    warmupTransport(alias) {
      return registerWarmupTransport(alias);
    },
    batch(request, signal) {
      return runBatch(request, signal);
    },
    async waitFor(request, signal) {
      if (disposed) return { error: true, text: "ssh state=unavailable reason=service_disposed" };
      if (!executable) return { error: true, text: "ssh state=unavailable reason=executable_missing" };
      const parsed = parseWaitRequest(request);
      if (!parsed.ok) {
        const hint = parsed.reason === "target_must_be_operator_ssh_alias"
          ? ` ${knownAliasesHint(hostEnv)}`
          : "";
        return { error: true, text: `ssh state=refused reason=${parsed.reason}${hint}` };
      }
      const matcher = parsed.matcher;
      // One approval covers the whole wait: the probe digest, not each poll,
      // is what the operator authorizes.
      const commandDigest = createHash("sha256").update(parsed.command).digest("hex");
      const approval = await requestApproval(parsed.target, commandDigest, signal);
      if (approval === "not_interactive") {
        return {
          error: true,
          text: "ssh state=approval_required reason=interactive_approval_unavailable; no operator answered — approve with dokkabi approve --session ID REQUEST once|session|deny (dokkabi approvals lists them), use Dokkabi chat, or restart with --permission-mode bypass",
        };
      }
      if (approval === "deny" || approval === "cancelled") {
        return { error: true, text: `ssh state=${approval === "deny" ? "denied" : "cancelled"}; no remote process started` };
      }
      if (signal?.aborted) return { error: true, text: "ssh state=cancelled; no remote process started" };
      assertExecutable(executable);
      const startedAt = performance.now();
      const deadlineAt = startedAt + parsed.deadlineMs;
      // A probe that stops changing is watching something that has stopped.
      // The loop already computed that and did nothing with it, so whole
      // deadlines were spent on finished jobs (ssh-wait-progress.ts).
      const stallMs = waitStallMs(parsed.deadlineMs);
      let unchangedSince = startedAt;
      let attempts = 0;
      let lastOutput = "";
      while (true) {
        if (signal?.aborted) return waitToolResult("cancelled", attempts, lastOutput, parsed.target);
        const remainingMs = deadlineAt - performance.now();
        if (remainingMs <= 0) return waitToolResult("deadline", attempts, lastOutput, parsed.target);
        attempts += 1;
        const probeTimeoutMs = Math.min(SSH_WAIT_PROBE_TIMEOUT_SECONDS * 1_000, remainingMs);
        input.log.append({
          kind: "effect",
          name: "ssh/exec",
          payload: {
            target: parsed.target,
            command_digest: commandDigest,
            approval_scope: approval,
            timeout_seconds: Math.max(1, Math.round(probeTimeoutMs / 1_000)),
            wait_attempt: attempts,
          },
        });
        let result: SshRunnerResult;
        try {
          result = await runner({
            command: parsed.command,
            env: hostEnv,
            executable: executable.path,
            signal,
            target: parsed.target,
            timeoutMs: probeTimeoutMs,
          });
        } catch {
          result = emptyRunnerResult("spawn_failed", performance.now());
        }
        const publicState = sshPublicState(result);
        input.log.append({
          kind: "observe",
          name: "ssh/result",
          payload: {
            target: parsed.target,
            state: publicState,
            exit_code: result.exitCode ?? "missing",
            stdout_bytes: result.stdoutBytes,
            stderr_bytes: result.stderrBytes,
            truncated: result.truncated,
            duration_ms: result.durationMs,
            wait_attempt: attempts,
          },
        });
        if (publicState === "alias_unresolved") {
          return {
            error: true,
            text: `ssh state=alias_unresolved target=${parsed.target} ${knownAliasesHint(hostEnv)}`,
          };
        }
        const previousOutput = attempts > 1 ? lastOutput : undefined;
        const liveness = splitLiveness(result.stdout);
        lastOutput = safeSshOutput(liveness.output, result.stderr);
        // Match against raw stdout so a private-coordinate withholding of the
        // safe output never silently prevents a legitimate match; the returned
        // text still carries only the safe output. The liveness marker is
        // stripped first so it can never satisfy the caller's pattern.
        if (matcher.test(liveness.output)) {
          return waitToolResult("matched", attempts, lastOutput, parsed.target);
        }
        // The watched process is gone and the pattern never appeared. That is
        // an answer, and usually the interesting one.
        if (liveness.alive === false) {
          return waitToolResult("process_exited", attempts, lastOutput, parsed.target);
        }
        const afterProbeMs = deadlineAt - performance.now();
        // Every poll already knows how far along the job is. Say so: a wait
        // that shows nothing for ten minutes is indistinguishable from a dead
        // one, and the probe's own words are the best progress there is.
        const progress = describeWaitProgress({
          attempt: attempts,
          elapsedMs: performance.now() - startedAt,
          remainingMs: Math.max(0, afterProbeMs),
          output: lastOutput,
          ...(previousOutput === undefined ? {} : { previousOutput }),
          // op=wait watches a probe, not a growing log.
          kind: "probe",
        });
        input.log.append({
          kind: "observe",
          name: "ssh/wait_progress",
          payload: {
            target: parsed.target,
            attempt: attempts,
            elapsed_ms: Math.round(performance.now() - startedAt),
            remaining_ms: Math.max(0, Math.round(afterProbeMs)),
            changed: progress.changed,
            detail: progress.line,
          },
        });
        if (progress.changed) unchangedSince = performance.now();
        if (afterProbeMs <= 0) return waitToolResult("deadline", attempts, lastOutput, parsed.target);
        if (waitHasStalled(performance.now() - unchangedSince, stallMs)) {
          return waitToolResult("stalled", attempts, lastOutput, parsed.target);
        }
        const slept = await sleepInterruptible(Math.min(parsed.intervalMs, afterProbeMs), signal);
        if (!slept) return waitToolResult("cancelled", attempts, lastOutput, parsed.target);
      }
    },
    async transfer(request, signal) {
      if (disposed) return { error: true, text: "ssh state=unavailable reason=service_disposed" };
      const plan = planTransfer(request, input.workspaceRoot, { scp: scpExecutable, rsync: rsyncExecutable });
      if (!plan.ok) {
        const hint = plan.reason === "target_must_be_operator_ssh_alias"
          ? ` ${knownAliasesHint(hostEnv)}`
          : "";
        return { error: true, text: `ssh state=refused reason=${plan.reason}${hint}` };
      }
      const seal = plan.engine === "scp" ? scpExecutable : rsyncExecutable;
      if (!seal) {
        return { error: true, text: `ssh state=unavailable reason=engine_unavailable engine=${plan.engine}` };
      }
      if (!executable) {
        return { error: true, text: "ssh state=unavailable reason=executable_missing" };
      }
      // Every distinct alias the transfer touches needs its own approval:
      // a server-to-server copy authorizes both ends.
      for (const alias of plan.targets) {
        const commandDigest = createHash("sha256").update(`${plan.op}:${plan.descriptor}`).digest("hex");
        const approval = await requestApproval(alias, commandDigest, signal);
        if (approval === "not_interactive") {
          return {
            error: true,
            text: "ssh state=approval_required reason=interactive_approval_unavailable; no operator answered — approve with dokkabi approve --session ID REQUEST once|session|deny (dokkabi approvals lists them), use Dokkabi chat, or restart with --permission-mode bypass",
          };
        }
        if (approval === "deny" || approval === "cancelled") {
          return { error: true, text: `ssh state=${approval === "deny" ? "denied" : "cancelled"}; no transfer started` };
        }
      }
      if (signal?.aborted) return { error: true, text: "ssh state=cancelled; no transfer started" };
      assertExecutable(executable);
      assertExecutable(seal);
      const remoteWorkspace = request.op === "put" ? refreshRemoteWorkspace(request.target) : undefined;
      if (request.op === "put" && revokedRemoteWorkspaceTargets.has(request.target)) {
        return { error: true, text: "ssh state=refused reason=remote_destination_unverified" };
      }
      if (request.op === "put" && remoteWorkspace !== undefined) {
        input.log.append({
          kind: "effect",
          name: "ssh/remote_put_preflight",
          payload: { target: request.target, status: "requested", transport: "atomic_nofollow" },
        });
        const preflight = await preflightRemotePut({
          target: request.target,
          remote: request.remote,
          remoteWorkspace,
          recursive: request.recursive === true,
          runner,
          executable: executable.path,
          env: hostEnv,
          signal,
        });
        input.log.append({
          kind: "observe",
          name: "ssh/remote_put_preflight",
          payload: { target: request.target, status: preflight.ok ? "verified" : "refused" },
        });
        if (!preflight.ok) {
          return { error: true, text: `ssh state=refused reason=${preflight.reason}` };
        }
        if (plan.localPath === undefined) {
          return { error: true, text: "ssh state=refused reason=local_source_unverified" };
        }
        const content = readSafeLocalFile(plan.localPath, input.workspaceRoot);
        if (content === undefined) {
          return { error: true, text: "ssh state=refused reason=local_source_unverified" };
        }
        input.log.append({
          kind: "effect",
          name: "ssh/transfer",
          payload: {
            op: plan.op,
            engine: "ssh-atomic-nofollow",
            targets: plan.targets,
            descriptor: plan.descriptor,
            timeout_seconds: plan.timeoutSeconds,
          },
        });
        const result = await runAtomicRemotePut({
          target: request.target,
          remote: request.remote,
          remoteWorkspace,
          baseIdentity: preflight.baseIdentity,
          parentIdentity: preflight.parentIdentity,
          content,
          runner,
          executable: executable.path,
          env: hostEnv,
          signal,
          timeoutMs: plan.timeoutSeconds * 1_000,
        });
        input.log.append({
          kind: "observe",
          name: "ssh/transfer_result",
          payload: {
            op: plan.op,
            engine: "ssh-atomic-nofollow",
            state: result.state,
            exit_code: result.exitCode ?? "missing",
            duration_ms: result.durationMs,
          },
        });
        const output = safeSshOutput(result.stdout, result.stderr);
        const completed = result.state === "completed" && result.exitCode === 0;
        if (result.state === "cancelled" || signal?.aborted) {
          return { error: true, text: "ssh state=cancelled; no remote file committed" };
        }
        if (!completed) {
          const reason = result.state === "completed"
            ? "remote_destination_unsafe"
            : "remote_destination_unverified";
          return {
            error: true,
            text: [
              `ssh state=refused reason=${reason} engine=ssh-atomic-nofollow state=${result.state} exit_code=${result.exitCode ?? "missing"}`,
              output,
            ].filter(Boolean).join("\n"),
          };
        }
        return {
          error: false,
          text: [
            "ssh put engine=ssh-atomic-nofollow state=completed exit_code=0",
            output,
          ].filter(Boolean).join("\n"),
        };
      }
      // The sealed OpenSSH is the transport for both engines (scp -S, rsync -e).
      let stagedSource: StagedLocalFile | undefined;
      if (request.op === "put") {
        if (plan.localPath === undefined) {
          return { error: true, text: "ssh state=refused reason=local_source_unverified" };
        }
        stagedSource = request.recursive === true
          ? stageSafeLocalTree(plan.localPath, input.workspaceRoot)
          : stageSafeLocalFile(plan.localPath, input.workspaceRoot);
        if (stagedSource === undefined) {
          return { error: true, text: "ssh state=refused reason=local_source_unverified" };
        }
      }
      const downloading = request.op === "get" || (request.op === "sync" && request.direction === "down");
      let receiveDirectory: string | undefined;
      let receivePath: string | undefined;
      let destinationAnchor: { path: string; dev: string; ino: string } | undefined;
      if (downloading) {
        const root = realpathSync(input.workspaceRoot);
        const identity = statSync(root, { bigint: true });
        destinationAnchor = { path: root, dev: String(identity.dev), ino: String(identity.ino) };
        receiveDirectory = mkdtempSync(join(tmpdir(), "dokkabi-ssh-receive-"));
        receivePath = join(receiveDirectory, basename(plan.localPath ?? "download"));
      }
      const args = plan.buildArgs(executable.path, stagedSource?.path ?? receivePath);
      input.log.append({
        kind: "effect",
        name: "ssh/transfer",
        payload: {
          op: plan.op,
          engine: plan.engine,
          targets: plan.targets,
          descriptor: plan.descriptor,
          timeout_seconds: plan.timeoutSeconds,
        },
      });
      let publicationVerified = false;
      let result: SshRunnerResult;
      try {
        result = await transferRunner({
          engine: plan.engine,
          executable: seal.path,
          args,
          env: hostEnv,
          signal,
          timeoutMs: plan.timeoutSeconds * 1_000,
        });
        if (downloading && result.state === "completed" && result.exitCode === 0) {
          signal?.throwIfAborted();
          if (!receivePath || !destinationAnchor || !plan.localPath) throw new Error("unverified download destination");
          const destination = resolvePath(destinationAnchor.path, relative(resolvePath(input.workspaceRoot), plan.localPath));
          const tree = request.op === "sync" || (request.op === "get" && request.recursive === true);
          if (tree) {
            const files = collectDownloadedTree(receivePath);
            publishAnchored(destination, files, new Set(), "directory", destinationAnchor);
          } else {
            const content = readSafeLocalFile(receivePath);
            if (content === undefined) throw new Error("unsafe downloaded file");
            publishAnchored(destination, new Map([["payload", content]]), new Set(), "replace-file", destinationAnchor);
          }
          publicationVerified = true;
        }
      } catch {
        result = emptyRunnerResult("spawn_failed", performance.now());
      } finally {
        stagedSource?.cleanup();
        if (receiveDirectory) rmSync(receiveDirectory, { recursive: true, force: true });
      }
      input.log.append({
        kind: "observe",
        name: "ssh/transfer_result",
        payload: {
          op: plan.op,
          engine: plan.engine,
          state: result.state,
          exit_code: result.exitCode ?? "missing",
          duration_ms: result.durationMs,
          ...(downloading ? { publication: publicationVerified ? "verified" : "unverified" } : {}),
        },
      });
      const output = safeSshOutput(result.stdout, result.stderr);
      const error = result.state !== "completed" || result.exitCode !== 0;
      return {
        error,
        text: [
          `ssh ${plan.op} engine=${plan.engine} state=${result.state} exit_code=${result.exitCode ?? "missing"}`,
          ...(downloading && !publicationVerified ? ["download publication is unverified; recursive/down-sync needs a new or empty destination"] : []),
          output,
        ].filter(Boolean).join("\n"),
      };
    },
    async enroll(request, signal) {
      if (disposed) return { error: true, text: "ssh state=unavailable reason=service_disposed" };
      if (!SSH_ALIAS.test(request.alias)) {
        return { error: true, text: "ssh enroll refused: alias must be a letter-led name (no dots, @, or spaces)" };
      }
      const parsed = parseAddress(request.address);
      if (!parsed) {
        return { error: true, text: "ssh enroll refused: address must be [user@]host[:port] with no shell characters" };
      }
      const home = hostEnv.HOME;
      if (!home) return { error: true, text: "ssh enroll refused: operator HOME is unknown" };
      // The operator confirms the coordinate in the popup (masked in the log);
      // the address itself never lands in the EventLog. Bypass auto-approves.
      const addressDigest = createHash("sha256").update(request.address).digest("hex");
      const approval = await requestApproval(request.alias, addressDigest, signal, { detail: `enroll → ${maskAddress(request.address)}` });
      if (approval === "not_interactive") {
        return { error: true, text: "ssh enroll needs operator approval: run in Dokkabi chat, or start with --permission-mode bypass" };
      }
      if (approval === "deny" || approval === "cancelled") {
        return { error: true, text: `ssh enroll ${approval === "deny" ? "denied" : "cancelled"} — alias not written` };
      }
      const result = enrollSshAlias({ alias: request.alias, address: request.address, configPath: join(home, ".ssh", "config") });
      input.log.append({
        kind: "observe",
        name: "ssh/enroll",
        payload: { alias: request.alias, status: result.ok ? (result.already ? "already" : "written") : "failed" },
      });
      if (!result.ok) {
        return { error: true, text: `ssh enroll failed: ${result.reason ?? "unknown"}` };
      }
      return {
        error: false,
        text: `ssh alias '${request.alias}' ${result.already ? "already configured" : "enrolled"} — now use op=exec target=${request.alias}`,
      };
    },
    setInteractiveApproval(enabled) {
      if (disposed) return;
      interactive = enabled;
      if (!enabled) resolvePending("cancelled", "interactive_closed");
    },
  };
}

const SSH_TRANSFER_OPTIONS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"] as const;

interface TransferPlan {
  readonly ok: true;
  readonly op: "put" | "get" | "copy" | "sync";
  readonly engine: "scp" | "rsync";
  readonly targets: readonly string[];
  readonly descriptor: string;
  readonly timeoutSeconds: number;
  readonly localPath?: string;
  /** Build the engine argv given the sealed OpenSSH path (the transport). */
  buildArgs(sshPath: string, localOverride?: string): string[];
}

/** Validate a transfer request and produce a sealed engine argv, or a typed
 * refusal. Local paths are confined to the workspace; aliases and remote
 * paths pass the alias, secret, and private-coordinate guards. */
function planTransfer(
  request: SshTransferRequest,
  workspaceRoot: string,
  engines: { scp?: SandboxHostExecutableSeal; rsync?: SandboxHostExecutableSeal },
): TransferPlan | { readonly ok: false; readonly reason: string } {
  const timeout = request.timeout ?? SSH_TIMEOUT_DEFAULT_SECONDS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > SSH_TIMEOUT_MAX_SECONDS) {
    return { ok: false, reason: "timeout_invalid" };
  }
  const timeoutSeconds = Math.round(timeout);
  const guardAlias = (alias: string): boolean => SSH_ALIAS.test(alias);
  const localAbs = (local: string): string | undefined => {
    if (typeof local !== "string" || local.length === 0 || local.includes("\0")) return undefined;
    const abs = resolvePath(workspaceRoot, local);
    const rel = relative(workspaceRoot, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return abs;
  };
  const guardRemote = (remote: string): boolean =>
    typeof remote === "string" && remote.length > 0 && !remote.includes("\0")
    && !containsSecretValue({ remote }) && !containsPrivateInfrastructureValue({ remote });

  if (request.op === "put" || request.op === "get") {
    if (!engines.scp) return { ok: false, reason: "engine_unavailable" };
    if (!guardAlias(request.target)) return { ok: false, reason: "target_must_be_operator_ssh_alias" };
    const abs = localAbs(request.local);
    if (abs === undefined) return { ok: false, reason: "local_outside_workspace" };
    if (!guardRemote(request.remote)) {
      return { ok: false, reason: guardPathReason(request.remote) };
    }
    const remoteSpec = `${request.target}:${request.remote}`;
    const recursive = request.recursive === true;
    const descriptor = request.op === "put" ? `${request.local} -> ${remoteSpec}` : `${remoteSpec} -> ${request.local}`;
    return {
      ok: true,
      op: request.op,
      engine: "scp",
      targets: [request.target],
      descriptor,
      timeoutSeconds,
      localPath: abs,
      buildArgs: (sshPath, localOverride) => [
        "-S", sshPath,
        ...SSH_TRANSFER_OPTIONS,
        "-p", "-q",
        ...(recursive ? ["-r"] : []),
        "--",
        ...(request.op === "put" ? [localOverride ?? abs, remoteSpec] : [remoteSpec, localOverride ?? abs]),
      ],
    };
  }

  if (request.op === "copy") {
    if (!engines.scp) return { ok: false, reason: "engine_unavailable" };
    if (!guardAlias(request.source_target) || !guardAlias(request.dest_target)) {
      return { ok: false, reason: "target_must_be_operator_ssh_alias" };
    }
    if (!guardRemote(request.source_remote)) return { ok: false, reason: guardPathReason(request.source_remote) };
    if (!guardRemote(request.dest_remote)) return { ok: false, reason: guardPathReason(request.dest_remote) };
    const src = `${request.source_target}:${request.source_remote}`;
    const dst = `${request.dest_target}:${request.dest_remote}`;
    const recursive = request.recursive === true;
    const targets = request.source_target === request.dest_target
      ? [request.source_target]
      : [request.source_target, request.dest_target];
    return {
      ok: true,
      op: "copy",
      engine: "scp",
      targets,
      descriptor: `${src} -> ${dst}`,
      timeoutSeconds,
      // -3 relays both hops through the host, so neither remote needs a route
      // to the other and both stay behind the sealed transport.
      buildArgs: (sshPath) => [
        "-3", "-S", sshPath,
        ...SSH_TRANSFER_OPTIONS,
        "-p", "-q",
        ...(recursive ? ["-r"] : []),
        "--",
        src, dst,
      ],
    };
  }

  // sync — and the exhaustiveness the two branches above leave implicit. Put
  // and get share `target`/`local`/`remote` with sync and declare `op` as a
  // union of its own, so eliminating them by their discriminant does not
  // narrow this tail; every field sync owns then reads as absent.
  if (request.op !== "sync") return { ok: false, reason: "unsupported_op" };
  if (!engines.rsync) return { ok: false, reason: "engine_unavailable" };
  if (!guardAlias(request.target)) return { ok: false, reason: "target_must_be_operator_ssh_alias" };
  const abs = localAbs(request.local);
  if (abs === undefined) return { ok: false, reason: "local_outside_workspace" };
  if (!guardRemote(request.remote)) return { ok: false, reason: guardPathReason(request.remote) };
  if (request.direction !== "up" && request.direction !== "down") {
    return { ok: false, reason: "direction_invalid" };
  }
  const remoteSpec = `${request.target}:${request.remote}`;
  const del = request.delete === true;
  const up = request.direction === "up";
  return {
    ok: true,
    op: "sync",
    engine: "rsync",
    targets: [request.target],
    descriptor: up ? `${request.local} => ${remoteSpec}` : `${remoteSpec} => ${request.local}`,
    timeoutSeconds,
    localPath: abs,
    buildArgs: (sshPath, localOverride) => [
      "-a",
      // Transfer path arguments through the rsync protocol, not the remote
      // shell. Unsupported legacy peers fail rather than retrying unsafely.
      "--protect-args",
      ...(del ? ["--delete"] : []),
      "-e", `${sshPath} ${SSH_TRANSFER_OPTIONS.join(" ")}`,
      "--",
      ...(up ? [abs, remoteSpec] : [remoteSpec, localOverride ?? abs]),
    ],
  };
}

function guardPathReason(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return "remote_path_invalid";
  if (containsSecretValue({ value })) return "protected_value";
  if (containsPrivateInfrastructureValue({ value })) return "private_coordinate";
  return "remote_path_invalid";
}

type RemotePutPreflightResult =
  | { readonly ok: true; readonly baseIdentity: string; readonly parentIdentity: string }
  | { readonly ok: false; readonly reason: "remote_destination_unsafe" | "remote_destination_unverified" | "remote_destination_cancelled" };

const REMOTE_PUT_ID_MARK = "__DOKKABI_PUT_IDS__";

const REMOTE_PUT_PREFLIGHT_SCRIPT = `import os
import stat
import sys

base = os.path.realpath(sys.argv[1])
destination = os.path.abspath(sys.argv[2])
parent = os.path.realpath(os.path.dirname(destination))
base_stat = os.stat(base, follow_symlinks=False)
parent_stat = os.stat(parent, follow_symlinks=False)
if not stat.S_ISDIR(base_stat.st_mode) or not stat.S_ISDIR(parent_stat.st_mode):
    raise RuntimeError("workspace is not a directory")
relative_parent = os.path.relpath(parent, base)
if relative_parent == ".." or relative_parent.startswith(".." + os.sep):
    raise RuntimeError("destination outside workspace")
try:
    existing = os.lstat(destination)
except FileNotFoundError:
    existing = None
if existing is not None and (stat.S_ISLNK(existing.st_mode) or stat.S_ISDIR(existing.st_mode) or existing.st_nlink != 1):
    raise RuntimeError("destination is not a replaceable regular file")
print("__DOKKABI_PUT_IDS__" + f"{base_stat.st_dev}:{base_stat.st_ino}:{parent_stat.st_dev}:{parent_stat.st_ino}")
`;

const REMOTE_ATOMIC_PUT_SCRIPT = `import base64
import os
import secrets
import stat
import sys

base = os.path.abspath(sys.argv[1])
destination_arg = os.path.abspath(sys.argv[2])
expected_base = sys.argv[3]
expected_parent = sys.argv[4]
destination = os.path.join(os.path.realpath(os.path.dirname(destination_arg)), os.path.basename(destination_arg))
def identity(value):
    return f"{value.st_dev}:{value.st_ino}"
base_stat = os.stat(base, follow_symlinks=False)
if identity(base_stat) != expected_base or not stat.S_ISDIR(base_stat.st_mode):
    raise RuntimeError("workspace identity changed")
parent = os.path.realpath(os.path.dirname(destination_arg))
parent_stat = os.stat(parent, follow_symlinks=False)
if identity(parent_stat) != expected_parent or not stat.S_ISDIR(parent_stat.st_mode):
    raise RuntimeError("destination parent identity changed")
base_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
parent_fd = None
temp_fd = None
temp_name = None
try:
    for component in [part for part in base.split(os.sep) if part]:
        next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd)
        os.close(base_fd)
        base_fd = next_fd
    if identity(os.fstat(base_fd)) != expected_base:
        raise RuntimeError("workspace identity changed")
    relative = os.path.relpath(destination, base)
    components = relative.split(os.sep)
    if relative in ("", ".") or any(part in ("", ".", "..") for part in components):
        raise RuntimeError("destination outside workspace")
    parent_fd = os.dup(base_fd)
    for component in components[:-1]:
        next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        os.close(parent_fd)
        parent_fd = next_fd
    if identity(os.fstat(parent_fd)) != expected_parent:
        raise RuntimeError("destination parent identity changed")
    name = components[-1]
    try:
        existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        existing = None
    if existing is not None and (stat.S_ISLNK(existing.st_mode) or stat.S_ISDIR(existing.st_mode) or existing.st_nlink != 1):
        raise RuntimeError("destination is not a replaceable regular file")
    for _ in range(16):
        candidate = ".dokkabi-put-" + secrets.token_hex(16)
        try:
            temp_fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
            temp_name = candidate
            break
        except FileExistsError:
            continue
    if temp_fd is None or temp_name is None:
        raise RuntimeError("temporary name exhausted")
    with os.fdopen(temp_fd, "wb") as output:
        temp_fd = None
        base64.decode(sys.stdin.buffer, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    temp_name = None
finally:
    if temp_fd is not None:
        os.close(temp_fd)
    if temp_name is not None and parent_fd is not None:
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
    if parent_fd is not None:
        os.close(parent_fd)
    os.close(base_fd)
`;

async function preflightRemotePut(input: {
  readonly target: string;
  readonly remote: string;
  readonly remoteWorkspace: string;
  readonly recursive: boolean;
  readonly runner: SshRunner;
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<RemotePutPreflightResult> {
  // A recursive put can traverse symlinks below the destination after this
  // check, so the safe, target-bound finalizer contract does not admit it.
  if (input.recursive) return { ok: false, reason: "remote_destination_unsafe" };
  const base = remotePathShellWord(input.remoteWorkspace);
  const destination = remotePathShellWord(input.remote);
  if (base === undefined || destination === undefined) {
    return { ok: false, reason: "remote_destination_unverified" };
  }
  const command = [
    "set -eu",
    `base=${base}`,
    `dest=${destination}`,
    `python3 -c ${shellQuoteRemote(REMOTE_PUT_PREFLIGHT_SCRIPT)} "$base" "$dest"`,
  ].join("; ");
  try {
    const result = await input.runner({
      command,
      env: input.env,
      executable: input.executable,
      signal: input.signal,
      target: input.target,
      timeoutMs: REMOTE_PUT_PREFLIGHT_TIMEOUT_MS,
    });
    if (input.signal?.aborted || result.state === "cancelled") {
      return { ok: false, reason: "remote_destination_cancelled" };
    }
    const identity = new RegExp(`^${REMOTE_PUT_ID_MARK}([0-9]+:[0-9]+):([0-9]+:[0-9]+)$`, "u").exec(result.stdout.trim());
    const baseIdentity = identity?.[1];
    const parentIdentity = identity?.[2];
    return result.state === "completed" && result.exitCode === 0 && baseIdentity !== undefined && parentIdentity !== undefined
      ? { ok: true, baseIdentity, parentIdentity }
      : { ok: false, reason: "remote_destination_unsafe" };
  } catch (error) {
    if (error instanceof Error) return { ok: false, reason: "remote_destination_unverified" };
    return { ok: false, reason: "remote_destination_unverified" };
  }
}

function readSafeLocalFile(path: string, workspaceRoot?: string): Buffer | undefined {
  if (workspaceRoot !== undefined && process.platform === "linux") {
    let anchor: WorkspacePathAnchor | undefined;
    let handle: ReturnType<WorkspacePathAnchor["openFile"]> | undefined;
    try {
      const relativePath = relative(resolvePath(workspaceRoot), path);
      if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
      anchor = new WorkspacePathAnchor(workspaceRoot);
      handle = anchor.openFile(relativePath);
      if (handle.info().size > REMOTE_ATOMIC_PUT_MAX_BYTES) return undefined;
      return Buffer.from(handle.read());
    } catch {
      return undefined;
    } finally {
      handle?.close();
      anchor?.close();
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > REMOTE_ATOMIC_PUT_MAX_BYTES) return undefined;
    if (workspaceRoot !== undefined) {
      const safePath = canonicalLocalFilePath(workspaceRoot, path);
      if (safePath === undefined) return undefined;
      const canonicalStat = statSync(safePath);
      if (canonicalStat.dev !== stat.dev || canonicalStat.ino !== stat.ino) return undefined;
    }
    return readFileSync(fd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function collectDownloadedTree(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let bytes = 0, entries = 0;
  const visit = (path: string, rel: string, depth: number) => {
    if (++entries > SSH_TRANSFER_MAX_ENTRIES || depth > SSH_TRANSFER_MAX_DEPTH) throw new Error("download tree limit");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("download tree contains a link");
    if (stat.isDirectory()) {
      const children = readdirSync(path);
      if (!children.length) throw new Error("empty download directories require explicit support");
      for (const name of children) visit(join(path, name), rel ? `${rel}/${name}` : name, depth + 1);
      return;
    }
    const content = readSafeLocalFile(path);
    if (!content || !rel || files.size >= SSH_TRANSFER_MAX_FILES || (bytes += content.length) > REMOTE_ATOMIC_PUT_MAX_BYTES) throw new Error("unsafe or oversized download tree");
    files.set(rel, content);
  };
  visit(root, "", 0);
  return files;
}

interface StagedLocalFile {
  readonly path: string;
  readonly cleanup: () => void;
}

function stageSafeLocalFile(path: string, workspaceRoot?: string): StagedLocalFile | undefined {
  const content = readSafeLocalFile(path, workspaceRoot);
  if (content === undefined) return undefined;
  let directory: string | undefined;
  let fd: number | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "dokkabi-ssh-put-"));
    const stagedPath = join(directory, "payload");
    fd = openSync(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content);
    closeSync(fd);
    fd = undefined;
    const stagedDirectory = directory;
    return {
      path: stagedPath,
      cleanup: () => {
        try {
          rmSync(stagedDirectory, { recursive: true, force: true });
        } catch {
          return;
        }
      },
    };
  } catch {
    if (fd !== undefined) closeSync(fd);
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function stageSafeLocalTree(path: string, workspaceRoot?: string): StagedLocalFile | undefined {
  if (workspaceRoot === undefined) return undefined;
  const sourceRoot = canonicalLocalDirectoryPath(workspaceRoot, path);
  if (sourceRoot === undefined) return undefined;
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "dokkabi-ssh-put-"));
    const stagedRoot = join(directory, basename(sourceRoot));
    const state = { bytes: 0, files: 0, entries: 0, depth: 0 };
    copySafeLocalTree(sourceRoot, stagedRoot, workspaceRoot, state);
    const stagedDirectory = directory;
    return {
      path: stagedRoot,
      cleanup: () => {
        try {
          rmSync(stagedDirectory, { recursive: true, force: true });
        } catch {
          return;
        }
      },
    };
  } catch {
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function copySafeLocalTree(
  source: string,
  destination: string,
  workspaceRoot: string,
  state: { bytes: number; files: number; entries: number; depth: number },
): void {
  state.entries += 1;
  if (state.entries > SSH_TRANSFER_MAX_ENTRIES || state.depth > SSH_TRANSFER_MAX_DEPTH) {
    throw new Error("recursive source exceeds the tree bounds");
  }
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) throw new Error("recursive source contains a symlink");
  if (entry.isDirectory()) {
    state.depth += 1;
    try {
      mkdirSync(destination, { mode: 0o700 });
      for (const name of readdirSync(source)) {
        if (name === "." || name === ".." || name.includes("\0")) throw new Error("invalid recursive source entry");
        copySafeLocalTree(join(source, name), join(destination, name), workspaceRoot, state);
      }
    } finally {
      state.depth -= 1;
    }
    return;
  }
  if (!entry.isFile() || entry.nlink !== 1) throw new Error("recursive source contains an unsafe file");
  state.files += 1;
  if (state.files > SSH_TRANSFER_MAX_FILES) throw new Error("recursive source has too many files");
  const content = readSafeLocalFile(source, workspaceRoot);
  if (content === undefined || state.bytes + content.byteLength > REMOTE_ATOMIC_PUT_MAX_BYTES) {
    throw new Error("recursive source is too large or unsafe");
  }
  state.bytes += content.byteLength;
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function canonicalLocalDirectoryPath(workspaceRoot: string, path: string): string | undefined {
  try {
    const lexicalRoot = resolvePath(workspaceRoot);
    const absolute = resolvePath(path);
    const relativePath = relative(lexicalRoot, absolute);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
    const canonicalRoot = realpathSync(lexicalRoot);
    const canonicalPath = realpathSync(absolute);
    const expectedPath = resolvePath(canonicalRoot, relativePath);
    const entry = lstatSync(absolute);
    if (canonicalPath !== expectedPath || !entry.isDirectory() || entry.isSymbolicLink()) return undefined;
    return absolute;
  } catch {
    return undefined;
  }
}

function canonicalLocalFilePath(workspaceRoot: string, path: string): string | undefined {
  try {
    const lexicalRoot = resolvePath(workspaceRoot);
    const absolute = resolvePath(path);
    const relativePath = relative(lexicalRoot, absolute);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
    const canonicalRoot = realpathSync(lexicalRoot);
    const canonicalPath = realpathSync(absolute);
    const expectedPath = resolvePath(canonicalRoot, relativePath);
    if (canonicalPath !== expectedPath) return undefined;
    const entry = lstatSync(absolute);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return undefined;
    return absolute;
  } catch {
    return undefined;
  }
}

async function runAtomicRemotePut(input: {
  readonly target: string;
  readonly remote: string;
  readonly remoteWorkspace: string;
  readonly baseIdentity: string;
  readonly parentIdentity: string;
  readonly content: Buffer;
  readonly runner: SshRunner;
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<SshRunnerResult> {
  const startedAt = performance.now();
  const base = remotePathShellWord(input.remoteWorkspace);
  const destination = remotePathShellWord(input.remote);
  if (base === undefined || destination === undefined) return emptyRunnerResult("spawn_failed", startedAt);
  const command = [
    "set -eu",
    `base=${base}`,
    `dest=${destination}`,
    'base_real=$(realpath -- "$base")',
    `python3 -c ${shellQuoteRemote(REMOTE_ATOMIC_PUT_SCRIPT)} "$base_real" "$dest" ${shellQuoteRemote(input.baseIdentity)} ${shellQuoteRemote(input.parentIdentity)}`,
  ].join("; ");
  try {
    return await input.runner({
      command,
      env: input.env,
      executable: input.executable,
      signal: input.signal,
      stdin: input.content.toString("base64"),
      target: input.target,
      timeoutMs: input.timeoutMs,
    });
  } catch {
    return emptyRunnerResult("spawn_failed", startedAt);
  }
}

function remotePathShellWord(value: string): string | undefined {
  if (value.length === 0 || /[\0\r\n]/u.test(value)) return undefined;
  if (value === "~" || value === "$HOME") return '"$HOME"';
  const homeSuffix = value.startsWith("~/")
    ? value.slice(2)
    : value.startsWith("$HOME/")
      ? value.slice("$HOME/".length)
      : undefined;
  if (homeSuffix !== undefined) {
    return `"$HOME/${escapeRemoteDoubleQuoted(homeSuffix)}"`;
  }
  if (!value.startsWith("/")) return undefined;
  return /^[A-Za-z0-9_./:+@=-]+$/u.test(value) ? value : shellQuoteRemote(value);
}

function escapeRemoteDoubleQuoted(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
}

function shellQuoteRemote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function runTransfer(input: SshTransferRunnerInput): Promise<SshRunnerResult> {
  const startedAt = performance.now();
  let child: ChildProcess;
  try {
    child = spawn(input.executable, [...input.args], {
      env: { ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return emptyRunnerResult("spawn_failed", startedAt);
  }
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let state: SshExecutionState = "completed";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const append = (stream: "stdout" | "stderr", chunk: unknown): void => {
    const bytes = Buffer.from(chunk as Uint8Array);
    if (stream === "stdout") stdoutBytes += bytes.length;
    else stderrBytes += bytes.length;
    const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const remaining = Math.max(0, SSH_OUTPUT_MAX_BYTES - used);
    if (remaining === 0) {
      truncated = true;
      return;
    }
    const text = bytes.subarray(0, remaining).toString("utf8");
    if (bytes.length > remaining) truncated = true;
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  const stop = (next: SshExecutionState): void => {
    if (state !== "completed") return;
    state = next;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    killTimer.unref?.();
  };
  const timer = setTimeout(() => stop("timed_out"), input.timeoutMs);
  const onAbort = () => stop("cancelled");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const exitCode = await new Promise<number | undefined>((resolve) => {
    child.once("error", () => {
      state = "spawn_failed";
      resolve(undefined);
    });
    child.once("close", (code) => resolve(typeof code === "number" ? code : undefined));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  input.signal?.removeEventListener("abort", onAbort);
  return {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    exitCode,
    state,
    stderr,
    stderrBytes,
    stdout,
    stdoutBytes,
    truncated,
  };
}

function waitToolResult(
  outcome: "matched" | "deadline" | "cancelled" | "stalled" | "process_exited",
  attempts: number,
  output: string,
  target: string,
): SshToolResult {
  const head = outcome === "process_exited"
    ? `ssh target=${target} state=wait_process_exited attempts=${attempts} — the process you named has exited and the pattern never appeared. `
      + `Read the output below: the job's own last lines say how it ended.`
    : outcome === "stalled"
    ? `ssh target=${target} state=wait_stalled attempts=${attempts} — the probe returned the same output for the whole stall window. `
      + `The job has most likely finished or died: check whether its process still exists and read the end of its log instead of waiting again.`
    : `ssh target=${target} state=wait_${outcome} attempts=${attempts}`;
  return {
    error: outcome !== "matched",
    text: [head, output].filter(Boolean).join("\n"),
  };
}

export function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    // NOT unref'd. Between two op=wait polls the remote child has exited and
    // the model request may be past its deadline, so this timer can be the
    // only thing left holding the runtime. Unreferenced, it let three runs
    // exit with code 0 mid-wait, abandoning a poll the harness had promised
    // to see through. The abort path below is what ends it early.
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseWaitRequest(
  input: Readonly<{ target: string; probe: string; until: string; interval?: number; deadline: number; pid?: number }>,
):
  | { readonly ok: true; readonly target: string; readonly command: string; readonly matcher: RegExp; readonly intervalMs: number; readonly deadlineMs: number; readonly pid?: number }
  | { readonly ok: false; readonly reason: string } {
  const pid = input.pid;
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31)) {
    return { ok: false, reason: "pid_invalid" };
  }
  // A wait that knows which process it watches ends when that process does,
  // instead of polling a finished job until its deadline (ssh-wait-liveness).
  const base = parseSshRequest({
    target: input.target,
    command: probeWithLiveness(input.probe, pid),
    timeout: SSH_WAIT_PROBE_TIMEOUT_SECONDS,
  });
  if (!base.ok) return { ok: false, reason: base.reason };
  if (typeof input.until !== "string" || input.until.length === 0 || input.until.length > 512) {
    return { ok: false, reason: "until_invalid" };
  }
  // A polling probe must SNAPSHOT state and return immediately. A probe that
  // waits on its own (a while-sleep spin, a bare sleep, `wait`) never returns
  // inside the per-poll timeout, so every attempt is killed and op=wait hangs
  // until its deadline while reporting nothing (observed live: an 8-minute
  // stall on `while pgrep -f job; do sleep 5; done; echo DONE`).
  if (/\b(while|until)\b[\s\S]*\bsleep\b/u.test(input.probe) || /^\s*sleep\b/u.test(input.probe) || /\bwait\s*$/u.test(input.probe)) {
    return { ok: false, reason: "probe_blocking" };
  }
  let matcher: RegExp;
  try {
    matcher = new RegExp(input.until, "m");
  } catch {
    return { ok: false, reason: "until_invalid" };
  }
  const deadlineMs = input.deadline;
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > SSH_WAIT_DEADLINE_MAX_MS) {
    return { ok: false, reason: "deadline_invalid" };
  }
  const intervalMs = input.interval ?? SSH_WAIT_INTERVAL_DEFAULT_MS;
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < SSH_WAIT_INTERVAL_MIN_MS || intervalMs > SSH_WAIT_INTERVAL_MAX_MS) {
    return { ok: false, reason: "interval_invalid" };
  }
  return {
    ok: true,
    target: base.target,
    command: base.command,
    matcher,
    intervalMs,
    deadlineMs,
    ...(pid === undefined ? {} : { pid }),
  };
}

function sshPublicState(result: SshRunnerResult): SshExecutionState | "alias_unresolved" {
  if (
    result.state === "completed"
    && result.exitCode === 255
    && /(?:^|\n)ssh:\s+Could not resolve hostname\s+/iu.test(result.stderr)
  ) {
    return "alias_unresolved";
  }
  return result.state;
}

function parseSshRequest(input: Readonly<{ target: string; command: string; script?: string; timeout?: number }> = { target: "", command: "" }):
  | { readonly ok: true; readonly target: string; readonly command: string; readonly script?: string; readonly timeout: number }
  | { readonly ok: false; readonly reason: string } {
  const target = input.target?.trim();
  // A script travels on stdin so quoting never touches it; without an explicit
  // interpreter it lands in bash -s.
  const script = input.script;
  const command = input.command?.trim() || (script !== undefined ? "bash -s" : "");
  if (!SSH_ALIAS.test(target)) return { ok: false, reason: "target_must_be_operator_ssh_alias" };
  if (!command || command.includes("\0") || Buffer.byteLength(command) > SSH_COMMAND_MAX_BYTES) {
    return { ok: false, reason: "command_invalid" };
  }
  if (script !== undefined && (script.includes("\0") || script.length === 0 || Buffer.byteLength(script) > SSH_SCRIPT_MAX_BYTES)) {
    return { ok: false, reason: "script_invalid" };
  }
  if (containsSecretValue({ target, command, script })) return { ok: false, reason: "protected_value" };
  if (containsPrivateInfrastructureValue({ target, command, script })) return { ok: false, reason: "private_coordinate" };
  const timeout = input.timeout ?? SSH_TIMEOUT_DEFAULT_SECONDS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > SSH_TIMEOUT_MAX_SECONDS) {
    return { ok: false, reason: "timeout_invalid" };
  }
  return { ok: true, target, command, ...(script === undefined ? {} : { script }), timeout: Math.round(timeout) };
}

function approvedRequestDigest(input: Readonly<{
  target: string;
  command: string;
  script?: string;
  timeout: number;
}>): string {
  return createHash("sha256")
    .update(input.target).update("\0")
    .update(input.command).update("\0")
    .update(input.script ?? "").update("\0")
    .update(String(input.timeout))
    .digest("hex");
}

function sshHostEnvironment(env: NodeJS.Dict<string>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
  };
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SSH_AUTH_SOCK"] as const) {
    const value = env[key];
    if (value && value.length <= 4096 && !value.includes("\0") && !value.includes("\n")) out[key] = value;
  }
  return Object.freeze(out);
}

export function selectServiceSshConfigPath(input: Readonly<{
  serviceHome?: string;
  osAccountHome: string;
  registeredConfigPath?: string;
}>): string | undefined {
  if (!input.serviceHome || !input.registeredConfigPath) return undefined;
  return resolvePath(input.serviceHome) === resolvePath(input.osAccountHome) ? undefined : input.registeredConfigPath;
}

/** Split a probe's combined stdout at its marker. A missing marker means the
 * far end never reached the second command, so only the first answer is real. */
export function splitAtMark(stdout: string, mark: string): [string, string] {
  const tail = (rest: string): string => (rest.startsWith("\n") ? rest.slice(1) : rest);
  const at = stdout.lastIndexOf(`\n${mark}`);
  if (at >= 0) return [stdout.slice(0, at), tail(stdout.slice(at + 1 + mark.length))];
  if (stdout.startsWith(mark)) return ["", tail(stdout.slice(mark.length))];
  return [stdout, ""];
}

function safeSshOutput(stdout: string, stderr: string): string {
  // A remote workspace lives under /home/<user>/, so that prefix is on nearly
  // every line the host prints. Withholding the whole body for it left the
  // model blind to commands that had actually succeeded — normalize the
  // account name away first, then withhold only for a real coordinate.
  const joined = normalizeHomePaths(
    redactText([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")),
  );
  if (containsPrivateInfrastructure(joined)) {
    return "[private infrastructure output withheld]";
  }
  return joined;
}

/**
 * The sealed connection argv for one remote command.
 *
 * ConnectTimeout only bounds reaching the host. Once a call is connected the
 * only thing that ends it is the remote command finishing or the harness's own
 * timeout expiring — so a link that dies mid-call (a tunnel dropping, a route
 * changing under a long-running job) is indistinguishable from work in
 * progress, and the call sits there until its full budget is spent. One run's
 * longest exec ran 279 seconds; the default budget is 120 and the ceiling 600,
 * all of which a dead link can consume while saying nothing.
 *
 * Keepalives put a bound on that: the client asks the server to speak every 15
 * seconds and gives up after three unanswered, so a broken link surfaces in
 * about 45 seconds as a failed call rather than as a call that looks busy.
 * They ride the protocol rather than the channel, so a command that is
 * genuinely working in silence is never disturbed.
 *
 * Exported so the options that decide how the harness reaches a host can be
 * asserted directly rather than inferred from a spawn.
 */
export function sshConnectionArgs(input: {
  readonly command: string;
  readonly target: string;
  readonly timeoutMs: number;
}): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ConnectTimeout=${Math.max(1, Math.min(15, Math.ceil(input.timeoutMs / 1_000)))}`,
    "-o", "ConnectionAttempts=1",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", `ServerAliveInterval=${SSH_KEEPALIVE_INTERVAL_SECONDS}`,
    "-o", `ServerAliveCountMax=${SSH_KEEPALIVE_COUNT_MAX}`,
    "--",
    input.target,
    input.command,
  ];
}

async function runSsh(input: SshRunnerInput, configPath?: string): Promise<SshRunnerResult> {
  const startedAt = performance.now();
  let child: ChildProcess;
  try {
    const args = configPath ? ["-F", configPath, ...sshConnectionArgs(input)] : sshConnectionArgs(input);
    child = spawn(input.executable, args, {
      env: { ...input.env },
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return emptyRunnerResult("spawn_failed", startedAt);
  }
  if (input.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin);
  }
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let state: SshExecutionState = "completed";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const append = (stream: "stdout" | "stderr", chunk: unknown): void => {
    const bytes = Buffer.from(chunk as Uint8Array);
    if (stream === "stdout") stdoutBytes += bytes.length;
    else stderrBytes += bytes.length;
    const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const remaining = Math.max(0, SSH_OUTPUT_MAX_BYTES - used);
    if (remaining === 0) {
      truncated = true;
      return;
    }
    const text = bytes.subarray(0, remaining).toString("utf8");
    if (bytes.length > remaining) truncated = true;
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  const stop = (next: SshExecutionState): void => {
    if (state !== "completed") return;
    state = next;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    killTimer.unref?.();
  };
  const timer = setTimeout(() => stop("timed_out"), input.timeoutMs);
  const onAbort = () => stop("cancelled");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const exitCode = await new Promise<number | undefined>((resolve) => {
    child.once("error", () => {
      state = "spawn_failed";
      resolve(undefined);
    });
    child.once("close", (code) => resolve(typeof code === "number" ? code : undefined));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  input.signal?.removeEventListener("abort", onAbort);
  return {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    exitCode,
    state,
    stderr,
    stderrBytes,
    stdout,
    stdoutBytes,
    truncated,
  };
}

function emptyRunnerResult(state: "spawn_failed", startedAt: number): SshRunnerResult {
  return {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    state,
    stderr: "",
    stderrBytes: 0,
    stdout: "",
    stdoutBytes: 0,
    truncated: false,
  };
}
