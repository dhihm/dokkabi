import { EXEC_MARKER_ENV } from "./live-writers.ts";
import {
  beginExecutionMembership,
  endExecutionMembership,
  EXECUTION_CAPABILITY_ENV,
  EXECUTION_CAPABILITY_PARAM,
  type ExecutionMembership,
} from "./execution-membership.ts";
import { hostOwnedSessionDir, registerSessionPolicy } from "./writable-world.ts";
import { acquireJudgedToolCache, acquireSessionToolCache, isJudgedToolCache, renewJudgedToolCache } from "./tool-cache.ts";
import { hostOwnedDenials, recordHostOwnedExposure } from "./host-owned.ts";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { acceleratorBindArgs, acceleratorDevicePaths } from "./sandbox-accelerator.ts";
import { proxyEnvironment } from "./sandbox-proxy.ts";
import type { EventLog } from "./event-log.ts";
import {
  attestDockerImage,
  attestDockerWorld,
  canonicalWorkspaceRoot,
  dockerHostEnvironment,
  dockerHostEnvironmentDigest,
  dockerImageExecutionTarget,
  dockerWorldImageExecutionTarget,
  dockerWorldExecutionTarget,
  worktreeCommonGitDir,
} from "./sandbox-docker.ts";
import {
  SANDBOX_BUN_BIN,
  createSandboxEnvironment,
  SANDBOX_DOKKABI_HOME,
  sandboxEnvironmentDigest,
} from "./sandbox-env.ts";
import {
  assertSandboxExecutableIdentity,
  findAndSealSandboxExecutable,
  requireAndSealSandboxExecutable,
  type SandboxHostExecutableSeal,
} from "./sandbox-executable.ts";
import {
  attestSeatbeltPolicy,
  seatbeltArgvUnchecked,
  seatbeltCapabilityDir,
  seatbeltProfile,
  seatbeltUnassignedCapability,
  seatbeltWritableRoots,
} from "./sandbox-seatbelt.ts";
import {
  homeMirrorBwrapArgs,
  materializeHomeMirrors,
  planHomeMirrors,
} from "./sandbox-home-mirror.ts";
import { toolchainRoots } from "./sandbox-toolchain.ts";
import { readConfig } from "./config.ts";
import type { EventInput, EventRecord } from "./schema.ts";
import { redactText } from "./redact.ts";
import { assertMaterializedExecutionImage, within, type MaterializedExecutionImage } from "./execution-image.ts";

export type SandboxMode = "workspace-write" | "read-only" | "envfix";
export type SandboxBackend = "bwrap" | "seatbelt" | "docker" | "none";
export type SandboxNetwork = "allow" | "deny";
export type DockerNetworkState = "connected" | "none";

export const PROTECTED_OBSERVER_ISOLATION = "protected-observer-v1" as const;
export const MAX_SANDBOX_STDIN_BYTES = 2 * 1024 * 1024;
export const MAX_SANDBOX_OBSERVER_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  readonly backend: SandboxBackend;
  /** Host-enrolled observer execution; never inferred from candidate output. */
  readonly observerIsolation?: typeof PROTECTED_OBSERVER_ISOLATION;
  /**
   * Narrow exceptions to a read-only policy: absolute paths a phase is
   * entitled to write even though the workspace as a whole is sealed. The
   * decompose sibling uses this for the ledger and the RED tests, which that
   * turn is required to produce (createReadOnlyPolicyFrom).
   */
  readonly writablePaths?: readonly string[];
  /**
   * The session's scratch space (D48): a canonical directory OUTSIDE the
   * workspace that a writable world may also write, exported to the child as
   * DOKKABI_SCRATCH. Set only for a ledger session's own tools and the host's
   * observations of its cases; never on a read-only, observer or Docker
   * policy (the Docker world cannot see a host path). Absent, the policy and
   * its digest are exactly what they were before scratch existed.
   */
  readonly scratchRoot?: string;
  /**
   * A read-only view of the scratch (D58b V4): when present, the scratch is
   * bound READ-ONLY except these directories below it — canonical, real,
   * strictly beneath `scratchRoot` — which stay writable. One property
   * execution's policy carries its own case directory and output capture
   * directory here, so nothing it writes into the scratch outside them — and
   * nothing it writes there, which the host removes or holds before the next
   * execution — is readable to a later execution. Absent, the whole scratch
   * is writable and the policy digests exactly as before.
   */
  readonly scratchWritable?: readonly string[];
  /**
   * Accelerator device nodes bound back into the sandbox world. `--dev` mounts
   * a fresh minimal devtmpfs with none of them, so without this a driver
   * inside the sandbox finds no device and the machine's own GPU is
   * unreachable to the machine's own work (sandbox-accelerator.ts). Discovered
   * by presence; empty on a machine with no accelerator.
   */
  readonly devicePaths?: readonly string[];
  readonly dockerContainer?: string;
  readonly dockerImage?: string;
  /** Attested effective connectivity of an existing Docker world. */
  readonly dockerNetworkState?: DockerNetworkState;
  /** Digest of the exact `/testbed` and optional Git metadata mount set. */
  readonly dockerMountDigest?: string;
  readonly dockerContainerIdentityDigest?: string;
  readonly dockerImageIdentityDigest?: string;
  readonly dockerSecurityDigest?: string;
  /** Outer Docker CLI connection selection; never enters the container. */
  readonly dockerHostEnv?: Readonly<Record<string, string>>;
  readonly dockerHostEnvDigest?: string;
  /** Host-resolved executable; it is digest-only in durable evidence. */
  readonly dockerBinary?: string;
  /** Host-resolved bwrap executable; ambient PATH is never consulted. */
  readonly bwrapBinary?: string;
  /** Host-resolved sandbox-exec; ambient PATH is never consulted. */
  readonly seatbeltBinary?: string;
  /** Host-private HOME provisioned for exactly one Seatbelt policy. */
  readonly sandboxHome?: string;
  /** Host-private temporary directory provisioned for one Seatbelt policy. */
  readonly sandboxTemp?: string;
  /** Content/stat identity rechecked immediately before every execution seam. */
  readonly backendExecutableIdentity: string;
  /** Fast immutable stat tuple paired with the content identity. */
  readonly backendExecutableStatIdentity: string;
  /** Exact runtime executable made visible through the minimal bwrap root. */
  readonly runtimeExecutable: string;
  /** Digest of the host-generated minimal passwd/group view. */
  readonly sandboxIdentityDigest?: string;
  /** Linked-worktree metadata mount, when needed; digest-only in evidence. */
  readonly gitCommonDir?: string;
  /** Host-enrolled structured Git tools only; generic bash keeps metadata read-only. */
  readonly gitCommonDirWritable?: true;
  /**
   * Host-owned locations inside the workspace (W2, D57g): the session's own
   * directory when the layout puts it under the workspace (the SWE-bench
   * adapter's `.dokkabi-home`). The session may read them and never write
   * them: Seatbelt denies file-write* below them after the workspace's
   * allow, bwrap binds them read-only over the writable workspace bind.
   */
  readonly hostOwnedPaths?: readonly string[];
  /**
   * G3 (D57g): the session's tool-cache directory (tool-cache.ts) — one per
   * session and tree, outside the tree, in a host-owned holder. Present only
   * on a writable policy of a session over its own tree (`toolCache:
   * "session"`); the execution may read and write it and nothing else in
   * its holder. G3' (D57h): on a judged policy (`toolCache: "judged"`) it
   * is instead a directory of that policy alone, emptied by the host before
   * and after every execution (tool-cache.ts renewJudgedToolCache).
   */
  readonly toolCacheDir?: string;
  /** Complete allowlisted child environment. Never inherited at execution. */
  readonly childEnv: Readonly<Record<string, string>>;
  /** Network policy sealed when this session policy is created. */
  readonly networkDenied: boolean;
  /**
   * Operator toolchain roots readable and executable inside the world
   * (sandbox-toolchain.ts). Sealed at creation like the network value; empty
   * under DOKKABI_SANDBOX_TOOLCHAIN=deny and for Docker, whose image is the
   * toolchain.
   */
  readonly toolchainRoots: readonly string[];
  /**
   * Roots the sandbox home mirrors as symlinks at their home-relative paths,
   * so the `~/…` spellings durable records carry resolve inside the sandbox
   * (sandbox-home-mirror.ts). Sealed at creation; empty when no bound root
   * lies under the operator's real home.
   */
  readonly homeMirrorRoots: readonly string[];
  /** Roots not mirrored and why (`<reason>:<root>`); part of the digest. */
  readonly homeMirrorSkipped: readonly string[];
  /**
   * The operator switched the kernel fence off for this session
   * (sandboxDisabled). The backend is `none`, the child runs with the
   * operator's own environment, and every sandbox/policy and sandbox/exec
   * row says so — the fence is gone, the label is not.
   */
  readonly disabled?: true;
}

/** The environment variable that switches the kernel fence off: on|off. */
export const SANDBOX_SWITCH_ENV = "DOKKABI_SANDBOX";

/**
 * Whether this process runs its children unfenced.
 *
 * "No loop without a sandbox" (issue #6) was written for a machine with a
 * backend. On a laptop without bwrap it meant no loop at all, and on a Mac it
 * meant a world where the operator's toolchain did not exist — so the
 * operator asked for the switch. The precedence is the flag (which sets the
 * variable), then the variable, then `sandbox.disabled` in the config file.
 * The choice is recorded in every policy row; it is never silent.
 */
export function sandboxDisabled(
  env: NodeJS.Dict<string> = process.env,
  configured: () => boolean | undefined = () => readConfig().sandbox?.disabled,
): boolean {
  const value = env[SANDBOX_SWITCH_ENV]?.trim().toLowerCase();
  if (value && value !== "on" && value !== "off") {
    throw new Error(`${SANDBOX_SWITCH_ENV} must be on or off`);
  }
  if (value === "off") return true;
  if (value === "on") return false;
  try {
    return configured() === true;
  } catch {
    return false;
  }
}

const HOST_SEALED_SANDBOX_POLICIES = new WeakSet<object>();
const HOST_PREPARED_SANDBOX_EXECUTIONS = new WeakMap<object, SandboxPolicy>();
const HOST_SEALED_DOCKER_EXECUTION_TARGETS = new WeakMap<object, string>();
const HOST_SEALED_DOCKER_IMAGE_TARGETS = new WeakMap<object, string>();
const HOST_PRIVATE_CACHE_ROOTS = new WeakMap<object, PrivateCacheRoot>();
/** The lease on the session's tool-cache directory a policy holds (G3). */
const HOST_TOOL_CACHE_LEASES = new WeakMap<object, () => void>();
const HOST_SANDBOX_IDENTITIES = new WeakMap<object, SandboxIdentityFiles>();
const HOST_SANDBOX_IDENTITY_ROOTS = new Set<string>();
const HOST_SEATBELT_RUNTIME_ROOTS = new Set<string>();
const HOST_EXECUTION_VIEWS = new WeakMap<object, MaterializedExecutionImage>();
/** LX (D58c): the scratch view's directories as the policy sealed them — the
 * scratch root and each writable directory below it, by device and inode — so
 * every spawn binds or names exactly those (assertScratchViewUnchanged). */
const HOST_SCRATCH_VIEWS = new WeakMap<object, readonly { readonly path: string; readonly dev: number; readonly ino: number }[]>();

interface SandboxIdentityFiles {
  readonly root: string;
  readonly passwd: string;
  readonly group: string;
  readonly digest: string;
}

interface PrivateCacheRoot {
  readonly path: string;
  readonly identity: string;
  readonly label: string;
}

interface SeatbeltRuntime {
  readonly root: string;
  readonly home: string;
  readonly temp: string;
}

process.once("exit", () => {
  for (const root of HOST_SANDBOX_IDENTITY_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
  HOST_SANDBOX_IDENTITY_ROOTS.clear();
  for (const root of HOST_SEATBELT_RUNTIME_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
  HOST_SEATBELT_RUNTIME_ROOTS.clear();
});

function createSeatbeltRuntime(): SeatbeltRuntime {
  const root = mkdtempSync(join(tmpdir(), "dokkabi-seatbelt-session-"));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  try {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(temp, { mode: 0o700 });
    HOST_SEATBELT_RUNTIME_ROOTS.add(root);
    return { root, home, temp };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function disposeSeatbeltRuntime(root: string): void {
  HOST_SEATBELT_RUNTIME_ROOTS.delete(root);
  rmSync(root, { recursive: true, force: true });
}

export function disposeSandboxPolicy(policy: SandboxPolicy): void {
  if (!HOST_SEALED_SANDBOX_POLICIES.delete(policy)) return;
  HOST_EXECUTION_VIEWS.delete(policy);
  HOST_SEALED_DOCKER_EXECUTION_TARGETS.delete(policy);
  HOST_SEALED_DOCKER_IMAGE_TARGETS.delete(policy);
  HOST_PRIVATE_CACHE_ROOTS.delete(policy);
  HOST_TOOL_CACHE_LEASES.get(policy)?.();
  HOST_TOOL_CACHE_LEASES.delete(policy);
  const identity = HOST_SANDBOX_IDENTITIES.get(policy);
  if (identity) {
    HOST_SANDBOX_IDENTITIES.delete(policy);
    disposeSandboxIdentity(identity);
  }
  if (policy.backend === "seatbelt" && policy.sandboxHome) {
    disposeSeatbeltRuntime(dirname(policy.sandboxHome));
  }
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type ProtectedObserverBoundary = Readonly<{
  schema_version: 1;
  network: "deny";
  isolation: typeof PROTECTED_OBSERVER_ISOLATION;
} & (
  | { backend: "seatbelt"; mechanism: "seatbelt-profile"; content: string }
  | { backend: "bwrap"; mechanism: "bwrap-argv"; content: readonly string[] }
)>;

export interface PreparedSandboxExecution {
  readonly network: SandboxNetwork;
  readonly digest: string;
  readonly observerIsolation?: typeof PROTECTED_OBSERVER_ISOLATION;
  /** Full digest of the executed Seatbelt profile or native namespace argv. */
  readonly observerIsolationDigest?: string;
  /** Exact private boundary captured before the execution effect is recorded. */
  readonly observerBoundary?: ProtectedObserverBoundary;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Opt-in lossless streams for host comparators; text remains presentation. */
  stdoutBase64?: string;
  stderrBase64?: string;
  /** Preserve a missing exit status instead of misreading normalized exit one as assertion failure. */
  rawExitCode?: number | null;
  signal?: string;
  error?: string;
  timedOut?: true;
  maxBufferExceeded?: true;
  /** A process-supervising backend returned a status that cannot establish child completion. */
  completionUnavailable?: true;
  /** P1: how many processes of the execution's tree the host could not end
   * once it was over (0 is never recorded). An execution whose tree survived
   * is not over, so it is never judged. */
  survivors?: number;
}

export type SandboxExecutionEvidence =
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly argsDigest: string;
    }
  | {
      readonly kind: "direct";
      readonly commandDigest: string;
    }
  | {
      readonly kind: "workspace-bash";
      readonly background: boolean;
      readonly handle?: string;
      readonly observer?: "bash_wait" | "bash_probe";
      readonly probeId?: string;
      readonly attempt?: number;
    };

/** Detect the isolation backend this platform can offer. */
export function detectBackend(workspaceRoot = process.cwd()): SandboxBackend {
  if (process.platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec") ? "seatbelt" : "none";
  }
  return findAndSealSandboxExecutable("bwrap", [resolve(workspaceRoot)]) ? "bwrap" : "none";
}

/**
 * Resolve ambient sandbox authority without letting an unrelated stale Docker
 * coordinate replace the ordinary macOS Seatbelt world. Evaluator and bound
 * swarm children carry typed authority; explicit caller choices remain exact.
 */
export function resolveSandboxBackendAuthority(input: {
  readonly platform?: NodeJS.Platform;
  readonly requestedBackend?: SandboxBackend;
  readonly requestedContainer?: string;
  readonly localBackend?: SandboxBackend;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): { readonly backend: SandboxBackend; readonly container?: string } {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const requestedContainer = nonempty(input.requestedContainer);
  const genericContainer = nonempty(env.DOKKABI_DOCKER_CONTAINER);
  const evaluatorContainer = nonempty(env.DOKKABI_SWE_CONTAINER);

  if (input.requestedBackend) {
    if (input.requestedBackend !== "docker") return { backend: input.requestedBackend };
    const container = requestedContainer ?? genericContainer ?? evaluatorContainer;
    return container ? { backend: "docker", container } : { backend: "docker" };
  }
  if (requestedContainer) return { backend: "docker", container: requestedContainer };
  if (genericContainer && nonempty(env.DOKKABI_PARENT_SESSION) && nonempty(env.DOKKABI_SWARM_ROLE)) {
    return { backend: "docker", container: genericContainer };
  }
  if (genericContainer && platform !== "darwin") {
    return { backend: "docker", container: genericContainer };
  }
  if (evaluatorContainer) return { backend: "docker", container: evaluatorContainer };
  return { backend: input.localBackend ?? detectBackend() };
}

/**
 * The sandbox is the world, not an option: creating a policy without an
 * available backend fails closed (issue #6: no loop without a sandbox).
 */
/** Every HOST root a policy lets a session write (#230 K1''): the
 * workspace or the sealed writable paths, the scratch (or its writable
 * directories in a read-only view), the tool cache, and — on Seatbelt — the
 * sandbox home and temp. A bwrap policy's home and temp are paths inside the
 * execution's private /tmp, never the host's. */
function policyWritableRoots(policy: SandboxPolicy): string[] {
  const writable = policy.mode !== "read-only";
  const hostHomeAndTemp = policy.backend !== "bwrap" && policy.backend !== "docker";
  return [
    ...(writable ? [policy.workspaceRoot] : (policy.writablePaths ?? [])),
    ...(writable && policy.gitCommonDirWritable && policy.gitCommonDir ? [policy.gitCommonDir] : []),
    ...(writable && policy.scratchRoot !== undefined ? (policy.scratchWritable ?? [policy.scratchRoot]) : []),
    ...(writable && policy.toolCacheDir !== undefined ? [policy.toolCacheDir] : []),
    ...(hostHomeAndTemp && policy.sandboxHome !== undefined ? [policy.sandboxHome] : []),
    ...(hostHomeAndTemp && policy.sandboxTemp !== undefined ? [policy.sandboxTemp] : []),
  ];
}

const depthOf = (path: string) => path.split("/").length;

/**
 * bwrap has no deny rule: what a session may not write is bound read-only,
 * and a mount point cannot be renamed (EBUSY), so a pinned directory can
 * neither be moved away nor replaced. Placed after every writable bind, from
 * the widest to the narrowest — a later mount covers every earlier one below
 * it — so each only narrows: every directory between a writable root and a
 * host-owned path is pinned at its own path (writable where it was, read-only
 * inside the sessions area), the sessions area and the configuration file are
 * bound read-only, and a writable root inside a read-only area (a ledger
 * scratch under sessions/) is bound writable again. The key directories are
 * masked afterwards (bwrapHostOwnedMasks), last of all.
 */
function bwrapHostOwnedPins(denials: ReturnType<typeof hostOwnedDenials>): string[] {
  const mounts = new Map<string, "--bind" | "--ro-bind">();
  for (const path of denials.literals) {
    if (!existsSync(path)) continue;
    const readOnly = !lstatSync(path).isDirectory() || denials.writeSubpaths.some((area) => pathWithin(area, path));
    mounts.set(path, readOnly ? "--ro-bind" : "--bind");
  }
  for (const path of denials.writeSubpaths) if (existsSync(path)) mounts.set(path, "--ro-bind");
  return [
    ...[...mounts].sort(([a], [b]) => depthOf(a) - depthOf(b)).flatMap(([path, kind]) => [kind, path, path]),
    ...denials.regrants.filter((path) => existsSync(path)).flatMap((path) => ["--bind", path, path]),
  ];
}

/** The key directories, each under an empty private tmpfs: the last mounts
 * of the world, so no bind above — a pinned ancestor, a regrant, a host-owned
 * location — can show what is beneath. Masks only remove exposure. */
function bwrapHostOwnedMasks(denials: ReturnType<typeof hostOwnedDenials>): string[] {
  return [...denials.subpaths].filter((path) => existsSync(path)).sort((a, b) => depthOf(a) - depthOf(b)).flatMap((path) => ["--tmpfs", path]);
}

export function createPolicy(input: {
  mode: SandboxMode;
  workspaceRoot: string;
  backend?: SandboxBackend;
  /** Only the structured Git provider may request linked metadata writes. */
  gitMetadataWrite?: boolean;
  /** A separate native policy for a host-controlled protected observer. */
  observerIsolation?: true;
  dockerContainer?: string;
  dockerImage?: string;
  dockerNetworkState?: DockerNetworkState;
  /** Narrow write exceptions for a sealed phase; see SandboxPolicy. */
  writablePaths?: readonly string[];
  /** The session's scratch space (D48); see SandboxPolicy.scratchRoot. */
  scratchRoot?: string;
  /** The scratch read-only except these directories (D58b); see
   * SandboxPolicy.scratchWritable. Requires `scratchRoot`. */
  scratchWritable?: readonly string[];
  /** Startup attestation evidence sink. The probe still runs when omitted. */
  log?: EventLog;
  /**
   * G3 (D57g): `"session"` — this policy runs the session's executions on
   * its own tree and shares the session's tool-cache directory for that
   * tree (tool-cache.ts). G3' (D57h): `"judged"` — this policy runs a run
   * the host judges (the final case pass, the base pass, the verify step,
   * a recheck, a verifier copy, a managed checker): a fresh tool-cache
   * directory of its own, empty at the start of every execution, never one
   * a session execution could write. Omitted, an observation: its caches
   * stay in its own home, never the session's.
   */
  toolCache?: "session" | "judged";
}): SandboxPolicy {
  const policy = createPolicyWithAuthority(input);
  // Part of that session's writable world (W, D57g).
  if (input.log !== undefined) registerSessionPolicy(input.log, policy);
  // A writable root that contains the doctor's key directory or the
  // configuration file exposes it: the key is unavailable, the file not
  // believed, from now on (host-owned.ts, #230 K1, K1'').
  recordHostOwnedExposure(policyWritableRoots(policy));
  return policy;
}

type PolicyInput = Parameters<typeof createPolicy>[0];

/** A host-only view is a new sealed policy, never an argv rewrite after seal.
 * Other native backends must supply equivalent namespace semantics first. */
export function createExecutionViewPolicyFrom(base: SandboxPolicy, image: MaterializedExecutionImage): SandboxPolicy {
  assertSandboxPolicyEnforceable(base);
  if (process.platform !== "linux" || base.backend !== "bwrap" || base.disabled || base.observerIsolation ||
    base.mode !== "workspace-write" || HOST_PRIVATE_CACHE_ROOTS.has(base) || HOST_EXECUTION_VIEWS.has(base)) {
    throw new Error("execution_view_backend_unsupported");
  }
  assertMaterializedExecutionImage(image);
  const targets = [base.workspaceRoot, ...(base.gitCommonDir && !within(base.workspaceRoot, base.gitCommonDir) ? [base.gitCommonDir] : [])];
  if (image.workspace !== base.workspaceRoot || JSON.stringify(image.mappings.map(row => row.target)) !== JSON.stringify(targets)) throw new Error("execution_view_mapping_mismatch");
  const system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/dev", SANDBOX_DOKKABI_HOME, SANDBOX_BUN_BIN, ...base.toolchainRoots];
  for (const mapping of image.mappings) {
    if (system.some(root => within(root, mapping.target) || within(mapping.target, root) || within(root, mapping.source)) ||
      within(mapping.target, base.runtimeExecutable)) throw new Error("execution_view_mount_overlap");
  }
  const identity = createSandboxIdentityFiles();
  const policy = Object.freeze({ ...base, sandboxIdentityDigest: identity.digest });
  HOST_SANDBOX_IDENTITIES.set(policy, identity);
  HOST_EXECUTION_VIEWS.set(policy, image);
  HOST_SEALED_SANDBOX_POLICIES.add(policy);
  return policy;
}

export function executionViewBoundary(policy: SandboxPolicy): readonly string[] {
  if (!HOST_EXECUTION_VIEWS.has(policy)) throw new Error("execution_view_policy_missing");
  return Object.freeze(bwrapArgv(policy, []));
}

interface DerivedDockerImageAuthority {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly imageTarget: string;
  readonly imageIdentityDigest: string;
}

/**
 * What a sealed decompose turn may still write.
 *
 * That turn is required to produce a plan and its RED tests, and is meant to
 * do so through the write/edit tools — which are built only where the
 * descriptor-anchored tool set is. Everywhere else the turn had no way to
 * write at all: the tools were absent and the shell was refused with
 * "Operation not permitted". A live campaign died there three times, the model
 * trying redirection, then echo, then tee, before the run ended with no plan.
 *
 * A phase's authority belongs to the phase, not to the host it runs on, so the
 * limit the mutation guard applies — writes confined to tests/ and work/ —
 * lives here as well.
 */
export function decomposeWritablePaths(workspaceRoot: string): readonly string[] {
  const root = resolve(workspaceRoot);
  return [join(root, "work"), join(root, "tests")];
}

/** Create the decompose/read-only sibling of an already sealed policy.
 * Docker siblings inherit the writable world's host-private immutable image
 * coordinate and sealed daemon/executable authority; the raw ID never enters
 * either policy fields or EventLog facts. */
export function createReadOnlyPolicyFrom(policy: SandboxPolicy): SandboxPolicy {
  assertSandboxPolicyEnforceable(policy);
  if (policy.mode === "read-only") return policy;
  if (policy.backend !== "docker") {
    return createPolicy({
      mode: "read-only",
      workspaceRoot: policy.workspaceRoot,
      backend: policy.backend,
      ...(policy.observerIsolation
        ? { observerIsolation: true }
        : { writablePaths: decomposeWritablePaths(policy.workspaceRoot) }),
    });
  }
  const imageTarget = HOST_SEALED_DOCKER_IMAGE_TARGETS.get(policy);
  if (!imageTarget || !policy.dockerImage || !policy.dockerImageIdentityDigest || !policy.dockerHostEnv) {
    throw new Error("Docker image derivation authority is incomplete");
  }
  return createPolicyWithAuthority({
    mode: "read-only",
    workspaceRoot: policy.workspaceRoot,
    backend: "docker",
    dockerImage: policy.dockerImage,
  }, {
    executable: policyExecutableSeal(policy),
    hostEnv: policy.dockerHostEnv,
    imageTarget,
    imageIdentityDigest: policy.dockerImageIdentityDigest,
  });
}

export function createPrivateCachePolicyFrom(policy: SandboxPolicy, cacheRoot: string): SandboxPolicy {
  assertSandboxPolicyEnforceable(policy);
  if (policy.observerIsolation) throw new Error("protected observer isolation cannot expose a host private cache");
  const cache = sealPrivateCacheRoot(policy.workspaceRoot, cacheRoot);
  const input: PolicyInput = {
    mode: "read-only",
    workspaceRoot: policy.workspaceRoot,
    backend: policy.backend,
    writablePaths: [cache.path],
  };
  let derived: SandboxPolicy;
  if (policy.backend !== "docker") {
    derived = createPolicy(input);
  } else {
    const imageTarget = HOST_SEALED_DOCKER_IMAGE_TARGETS.get(policy);
    if (!imageTarget || !policy.dockerImage || !policy.dockerHostEnv) {
      throw new Error("Docker private cache authority is incomplete");
    }
    derived = createPolicyWithAuthority({ ...input, dockerImage: policy.dockerImage }, {
      executable: policyExecutableSeal(policy),
      hostEnv: policy.dockerHostEnv,
      imageTarget,
      imageIdentityDigest: policy.dockerImageIdentityDigest ?? "",
    });
  }
  HOST_PRIVATE_CACHE_ROOTS.set(derived, cache);
  return derived;
}

export function privateCachePolicyLabel(policy: SandboxPolicy): string | undefined {
  return HOST_PRIVATE_CACHE_ROOTS.get(policy)?.label;
}

function createPolicyWithAuthority(
  input: PolicyInput,
  derivedDockerImage?: DerivedDockerImageAuthority,
): SandboxPolicy {
  const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
  if (input.observerIsolation && (input.writablePaths?.length || input.dockerContainer || input.dockerImage || input.scratchRoot)) {
    throw new Error("protected observer isolation cannot expose external writes or Docker worlds");
  }
  if (input.scratchRoot !== undefined) assertScratchRoot(input.scratchRoot, workspaceRoot);
  if (input.scratchWritable !== undefined) assertScratchWritable(input.scratchWritable, input.scratchRoot);
  if (
    !input.observerIsolation
    && !derivedDockerImage
    && !input.dockerContainer
    && (input.backend === undefined || input.backend === "none")
    && sandboxDisabled()
  ) {
    return sealDisabledPolicy(input, workspaceRoot);
  }
  const authority = input.observerIsolation
    ? { backend: input.backend ?? detectBackend(workspaceRoot), container: undefined }
    : derivedDockerImage
    ? { backend: "docker" as const }
    : resolveSandboxBackendAuthority({
        requestedBackend: input.backend,
        requestedContainer: input.dockerContainer,
        localBackend: detectBackend(workspaceRoot),
      });
  const container = authority.container;
  const image = input.dockerImage ?? process.env.DOKKABI_DOCKER_IMAGE ?? process.env.DOKKABI_SWE_IMAGE;
  const configuredDockerNetwork = input.dockerNetworkState ?? process.env.DOKKABI_DOCKER_NETWORK_STATE;
  const gitCommonDir = input.observerIsolation ? undefined : worktreeCommonGitDir(workspaceRoot);
  if (input.gitMetadataWrite && (input.mode === "read-only" || input.observerIsolation)) {
    throw new Error("Git metadata writes require a writable non-observer policy");
  }
  const writableRoots = [workspaceRoot, ...(gitCommonDir ? [gitCommonDir] : [])];
  const backend = authority.backend;
  const gitCommonDirWritable = input.gitMetadataWrite === true && gitCommonDir !== undefined &&
    (backend === "seatbelt" || backend === "bwrap");
  if (input.observerIsolation && !(
    (process.platform === "darwin" && backend === "seatbelt") ||
    (process.platform === "linux" && backend === "bwrap")
  )) {
    throw new Error("protected observer isolation requires native Seatbelt on macOS or bubblewrap on Linux");
  }
  if (backend === "none") {
    throw new Error(
      "no sandbox backend available (bwrap on Linux, sandbox-exec on macOS); refusing to open a session without a sandbox",
    );
  }
  const backendExecutable = derivedDockerImage?.executable ?? (
    backend === "docker" || backend === "bwrap" || backend === "seatbelt"
      ? requireAndSealSandboxExecutable(backend, writableRoots)
      : undefined
  );
  const dockerBinary = backend === "docker" ? backendExecutable!.path : undefined;
  const bwrapBinary = backend === "bwrap" ? backendExecutable!.path : undefined;
  const seatbeltBinary = backend === "seatbelt" ? backendExecutable!.path : undefined;
  let dockerNetworkState: DockerNetworkState | undefined;
  let dockerMountDigest: string | undefined;
  let dockerContainerIdentityDigest: string | undefined;
  let dockerImageIdentityDigest: string | undefined;
  let dockerSecurityDigest: string | undefined;
  let dockerExecutionTarget: string | undefined;
  let dockerImageTarget: string | undefined;
  const dockerHostEnv = backend === "docker"
    ? (derivedDockerImage?.hostEnv ?? dockerHostEnvironment())
    : undefined;
  if (backend === "docker" && input.mode === "read-only") {
    if (!image || !dockerBinary || !dockerHostEnv) {
      throw new Error("read-only Docker sandbox needs an image");
    }
    const imageAttestation = attestDockerImage(
      dockerBinary,
      derivedDockerImage?.imageTarget ?? image,
      dockerHostEnv,
    );
    if (derivedDockerImage &&
      imageAttestation.imageIdentityDigest !== derivedDockerImage.imageIdentityDigest) {
      throw new Error("Docker derived image authority changed after policy attestation");
    }
    dockerImageIdentityDigest = imageAttestation.imageIdentityDigest;
    dockerImageTarget = dockerImageExecutionTarget(imageAttestation);
    dockerNetworkState = "none";
  } else if (backend === "docker" && container) {
    const attestation = attestDockerWorld(dockerBinary!, container, {
      workspaceRoot,
      ...(gitCommonDir ? { gitCommonDir } : {}),
      hostEnv: dockerHostEnv!,
      expectedContainer: container,
      ...(image ? { expectedImage: image } : {}),
    });
    dockerNetworkState = attestation.networkState;
    dockerMountDigest = attestation.mountDigest;
    dockerContainerIdentityDigest = attestation.containerIdentityDigest;
    dockerImageIdentityDigest = attestation.imageIdentityDigest;
    dockerSecurityDigest = attestation.securityDigest;
    dockerExecutionTarget = dockerWorldExecutionTarget(attestation);
    dockerImageTarget = dockerWorldImageExecutionTarget(attestation);
    if (configuredDockerNetwork !== undefined && configuredDockerNetwork !== dockerNetworkState) {
      throw new Error("Docker network configuration does not match the attested world");
    }
  }
  const seatbeltRuntime = backend === "seatbelt" ? createSeatbeltRuntime() : undefined;
  // Scratch (D48) belongs to a writable world the host can bind a host path
  // into: never a read-only phase, never a Docker world.
  const scratchRoot = input.scratchRoot !== undefined && input.mode !== "read-only" && backend !== "docker"
    ? input.scratchRoot
    : undefined;
  const scratchWritable = scratchRoot === undefined ? undefined : sealedScratchWritable(input.scratchWritable);
  // G3 (D57g): the session's tool-cache directory, for a writable policy of
  // a session over its own tree on a backend the host can bind it into.
  // G3' (D57h): a judged policy's own, fresh one instead — never the
  // session's.
  const bindsToolCache = input.mode !== "read-only" && input.observerIsolation !== true
    && (backend === "seatbelt" || backend === "bwrap");
  const toolCache = !bindsToolCache
    ? undefined
    : input.toolCache === "session" && input.log !== undefined
    ? acquireSessionToolCache(input.log, workspaceRoot)
    : input.toolCache === "judged"
    ? acquireJudgedToolCache(workspaceRoot)
    : undefined;
  let policyChild: ReturnType<typeof policyChildEnvironment>;
  try {
    policyChild = policyChildEnvironment({
      workspaceRoot,
      mode: input.mode,
      backend,
      observerIsolation: input.observerIsolation === true,
      ...(seatbeltRuntime
        ? { sandboxHome: seatbeltRuntime.home, sandboxTemp: seatbeltRuntime.temp }
        : {}),
      ...(toolCache !== undefined ? { toolCacheDir: toolCache.dir, toolCacheRole: input.toolCache } : {}),
    });
  } catch (error) {
    toolCache?.release();
    if (seatbeltRuntime) disposeSeatbeltRuntime(seatbeltRuntime.root);
    throw error;
  }
  const { childEnv: baseChildEnv, toolchain, devicePaths, runtimeExecutable } = policyChild;
  const childEnv = withScratchEnvironment(baseChildEnv, scratchRoot);
  // A proxy address the operator set but the sandbox refused must never be
  // silent: the run would fail every fetch and read as a closed network
  // (sandbox-proxy.ts).
  const proxyReport = proxyEnvironment(process.env);
  if (proxyReport.withheld.length > 0) {
    process.stderr.write(
      `sandbox: withheld ${proxyReport.withheld.join(", ")} because the URL carries credentials; `
      + `set a credential-free proxy URL so sandboxed commands can reach the network\n`,
    );
  }
  if (proxyReport.droppedExceptions.length > 0) {
    // A dropped exception changes routing: a host that used to bypass the
    // proxy now goes through it. Saying which ones went is the difference
    // between a fixed list and a mystery.
    process.stderr.write(
      `sandbox: dropped no_proxy entries a Linux client cannot read `
      + `(${proxyReport.droppedExceptions.join(", ")}); set no_proxy explicitly rather than `
      + `inheriting the host's\n`,
    );
  }
  const sandboxIdentity = backend === "bwrap" ? createSandboxIdentityFiles() : undefined;
  // The sandbox home mirrors every bound root that lies under the operator's
  // real home (sandbox-home-mirror.ts); under Seatbelt the tree is real
  // symlinks created now, under bwrap it is argv --dir/--symlink pairs.
  const homeMirrorPlan = planHomeMirrors({
    sandboxHome: seatbeltRuntime ? seatbeltRuntime.home : SANDBOX_DOKKABI_HOME,
    roots: [workspaceRoot, ...(gitCommonDir ? [gitCommonDir] : []), ...toolchain],
  });
  if (seatbeltRuntime) materializeHomeMirrors(homeMirrorPlan.mirrors);
  // W2 (D57g): the session's own directory, when it lies inside the
  // workspace, is host-owned there — never writable by the session.
  const sessionDir = input.log === undefined || backend === "docker" ? undefined : hostOwnedSessionDir(input.log.path, workspaceRoot);
  const hostOwnedPaths = sessionDir === undefined ? [] : [sessionDir];
  const policy: SandboxPolicy = {
    mode: input.mode,
    workspaceRoot,
    backend,
    ...(input.observerIsolation ? { observerIsolation: PROTECTED_OBSERVER_ISOLATION } : {}),
    ...(backend === "docker" && container ? { dockerContainer: container } : {}),
    ...(backend === "docker" && image ? { dockerImage: image } : {}),
    ...(dockerNetworkState === "connected" || dockerNetworkState === "none" ? { dockerNetworkState } : {}),
    ...(dockerMountDigest ? { dockerMountDigest } : {}),
    ...(dockerContainerIdentityDigest ? { dockerContainerIdentityDigest } : {}),
    ...(dockerImageIdentityDigest ? { dockerImageIdentityDigest } : {}),
    ...(dockerSecurityDigest ? { dockerSecurityDigest } : {}),
    ...(dockerHostEnv
      ? { dockerHostEnv, dockerHostEnvDigest: dockerHostEnvironmentDigest(dockerHostEnv) }
      : {}),
    ...(dockerBinary ? { dockerBinary } : {}),
    ...(bwrapBinary ? { bwrapBinary } : {}),
    ...(seatbeltBinary ? { seatbeltBinary } : {}),
    ...(seatbeltRuntime ? { sandboxHome: seatbeltRuntime.home, sandboxTemp: seatbeltRuntime.temp } : {}),
    ...(input.writablePaths && input.writablePaths.length > 0
      ? { writablePaths: input.writablePaths }
      : {}),
    ...(scratchRoot !== undefined ? { scratchRoot } : {}),
    ...(scratchWritable !== undefined ? { scratchWritable } : {}),
    ...(devicePaths.length > 0 ? { devicePaths } : {}),
    backendExecutableIdentity: backendExecutable!.identity,
    backendExecutableStatIdentity: backendExecutable!.statIdentity,
    runtimeExecutable,
    ...(sandboxIdentity ? { sandboxIdentityDigest: sandboxIdentity.digest } : {}),
    ...(gitCommonDir ? { gitCommonDir } : {}),
    ...(gitCommonDirWritable ? { gitCommonDirWritable: true as const } : {}),
    ...(hostOwnedPaths.length > 0 ? { hostOwnedPaths: Object.freeze(hostOwnedPaths) } : {}),
    ...(toolCache !== undefined ? { toolCacheDir: toolCache.dir } : {}),
    childEnv,
    networkDenied: input.observerIsolation ? true : networkDenied(input.mode),
    toolchainRoots: Object.freeze([...toolchain]),
    homeMirrorRoots: Object.freeze(homeMirrorPlan.mirrors.map((mirror) => mirror.root)),
    homeMirrorSkipped: Object.freeze([...homeMirrorPlan.skipped]),
  };
  if (dockerExecutionTarget) {
    HOST_SEALED_DOCKER_EXECUTION_TARGETS.set(policy, dockerExecutionTarget);
  }
  if (dockerImageTarget) {
    HOST_SEALED_DOCKER_IMAGE_TARGETS.set(policy, dockerImageTarget);
  }
  if (sandboxIdentity) HOST_SANDBOX_IDENTITIES.set(policy, sandboxIdentity);
  try {
    assertPolicyFieldsEnforceable(policy);
    const frozen = Object.freeze(policy);
    attestSeatbeltPolicy(frozen, input.log);
    if (scratchRoot !== undefined && scratchWritable !== undefined) {
      HOST_SCRATCH_VIEWS.set(frozen, [scratchRoot, ...scratchWritable].map((path) => {
        const entry = lstatSync(path);
        return { path, dev: entry.dev, ino: entry.ino };
      }));
    }
    HOST_SEALED_SANDBOX_POLICIES.add(frozen);
    if (toolCache !== undefined) HOST_TOOL_CACHE_LEASES.set(frozen, toolCache.release);
    return frozen;
  } catch (error) {
    if (sandboxIdentity) disposeSandboxIdentity(sandboxIdentity);
    if (seatbeltRuntime) disposeSeatbeltRuntime(seatbeltRuntime.root);
    toolCache?.release();
    throw error;
  }
}

/**
 * A policy with the fence off. No executable is sealed because none runs;
 * the child inherits the operator's environment with the sandbox markers
 * added so a tool can still tell which world it is in.
 */
function sealDisabledPolicy(input: PolicyInput, workspaceRoot: string): SandboxPolicy {
  const scratchRoot = input.scratchRoot !== undefined && input.mode !== "read-only" ? input.scratchRoot : undefined;
  // With the fence off nothing enforces the read-only view; it is kept on the
  // policy so the record says what was asked (`fence: none` says the rest).
  const scratchWritable = scratchRoot === undefined ? undefined : sealedScratchWritable(input.scratchWritable);
  const childEnv = withScratchEnvironment(disabledChildEnvironment(input.mode, workspaceRoot), scratchRoot);
  const policy: SandboxPolicy = {
    mode: input.mode,
    workspaceRoot,
    backend: "none",
    disabled: true,
    ...(input.writablePaths && input.writablePaths.length > 0
      ? { writablePaths: input.writablePaths }
      : {}),
    ...(scratchRoot !== undefined ? { scratchRoot } : {}),
    ...(scratchWritable !== undefined ? { scratchWritable } : {}),
    backendExecutableIdentity: "sandbox-off",
    backendExecutableStatIdentity: "sandbox-off",
    runtimeExecutable: resolve(process.execPath),
    childEnv,
    networkDenied: false,
    toolchainRoots: Object.freeze([]),
    homeMirrorRoots: Object.freeze([]),
    homeMirrorSkipped: Object.freeze([]),
  };
  const frozen = Object.freeze(policy);
  HOST_SEALED_SANDBOX_POLICIES.add(frozen);
  return frozen;
}

/** The environment variable a session's commands find its scratch space in
 * (D48). */
export const SCRATCH_ENV = "DOKKABI_SCRATCH";

/** A scratch root must be a canonical, existing directory outside the
 * workspace: the fence binds it at its own path, and nothing written there
 * may reach the developer's tree. */
function assertScratchRoot(scratchRoot: string, workspaceRoot: string): void {
  if (!isAbsolute(scratchRoot) || !existsSync(scratchRoot) || realpathSync(scratchRoot) !== scratchRoot
    || !statSync(scratchRoot).isDirectory()) {
    throw new Error("sandbox scratch root must be a canonical directory");
  }
  const rel = relative(workspaceRoot, scratchRoot);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("sandbox scratch root must lie outside the workspace");
  }
  // Nor may the workspace lie inside the scratch: each is bound on its own,
  // and neither bind may cover the other (LX).
  const back = relative(scratchRoot, workspaceRoot);
  if (!back.startsWith("..") && !isAbsolute(back)) {
    throw new Error("sandbox workspace must lie outside the scratch root");
  }
}

/** The writable directories of a read-only scratch view (D58b V4): each a
 * canonical, existing directory strictly beneath the scratch root — reached
 * through no link (its real path is its path), so the fence binds exactly
 * the directory the host made. */
function assertScratchWritable(paths: readonly string[], scratchRoot: string | undefined): void {
  if (scratchRoot === undefined) throw new Error("a read-only scratch view needs a scratch root");
  if (!Array.isArray(paths)) throw new Error("sandbox scratch writable paths must be a list");
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path) || realpathSync(path) !== path
      || !lstatSync(path).isDirectory()) {
      throw new Error("sandbox scratch writable path must be a canonical directory");
    }
    const rel = relative(scratchRoot, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("sandbox scratch writable path must lie strictly beneath the scratch root");
    }
  }
}

/** Each directory of a policy's scratch view is still, at its path, the real
 * directory the policy sealed — reached through no link, the same device and
 * inode; otherwise the execution is not made. */
function assertScratchViewUnchanged(policy: SandboxPolicy): void {
  for (const entry of HOST_SCRATCH_VIEWS.get(policy) ?? []) {
    let same = false;
    try {
      const now = lstatSync(entry.path);
      same = now.isDirectory() && now.dev === entry.dev && now.ino === entry.ino && realpathSync(entry.path) === entry.path;
    } catch {
      same = false;
    }
    if (!same) throw new Error("the sandbox's scratch view changed after its policy was sealed; the execution is not made");
  }
}

/** The writable directories as the policy keeps them: frozen, in the order
 * given, each once; undefined when none was asked for (the whole scratch
 * writable, as before). */
function sealedScratchWritable(paths: readonly string[] | undefined): readonly string[] | undefined {
  if (paths === undefined) return undefined;
  return Object.freeze([...new Set(paths)]);
}

/** The sealed child environment, with DOKKABI_SCRATCH added when the policy
 * carries a scratch root; frozen either way. */
function withScratchEnvironment(
  childEnv: Readonly<Record<string, string>>,
  scratchRoot: string | undefined,
): Readonly<Record<string, string>> {
  if (scratchRoot === undefined) return Object.isFrozen(childEnv) ? childEnv : Object.freeze({ ...childEnv });
  return Object.freeze({ ...childEnv, [SCRATCH_ENV]: scratchRoot });
}

function disabledChildEnvironment(mode: string, workspaceRoot: string): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  childEnv.DOKKABI_SANDBOX_WORKSPACE = workspaceRoot;
  childEnv.DOKKABI_SANDBOX_MODE = mode;
  childEnv[SANDBOX_SWITCH_ENV] = "off";
  return childEnv;
}

/**
 * The child-environment block of policy construction, factored out so the
 * boot-time environment probe (host/environment) reads the exact PATH the
 * session's sandbox will expose instead of a lookalike. The accelerator and
 * toolchain discoveries are filesystem reads; nothing here spawns.
 */
function policyChildEnvironment(input: {
  readonly workspaceRoot: string;
  readonly mode: string;
  readonly backend: SandboxBackend;
  readonly observerIsolation?: boolean;
  readonly sandboxHome?: string;
  readonly sandboxTemp?: string;
  readonly toolCacheDir?: string;
  readonly toolCacheRole?: "session" | "judged";
}): {
  readonly childEnv: Readonly<Record<string, string>>;
  readonly toolchain: readonly string[];
  readonly devicePaths: readonly string[];
  readonly runtimeExecutable: string;
} {
  const runtimeExecutable = resolve(process.execPath);
  // Discovered on the host, not requested by the caller: a machine either has
  // accelerators or it does not, and a policy that hid them made the local
  // GPU unusable to every case (sandbox-accelerator.ts).
  const devicePaths = input.backend === "bwrap" && !input.observerIsolation ? acceleratorDevicePaths() : [];
  // The operator's toolchain is part of this host's world, not something a
  // caller asks for: without it the shell cannot name python3 or gh on a
  // Homebrew Mac (sandbox-toolchain.ts). Docker brings its own.
  const toolchain = !input.observerIsolation && (input.backend === "bwrap" || input.backend === "seatbelt")
    ? toolchainRoots({ workspaceRoot: input.workspaceRoot }) : [];
  const childEnv = createSandboxEnvironment({
    workspaceRoot: input.workspaceRoot,
    mode: input.mode,
    backend: input.backend,
    runtimeExecutable,
    devicePaths,
    toolchainRoots: toolchain,
    dockerPython: process.env.DOKKABI_SWE_PYTHON,
    ...(input.observerIsolation ? { hostEnv: {} } : {}),
    ...(input.sandboxHome !== undefined && input.sandboxTemp !== undefined
      ? { sandboxHome: input.sandboxHome, sandboxTemp: input.sandboxTemp }
      : {}),
    ...(input.toolCacheDir !== undefined ? { toolCacheDir: input.toolCacheDir } : {}),
    ...(input.toolCacheRole !== undefined ? { toolCacheRole: input.toolCacheRole } : {}),
  });
  return { childEnv, toolchain, devicePaths, runtimeExecutable };
}

/**
 * The environment the session's own sandboxed shell will inherit, computed
 * without sealing a policy. The workspace-tools policy is built when that
 * plugin loads, but the boot environment probe (host/environment) publishes
 * the PATH before that, so both go through the one construction above and the
 * published facts cannot drift from the world the model actually gets. With
 * the fence off — or no backend on the host — the child inherits the
 * operator's PATH, mirrored from sealDisabledPolicy. Mode never changes PATH;
 * the envfix switch is mirrored from workspace-tools so
 * DOKKABI_SANDBOX_MODE stays truthful. Filesystem reads only.
 */
export function sessionSandboxEnvironment(input: {
  readonly workspaceRoot: string;
}): Readonly<Record<string, string>> {
  const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
  const mode: SandboxMode = process.env.DOKKABI_SANDBOX_MODE === "envfix" ? "envfix" : "workspace-write";
  if (sandboxDisabled()) {
    return Object.freeze(disabledChildEnvironment(mode, workspaceRoot));
  }
  const authority = resolveSandboxBackendAuthority({ localBackend: detectBackend(workspaceRoot) });
  if (authority.backend === "none") {
    throw new Error("no sandbox backend available; explicit operator sandbox opt-out is required");
  }
  return policyChildEnvironment({ workspaceRoot, mode, backend: authority.backend }).childEnv;
}

/** Recorded roots stay host-free for portable fixtures (see loader). */
function displayRoot(workspaceRoot: string): string {
  const cwd = process.cwd();
  const rel = relative(cwd, resolve(workspaceRoot));
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return rel;
  }
  return "external-workspace";
}

export function policyDigest(policy: SandboxPolicy): string {
  assertSandboxPolicyEnforceable(policy);
  return policyDigestUnchecked(policy);
}

function policyDigestUnchecked(policy: SandboxPolicy, boundary?: ProtectedObserverBoundary): string {
  return createHash("sha256")
    .update([
      policy.backend,
      policy.mode,
      policy.workspaceRoot,
      `net=${policy.networkDenied ? "deny" : "allow"}`,
      `docker_network=${policy.dockerNetworkState ?? "missing"}`,
      `docker_mount=${policy.dockerMountDigest ?? "missing"}`,
      `docker_container_identity=${policy.dockerContainerIdentityDigest ?? "missing"}`,
      `docker_image_identity=${policy.dockerImageIdentityDigest ?? "missing"}`,
      `docker_security=${policy.dockerSecurityDigest ?? "missing"}`,
      `docker_host_env=${policy.dockerHostEnvDigest ?? "missing"}`,
      `docker_container=${policy.dockerContainer ?? "missing"}`,
      `docker_image=${policy.dockerImage ?? "missing"}`,
      `docker_binary=${policy.dockerBinary ?? "missing"}`,
      `bwrap_binary=${policy.bwrapBinary ?? "missing"}`,
      `seatbelt_binary=${policy.seatbeltBinary ?? "missing"}`,
      `backend_executable_identity=${policy.backendExecutableIdentity}`,
      `runtime=${policy.runtimeExecutable}`,
      `sandbox_identity=${policy.sandboxIdentityDigest ?? "missing"}`,
      `git_common=${policy.gitCommonDir ?? "missing"}`,
      ...(policy.gitCommonDirWritable ? ["git_common_write=true"] : []),
      `environment=${sandboxEnvironmentDigest(policy.childEnv)}`,
      `dokkabi_home=${policy.childEnv.HOME}`,
      `toolchain=${(policy.toolchainRoots ?? []).join(":")}`,
      `home_mirror=${(policy.homeMirrorRoots ?? []).join(":")}`,
      `home_mirror_skipped=${(policy.homeMirrorSkipped ?? []).join(":")}`,
      `private_cache=${HOST_PRIVATE_CACHE_ROOTS.get(policy)?.label ?? "missing"}`,
      `fence=${policy.disabled ? "off" : "on"}`,
      // Present only on a policy that carries scratch (D48), so every policy
      // without one digests exactly as it did before.
      ...(policy.scratchRoot !== undefined ? [`scratch=${policy.scratchRoot}`] : []),
      // Present only on a read-only scratch view (D58b V4).
      ...(policy.scratchWritable !== undefined ? [`scratch_writable=${JSON.stringify(policy.scratchWritable)}`] : []),
      ...(policy.toolCacheDir !== undefined ? [`tool_cache=${policy.toolCacheDir}`] : []),
      ...(HOST_EXECUTION_VIEWS.has(policy) ? [`execution_view=${JSON.stringify(HOST_EXECUTION_VIEWS.get(policy))}`] : []),
      ...(policy.observerIsolation ? [
        `observer_isolation=${policy.observerIsolation}`,
        `observer_isolation_digest=${observerBoundaryDigest(boundary ?? captureObserverBoundary(policy))}`,
      ] : []),
    ].join("\0"))
    .digest("hex")
    .slice(0, 16);
}

function captureObserverBoundary(policy: SandboxPolicy): ProtectedObserverBoundary {
  if (!policy.observerIsolation) throw new Error("protected observer isolation is missing");
  const common = { schema_version: 1, network: "deny", isolation: policy.observerIsolation } as const;
  if (policy.backend === "seatbelt") {
    return Object.freeze({ ...common, backend: "seatbelt", mechanism: "seatbelt-profile", content: seatbeltProfile(policy) });
  }
  if (policy.backend === "bwrap") {
    return Object.freeze({ ...common, backend: "bwrap", mechanism: "bwrap-argv", content: Object.freeze(bwrapArgvUnchecked(policy, [])) });
  }
  throw new Error("protected observer isolation requires a supported native boundary");
}

function observerBoundaryDigest(boundary: ProtectedObserverBoundary): string {
  return createHash("sha256")
    .update(boundary.mechanism === "seatbelt-profile" ? boundary.content : JSON.stringify(boundary.content))
    .digest("hex");
}

/** Whether this child's network is fenced. Operator direction (2026-08-22,
 * #29): workspace-write ALLOWS by default — the assistant must be able to
 * reach the network on this host. read-only keeps DENY (a review fence that
 * phones home is not a review fence), and DOKKABI_SANDBOX_NET=deny restores
 * the old fence for any mode — the knob is the rollback, not a code change. */
export function networkDenied(mode: SandboxMode, env: NodeJS.Dict<string> = process.env): boolean {
  const configured = env.DOKKABI_SANDBOX_NET?.trim();
  if (configured && configured !== "allow" && configured !== "deny") {
    throw new Error("DOKKABI_SANDBOX_NET must be allow or deny");
  }
  if (mode === "read-only") {
    return true;
  }
  return configured === "deny";
}

/** The effective network value captured in the immutable session policy. */
export function sandboxNetwork(policy: SandboxPolicy): SandboxNetwork {
  assertSandboxPolicyEnforceable(policy);
  return sandboxNetworkUnchecked(policy);
}

function sandboxNetworkUnchecked(policy: SandboxPolicy): SandboxNetwork {
  return policy.networkDenied ? "deny" : "allow";
}

/** Perform the one mutable-world/executable check for an execution seam.
 * The returned opaque capability lets the caller record matching evidence
 * and then spawn without multiplying Docker inspect calls. */
export function prepareSandboxExecution(policy: SandboxPolicy): PreparedSandboxExecution {
  assertSandboxPolicyEnforceable(policy);
  const view = HOST_EXECUTION_VIEWS.get(policy);
  if (view) {
    assertMaterializedExecutionImage(view);
    if (createHash("sha256").update(readFileSync(policy.runtimeExecutable)).digest("hex") !== view.runtime) throw new Error("execution_view_runtime_changed");
  }
  const boundary = policy.observerIsolation ? captureObserverBoundary(policy) : undefined;
  const prepared = Object.freeze({
    network: sandboxNetworkUnchecked(policy),
    digest: policyDigestUnchecked(policy, boundary),
    ...(boundary ? {
      observerIsolation: boundary.isolation,
      observerIsolationDigest: observerBoundaryDigest(boundary),
      observerBoundary: boundary,
    } : {}),
  });
  HOST_PREPARED_SANDBOX_EXECUTIONS.set(prepared, policy);
  return prepared;
}

/** Consume a prepared execution after its effect row has landed. The mutable
 * world and host executable are checked again immediately before the caller
 * crosses the spawn boundary; an append hook therefore cannot make recorded
 * authority differ from executed authority. */
export function consumePreparedSandboxExecution(prepared: PreparedSandboxExecution): void {
  const policy = HOST_PREPARED_SANDBOX_EXECUTIONS.get(prepared);
  if (!policy) throw new Error("sandbox execution capability is missing or already consumed");
  HOST_PREPARED_SANDBOX_EXECUTIONS.delete(prepared);
  assertSandboxPolicyEnforceable(policy);
  const view = HOST_EXECUTION_VIEWS.get(policy);
  if (view) {
    assertMaterializedExecutionImage(view);
    if (createHash("sha256").update(readFileSync(policy.runtimeExecutable)).digest("hex") !== view.runtime) throw new Error("execution_view_runtime_changed");
  }
  const currentBoundary = policy.observerIsolation ? captureObserverBoundary(policy) : undefined;
  if (prepared.network !== sandboxNetworkUnchecked(policy) ||
    prepared.digest !== policyDigestUnchecked(policy, currentBoundary) ||
    prepared.observerIsolation !== policy.observerIsolation ||
    prepared.observerIsolationDigest !== (currentBoundary ? observerBoundaryDigest(currentBoundary) : undefined) ||
    JSON.stringify(prepared.observerBoundary) !== JSON.stringify(currentBoundary)) {
    throw new Error("sandbox execution authority changed after its effect was recorded");
  }
}

/** Reject a policy that its selected backend cannot enforce. Call before an
 * effect append as well as at normal policy creation so hand-built policies
 * cannot produce a false execution claim. */
export function assertSandboxPolicyEnforceable(policy: SandboxPolicy): void {
  if (!Object.isFrozen(policy) || !HOST_SEALED_SANDBOX_POLICIES.has(policy)) {
    throw new Error("sandbox policy is not a host-sealed policy");
  }
  // A switched-off fence enforces nothing and claims nothing; the seal above
  // is what keeps a hand-built object from wearing the label.
  if (policy.disabled === true && policy.backend === "none") return;
  assertPolicyFieldsEnforceable(policy);
  if (policy.backend === "bwrap" || policy.backend === "docker" || policy.backend === "seatbelt") {
    assertSandboxExecutableIdentity(policyExecutableSeal(policy));
  }
  const cache = HOST_PRIVATE_CACHE_ROOTS.get(policy);
  if (cache) assertPrivateCacheRoot(cache);
  if (policy.backend === "docker" && policy.mode !== "read-only") {
    const executionTarget = HOST_SEALED_DOCKER_EXECUTION_TARGETS.get(policy);
    if (!executionTarget || !policy.dockerContainer || !policy.dockerBinary || !policy.dockerHostEnv) {
      throw new Error("Docker world attestation is incomplete");
    }
    const attestation = attestDockerWorld(policy.dockerBinary, executionTarget, {
      workspaceRoot: policy.workspaceRoot,
      ...(policy.gitCommonDir ? { gitCommonDir: policy.gitCommonDir } : {}),
      hostEnv: policy.dockerHostEnv,
      expectedContainer: executionTarget,
      ...(policy.dockerImage ? { expectedImage: policy.dockerImage } : {}),
    });
    if (dockerWorldExecutionTarget(attestation) !== executionTarget ||
      attestation.networkState !== policy.dockerNetworkState ||
      attestation.mountDigest !== policy.dockerMountDigest ||
      attestation.containerIdentityDigest !== policy.dockerContainerIdentityDigest ||
      attestation.imageIdentityDigest !== policy.dockerImageIdentityDigest ||
      attestation.securityDigest !== policy.dockerSecurityDigest) {
      throw new Error("Docker world authority changed after policy attestation");
    }
  } else if (policy.backend === "docker") {
    const imageTarget = HOST_SEALED_DOCKER_IMAGE_TARGETS.get(policy);
    if (!imageTarget || !policy.dockerBinary || !policy.dockerHostEnv) {
      throw new Error("Docker image attestation is incomplete");
    }
    const attestation = attestDockerImage(policy.dockerBinary, imageTarget, policy.dockerHostEnv);
    if (dockerImageExecutionTarget(attestation) !== imageTarget ||
      attestation.imageIdentityDigest !== policy.dockerImageIdentityDigest) {
      throw new Error("Docker image authority changed after policy attestation");
    }
  }
}

function assertPolicyFieldsEnforceable(policy: SandboxPolicy): void {
  if (policy.observerIsolation && (
    policy.observerIsolation !== PROTECTED_OBSERVER_ISOLATION ||
    !policy.networkDenied || policy.disabled ||
    policy.toolchainRoots.length > 0 || (policy.devicePaths?.length ?? 0) > 0 ||
    policy.gitCommonDir || (policy.writablePaths?.length ?? 0) > 0 || policy.scratchRoot !== undefined ||
    !((process.platform === "darwin" && policy.backend === "seatbelt") ||
      (process.platform === "linux" && policy.backend === "bwrap"))
  )) {
    throw new Error("protected observer isolation policy is not enforceable");
  }
  if (policy.backend === "none") {
    throw new Error("sandbox backend none cannot enforce a policy");
  }
  const expectedHome = policy.backend === "seatbelt" ? policy.sandboxHome : SANDBOX_DOKKABI_HOME;
  const expectedTemp = policy.backend === "seatbelt" ? policy.sandboxTemp : "/tmp";
  if (!Object.isFrozen(policy.childEnv) || !expectedHome || !expectedTemp ||
    policy.childEnv.HOME !== expectedHome || policy.childEnv.DOKKABI_HOME !== expectedHome ||
    policy.childEnv.TMPDIR !== expectedTemp || policy.childEnv.TMP !== expectedTemp ||
    policy.childEnv.TEMP !== expectedTemp) {
    throw new Error("sandbox child environment is not sealed");
  }
  if (typeof policy.backendExecutableIdentity !== "string" || policy.backendExecutableIdentity.length !== 64) {
    throw new Error("sandbox backend executable identity is missing");
  }
  if (typeof policy.backendExecutableStatIdentity !== "string" || policy.backendExecutableStatIdentity.length === 0) {
    throw new Error("sandbox backend executable stat identity is missing");
  }
  if (policy.backend === "bwrap" && !policy.bwrapBinary) {
    throw new Error("bwrap sandbox needs a sealed executable");
  }
  if (policy.backend === "seatbelt" && !policy.seatbeltBinary) {
    throw new Error("seatbelt sandbox needs a sealed executable");
  }
  if (policy.backend === "seatbelt" && (!policy.sandboxHome || !policy.sandboxTemp)) {
    throw new Error("seatbelt sandbox needs private runtime roots");
  }
  if (policy.backend === "bwrap") assertSandboxIdentity(policy);
  assertDockerNetworkPolicy(policy);
}

/** The bwrap argv that fences one child: ro root, rw workspace, tmpfs /tmp.
 * Network: see networkDenied — allow by default, deny for read-only or the
 * explicit knob. envfix always had the network and keeps it. */
export function bwrapArgv(policy: SandboxPolicy, argv: string[]): string[] {
  assertSandboxPolicyEnforceable(policy);
  return bwrapArgvUnchecked(policy, argv);
}

function bwrapArgvUnchecked(policy: SandboxPolicy, argv: string[]): string[] {
  if (policy.backend !== "bwrap") throw new Error("bwrap argv requires a bwrap policy");
  const workspace = policy.workspaceRoot;
  const net = policy.networkDenied ? ["--unshare-net"] : [];
  // LX (D58c): the argv grants what the Seatbelt profile grants, in an order
  // no later mount can undo (bwrapWorldArgs): the read-only grants first (the
  // system, the git common directory, the toolchain), then the writable ones
  // from the widest to the narrowest (the workspace; then the scratch
  // read-only and only its listed directories writable), so a later mount
  // only ever narrows or exactly re-grants what an earlier one covered; the
  // private /tmp (TMPDIR and HOME, fresh per bwrap process) stays writable,
  // and once every mount point exists the root itself is remounted read-only,
  // so a write anywhere else fails as Seatbelt fails it instead of landing in
  // a private tmpfs.
  return [
    policy.bwrapBinary!,
    ...minimalSystemMounts(policy),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--hostname",
    "dokkabi",
    ...bwrapWorldArgs(policy),
    // Every mount point exists now: the root's own tmpfs (its skeleton of
    // directories) is read-only from here on, as everything outside the
    // policy's writable roots is under Seatbelt (LX). Not a mount, so it is
    // no row of the mount table (bwrapMountTable).
    "--remount-ro", "/",
    "--clearenv",
    ...environmentArgs(policy.childEnv),
    "--chdir",
    workspace,
    ...net,
    "--die-with-parent",
    ...argv,
  ];
}

/** The mounts of a bwrap world beyond the minimal system: the execution's
 * private /proc, /dev and /tmp, and every root bound into them — exactly the
 * arguments the fence runs with (bwrapArgvUnchecked) and the arguments its
 * mount table is read from (bwrapMountTable). */
export function bwrapWorldArgs(policy: SandboxPolicy): string[] {
  const hostOwned = hostOwnedDenials(policyWritableRoots(policy));
  const workspace = policy.workspaceRoot;
  const workspaceBind = policy.mode === "read-only" ? "--ro-bind" : "--bind";
  const view = HOST_EXECUTION_VIEWS.get(policy);
  const source = (target: string) => view?.mappings.find(row => row.target === target)?.source ?? target;
  return [
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // `--dev` mounts a fresh minimal devtmpfs with no accelerator nodes in it.
    // Without these a driver inside the sandbox finds no device, and a case
    // that uses the local GPU fails for a reason that is not the case's.
    // Writable worlds only: the sealed read-only phase writes a plan and has
    // no business opening a device (sandbox-accelerator.ts).
    ...(policy.mode === "read-only" ? [] : acceleratorBindArgs(policy.devicePaths ?? [])),
    "--tmpfs",
    "/tmp",
    "--dir",
    SANDBOX_DOKKABI_HOME,
    ...(policy.gitCommonDir && !pathWithin(workspace, policy.gitCommonDir)
      ? [
          ...mountParentDirs(policy.gitCommonDir),
          policy.gitCommonDirWritable && policy.mode !== "read-only" ? "--bind" : "--ro-bind",
          source(policy.gitCommonDir),
          policy.gitCommonDir,
        ]
      : []),
    // Read-only, at their own paths, so shebangs and symlinks inside them
    // keep resolving (sandbox-toolchain.ts).
    ...(policy.toolchainRoots ?? []).flatMap((root) => [...mountParentDirs(root), "--ro-bind", root, root]),
    // The home mirror: `--dir` intermediates plus one symlink per bound root
    // under the operator's home, so `~/…` paths from normalized outputs
    // resolve to the same files the real paths name (sandbox-home-mirror.ts).
    ...homeMirrorBwrapArgs(SANDBOX_DOKKABI_HOME, policy.homeMirrorRoots ?? []),
    ...mountParentDirs(workspace),
    workspaceBind,
    source(workspace),
    workspace,
    ...(policy.mode === "read-only" ? (policy.writablePaths ?? []).flatMap((path) => {
      if (!existsSync(path)) return [];
      if (!isAbsolute(path) || realpathSync(path) !== path || !statSync(path).isDirectory()) {
        throw new Error("sandbox writable path must be a canonical directory");
      }
      return [...mountParentDirs(path), "--bind", path, path];
    }) : []),
    // The session's scratch space (D48), read-write at its own path in a
    // writable world only — or, a read-only scratch view (D58b V4), bound
    // read-only with only the listed directories below it writable.
    ...(policy.scratchRoot !== undefined && policy.mode !== "read-only"
      ? policy.scratchWritable === undefined
        ? [...mountParentDirs(policy.scratchRoot), "--bind", policy.scratchRoot, policy.scratchRoot]
        : [
          ...mountParentDirs(policy.scratchRoot), "--ro-bind", policy.scratchRoot, policy.scratchRoot,
          ...policy.scratchWritable.flatMap((path) => ["--bind", path, path]),
        ]
      : []),
    // The session's tool-cache directory (G3, D57g), read-write at its own
    // path — the directory only, never its host-owned holder.
    ...(policy.toolCacheDir !== undefined && policy.mode !== "read-only"
      ? [...mountParentDirs(policy.toolCacheDir), "--bind", policy.toolCacheDir, policy.toolCacheDir]
      : []),
    // Host-owned state any writable root happens to contain (host-owned.ts,
    // K1''), after every writable bind: its ancestors pinned, the sessions
    // area and the configuration file read-only (bwrapHostOwnedPins).
    ...bwrapHostOwnedPins(hostOwned),
    // Host-owned locations inside the workspace (W2, D57g): read-only over
    // the writable workspace bind, so no grant above reopens one.
    ...(policy.hostOwnedPaths ?? []).flatMap((path) => (existsSync(path) ? ["--ro-bind", path, path] : [])),
    // The key directories masked, last (bwrapHostOwnedMasks).
    ...bwrapHostOwnedMasks(hostOwned),
    // Expose the pinned substrate under its public command even when its
    // physical installation filename differs (for example npm's bun.exe).
    "--dir", SANDBOX_BUN_BIN,
    "--ro-bind", policy.runtimeExecutable, `${SANDBOX_BUN_BIN}/bun`,
  ];
}

/**
 * THE MOUNT TABLE OF A BWRAP WORLD (W1 on bwrap, D57g Linux follow-up), read
 * from the very arguments the fence runs with (bwrapWorldArgs):
 *
 *   `private`   what only the execution sees — the tmpfs at /tmp (and so the
 *               sandbox HOME and TMPDIR inside it) and the shm of its fresh
 *               /dev — and the target of any bind whose source is another
 *               path (the host sees something else there);
 *   `samePath`  every root bound at its own path (the workspace, the scratch,
 *               the tool cache, the git metadata, toolchains, devices, a
 *               phase's writable paths, host-owned locations): the host sees
 *               there exactly what the execution sees, wherever it lies —
 *               under /tmp included.
 *
 * A location is invisible to the host exactly when the deepest mount holding
 * it is private (writable-world.ts inUnseenWorld). /proc and the rest of
 * /dev are the kernel's own views and name the same things for the host.
 */
export function bwrapMountTable(policy: SandboxPolicy): { readonly private: readonly string[]; readonly samePath: readonly string[] } {
  const args = bwrapWorldArgs(policy);
  const hidden: string[] = [];
  const same: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    switch (word) {
      case "--tmpfs":
        hidden.push(args[at + 1]!);
        at += 1;
        break;
      case "--dev":
        hidden.push(join(args[at + 1]!, "shm"));
        at += 1;
        break;
      case "--proc":
      case "--dir":
        at += 1;
        break;
      case "--symlink":
        at += 2;
        break;
      case "--bind":
      case "--ro-bind":
      case "--dev-bind":
      case "--bind-try":
      case "--ro-bind-try":
      case "--dev-bind-try": {
        const from = args[at + 1];
        const to = args[at + 2]!;
        if (from !== undefined && from === to) same.push(to);
        else hidden.push(to);
        at += 2;
        break;
      }
      default:
        throw new Error(`bwrap mount table: an argument it does not know: ${String(word)}`);
    }
  }
  return { private: hidden, samePath: same };
}

function sandboxPolicyInput(policy: SandboxPolicy, prepared?: PreparedSandboxExecution): EventInput {
  assertSandboxPolicyEnforceable(policy);
  return {
    kind: "observe",
    name: "sandbox/policy",
    payload: {
      mode: policy.mode,
      backend: policy.backend,
      network: sandboxNetworkUnchecked(policy),
      // The row's shape is a replay contract (replay.ts): a switched-off fence
      // is said by `backend: "none"`, and the toolchain roots ride in the
      // digest — host paths stay out of durable evidence.
      workspace_root: displayRoot(policy.workspaceRoot),
      digest: prepared?.digest ?? policyDigestUnchecked(policy),
    },
  };
}

/** The latest `sandbox/policy` row of each log, kept as a running index
 * (D48b, design memo §99 T7): an execution's lookup reads the rows appended
 * since the previous one, not the log back to the row — which, with one
 * policy for the whole session, was the log's first rows every time. It finds
 * the row the backward scan found. Rows are hash-chained, so an index whose
 * last row is still at the same position with the same hash covers an
 * unchanged prefix; a log that no longer extends it (re-read after another
 * writer) is indexed again from its first row. */
const latestPolicyRows = new WeakMap<EventLog, { consumed: number; head: string | undefined; row: EventRecord | undefined }>();

function latestPolicyRow(log: EventLog): EventRecord | undefined {
  const events = log.events;
  let entry = latestPolicyRows.get(log);
  if (entry === undefined || entry.consumed > events.length
    || (entry.consumed > 0 && events[entry.consumed - 1]?.hash !== entry.head)) {
    entry = { consumed: 0, head: undefined, row: undefined };
    latestPolicyRows.set(log, entry);
  }
  for (let index = entry.consumed; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.name === "sandbox/policy") entry.row = event;
    entry.head = event.hash;
  }
  entry.consumed = events.length;
  return entry.row;
}

function activePolicyMatches(event: EventRecord | undefined, expected: EventInput): boolean {
  if (!event || event.kind !== "observe" || event.name !== "sandbox/policy") return false;
  const payload = expected.payload ?? {};
  return Object.keys(event.payload).length === Object.keys(payload).length
    && event.payload.mode === payload.mode
    && event.payload.backend === payload.backend
    && event.payload.network === payload.network
    && event.payload.workspace_root === payload.workspace_root
    && event.payload.digest === payload.digest;
}

function executionPayload(
  policy: SandboxPolicy,
  prepared: PreparedSandboxExecution,
  evidence: SandboxExecutionEvidence,
): Record<string, unknown> {
  const common = {
    backend: policy.backend,
    mode: policy.mode,
    network: prepared.network,
    digest: prepared.digest,
  } as const;
  switch (evidence.kind) {
    case "tool":
      return { ...common, tool: evidence.tool, args_digest: evidence.argsDigest };
    case "direct":
      return { ...common, command_digest: evidence.commandDigest, shell: "direct" };
    case "workspace-bash":
      return {
        ...common,
        shell: "workspace-tools/bash",
        background: evidence.background,
        ...(evidence.handle ? { handle: evidence.handle } : {}),
        ...(evidence.observer ? { observer: evidence.observer } : {}),
        ...(evidence.probeId ? { probe_id: evidence.probeId } : {}),
        ...(evidence.attempt === undefined ? {} : { attempt: evidence.attempt }),
      };
    default:
      return assertNeverExecutionEvidence(evidence);
  }
}

function assertNeverExecutionEvidence(value: never): never {
  throw new Error(`unknown sandbox execution evidence: ${String(value)}`);
}

/** Record the active policy. Mode changes are observe events, never a seal. */
export function appendPolicyEvent(log: EventLog, policy: SandboxPolicy): void {
  log.append(sandboxPolicyInput(policy));
}

/**
 * Bind one execution effect to its active policy under the EventLog lock.
 * Case runners create short-lived policies, so relying on plugin startup to
 * have recorded the same digest makes otherwise valid work unreplayable.
 */
export function appendSandboxExecutionEvent(input: {
  readonly log: EventLog;
  readonly policy: SandboxPolicy;
  readonly evidence: SandboxExecutionEvidence;
}): PreparedSandboxExecution {
  const prepared = prepareSandboxExecution(input.policy);
  const policyInput = sandboxPolicyInput(input.policy, input.policy.observerIsolation ? prepared : undefined);
  const executionInput: EventInput = {
    kind: "effect",
    name: "sandbox/exec",
    payload: executionPayload(input.policy, prepared, input.evidence),
  };
  input.log.appendBatch(() => {
    const active = latestPolicyRow(input.log);
    return activePolicyMatches(active, policyInput)
      ? [executionInput]
      : [policyInput, executionInput];
  });
  return prepared;
}

/**
 * Run one command inside the sandbox. The effect event is appended BEFORE
 * the spawn; if the append fails, the command never runs (constitution 2:
 * what the agent did is an observe event, fail closed).
 */
export function execSandboxed(input: {
  log: EventLog;
  policy: SandboxPolicy;
  command: string;
  timeoutMs?: number;
}): SandboxExecutionResult {
  const prepared = appendSandboxExecutionEvent({
    log: input.log,
    policy: input.policy,
    evidence: {
      kind: "direct",
      commandDigest: createHash("sha256").update(input.command).digest("hex"),
    },
  });
  const executionSeq = input.log.lastSeq;
  const result = spawnPreparedSandbox(prepared, input.command, input.timeoutMs);
  if (result.rawExitCode === null || result.signal !== undefined || result.error !== undefined || result.timedOut || result.maxBufferExceeded || result.completionUnavailable || (result.survivors ?? 0) > 0) {
    input.log.append({
      kind: "observe",
      name: "sandbox/result",
      payload: {
        execution_seq: executionSeq,
        digest: prepared.digest,
        exit_code: result.exitCode,
        ...(result.rawExitCode === undefined ? {} : { raw_exit_code: result.rawExitCode }),
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.timedOut ? { timed_out: true } : {}),
        ...(result.maxBufferExceeded ? { max_buffer_exceeded: true } : {}),
        ...(result.completionUnavailable ? { completion_unavailable: true } : {}),
        ...((result.survivors ?? 0) > 0 ? { survivors: result.survivors } : {}),
      },
    });
  }
  return result;
}

/** The exact argv one fenced command runs as. Host bwrap keeps the inherited
 * venv PATH with a non-login shell. Official containers use their login
 * shell because that is where the image activates the testbed environment. */
export function fencedArgv(policy: SandboxPolicy, command: string, membership?: ExecutionMembership): string[] {
  assertSandboxPolicyEnforceable(policy);
  return fencedArgvUnchecked(policy, command, membership);
}

/**
 * G2' (D57h): begin tracking one execution under `policy` — on Seatbelt a
 * capability of its own that its profile alone may write
 * (execution-membership.ts); undefined elsewhere (bwrap: the pid namespace
 * is the membership; Docker and an unfenced run: none) or where the kernel
 * check is unavailable.
 */
export function beginSandboxExecution(policy: SandboxPolicy): ExecutionMembership | undefined {
  if (policy.backend !== "seatbelt" || policy.disabled === true) return undefined;
  const dir = seatbeltCapabilityDir(policy);
  const membership = dir === undefined ? undefined : beginExecutionMembership(dir, seatbeltWritableRoots(policy));
  if (membership === undefined) throw new Error("Seatbelt execution requires verified kernel membership");
  return membership;
}

/**
 * G2' (D57h): the execution is over — every process confined to its
 * profile is ended and verified gone; one that remains is a live writer of
 * the policy's tree (when the policy can write it) until it is.
 */
export function endSandboxExecution(policy: SandboxPolicy, membership: ExecutionMembership | undefined): number {
  if (membership === undefined) return 0;
  return endExecutionMembership(membership, policy.mode === "read-only" ? undefined : policy.workspaceRoot).remaining.length;
}

function fencedArgvUnchecked(policy: SandboxPolicy, command: string, membership?: ExecutionMembership): string[] {
  if (policy.backend === "none") {
    return ["/bin/bash", "-c", command];
  }
  if (policy.backend === "docker") {
    return dockerFencedArgv(policy, command);
  }
  if (policy.backend === "bwrap") {
    return bwrapArgvUnchecked(policy, ["/bin/bash", "-c", command]);
  }
  return seatbeltArgvUnchecked(policy, ["/bin/bash", "--noprofile", "--norc", "-c", command], membership?.capability);
}

/**
 * Whether a command run under `policy` can write only where the policy lets
 * the session write (S1, D57c): a policy this process sealed, with a native
 * fence on — Seatbelt or bubblewrap — in a writable mode. Then a host
 * operation run inside it as a helper (spawnFenced) cannot be led anywhere
 * else by a link a session placed, whatever races it. False for anything
 * else: the fence off, Docker, a read-only phase, or an object that is not a
 * sealed policy.
 */
export function policyConfinesWrites(policy: Pick<SandboxPolicy, "backend" | "mode" | "disabled">): boolean {
  return HOST_SEALED_SANDBOX_POLICIES.has(policy)
    && policy.disabled !== true
    && (policy.backend === "seatbelt" || policy.backend === "bwrap")
    && policy.mode !== "read-only";
}

/** The fenced spawn itself, no logging — callers that record their own effect use this. */
export function spawnFenced(
  policy: SandboxPolicy,
  command: string,
  timeoutMs?: number,
): SandboxExecutionResult {
  return spawnPreparedSandbox(prepareSandboxExecution(policy), command, timeoutMs);
}

/**
 * The same fenced spawn, awaited and cancellable: the prepared authority,
 * argv, working directory and child environment of spawnFenced, but the child
 * is killed when `signal` aborts or `timeoutMs` passes. For a host diagnosis
 * that owns its own deadline (doctor readiness); a protected observer policy
 * keeps the synchronous path, whose captured boundary this does not replay.
 */
export async function spawnFencedAsync(
  policy: SandboxPolicy,
  command: string,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: true; aborted?: true }> {
  const prepared = prepareSandboxExecution(policy);
  if (prepared.observerBoundary !== undefined) {
    HOST_PREPARED_SANDBOX_EXECUTIONS.delete(prepared);
    throw new Error("spawnFencedAsync does not run protected observer policies");
  }
  consumePreparedSandboxExecution(prepared);
  options.signal?.throwIfAborted();
  const child = Bun.spawn(fencedArgvUnchecked(policy, command), {
    cwd: policy.workspaceRoot,
    env: policy.backend === "docker" ? { ...(policy.dockerHostEnv ?? {}) } : { ...policy.childEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const aborted = options.signal?.aborted === true;
  const timedOut = !aborted && child.killed && child.signalCode !== null;
  return {
    exitCode,
    stdout,
    stderr,
    ...(timedOut ? { timedOut: true as const } : {}),
    ...(aborted ? { aborted: true as const } : {}),
  };
}

/** A long-lived fenced helper (#222 D3): a language server the host owns. */
export interface FencedService {
  readonly pid: number;
  readonly stdin: import("bun").FileSink;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** Ends the whole execution once — its process group and, on Seatbelt,
   * every process its capability confines — and resolves to how many
   * processes are not gone (0 when nothing survives). Every call returns the
   * same promise. The leader is reaped before survivors are counted, so a
   * zombie awaiting its parent is never counted as a survivor. */
  end(): Promise<number>;
}

/**
 * #222 D3: start a long-lived helper under `policy` — the same prepared
 * authority, fenced argv, allowlisted child environment, process group of its
 * own and lifeline as a one-shot execution (spawnPreparedSandbox), but with
 * piped stdio that stays open until the owner ends it. The owner MUST call
 * `end()`; the lifeline ends the group if the host itself dies. Docker and a
 * protected observer policy are refused (no long-lived helper there in v1).
 */
export function spawnFencedService(policy: SandboxPolicy, argv: readonly string[]): FencedService {
  const prepared = prepareSandboxExecution(policy);
  if (prepared.observerBoundary !== undefined || policy.backend === "docker") {
    HOST_PREPARED_SANDBOX_EXECUTIONS.delete(prepared);
    throw new Error("a long-lived helper is not supported under this policy");
  }
  consumePreparedSandboxExecution(prepared);
  const membership = beginSandboxExecution(policy);
  // stderr is discarded: a helper's log is neither read nor retained (it
  // could carry anything), and an unread pipe would stall a chatty server.
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
  try {
    assertScratchViewUnchanged(policy);
    child = Bun.spawn(fencedServiceArgvUnchecked(policy, argv, membership), {
      cwd: policy.workspaceRoot,
      env: { ...policy.childEnv },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
  } catch (error) {
    endSandboxExecution(policy, membership);
    throw error;
  }
  let ending: Promise<number> | undefined;
  const pid = child.pid;
  return {
    pid,
    stdin: child.stdin,
    stdout: child.stdout,
    exited: child.exited,
    end() {
      return ending ??= (async () => {
        let seen: ExecutionTreeCut | undefined;
        let cleanupProblems = 0;
        try {
          seen = cutExecutionTree(pid);
          // Reap the leader (Bun does, on its event loop) before counting.
          await Promise.race([child.exited, Bun.sleep(TREE_END_WAIT_MS)]);
          const deadline = Date.now() + TREE_END_WAIT_MS;
          for (;;) {
            const left = (groupAlive(pid) ? 1 : 0) + [...(seen ?? [])].filter((member) => member !== pid && processAlive(member)).length
              + (child.exitCode === null && child.signalCode === null ? 1 : 0);
            if (left === 0 || Date.now() >= deadline) { cleanupProblems = left + (seen?.unverified ? 1 : 0); break; }
            await Bun.sleep(5);
          }
        } finally {
          cleanupProblems += endSandboxExecution(policy, membership);
        }
        return cleanupProblems;
      })();
    },
  };
}

/**
 * The exact argv a long-lived helper runs as (#222 D3), the same on every
 * native backend: the policy's fenced argv (`exec` of the helper, so the
 * fence's own process is the execution's root), wrapped only where the
 * backend needs a lifeline. Under bwrap the spawned process IS bwrap — its
 * PID namespace ends with it (`--unshare-pid`, `--die-with-parent`) — so
 * the host's cut targets the sandbox's root process; under Seatbelt it is
 * the lifeline's anchor. Exported so a test can hold the shape on any host.
 */
export function fencedServiceArgv(policy: SandboxPolicy, argv: readonly string[]): string[] {
  assertSandboxPolicyEnforceable(policy);
  return fencedServiceArgvUnchecked(policy, argv, undefined);
}

function fencedServiceArgvUnchecked(policy: SandboxPolicy, argv: readonly string[], membership: ExecutionMembership | undefined): string[] {
  const command = argv.map(shellWord).join(" ");
  return lifelineArgv(policy, fencedArgvUnchecked(policy, `exec ${command}`, membership), undefined);
}

export function spawnPreparedSandbox(
  prepared: PreparedSandboxExecution,
  command: string,
  timeoutMs?: number,
  options: { readonly stdin?: Buffer; readonly maxBuffer?: number; readonly captureBytes?: boolean } = {},
): SandboxExecutionResult {
  const policy = HOST_PREPARED_SANDBOX_EXECUTIONS.get(prepared);
  if (!policy) throw new Error("sandbox execution capability is missing or already consumed");
  consumePreparedSandboxExecution(prepared);
  if (options.stdin !== undefined && (!Buffer.isBuffer(options.stdin) || options.stdin.byteLength > MAX_SANDBOX_STDIN_BYTES)) {
    throw new Error(`sandbox stdin must be a Buffer of at most ${MAX_SANDBOX_STDIN_BYTES} bytes`);
  }
  if (options.maxBuffer !== undefined && (!Number.isSafeInteger(options.maxBuffer) ||
    options.maxBuffer <= 0 || options.maxBuffer > MAX_SANDBOX_OBSERVER_OUTPUT_BYTES)) {
    throw new Error(`sandbox maxBuffer must be an integer from 1 to ${MAX_SANDBOX_OBSERVER_OUTPUT_BYTES}`);
  }
  const stdin = options.stdin === undefined ? undefined : Buffer.from(options.stdin);
  const maxBuffer = options.maxBuffer ?? (policy.observerIsolation ? MAX_SANDBOX_OBSERVER_OUTPUT_BYTES : undefined);
  const boundary = prepared.observerBoundary;
  let wrapped: string[];
  // G2' (D57h): this execution's own capability (Seatbelt).
  const membership = boundary?.mechanism === "bwrap-argv" ? undefined : beginSandboxExecution(policy);
  if (boundary?.mechanism === "bwrap-argv") {
    wrapped = [...boundary.content, "/bin/bash", "-c", command];
  } else {
    wrapped = fencedArgvUnchecked(policy, command, membership);
    if (boundary?.mechanism === "seatbelt-profile") {
      // The exact captured profile is the authority retained with the effect.
      // Do not execute a second profile generated after its final comparison.
      if (wrapped[1] !== "-p") throw new Error("protected observer Seatbelt argv is invalid");
      wrapped[2] = boundary.content;
    }
  }
  // P1 (D58c): the execution owns a process group (a session of its own,
  // `detached`), so everything it starts without leaving that group is ended
  // with it; the cut is SIGKILL — a trap on SIGTERM cannot outlive the host's
  // bound — and once the spawn returns the host ends what is left of the tree
  // and verifies nothing of it survives (endExecutionTree). bwrap ends its
  // whole PID namespace with its first process and dies with the host
  // (--die-with-parent); Seatbelt and an unfenced child have no such bond, so
  // their group carries a lifeline that ends it if the host itself dies, and
  // the process the host spawns is the execution's anchor, so the cut never
  // orphans the execution's own processes (lifelineArgv). What the operator's
  // terminal sends the host's group no longer reaches the execution's group
  // by itself; the host's relay passes it on (hostRelayFile).
  let result: ReturnType<typeof Bun.spawnSync>;
  let survivors = 0;
  try {
    // LX (D58c): the scratch view's directories are session-writable paths,
    // and a backend resolves them when it starts — bwrap a bind's source,
    // following any link on the way — so right before the spawn each must
    // still be the real directory the policy sealed; otherwise the execution
    // is not made (unknown, never a write led elsewhere). The Seatbelt profile
    // names them exactly as sealed, never their real paths now.
    assertScratchViewUnchanged(policy);
    // G3' (D57h): a judged execution starts with an empty cache made for it
    // alone, and leaves nothing there for the next one.
    renewJudgedToolCache(policy.toolCacheDir);
    const relayFile = hostRelayFile();
    const lifelined = lifelineArgv(policy, wrapped, relayFile);
    result = unregisteredAfter(relayFile, () => Bun.spawnSync(lifelined, {
      cwd: policy.workspaceRoot,
      env: policy.backend === "docker"
        ? { ...(policy.dockerHostEnv ?? {}) }
        : { ...policy.childEnv },
      stdout: "pipe",
      stderr: "pipe",
      ...(stdin === undefined ? {} : { stdin }),
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      timeout: timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
      ...(process.platform === "win32" ? {} : { detached: true }),
    }));
    survivors = endExecutionTree(result.pid);
  } finally {
    // The execution is over only when nothing of it can still write: its
    // process tree is ended (P1) and every process its profile confines is
    // ended before the caller takes the after-image (G2', D57h).
    survivors += endSandboxExecution(policy, membership);
    renewJudgedToolCache(policy.toolCacheDir);
  }
  // Bun's declared exitCode type omits the null returned for signal/timeout termination.
  const raw = result as Omit<typeof result, "exitCode"> & { exitCode: number | null; error?: unknown };
  const error = raw.error === undefined || raw.error === null
    ? undefined
    : redactText(raw.error instanceof Error ? raw.error.message : String(raw.error));
  // bwrap and Docker report inner process signals as shell-compatible statuses.
  // An explicit exit in this range is indistinguishable: retain the observed
  // code, never invent a signal, and leave child completion unqualified.
  const completionUnavailable = (policy.backend === "bwrap" || policy.backend === "docker")
    && raw.signalCode === undefined
    && raw.exitCode !== null && raw.exitCode >= 129 && raw.exitCode <= 255;
  return {
    exitCode: raw.exitCode ?? 1,
    stdout: raw.stdout?.toString() ?? "",
    stderr: raw.stderr?.toString() ?? "",
    ...(options.captureBytes ? { stdoutBase64: raw.stdout?.toString("base64") ?? "", stderrBase64: raw.stderr?.toString("base64") ?? "" } : {}),
    ...(raw.exitCode === null ? { rawExitCode: null } : {}),
    ...(raw.signalCode === undefined ? {} : { signal: raw.signalCode }),
    ...(error === undefined ? {} : { error }),
    ...(raw.exitedDueToTimeout === true ? { timedOut: true } : {}),
    ...(raw.exitedDueToMaxBuffer === true ? { maxBufferExceeded: true } : {}),
    ...(completionUnavailable ? { completionUnavailable: true } : {}),
    ...(survivors > 0 ? { survivors } : {}),
  };
}

/**
 * The spawned process of an execution in a group of its own (P1): a host
 * shell, outside every sandbox, that registers the group with the host's
 * relay (hostRelayFile) and then becomes the execution (`exec`, the same
 * process, so exit statuses and signals are the execution's own). For Seatbelt
 * and the fence off — no PID namespace ends what the execution leaves — it
 * also starts the group's lifeline and becomes the execution's anchor
 * (EXECUTION_ANCHOR) rather than the execution itself. The lifeline is a
 * watcher in a group of its own (job control), its stdio closed — so what is
 * left of the execution's group once it ended is the execution's alone
 * (endExecutionTree) —: it looks at the host and at the execution's group
 * once a second, ends the group when the host is gone, and ends itself when
 * the group is; a signal the execution sends its own group or session does not
 * reach it. bwrap needs neither (--die-with-parent, its PID namespace);
 * Docker's process tree is the container's.
 */
function lifelineArgv(policy: SandboxPolicy, argv: string[], relayFile: string | undefined): string[] {
  if (process.platform === "win32") return argv;
  const register = "{ [ -z \"$2\" ] || printf '%s' \"$$\" > \"$2\"; } 2>/dev/null";
  if (policy.backend === "seatbelt" || policy.backend === "none") {
    // Outside every sandbox, with the execution's own PATH (which can name
    // directories of the workspace): only builtins and absolute paths here.
    // `$$` is the execution's pid, its group's id. It looks soon at first
    // and then once a second, so the lifeline of a short execution is gone
    // soon after it.
    const watcher = "PATH=/usr/bin:/bin; trap '' HUP INT TERM; d=0.01; "
      + "while kill -0 \"$1\" 2>/dev/null && kill -0 -- \"-$$\" 2>/dev/null; do /bin/sleep $d; "
      + "case $d in 0.01) d=0.05 ;; 0.05) d=0.2 ;; *) d=1 ;; esac; done; "
      + "kill -0 \"$1\" 2>/dev/null || kill -KILL -- \"-$$\" 2>/dev/null";
    const anchor = existsSync(ANCHOR_PERL) ? EXECUTION_ANCHOR : "";
    return [
      "/bin/bash", "-c",
      `${register}; set -m; ( ${watcher} ) </dev/null >/dev/null 2>&1 & set +m; `
        + `a=$3; shift 3; [ -z "$a" ] || exec ${ANCHOR_PERL} -e "$a" "$@"; exec "$@"`,
      "dokkabi-lifeline", String(process.pid), relayFile ?? "", anchor, ...argv,
    ];
  }
  if (relayFile === undefined || !isAbsolute(argv[0] ?? "")) return argv;
  return ["/bin/bash", "-c", `${register}; shift 2; exec "$@"`, "dokkabi-lifeline", String(process.pid), relayFile, ...argv];
}

const ANCHOR_PERL = "/usr/bin/perl";

/**
 * The anchor of a Seatbelt or unfenced execution (P1): the process the host
 * spawned runs the execution as its child and ends exactly as the execution
 * ended — the same exit status, or the same signal raised on itself — so the
 * host's cut (a SIGKILL of the process it spawned) never orphans the
 * execution's own processes before the host looks at its tree: a descendant
 * that left the group still has its parent there. INT, TERM, HUP and QUIT sent
 * to the group reach the execution with the dispositions it would have had;
 * the anchor waits. Without a fork it becomes the execution itself.
 */
const EXECUTION_ANCHOR = [
  // No module: loading one (POSIX) cost the anchor about 15 ms an execution.
  "my @s = qw(INT TERM HUP QUIT); my %o = map { $_ => $SIG{$_} } @s;",
  "$SIG{$_} = 'IGNORE' for @s;",
  "my $p = fork;",
  "if (!defined $p || $p == 0) { if (defined $p) { $SIG{$_} = defined $o{$_} ? $o{$_} : 'DEFAULT' for @s } exec { $ARGV[0] } @ARGV; exit 127 }",
  "my $w; do { $w = waitpid($p, 0) } while ($w == -1 && kill(0, $p));",
  "exit 127 if $w != $p;",
  // Every other signal keeps the disposition the anchor was started with,
  // the execution's own.
  "if ($? & 127) { my $n = $? & 127; $SIG{$_} = 'DEFAULT' for @s; kill $n, $$; exit 128 + $n }",
  "exit($? >> 8);",
].join(" ");

/**
 * The host's relay (P1). An execution in a group of its own no longer receives
 * what the operator's terminal sends the host's group — Ctrl-C, Ctrl-\, a
 * hangup — and a host blocked in its spawn cannot pass it on (before D58c the
 * execution shared the host's group and received it directly). One relay
 * process per host, in the host's own group, passes it on: each execution's
 * first process registers its group in the relay's directory (lifelineArgv),
 * and the relay sends INT, TERM, HUP and QUIT on to every group registered
 * there; once the host is gone it ends them and removes the directory. The
 * host removes a registration as soon as its spawn returned.
 */
const RELAY_SCRIPT = [
  "host=$1; dir=$2",
  "relay() { for f in \"$dir\"/*; do [ -f \"$f\" ] || continue; g=$(/bin/cat -- \"$f\" 2>/dev/null) || continue; case $g in ''|*[!0-9]*) continue ;; esac; [ \"$g\" -gt 1 ] && kill -\"$1\" -- \"-$g\" 2>/dev/null; done; }",
  "trap 'relay INT' INT; trap 'relay TERM' TERM; trap 'relay HUP' HUP; trap 'relay QUIT' QUIT",
  "while kill -0 \"$host\" 2>/dev/null; do /bin/sleep 1; done",
  "relay KILL; /bin/rm -rf -- \"$dir\"",
].join("\n");
let hostRelay: { readonly dir: string; readonly child: { readonly exitCode: number | null; readonly signalCode: string | null } } | undefined;
let hostRelaySeq = 0;

/** A fresh registration path in the host's relay, the relay started first
 * when there is none (or it is gone); undefined when none can be had — the
 * execution then runs unrelayed. */
function hostRelayFile(): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    if (hostRelay === undefined || hostRelay.child.exitCode !== null || hostRelay.child.signalCode !== null || !existsSync(hostRelay.dir)) {
      const dir = mkdtempSync(join(tmpdir(), "dokkabi-interrupt-relay-"));
      const child = Bun.spawn(["/bin/bash", "-c", RELAY_SCRIPT, "dokkabi-relay", String(process.pid), dir], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      });
      child.unref();
      hostRelay = { dir, child };
    }
    hostRelaySeq += 1;
    return join(hostRelay.dir, String(hostRelaySeq));
  } catch {
    return undefined;
  }
}

/** Run `spawn`, then drop the execution's registration with the relay. */
function unregisteredAfter<T>(relayFile: string | undefined, spawn: () => T): T {
  try {
    return spawn();
  } finally {
    if (relayFile !== undefined) {
      try {
        rmSync(relayFile, { force: true });
      } catch {
        // The relay's directory went away: nothing is registered.
      }
    }
  }
}

/** Whether any process of group `pgid` exists (a zombie counts until it is
 * reaped). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

function signalQuietly(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // Gone already.
  }
}

export function parseExecutionProcessTable(text: string): { pid: number; ppid: number; pgid: number }[] | undefined {
  const rows: { pid: number; ppid: number; pgid: number }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 3 || fields.some(value => !/^\d+$/.test(value))) return undefined;
    const [pid, ppid, pgid] = fields.map(Number);
    if (![pid, ppid, pgid].every(value => Number.isSafeInteger(value) && value! >= 0) || pid! < 1) return undefined;
    rows.push({ pid: pid!, ppid: ppid!, pgid: pgid! });
  }
  return rows.length ? rows : undefined;
}

interface ExecutionTreeCut extends Set<number> { unverified: boolean }

/** The host's process table: pid, parent, group. Undefined when `ps` cannot
 * be read. */
function processTable(): { readonly pid: number; readonly ppid: number; readonly pgid: number }[] | undefined {
  for (const ps of ["/bin/ps", "/usr/bin/ps"]) {
    if (!existsSync(ps)) continue;
    try {
      const listed = Bun.spawnSync([ps, "-A", "-o", "pid=,ppid=,pgid="], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
      if (listed.exitCode !== 0) continue;
      const rows = parseExecutionProcessTable(listed.stdout.toString());
      if (rows !== undefined) return rows;
    } catch {
      // The next place.
    }
  }
  return undefined;
}

/** How long the host waits for an ended tree to be gone (a killed process is
 * a zombie until its new parent reaps it). */
const TREE_END_WAIT_MS = 2_000;

/**
 * End what is left of one execution's process tree and verify nothing of it
 * survives (P1): `leader` is the spawned process, the leader of the
 * execution's own process group, already reaped. When anything of the group
 * is left — a cut execution, or what an ended one left running — the group is
 * frozen (SIGSTOP) and the host's process table read, round after round until
 * a round finds nothing new: every process of the group, and every descendant
 * of one through its parent — one that left for a group or session of its own
 * too —, is frozen by itself as well (a process forked while its group was
 * being frozen does not inherit the stop, and may leave the group before the
 * group is killed). Then all of it is killed (SIGKILL: the group, each process
 * seen, and the group each one leads), and the host waits until the group and
 * each process seen are gone. A descendant that left both its group and its
 * parent before the host looked (a double fork) is out of any walk's reach
 * under Seatbelt; bwrap's PID namespace ends it. Returns how many are not
 * gone, plus a nonzero sentinel for unverified membership (the caller records
 * it, and an execution with
 * survivors is never judged).
 */
export function endExecutionTree(leader: number | undefined): number {
  if (leader === undefined || !Number.isSafeInteger(leader) || leader <= 1 || process.platform === "win32") return 1;
  const seen = cutExecutionTree(leader);
  if (seen === undefined) return 0;
  const deadline = Date.now() + TREE_END_WAIT_MS;
  for (;;) {
    const left = (groupAlive(leader!) ? 1 : 0) + [...seen].filter(processAlive).length;
    if (left === 0) return seen.unverified ? 1 : 0;
    if (Date.now() >= deadline) return left + (seen.unverified ? 1 : 0);
    Bun.sleepSync(2);
  }
}

/** The first half of endExecutionTree: stop, walk and kill the tree without
 * waiting. Returns every process seen, or undefined when there was none. */
function cutExecutionTree(leader: number | undefined): ExecutionTreeCut | undefined {
  if (process.platform === "win32" || leader === undefined || !Number.isSafeInteger(leader) || leader <= 1) return Object.assign(new Set<number>(), { unverified: true });
  if (!groupAlive(leader)) return undefined;
  const seen: ExecutionTreeCut = Object.assign(new Set<number>(), { unverified: false });
  signalQuietly(-leader, "SIGSTOP");
  for (let round = 0; round < 16; round += 1) {
    const table = processTable();
    if (table === undefined) { seen.unverified = true; break; }
    const tree = new Set(table.filter((row) => row.pgid === leader && row.pid > 1 && row.pid !== process.pid).map((row) => row.pid));
    for (const row of table) if (seen.has(row.pid)) tree.add(row.pid);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of table) {
        if (tree.has(row.pid) || !tree.has(row.ppid) || row.pid <= 1 || row.pid === process.pid) continue;
        tree.add(row.pid);
        changed = true;
      }
    }
    let grew = false;
    for (const pid of tree) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      grew = true;
    }
    signalQuietly(-leader, "SIGSTOP");
    for (const pid of seen) signalQuietly(pid, "SIGSTOP");
    if (!grew) break;
    if (round === 15) seen.unverified = true;
  }
  signalQuietly(-leader, "SIGKILL");
  for (const pid of seen) {
    signalQuietly(pid, "SIGKILL");
    // One that leads a group of its own takes its group with it.
    signalQuietly(-pid, "SIGKILL");
  }
  return seen;
}

/**
 * The wrapper shell for the Pi bash tool: NodeExecutionEnv spawns
 * <shellPath> -c <command>; this script re-execs the command through the
 * selected sandbox backend while the loop's own HTTPS stays outside. The
 * script must live OUTSIDE the workspace: inside the fence the child could
 * rewrite it and strip the sandbox.
 */
export function writeWrapperScript(policy: SandboxPolicy, targetPath: string): string {
  assertSandboxPolicyEnforceable(policy);
  // G3' (D57h): a wrapper runs executions the host does not spawn itself, so
  // it cannot renew a judged cache around each one; judged runs go through
  // spawnPreparedSandbox only.
  if (isJudgedToolCache(policy.toolCacheDir)) throw new Error("a judged policy has no wrapper shell");
  const safeTarget = privateWrapperTarget(policy, targetPath);
  // G2 (D57g): the execution's environment marker crosses the fence's
  // cleared environment (`env -i` / `--clearenv`): whatever the caller set.
  const withMarker = (argv: string[], after: string, marker: string[]): string => {
    const at = argv.indexOf(after);
    const words = argv.map(shellWord);
    if (at < 0) return words.join(" ");
    return [...words.slice(0, at + 1), ...marker, ...words.slice(at + 1)].join(" ");
  };
  const execLine = policy.backend === "none"
    ? 'exec /bin/bash "$@"'
    : policy.backend === "docker"
    ? dockerWrapperCommand(policy)
    : policy.backend === "seatbelt"
      ? `exec ${withMarker(seatbeltArgvUnchecked(policy, ["/bin/bash"], CAPABILITY_SLOT), "-i", [`"${EXEC_MARKER_ENV}=\${${EXEC_MARKER_ENV}:-}"`]).replace(shellWord(`${EXECUTION_CAPABILITY_PARAM}=${CAPABILITY_SLOT}`), `"${EXECUTION_CAPABILITY_PARAM}=\${${EXECUTION_CAPABILITY_ENV}}"`)} "$@"`
      : `exec ${withMarker(bwrapArgvUnchecked(policy, ["/bin/bash"]), "--clearenv", ["--setenv", EXEC_MARKER_ENV, `"\${${EXEC_MARKER_ENV}:-}"`])} "$@"`;
  // G2' (D57h): the call's capability path comes from the host through the
  // wrapper's own environment (never across the fence); a call the host
  // does not track gets the unassigned one, which no process is allowed.
  const capabilityLine = policy.backend === "seatbelt"
    ? [`${EXECUTION_CAPABILITY_ENV}=\${${EXECUTION_CAPABILITY_ENV}:-${shellWord(seatbeltUnassignedCapability(policy))}}`]
    : [];
  const script = ["#!/bin/sh", "set -eu", ...capabilityLine, execLine, ""].join("\n");
  writeFileSync(safeTarget, script, { mode: 0o755 });
  return safeTarget;
}

/** A placeholder the wrapper replaces with the call's capability path. */
const CAPABILITY_SLOT = "/dokkabi-execution-capability-slot";

function privateWrapperTarget(policy: SandboxPolicy, targetPath: string): string {
  if (!isAbsolute(targetPath)) throw new Error("sandbox wrapper path must be absolute");
  const requested = resolve(targetPath);
  if (pathWithin(policy.workspaceRoot, requested)) {
    throw new Error("sandbox wrapper must live outside the writable workspace");
  }
  const parent = dirname(requested);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parent);
    const stat = statSync(canonicalParent);
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isDirectory() || !owned || (stat.mode & 0o077) !== 0 ||
      pathWithin(policy.workspaceRoot, canonicalParent)) {
      throw new Error("untrusted parent");
    }
    try {
      if (lstatSync(requested).isSymbolicLink()) throw new Error("symlink");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? Reflect.get(error, "code")
        : undefined;
      if (code !== "ENOENT") throw error;
    }
  } catch {
    throw new Error("sandbox wrapper parent must be a private host-owned directory");
  }
  const canonicalTarget = join(canonicalParent, requested.slice(parent.length).replace(/^[/\\]+/u, ""));
  if (pathWithin(policy.workspaceRoot, canonicalTarget)) {
    throw new Error("sandbox wrapper must live outside the writable workspace");
  }
  return canonicalTarget;
}

function minimalSystemMounts(policy: SandboxPolicy): string[] {
  const args: string[] = ["--ro-bind", "/usr", "/usr"];
  for (const [link, target] of [["/bin", "usr/bin"], ["/sbin", "usr/sbin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"]] as const) {
    if (!existsSync(link)) continue;
    let canonical = "";
    try {
      canonical = realpathSync(link);
    } catch {
      canonical = "";
    }
    if (canonical === `/${target}`) args.push("--symlink", target, link);
    else args.push("--ro-bind", link, link);
  }
  args.push("--dir", "/etc");
  const identity = HOST_SANDBOX_IDENTITIES.get(policy);
  if (!identity) throw new Error("bwrap sandbox identity is missing");
  args.push("--ro-bind", identity.passwd, "/etc/passwd", "--ro-bind", identity.group, "/etc/group");
  for (const directory of [
    "/etc/ssl/certs",
    "/etc/pki/ca-trust",
    "/etc/pki/tls/certs",
    "/etc/alternatives",
  ]) {
    if (existsSync(directory)) args.push(...mountParentDirs(directory), "--ro-bind", directory, directory);
  }
  for (const file of ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/os-release"]) {
    if (!existsSync(file)) continue;
    let source = file;
    try {
      source = realpathSync(file);
    } catch {
      source = file;
    }
    args.push("--ro-bind", source, file);
  }
  const runtime = policy.runtimeExecutable;
  if (!pathWithin("/usr", runtime) && !pathWithin(policy.workspaceRoot, runtime)) {
    args.push(...mountParentDirs(runtime), "--ro-bind", runtime, runtime);
  }
  return args;
}

function createSandboxIdentityFiles(): SandboxIdentityFiles {
  const uid = process.getuid?.() ?? 65_534;
  const gid = process.getgid?.() ?? 65_534;
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("sandbox runtime identity is invalid");
  }
  const root = mkdtempSync(join(tmpdir(), "dokkabi-sandbox-identity-"));
  HOST_SANDBOX_IDENTITY_ROOTS.add(root);
  const passwd = join(root, "passwd");
  const group = join(root, "group");
  const passwdBytes = `dokkabi:x:${uid}:${gid}:Dokkabi sandbox:${SANDBOX_DOKKABI_HOME}:/bin/bash\n`;
  const groupBytes = `dokkabi:x:${gid}:\n`;
  writeFileSync(passwd, passwdBytes, { mode: 0o644 });
  writeFileSync(group, groupBytes, { mode: 0o644 });
  const digest = createHash("sha256").update(passwdBytes).update("\0").update(groupBytes).digest("hex");
  return Object.freeze({ root, passwd, group, digest });
}

function assertSandboxIdentity(policy: SandboxPolicy): void {
  const identity = HOST_SANDBOX_IDENTITIES.get(policy);
  if (!identity || policy.sandboxIdentityDigest !== identity.digest) {
    throw new Error("bwrap sandbox identity is incomplete");
  }
  try {
    const digest = createHash("sha256")
      .update(readFileSync(identity.passwd))
      .update("\0")
      .update(readFileSync(identity.group))
      .digest("hex");
    if (digest !== identity.digest) throw new Error("changed");
  } catch {
    throw new Error("bwrap sandbox identity changed after policy seal");
  }
}

function disposeSandboxIdentity(identity: SandboxIdentityFiles): void {
  HOST_SANDBOX_IDENTITY_ROOTS.delete(identity.root);
  rmSync(identity.root, { recursive: true, force: true });
}

function mountParentDirs(target: string): string[] {
  const absolute = resolve(target);
  const parts = dirname(absolute).split("/").filter(Boolean);
  const args: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (current === "/usr" || current.startsWith("/usr/") || current === "/opt" || current.startsWith("/opt/")) break;
    args.push("--dir", current);
  }
  return args;
}

function environmentArgs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => ["--setenv", key, value]);
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function policyExecutableSeal(policy: SandboxPolicy): SandboxHostExecutableSeal {
  if (policy.backend === "bwrap" && policy.bwrapBinary) {
    return {
      name: "bwrap",
      path: policy.bwrapBinary,
      identity: policy.backendExecutableIdentity,
      statIdentity: policy.backendExecutableStatIdentity,
    };
  }
  if (policy.backend === "docker" && policy.dockerBinary) {
    return {
      name: "docker",
      path: policy.dockerBinary,
      identity: policy.backendExecutableIdentity,
      statIdentity: policy.backendExecutableStatIdentity,
    };
  }
  if (policy.backend === "seatbelt" && policy.seatbeltBinary) {
    return {
      name: "seatbelt",
      path: policy.seatbeltBinary,
      identity: policy.backendExecutableIdentity,
      statIdentity: policy.backendExecutableStatIdentity,
    };
  }
  throw new Error("sandbox backend executable seal is incomplete");
}

/** docker exec joins an existing container's network namespace and cannot
 * add a per-command fence. Writable execution therefore re-attests whether
 * the world has any live network endpoint; read-only execution creates a
 * disposable `docker run --network none` sibling. These helpers stay private
 * so every execution-producing seam first checks the host policy seal. */
function assertDockerNetworkPolicy(policy: SandboxPolicy): void {
  if (policy.backend !== "docker") return;
  if (!policy.dockerBinary) throw new Error("Docker sandbox needs an attested executable");
  if (!policy.dockerHostEnv || !Object.isFrozen(policy.dockerHostEnv) ||
    policy.dockerHostEnvDigest !== dockerHostEnvironmentDigest(policy.dockerHostEnv)) {
    throw new Error("Docker host connection environment is not sealed");
  }
  if (policy.mode === "read-only") {
    if (!policy.dockerImage) throw new Error("read-only Docker sandbox needs an image");
    if (!policy.dockerImageIdentityDigest || !/^[a-f0-9]{64}$/u.test(policy.dockerImageIdentityDigest)) {
      throw new Error("read-only Docker sandbox needs a sealed image identity");
    }
    if (policy.dockerNetworkState !== "none" || !policy.networkDenied) {
      throw new Error("read-only Docker sandbox must seal network none");
    }
    return;
  }
  if (!policy.dockerContainer) throw new Error("writable Docker sandbox needs an existing container");
  if (!policy.dockerMountDigest || !/^[a-f0-9]{64}$/u.test(policy.dockerMountDigest)) {
    throw new Error("writable Docker sandbox needs an attested workspace mount");
  }
  for (const digest of [
    policy.dockerContainerIdentityDigest,
    policy.dockerImageIdentityDigest,
    policy.dockerSecurityDigest,
  ]) {
    if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error("writable Docker sandbox needs sealed container, image, and security identity");
    }
  }
  if (policy.dockerNetworkState !== "connected" && policy.dockerNetworkState !== "none") {
    throw new Error("writable Docker sandbox needs a sealed connected or none network state");
  }
  if (policy.networkDenied !== (policy.dockerNetworkState === "none")) {
    throw new Error("Docker world network state does not match the sealed network policy");
  }
}

function dockerFencedArgv(policy: SandboxPolicy, command: string): string[] {
  const containerCommand = dockerWorkspaceCommand(policy, command);
  if (policy.mode === "read-only") return [...dockerReadOnlyPrefix(policy), "-c", containerCommand];
  const executionTarget = sealedDockerExecutionTarget(policy);
  return [
    policy.dockerBinary!, "exec", "--user", hostUser(),
    "-w", "/testbed", executionTarget,
    "/usr/bin/env", "-i", ...dockerEnvironmentAssignments(policy),
    "bash", "-lc", containerCommand,
  ];
}

function dockerWorkspaceCommand(policy: SandboxPolicy, command: string): string {
  const root = policy.workspaceRoot.replace(/\/+$/u, "");
  return root ? command.replaceAll(`${root}/`, "/testbed/") : command;
}

function dockerWrapperCommand(policy: SandboxPolicy): string {
  if (policy.mode === "read-only") {
    return `exec ${dockerReadOnlyPrefix(policy).map(shellWord).join(" ")} "$@"`;
  }
  const executionTarget = sealedDockerExecutionTarget(policy);
  const expectNone = policy.dockerNetworkState === "none";
  const inspect = [
    `DOKKABI_DOCKER_NETWORK_STATE=$(${shellWord(policy.dockerBinary!)} inspect --format '{{.HostConfig.NetworkMode}}|{{range $name, $_ := .NetworkSettings.Networks}}{{$name}},{{end}}' ${shellWord(executionTarget)})`,
    `case "$DOKKABI_DOCKER_NETWORK_STATE" in *'|'*) ;; *) exit 125;; esac`,
    `DOKKABI_DOCKER_NETWORK_MODE=\${DOKKABI_DOCKER_NETWORK_STATE%%|*}`,
    `DOKKABI_DOCKER_NETWORK_ENDPOINTS=\${DOKKABI_DOCKER_NETWORK_STATE#*|}`,
    ...(expectNone
      ? [
          `[ "$DOKKABI_DOCKER_NETWORK_MODE" = none ] || exit 125`,
          `[ "$DOKKABI_DOCKER_NETWORK_ENDPOINTS" = none, ] || exit 125`,
        ]
      : [
          `case "$DOKKABI_DOCKER_NETWORK_MODE" in ''|none|host|container:*) exit 125;; esac`,
          `case ",$DOKKABI_DOCKER_NETWORK_ENDPOINTS" in *',none,'*|*',host,'*) exit 125;; esac`,
          `DOKKABI_DOCKER_EXPECTED_NETWORK="$DOKKABI_DOCKER_NETWORK_MODE"`,
          `[ "$DOKKABI_DOCKER_EXPECTED_NETWORK" != default ] || DOKKABI_DOCKER_EXPECTED_NETWORK=bridge`,
          `case ",$DOKKABI_DOCKER_NETWORK_ENDPOINTS" in *",$DOKKABI_DOCKER_EXPECTED_NETWORK,"*) ;; *) exit 125;; esac`,
        ]),
  ].join("\n");
  const exec = [
    policy.dockerBinary!, "exec", "--user", hostUser(),
    "-w", "/testbed", executionTarget,
    "/usr/bin/env", "-i", ...dockerEnvironmentAssignments(policy),
    "/bin/bash", "-l",
  ].map(shellWord).join(" ");
  return `${inspect}\nexec ${exec} "$@"`;
}

function sealedDockerExecutionTarget(policy: SandboxPolicy): string {
  const target = HOST_SEALED_DOCKER_EXECUTION_TARGETS.get(policy);
  if (!target) throw new Error("Docker world execution identity is missing");
  return target;
}

function dockerReadOnlyPrefix(policy: SandboxPolicy): string[] {
  const commonGitDir = policy.gitCommonDir;
  const imageTarget = HOST_SEALED_DOCKER_IMAGE_TARGETS.get(policy);
  if (!imageTarget) throw new Error("Docker image execution identity is missing");
  const cache = HOST_PRIVATE_CACHE_ROOTS.get(policy);
  if (cache) assertPrivateCacheRoot(cache);
  return [
    policy.dockerBinary!, "run", "--rm", "--network", "none", "--read-only",
    ...(cache ? ["--label", `dokkabi.speculative.warmup=${cache.label}`] : []),
    "--user", hostUser(),
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev",
    "--mount", `type=bind,source=${policy.workspaceRoot},target=/testbed,readonly`,
    ...(cache ? ["--mount", `type=bind,source=${cache.path},target=${cache.path}`] : []),
    ...(commonGitDir ? ["--mount", `type=bind,source=${commonGitDir},target=${commonGitDir},readonly`] : []),
    "-w", "/testbed", "--entrypoint", "/usr/bin/env", "-i", imageTarget,
    "-i", ...dockerEnvironmentAssignments(policy),
    "/bin/bash", "-l",
  ];
}

function sealPrivateCacheRoot(workspaceRoot: string, requested: string): PrivateCacheRoot {
  if (!isAbsolute(requested)) throw new Error("private cache root must be absolute");
  const normalized = resolve(requested);
  const canonical = realpathSync(normalized);
  if (canonical !== normalized || pathWithin(workspaceRoot, canonical)) {
    throw new Error("private cache root must be canonical and outside the workspace");
  }
  const stat = lstatSync(canonical, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? Number(stat.uid));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077n) !== 0n) {
    throw new Error("private cache root must be a private owned directory");
  }
  const identity = `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
  const label = createHash("sha256").update(canonical).update("\0").update(identity).digest("hex");
  return Object.freeze({ path: canonical, identity, label });
}

function assertPrivateCacheRoot(cache: PrivateCacheRoot): void {
  const current = sealPrivateCacheRoot("/__dokkabi_no_workspace__", cache.path);
  if (current.identity !== cache.identity) throw new Error("private cache root changed after policy seal");
}

/** Exact child environment after backend-specific execution transformations. */
export function effectiveSandboxChildEnvironment(policy: SandboxPolicy): Readonly<Record<string, string>> {
  if (policy.backend !== "docker") return policy.childEnv;
  return Object.freeze({
    ...policy.childEnv,
    DOKKABI_SANDBOX_WORKSPACE: "/testbed",
    ...(policy.mode === "read-only" ? {
      PYTHONDONTWRITEBYTECODE: "1",
      HYPOTHESIS_STORAGE_DIRECTORY: "/tmp/hypothesis",
    } : {}),
  });
}

function dockerEnvironmentAssignments(policy: SandboxPolicy): string[] {
  return Object.entries(effectiveSandboxChildEnvironment(policy))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hostUser(): string {
  return `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}
