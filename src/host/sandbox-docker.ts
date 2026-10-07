import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

class DockerSandboxConfigError extends Error {}

export interface DockerWorldAttestation {
  readonly networkState: "connected" | "none";
  /** Binds the exact allowed host mounts without exposing their paths. */
  readonly mountDigest: string;
  /** Immutable inspect identities; raw container/image coordinates stay out of evidence. */
  readonly containerIdentityDigest: string;
  readonly imageIdentityDigest: string;
  /** Binds the privilege/device/namespace settings accepted by the host. */
  readonly securityDigest: string;
}

export interface DockerImageAttestation {
  /** Digest of the immutable local image ID; the raw execution target stays host-private. */
  readonly imageIdentityDigest: string;
}

const DOCKER_WORLD_EXECUTION_TARGETS = new WeakMap<object, string>();
const DOCKER_WORLD_IMAGE_EXECUTION_TARGETS = new WeakMap<object, string>();
const DOCKER_IMAGE_EXECUTION_TARGETS = new WeakMap<object, string>();

/** Host-only coordinate paired with an otherwise digest-only attestation.
 * The raw immutable ID never becomes a policy field or durable event. */
export function dockerWorldExecutionTarget(attestation: DockerWorldAttestation): string {
  const target = DOCKER_WORLD_EXECUTION_TARGETS.get(attestation);
  if (!target) throw new DockerSandboxConfigError("Docker world execution identity is missing");
  return target;
}

/** Host-only immutable image coordinate observed in the same inspect row as
 * the writable world. This lets sibling policies inherit its image without
 * resolving the mutable configured tag a second time. */
export function dockerWorldImageExecutionTarget(attestation: DockerWorldAttestation): string {
  const target = DOCKER_WORLD_IMAGE_EXECUTION_TARGETS.get(attestation);
  if (!target) throw new DockerSandboxConfigError("Docker world image execution identity is missing");
  return target;
}

export function dockerImageExecutionTarget(attestation: DockerImageAttestation): string {
  const target = DOCKER_IMAGE_EXECUTION_TARGETS.get(attestation);
  if (!target) throw new DockerSandboxConfigError("Docker image execution identity is missing");
  return target;
}

/** Resolve a mutable image reference to exactly one immutable local image ID. */
export function attestDockerImage(
  dockerBinary: string,
  image: string,
  hostEnv: Readonly<Record<string, string>> = dockerHostEnvironment(),
): DockerImageAttestation {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([dockerBinary, "image", "inspect", image], {
      env: { ...hostEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new DockerSandboxConfigError("Docker image attestation failed");
  }
  if ((result.exitCode ?? 1) !== 0) {
    throw new DockerSandboxConfigError("Docker image attestation failed");
  }
  let target: string;
  try {
    const rows = JSON.parse(result.stdout?.toString().trim() ?? "") as unknown;
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid image rows");
    const row = objectRecord(rows[0]);
    if (typeof row.Id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(row.Id)) {
      throw new Error("invalid image identity");
    }
    target = row.Id;
  } catch {
    throw new DockerSandboxConfigError("Docker image attestation was invalid");
  }
  const attestation = Object.freeze({
    imageIdentityDigest: createHash("sha256").update(target).digest("hex"),
  });
  DOCKER_IMAGE_EXECUTION_TARGETS.set(attestation, target);
  return attestation;
}

/** Only connection-selection values needed by the host Docker CLI survive.
 * They are used by the outer CLI process only; `docker exec/run` still starts
 * the model command under `/usr/bin/env -i`. */
export const DOCKER_HOST_ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_API_VERSION",
] as const;

export function dockerHostEnvironment(
  env: NodeJS.Dict<string> = process.env,
): Readonly<Record<string, string>> {
  const context = env.DOCKER_CONTEXT?.trim();
  if (context && context !== "default") {
    throw new DockerSandboxConfigError(
      "named Docker contexts are mutable authority; set an explicit DOCKER_HOST instead",
    );
  }
  const selected: Record<string, string> = {};
  for (const key of DOCKER_HOST_ENV_KEYS) {
    if (key === "DOCKER_CONTEXT") continue;
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new DockerSandboxConfigError("Docker host connection environment is invalid");
    }
    selected[key] = value;
  }
  // A fixed endpoint overrides config.json's mutable currentContext. Rootless
  // or remote daemons remain supported by setting DOCKER_HOST explicitly.
  selected.DOCKER_HOST = selected.DOCKER_HOST ?? "unix:///var/run/docker.sock";
  return Object.freeze(selected);
}

export function dockerHostEnvironmentDigest(env: Readonly<Record<string, string>>): string {
  return createHash("sha256")
    .update(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\0"))
    .digest("hex");
}

/** Resolve the filesystem object once before it becomes writable authority. */
export function canonicalWorkspaceRoot(workspaceRoot: string): string {
  let root: string;
  try {
    root = realpathSync(resolve(workspaceRoot));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("sandbox workspace must be an existing canonical directory");
  }
  if (root === "/") throw new Error("the filesystem root cannot be used as a sandbox workspace");
  return root;
}

/** Read-only attestation of the existing execution world's real network
 * namespace. Configuration is an expectation, never the source of truth. */
export function inspectDockerNetworkState(
  dockerBinary: string,
  container: string,
  hostEnv: Readonly<Record<string, string>> = dockerHostEnvironment(),
): "connected" | "none" {
  return networkState(inspectDockerRow(dockerBinary, container, hostEnv));
}

export function attestDockerNetworkState(
  dockerBinary: string,
  container: string,
  hostEnv: Readonly<Record<string, string>> = dockerHostEnvironment(),
): "connected" | "none" {
  const mode = inspectDockerNetworkState(dockerBinary, container, hostEnv);
  if (mode !== "connected" && mode !== "none") {
    throw new DockerSandboxConfigError("Docker network attestation returned an unsupported mode");
  }
  return mode;
}

/** Attest the complete authority boundary of an existing writable world.
 * A matching network name alone is insufficient: `/testbed` must be the
 * canonical workspace, optional linked-worktree metadata is read-only, and
 * no other host mount or privileged namespace may be present. */
export function attestDockerWorld(
  dockerBinary: string,
  container: string,
  input: {
    readonly workspaceRoot: string;
    readonly gitCommonDir?: string;
    readonly hostEnv?: Readonly<Record<string, string>>;
    readonly expectedContainer?: string;
    readonly expectedImage?: string;
  },
): DockerWorldAttestation {
  const hostEnv = input.hostEnv ?? dockerHostEnvironment();
  const row = inspectDockerRow(dockerBinary, container, hostEnv);
  const state = objectRecord(row.State);
  const running = state.Running;
  const status = state.Status;
  if (running !== true || status !== "running") {
    throw new DockerSandboxConfigError("Docker world is not a live running container");
  }
  const hostConfig = objectRecord(row.HostConfig);
  if (hostConfig.Privileged !== false) {
    throw new DockerSandboxConfigError("Docker world privileged authority is forbidden");
  }
  if (!emptyDockerList(hostConfig.CapAdd)) {
    throw new DockerSandboxConfigError("Docker world added capabilities are forbidden");
  }
  if (!emptyDockerList(hostConfig.Devices) || !emptyDockerList(hostConfig.DeviceRequests) ||
    !emptyDockerList(hostConfig.DeviceCgroupRules) || !emptyDockerList(hostConfig.SecurityOpt)) {
    throw new DockerSandboxConfigError("Docker world device or security overrides are forbidden");
  }
  const runtime = requiredDockerStringSetting(hostConfig.Runtime, "runtime");
  const cgroupnsMode = requiredDockerStringSetting(hostConfig.CgroupnsMode, "cgroup namespace");
  const usernsMode = requiredDockerStringSetting(hostConfig.UsernsMode, "user namespace");
  const cgroupParent = requiredDockerStringSetting(hostConfig.CgroupParent, "cgroup parent");
  const isolation = requiredDockerStringSetting(hostConfig.Isolation, "isolation");
  const appArmorProfile = requiredDockerStringSetting(row.AppArmorProfile, "AppArmor");
  const publishAllPorts = dockerBooleanSetting(hostConfig.PublishAllPorts, false);
  if (runtime !== "runc") {
    throw new DockerSandboxConfigError("Docker world custom runtime authority is forbidden");
  }
  if (cgroupnsMode !== "private" || usernsMode !== "" || cgroupParent !== "") {
    throw new DockerSandboxConfigError("Docker world shares forbidden cgroup or user namespace authority");
  }
  if (!emptyDockerList(hostConfig.GroupAdd) || !emptyDockerObject(hostConfig.Sysctls) ||
    !emptyDockerObject(hostConfig.Tmpfs) || isolation !== "") {
    throw new DockerSandboxConfigError("Docker world host group, sysctl, tmpfs, or isolation authority is forbidden");
  }
  if (!emptyDockerObject(hostConfig.PortBindings) || publishAllPorts) {
    throw new DockerSandboxConfigError("Docker world inbound port authority is forbidden");
  }
  if (appArmorProfile !== "" && appArmorProfile !== "docker-default") {
    throw new DockerSandboxConfigError("Docker world AppArmor authority is untrusted");
  }
  const pidMode = requiredDockerStringSetting(hostConfig.PidMode, "PID namespace");
  const ipcMode = requiredDockerStringSetting(hostConfig.IpcMode, "IPC namespace");
  const utsMode = requiredDockerStringSetting(hostConfig.UTSMode, "UTS namespace");
  if (pidMode !== "" || (ipcMode !== "" && ipcMode !== "private") || utsMode !== "") {
    throw new DockerSandboxConfigError("Docker world shares a forbidden host namespace");
  }
  const containerId = requiredDockerIdentity(row.Id, "container");
  const containerName = requiredDockerIdentity(row.Name, "container name").replace(/^\//u, "");
  if (input.expectedContainer && input.expectedContainer !== containerName &&
    !containerId.startsWith(input.expectedContainer)) {
    throw new DockerSandboxConfigError("Docker world container does not match the sealed request");
  }
  const imageId = requiredDockerIdentity(row.Image, "image");
  const config = objectRecord(row.Config);
  const configuredImage = requiredDockerIdentity(config.Image, "configured image");
  if (input.expectedImage && input.expectedImage !== configuredImage && input.expectedImage !== imageId) {
    throw new DockerSandboxConfigError("Docker world image does not match the sealed request");
  }

  const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
  const gitCommonDir = input.gitCommonDir ? realpathDirectory(input.gitCommonDir) : undefined;
  const expected = [
    { source: workspaceRoot, destination: "/testbed", writable: true, propagation: "rprivate" },
    ...(gitCommonDir
      ? [{ source: gitCommonDir, destination: gitCommonDir, writable: false, propagation: "rprivate" }]
      : []),
  ].sort((a, b) => a.destination.localeCompare(b.destination));
  const rawMounts = row.Mounts;
  if (!Array.isArray(rawMounts)) {
    throw new DockerSandboxConfigError("Docker world mount attestation was missing");
  }
  const actual = rawMounts.map((raw) => {
    const mount = objectRecord(raw);
    const propagation = requiredDockerStringSetting(mount.Propagation, "mount propagation");
    if (mount.Type !== "bind" || typeof mount.Source !== "string" ||
      typeof mount.Destination !== "string" || typeof mount.RW !== "boolean" ||
      propagation !== "rprivate") {
      throw new DockerSandboxConfigError("Docker world contains an unsupported mount");
    }
    return {
      source: realpathDirectory(mount.Source),
      destination: mount.Destination,
      writable: mount.RW,
      propagation,
    };
  }).sort((a, b) => a.destination.localeCompare(b.destination));
  if (actual.length !== expected.length || actual.some((mount, index) => {
    const wanted = expected[index];
    return !wanted || mount.source !== wanted.source ||
      mount.destination !== wanted.destination || mount.writable !== wanted.writable ||
      mount.propagation !== wanted.propagation;
  })) {
    throw new DockerSandboxConfigError("Docker world mounts do not match the canonical workspace authority");
  }
  const mountDigest = createHash("sha256")
    .update(JSON.stringify(expected))
    .digest("hex");
  const containerIdentityDigest = createHash("sha256").update(containerId).digest("hex");
  const imageIdentityDigest = createHash("sha256").update(imageId).digest("hex");
  const securityDigest = createHash("sha256")
    .update(JSON.stringify({
      privileged: false,
      running,
      status,
      capabilities: [],
      devices: [],
      deviceRequests: [],
      deviceCgroupRules: [],
      securityOpt: [],
      runtime,
      cgroupnsMode,
      usernsMode,
      cgroupParent,
      groupAdd: [],
      sysctls: {},
      tmpfs: {},
      portBindings: {},
      publishAllPorts,
      isolation,
      appArmorProfile,
      mountPropagation: actual.map((mount) => mount.propagation),
      pidMode,
      ipcMode,
      utsMode,
    }))
    .digest("hex");
  const attestation = Object.freeze({
    networkState: networkState(row),
    mountDigest,
    containerIdentityDigest,
    imageIdentityDigest,
    securityDigest,
  });
  DOCKER_WORLD_EXECUTION_TARGETS.set(attestation, containerId);
  DOCKER_WORLD_IMAGE_EXECUTION_TARGETS.set(attestation, imageId);
  return attestation;
}

function requiredDockerIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new DockerSandboxConfigError(`Docker ${label} identity is missing`);
  }
  return value;
}

function inspectDockerRow(
  dockerBinary: string,
  container: string,
  hostEnv: Readonly<Record<string, string>>,
): Record<string, unknown> {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([dockerBinary, "inspect", container], {
      env: { ...hostEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new DockerSandboxConfigError("Docker world attestation failed");
  }
  if ((result.exitCode ?? 1) !== 0) {
    throw new DockerSandboxConfigError("Docker world attestation failed");
  }
  try {
    const rows = JSON.parse(result.stdout?.toString().trim() ?? "") as unknown;
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("invalid inspect rows");
    return objectRecord(rows[0]);
  } catch {
    throw new DockerSandboxConfigError("Docker world attestation was invalid");
  }
}

function networkState(row: Record<string, unknown>): "connected" | "none" {
  try {
    const hostConfig = objectRecord(row.HostConfig);
    const networkSettings = objectRecord(row.NetworkSettings);
    const networks = objectRecord(networkSettings.Networks);
    const mode = typeof hostConfig.NetworkMode === "string" ? hostConfig.NetworkMode.trim() : "";
    const names = Object.keys(networks).sort();
    if (mode === "none") {
      if (names.length === 1 && names[0] === "none") return "none";
      throw new Error("contradictory none network state");
    }
    if (!mode || mode === "host" || mode.startsWith("container:")) {
      throw new Error("unsupported Docker network namespace");
    }
    if (names.length === 0 || names.includes("none") || names.includes("host")) {
      throw new Error("missing or contradictory Docker endpoints");
    }
    const expected = mode === "default" ? "bridge" : mode;
    if (!names.includes(expected)) throw new Error("Docker mode and endpoints disagree");
    return "connected";
  } catch {
    throw new DockerSandboxConfigError("Docker network attestation was invalid");
  }
}

function emptyDockerList(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function emptyDockerObject(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function requiredDockerStringSetting(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new DockerSandboxConfigError(`Docker world ${label} security setting was missing or invalid`);
  }
  return value;
}

function dockerBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new DockerSandboxConfigError("Docker world security setting was invalid");
  }
  return value;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function realpathDirectory(path: string): string {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error("not directory");
    return canonical;
  } catch {
    throw new DockerSandboxConfigError("Docker world mount source is invalid");
  }
}

/** Return the common Git directory only for a real linked-worktree record.
 * A repository-controlled `.git` text file is not authority by itself: the
 * metadata directory must point back to this exact worktree and live beneath
 * the resolved common directory's `worktrees/` namespace. */
export function worktreeCommonGitDir(workspaceRoot: string): string | undefined {
  return trustedGitMetadata(workspaceRoot)?.commonDir;
}

export interface TrustedGitMetadata {
  readonly gitDir: string;
  readonly commonDir?: string;
}

export function trustedGitMetadata(workspaceRoot: string): TrustedGitMetadata | undefined {
  let root: string;
  let dotGit: string;
  try {
    root = canonicalWorkspaceRoot(workspaceRoot);
    dotGit = join(root, ".git");
    const entry = lstatSync(dotGit);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const gitDir = realpathDirectory(dotGit);
      return gitDir === dotGit ? Object.freeze({ gitDir }) : undefined;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }

  let gitDir: string;
  let commonDir: string;
  try {
    const line = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/u.exec(line);
    if (!match?.[1]) return undefined;
    gitDir = realpathDirectory(resolve(root, match[1]));

    const backlink = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
    if (!backlink || resolve(gitDir, backlink) !== dotGit) return undefined;

    const relativeCommonDir = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (!relativeCommonDir) return undefined;
    commonDir = realpathDirectory(resolve(gitDir, relativeCommonDir));
    const worktreesRoot = realpathDirectory(join(commonDir, "worktrees"));
    if (!pathWithin(worktreesRoot, gitDir) || gitDir === worktreesRoot) return undefined;
  } catch {
    return undefined;
  }
  return Object.freeze({ gitDir, commonDir });
}

export function hasTrustedGitMetadata(workspaceRoot: string): boolean {
  return trustedGitMetadata(workspaceRoot) !== undefined;
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
