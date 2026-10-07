import { withHostBuiltIndex } from "../../host/host-index.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import {
  chmodSync,
  lstatSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  SweBenchAdapter,
  SweBenchInstance,
  SweBenchLoadOptions,
  SweBenchRunRequest,
  SweBenchRunResult,
  SweBenchTestReport,
} from "./types.ts";
import { operatorHome, recordRun } from "../../host/run-registry.ts";
import { preserveSession } from "../../host/session-pack.ts";
import { formatPlanGraphStats, planGraphStats } from "../../work/plan-quality.ts";
import { frameBugfixOrder } from "./order.ts";
import { partitionTestIds } from "./django.ts";
import { resolveIdsFromPatch } from "./test-ids.ts";
import {
  assertSealedSweDockerArgv,
  sealedSweDockerHostEnvironment,
  dockerTestArgv,
  officialEvalImage,
  registerOfficialWorkspaceTermination,
  startOfficialWorkspace,
  stopOfficialWorkspace,
  TESTBED_PYTHON,
} from "./docker.ts";
import { loadWorkPlan } from "../../work/load.ts";
import { loadRunnerSpecs } from "../../work/runner-load.ts";
import { patchTouchedFiles, restoreManagedTests } from "../../work/managed-tests.ts";
import { EventLog } from "../../host/event-log.ts";
import { currentSessionSchemaPayload, type EventRecord } from "../../host/schema.ts";
import { scrubEvaluatorArtifacts } from "./evaluator-artifacts.ts";
import { planDigest } from "../../work/digest.ts";
import { lastPlanDigest } from "../../work/log.ts";
import { buildSweAgentCommand, buildSweResearchAgentCommand, reviewerSessionFrom } from "./agent-command.ts";
import { acquireResearchPhase, superviseResearchProcess } from "../experiment/runner.ts";
import { spawnSealedHostGit } from "../../host/git-authority.ts";
import { requireAndSealSandboxExecutable, sealHostRuntimeExecutable, assertSandboxExecutableIdentity, type SandboxHostExecutableSeal } from "../../host/sandbox-executable.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { createPolicy, disposeSandboxPolicy, execSandboxed, type SandboxPolicy } from "../../host/sandbox.ts";
import { enrollFixture, FixturePreparationError, fixtureHash, fixtureRoot, fixtureTarget, recordFixtureBody } from "../../work/evidence/fixture-manifest.ts";
import { readFixtureFile, listFixtureDirectory } from "../../work/evidence/fixture-files.ts";
import { assertPreparedFixtureEnvironment, prepareFixture, type PreparedFixture } from "../../work/evidence/fixture-prepare.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/**
 * Load + prepare + run path for a single SWE-bench-shaped instance.
 * Scoring is local pytest on FAIL_TO_PASS only — not the official harness.
 */
export function loadSweBenchInstances(options: SweBenchLoadOptions): SweBenchInstance[] {
  if (!existsSync(options.path)) {
    throw new Error(`SWE-bench dataset not found: ${options.path}`);
  }
  const raw = readFileSync(options.path, "utf8").trim();
  let rows: unknown[];
  if (raw.startsWith("[")) {
    rows = JSON.parse(raw) as unknown[];
  } else {
    rows = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  let instances = rows.map(parseInstance).filter((row): row is SweBenchInstance => row !== undefined);
  if (options.only && options.only.length > 0) {
    const allow = new Set(options.only);
    instances = instances.filter((row) => allow.has(row.instance_id));
  }
  if (options.limit !== undefined) {
    instances = instances.slice(0, options.limit);
  }
  return instances;
}

function parseInstance(value: unknown): SweBenchInstance | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.instance_id !== "string" || typeof row.repo !== "string") {
    return undefined;
  }
  if (typeof row.base_commit !== "string" || typeof row.problem_statement !== "string") {
    return undefined;
  }
  if (row.FAIL_TO_PASS === undefined) {
    return undefined;
  }
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    base_commit: row.base_commit,
    problem_statement: row.problem_statement,
    FAIL_TO_PASS: row.FAIL_TO_PASS as string | string[],
    ...(row.PASS_TO_PASS !== undefined ? { PASS_TO_PASS: row.PASS_TO_PASS as string | string[] } : {}),
    ...(typeof row.test_patch === "string" ? { test_patch: row.test_patch } : {}),
    ...(typeof row.version === "string" ? { version: row.version } : {}),
    ...(typeof row.patch === "string" ? { patch: row.patch } : {}),
  };
}

export function parseTestList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // fall through
  }
  return value
    .split(/\n|,/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function runCmd(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): { code: number; out: string; signal?: string; error?: string; rawExitCode?: number | null; timedOut?: true } {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: env ?? process.env,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const terminal = {
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: `${(result.error as NodeJS.ErrnoException).code ?? "spawn_error"}: ${result.error.message}` } : {}),
    ...(result.status === null ? { rawExitCode: null } : {}),
  };
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { code: 124, out: `${out}\n[timeout]\n`, ...terminal, timedOut: true };
  }
  return { code: result.status ?? 1, out, ...terminal };
}

async function runCmdAsync(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onSpawn: (child: ChildProcess) => void,
): Promise<{ code: number; out: string }> {
  return await new Promise((resolveResult) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn(child);
    const maxOutput = 8 * 1024 * 1024;
    let out = "";
    let timedOut = false;
    let spawnError = "";
    const append = (chunk: Buffer) => {
      out = `${out}${chunk.toString()}`;
      if (out.length > maxOutput) {
        out = out.slice(-maxOutput);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      spawnError = error.message;
    });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      if (timedOut) {
        resolveResult({ code: 124, out: `${out}\n[timeout]\n` });
        return;
      }
      resolveResult({ code: code ?? 1, out: spawnError ? `${out}${spawnError}` : out });
    });
  });
}

/**
 * Env for the work child: DOKKABI_SWE_PYTHON names the prepared interpreter so
 * scaffolded cases and the model's own shell use the same python that prepare
 * installed into (ambient `python` is a different, contaminated interpreter).
 */
/** The sampling knob is request-scoped (SweBenchRunRequest.temperature): an
 * operator-exported DOKKABI_TEMPERATURE must not ride ...process.env into
 * envfix children or plain k=1 runs (PR #91 review finding 6). */
export function temperatureScrubbedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DOKKABI_TEMPERATURE;
  return env;
}

export function sweChildEnv(pythonBin: string, workspace?: string): Record<string, string> {
  const resolved = Bun.which(pythonBin) ?? pythonBin;
  // When prepare built a venv, the child's bare `python`/`pip` must resolve
  // inside it — run 21's envfix saw an ambient python with no pip, installed
  // into the system user-site, and forged the .so it could not build. The
  // model still owns the era reasoning; the harness owns which world the
  // shell sees (constitution 1).
  const binDir = dirname(resolved);
  const venvRoot = dirname(binDir);
  const isVenv = existsSync(join(venvRoot, "pyvenv.cfg"));
  return {
    DOKKABI_SWE_PYTHON: resolved,
    DOKKABI_EXTERNAL_KNOWLEDGE: "deny",
    ...(isVenv ? { PATH: `${binDir}:${process.env.PATH ?? ""}`, VIRTUAL_ENV: venvRoot } : {}),
    ...(workspace ? suiteEnv(workspace) : {}),
    // Keyless operator vLLM: Pi still demands an apiKey resolver. EMPTY is
    // the documented dummy — never write a host or a real key here.
    ...((process.env.VLLM_BASE_URL || process.env.DOKKABI_VLLM_BASE_URL) && !process.env.VLLM_API_KEY
      ? { VLLM_API_KEY: "EMPTY" }
      : {}),
  };
}

/**
 * Upstream SWE-bench rows carry TRUNCATED parametrized ids (run 36:
 * `test_locate_app[cliapp.factory-create_app2("foo",` — the dataset split a
 * node id on a comma and dropped the tail). One such id makes pytest refuse
 * the whole collection, so PASS_TO_PASS runs nothing and every verdict is
 * false. Balanced brackets are the fingerprint of an intact id.
 */
export function balancedTestIds(ids: readonly string[]): string[] {
  return ids.filter((id) => {
    let depth = 0;
    for (const glyph of id) {
      if (glyph === "[") {
        depth += 1;
      } else if (glyph === "]") {
        depth -= 1;
      }
    }
    return depth === 0;
  });
}

/** Test ids from pytest's short summary FAILED lines. */
export function failedTestIds(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^FAILED (\S+::\S+?)(?: - .*)?$/.exec(line.trim());
    if (match?.[1]) {
      out.push(match[1]);
    }
  }
  return out;
}

/** Relativize a pytest node id: strip the workspace prefix so
 * `/tmp/ws/tests/a.py::t` and `tests/a.py::t` compare. */
export function normalizeTestId(id: string): string {
  const cut = id.trim();
  const tests = cut.lastIndexOf("/tests/");
  if (tests >= 0) {
    return cut.slice(tests + 1);
  }
  if (cut.startsWith("tests/")) {
    return cut;
  }
  const py = cut.lastIndexOf(".py::");
  if (py >= 0) {
    const slash = cut.lastIndexOf("/", py);
    return slash >= 0 ? cut.slice(slash + 1) : cut;
  }
  return cut;
}

export function testIdMatches(datasetId: string, reported: string): boolean {
  const left = normalizeTestId(datasetId);
  const right = normalizeTestId(reported);
  return left === right || left.endsWith(right) || right.endsWith(left);
}

/** Dataset ghosts: pytest refused the node id (`ERROR: not found:`). */
export function notFoundTestIds(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^ERROR: not found: (\S+)/.exec(line.trim());
    if (match?.[1]) {
      out.push(normalizeTestId(match[1]));
    }
  }
  return out;
}

/**
 * Keep the pytest short-summary (it sits at the END). A head-only 8KB clip
 * dropped FAILED lines on large PASS_TO_PASS suites, so known_bad stayed
 * empty and era-broken tests counted as regressions.
 */
export function clipTestOutput(output: string, limit = 12_000): string {
  if (output.length <= limit) {
    return output;
  }
  const head = Math.floor(limit / 3);
  const tail = limit - head - 5;
  return `${output.slice(0, head)}\n…\n${output.slice(-tail)}`;
}

export interface P2pScorePlan {
  /** Ids to run after the agent: collected and green at baseline. */
  run: string[];
  /** Collected at baseline but already red — not a regression. */
  known_bad: string[];
  /** Dataset garbage: truncated or not found. Never sent to pytest again. */
  dropped: string[];
}

/**
 * Pure P2P set: drop truncated/not-found ids, park era-broken failures as
 * known_bad, and keep only tests that can actually regress.
 */
export function planP2pScoring(input: {
  ids: readonly string[];
  baselineOutput: string;
}): P2pScorePlan {
  const intact = balancedTestIds(input.ids);
  const unbalanced = input.ids.filter((id) => !intact.includes(id));
  const missing = notFoundTestIds(input.baselineOutput);
  const dropped = [
    ...unbalanced,
    ...intact.filter((id) => missing.some((item) => testIdMatches(id, item))),
  ];
  const collectable = intact.filter((id) => !dropped.includes(id));
  const known_bad = failedTestIds(input.baselineOutput).filter((id) =>
    collectable.some((item) => testIdMatches(item, id)),
  );
  const bad = new Set(known_bad);
  const run = collectable.filter((id) => !bad.has(id) && !known_bad.some((item) => testIdMatches(id, item)));
  return { run, known_bad, dropped };
}

/**
 * The identity of a collection failure, for deciding whether an envfix round
 * made progress: workspace paths and counters (timings, error counts, line
 * numbers) vary between identical failures, so they are stripped before the
 * tail comparison. Two equal signatures mean the model hit the same wall.
 */
export function collectionSignature(output: string, workspace: string): string {
  return output
    .split(workspace)
    .join("")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-240);
}

/**
 * A baseline that already passes FAIL_TO_PASS means the environment is
 * wrong (the test skipped under the chosen python) or the instance is
 * misconfigured — running the agent would manufacture a fake resolve.
 */
export function evaluateBaseline(
  baseline: SweBenchTestReport,
): { proceed: true } | { proceed: false; error: string } {
  if (baseline.passed) {
    return {
      proceed: false,
      error:
        "baseline already passes FAIL_TO_PASS — environment or instance invalid (check for skips / wrong python)",
    };
  }
  if (baseline.exit_code === 86 || baseline.output.includes("DOKKABI_EVALUATOR_SETUP_FAILED")) {
    return {
      proceed: false,
      error: `baseline evaluator patch setup failed (exit ${baseline.exit_code}) — FAIL_TO_PASS did not run`,
    };
  }
  // A collection error is not a reproducible bug: the suite never ran, so
  // the model would chase a broken environment and burn its context.
  if (baseline.exit_code === 4 || /ImportError while loading conftest|errors? during collection|failed to import/i.test(baseline.output)) {
    return {
      proceed: false,
      error: `baseline cannot even collect FAIL_TO_PASS (exit ${baseline.exit_code}) — conftest/collection error. Fix the environment (interpreter era, -W flags, deps) before running: ${baseline.output.slice(-300)}`,
    };
  }
  return { proceed: true };
}

/**
 * A per-workspace venv: user-site poison (editable .pth leftovers from
 * sibling probes) can never shadow packages again, and the venv lives inside
 * the workspace so the bwrap sandbox sees it read-write.
 */
export function createWorkspaceVenv(pythonBin: string, workspace: string): { python: string } {
  const venvDir = join(workspace, ".venv");
  rmSync(venvDir, { recursive: true, force: true });
  const created = runCmd([pythonBin, "-m", "venv", venvDir], workspace, 120_000);
  if (created.code !== 0) {
    throw new Error(`venv creation failed under ${pythonBin}: ${created.out.slice(0, 300)}`);
  }
  return { python: join(venvDir, "bin", "python") };
}

/**
 * Fail-closed test environment: the run is meaningless when the chosen
 * python cannot execute pytest (probe 5: python3.12 had no pip, every
 * baseline "failed" on the interpreter, and nothing scored the bug).
 * Everything installs into the workspace venv, isolated from ~/.local.
 */
export function ensureTestEnv(
  py: string,
  cwd: string,
  timeoutMs: number,
  pytestSpec = "pytest<9",
): { ok: true; python: string } | { ok: false; error: string } {
  let python: string;
  try {
    python = createWorkspaceVenv(py, cwd).python;
  } catch (error) {
    return {
      ok: false,
      error: `pytest cannot run in the workspace venv (venv creation failed under ${py}): ${String(error).slice(0, 400)}`,
    };
  }
  const diag: string[] = [];
  // `pytest --version` from HOME: running it in the workspace loads the
  // repo's conftest (tests/conftest.py imports flask) before the editable
  // install exists — a guaranteed ImportError that fail-closed the whole
  // prepare (flask-5063 sweep 3). The interpreter check needs no repo.
  const home = homedir();
  const install = () =>
    runCmd([python, "-m", "pip", "install", "-q", "--disable-pip-version-check", pytestSpec], home, timeoutMs);
  const pytestReady = () => runCmd([python, "-m", "pytest", "--version"], home, 60_000);
  let pipRun = install();
  diag.push(`pip exit=${pipRun.code}\n${pipRun.out.slice(0, 400)}`);
  let ready = pytestReady();
  if (ready.code !== 0) {
    diag.push(`pytest exit=${ready.code}\n${ready.out.slice(0, 400)}`);
    // venv creation already bootstrapped pip via ensurepip; one retry for flaky networks.
    pipRun = install();
    diag.push(`pip retry exit=${pipRun.code}\n${pipRun.out.slice(0, 400)}`);
    ready = pytestReady();
  }
  if (ready.code === 0) {
    return { ok: true, python };
  }
  diag.push(`pytest retry exit=${ready.code}\n${ready.out.slice(0, 400)}`);
  return {
    ok: false,
    error: `pytest cannot run in the workspace venv (${python}):
${diag.join("\n---\n")}`,
  };
}

/**
 * Prepare the base checkout and environment. Hidden test_patch bytes are
 * installed only by enrollSweFixture in private source staging.
 */
export async function prepareSweBenchCheckout(
  request: SweBenchRunRequest,
): Promise<{ ok: boolean; error?: string; commit?: string; patchPath?: string; python?: string; container?: string }> {
  const workspace = resolve(request.workspace);
  const instance = request.instance;
  mkdirSync(dirname(workspace), { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const officialImage = officialEvalImage(instance.instance_id);
  if (officialImage) {
    const started = startOfficialWorkspace({
      image: officialImage,
      instanceId: instance.instance_id,
      workspace,
    });
    if (!started.ok) {
      return { ok: false, error: `official image start failed: ${started.error ?? "unknown"}` };
    }
    const head = runCmd(["git", "rev-parse", "HEAD"], workspace, 30_000);
    return {
      ok: true,
      commit: head.out.trim() || instance.base_commit,
      container: started.container,
      python: TESTBED_PYTHON,
    };
  }

  const url = `https://github.com/${instance.repo}.git`;
  const clone = runCmd(["git", "clone", "--quiet", url, workspace], dirname(workspace), 600_000);
  if (clone.code !== 0) {
    return { ok: false, error: `git clone failed: ${clone.out.slice(0, 500)}` };
  }
  let checkout = runCmd(["git", "checkout", "--quiet", instance.base_commit], workspace, 120_000);
  if (checkout.code !== 0) {
    const fetch = runCmd(["git", "fetch", "--quiet", "origin", instance.base_commit], workspace, 300_000);
    checkout = runCmd(["git", "checkout", "--quiet", instance.base_commit], workspace, 120_000);
    if (checkout.code !== 0) {
      return {
        ok: false,
        error: `git checkout failed: ${fetch.out.slice(0, 300)}\n${checkout.out.slice(0, 400)}`,
      };
    }
  }


  // Best-effort env: pytest + editable package. Official SWE-bench uses
  // per-repo Docker images; this is a thin local approximation — but pytest
  // itself is not best-effort: without it no FAIL_TO_PASS can ever run.
  // Do not add silent pip pins here. A host-chosen setuptools/hypothesis/
  // urllib3 pin to make an old repo import is environment cheating.
  const py = request.pythonBin ?? "python3";
  const env = ensureTestEnv(py, workspace, 300_000);
  if (!env.ok) {
    return { ok: false, error: env.error };
  }
  // Everything downstream — editable install, extra pins, baseline, the work
  // child's DOKKABI_SWE_PYTHON, scoring — uses the isolated venv python.
  const venvPy = env.python;
  const pipLog: string[] = ["test_env ok", `venv ${venvPy}`];
  if (existsSync(join(workspace, "pyproject.toml")) || existsSync(join(workspace, "setup.py"))) {
    const install = runCmd(
      [venvPy, "-m", "pip", "install", "-e", ".", "-q", "--disable-pip-version-check"],
      workspace,
      600_000,
    );
    pipLog.push(`editable_install exit=${install.code}\n${install.out.slice(0, 8000)}`);
  }
  if (request.extraPip && request.extraPip.length > 0) {
    const extra = runCmd(
      [venvPy, "-m", "pip", "install", "-q", "--disable-pip-version-check", ...request.extraPip],
      workspace,
      300_000,
    );
    pipLog.push(`extra_pip exit=${extra.code} pkgs=${request.extraPip.join(" ")}\n${extra.out.slice(0, 4000)}`);
    if (extra.code !== 0) {
      return {
        ok: false,
        error: `extra-pip failed in the workspace venv (${venvPy}) for ${request.extraPip.join(" ")} — pick wheels/py3.12-compatible pins: ${extra.out.slice(0, 400)}`,
      };
    }
  }
  writeFileSync(join(workspace, ".swe-pip-install.log"), pipLog.join("\n---\n"));

  const head = runCmd(["git", "rev-parse", "HEAD"], workspace, 30_000);
  return { ok: true, commit: head.out.trim(), python: venvPy };
}

/**
 * Compatibility restoration helper for callers with an explicit visible patch.
 * This operation does not enroll fixture authority or authorize official scoring.
 */
export function resetPatchedTests(
  workspace: string,
  patchPath: string,
): { ok: boolean; files: string[]; error?: string } {
  const result = restoreManagedTests(workspace, patchPath);
  return result;
}

/** Remove evaluator-only tests before the model enters the workspace. */
export function hidePatchedTests(
  workspace: string,
  patchPath: string,
  log?: EventLog,
): { ok: true } | { ok: false; error: string } {
  const reversed = runCmd(["git", "apply", "-R", patchPath], workspace, 60_000);
  if (reversed.code !== 0) {
    return { ok: false, error: `test_patch hide failed: ${reversed.out.slice(0, 300)}` };
  }
  try {
    rmSync(patchPath, { force: true });
    const scrubbed = scrubEvaluatorArtifacts(workspace);
    log?.append({
      kind: "observe",
      name: "swe/evaluator_artifacts_scrubbed",
      payload: {
        removed_directories: scrubbed.removedDirectories,
        removed_files: scrubbed.removedFiles,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `evaluator artifact scrub failed: ${message.slice(0, 300)}` };
  }
  return { ok: true };
}


/**
 * Envfix owns the ENVIRONMENT — venv, pip installs, untracked build
 * artifacts — never the tracked sources. Run 16 (openrouter) "fixed" a
 * broken build by deleting the whole sklearn/ tree, and the re-verify then
 * judged wreckage instead of the repo. After the wave every tracked change
 * outside the official test patch is model damage: restore the tree
 * (untracked artifacts survive) and report what came back. The caller
 * re-applies the test patch — a full checkout wipes it too.
 */
export function restoreTrackedTree(
  workspace: string,
  patchPath?: string,
): { restored: string[]; error?: string } {
  // I2 (D57g): what the model changed of the tracked tree is the HOST's
  // listing of the workspace, staged into an index of its own, against HEAD
  // — never the workspace's index, which the model's session wrote.
  let changed: string;
  try {
    changed = withHostBuiltIndex(workspace, (env) => {
      const result = spawnSealedHostGit(workspace, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=MDT", "-z", "HEAD"], { extraEnv: env, timeoutMs: 60_000 });
      if ((result.exitCode ?? 1) !== 0) throw new Error(result.stderr.toString().slice(0, 200));
      return result.stdout.toString();
    }, { writeObjects: false, timeoutMs: 60_000 });
  } catch (error) {
    return { restored: [], error: `git status failed: ${String(error).slice(0, 200)}` };
  }
  const official = new Set(patchPath && existsSync(patchPath) ? patchTouchedFiles(patchPath) : []);
  const damaged = changed
    .split("\0")
    .filter((file) => file.length > 0 && !official.has(file));
  if (damaged.length === 0) {
    return { restored: [] };
  }
  // Every tracked file written back from HEAD (untracked artifacts stay), as
  // `checkout HEAD -- .` did — but through the sealed subcommands (S2, I2,
  // D57e/D57g): HEAD read into a fresh index of the host's own, in a
  // host-owned temporary directory, and every file of it written out. `checkout`
  // is not a sealed subcommand (it looks inside a populated submodule), and
  // the workspace's own index — the model's session wrote it — is neither
  // read nor needed.
  const indexDir = mkdtempSync(join(tmpdir(), "dokkabi-envfix-restore-index-"));
  try {
    for (const args of [["read-tree", "HEAD"], ["checkout-index", "-a", "-f"]]) {
      const run = spawnSealedHostGit(workspace, args, { timeoutMs: 120_000, extraEnv: { GIT_INDEX_FILE: join(indexDir, "index") } });
      if ((run.exitCode ?? 1) !== 0) {
        return { restored: [], error: `git checkout failed: ${`${run.stdout.toString()}${run.stderr.toString()}`.slice(0, 200)}` };
      }
    }
  } catch (error) {
    return { restored: [], error: `git checkout failed: ${String(error).slice(0, 200)}` };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
  return { restored: damaged };
}

/** SWE-bench repo conventions: django's suite needs the sqlite settings
 * module or every test dies at collection (exit 4). Detected by file, not
 * repo name, so forks and mirrors get it too. */
export function suiteEnv(workspace: string): Record<string, string> {
  if (existsSync(join(workspace, "tests", "test_sqlite.py"))) {
    return { DJANGO_SETTINGS_MODULE: "tests.test_sqlite" };
  }
  return {};
}

/**
 * Django suites run under tests/runtests.py: plain pytest cannot load the
 * app registry at all (every collection dies with ImproperlyConfigured).
 * Runnable ids are module paths, and narrative ids are counted as skipped
 * rather than guessed (django.ts).
 */
export function runFailToPass(
  workspace: string,
  rawTests: string[],
  options: { pytestArgs?: string[]; timeoutMs?: number; python?: string; environment?: Record<string, string> } = {},
): SweBenchTestReport {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const hasRuntests = existsSync(join(workspace, "tests", "runtests.py"));
  const { runnable, skipped } = hasRuntests
    ? partitionTestIds(rawTests)
    : { runnable: rawTests, skipped: [] as string[] };
  if (runnable.length === 0) {
    return {
      exit_code: 2,
      tests: rawTests,
      output: `no runnable FAIL_TO_PASS tests (skipped ${skipped.length} narrative ids)`,
      passed: false,
    };
  }
  let result: ReturnType<typeof runCmd>;
  const suppliedArgs = options.pytestArgs;
  const sealedDocker = suppliedArgs ? assertSealedSweDockerArgv(suppliedArgs) : false;
  const dockerLike = suppliedArgs ? containsUnsealedDockerInvocation(suppliedArgs) : false;
  if (suppliedArgs) {
    if (dockerLike && !sealedDocker) {
      result = { code: 126, out: "refusing an unsealed Docker evaluator command" };
    } else {
      result = runCmd(
        suppliedArgs,
        sealedDocker ? process.cwd() : workspace,
        timeoutMs,
        sealedDocker ? { ...sealedSweDockerHostEnvironment(suppliedArgs) } : options.environment,
      );
    }
  } else if (hasRuntests) {
    result = runDjangoRuntests(workspace, runnable, options.python ?? "python3", timeoutMs, options.environment);
  } else {
    const argv = options.pytestArgs ?? [options.python ?? "python3", "-m", "pytest", "-q", "-W", "ignore::DeprecationWarning", "--tb=line"];
    result = runCmd([...argv, ...runnable], workspace, timeoutMs, options.environment ?? { ...process.env, ...suiteEnv(workspace) });
  }
  const skippedNote = skipped.length > 0 ? `\n[skipped ${skipped.length} narrative ids]` : "";
  if (result.signal || result.error || result.rawExitCode === null || result.timedOut) {
    const execution = { exit_code: result.code, output: clipTestOutput(result.out) + skippedNote, passed: false,
      ...(result.signal ? { signal: result.signal } : {}), ...(result.error ? { error: result.error } : {}),
      ...(result.rawExitCode === null ? { raw_exit_code: null } : {}), ...(result.timedOut ? { timed_out: true } : {}),
    };
    return { status: "evaluator_error", exit_code: 86, tests: rawTests, output: execution.output, passed: false, error: "evaluator_error: swe_evaluator_process_incomplete", execution };
  }
  return {
    exit_code: result.code,
    tests: rawTests,
    output: clipTestOutput(result.out) + skippedNote,
    passed: result.code === 0,
  };
}

/** Raw pytest argv is an explicit operator escape hatch, but it never grants
 * Docker-host authority. Catch both direct Docker and common wrapper forms
 * (`env docker ...`, or an argv[0] symlink to Docker). Official Docker argv
 * carries the private SWE seal and is handled before this predicate. */
function containsUnsealedDockerInvocation(argv: readonly string[]): boolean {
  if (argv.some((token) => basename(token).toLowerCase() === "docker")) return true;
  const executable = argv[0];
  if (!executable) return false;
  try {
    const resolved = isAbsolute(executable) ? executable : Bun.which(executable);
    return resolved ? basename(realpathSync(resolved)).toLowerCase() === "docker" : false;
  } catch {
    return false;
  }
}

function runDjangoRuntests(
  workspace: string,
  ids: string[],
  python: string,
  timeoutMs: number,
  environment?: Record<string, string>,
): { code: number; out: string } {
  const venvPython = join(workspace, ".venv", "bin", "python");
  const py = existsSync(venvPython) ? venvPython : python;
  // runtests.py exits non-zero on any failure; -v1 keeps the summary short.
  return runCmd([py, "tests/runtests.py", "-v1", ...ids], workspace, timeoutMs, environment ?? {
    ...process.env,
    ...suiteEnv(workspace),
  });
}

/** Baseline goes on the log before the agent runs so the dashboard shows the probe live. */
export function recordSweBaseline(
  log: EventLog,
  instanceId: string,
  baseline: SweBenchTestReport,
): void {
  log.append({
    kind: "observe",
    name: "swe/baseline",
    payload: {
      instance: instanceId,
      tests: baseline.tests.length,
      passed: baseline.passed,
      exit_code: baseline.exit_code,
    },
  });
}

/** Final run record: after-report plus the resolved verdict. Constitution 6. */
/**
 * Keep the instance's EventLog where the operator can still open it.
 *
 * A campaign runs each instance under a throwaway DOKKABI_HOME and deletes it
 * when it moves on. The log is the only record of what happened
 * (constitution 3), so it is copied — with the blobs it references — into the
 * operator's own home, and the run index is pointed at the copy. Best effort:
 * an instance never fails because its archive could not be written.
 */
function keepSessionForOperator(logPath: string): void {
  try {
    const sessionId = basename(dirname(logPath));
    const runHome = dirname(dirname(dirname(logPath)));
    const keepHome = operatorHome();
    if (resolve(runHome) === resolve(keepHome)) {
      return;
    }
    const kept = preserveSession({ logPath, sessionId, destHome: keepHome });
    if (kept) {
      recordRun({ home: keepHome, session: basename(dirname(kept)), label: "swe" });
    }
  } catch {
    // The operator loses a copy; the campaign carries on.
  }
}

export function recordSweRun(log: EventLog, result: SweBenchRunResult): void {
  if (result.after) {
    log.append({
      kind: "observe",
      name: "swe/after",
      payload: {
        instance: result.instance_id,
        tests: result.after.tests.length,
        passed: result.after.passed,
        exit_code: result.after.exit_code,
      },
    });
  }
  log.append({
    kind: "observe",
    name: "swe/result",
    payload: {
      instance: result.instance_id,
      prepared: result.prepared,
      planned: result.planned,
      completed: result.completed,
      resolved: result.status !== "evaluator_error" && result.resolved,
      ...(result.status ? { status: result.status } : {}),
      ...(result.evaluator_log_path ? { evaluator_log_path: result.evaluator_log_path } : {}),
      blame: classifySweBlame(result),
      work_exit: result.work_exit ?? "missing",
      plan_stats: result.plan_stats ?? "missing",
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    },
  });
  keepSessionForOperator(log.path);
}

export function inspectSweWorkPlan(
  workspace: string,
  homeDir?: string,
  events: readonly EventRecord[] = [],
): { planned: boolean; planStats: string } {
  const planPath = join(workspace, "work", "current.json");
  if (!existsSync(planPath)) {
    return { planned: false, planStats: "missing workspace work/current.json" };
  }
  try {
    const runners = loadRunnerSpecs({ workspaceRoot: workspace, ...(homeDir ? { homeDir } : {}) });
    const loaded = loadWorkPlan(planPath);
    const errors = [
      ...runners.errors.map((error) => `runner spec ${error}`),
      ...loaded.errors,
    ];
    if (errors.length === 0 && loaded.plan.todos.length > 0) {
      if (lastPlanDigest(events) !== planDigest(loaded.plan)) {
        return {
          planned: false,
          planStats: `unsealed@${planPath}: no matching work/goal digest in the event log`,
        };
      }
      return {
        planned: true,
        planStats: formatPlanGraphStats(planGraphStats(loaded.plan)),
      };
    }
    return {
      planned: false,
      planStats: `unsealed@${planPath}: ${errors.slice(0, 3).join("; ") || "empty"}`,
    };
  } catch (error) {
    return {
      planned: false,
      planStats: `unreadable@${planPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The full invocation is pinned with the checker before any candidate work. */
export interface SweFixtureSuite {
  name: "f2p" | "p2p";
  tests: readonly string[];
  argv?: readonly string[];
  image?: string;
  runner?: "pytest" | "django";
  python?: string;
}

function nativeSuiteExecutable(suite: SweFixtureSuite, workspace?: string): SandboxHostExecutableSeal {
  const requested = suite.argv?.[0] ?? suite.python ?? "python3";
  const candidate = isAbsolute(requested) ? requested
    : requested === "bun" ? process.execPath
    : Bun.which(requested, { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" });
  if (!candidate) throw new FixturePreparationError("swe_native_runtime_unavailable");
  const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)); };
  const root = workspace ? fixtureRoot(workspace) : undefined;
  // Check original pathname ancestry as well as its final target. A candidate
  // .venv symlink cannot launder an outside interpreter through /tmp aliases.
  if (root) for (let cursor = resolve(candidate); cursor !== dirname(cursor); cursor = dirname(cursor)) {
    if (within(root, realpathSync(cursor))) throw new FixturePreparationError("swe_candidate_runtime_refused");
  }
  const canonical = realpathSync(candidate);
  return sealHostRuntimeExecutable(canonical, root ? [root] : []);
}

function commandWithNativeIdentity(suite: SweFixtureSuite, seal?: SandboxHostExecutableSeal): string {
  return canonicalJson({ ...suite, ...(seal ? { native_executable: seal } : {}) });
}

export function sweFixtureCommand(suite: SweFixtureSuite): string {
  return commandWithNativeIdentity(suite, suite.image ? undefined : nativeSuiteExecutable(suite));
}

function shellArg(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function nativeSuiteArgv(suite: SweFixtureSuite, tests: readonly string[], seal: SandboxHostExecutableSeal): string[] {
  if (suite.argv) return [seal.path, ...suite.argv.slice(1)];
  return suite.runner === "django"
    ? [seal.path, "tests/runtests.py", "-v1", ...partitionTestIds(tests).runnable]
    : [seal.path, "-m", "pytest", "-q", "-W", "ignore::DeprecationWarning", "--tb=line", ...tests];
}

/** Host-only setup. The hidden patch is never materialized in the model checkout. */
export function enrollSweFixture(input: {
  log: EventLog;
  workspace: string;
  instance: SweBenchInstance;
  closure: SweBenchRunRequest["checkerClosure"];
  suites: readonly SweFixtureSuite[];
}): void {
  if (!input.closure) throw new FixturePreparationError("swe_checker_closure_required");
  const root = fixtureRoot(input.workspace);
  const source = mkdtempSync(join(tmpdir(), "dokkabi-swe-source-"));
  const directories = new Map<string, number>();
  let primaryFailure = false;
  let enrollment: ReturnType<typeof enrollFixture> | undefined;
  try {
    const files = new Map<string, { bytes: Buffer; mode: number; identity: string }>();
    let byteCount = 0;
    const captureAncestors = (path: string): void => {
      const parts = path.split("/");
      for (let length = 1; length < parts.length; length += 1) {
        const path = parts.slice(0, length).join("/");
        if (existsSync(fixtureTarget(root, path, true))) captureDirectory(path, false);
      }
    };
    const captureFile = (path: string, expectedIdentity?: string): void => {
      if (files.has(path)) return;
      captureAncestors(path);
      const acquired = readFixtureFile(root, path);
      if (expectedIdentity && expectedIdentity !== acquired.identity) throw new FixturePreparationError("swe_source_changed", path);
      byteCount += acquired.bytes.length;
      if (byteCount > 1024 ** 3 || files.size >= 100000) throw new FixturePreparationError("swe_source_limit");
      files.set(path, acquired);
    };
    const captureDirectory = (path: string, recursive: boolean, expectedIdentity?: string): void => {
      if (!recursive && directories.has(path)) return;
      const target = fixtureTarget(root, path);
      const before = lstatSync(target);
      if (!before.isDirectory() || (before.mode & 0o7000) !== 0 || (expectedIdentity && expectedIdentity !== `${before.dev}:${before.ino}`)) throw new FixturePreparationError("swe_source_directory_changed", path);
      captureAncestors(path);
      const entries = listFixtureDirectory(root, path);
      if (recursive) for (const entry of entries) {
        const child = `${path}/${entry.name}`;
        if (entry.kind === "directory") captureDirectory(child, true, entry.identity);
        else captureFile(child, entry.identity);
      }
      const after = lstatSync(fixtureTarget(root, path));
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new FixturePreparationError("swe_source_directory_changed", path);
      directories.set(path, before.mode & 0o777);
    };
    for (const path of input.closure.discoveryRoots ?? []) {
      const target = fixtureTarget(root, path, true);
      if (existsSync(target)) captureDirectory(path, true);
    }
    for (const file of input.closure.files) {
      const target = fixtureTarget(root, file.path, true);
      if (existsSync(target)) captureFile(file.path);
      else captureAncestors(file.path);
    }
    // Authenticate every original source before materializing any private copy.
    for (const path of [...directories.keys()].sort((a, b) => a.split("/").length - b.split("/").length)) mkdirSync(join(source, path), { recursive: true, mode: 0o700 });
    for (const [path, acquired] of files) {
      mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(source, path), acquired.bytes, { flag: "wx", mode: acquired.mode });
      chmodSync(join(source, path), acquired.mode);
    }
    const patch = input.instance.test_patch;
    if (patch?.trim()) {
      const git = requireAndSealSandboxExecutable("git", [root, source]);
      assertSandboxExecutableIdentity(git);
      const initialized = Bun.spawnSync([git.path, "-c", "core.hooksPath=/dev/null", "init", "--template=", "-q"], {
        cwd: source, env: { PATH: "/usr/bin:/bin", HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      if (initialized.exitCode !== 0) throw new FixturePreparationError("swe_source_init_failed");
      const patchPath = join(source, ".git", "official-checker.patch");
      writeFileSync(patchPath, patch, { mode: 0o600 });
      const touched = patchTouchedFiles(patchPath);
      if (!touched.length) throw new FixturePreparationError("swe_test_patch_empty");
      for (const path of touched) {
        fixtureTarget(source, path, true);
        if (!input.closure.files.some(file => file.path === path) && !input.closure.discoveryRoots?.some(prefix => path.startsWith(prefix + "/"))) throw new FixturePreparationError("swe_patch_outside_declared_closure", path);
      }
      const result = spawnSealedHostGit(source, ["apply", "--whitespace=nowarn", "-"], { timeoutMs: 60_000, input: patch });
      if ((result.exitCode ?? 1) !== 0) throw new FixturePreparationError("swe_test_patch_apply_failed", result.stderr.toString().slice(0, 300));
    }
    // Patch installation needs writable private directories; pin their original
    // modes only after writes finish, including explicit-file ancestors.
    for (const [path, mode] of [...directories].sort(([a], [b]) => b.split("/").length - a.split("/").length)) {
      const target = fixtureTarget(source, path);
      if (!lstatSync(target).isDirectory()) throw new FixturePreparationError("swe_source_directory_changed", path);
      chmodSync(target, mode);
    }

    enrollment = enrollFixture(input.log, {
      ...input.closure,
      id: `swe:${input.instance.instance_id}:${fixtureHash(patch ?? "")}`,
      workspace: root,
      sourceRoot: source,
      visibility: "hidden",
      commands: input.suites.map(suite => commandWithNativeIdentity(suite, suite.image ? undefined : nativeSuiteExecutable(suite, root))),
      excludedCandidateRoots: [...new Set([".swe-test.patch", ".venv", "node_modules", ...input.closure.excludedCandidateRoots ?? []])],
    });
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    try {
      for (const path of [...directories.keys()].sort((a, b) => a.split("/").length - b.split("/").length)) {
        try {
          const target = fixtureTarget(source, path, true);
          if (lstatSync(target).isDirectory()) chmodSync(target, 0o700);
        } catch (error) {
          // rmSync unlinks unsafe leaves; cleanup never follows them to chmod.
          if (error instanceof FixturePreparationError && error.code === "unsafe_path_type") continue;
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          throw error;
        }
      }
      rmSync(source, { recursive: true, force: true });
    } catch {
      try {
        if (enrollment) input.log.append({ kind: "observe", name: "fixture/revoked", payload: { fixture_digest: enrollment.digest, fixture_id: enrollment.manifest.id, workspace: enrollment.manifest.workspace } });
        input.log.append({ kind: "observe", name: "swe/source_cleanup", payload: { status: "evaluator_error", reason_code: "swe_source_cleanup_failed", primary_failure: primaryFailure } });
      } catch (error) { if (!primaryFailure) throw error; }
      if (!primaryFailure) throw new FixturePreparationError("swe_source_cleanup_failed");
    }
  }
}

function evaluatorFailure(error: unknown, tests: readonly string[], execution?: SweBenchTestReport): SweBenchTestReport {
  const detail = error instanceof Error ? error.message : String(error);
  return { status: "evaluator_error", exit_code: 86, tests: [...tests], output: detail, error: detail, passed: false, ...(execution ? { execution: execution.execution ?? { exit_code: execution.exit_code, output: execution.output, passed: execution.passed } } : {}) };
}

/** Bounded scoring boundary used by both baselines and final scoring. */
export function runSweFixtureSuite(input: {
  log: EventLog;
  workspace: string;
  suite: SweFixtureSuite;
  selectedTests?: readonly string[];
  timeoutMs?: number;
}): SweBenchTestReport {
  const tests = [...input.selectedTests ?? input.suite.tests];
  let prepared: PreparedFixture | undefined;
  let policy: SandboxPolicy | undefined;
  let report: SweBenchTestReport | undefined;
  try {
    if (tests.some(test => !input.suite.tests.includes(test))) throw new FixturePreparationError("swe_unenrolled_test_selection");
    const runtime = input.suite.image ? undefined : nativeSuiteExecutable(input.suite, input.workspace);
    const preparation = prepareFixture({ log: input.log, workspace: input.workspace, command: commandWithNativeIdentity(input.suite, runtime), visibility: "hidden" });
    if (preparation.status === "evaluator_error") throw preparation.error;
    if (preparation.status !== "prepared") throw new FixturePreparationError("swe_fixture_not_enrolled");
    prepared = preparation;
    scrubEvaluatorArtifacts(prepared.root);
    prepared.assertIntegrity();
    const suite = input.suite;
    if (suite.image && suite.argv) throw new FixturePreparationError("swe_official_argv_override_refused");
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 600_000, 1), 600_000);
    if (suite.image) {
      const argv = dockerTestArgv({ image: suite.image, tests, runner: suite.runner, workspaceRoot: input.workspace, prepared });
      input.log.append({ kind: "observe", name: "swe/evaluator_dispatch", payload: { suite: suite.name, preparation_ref: prepared.receiptDigest, tests, argv } });
      report = runFailToPass(prepared.root, tests, { pytestArgs: argv, timeoutMs });
    } else {
      if (!runtime || !["darwin", "linux"].includes(process.platform)) throw new FixturePreparationError("swe_native_sandbox_unavailable");
      policy = createPolicy({ mode: "read-only", workspaceRoot: prepared.root, writablePaths: [prepared.root], backend: process.platform === "darwin" ? "seatbelt" : "bwrap", log: input.log });
      if (policy.disabled || policy.backend === "none" || !policy.networkDenied) throw new FixturePreparationError("swe_native_sandbox_required");
      const environment = { ...policy.childEnv, ...prepared.manifest.environment };
      assertPreparedFixtureEnvironment(prepared, environment);
      assertSandboxExecutableIdentity(runtime);
      const argv = nativeSuiteArgv(suite, tests, runtime);
      const command = ["/usr/bin/env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), ...argv].map(shellArg).join(" ");
      input.log.append({ kind: "observe", name: "swe/evaluator_dispatch", payload: { suite: suite.name, preparation_ref: prepared.receiptDigest, tests, argv, runtime_identity: runtime.identity, backend: policy.backend } });
      const execution = execSandboxed({ log: input.log, policy, command, timeoutMs });
      report = { exit_code: execution.exitCode, tests, output: clipTestOutput(execution.stdout + execution.stderr), passed: execution.exitCode === 0 };
      if (execution.signal || execution.error || execution.timedOut || execution.maxBufferExceeded || execution.completionUnavailable || execution.rawExitCode === null) {
        report.execution = { exit_code: execution.exitCode, output: report.output, passed: false,
          ...(execution.signal ? { signal: execution.signal } : {}), ...(execution.error ? { error: execution.error } : {}),
          ...(execution.timedOut ? { timed_out: true } : {}), ...(execution.maxBufferExceeded ? { max_buffer_exceeded: true } : {}),
          ...(execution.rawExitCode === null ? { raw_exit_code: null } : {}),
          ...(execution.completionUnavailable ? { completion_unavailable: true } : {}),
        };
        throw new FixturePreparationError("swe_native_process_incomplete");
      }
      assertSandboxExecutableIdentity(runtime);
      if (!suite.argv && suite.runner !== "django" && /No module named ['"]?pytest(?:['"]|$)/m.test(report.output)) throw new FixturePreparationError("swe_native_pytest_unavailable");
    }
    if (report.exit_code >= 124) throw new FixturePreparationError("swe_evaluator_process_incomplete");
    if (report.exit_code === 86 || report.output.includes("DOKKABI_EVALUATOR_SETUP_FAILED")) throw new FixturePreparationError("swe_evaluator_setup_failed");
    scrubEvaluatorArtifacts(prepared.root);
    prepared.assertIntegrity();
    report = { ...report, status: "scored", preparation_ref: prepared.receiptDigest };
  } catch (error) {
    report = evaluatorFailure(error, tests, report);
    if (prepared) report.preparation_ref = prepared.receiptDigest;
  } finally {
    if (prepared) {
      try { prepared.close(); }
      catch (error) { report = { ...evaluatorFailure(error, tests, report), preparation_ref: prepared.receiptDigest }; }
    }
    if (policy) {
      try { disposeSandboxPolicy(policy); }
      catch (error) { report = evaluatorFailure(error, tests, report); }
    }
  }
  recordFixtureBody(input.log, "swe/evaluation", report!, { suite: input.suite.name, status: report!.status, preparation_ref: report!.preparation_ref ?? null });
  return report!;
}

/** F2P preparation/integrity/cleanup failure prevents P2P dispatch and resolution. */
export function scoreSweBenchCandidate(input: {
  log: EventLog;
  workspace: string;
  f2p: SweFixtureSuite;
  p2p?: SweFixtureSuite;
  p2pTests?: readonly string[];
  timeoutMs?: number;
}): { status: "scored" | "evaluator_error"; after: SweBenchTestReport; p2p?: SweBenchTestReport; resolved: boolean; error?: string } {
  const after = runSweFixtureSuite({ ...input, suite: input.f2p });
  const p2p = after.status !== "evaluator_error" && input.p2p && (input.p2pTests ?? input.p2p.tests).length > 0
    ? runSweFixtureSuite({ ...input, suite: input.p2p, selectedTests: input.p2pTests })
    : undefined;
  const failed = after.status === "evaluator_error" ? after : p2p?.status === "evaluator_error" ? p2p : undefined;
  const result = { status: failed ? "evaluator_error" as const : "scored" as const, after, p2p, resolved: !failed && scoreResolved({ after, p2p }), ...(failed ? { error: failed.error } : {}) };
  recordFixtureBody(input.log, "swe/scoring", result, { status: result.status, resolved: result.resolved });
  return result;
}

/**
 * prepare → baseline tests → dokkabi work → after tests.
 */
export async function runSweBenchInstance(request: SweBenchRunRequest): Promise<SweBenchRunResult> {
  const instance = request.instance;
  const workspace = resolve(request.workspace);
  const research = request.research;
  if (research && (workspace !== research.home.workspace || request.sessionId !== research.attempt.id
    || (request.dokkabiHome !== undefined && request.dokkabiHome !== research.home.dokkabiHome))) throw new Error("SWE research attempt/home mismatch");
  const home = research?.home.dokkabiHome ?? request.dokkabiHome ?? join(workspace, ".dokkabi-home");
  mkdirSync(home, { recursive: true });
  const logPath = join(home, "sessions", request.sessionId, "events.jsonl");
  const runLog = EventLog.create(logPath);
  // This retained archive is outside both the candidate and the model session home.
  const evaluatorHome = mkdtempSync(join(tmpdir(), "dokkabi-swe-evidence-"));
  const fixtureLog = EventLog.create(join(evaluatorHome, "events.jsonl"));
  fixtureLog.append({ kind: "observe", name: "session/open", payload: currentSessionSchemaPayload() });
  let result: SweBenchRunResult = {
    instance_id: instance.instance_id, prepared: false, planned: false,
    completed: false, resolved: false, log_path: logPath, evaluator_log_path: fixtureLog.path,
  };
  let officialContainer: string | undefined;
  let activeWorkChild: ChildProcess | undefined;
  let releaseTermination = () => {};
  let releaseResearchPhase: (() => void) | undefined;
  try {
    if (research) releaseResearchPhase = acquireResearchPhase(research.phaseRoot, "scoring", research.attempt.id);
    if (!request.checkerClosure) throw new FixturePreparationError("swe_checker_closure_required");
    const prep = await prepareSweBenchCheckout(request);
    officialContainer = prep.container;
    if (!prep.ok) throw new FixturePreparationError("swe_checkout_prepare_failed", prep.error);
    result.prepared = true;
    if (officialContainer) releaseTermination = registerOfficialWorkspaceTermination(officialContainer, signal => activeWorkChild?.kill(signal));
    const patchPath = join(evaluatorHome, "instance.test.patch");
    writeFileSync(patchPath, instance.test_patch ?? "");
    const tests = resolveIdsFromPatch(parseTestList(instance.FAIL_TO_PASS), patchPath);
    const py = prep.python ?? request.pythonBin ?? "python3";
    const image = officialEvalImage(instance.instance_id);
    const hasDjangoRunner = existsSync(join(workspace, "tests", "runtests.py"));
    const p2pBalanced = balancedTestIds(parseTestList(instance.PASS_TO_PASS));
    const p2pPartition = hasDjangoRunner ? partitionTestIds(p2pBalanced) : { runnable: p2pBalanced, skipped: [] as string[] };
    const suite = (name: "f2p" | "p2p", ids: readonly string[]): SweFixtureSuite => ({
      name, tests: [...ids], image, runner: hasDjangoRunner ? "django" : "pytest", python: py,
      ...(request.pytestArgs ? { argv: [...request.pytestArgs] } : {}),
    });
    const f2p = suite("f2p", tests);
    const p2p = p2pPartition.runnable.length ? suite("p2p", p2pPartition.runnable) : undefined;
    enrollSweFixture({ log: fixtureLog, workspace, instance, closure: request.checkerClosure, suites: [f2p, ...(p2p ? [p2p] : [])] });
    runLog.append({ kind: "observe", name: "swe/fixture_enrolled", payload: { evaluator_log_path: fixtureLog.path, fixture_digest: fixtureLog.events.find(event => event.name === "fixture/enrolled")?.payload.blob ?? null } });
    const baseline = runSweFixtureSuite({ log: fixtureLog, workspace, suite: f2p, timeoutMs: request.testTimeoutMs });
    result.baseline = baseline;
    recordSweBaseline(runLog, instance.instance_id, baseline);
    if (baseline.status === "evaluator_error") throw new FixturePreparationError("swe_baseline_evaluator_failed", baseline.error);
    const decision = evaluateBaseline(baseline);
    if (!decision.proceed) result.error = decision.error;
    else if (!request.prepareOnly) {
      let p2pTests = p2p?.tests ? [...p2p.tests] : [];
      if (p2p) {
        let p2pBaseline = runSweFixtureSuite({ log: fixtureLog, workspace, suite: p2p, timeoutMs: request.testTimeoutMs });
        if (p2pBaseline.status === "evaluator_error") throw new FixturePreparationError("swe_p2p_baseline_evaluator_failed", p2pBaseline.error);
        let planned = planP2pScoring({ ids: p2p.tests, baselineOutput: p2pBaseline.output });
        if (planned.dropped.length > 0 && p2pBaseline.exit_code !== 0) {
          const retryIds = [...planned.run, ...planned.known_bad];
          if (retryIds.length > 0 && retryIds.length < p2p.tests.length) {
            p2pBaseline = runSweFixtureSuite({ log: fixtureLog, workspace, suite: p2p, selectedTests: retryIds, timeoutMs: request.testTimeoutMs });
            if (p2pBaseline.status === "evaluator_error") throw new FixturePreparationError("swe_p2p_baseline_evaluator_failed", p2pBaseline.error);
            const again = planP2pScoring({ ids: retryIds, baselineOutput: p2pBaseline.output });
            planned = { ...again, dropped: [...planned.dropped, ...again.dropped] };
          }
        }
        p2pTests = planned.run;
        runLog.append({ kind: "observe", name: "swe/p2p_baseline", payload: {
          instance: instance.instance_id, tests: p2pBalanced.length, run: p2pTests.length,
          known_bad: planned.known_bad.length, dropped: planned.dropped.length,
          ...(p2pPartition.skipped.length ? { skipped_narrative: p2pPartition.skipped.length } : {}),
        } });
      }
      const order = frameBugfixOrder({ title: `SWE-bench ${instance.instance_id} (${instance.repo} @ ${instance.base_commit.slice(0, 12)}). Resolve the reported issue.`, body: instance.problem_statement });
      const workTimeoutMs = request.workTimeoutMs ?? 1_200_000;
      const commandInput = { repoRoot: REPO_ROOT, sessionId: request.sessionId, workspace, order, maxSteps: request.maxSteps ?? 24, workTimeoutMs, crunch: request.crunch !== false, swarm: request.swarm === true, officialImage: image,
        ...(request.route ? { route: request.route } : {}), ...(request.modelId ? { modelId: request.modelId } : {}),
      };
      const agentCommand = research ? buildSweResearchAgentCommand(commandInput, research.home, research.runtime) : buildSweAgentCommand(commandInput);
      let work: { code: number; out: string };
      if (research) {
        releaseResearchPhase?.(); releaseResearchPhase = undefined;
        const observed = await superviseResearchProcess({ controlRoot: research.controlRoot, attempt: research.attempt,
          command: { start: agentCommand.argv }, cwd: workspace, timeoutMs: workTimeoutMs, phaseRoot: research.phaseRoot, childLog: logPath,
          authorityFiles: [{ path: research.home.environment.DOKKABI_RESEARCH_POLICY!, sha256: research.home.environment.DOKKABI_RESEARCH_POLICY_SHA256! }],
          environment: { ...agentCommand.env, DOKKABI_SWE_PYTHON: py,
            ...(request.temperature !== undefined ? { DOKKABI_TEMPERATURE: String(request.temperature) } : {}),
            ...(officialContainer ? { DOKKABI_SWE_CONTAINER: officialContainer, DOKKABI_SWE_IMAGE: image, DOKKABI_DOCKER_NETWORK_STATE: "connected" } : {}) },
          onSpawn: child => { activeWorkChild = child; },
        });
        result.research_process = observed;
        work = { code: observed.status === "exited" ? 0 : observed.exit_code || 1,
          out: readFileSync(join(research.controlRoot, observed.stdout), "utf8") + readFileSync(join(research.controlRoot, observed.stderr), "utf8") };
        releaseResearchPhase = acquireResearchPhase(research.phaseRoot, "scoring", research.attempt.id);
      } else work = await runCmdAsync([...agentCommand.argv], REPO_ROOT, workTimeoutMs, {
        ...temperatureScrubbedEnv(), DOKKABI_HOME: home,
        ...(request.temperature !== undefined ? { DOKKABI_TEMPERATURE: String(request.temperature) } : {}),
        ...sweChildEnv(py, workspace),
        ...(officialContainer ? { DOKKABI_SWE_CONTAINER: officialContainer, DOKKABI_SWE_IMAGE: image, DOKKABI_DOCKER_NETWORK_STATE: "connected" } : {}),
        ...agentCommand.env,
      }, child => { activeWorkChild = child; });
      activeWorkChild = undefined;
      runLog.refresh();
      const reviewerSession = request.swarm ? reviewerSessionFrom(runLog.events) : undefined;
      const planEvents = reviewerSession ? new EventLog(join(home, "sessions", reviewerSession, "events.jsonl")).events : runLog.events;
      const inspected = inspectSweWorkPlan(workspace, home, planEvents);
      result.planned = inspected.planned;
      result.plan_stats = inspected.planStats;
      result.completed = work.code === 0;
      result.work_exit = work.code;
      const score = scoreSweBenchCandidate({ log: fixtureLog, workspace, f2p, p2p, p2pTests, timeoutMs: request.testTimeoutMs });
      result = { ...result, ...score, error: score.error ?? (result.completed ? undefined : `work exit ${work.code}: ${work.out.slice(-1500)}`) };
    }
  } catch (error) {
    result = { ...result, status: "evaluator_error", resolved: false, error: evaluatorFailure(error, []).error };
  } finally {
    releaseTermination();
    if (officialContainer) {
      try { stopOfficialWorkspace(officialContainer); }
      catch (error) { result = { ...result, status: "evaluator_error", resolved: false, error: evaluatorFailure(error, []).error }; }
    }
    releaseResearchPhase?.();
  }
  recordFixtureBody(fixtureLog, "swe/result", result, { status: result.status ?? "unscored", resolved: result.resolved });
  recordSweRun(runLog, result);
  return result;
}

/**
 * Who owns an unresolved row. The model is blamed only when it had a
 * fair scored shot (work completed, FAIL_TO_PASS still red). Context
 * blowups, scoring holes, and prepare failures are harness. 429s are infra.
 * Everything else stays unclear — do not call that a capability miss.
 */
export type SweBlame = "resolved" | "harness" | "model" | "infra" | "unclear";

export function classifySweBlame(input: {
  resolved: boolean;
  status?: "scored" | "evaluator_error";
  prepared?: boolean;
  planned?: boolean;
  completed?: boolean;
  envfix_attempted?: boolean;
  after?: { passed: boolean };
  error?: string;
}): SweBlame {
  if (input.status === "evaluator_error") return "harness";
  if (input.resolved) {
    return "resolved";
  }
  const err = input.error ?? "";
  if (/429|rate limit|ECONNREFUSED|ENOTFOUND|status code \(no body\)/i.test(err)) {
    return "infra";
  }
  if (input.prepared === false) {
    return "harness";
  }
  if (/exceeds the context window|input exceeds/i.test(err)) {
    return "harness";
  }
  if (/cannot even collect|collection/i.test(err) && input.envfix_attempted !== true) {
    return "harness";
  }
  if (/test_patch|evaluator artifact|evaluator_error/i.test(err)) {
    return "harness";
  }
  if (input.after?.passed === true) {
    return "harness";
  }
  if (input.completed === true && input.after?.passed === false) {
    return "model";
  }
  if (input.planned === false && input.envfix_attempted === true) {
    return "model";
  }
  if (input.completed !== true) {
    return "unclear";
  }
  return "model";
}

/**
 * Official resolution: FAIL_TO_PASS all green AND PASS_TO_PASS free of
 * regressions. Rows without a p2p list fall back to f2p-only (legacy).
 */
export function scoreResolved(input: {
  after: { passed: boolean; status?: string };
  p2p?: { passed: boolean; status?: string };
}): boolean {
  if (input.after.status === "evaluator_error" || input.p2p?.status === "evaluator_error") return false;
  if (!input.after.passed) {
    return false;
  }
  return input.p2p ? input.p2p.passed : true;
}

export function createSweBenchAdapter(): SweBenchAdapter {
  return {
    load: loadSweBenchInstances,
    prepare: async (request) => {
      const prepared = await prepareSweBenchCheckout(request);
      if (prepared.container) {
        stopOfficialWorkspace(prepared.container);
      }
      return prepared;
    },
    run: runSweBenchInstance,
  };
}
