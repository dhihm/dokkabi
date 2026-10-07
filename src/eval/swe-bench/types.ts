import type { FixtureClosure } from "../../work/evidence/fixture-manifest.ts";

/**
 * SWE-bench-shaped types for the Dokkabi adapter.
 *
 * Not a leaderboard client. docs/non-goals.md forbids declaring victory.
 * Field names follow the public dataset so JSONL drops load without renaming.
 */

/** One SWE-bench row (fields the adapter actually uses). */
export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** FAIL_TO_PASS test list (JSON string or string[] depending on dump). */
  FAIL_TO_PASS: string | string[];
  PASS_TO_PASS?: string | string[];
  /** Tests that must be applied at base so fail-to-pass exists. */
  test_patch?: string;
  version?: string;
  /** Gold patch — never auto-applied for scoring. */
  patch?: string;
}

export type SweBenchSplit = "lite" | "verified" | "full" | "custom";

export interface SweBenchLoadOptions {
  path: string;
  split?: SweBenchSplit;
  only?: string[];
  limit?: number;
}

export interface SweBenchRunRequest {
  /** Host-prepared research attempt. Independent evaluator artifacts remain
   * outside the model's workspace and environment. */
  research?: {
    home: import("../experiment/environment.ts").ResearchAttemptHome;
    controlRoot: string;
    attempt: import("../experiment/runner.ts").ResearchAttemptIdentity;
    phaseRoot: string;
    runtime: string;
  };
  instance: SweBenchInstance;
  /** Absolute workspace for the repo checkout. */
  workspace: string;
  sessionId: string;
  /** Dokkabi home (sessions/logs). Defaults to workspace/.dokkabi-home */
  dokkabiHome?: string;
  /** Complete host-declared official checker closure. Required for official scoring.
   * Paths refer to the base checkout; test_patch is applied only in private staging. */
  checkerClosure?: Omit<FixtureClosure, "id" | "workspace" | "sourceRoot" | "visibility" | "commands">;
  /** Cap work steps (passed to dokkabi work --max-steps). */
  maxSteps?: number;
  /** Run typed candidate → reviewer swarm instead of one work session. */
  swarm?: boolean;
  /** Legacy local-environment option. Official image scoring fails closed
   * on collection errors and does not open an envfix model session. */
  envfix?: boolean;
  /** Legacy local-environment round limit; unused by official image scoring. */
  envfixRounds?: number;
  /** Enable HEUNG on the work invocation. Default true. */
  crunch?: boolean;
  /** Skip the model and only prepare + baseline tests. */
  prepareOnly?: boolean;
  /** Legacy local argv override. Official image scoring refuses overrides. */
  pytestArgs?: string[];
  /** Python used for pip install -e . during prepare. Default python3. */
  pythonBin?: string;
  /** Extra pip packages after editable install (e.g. Werkzeug&lt;3 for old Flask). */
  extraPip?: string[];
  /** Timeout ms for the work child. Default 20 minutes. */
  workTimeoutMs?: number;
  /** LLM route for the work child (dokkabi work --route). */
  route?: string;
  /** Model id for the work child (dokkabi work --model). */
  modelId?: string;
  /** Sampling temperature for the work child (monkeymode diversity, #59).
   * Rides DOKKABI_TEMPERATURE into that child only — envfix stays default. */
  temperature?: number;
  /** Timeout ms for pytest. Default 10 minutes. */
  testTimeoutMs?: number;
}

export interface SweBenchTestReport {
  status?: "scored" | "evaluator_error";
  error?: string;
  preparation_ref?: string;
  /** Child return retained when later integrity or cleanup revokes the score. */
  execution?: { exit_code: number; output: string; passed: boolean; signal?: string; error?: string; raw_exit_code?: number | null; timed_out?: boolean; max_buffer_exceeded?: boolean; completion_unavailable?: boolean };
  /** Exit code of the pytest (or runner) process. */
  exit_code: number;
  /** Tests requested. */
  tests: string[];
  /** Truncated stdout+stderr. */
  output: string;
  /** true when exit_code === 0. */
  passed: boolean;
}

/**
 * Outcome of one adapter run — audit fields, not a leaderboard row.
 */
export interface SweBenchRunResult {
  research_process?: import("../experiment/runner.ts").ResearchProcessResult;
  instance_id: string;
  status?: "scored" | "evaluator_error";
  evaluator_log_path?: string;
  prepared: boolean;
  /** fail-to-pass before the agent (should usually fail). */
  baseline?: SweBenchTestReport;
  planned: boolean;
  completed: boolean;
  /** An envfix work graph ran before this baseline (collection repair). */
  envfix_attempted?: boolean;
  /** fail-to-pass after the agent. */
  after?: SweBenchTestReport;
  /** pass-to-pass regression suite after the agent (official scoring). */
  p2p?: SweBenchTestReport;
  /** f2p green AND p2p regression-free (when the row has a p2p list) */
  resolved: boolean;
  log_path?: string;
  plan_stats?: string;
  work_exit?: number;
  error?: string;
}

export interface SweBenchAdapter {
  load(options: SweBenchLoadOptions): SweBenchInstance[];
  prepare(request: SweBenchRunRequest): Promise<{ ok: boolean; error?: string; commit?: string }>;
  run(request: SweBenchRunRequest): Promise<SweBenchRunResult>;
}
