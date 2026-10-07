import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExactCallProvider } from "../exact-cache-types.ts";

export const TIER1_PROVIDER_NAMES = [
  "read",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "probe_log",
] as const;

export type Tier1ProviderName = (typeof TIER1_PROVIDER_NAMES)[number];

export const TIER1_PROBE_RECIPES = {
  python_byte_count: {
    runtime: "python",
    script: "import sys\nprint(len(sys.stdin.buffer.read()))",
  },
  bun_byte_count: {
    runtime: "bun",
    script: "const chunks=[];for await(const chunk of Bun.stdin.stream())chunks.push(chunk);console.log(Buffer.concat(chunks).byteLength)",
  },
} as const;

export interface Tier1ExecutionAuthority {
  readonly executablePath: string;
  readonly environmentDigest: string;
  readonly validate: () => boolean;
}

export interface Tier1ProviderLimits {
  readonly maxFiles?: number;
  readonly maxDependencyBytes?: number;
  readonly maxValidateMs?: number;
}

export interface Tier1ProviderOptions {
  readonly workspaceRoot: string;
  readonly tools: readonly AgentTool[];
  readonly limits?: Tier1ProviderLimits;
  readonly gitAuthority?: Tier1ExecutionAuthority;
  readonly probeAuthority?: Tier1ExecutionAuthority & { readonly runtime: "python" | "bun" };
}

export type Tier1Providers = Readonly<Partial<Record<
  Tier1ProviderName,
  ExactCallProvider<AgentToolResult<unknown>>
>>>;
