import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync, constants } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { ADOPTION_RECORD, canonicalPath, CONFIG_EXPOSURE_MARKER, configurationTrust, defaultKeyDirectory, doctorKeyDirectory, KEY_EXPOSURE_MARKER, type ConfigurationProblem } from "./host-owned.ts";
import { THINKING_LEVELS } from "./thinking.ts";
import { canonicalJson } from "./canonical.ts";
import { createExclusiveBeneath, openBeneath, readOpened, safeRoot } from "../work/link-safe-fs.ts";
import { digestOf } from "./doctor-report.ts";

/**
 * The identity a readiness report is taken under (#230 round 2, D3).
 *
 * `configDigest` is over the configuration's key structure and enumerated
 * non-secret settings; every free value (and every free key: a repository
 * name, a profile name) is replaced by an HMAC under this installation's own
 * secret key, so a published digest cannot be inverted by guessing — a guess
 * needs the key, which never leaves `~/.dokkabi`. The key is made once, by the
 * first readiness run, link-safe and 0600; a reader that finds none (the
 * dashboard) cannot recheck, and says so.
 */

/** The installation key lives in a directory of its own under the Dokkabi
 * home, never inside a session's writable world (D3'). */
export const INSTALLATION_KEY_DIR = "doctor";
export const INSTALLATION_KEY_FILE = "installation.key";
const KEY_BYTES = 32;

/** The process switches a diagnosis reads. */
export const DIAGNOSED_SWITCHES = [
  "DOKKABI_SANDBOX",
  "DOKKABI_SANDBOX_NET",
  "DOKKABI_SANDBOX_TOOLCHAIN",
  "DOKKABI_PERMISSION_MODE",
  "DOKKABI_APPROVAL_TIMEOUT_SECONDS",
  "DOKKABI_ROUTE",
  "DOKKABI_MODEL",
  "DOKKABI_WORK_LOOP",
  "DOKKABI_WORK_PLANNER",
  "DOKKABI_EXPERIMENT_MANIFEST",
  "DOKKABI_EXPERIMENT_REQUEST",
  "DOKKABI_EVAL_ABLATE",
  "DOKKABI_RESEARCH_POLICY",
  "DOKKABI_RESEARCH_POLICY_SHA256",
  "DOKKABI_WORKSPACE",
] as const;

/** Settings whose values are a closed set: kept in the clear inside the
 * digest input. Every other value is keyed. */
const ENUMERATED: Readonly<Record<string, readonly string[]>> = {
  "permissions.default_mode": ["ask", "auto", "bypass"],
  effort: THINKING_LEVELS,
  "switch.DOKKABI_SANDBOX": ["on", "off"],
  "switch.DOKKABI_SANDBOX_NET": ["allow", "deny"],
  "switch.DOKKABI_SANDBOX_TOOLCHAIN": ["allow", "deny"],
  "switch.DOKKABI_PERMISSION_MODE": ["ask", "auto", "bypass"],
  "switch.DOKKABI_WORK_LOOP": ["graph", "model"],
  "switch.DOKKABI_WORK_PLANNER": ["host", "model", "ledger"],
};
const STRUCTURAL_KEY = /^[a-z_][a-z0-9_]{0,63}$/u;

/** Why the installation key could not be used. Closed vocabulary. */
export type KeyProblem =
  | "home_unusable" | "inside_workspace" | "dir_not_private" | "missing"
  | "not_regular" | "not_private" | "wrong_length" | "unreadable" | "create_failed" | "exposed_to_session"
  | "config_untrusted" | "not_adopted";

export interface InstallationKey {
  readonly key: Buffer;
  /** Names the key without revealing it: `k:` + 16 hex of a domain-separated digest. */
  readonly keyId: string;
  /** False for an ephemeral in-memory key: nothing it signed can be rechecked later. */
  readonly persistent: boolean;
  readonly problem?: KeyProblem;
  /** With `config_untrusted`: why the configuration file is not believed. */
  readonly configProblem?: ConfigurationProblem;
}

export function keyIdOf(key: Buffer): string {
  return `k:${createHash("sha256").update("dokkabi doctor key id\0").update(key).digest("hex").slice(0, 16)}`;
}

function ephemeral(problem: KeyProblem, configProblem?: ConfigurationProblem): InstallationKey {
  const key = randomBytes(KEY_BYTES);
  return { key, keyId: keyIdOf(key), persistent: false, problem, ...(configProblem ? { configProblem } : {}) };
}

/** The adoption record (K1''): which configured directory the operator made
 * current with `doctor --rotate-key`, and the id of the key it holds. */
function readAdoption(): { directory: string; keyId: string } | undefined {
  try {
    const fd = openSync(join(defaultKeyDirectory(), ADOPTION_RECORD), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [directory, keyId] = readFileSync(fd, "utf8").split("\n");
      return directory && keyId ? { directory, keyId } : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function writeAdoption(directory: string, keyId: string): void {
  const home = defaultKeyDirectory();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = join(home, `${ADOPTION_RECORD}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${directory}\n${keyId}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, join(home, ADOPTION_RECORD));
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function privateTo(stat: { mode: number | bigint; uid: number | bigint }): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (Number(stat.mode) & 0o077) === 0 && (uid === undefined || Number(stat.uid) === uid);
}

/**
 * This installation's key (D3', K1''). The configuration file decides the
 * directory only when `configurationTrust` believes it (else
 * `config_untrusted`). A configured directory other than the default is used
 * only as adopted: a key the doctor itself made there, or one `doctor
 * --rotate-key` made current — a directory that already holds a key nobody
 * adopted (or a different key than the one adopted) is `not_adopted`. It lives in `<home>/doctor/installation.key`:
 * the directory is refused when it is a link, not the user's own, open to the
 * group or the world, or inside the workspace (a fenced session can write
 * there); the key when it is not a regular private file of exactly 32 bytes.
 * With `create`, a missing key is written to a temporary name and renamed into
 * place, then read back. Any problem yields an ephemeral in-memory key and
 * names the problem — never a throw.
 */
export function installationKey(options: {
  readonly create: boolean;
  /** Tests: the key directory is `<home>/doctor` instead of the configured one. */
  readonly home?: string;
  readonly workspace?: string;
  /** Replace the key with a new one (`doctor --rotate-key`): every report
   * signed before is stale from then on (its key id no longer matches). */
  readonly rotate?: boolean;
}): InstallationKey {
  if (options.home === undefined) {
    // Rotation is the operator's act: it re-trusts a configuration a session
    // was once granted (the operator has looked at it) — never one that is
    // writable by others or inside the workspace now.
    if (options.rotate) rmSync(join(defaultKeyDirectory(), CONFIG_EXPOSURE_MARKER), { force: true });
    const untrusted = configurationTrust(options.workspace !== undefined ? [options.workspace] : []);
    if (untrusted !== undefined) return ephemeral("config_untrusted", untrusted);
  }
  const configured = options.home !== undefined ? join(options.home, INSTALLATION_KEY_DIR) : doctorKeyDirectory();
  // The default directory is the host's own; any other must be adopted.
  const adopted = options.home !== undefined || canonicalPath(configured) === canonicalPath(defaultKeyDirectory());
  let homeRoot: ReturnType<typeof safeRoot>;
  try {
    homeRoot = safeRoot(dirname(configured), "doctor key parent", options.create ? { create: 0o700 } : {});
  } catch {
    return ephemeral("home_unusable");
  }
  const dirPath = join(homeRoot.text, basename(configured));
  try {
    if (options.workspace !== undefined) {
      const workspace = realpathSync(options.workspace);
      if (within(workspace, dirPath) || within(workspace, homeRoot.text)) return ephemeral("inside_workspace");
    }
  } catch {
    return ephemeral("home_unusable");
  }
  let dirRoot: ReturnType<typeof safeRoot>;
  try {
    if (options.create && !existsSync(dirPath)) mkdirSync(dirPath, { mode: 0o700 });
    dirRoot = safeRoot(dirPath, "doctor key directory");
    if (!privateTo(lstatSync(dirRoot.text))) return ephemeral("dir_not_private");
    // A fenced session was once granted a writable root containing this
    // directory (host-owned.ts): the key may have left, so it is never used.
    if (existsSync(join(dirRoot.text, KEY_EXPOSURE_MARKER))) return ephemeral("exposed_to_session");
  } catch {
    return ephemeral(options.create ? "create_failed" : "missing");
  }
  const rel = Buffer.from(INSTALLATION_KEY_FILE);
  const read = (): InstallationKey | undefined => {
    let opened: ReturnType<typeof openBeneath>;
    try {
      opened = openBeneath(dirRoot, rel, "read doctor key");
    } catch {
      return ephemeral("not_regular");
    }
    if (opened === undefined) return undefined;
    try {
      if ((opened.mode & 0o077) !== 0) return ephemeral("not_private");
      if (opened.size !== KEY_BYTES) return ephemeral("wrong_length");
      const bytes = readOpened(opened, KEY_BYTES + 1);
      opened.verify();
      if (bytes.length !== KEY_BYTES) return ephemeral("wrong_length");
      return { key: bytes, keyId: keyIdOf(bytes), persistent: true };
    } catch {
      return ephemeral("unreadable");
    } finally {
      opened.close();
    }
  };
  const canonicalDir = canonicalPath(dirRoot.text);
  const existing = options.rotate ? undefined : read();
  if (existing !== undefined) {
    if (!existing.persistent || adopted) return existing;
    const record = readAdoption();
    return record?.directory === canonicalDir && record.keyId === existing.keyId ? existing : ephemeral("not_adopted");
  }
  if (!options.create) return ephemeral("missing");
  const temp = Buffer.from(`${INSTALLATION_KEY_FILE}.${randomBytes(8).toString("hex")}.tmp`);
  let ours = false;
  try {
    const fd = createExclusiveBeneath(dirRoot, temp, 0o600, "create doctor key");
    try {
      if (writeSync(fd, randomBytes(KEY_BYTES)) !== KEY_BYTES) throw new Error("short write");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Atomic: a reader sees no key or a whole key, never a partial one; a
    // racing creator's key wins and ours is discarded. Rotation replaces the
    // one key in place (rename), so exactly one key exists at any time.
    try {
      if (options.rotate) renameSync(join(dirRoot.text, temp.toString()), join(dirRoot.text, INSTALLATION_KEY_FILE));
      else linkSync(join(dirRoot.text, temp.toString()), join(dirRoot.text, INSTALLATION_KEY_FILE));
      ours = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(join(dirRoot.text, temp.toString()), { force: true });
    }
  } catch {
    return ephemeral("create_failed");
  }
  const made = read() ?? ephemeral("create_failed");
  if (!made.persistent || adopted) return made;
  // A key this call made in a configured directory is adopted with it; a
  // racing key that won the link is someone else's and is not.
  if (!ours) {
    const record = readAdoption();
    return record?.directory === canonicalDir && record.keyId === made.keyId ? made : ephemeral("not_adopted");
  }
  try {
    writeAdoption(canonicalDir, made.keyId);
  } catch {
    return ephemeral("create_failed");
  }
  return made;
}

/** A report's authentication: an HMAC over its canonical form without this
 * field, under the installation key, and the key's id (D3'). */
export function authenticateReport<T extends object>(report: T, key: InstallationKey): T & { authentication: { keyId: string; mac: string } } {
  const { authentication: _drop, ...body } = report as T & { authentication?: unknown };
  const mac = createHmac("sha256", key.key).update("dokkabi doctor report\0").update(canonicalJson(body)).digest("hex");
  return { ...(body as T), authentication: { keyId: key.keyId, mac } };
}

/** Whether a report carries a valid HMAC under this key. Never throws. */
export function reportAuthentic(report: unknown, key: InstallationKey | undefined): boolean {
  if (key === undefined || report === null || typeof report !== "object") return false;
  const auth = (report as { authentication?: { keyId?: unknown; mac?: unknown } }).authentication;
  if (!auth || auth.keyId !== key.keyId || typeof auth.mac !== "string" || !/^[a-f0-9]{64}$/u.test(auth.mac)) return false;
  const expected = authenticateReport(report as object, key).authentication.mac;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(auth.mac, "hex"));
}

function keyed(key: Buffer, value: string): string {
  return `hmac:${createHmac("sha256", key).update(value).digest("hex")}`;
}

function structureOf(value: unknown, path: string, key: Buffer): unknown {
  if (typeof value === "string") {
    return ENUMERATED[path]?.includes(value) ? value : keyed(key, value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => structureOf(entry, `${path}[]`, key));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      const shown = STRUCTURAL_KEY.test(name) ? name : keyed(key, name);
      out[shown] = structureOf(entry, path === "" ? shown : `${path}.${shown}`, key);
    }
    return out;
  }
  return null;
}

/** The digest input: structure plus keyed values. Exported for tests. */
export function configIdentityInput(config: unknown, env: NodeJS.Dict<string>, key: Buffer): unknown {
  const switches: Record<string, unknown> = {};
  for (const name of DIAGNOSED_SWITCHES) {
    const value = env[name];
    if (value !== undefined) switches[name] = structureOf(value, `switch.${name}`, key);
  }
  return { config: structureOf(config ?? {}, "", key), switches };
}

/** The configuration identity of a report. Requires a key: without one there
 * is no digest, only refusal. */
export function configDigest(config: unknown, env: NodeJS.Dict<string>, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("configDigest requires this installation's key");
  return digestOf(canonicalJson(configIdentityInput(config, env, key)));
}

