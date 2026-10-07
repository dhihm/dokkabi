import type { CoEditRule } from "./coedit.ts";

export const SPECULATIVE_RULES_SCHEMA = "dokkabi-speculative-rules-v1" as const;

export interface SpeculativeTransition {
  readonly previous_tool: string;
  readonly previous_error: boolean;
  readonly previous_exit_code: number | null;
  readonly next_tool: string;
  readonly count: number;
  readonly total: number;
  readonly probability_ppm: number;
}

export interface SpeculativeRules {
  readonly schema: typeof SPECULATIVE_RULES_SCHEMA;
  readonly trajectories: number;
  readonly samples: number;
  readonly transitions: readonly SpeculativeTransition[];
  readonly co_edits: readonly CoEditRule[];
}

export class SpeculativeRulesError extends Error {
  readonly code = "speculative_rules" as const;
}
