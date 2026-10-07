import type {
  HostContext,
  PluginModule,
  RequestContextContributionRegistry,
  WorkCheckpointContributionRegistry,
  OwnedWorkResourceRegistry,
} from "../loader/types.ts";
import { observerPaths, readCodeObserverState } from "../code-evolution/observer-state.ts";
import { EventLog } from "../host/event-log.ts";
import type { VersionResult } from "../host/code-evolution-versions.ts";
import type { WorkspaceCheckpointBoundary } from "./workspace-checkpoints.ts";
export const CODE_EVOLUTION_OBSERVER = "code_evolution_observer";
export const CAPTURE_PATHS_ENV = "DOKKABI_CODE_EVOLUTION_CAPTURE_PATHS";
export const IDLE_OBSERVER_ENV = "DOKKABI_CODE_EVOLUTION_IDLE";
export const plugin: PluginModule = {
  id: "code-evolution-observer",
  claims: [
    { key: CODE_EVOLUTION_OBSERVER, role: "definition" },
    { key: CODE_EVOLUTION_OBSERVER, role: "provider" },
    { key: "code_evolution_versions", role: "consumer" },
    { key: "request_context_contributions", role: "consumer" },
    { key: "work_checkpoint_contributions", role: "consumer" },
    { key: "workspace_checkpoint_boundary", role: "consumer", optional: true },
    { key: "owned_work_resources", role: "consumer", optional: true },
  ],
  activate() {
    const text = process.env[CAPTURE_PATHS_ENV];
    if (text === undefined || text === "")
      return {
        active: false,
        kind: "not_configured",
        reason: "Automatic Code capture has no selected paths",
      };
    try {
      observerPaths.parse(JSON.parse(text));
      if (process.env.DOKKABI_CODE_EVOLUTION_VERSIONS !== "1") throw new Error("versions disabled");
      const idle = process.env[IDLE_OBSERVER_ENV];
      if (idle !== undefined && idle !== "" && idle !== "0" && idle !== "1") throw new Error("invalid idle mode");
    } catch {
      return {
        active: false,
        kind: "invalid_configuration",
        reason: "Automatic Code capture requires enabled versions and distinct safe selected paths",
      };
    }
    return { active: true };
  },
  async register(ctx: HostContext) {
    const { CodeEvolutionObserver } = await import("../host/code-evolution-observer.ts");
    const paths = observerPaths.parse(JSON.parse(process.env[CAPTURE_PATHS_ENV]!));
    const versions = ctx.inject<{
      capture(input: unknown): VersionResult;
      read(input: unknown): VersionResult;
    }>("code_evolution_versions");
    const requests = ctx.inject<RequestContextContributionRegistry>(
      "request_context_contributions",
    );
    const checkpoints = ctx.inject<WorkCheckpointContributionRegistry>(
      "work_checkpoint_contributions",
    );
    const boundary = ctx.tryGet<WorkspaceCheckpointBoundary>("workspace_checkpoint_boundary");
    const resources = ctx.tryGet<OwnedWorkResourceRegistry>("owned_work_resources");
    const idleRequested = process.env[IDLE_OBSERVER_ENV] === "1";
    const idleAvailable = idleRequested && !!boundary && !!resources && !ctx.log.isReadOnly;
    const observer = new CodeEvolutionObserver({
      log: ctx.log,
      sessionId: ctx.sessionId,
      workspaceRoot: ctx.workspaceRoot,
      paths,
      versions,
      ...(idleAvailable ? { idle: { isSettled: () => boundary!.isSettled() } } : {}),
    });
    ctx.define(CODE_EVOLUTION_OBSERVER, {
      visibility: "host_only",
      format: 1,
      modelFacing: false,
      mode: idleAvailable ? "selected_path_idle_poll" : "selected_path_boundary_observation",
      ...(idleRequested ? { idleAvailability: idleAvailable ? "available" : "unavailable",
        idleReason: idleAvailable ? null : "trusted settled boundary and owned resource enrollment required" } : {}),
    });
    ctx.provide(
      CODE_EVOLUTION_OBSERVER,
      Object.freeze({
        status: () =>
          readCodeObserverState(
            new EventLog(ctx.log.path, { readOnly: true }).events,
            ctx.sessionId,
            ctx.workspaceRoot,
          ),
        resume: (input: unknown) => {
          if (!boundary || !boundary.isSettled()) throw new Error("Code observer control requires an owned settled host");
          return observer.resume(input);
        },
      }),
    );
    ctx.effect(() => {
      const stopRequest = requests.register(plugin.id, {
        mode: "shadow",
        prepare(input) {
          observer.check(input.boundary);
          return { action: "none" };
        },
      });
      const stopCheckpoint = checkpoints.register(plugin.id, (input) =>
        observer.check(input.reason),
      );
      const stopResource = idleAvailable ? resources!.register(plugin.id, {
        suspend: () => observer.suspend(), resume: () => observer.resumeWatcher(),
      }) : undefined;
      if (idleAvailable) observer.startWatcher();
      else if (idleRequested) observer.markWatcherUnavailable();
      return () => {
        stopResource?.();
        stopRequest();
        stopCheckpoint();
        observer.dispose();
      };
    });
  },
};
