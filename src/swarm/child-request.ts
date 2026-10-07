import type { RunDokkabiChildInput } from "./child-process.ts";
import {
  swarmChildEnvironment,
  type SwarmChildCapabilityBinding,
  type SwarmChildMemoryBinding,
  type SwarmChildPrivateHome,
  type SwarmChildRouteAuthority,
} from "./child-environment.ts";
import type { SwarmAssignment } from "./routes.ts";

export interface ChildRunRequest {
  readonly repoRoot: string;
  readonly request: { readonly order: string; readonly maxSteps: number; readonly timeoutMs: number };
  // The assignment as routes.ts defines it, not a narrower copy of it. The
  // copy dropped `model`, which is how freeswarm pins a specific free model
  // per role: the value was passed and read at runtime while the type said it
  // could not exist.
  readonly assignment: Readonly<SwarmAssignment>;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly parentOpenSeq: number;
  readonly parentSessionId: string;
  readonly dispatchDigest: string;
  readonly signal: AbortSignal;
  readonly planPath?: string;
  readonly deferAcceptance?: boolean;
  readonly privateHome: SwarmChildPrivateHome;
  readonly runtimeEnv: Readonly<Record<string, string | undefined>>;
  readonly routeAuthority?: SwarmChildRouteAuthority;
  readonly worldEnv?: Readonly<Record<string, string | undefined>>;
  readonly memoryBinding: SwarmChildMemoryBinding;
  readonly capabilityBinding: SwarmChildCapabilityBinding;
}

export function childRunInput(input: ChildRunRequest): RunDokkabiChildInput {
  return {
    repoRoot: input.repoRoot,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    route: input.assignment.route,
    order: input.request.order,
    maxSteps: input.request.maxSteps,
    timeoutMs: input.request.timeoutMs,
    ...(input.planPath ? { planPath: input.planPath } : {}),
    ...(input.deferAcceptance ? { deferAcceptance: true } : {}),
    signal: input.signal,
    env: swarmChildEnvironment({
      route: input.assignment.route,
      ...(input.assignment.model ? { model: input.assignment.model } : {}),
      privateHome: input.privateHome,
      runtimeEnv: input.runtimeEnv,
      ...(input.routeAuthority ? { routeAuthority: input.routeAuthority } : {}),
      ...(input.worldEnv ? { worldEnv: input.worldEnv } : {}),
      memoryBinding: input.memoryBinding,
      capabilityBinding: input.capabilityBinding,
      parentSessionId: input.parentSessionId,
      parentOpenSeq: input.parentOpenSeq,
      role: input.assignment.role,
      dispatchDigest: input.dispatchDigest,
    }),
  };
}
