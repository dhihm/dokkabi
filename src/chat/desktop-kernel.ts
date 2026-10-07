import type { OwnedWorkResourceRegistry } from "../loader/types.ts";
import type { CodeObserverState } from "../code-evolution/observer-state.ts";
import type { BranchCheckpointService } from "../host/branch-checkpoint.ts";
import { BranchDecisionService } from "../host/branch-decision.ts";
import { DesktopBranchRuntime } from "./desktop-branch-runtime.ts";
import type { ContextGraphService } from "../context-graph/service.ts";
import { retainSealedProviderPrefix } from "../host/checkpoint-input-import.ts";
import { join, resolve } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import type { SessionLease } from "../host/session-lease.ts";
import { bootSession } from "../boot.ts";
import { acquireSessionLease } from "../host/session-lease.ts";
import { recordRun } from "../host/run-registry.ts";
import { readConfig, resolveLlmSelection } from "../host/config.ts";
import {
  PERMISSION_MODE_ENV,
  permissionModeFromEvents,
  resolvePermissionMode,
  type PermissionMode,
} from "../host/permissions.ts";
import { parseThinkingLevel, resolveThinkingLevel } from "../host/thinking.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveInteractiveTurnBudget } from "../host/stream-stall.ts";
import { freshStartArchive, restoreArchivedTranscript } from "../host/session-resume.ts";
import { agentTranscriptPath } from "../host/agent-transcript.ts";
import { announceRouteReadiness } from "./route-readiness.ts";
import { redactText } from "../host/redact.ts";
import { createChatFrontend, type NoteDelivery } from "./frontend.ts";
import { createChatTurnRouter, startHeungWork, startRalphPlanWork } from "./heung-work.ts";
import { createSessionWorkModeService, type SessionWorkModeService } from "./work-mode.ts";
import { createSessionContinuityNotice } from "./session-context-notice.ts";
import { selectLiveModel, type LiveModelSelectionResult } from "./model-control.ts";
import { resolveHeung } from "../work/heung.ts";
import { hostedModelCatalogs } from "../plugins/model-catalog.ts";
import { createHostedModels } from "../plugins/hosted-models.ts";
import { buildModelPickerCandidates, type ModelPickerRoute } from "./model-picker.ts";
import { readModelPreferences } from "../host/model-preferences.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";
import type { SshService } from "../host/ssh.ts";
import type { GithubAdminService } from "../host/github-admin.ts";
import type { McpService } from "../host/mcp.ts";
import type { ManagedPluginService } from "../host/managed-plugin.ts";
import type { PermissionController } from "../host/permissions.ts";
import type { LlmFacade, LoopFacade } from "../loader/types.ts";

/**
 * The embedded chat kernel for the desktop gateway: the same wiring
 * `dokkabi chat` builds, with the web console where the TUI board would be.
 *
 * The kernel is a chat FRONTEND (the #37 seam), not a bypass: notes go
 * through the frontend's submit path, turns run through the loop, and every
 * turn's content reaches the window only as EventLog surface events. The
 * interactive lease is the same one the TUI takes, so a terminal chat and
 * the desktop window exclude each other honestly.
 */
export interface DesktopChatKernel {
  readonly sessionId: string;
  submitNote(text: string, commandId?: string): NoteDelivery;
  /**
   * Abort the in-flight turn without popping a staged inbox note. The R2
   * workbench cancellation path: cancelling one command must not consume the
   * operator's separately staged note the way the interactive `abort` does.
   */
  abortActive(): boolean;
  abort(): { aborted: boolean; restored?: string };
  busy(): boolean;
  modelCandidates(): {
    routes: string[];
    details: ReturnType<typeof buildModelPickerCandidates>;
  };
  /** Answers with a line, or with the confirmation a large carry needs first;
   * desktop-server.ts tests for exactly that before rendering. */
  setModel(choice: string): Promise<LiveModelSelectionResult>;
  setEffort(level?: string): string;
  routeStatus(): Promise<{ route: string; model?: string; ready: boolean; reason?: string }>;
  /**
   * The permission mode currently in force for this kernel's session (the
   * R2 workbench handshake reads it): the live controller mode, falling back
   * to the session's recorded permission rows. Honest report, no probing.
   */
  permissionMode(): PermissionMode;
  /** The live model identity of THIS kernel's llm facade — route, provider
   * id and model id, with no provider request or readiness probe. Host-only
   * trusted material for the R8-05 child dispatch guard. */
  currentModelSelection(): { route: string; provider: string; model: string } | undefined;
  /** Optional harness-owned restoration capability; no live fork authority. */
  checkpointService?(): BranchCheckpointService | undefined;
  /** Optional host-only durable decision capability (R8-04 plugin). */
  decisionService?(): BranchDecisionService | undefined;
  /** Optional host-only runnable branch runtime capability (R8-05 plugin).
   * Disposed or absent kernels answer undefined. */
  branchRuntime?(): DesktopBranchRuntime | undefined;
  /** Optional host-only session work-mode capability (R8-06j2): explicit
   * Default/Chat/Work selection for this kernel's own session, persisted
   * through the session control file and evidenced in the session EventLog.
   * Disposed or absent kernels answer undefined. */
  workModeService?(): SessionWorkModeService | undefined;
  codeObserverService?(): {
    status(): CodeObserverState;
    resume(input: unknown): { commandId: string; seq: number; hash: string };
  } | undefined;
  dispose(): Promise<void>;
}

/** The sealed boot material a trusted host branch bootstrap receives: the
 * live session log, the actual current system prompt/tool schemas and the
 * plugin manifest digest the boot sealed, plus the registered host-only
 * ContextGraph service when the plugin is on. This is host authority, never
 * renderer input. */
export interface DesktopKernelBranchMaterial {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly toolSchemas: unknown[];
  readonly pluginManifestDigest: string;
  contextGraphService(): ContextGraphService | undefined;
}

/** External observers for workbench-correlated turn lifecycle (R2). */
export interface DesktopKernelTurnLifecycle {
  onTurnStarted?(commandId: string): void;
  onTurnAccepted?(commandId: string): void;
  onTurnSettled?(commandId: string, outcome: "success" | "failure" | "operator_abort"): void;
}

export async function openDesktopChatKernel(input: {
  sessionId: string;
  /** Sessions home (the parent of the sessions directory). */
  home: string;
  workspaceRoot: string;
  repoRoot: string;
  manifestPath: string;
  resume?: boolean;
  /** Workbench turn lifecycle observers; each fires after its durable record. */
  turnLifecycle?: DesktopKernelTurnLifecycle;
  /** Trusted host-only branch bootstrap (R8-05): runs after the boot sealed
   * the actual current material and BEFORE the frontend exists, so the
   * authenticated checkpoint input/lesson import lands inside the sealed
   * boundary with no first request possible. A refusal disposes the boot
   * and releases the lease. Never supplied from wire input. */
  branchBootstrap?: (material: DesktopKernelBranchMaterial) => void | Promise<void>;
  /** Trusted host boot configuration (R8-05): pins this kernel's model
   * selection to a recorded policy instead of the standing operator
   * selection — the branch child boot path. Never supplied from wire
   * input; a mismatched pin is refused by the caller before exposure. */
  modelSelection?: { route: string; model?: string };
}): Promise<DesktopChatKernel> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const sessionDirectory = join(input.home, "sessions", input.sessionId);
  let effort: ThinkingLevel = resolveThinkingLevel();
  // The standing operator policy (environment, then the config file) — the
  // same resolution an interactive `dokkabi chat` boots with, so this
  // session's controller holds the operator's actual mode and source instead
  // of a silent default. An invalid standing value fails loudly BEFORE any
  // resource is taken.
  const bootPermissions = resolvePermissionMode({
    env: process.env[PERMISSION_MODE_ENV],
    configured: readConfig().permissions?.default_mode,
  });
  // One interactive owner per session: a second chat — TUI or desktop —
  // would interleave two agents into one log and transcript. The lease is
  // released on EVERY failed path below: a boot that dies must not poison
  // the session for the next attempt in the same process.
  const lease: SessionLease = acquireSessionLease(sessionDirectory);
  let runtime: Awaited<ReturnType<typeof bootSession>>["runtime"] | undefined;
  let checkpointSettled: (() => boolean) | undefined;
  try {
    recordRun({ home: input.home, session: input.sessionId, label: "desktop-chat" });
    const booted = await bootSession({
      sessionId: input.sessionId,
      workspaceRoot,
      manifestPath: input.manifestPath,
      repoRoot: input.repoRoot,
      home: input.home,
      permissionMode: bootPermissions.mode,
      permissionSource: bootPermissions.source,
      checkpointBoundary: { isSettled: () => checkpointSettled?.() === true },
      branchRuntimeBoundary: {
        home: input.home,
        repoRoot: input.repoRoot,
        manifestPath: input.manifestPath,
        storageRoot: join(input.home, "branches"),
      },
    });
    runtime = booted.runtime;
    const pluginRuntime = booted.runtime;
    const { ctx, digest } = booted;
    if (!ctx.llm || !ctx.loop) {
      throw new Error("loop or llm missing after load");
    }
    // The fresh-start contract, identical to a plain `dokkabi chat` start:
    // no prior context unless the operator asked to resume.
    if (input.resume) {
      restoreArchivedTranscript(agentTranscriptPath(ctx.log.path), ctx.log);
    } else {
      freshStartArchive({ log: ctx.log, transcriptPath: agentTranscriptPath(ctx.log.path) });
    }
    // Retain the current host-owned sealed bytes before exposing optional
    // checkpoint settlement. This cannot complete older historical images.
    if (ctx.tryGet<BranchCheckpointService>("workspace_checkpoints")) {
      retainSealedProviderPrefix(ctx.log, { systemPrompt: ctx.systemPrompt, tools: ctx.toolSchemas });
    }
    // The trusted branch bootstrap: after the seal, before the frontend. A
    // refusal propagates to the catch below, which disposes the partially
    // initialized runtime and releases the lease — a failed child boot never
    // poisons the session for the next attempt.
    if (input.branchBootstrap) {
      await input.branchBootstrap({
        log: ctx.log,
        sessionId: input.sessionId,
        systemPrompt: ctx.systemPrompt,
        toolSchemas: ctx.toolSchemas,
        pluginManifestDigest: digest,
        contextGraphService: () => ctx.tryGet<ContextGraphService>("context_graph_service"),
      });
    }
    const selection = input.modelSelection ?? resolveLlmSelection();
    ctx.llm.select(selection.route, selection.model);
    const loop: LoopFacade = ctx.loop;
    const llm: LlmFacade = ctx.llm;
    const log: EventLog = ctx.log;
    announceRouteReadiness(llm, log);
    const resilience = ctx.tryGet<ModelResilienceService>("model_resilience");
    const ssh = ctx.tryGet<SshService>("ssh");
    const githubAdmin = ctx.tryGet<GithubAdminService>("github_admin");
    const mcp = ctx.tryGet<McpService>("mcp");
    const pluginInstaller = ctx.tryGet<ManagedPluginService>("plugin_installer");
    const permissions = ctx.tryGet<PermissionController>("permissions");
    resilience?.setManualPrimary({
      route: llm.activeName,
      model: llm.activeModelId ?? llm.active().defaultModelId() ?? "missing",
    });
    resilience?.setInteractiveApproval(true);
    ssh?.setInteractiveApproval(true);
    githubAdmin?.setInteractiveApproval(true);
    mcp?.setInteractiveApproval(true);
    pluginInstaller?.setInteractiveApproval(true);

    const savedConfig = readConfig();
    // The standing work default resolved once: the router's fallback AND the
    // work-mode service's Default effective mode are the same truth.
    const standingWorkDefault = resolveHeung({
      config: savedConfig.heung,
      legacyConfig: savedConfig.crunchmode,
    });
    let abortWork: (() => void) | undefined;
    const continuity = createSessionContinuityNotice({ ctx, llm, pluginManifestDigest: digest });
    const cliPath = join(input.repoRoot, "src", "cli.ts");
    const turnRouter = createChatTurnRouter({
      sessionDir: sessionDirectory,
      defaultEnabled: standingWorkDefault,
      startChat: async (text, onAccepted) => loop.prompt(await continuity.fold(text), {
        modelId: llm.activeModelId,
        thinkingLevel: effort,
        onAccepted,
        origin: "operator",
        ...resolveInteractiveTurnBudget(),
      }),
      startWork: (text, onAccepted) => {
        const run = startHeungWork({
          sessionId: input.sessionId,
          workspaceRoot,
          route: llm.activeName,
          ...(llm.activeModelId ? { model: llm.activeModelId } : {}),
          effort,
          text,
          cliPath,
          permissionMode: permissions?.current() ?? "ask",
          resources: ctx.tryGet<OwnedWorkResourceRegistry>("owned_work_resources"),
        }, onAccepted);
        const abort = () => run.abort();
        abortWork = abort;
        return run.done.finally(() => {
          if (abortWork === abort) abortWork = undefined;
        });
      },
      startRalphPlan: (text, onAccepted) => {
        const run = startRalphPlanWork({
          sessionId: input.sessionId,
          workspaceRoot,
          route: llm.activeName,
          ...(llm.activeModelId ? { model: llm.activeModelId } : {}),
          effort,
          text,
          cliPath,
          permissionMode: permissions?.current() ?? "ask",
          resources: ctx.tryGet<OwnedWorkResourceRegistry>("owned_work_resources"),
        }, onAccepted);
        const abort = () => run.abort();
        abortWork = abort;
        return run.done.finally(() => {
          if (abortWork === abort) abortWork = undefined;
        });
      },
      abortChat: () => {
        abortWork?.();
        loop.abort();
      },
    });
    // The explicit session work-mode capability (R8-06j2): the same session
    // control file the router reads, evidenced in this session's own log.
    const workMode = createSessionWorkModeService({
      sessionDir: sessionDirectory,
      log,
      standingDefault: standingWorkDefault,
    });
    // Workbench correlation (R2): turn start, model-facing acceptance and
    // settlement land in the SESSION log as observe rows carrying the submit
    // command id, before any external observer hears about them. Rows are
    // only written for tracked submits; ordinary CLI notes are unchanged.
    const externalLifecycle = input.turnLifecycle;
    const recordTrackedTurn = (name: string, payload: Record<string, unknown>): void => {
      log.appendDurable({ kind: "observe", name, payload });
    };
    const frontend = createChatFrontend({
      sessionDir: sessionDirectory,
      startTurn: turnRouter.startTurn,
      abortTurn: () => turnRouter.abort(),
      onError: (error) => {
        process.stderr.write(
          `desktop chat turn failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
      onTurnStart: ({ commandId, text }) => {
        if (!commandId) return;
        recordTrackedTurn("chat/turn_started", {
          command_id: commandId,
          text_bytes: Buffer.byteLength(text, "utf8"),
        });
        externalLifecycle?.onTurnStarted?.(commandId);
      },
      onTurnAccepted: ({ commandId, message }) => {
        if (!commandId) return;
        // The acceptance observer fires after the model-facing user/message
        // is durable and before route readiness. An owned work child records
        // that input in ANOTHER process, so its verified row reference is
        // passed explicitly through the seam — this kernel's in-memory log is
        // never scanned for a cross-process row. Ordinary same-process turns
        // still resolve the row through this session's own single writer.
        let ref = message;
        if (!ref) {
          for (let i = log.events.length - 1; i >= 0; i -= 1) {
            const event = log.events[i]!;
            if (event.name === "user/message") {
              ref = { seq: event.seq, hash: event.hash };
              break;
            }
          }
        }
        recordTrackedTurn("chat/turn_accepted", {
          command_id: commandId,
          ...(ref ? { message_seq: ref.seq, message_hash: ref.hash } : {}),
        });
        externalLifecycle?.onTurnAccepted?.(commandId);
      },
      onTurnSettled: ({ commandId, outcome, error }) => {
        if (!commandId) return;
        recordTrackedTurn("chat/turn_settled", {
          command_id: commandId,
          outcome,
          ...(error !== undefined
            ? { error: redactText(error instanceof Error ? error.message : String(error)).slice(0, 200) }
            : {}),
        });
        externalLifecycle?.onTurnSettled?.(commandId, outcome);
      },
    });

    let disposed = false;
    checkpointSettled = () => !disposed && !frontend.busy();
    return {
      sessionId: input.sessionId,
      checkpointService() {
        return disposed ? undefined : ctx.tryGet<BranchCheckpointService>("workspace_checkpoints");
      },
      decisionService() {
        // A defined-but-unavailable capability answers as the definition
        // record; only the real service instance is a runnable capability.
        if (disposed) return undefined;
        const service = ctx.tryGet<BranchDecisionService>("branch_decisions");
        return service instanceof BranchDecisionService ? service : undefined;
      },
      branchRuntime() {
        if (disposed) return undefined;
        const runtime = ctx.tryGet<DesktopBranchRuntime>("branch_runtime");
        return runtime instanceof DesktopBranchRuntime ? runtime : undefined;
      },
      workModeService() {
        return disposed ? undefined : workMode;
      },
      codeObserverService() {
        return disposed ? undefined : ctx.tryGet<{
          status(): CodeObserverState;
          resume(input: unknown): { commandId: string; seq: number; hash: string };
        }>("code_evolution_observer");
      },
      submitNote(text: string, commandId?: string): NoteDelivery {
        return frontend.submitNote(text, commandId === undefined ? undefined : { commandId });
      },
      abortActive() {
        return frontend.abortTurn();
      },
      abort() {
        const aborted = frontend.abortTurn();
        const restored = frontend.popQueuedNote();
        return restored === undefined ? { aborted } : { aborted, restored };
      },
      busy() {
        return frontend.busy();
      },
      modelCandidates() {
        const routes: ModelPickerRoute[] = [...llm.routes.entries()]
          .filter(([name]) => name !== "replay")
          .map(([name, route]) => ({
            name,
            provider: route.providerId,
            defaultModel: route.defaultModelId(),
          }));
        const details = buildModelPickerCandidates({
          routes,
          catalogs: hostedModelCatalogs(createHostedModels()),
          selection: {
            route: llm.activeName,
            model: llm.activeModelId ?? llm.active().defaultModelId(),
          },
          preferences: readModelPreferences(),
        });
        return {
          routes: details.filter((detail) => detail.kind === "route").map((detail) => detail.value),
          details,
        };
      },
      // May answer with a handoff confirmation rather than a line;
      // desktop-server.ts tests for exactly that before rendering.
      async setModel(choice: string): Promise<LiveModelSelectionResult> {
        return selectLiveModel({ choice, llm, loop, resilience });
      },
      setEffort(level?: string): string {
        if (level !== undefined) effort = parseThinkingLevel(level);
        return `effort=${effort}`;
      },
      async routeStatus() {
        const routeName = llm.activeName;
        const model = llm.activeModelId ?? llm.active().defaultModelId();
        const route = llm.routes.get(routeName);
        if (!route) {
          return { route: routeName, ...(model ? { model } : {}), ready: false, reason: "route missing" };
        }
        const check = await route.ready();
        return {
          route: routeName,
          ...(model ? { model } : {}),
          ready: check.ok,
          ...(check.ok ? {} : { reason: check.reason }),
        };
      },
      permissionMode() {
        // The live controller mode; without the controller plugin the
        // session's own recorded permission rows are the honest source.
        return permissions?.current() ?? permissionModeFromEvents(log.events);
      },
      currentModelSelection() {
        if (disposed) return undefined;
        const route = llm.activeName;
        const model = llm.activeModelId ?? llm.active().defaultModelId();
        const provider = llm.routes.get(route)?.providerId;
        if (typeof model !== "string" || model.length === 0
          || typeof provider !== "string" || provider.length === 0) {
          return undefined;
        }
        return { route, provider, model };
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        frontend.stop();
        try {
          resilience?.setInteractiveApproval(false);
          githubAdmin?.setInteractiveApproval(false);
          ssh?.setInteractiveApproval(false);
          mcp?.setInteractiveApproval(false);
          pluginInstaller?.setInteractiveApproval(false);
          await pluginRuntime.dispose();
        } finally {
          lease.release();
        }
      },
    };
  } catch (error) {
    // The boot failed at some point after the lease was taken: dispose the
    // partially initialized runtime when there is one, and always release
    // the lease so the same session can retry immediately.
    try {
      await runtime?.dispose();
    } finally {
      lease.release();
    }
    throw error;
  }
}
