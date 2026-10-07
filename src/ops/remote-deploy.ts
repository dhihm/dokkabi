export const REMOTE_SERVICE = "dokkabi-remote.service";

const REMOTE_UNIT = `/etc/systemd/system/${REMOTE_SERVICE}`;
const SERVICE_BUN = "/usr/local/libexec/dokkabi-bun";
const VPN_WORKER_SOURCE = "plugins/vpn/openfortivpn-worker.ts";
const VPN_WORKER_INSTALLED = "/usr/local/libexec/dokkabi-openfortivpn-worker.ts";
const CREDENTIAL_DIRECTORY = `/run/credentials/${REMOTE_SERVICE}`;
const VPN_WORKER_COMMAND = [
  SERVICE_BUN,
  VPN_WORKER_INSTALLED,
  "--config",
  `${CREDENTIAL_DIRECTORY}/vpn-config`,
  "--probe-file",
  `${CREDENTIAL_DIRECTORY}/vpn-probe`,
  "--lease-seconds",
  "180",
  "--otp-wait-seconds",
  "60",
] as const;
const CREDENTIAL_NAMES = [
  "dokkabi-remote-config",
  "dokkabi-discord-token",
  "vpn-config",
  "vpn-probe",
] as const;
const LEGACY_SECRET_ENVIRONMENT = new Set([
  "DOKKABI_DISCORD_BOT_TOKEN",
  "DOKKABI_DISCORD_GUILD_ID",
  "DOKKABI_DISCORD_CHANNEL_ID",
  "DOKKABI_DISCORD_OPERATOR_ID",
  "DOKKABI_REMOTE_GUILD_ID",
  "DOKKABI_REMOTE_CHANNEL_ID",
  "DOKKABI_REMOTE_OPERATOR_IDS",
  "DOKKABI_VPN_WORKER_COMMAND",
]);
const REMOTE_TESTS = [
  "tests/prerequisite-registry.test.ts",
  "tests/remote-cli.test.ts",
  "tests/remote-credentials.test.ts",
  "tests/remote-dashboard.test.ts",
  "tests/remote-discord-gateway.test.ts",
  "tests/remote-discord-rest.test.ts",
  "tests/remote-extension.test.ts",
  "tests/remote-local-controller.test.ts",
  "tests/remote-deploy.test.ts",
  "tests/remote-plugin.test.ts",
  "tests/remote-runtime.test.ts",
  "tests/vpn-openfortivpn-worker.test.ts",
  "tests/vpn-plugin.test.ts",
  "tests/vpn-remote.test.ts",
] as const;

export interface DeployCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RemoteDeployRuntime {
  run(argv: readonly string[], cwd: string): Promise<DeployCommandResult>;
  processEnvironment(pid: number): Promise<readonly string[]>;
  sleep(milliseconds: number): Promise<void>;
}

export type RemoteDeployMilestone =
  | "source-ready"
  | "tests-passed"
  | "host-ready"
  | "service-restarted"
  | "health-passed";

export interface RemoteDeployOptions {
  readonly connectionAttempts?: number;
  readonly stableProbes?: number;
  readonly pollIntervalMs?: number;
  readonly onProgress?: (milestone: RemoteDeployMilestone) => void;
}

export interface RemoteDeployReport {
  readonly revision: string;
  readonly gatewayConnected: true;
  readonly processReplaced: true;
  readonly restartLoop: false;
  readonly serviceState: "active";
}

export class RemoteDeploymentError extends Error {
  constructor(stage: string) {
    super(`Deployment stopped at ${stage}. Inspect privileged host diagnostics locally.`);
    this.name = "RemoteDeploymentError";
  }
}

export async function deployRemote(
  runtime: RemoteDeployRuntime,
  repoRoot: string,
  options: RemoteDeployOptions = {},
): Promise<RemoteDeployReport> {
  const attempts = positiveInteger(options.connectionAttempts ?? 20, "connection attempts");
  const stableProbes = positiveInteger(options.stableProbes ?? 3, "stable probes");
  const pollIntervalMs = nonNegativeInteger(options.pollIntervalMs ?? 1_000, "poll interval");
  const progress = options.onProgress ?? (() => {});
  const run = (stage: string, argv: readonly string[]) => checked(runtime, repoRoot, stage, argv);

  const branch = await output(run("source checkout", ["git", "symbolic-ref", "--short", "HEAD"]));
  if (branch !== "main") throw new RemoteDeploymentError("source checkout");
  if (await output(run("source checkout", ["git", "status", "--porcelain"]))) {
    throw new RemoteDeploymentError("source checkout");
  }
  await run("source fetch", ["git", "fetch", "origin", "--prune"]);
  await run("source fast-forward", ["git", "merge", "--ff-only", "origin/main"]);
  if (await output(run("source checkout", ["git", "status", "--porcelain"]))) {
    throw new RemoteDeploymentError("source checkout");
  }
  const revision = await output(run("source revision", ["git", "rev-parse", "HEAD"]));
  const remoteRevision = await output(run("source revision", ["git", "rev-parse", "origin/main"]));
  if (!/^[0-9a-f]{40}$/.test(revision) || revision !== remoteRevision) {
    throw new RemoteDeploymentError("source revision");
  }
  progress("source-ready");

  await run("locked dependencies", [SERVICE_BUN, "install", "--frozen-lockfile"]);
  await run("remote tests", [SERVICE_BUN, "test", ...REMOTE_TESTS]);
  if (await output(run("verified source", ["git", "status", "--porcelain"]))) {
    throw new RemoteDeploymentError("verified source");
  }
  const verifiedRevision = await output(run("verified source", ["git", "rev-parse", "HEAD"]));
  if (verifiedRevision !== revision) throw new RemoteDeploymentError("verified source");
  progress("tests-passed");

  const bunIdentity = await output(run("service executable", [
    "sudo", "-n", "stat", "-c", "%U:%G:%a", SERVICE_BUN,
  ]));
  if (bunIdentity !== "root:root:755") throw new RemoteDeploymentError("service executable");
  await run("service unit", ["systemd-analyze", "verify", REMOTE_UNIT]);
  await run("VPN sudo policy", ["sudo", "-n", "-l", ...VPN_WORKER_COMMAND]);
  const oldPid = parsePid(await output(run("running service", systemctlProperty("MainPID"))), "running service");
  await assertEnvironmentBoundary(runtime, oldPid);
  await assertCredentials(run);
  progress("host-ready");

  await run("worker install", [
    "sudo", "-n", "install", "-o", "root", "-g", "root", "-m", "0755",
    `${repoRoot}/${VPN_WORKER_SOURCE}`,
    VPN_WORKER_INSTALLED,
  ]);
  await run("worker install", ["sudo", "-n", "cmp", "--silent", `${repoRoot}/${VPN_WORKER_SOURCE}`, VPN_WORKER_INSTALLED]);
  await run("service restart", ["sudo", "-n", "systemctl", "restart", REMOTE_SERVICE]);
  progress("service-restarted");

  const newPid = await waitForReplacement(runtime, repoRoot, oldPid, attempts, pollIntervalMs);
  const restartCount = await output(run("startup health", systemctlProperty("NRestarts")));
  if (!/^\d+$/.test(restartCount)) throw new RemoteDeploymentError("startup health");
  await waitForCredentialBoundary(
    runtime,
    repoRoot,
    run,
    newPid,
    restartCount,
    attempts,
    pollIntervalMs,
  );
  await waitForConnection(runtime, repoRoot, newPid, restartCount, attempts, pollIntervalMs);
  await assertStable(runtime, repoRoot, newPid, restartCount, stableProbes, pollIntervalMs);

  const activeSince = await output(run("startup health", systemctlProperty("ActiveEnterTimestamp")));
  if (!activeSince) throw new RemoteDeploymentError("startup health");
  const journal = await output(run("startup health", [
    "sudo", "-n", "journalctl", "-u", REMOTE_SERVICE, "--since", activeSince, "--no-pager", "-o", "cat",
  ]));
  if (/\b(?:panic|fatal|uncaught|unhandled|authentication failed|invalid token)\b/i.test(journal)) {
    throw new RemoteDeploymentError("startup health");
  }
  progress("health-passed");

  return {
    revision: revision.slice(0, 12),
    gatewayConnected: true,
    processReplaced: true,
    restartLoop: false,
    serviceState: "active",
  };
}

async function checked(
  runtime: RemoteDeployRuntime,
  cwd: string,
  stage: string,
  argv: readonly string[],
): Promise<DeployCommandResult> {
  let result: DeployCommandResult;
  try {
    result = await runtime.run(argv, cwd);
  } catch {
    throw new RemoteDeploymentError(stage);
  }
  if (result.exitCode !== 0) throw new RemoteDeploymentError(stage);
  return result;
}

async function output(result: Promise<DeployCommandResult>): Promise<string> {
  return (await result).stdout.trim();
}

function systemctlProperty(property: string): readonly string[] {
  return ["systemctl", "show", REMOTE_SERVICE, `--property=${property}`, "--value"];
}

function parsePid(value: string, stage: string): number {
  if (!/^\d+$/.test(value)) throw new RemoteDeploymentError(stage);
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new RemoteDeploymentError(stage);
  return pid;
}

async function assertEnvironmentBoundary(runtime: RemoteDeployRuntime, pid: number): Promise<void> {
  let environment: readonly string[];
  try {
    environment = await runtime.processEnvironment(pid);
  } catch {
    throw new RemoteDeploymentError("credential boundary");
  }
  for (const entry of environment) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? entry : entry.slice(0, separator);
    if (LEGACY_SECRET_ENVIRONMENT.has(name)) throw new RemoteDeploymentError("credential boundary");
  }
}

async function assertCredentials(
  run: (stage: string, argv: readonly string[]) => Promise<DeployCommandResult>,
): Promise<void> {
  for (const name of CREDENTIAL_NAMES) {
    const path = `${CREDENTIAL_DIRECTORY}/${name}`;
    await run("credential boundary", ["sudo", "-n", "test", "-s", path]);
    const mode = await output(run("credential boundary", ["sudo", "-n", "stat", "-c", "%a", path]));
    if (mode !== "400") throw new RemoteDeploymentError("credential boundary");
  }
}

async function waitForReplacement(
  runtime: RemoteDeployRuntime,
  cwd: string,
  oldPid: number,
  attempts: number,
  interval: number,
): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const active = await runtime.run(["systemctl", "is-active", REMOTE_SERVICE], cwd);
    const pidResult = await runtime.run(systemctlProperty("MainPID"), cwd);
    const pidText = pidResult.stdout.trim();
    if (active.exitCode === 0 && active.stdout.trim() === "active" && pidResult.exitCode === 0 && /^\d+$/.test(pidText)) {
      const pid = Number(pidText);
      if (pid > 1 && pid !== oldPid) return pid;
    }
    await runtime.sleep(interval);
  }
  throw new RemoteDeploymentError("process replacement");
}

async function waitForConnection(
  runtime: RemoteDeployRuntime,
  cwd: string,
  pid: number,
  restartCount: string,
  attempts: number,
  interval: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await assertSameProcess(runtime, cwd, pid, restartCount);
    const sockets = await runtime.run(["ss", "-Hntp", "state", "established"], cwd);
    if (sockets.exitCode === 0 && sockets.stdout.includes(`pid=${pid},`)) return;
    await runtime.sleep(interval);
  }
  throw new RemoteDeploymentError("gateway connection");
}

/** A replacement PID can become visible to systemd a few milliseconds before
 * procfs and its systemd credential mount are readable to the deployment
 * operator. Retry only that narrow boundary, while proving on every attempt
 * that the same process is still active and has not entered a restart loop. */
async function waitForCredentialBoundary(
  runtime: RemoteDeployRuntime,
  cwd: string,
  run: (stage: string, argv: readonly string[]) => Promise<DeployCommandResult>,
  pid: number,
  restartCount: string,
  attempts: number,
  interval: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await assertSameProcess(runtime, cwd, pid, restartCount);
    try {
      await assertEnvironmentBoundary(runtime, pid);
      await assertCredentials(run);
      return;
    } catch (error) {
      if (!(error instanceof RemoteDeploymentError) || !error.message.includes("credential boundary")) {
        throw error;
      }
    }
    await runtime.sleep(interval);
  }
  throw new RemoteDeploymentError("credential boundary");
}

async function assertStable(
  runtime: RemoteDeployRuntime,
  cwd: string,
  pid: number,
  restartCount: string,
  probes: number,
  interval: number,
): Promise<void> {
  for (let probe = 0; probe < probes; probe += 1) {
    await runtime.sleep(interval);
    await assertSameProcess(runtime, cwd, pid, restartCount);
  }
}

async function assertSameProcess(
  runtime: RemoteDeployRuntime,
  cwd: string,
  pid: number,
  restartCount: string,
): Promise<void> {
  const active = await runtime.run(["systemctl", "is-active", REMOTE_SERVICE], cwd);
  const currentPid = await runtime.run(systemctlProperty("MainPID"), cwd);
  const currentRestarts = await runtime.run(systemctlProperty("NRestarts"), cwd);
  if (
    active.exitCode !== 0
    || active.stdout.trim() !== "active"
    || currentPid.exitCode !== 0
    || currentPid.stdout.trim() !== String(pid)
    || currentRestarts.exitCode !== 0
    || currentRestarts.stdout.trim() !== restartCount
  ) {
    throw new RemoteDeploymentError("startup health");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
