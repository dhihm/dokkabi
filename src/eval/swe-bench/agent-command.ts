import { join } from "node:path";
import type { EventRecord } from "../../host/schema.ts";
import type { ResearchAttemptHome } from "../experiment/environment.ts";
import { researchContains } from "../experiment/environment.ts";
import type { ToolProfileName } from "../../loader/tool-profiles.ts";

export interface SweAgentCommandInput {
  readonly repoRoot: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly order: string;
  readonly maxSteps: number;
  readonly workTimeoutMs: number;
  readonly crunch: boolean;
  readonly swarm: boolean;
  readonly officialImage?: string;
  readonly route?: string;
  readonly modelId?: string;
  readonly loop?: "graph" | "model";
  readonly planner?: "host" | "model" | "ledger";
  /** The session's tool profile (D39); omitted leaves the unflagged default. */
  readonly toolProfile?: ToolProfileName;
}

/** Research launch supplies the entire environment, never a partial overlay
 * on the operator's HOME. The registered guard checks resolved request bytes. */
export function buildSweResearchAgentCommand(input: SweAgentCommandInput, home: ResearchAttemptHome, runtime: string): SweAgentCommand {
  const selectionMismatch = input.swarm ? Boolean(input.route || input.modelId)
    : !input.route || !input.modelId || input.route !== home.environment.DOKKABI_ROUTE || input.modelId !== home.environment.DOKKABI_MODEL;
  if (input.workspace !== home.workspace || selectionMismatch
    || home.environment.DOKKABI_HOME !== home.dokkabiHome || home.environment.HOME !== home.home
    || !home.environment.DOKKABI_RESEARCH_POLICY || !home.environment.DOKKABI_RESEARCH_POLICY_SHA256
    || researchContains(home.workspace, home.dokkabiHome)) throw new Error("SWE research launch lacks its isolated input binding");
  const command = buildSweAgentCommand(input);
  return { argv: [runtime, ...command.argv.slice(1)], env: { ...home.environment, ...command.env } };
}

export interface SweAgentCommand {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function buildSweAgentCommand(input: SweAgentCommandInput): SweAgentCommand {
  const cli = join(input.repoRoot, "src", "cli.ts");
  if (input.swarm) {
    if (input.route || input.modelId) {
      throw new Error("SWE swarm uses typed role routes; --route and --model apply only to single-agent runs");
    }
    const childTimeoutMs = Math.max(1_000, Math.floor(input.workTimeoutMs / 2));
    return {
      argv: [
        "bun", cli, "swarm",
        "--max-steps", String(input.maxSteps),
        "--timeout-ms", String(childTimeoutMs),
        "--session", input.sessionId,
        "--workspace", input.workspace,
        ...(input.officialImage ? ["--world", "docker"] : []),
        input.order,
      ],
      env: input.officialImage ? { DOKKABI_SWARM_DOCKER_IMAGE: input.officialImage } : {},
    };
  }
  return {
    argv: [
      "bun", cli, "work",
      "--decision", "work",
      // The planner is always named: an arm that names none is a host arm,
      // and the CLI's own default is the ledger (D43).
      "--planner", input.planner ?? "host",
      ...(input.crunch ? ["--heung"] : []),
      // The graph loop stays the unflagged default; only the model loop is named.
      ...(input.loop === "model" ? ["--loop", "model"] : []),
      // The full installed surface stays the unflagged default; only a session
      // asked to run under a closed profile names one.
      ...(input.toolProfile ? ["--tool-profile", input.toolProfile] : []),
      "--max-steps", String(input.maxSteps),
      "--session", input.sessionId,
      "--workspace", input.workspace,
      ...(input.route ? ["--route", input.route] : []),
      ...(input.modelId ? ["--model", input.modelId] : []),
      input.order,
    ],
    env: {},
  };
}

export function reviewerSessionFrom(events: readonly EventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.name === "swarm/child_close" &&
      event.payload.role === "reviewer" &&
      event.payload.status === "completed" &&
      typeof event.payload.child_session === "string"
    ) {
      return event.payload.child_session;
    }
  }
  return undefined;
}
