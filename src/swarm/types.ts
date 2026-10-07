import type { SwarmChildStatus, SwarmStatus } from "./events.ts";
import type { SwarmCandidateRole, SwarmRole } from "./routes.ts";
import type { SwarmWorldSpec } from "./world.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SwarmRunRequest {
  readonly order: string;
  readonly candidates?: readonly SwarmCandidateRole[];
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly effort?: ThinkingLevel;
  readonly world: SwarmWorldSpec;
  readonly signal?: AbortSignal;
  /** Role → named-route overrides from a 돗가비 장터 recipe (#60). Roles
   * not named keep the ambient env/default map. Never a model id. */
  readonly routes?: Readonly<Partial<Record<SwarmRole, string>>>;
  /** The sealed recipe this run executes under. Its digest binds every
   * child dispatch contract; the body never reaches a child (#60 T1). */
  readonly recipe?: { readonly id: string; readonly digest: string };
}

export interface SwarmChildReport {
  readonly role: SwarmRole;
  readonly route: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly status: SwarmChildStatus;
  readonly replayDigest: string | "missing";
  readonly finalHash: string | "missing";
  readonly dispatchDigest: string;
  readonly resultEnvelopeDigest: string;
}

export interface SwarmRunResult {
  readonly parentSessionId: string;
  readonly status: SwarmStatus;
  readonly children: readonly SwarmChildReport[];
  readonly finalized: boolean;
  readonly patchDigest: string | "missing";
}

export interface SwarmService {
  run(request: SwarmRunRequest): Promise<SwarmRunResult>;
}
