import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { comparatorArmSchema, executeComparatorAttempt } from "./comparator-runner.ts";
import { durableResearchFile, prepareResearchHome, researchHash, researchRead, type ResearchAttemptHome } from "./environment.ts";
import { registerScheduledResearchAttempt } from "./runner.ts";
import { reconcileComparatorCredential } from "./comparator-credentials.ts";
import { sha256Schema } from "./schema.ts";

/**
 * One dispatched comparator attempt: the spec schema and the executor that
 * scripts/run-harness-comparison.ts is the CLI of.
 *
 * The script owned both until a second caller appeared — the verified-work
 * chain (scripts/run-verified-work.ts, D37), which runs the same executor
 * once per stage and composes each stage's spec from the previous stage's
 * workspace. The schema and the execution are the same bytes they were; the
 * script keeps its argument handling, its error text and the exact line it
 * prints, and passes that print through `onSummary` so it still happens where
 * it always did — inside the try, before the credential is reconciled.
 */

const file = z.strictObject({ path: z.string(), sha256: sha256Schema, executable: z.boolean().optional() });
export const specSchema = z.strictObject({ schema_version: z.literal(1), study: z.string(), scheduled_key: sha256Schema,
  ordinal: z.number().int().positive(), source_root: z.string(), files: z.array(file).min(1), prompt: file,
  arm: comparatorArmSchema, git: z.string(), timeout_ms: z.number().int().positive().max(86400000),
  runtime: z.string(), variables: z.record(z.string(), z.string()).default({}),
  credential_file: z.string().optional(), credential_provider: z.string().optional(),
  initialize_git: z.boolean().default(true) });

export type ComparisonSpec = z.infer<typeof specSchema>;
export type ComparisonSpecInput = z.input<typeof specSchema>;
export type ComparisonFile = z.infer<typeof file>;

/** Read one spec file the way the CLI does: the bytes are bound (they are
 * retained beside the attempt) and parsed by the schema above. */
export function readComparisonSpec(path: string): { spec: ComparisonSpec; bytes: Buffer } {
  const resolved = resolve(path);
  const bytes = researchRead(dirname(resolved), resolved.split("/").at(-1)!);
  return { spec: specSchema.parse(JSON.parse(bytes.toString("utf8"))), bytes };
}

export interface ComparisonRun {
  readonly spec: ComparisonSpec;
  /** The canonical study directory the attempt registered against. */
  readonly study: string;
  readonly attemptId: string;
  readonly controlRoot: string;
  /** The prepared private home; `home.workspace` is the tree the session left
   * behind, which the next stage of a chain copies. */
  readonly home: ResearchAttemptHome;
  readonly result: Awaited<ReturnType<typeof executeComparatorAttempt>>;
  /** Exactly the object the CLI prints as one JSON line. */
  readonly summary: Record<string, unknown>;
}

/**
 * Dispatch one registered attempt. The body is the script's own, unchanged:
 * the study directories, the prompt digest check, the attempt registration,
 * the private home, the optional credential placement, the frozen-input git
 * baseline, the supervised execution and the credential reconciliation.
 */
export async function executeComparisonSpec(input: {
  readonly spec: ComparisonSpec;
  readonly bytes: Buffer;
  /** Called with the summary at the exact point the CLI prints it. */
  readonly onSummary?: (summary: Record<string, unknown>) => void;
}): Promise<ComparisonRun> {
  const spec = input.spec, study = realpathSync(spec.study);
  const phaseRoot = join(study, "resources"), live = join(study, "live");
  for (const dir of [phaseRoot, live]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prompt = researchRead(realpathSync(spec.source_root), spec.prompt.path);
  if (researchHash(prompt) !== spec.prompt.sha256) throw new Error("task prompt digest mismatch");
  const slot = registerScheduledResearchAttempt(study, join(study, "manifest.json"), spec.scheduled_key, spec.ordinal, phaseRoot);
  durableResearchFile(join(slot.controlRoot, "run-spec.json"), input.bytes);
  const credentials: Record<string, string> = {};
  // A key can be supplied by the operator's process; it never enters receipts.
  if (process.env.ANTHROPIC_API_KEY) credentials.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const home = prepareResearchHome({ root: live, sourceRoot: realpathSync(spec.source_root), files: spec.files,
    runtime: spec.runtime, route: spec.arm.kind === "dokkabi" ? spec.arm.route : "anthropic-native", model: spec.arm.model,
    variables: spec.variables, credentials });
  let credential: { source: string; target: string; provider: string; before: unknown } | undefined;
  if (spec.credential_file) {
    const value = JSON.parse(readFileSync(spec.credential_file, "utf8")) as Record<string, unknown>;
    const provider = spec.arm.kind === "claude-code" ? "claudeAiOauth" : spec.credential_provider;
    if (!provider || !value[provider]) throw new Error("selected provider credential unavailable");
    const target = spec.arm.kind === "claude-code" ? join(home.home, ".claude", ".credentials.json") : home.environment.DOKKABI_PI_AUTH!;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    durableResearchFile(target, JSON.stringify({ [provider]: value[provider] }) + "\n");
    credential = { source: realpathSync(spec.credential_file), target, provider, before: value[provider] };
  }
  try {
    if (spec.initialize_git) {
      const env = { ...home.environment, GIT_AUTHOR_NAME: "Research fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Research fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
      for (const command of [["init", "--quiet"], ["-c", "core.hooksPath=/dev/null", "add", "--all", "--force", "--", "."],
        ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "Frozen task input"]]) {
        execFileSync(spec.git, command, { cwd: home.workspace, env, stdio: "pipe", timeout: 60000 });
      }
    }
    const result = await executeComparatorAttempt({ study, ...slot, phaseRoot, home, arm: spec.arm, prompt: prompt.toString("utf8"),
      git: spec.git, timeoutMs: spec.timeout_ms });
    const summary = { attempt: result.attempt, process: result.process.status, harness: result.observation.harness,
      usage: result.observation.usage, models: result.observation.models, task_time_ms: result.task_time_ms,
      patch_sha256: result.artifact?.patch.sha256 ?? null, issues: result.issues,
      result: join(slot.controlRoot, "comparison-result.json"), inventory: join(slot.controlRoot, "inventory.json") };
    input.onSummary?.(summary);
    return { spec, study, attemptId: slot.attempt.id, controlRoot: slot.controlRoot, home, result, summary };
  } finally {
    if (credential) {
      const status = await reconcileComparatorCredential(credential.source, credential.target, credential.provider, credential.before);
      durableResearchFile(join(slot.controlRoot, "credential-state.json"), JSON.stringify({ status, provider: credential.provider }) + "\n");
    }
  }
}
