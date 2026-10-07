/**
 * Case-runner policy: WHICH commands may verify a case and HOW to read the
 * test file they name. This is capability DATA, not loop logic (constitution
 * 7) — the generic work loop must judge plans for any coding domain, so
 * ecosystem knowledge lives here as registrable runners, never as branches
 * in the validator or the case runner. Bun and pytest ship as defaults; an
 * adapter, an operator, or the MODEL registers more as declarative specs
 * (see runner-spec.ts).
 *
 * THE single allowlist: validate (plan seal) and verify (runCase) both
 * consult this registry — a second copy anywhere drifts and silently turns
 * cases red (probe 12 lesson).
 */
import { posix } from "node:path";
import { compileRunnerSpec, type RunnerSpec } from "./runner-spec.ts";
import { pytestResultAdapter } from "./results/pytest.ts";
import type { RunnerResultAdapter } from "./results/contract.ts";

export type CaseSpeculationProfile = Readonly<{
  kind: "bun-transpiler-cache-v1";
  environmentVariable: "BUN_RUNTIME_TRANSPILER_CACHE_PATH";
  artifactSuffix: ".pile";
  minimumSourceBytes: number;
}>;

export interface CaseRunner {
  readonly id: string;
  /** Complete declarative runner contract retained with operator obligations. */
  readonly definition?: RunnerSpec;
  /** Command shape shown to the model in prompts and refusals. */
  readonly example?: string;
  /** Whether this runner can execute the trimmed case command. */
  matches(command: string): boolean;
  /** The test file the command names, when it names one. */
  testFile(command: string): string | undefined;
  readonly speculation?: CaseSpeculationProfile;
  readonly authorizedRecipe?: "exact-bun-test";
  /** Declarative lookup only: execution still requires the host registry. */
  readonly measurementEvaluator?: string;
  readonly resultAdapter?: RunnerResultAdapter;
}

/** Built-in runner knowledge, expressed as data like every other runner. */
export const BUILTIN_RUNNER_SPECS: RunnerSpec[] = [
  {
    id: "bun-test",
    example: "bun test <test-file>",
    invocations: [{ programs: ["bun"], subcommand: ["test"] }],
    test_file: { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
  },
  {
    id: "unittest",
    example: "python -m unittest tests.test_module -k test_name",
    invocations: [
      { programs: ["python", "python3"], subcommand: ["-m", "unittest"] },
    ],
    test_file: {
      extensions: [".py"],
      dir_segments: ["tests", "testing"],
      basename_prefixes: ["test_"],
      basename_suffixes: ["_test.py"],
      exclude_basenames: ["conftest.py", "__init__.py"],
      module_paths: true,
      switches: ["-v", "--verbose", "-q", "--quiet", "-f", "--failfast", "-c", "--catch", "-b", "--buffer", "--locals"],
    },
  },
  {
    // pytest under any sanctioned interpreter: bare, python -m, the adapter's
    // DOKKABI_SWE_PYTHON indirection, or a venv path — the spec engine's
    // program normalization resolves all of those to python/python3/pytest.
    // Repositories may keep suites inside a package, so the rule asks for a
    // A tests/testing directory segment or a conventional test filename;
    // conftest/__init__ collect trivially and are not test files.
    id: "pytest",
    example: "python -m pytest <test-file>",
    invocations: [
      { programs: ["pytest"] },
      { programs: ["python", "python3"], subcommand: ["-m", "pytest"] },
    ],
    test_file: {
      extensions: [".py"],
      dir_segments: ["tests", "testing"],
      basename_prefixes: ["test_"],
      basename_suffixes: ["_test.py"],
      exclude_basenames: ["conftest.py", "__init__.py"],
    },
  },
];

const BUN_TEST_PROFILE = Object.freeze({
  kind: "bun-transpiler-cache-v1",
  environmentVariable: "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  artifactSuffix: ".pile",
  minimumSourceBytes: 64 * 1024,
} satisfies CaseSpeculationProfile);

function compileBuiltinRunner(spec: RunnerSpec): CaseRunner {
  const runner = compileRunnerSpec(spec);
  if (spec.id === "pytest") return Object.freeze({ ...runner, resultAdapter: pytestResultAdapter });
  return spec.id === "bun-test"
    ? Object.freeze({ ...runner, authorizedRecipe: "exact-bun-test", speculation: BUN_TEST_PROFILE })
    : runner;
}

// This runner names a protocol candidate. It cannot enroll an evaluator or
// relax its sandbox: the optional host plugin supplies execution authority.
const protocolCandidate = /^bun ((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ts|js|mjs|cjs))$/u;
const referenceMeasurementRunner: CaseRunner = Object.freeze({
  id: "bun-observer-v1",
  example: "bun <candidate-file>",
  measurementEvaluator: "u32-square-v1",
  matches: (command: string) => protocolCandidate.test(command),
  testFile: (command: string) => protocolCandidate.exec(command)?.[1],
});

const registry = new Map<string, CaseRunner>([
  ...BUILTIN_RUNNER_SPECS.map((spec) => [spec.id, compileBuiltinRunner(spec)] as const),
  [referenceMeasurementRunner.id, referenceMeasurementRunner],
]);

export function registerCaseRunner(runner: CaseRunner): void {
  registry.set(runner.id, runner);
}

/** Register a declarative spec (validated JSON from a file, a model, a catalog). */
export function registerRunnerSpec(spec: RunnerSpec): void {
  registry.set(spec.id, compileRunnerSpec(spec));
}

export function unregisterCaseRunner(id: string): void {
  registry.delete(id);
}

export function listCaseRunners(): CaseRunner[] {
  return [...registry.values()];
}

export function matchingCaseRunner(command: string): CaseRunner | undefined {
  const trimmed = command.trim();
  if (referencesScratchPath(trimmed)) return undefined;
  return listCaseRunners().find((runner) => runner.matches(trimmed) && !scratchPath(runner.testFile(trimmed)));
}

export function eligibleCaseSpeculationProfile(
  runner: CaseRunner,
  command: string,
  testFile: string,
  sourceBytes: number,
): CaseSpeculationProfile | undefined {
  const profile = runner.speculation;
  if (!profile || sourceBytes < profile.minimumSourceBytes) return undefined;
  return command.trim() === `bun test ${testFile}` ? profile : undefined;
}

export function isAuthorizedCaseRecipe(runner: CaseRunner, command: string, testFile: string): boolean {
  return runner.authorizedRecipe === "exact-bun-test" && command.trim() === `bun test ${testFile}`;
}

/**
 * Human/model-facing list of allowed case command shapes, derived from the
 * registry. Prompts and refusal messages MUST use this instead of naming a
 * runner literally — a hardcoded "bun test" steered a pytest-repo model into
 * writing bun cases (run 6 lesson).
 */
export function caseCommandHint(): string {
  return listCaseRunners()
    .map((runner) => `${runner.example ?? runner.id}${runner.resultAdapter ? " [native outcomes]" : ""}`)
    .join(", ");
}

/** A case command one of the registered runners can execute. */
export function isAllowedCaseCommand(command: string): boolean {
  return matchingCaseRunner(command) !== undefined;
}

/** Pull the test path out of a case command, when one is named. */
export function caseTestFile(command: string): string | undefined {
  for (const runner of listCaseRunners()) {
    const file = runner.testFile(command);
    if (file && !scratchPath(file)) {
      return file;
    }
  }
  return undefined;
}

function scratchPath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  const workspacePath = normalized.startsWith("/testbed/")
    ? normalized.slice("/testbed/".length)
    : normalized;
  return workspacePath.startsWith("work/scratch/") || workspacePath.includes("/work/scratch/");
}

function referencesScratchPath(command: string): boolean {
  return /(?:^|[\s'"])(?:[^\s'"]*\/)?work\/scratch\//u.test(command.replaceAll("\\", "/"));
}
