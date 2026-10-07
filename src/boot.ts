import { dirname, join, resolve } from "node:path";
import { EventLog } from "./host/event-log.ts";
import { recoverInterruptedCompaction } from "./host/compaction-transaction.ts";
import { agentTranscriptPath } from "./host/agent-transcript.ts";
import { sessionLogPath } from "./host/paths.ts";
import { HostContextImpl } from "./loader/context.ts";
import { loadPlugins, preparePlugins } from "./loader/loader.ts";
import { effectiveManifestPath, profileManifestPath } from "./host/execution-profile.ts";
import { PrepareUnavailable, type BootPreparation, type PluginRuntime } from "./loader/types.ts";
import { recordHostOwnedExposure } from "./host/host-owned.ts";
import { resolveWorkspaceRoot } from "./host/paths.ts";
import { type ExecutionProfileName } from "./host/execution-profile.ts";
import { createWorkFacade } from "./work/host.ts";
import { loadSystemPrompt } from "./work/load.ts";
import { sessionSandboxEnvironment } from "./host/sandbox.ts";
import { toolchainRoots } from "./host/sandbox-toolchain.ts";
import {
  environmentFactsFromPayload,
  environmentProbeErrorClass,
  HOST_ENVIRONMENT_EVENT,
  HOST_ENVIRONMENT_PROMPT_ORDER,
  HOST_ENVIRONMENT_PROMPT_OWNER,
  probeEnvironmentFacts,
  renderEnvironmentFacts,
} from "./host/environment-facts.ts";
import {
  createPermissionController,
  type PermissionMode,
  type PermissionModeSource,
} from "./host/permissions.ts";

export function defaultSystemPrompt(repoRoot: string): string {
  return loadSystemPrompt(repoRoot);
}

import { inspectCaTrust } from "./host/sandbox-ca.ts";
import { scanPromptPacks } from "./host/prompt-pack.ts";

/**
 * Everything a boot is asked to do, resolved (#230 round 5, B0). `dokkabi
 * work` and `dokkabi doctor` build it with the same resolver
 * (resolveBootRequest); `bootSession` prepares then commits it.
 */
export interface BootRequest {
  sessionId: string;
  workspaceRoot: string;
  manifestPath: string;
  repoRoot?: string;
  systemPrompt?: string;
  /** Observers (dash) boot read-only: no seal, sample, or plan append ever
   * reaches the observed session log. */
  readOnly?: boolean;
  /** Session-scoped approval mode. Bypass never becomes a saved default. */
  permissionMode?: PermissionMode;
  permissionSource?: PermissionModeSource;
  /** Environment the operator's prompt packs are read from; defaults to the
   * process environment. Injected by tests. */
  env?: NodeJS.Dict<string>;
  /** Environment-facts probe override; defaults to the filesystem probe in
   * host/environment-facts.ts. Injected by tests to exercise the failure
   * path, which a real workspace cannot reach: an unreadable root already
   * fails ctx construction before the probe runs. */
  probeEnvironmentFacts?: typeof probeEnvironmentFacts;
  /** Sessions home override (the parent of the sessions directory). The
   * desktop gateway hosts chat kernels under its own configured home so a
   * test gateway never touches the operator's real sessions. */
  home?: string;
  /** Trusted host observation; no renderer-supplied checkpoint readiness. */
  checkpointBoundary?: { readonly isSettled: () => boolean };
  /** Trusted desktop-only branch runtime boundary (R8-05): the host
   * coordinates the optional branch-runtime plugin consumes to build a
   * runnable DesktopBranchRuntime. Only the desktop host supplies it; a
   * non-desktop boot exposes no runnable branch capability. Never wire
   * input. */
  branchRuntimeBoundary?: {
    readonly home: string;
    readonly repoRoot: string;
    readonly manifestPath: string;
    readonly storageRoot: string;
  };
}

export type BootResult = { ctx: HostContextImpl; digest: string; loaded: readonly string[]; log: EventLog; runtime: PluginRuntime };

/** A prepared boot: the request and the prepare phase's verdict. */
export interface PreparedBoot {
  readonly request: BootRequest;
  readonly verdict: BootPreparation;
}

/**
 * The one resolver of a boot request from the operator's inputs: the profile
 * (itself from `resolveWorkExecution` or `--profile`), `--workspace`, the
 * environment (DOKKABI_WORKSPACE, DOKKABI_HOME, the experiment and research
 * switches) and the working directory. `dokkabi work` boots what this
 * returns; `dokkabi doctor` prepares the same.
 */
export function resolveBootRequest(input: {
  readonly profile: ExecutionProfileName;
  readonly sessionId: string;
  readonly repoRoot: string;
  readonly workspace?: string;
  readonly env?: NodeJS.Dict<string>;
  readonly cwd?: string;
  readonly systemPrompt?: string;
  readonly permissionMode?: PermissionMode;
  readonly permissionSource?: PermissionModeSource;
}): BootRequest {
  const env = input.env ?? process.env;
  return {
    sessionId: input.sessionId,
    workspaceRoot: resolveWorkspaceRoot(input.workspace, env, input.cwd ?? process.cwd()),
    manifestPath: profileManifestPath(input.repoRoot, input.profile, env),
    repoRoot: input.repoRoot,
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.permissionSource !== undefined ? { permissionSource: input.permissionSource } : {}),
    env,
  };
}

/**
 * The boot, both phases. Observers (read-only) only commit: they refuse
 * nothing. Every other boot is prepared first — the prepare phase is where
 * every refusal is made — then committed. A commit that refuses after an
 * admitting prepare is a plugin contract violation (register may not refuse);
 * a prepare refusal stands even if a commit would not have refused.
 */
export async function bootSession(input: BootRequest): Promise<BootResult> {
  if (input.readOnly) return commitBoot(input);
  const prepared = await prepareBoot(input);
  const result = await commitBoot(prepared.request);
  if (prepared.verdict.status === "refused") {
    await result.runtime.dispose();
    throw prepared.verdict.cause ?? new Error("the boot's prepare phase refused");
  }
  return result;
}

/** A session log that refuses every append: the prepare phase records nothing. */
class PrepareLog extends EventLog {
  override appendTelemetry(): void {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
  override append(): never {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
  override appendDurable(): never {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
  override appendDurableToolCall(): never {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
  override appendBatch(): never {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
  override appendBatchDurable(): never {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
  override appendProjectedBatchDurable(): never {
    throw new PrepareUnavailable("the prepare phase cannot append");
  }
}

/**
 * The boot's prepare phase (#230 round 5, B0): the manifest swap, the loader
 * and every plugin's `activate` and `preflight`, in the context the commit
 * would have — the request's workspace, and the session's own log read as it
 * is (never created, never appended). No side effect: `dokkabi doctor`'s
 * verdict is this call.
 */
export async function prepareBoot(request: BootRequest): Promise<PreparedBoot> {
  let manifestPath: string;
  try {
    manifestPath = effectiveManifestPath(request.manifestPath, request.env ?? process.env);
  } catch (error) {
    return { request, verdict: { status: "refused", stage: "manifest", plugins: new Map(), cause: error } };
  }
  const logPath = request.home
    ? join(request.home, "sessions", request.sessionId, "events.jsonl")
    : sessionLogPath(request.sessionId);
  const log = new PrepareLog(logPath, { readOnly: false });
  const ctx = new HostContextImpl({ log, sessionId: request.sessionId, workspaceRoot: resolve(request.workspaceRoot), systemPrompt: "" });
  if (request.checkpointBoundary) {
    ctx.define("workspace_checkpoint_boundary", { authority: "host", lifetime: "session" });
    ctx.provide("workspace_checkpoint_boundary", request.checkpointBoundary);
  }
  if (request.branchRuntimeBoundary) {
    ctx.define("desktop_branch_runtime_boundary", { authority: "host", lifetime: "session" });
    ctx.provide("desktop_branch_runtime_boundary", request.branchRuntimeBoundary);
  }
  return { request, verdict: await preparePlugins({ ctx, manifestPath }) };
}

/** The boot's commit phase: the session log, the host context, the facts and
 * prompt packs, and the plugins registered — the side effects. */
export async function commitBoot(input: BootRequest): Promise<BootResult> {
  const repoRoot = input.repoRoot ?? resolve(input.manifestPath, "..", "..");
  const logPath = input.home
    ? join(input.home, "sessions", input.sessionId, "events.jsonl")
    : sessionLogPath(input.sessionId);
  const log = input.readOnly
    ? new EventLog(logPath, { readOnly: true })
    : EventLog.create(logPath);
  // A session whose workspace contains the doctor's key directory (resolved
  // by the one installation-config function) exposes the key from its first
  // moment, whether or not it ever opens a fence (#230 round 5, K1').
  if (!input.readOnly) recordHostOwnedExposure([resolve(input.workspaceRoot)]);
  const ctx = new HostContextImpl({
    log,
    sessionId: input.sessionId,
    workspaceRoot: resolve(input.workspaceRoot),
    systemPrompt: input.systemPrompt ?? loadSystemPrompt(repoRoot),
  });
  if (input.checkpointBoundary && !input.readOnly) {
    ctx.define("workspace_checkpoint_boundary", { authority: "host", lifetime: "session" });
    ctx.provide("workspace_checkpoint_boundary", input.checkpointBoundary);
  }
  if (input.branchRuntimeBoundary && !input.readOnly) {
    ctx.define("desktop_branch_runtime_boundary", { authority: "host", lifetime: "session" });
    ctx.provide("desktop_branch_runtime_boundary", input.branchRuntimeBoundary);
  }
  ctx.define("work", { key: "work" });
  ctx.provide("work", createWorkFacade());
  ctx.define("permissions", { authority: "operator", lifetime: "session", sandbox: "enforced" });
  ctx.provide("permissions", createPermissionController({
    log,
    mode: input.permissionMode ?? "auto",
    source: input.permissionSource ?? "default",
  }));
  // The execution-environment facts (host/environment-facts.ts) are registered
  // BEFORE the plugins load for the same reason as the prompt packs below:
  // loading is what seals the model-facing surface, and a contribution added
  // after that seal leaves the surface dirty. The probe runs once per session
  // log and reads the filesystem only; a boot that finds the recorded row
  // (resume, replay) re-renders from it instead of re-probing, so the sealed
  // prefix is reproduced even when the machine changed between runs.
  publishEnvironmentFacts(ctx, input.probeEnvironmentFacts ?? probeEnvironmentFacts);
  // Domain instruction the operator keeps outside this repository, contributed
  // exactly the way a plugin's prompt is. Registered BEFORE the plugins load,
  // because loading is what seals the model-facing surface: a contribution
  // added after that seal leaves the surface dirty and the next turn refuses
  // to run at all (loader/context.ts requireSealedBeforeModel). Packs still
  // land last in the projection — their order carries that, not their timing
  // (host/prompt-pack.ts).
  const packs = scanPromptPacks(input.env ?? process.env);
  for (const pack of packs.packs) {
    ctx.registerPromptContribution(`pack:${pack.id}`, pack.order, pack.text);
    log.append({
      kind: "observe",
      name: "prompt/pack",
      payload: { id: pack.id, order: pack.order, digest: pack.digest, chars: pack.text.length },
    });
  }
  for (const problem of packs.problems) {
    // A pack the operator meant to load and that did not load must never be
    // silent: the model would run without instruction nobody knows is missing.
    log.append({
      kind: "observe",
      name: "prompt/pack_refused",
      payload: { reason: problem.reason },
    });
    process.stderr.write(`prompt pack skipped: ${problem.reason}\n`);
  }
  // A broken trust store fails as a network problem and says nothing. Read it
  // once so a run about to fail every HTTPS call knows why (host/sandbox-ca.ts).
  const trust = inspectCaTrust();
  if (trust.problems.length > 0) {
    log.append({
      kind: "observe",
      name: "host/ca_trust",
      payload: {
        ...(trust.bundle ? { bundle: trust.bundle } : {}),
        certificates: trust.certificates,
        ...(trust.truncatedAt === undefined ? {} : { truncated_at: trust.truncatedAt }),
        unconverted_der: trust.unconvertedDer.length,
        problems: trust.problems,
      },
    });
    for (const problem of trust.problems) process.stderr.write(`ca trust: ${problem}\n`);
  }
  const result = await loadPlugins({ ctx, manifestPath: effectiveManifestPath(input.manifestPath) });
  try {
    if (!input.readOnly) {
      const recovery = recoverInterruptedCompaction({
        transcriptPath: agentTranscriptPath(ctx.log.path),
        log: ctx.log,
      });
      if (recovery.needsSeal) {
        ctx.sealIfNeeded("compaction");
      }
    }
    return { ctx, digest: result.digest, loaded: result.loaded, log, runtime: result.runtime };
  } catch (error) {
    await result.runtime.dispose();
    throw error;
  }
}

export function defaultManifestPath(repoRoot: string): string {
  return profileManifestPath(repoRoot, "default");
}

/**
 * Publish the session's execution-environment facts: one observe row plus one
 * prompt contribution (docs/event-log.md). A session log that already carries
 * the row is never re-probed — the recorded payload is the only authority for
 * what the sealed prefix contains, so a resume reproduces the prefix
 * byte-for-byte. An error or unreadable row registers nothing, exactly what
 * the boot that wrote it projected. A probe failure records the bounded error
 * class and registers nothing: the model boots without the section rather
 * than not at all.
 */
function publishEnvironmentFacts(
  ctx: HostContextImpl,
  probe: typeof probeEnvironmentFacts,
): void {
  const recorded = [...ctx.log.events].reverse().find((event) => event.name === HOST_ENVIRONMENT_EVENT);
  if (recorded) {
    const facts = environmentFactsFromPayload(recorded.payload);
    if (facts !== undefined) {
      ctx.registerPromptContribution(
        HOST_ENVIRONMENT_PROMPT_OWNER,
        HOST_ENVIRONMENT_PROMPT_ORDER,
        renderEnvironmentFacts(facts),
      );
    }
    return;
  }
  try {
    const environment = sessionSandboxEnvironment({ workspaceRoot: ctx.workspaceRoot });
    const facts = probe({
      workspaceRoot: ctx.workspaceRoot,
      sandboxPath: environment.PATH ?? "",
      platform: process.platform,
      arch: process.arch,
      shell: environment.SHELL ?? "/bin/bash",
      // The read-only roots the session's sandbox exposes, from the one
      // construction that decides them (the knob's deny answer is []); the
      // browser scan reads the Playwright cache layout under them (D38).
      toolchainRoots: toolchainRoots({ workspaceRoot: ctx.workspaceRoot }),
    });
    ctx.log.append({ kind: "observe", name: HOST_ENVIRONMENT_EVENT, payload: { ...facts } });
    ctx.registerPromptContribution(
      HOST_ENVIRONMENT_PROMPT_OWNER,
      HOST_ENVIRONMENT_PROMPT_ORDER,
      renderEnvironmentFacts(facts),
    );
  } catch (error) {
    try {
      ctx.log.append({
        kind: "observe",
        name: HOST_ENVIRONMENT_EVENT,
        payload: { error: environmentProbeErrorClass(error) },
      });
    } catch {
      // A failed append is already constitution 1's refuse-to-request signal;
      // it must not take the boot down with it.
    }
  }
}
