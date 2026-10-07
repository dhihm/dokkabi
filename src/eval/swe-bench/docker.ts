import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { partitionTestIds } from "./django.ts";
import { assertPreparedFixture, assertPreparedFixtureEnvironment, type PreparedFixture } from "../../work/evidence/fixture-prepare.ts";
import { FixturePreparationError } from "../../work/evidence/fixture-manifest.ts";
import {
  canonicalWorkspaceRoot,
  dockerHostEnvironment,
  dockerHostEnvironmentDigest,
  worktreeCommonGitDir,
} from "../../host/sandbox-docker.ts";
import {
  assertSandboxExecutableIdentity,
  requireAndSealSandboxExecutable,
  type SandboxHostExecutableSeal,
} from "../../host/sandbox-executable.ts";

/** Official SWE-bench eval images. The host venv is not the suite. */

export const TESTBED_PYTHON = "/opt/miniconda3/envs/testbed/bin/python";

interface SweDockerAuthority {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostEnvDigest: string;
}

interface SweDockerArgvSeal {
  readonly authority: SweDockerAuthority;
  readonly argvDigest: string;
  readonly prepared?: PreparedFixture;
}

const SWE_DOCKER_ARGV_SEALS = new WeakMap<readonly string[], SweDockerArgvSeal>();

export function officialEvalImage(instanceId: string): string {
  return `swebench/sweb.eval.x86_64.${instanceId.toLowerCase().replaceAll("__", "_1776_")}`;
}

export function sweContainerName(instanceId: string): string {
  return `dokkabi-swe-${instanceId.replaceAll("/", "_")}`;
}

export function sweImageExecArgv(input: {
  container: string;
  command: string;
  workspaceRoot: string;
}): string[] {
  const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  const docker = sealSweDockerAuthority(input.workspaceRoot);
  assertSandboxExecutableIdentity(docker.executable);
  return sealSweDockerArgv(
    [docker.executable.path, "exec", "--user", user, "-w", "/testbed", input.container, "bash", "-lc", input.command],
    docker,
  );
}

const OFFICIAL_CONTAINER_EXECUTABLES = new Map<string, SweDockerAuthority>();

function sealSweDockerAuthority(workspaceRoot: string): SweDockerAuthority {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const commonGitDir = worktreeCommonGitDir(root);
  const executable = requireAndSealSandboxExecutable("docker", [root, ...(commonGitDir ? [commonGitDir] : [])]);
  const hostEnv = dockerHostEnvironment();
  return Object.freeze({
    executable,
    hostEnv,
    hostEnvDigest: dockerHostEnvironmentDigest(hostEnv),
  });
}

function sealSweDockerArgv(argv: string[], authority: SweDockerAuthority, prepared?: PreparedFixture): string[] {
  const frozen = Object.freeze(argv) as unknown as string[];
  SWE_DOCKER_ARGV_SEALS.set(frozen, Object.freeze({ authority, argvDigest: digestArgv(frozen), prepared }));
  return frozen;
}

/** Consume the private executable capability immediately before a host-side
 * spawn. A copied or caller-constructed argv has no authority to run Docker. */
export function assertSealedSweDockerArgv(argv: readonly string[]): boolean {
  const seal = SWE_DOCKER_ARGV_SEALS.get(argv);
  if (!seal) return false;
  if (argv[0] !== seal.authority.executable.path || digestArgv(argv) !== seal.argvDigest) {
    throw new Error("sealed SWE Docker argv executable was mutated");
  }
  if (dockerHostEnvironmentDigest(seal.authority.hostEnv) !== seal.authority.hostEnvDigest) {
    throw new Error("sealed SWE Docker host connection environment changed");
  }
  assertSandboxExecutableIdentity(seal.authority.executable);
  if (seal.prepared) assertPreparedFixture(seal.prepared);
  return true;
}

export function sealedSweDockerHostEnvironment(
  argv: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (!assertSealedSweDockerArgv(argv)) return undefined;
  return SWE_DOCKER_ARGV_SEALS.get(argv)!.authority.hostEnv;
}

function digestArgv(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

function spawnSealedDocker(
  authority: SweDockerAuthority,
  args: readonly string[],
): ReturnType<typeof Bun.spawnSync> {
  assertSandboxExecutableIdentity(authority.executable);
  if (dockerHostEnvironmentDigest(authority.hostEnv) !== authority.hostEnvDigest) {
    throw new Error("SWE Docker host connection environment changed");
  }
  return Bun.spawnSync([authority.executable.path, ...args], {
    env: { ...authority.hostEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function officialWorkspaceCopyCommand(hostUid: number, hostGid: number): string {
  return `cp -a /testbed/. /out/ && chmod -R u+w /out && rm -rf /out/work /out/tests/test_separable_nested_regression.py /out/tests/test_locate_12907.py /out/tests/test_verify_12907.py /out/tests/test_fix_12907.py && chown -R ${hostUid}:${hostGid} /out`;
}

export function isolateOfficialWorkspaceHistory(workspace: string): { ok: boolean; error?: string } {
  const root = resolve(workspace);
  const gitDir = join(root, ".git");
  if (root === parse(root).root || !existsSync(gitDir)) {
    return { ok: false, error: `official workspace has no isolatable Git directory: ${root}` };
  }
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((listed.exitCode ?? 1) !== 0) {
    return { ok: false, error: `git ls-files failed: ${listed.stderr.toString().slice(0, 400)}` };
  }
  const tracked = listed.stdout.toString().split("\0").filter(Boolean);
  if (tracked.length === 0) {
    return { ok: false, error: "official workspace has no tracked files" };
  }

  rmSync(gitDir, { recursive: true, force: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Dokkabi",
    GIT_AUTHOR_EMAIL: "evaluation@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Dokkabi",
    GIT_COMMITTER_EMAIL: "evaluation@invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const init = run(["init", "-q"]);
  if ((init.exitCode ?? 1) !== 0) {
    return { ok: false, error: `isolated git init failed: ${init.stderr.toString().slice(0, 400)}` };
  }
  const disableAutoGc = run(["config", "gc.auto", "0"]);
  if ((disableAutoGc.exitCode ?? 1) !== 0) {
    return { ok: false, error: `isolated git config failed: ${disableAutoGc.stderr.toString().slice(0, 400)}` };
  }
  for (let offset = 0; offset < tracked.length; offset += 500) {
    const add = run(["add", "-f", "--", ...tracked.slice(offset, offset + 500)]);
    if ((add.exitCode ?? 1) !== 0) {
      return { ok: false, error: `isolated git add failed: ${add.stderr.toString().slice(0, 400)}` };
    }
  }
  const commit = run([
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "-qm", "Dokkabi evaluation base",
  ]);
  if ((commit.exitCode ?? 1) !== 0) {
    return { ok: false, error: `isolated git commit failed: ${commit.stderr.toString().slice(0, 400)}` };
  }
  const gc = run(["gc", "--prune=now"]);
  if ((gc.exitCode ?? 1) !== 0) {
    return { ok: false, error: `isolated git gc failed: ${gc.stderr.toString().slice(0, 400)}` };
  }
  return { ok: true };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteTests(tests: readonly string[]): string {
  return tests.map(quoteShell).join(" ");
}

/** Copy official /testbed onto the host workspace, then keep a live
 * container whose /testbed is that workspace. bash runs via docker exec. */
export function startOfficialWorkspace(input: {
  image: string;
  instanceId: string;
  workspace: string;
}): { ok: boolean; container: string; error?: string } {
  const container = sweContainerName(input.instanceId);
  if (OFFICIAL_CONTAINER_EXECUTABLES.has(container)) {
    return { ok: false, container, error: "official Docker workspace allocation is already active" };
  }
  const workspace = canonicalWorkspaceRoot(input.workspace);
  const docker = sealSweDockerAuthority(workspace);
  spawnSealedDocker(docker, ["rm", "-f", container]);
  const copyCmd = officialWorkspaceCopyCommand(process.getuid?.() ?? 0, process.getgid?.() ?? 0);
  const copy = spawnSealedDocker(
    docker,
    ["run", "--rm", "-v", `${workspace}:/out`, input.image, "bash", "-lc", copyCmd],
  );
  if ((copy.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      container,
      error: copy.stderr?.toString() || copy.stdout?.toString() || "official workspace copy failed",
    };
  }
  const isolated = isolateOfficialWorkspaceHistory(workspace);
  if (!isolated.ok) {
    return { ok: false, container, error: isolated.error ?? "Git history isolation failed" };
  }
  const started = spawnSealedDocker(
    docker,
    [
      "run",
      "-d",
      "--name",
      container,
      "--network",
      "bridge",
      "-v",
      `${workspace}:/testbed`,
      "-w",
      "/testbed",
      input.image,
      "sleep",
      "infinity",
    ],
  );
  if ((started.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      container,
      error: started.stderr?.toString() || started.stdout?.toString() || "official workspace start failed",
    };
  }
  OFFICIAL_CONTAINER_EXECUTABLES.set(container, docker);
  return { ok: true, container };
}

export function stopOfficialWorkspace(container: string): void {
  const docker = OFFICIAL_CONTAINER_EXECUTABLES.get(container);
  if (!docker) throw new Error("official Docker workspace has no sealed host executable");
  const stopped = spawnSealedDocker(docker, ["rm", "-f", container]);
  if ((stopped.exitCode ?? 1) !== 0) throw new FixturePreparationError("swe_container_cleanup_failed", stopped.stderr?.toString().slice(0, 300));
  OFFICIAL_CONTAINER_EXECUTABLES.delete(container);
}

export function registerOfficialWorkspaceTermination(
  container: string,
  terminateWork?: (signal: "SIGINT" | "SIGTERM") => void,
): () => void {
  let armed = true;
  const dispose = () => {
    if (!armed) {
      return;
    }
    armed = false;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
  const terminate = (signal: "SIGINT" | "SIGTERM") => {
    if (!armed) {
      return;
    }
    dispose();
    terminateWork?.(signal);
    stopOfficialWorkspace(container);
    process.kill(process.pid, signal);
  };
  const onSigint = () => terminate("SIGINT");
  const onSigterm = () => terminate("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return dispose;
}

/** Official scoring consumes an authenticated independent snapshot. Legacy
 * workspace/patch arguments remain source-compatible but confer no authority. */
export function dockerTestArgv(input: {
  image: string;
  tests: readonly string[];
  testPatch?: string;
  testFiles?: readonly string[];
  workspace?: string;
  container?: string;
  runner?: "pytest" | "django";
  workspaceRoot: string;
  prepared?: PreparedFixture;
}): string[] {
  if (!input.prepared) throw new FixturePreparationError("swe_prepared_fixture_required");
  assertPreparedFixture(input.prepared);
  if (input.prepared.manifest.visibility !== "hidden") throw new FixturePreparationError("swe_hidden_fixture_required");
  const bound = JSON.parse(input.prepared.receipt.command) as { image?: unknown; runner?: unknown; tests?: unknown };
  const boundTests = bound.tests;
  if (bound.image !== input.image || (bound.runner ?? "pytest") !== (input.runner ?? "pytest") || !Array.isArray(boundTests) || input.tests.some(test => !boundTests.includes(test))) throw new FixturePreparationError("swe_docker_command_binding_mismatch");
  const selectedTests = input.runner === "django" ? partitionTestIds(input.tests).runnable : input.tests;
  const testCommand = input.runner === "django"
    ? `${TESTBED_PYTHON} tests/runtests.py -v1 ${quoteTests(selectedTests)}`
    : `${TESTBED_PYTHON} -m pytest -q -W ignore::DeprecationWarning --tb=line ${quoteTests(selectedTests)}`;
  const docker = sealSweDockerAuthority(input.workspaceRoot);
  const argv = [docker.executable.path, "run", "--rm", "--network", "none", "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, "-w", "/testbed", "-v", `${input.prepared.root}:/testbed`, "-e", "PYTHONDONTWRITEBYTECODE=1"];
  const environment = { PATH: "/opt/miniconda3/envs/testbed/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", ...input.prepared.manifest.environment };
  assertPreparedFixtureEnvironment(input.prepared, environment);
  const assignments = Object.entries(environment).map(([key, value]) => quoteShell(`${key}=${value}`)).join(" ");
  argv.push(input.image, "bash", "-lc", `env -i ${assignments} ${testCommand}`);
  return sealSweDockerArgv(argv, docker, input.prepared);
}
