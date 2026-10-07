import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { EventLog } from "./event-log.ts";
import type { SandboxPolicy } from "./sandbox.ts";
import { EXECUTION_CAPABILITY_PARAM, SESSION_CAPABILITY_PARAM, sessionCapabilityPath } from "./execution-membership.ts";
import { hostOwnedDenials } from "./host-owned.ts";

const SYSTEM_READ_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library",
  "/Applications",
  "/etc",
  "/private/etc",
  "/private/var/db",
  "/private/var/protected/trustd",
  "/dev",
] as const;

const PROBE_DIGEST = createHash("sha256")
  .update("seatbelt-startup-probe:v1:allowed-write,host-private-read,shared-temp-write")
  .digest("hex")
  .slice(0, 16);

/** SBPL enforced by `/usr/bin/sandbox-exec` for one model-controlled child. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const reads = readableSelectors(policy).map((selector) => `  ${selector}`).join("\n");
  const ancestorDirectoryReads = workspaceAncestorDirectoryRule(policy.workspaceRoot);
  const executableMaps = executableSelectors(policy).map((selector) => `  ${selector}`).join("\n");
  const writes = writableSubpaths(policy)
    .map((path) => `  (subpath "${escapeSbpl(path)}")`)
    .join("\n");
  const signal = policy.observerIsolation
    ? "(allow signal (target same-sandbox))"
    : "(allow signal)";
  const namedIpc = policy.observerIsolation ? "" : `(allow mach-lookup)
(allow ipc-posix-shm*)
(allow ipc-posix-sem)`;
  const network = policy.networkDenied
    ? "(deny network*)"
    : "(allow network*)";
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
${signal}
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))
(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))
(allow file-read-metadata)
${ancestorDirectoryReads}
(allow file-read* file-test-existence (literal "/"))
(allow file-read*
${reads}
)
(allow file-test-existence
${reads}
)
(allow file-map-executable
${executableMaps}
)
(allow file-ioctl)
(allow file-write*
${writes}
  (literal "/dev/null")
  (literal "/dev/dtracehelper")
)
${hostOwnedDenies(policy)}${capabilityRule()}${namedIpc}
(allow system-socket)
${network}
(deny network-outbound
  (require-all
    (remote unix-socket)
    (require-not (literal "/private/var/run/mDNSResponder"))))
${hostOwnedRules(policy)}`;
}

/** Host-owned state inside this session's writable roots (host-owned.ts, K1''):
 * key directories denied whole, the sessions area and the configuration file
 * denied every write, and every directory between the root and them made
 * unwritable, so none can be renamed out from under the deny. Last in the
 * profile: a later rule wins. Empty for every root that contains none. */
function hostOwnedRules(policy: SandboxPolicy): string {
  const denials = hostOwnedDenials(writableSubpaths(policy));
  return [
    ...denials.subpaths.map((path) => `(deny file-read* file-write* (subpath "${escapeSbpl(path)}"))\n`),
    ...denials.writeSubpaths.map((path) => `(deny file-write* (subpath "${escapeSbpl(path)}"))\n`),
    ...denials.literals.map((path) => `(deny file-write* (literal "${escapeSbpl(path)}"))\n`),
    // A writable root inside a write-denied area (a ledger scratch under
    // sessions/) is granted again: a later rule wins.
    ...denials.regrants.map((path) => `(allow file-write* (subpath "${escapeSbpl(path)}"))\n`),
    // ...and never over the workspace's own host-owned locations (W2, D57g):
    // their deny is said again after any grant.
    ...(denials.regrants.length > 0 ? [hostOwnedDenies(policy)] : []),
  ].join("");
}

/** G2' (D57h): the execution's capability — one host-owned file, named by
 * the host for each execution through the profile's parameter, that this
 * execution's processes (and no other execution's) may write; the kernel's
 * answer about it is the execution's membership (execution-membership.ts). */
function capabilityRule(): string {
  // G2'' (D57i): and the policy's session file, which every execution of
  // this policy may write and no other policy's: a later sweep classifies
  // what an earlier execution left behind.
  return `(allow file-write-data
  (literal (param "${EXECUTION_CAPABILITY_PARAM}"))
  (literal (param "${SESSION_CAPABILITY_PARAM}")))
`;
}

/** W2 (D57g): host-owned locations inside the workspace are never written
 * by the session — a deny after the workspace's allow (the later rule
 * decides). */
function hostOwnedDenies(policy: SandboxPolicy): string {
  const paths = policy.hostOwnedPaths ?? [];
  if (paths.length === 0) return "";
  return `(deny file-write*
${paths.map((path) => `  (subpath "${escapeSbpl(path)}")`).join("\n")}
)
`;
}

function workspaceAncestorDirectoryRule(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) throw new TypeError("Seatbelt workspace root must be absolute");
  const ancestors: string[] = [];
  for (let current = dirname(workspaceRoot); current !== "/"; current = dirname(current)) {
    ancestors.push(current);
  }
  if (ancestors.length === 0) return "";
  const literals = ancestors.map((path) => `      (literal "${escapeSbpl(path)}")`).join("\n");
  return `(allow file-read-data file-test-existence
  (require-all
    (vnode-type DIRECTORY)
    (require-any
${literals}
    )
  )
)`;
}

/** Digest-only identity for the exact profile; host paths never enter events. */
export function seatbeltProfileDigest(policy: SandboxPolicy): string {
  return createHash("sha256").update(seatbeltProfile(policy)).digest("hex").slice(0, 16);
}

/**
 * Exercise the exact sealed profile before a model loop can open. The effect
 * lands before sandbox-exec runs; failures are durable but disclose no host
 * paths or child output.
 */
export function attestSeatbeltPolicy(policy: SandboxPolicy, log?: EventLog): void {
  if (policy.backend !== "seatbelt") return;
  if (!policy.sandboxTemp) throw new Error("seatbelt sandbox temporary root is missing");
  const profileDigest = seatbeltProfileDigest(policy);
  log?.append({
    kind: "effect",
    name: "sandbox/probe",
    payload: {
      backend: "seatbelt",
      mode: policy.mode,
      network: policy.networkDenied ? "deny" : "allow",
      profile_digest: profileDigest,
      probe_digest: PROBE_DIGEST,
    },
  });

  const allowedWrite = join(policy.sandboxTemp, "startup-probe");
  let deniedRoot: string | undefined;
  let status: "full" | "failed" = "failed";
  let reason = "sandbox-exec-rejected-profile";
  try {
    deniedRoot = mkdtempSync(join(tmpdir(), "dokkabi-seatbelt-denied-"));
    const secret = join(deniedRoot, "host-private");
    const deniedWrite = join(deniedRoot, "shared-temp-write");
    writeFileSync(secret, "host-private-probe\n", { mode: 0o600 });
    const command = [
      "set -u",
      `printf allowed > ${shellWord(allowedWrite)} || exit 31`,
      `if cat ${shellWord(secret)} >/dev/null 2>&1; then exit 32; fi`,
      `if printf denied > ${shellWord(deniedWrite)} 2>/dev/null; then exit 33; fi`,
    ].join("; ");
    const spawnOptions = {
      cwd: policy.workspaceRoot,
      env: { ...policy.childEnv },
      stdout: "pipe" as const,
      stderr: "pipe" as const,
      timeout: 10_000,
    };
    const bootstrap = Bun.spawnSync(seatbeltArgvUnchecked(policy, ["/usr/bin/true"]), spawnOptions);
    if (bootstrap.exitCode !== 0) {
      reason = probeFailureReason(bootstrap, "runtime-bootstrap-denied");
    } else {
      const result = Bun.spawnSync(
        seatbeltArgvUnchecked(policy, ["/bin/bash", "--noprofile", "--norc", "-c", command]),
        spawnOptions,
      );
      if (result.exitCode === 0 &&
        existsSync(allowedWrite) && readFileSync(allowedWrite, "utf8") === "allowed" &&
        !existsSync(deniedWrite)) {
        status = "full";
        reason = "";
      } else if (result.exitCode === 31) {
        reason = "private-session-write-denied";
      } else if (result.exitCode === 32) {
        reason = "host-private-read-allowed";
      } else if (result.exitCode === 33 || existsSync(deniedWrite)) {
        reason = "shared-temp-write-allowed";
      } else {
        reason = probeFailureReason(result, "probe-command-denied");
      }
    }
  } catch {
    reason = "sandbox-exec-probe-error";
  } finally {
    rmSync(allowedWrite, { force: true });
    if (deniedRoot) rmSync(deniedRoot, { recursive: true, force: true });
  }

  log?.append({
    kind: "observe",
    name: "sandbox/probe_result",
    payload: {
      backend: "seatbelt",
      profile_digest: profileDigest,
      probe_digest: PROBE_DIGEST,
      status,
      ...(reason ? { reason } : {}),
    },
  });
  if (status !== "full") {
    throw new Error(`Seatbelt startup attestation failed: ${reason}`);
  }
}

/** The argv of one Seatbelt execution. `capability` is the execution's
 * capability path (execution-membership.ts); an execution the host does not
 * track gets the unassigned one, which no process can be allowed. */
export function seatbeltArgvUnchecked(policy: SandboxPolicy, argv: string[], capability: string = seatbeltUnassignedCapability(policy)): string[] {
  if (policy.backend !== "seatbelt") throw new Error("seatbelt argv requires a seatbelt policy");
  if (!policy.seatbeltBinary) throw new Error("seatbelt sandbox needs a sealed executable");
  return [
    policy.seatbeltBinary,
    "-p",
    seatbeltProfile(policy),
    "-D",
    `${EXECUTION_CAPABILITY_PARAM}=${capability}`,
    "-D",
    `${SESSION_CAPABILITY_PARAM}=${seatbeltSessionCapability(policy)}`,
    "/usr/bin/env",
    "-i",
    ...environmentAssignments(policy.childEnv),
    ...argv,
  ];
}

/** G2' (D57h): the host-owned directory of a Seatbelt policy's execution
 * capabilities — `capability/` in the policy's own runtime root (real path),
 * beside its sandbox home and temp, never inside anything the profile lets
 * an execution write; removed with the policy. Undefined without a runtime
 * root. */
export function seatbeltCapabilityDir(policy: SandboxPolicy): string | undefined {
  if (!policy.sandboxHome) return undefined;
  const root = existingRealpath(dirname(policy.sandboxHome));
  return root === undefined ? undefined : join(root, "capability");
}

/** G2'' (D57i): the policy's session file (execution-membership.ts). */
export function seatbeltSessionCapability(policy: SandboxPolicy): string {
  const dir = seatbeltCapabilityDir(policy);
  return dir === undefined ? "/private/var/empty/dokkabi-no-session-capability" : sessionCapabilityPath(dir);
}

/** The capability of an execution the host does not track (the startup
 * attestation): never created, so no process can be allowed it. */
export function seatbeltUnassignedCapability(policy: SandboxPolicy): string {
  const dir = seatbeltCapabilityDir(policy);
  return dir === undefined ? "/private/var/empty/dokkabi-unassigned-capability" : join(dir, "unassigned");
}

/** Every path a Seatbelt policy grants `file-write*` under (with real
 * paths): the capability directory must lie outside all of them. */
export function seatbeltWritableRoots(policy: SandboxPolicy): string[] {
  return writableSubpaths(policy);
}

function writableSubpaths(policy: SandboxPolicy): string[] {
  // The host's own private roots, and their real paths (a temporary
  // directory under /var is /private/var).
  const hostRoots = [policy.sandboxHome, policy.sandboxTemp].filter((path): path is string => Boolean(path));
  // The session's tool-cache directory (G3, D57g): the directory itself,
  // never its host-owned holder — a holder no session writes, so no session
  // can put a link in the directory's place and its real path is safe (LX).
  if (policy.mode !== "read-only" && policy.toolCacheDir !== undefined) hostRoots.push(policy.toolCacheDir);
  const resolved: string[] = [];
  // Paths a session writes below (D58c LX, S1): exactly as the policy sealed
  // them — canonical there — and never through a link a session placed since:
  // a real path read now would follow it and grant its target. A sealed phase
  // may still own a few paths outright: the decompose turn is required to
  // write the ledger and its RED tests (sandbox.ts), a warm build its cache;
  // each is granted as grantedWritablePath says.
  if (policy.mode === "read-only") resolved.push(...grantedWritablePaths(policy));
  // A read-only scratch view (D58b V4): only the listed directories below the
  // scratch are writable; the scratch itself stays readable (readableSelectors).
  else resolved.push(policy.workspaceRoot, ...(policy.scratchRoot === undefined ? [] : policy.scratchWritable ?? [policy.scratchRoot]));
  if (policy.mode !== "read-only" && policy.gitCommonDirWritable && policy.gitCommonDir) {
    resolved.push(policy.gitCommonDir);
  }
  for (const root of hostRoots) {
    const real = existingRealpath(root);
    resolved.push(root);
    if (real && real !== root) resolved.push(real);
  }
  return [...new Set(resolved)];
}

/** A path that is its own real path now, or does not exist yet: never one
 * reached through a link (LX). */
function isOwnRealPathOrAbsent(path: string): boolean {
  if (!existsSync(path)) return true;
  return existingRealpath(path) === path;
}

/** A read-only phase's writable paths as the profile grants them (LX). */
function grantedWritablePaths(policy: SandboxPolicy): string[] {
  return (policy.writablePaths ?? []).flatMap((path) => {
    const granted = grantedWritablePath(policy, path);
    return granted === undefined ? [] : [granted];
  });
}

/** One writable path of a read-only phase as the profile grants it (LX):
 * itself when it is its own real path or does not exist yet; else, when it is
 * the policy's (canonical) workspace or a path below it reached through a
 * link ABOVE the workspace — one no session controls, as a temporary
 * directory under /var is under /private/var —, the same path below the
 * workspace's real path, provided no link lies between the workspace and it;
 * otherwise nothing: a link a session placed, inside the workspace or
 * anywhere else, never leads a grant anywhere. */
function grantedWritablePath(policy: SandboxPolicy, path: string): string | undefined {
  if (isOwnRealPathOrAbsent(path)) return path;
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    if (existingRealpath(ancestor) === policy.workspaceRoot) {
      const within = join(policy.workspaceRoot, relative(ancestor, path));
      return isOwnRealPathOrAbsent(within) ? within : undefined;
    }
    if (dirname(ancestor) === ancestor) return undefined;
  }
}

function readableSelectors(policy: SandboxPolicy): string[] {
  const directoryRoots = [
    ...SYSTEM_READ_ROOTS,
    ...(policy.toolchainRoots ?? []),
    policy.workspaceRoot,
    policy.gitCommonDir,
    policy.sandboxHome,
    policy.sandboxTemp,
    // A read-only phase's own paths, as they are granted (LX).
    ...(policy.mode === "read-only" ? grantedWritablePaths(policy) : []),
    // The session's scratch space (D48): a writable world reads what it wrote.
    ...(policy.mode !== "read-only" && policy.scratchRoot !== undefined ? [policy.scratchRoot] : []),
    ...(policy.mode !== "read-only" && policy.toolCacheDir !== undefined ? [policy.toolCacheDir] : []),
  ].filter((path): path is string => Boolean(path));
  const selectors = directoryRoots.flatMap((path) => expandedPaths(path)
    .map((root) => `(subpath "${escapeSbpl(root)}")`));
  for (const path of expandedPaths(policy.runtimeExecutable)) {
    selectors.push(`(literal "${escapeSbpl(path)}")`);
  }
  return [...new Set(selectors)];
}

function executableSelectors(policy: SandboxPolicy): string[] {
  const directoryRoots = [
    ...SYSTEM_READ_ROOTS,
    ...(policy.toolchainRoots ?? []),
    policy.workspaceRoot,
    // A throwaway script in scratch (D48) runs like one in the workspace.
    ...(policy.mode !== "read-only" && policy.scratchRoot !== undefined ? [policy.scratchRoot] : []),
  ];
  const selectors = directoryRoots.flatMap((path) => expandedPaths(path)
    .map((root) => `(subpath "${escapeSbpl(root)}")`));
  for (const path of expandedPaths(policy.runtimeExecutable)) {
    selectors.push(`(literal "${escapeSbpl(path)}")`);
  }
  return [...new Set(selectors)];
}

function expandedPaths(path: string): string[] {
  const real = existingRealpath(path);
  return real && real !== path ? [path, real] : [path];
}

function existingRealpath(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function environmentAssignments(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
}

function escapeSbpl(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function probeFailureReason(
  result: { readonly stdout?: Uint8Array; readonly stderr?: Uint8Array },
  fallback: string,
): string {
  const diagnostic = `${result.stdout?.toString() ?? ""}\n${result.stderr?.toString() ?? ""}`;
  return /profile|compile|parse|syntax/i.test(diagnostic) ? "profile-compile-failed" : fallback;
}
