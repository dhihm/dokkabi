import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { configPath, readConfig } from "./config.ts";
import { dokkabiHome } from "./paths.ts";

/**
 * Where the doctor's installation key lives, and how the host keeps it out of
 * every session-writable root (#230 round 4, K1 — W2 applied to the key).
 *
 * The key directory is `doctor.key_directory` in the operator's config when
 * set, else `<DOKKABI_HOME>/doctor` (doctorKeyDirectory). It must never lie in or under a root a
 * fenced session can write (its workspace, scratch, sandbox home, sandbox
 * temp). The fence is the one authority that grants those roots, so it is the
 * one that knows: whenever a policy grants a writable root that contains the
 * key directory, the host records that exposure in the directory itself
 * (`exposed`), and the key is unavailable from then on — the doctor falls back
 * to an ephemeral key, so no report can be signed "current" with a key a
 * session could have reached. As defence in depth the fence also denies the
 * key directory to that session and denies writes to every directory between
 * the writable root and it, so the directory cannot be renamed out from under
 * the deny (the round-3 rename bypass).
 *
 * Round 6 (K1''): the configuration that names the key directory, the
 * default key directory and the sessions area are host-owned as well — the
 * fence denies a session every write to them, and the doctor believes the
 * configuration about the key only when no session could have written it
 * (configurationTrust).
 */

export const KEY_EXPOSURE_MARKER = "exposed";
/** In the default key directory: a fenced session was granted a writable
 * root containing the configuration file (#230 round 6, K1''). */
export const CONFIG_EXPOSURE_MARKER = "config-exposed";
/** In the default key directory: the configured key directory the operator
 * adopted, and the id of the key it holds (`doctor --rotate-key`). */
export const ADOPTION_RECORD = "adopted-key";

/** `<DOKKABI_HOME>/doctor`: the key's default home, and where the host keeps
 * its own records about the key (exposure of the configuration, adoption). */
export function defaultKeyDirectory(): string {
  return join(dokkabiHome(), "doctor");
}

/** `doctor.key_directory` as the configuration file states it (absolute),
 * whether or not the file can be trusted. The fence denies it either way. */
export function configuredKeyDirectory(): string | undefined {
  let configured: unknown;
  try {
    configured = readConfig().doctor?.key_directory;
  } catch {
    configured = undefined;
  }
  return typeof configured === "string" && isAbsolute(configured.trim()) ? configured.trim() : undefined;
}

/**
 * The one installation-config resolution of the key directory (#230 round 5,
 * K1'): `doctor.key_directory` in the operator's config (absolute), else
 * `<DOKKABI_HOME>/doctor`. `dokkabi doctor`, `dokkabi work` and the fence all
 * call this, with the same config and the same default — there is no
 * per-process switch that could make one of them look elsewhere. Whether the
 * configuration may be believed is `configurationTrust`'s question (K1'').
 */
export function doctorKeyDirectory(): string {
  return configuredKeyDirectory() ?? defaultKeyDirectory();
}

/** Every directory a key could be read from: the default and the configured. */
function keyDirectories(): string[] {
  const configured = configuredKeyDirectory();
  return configured === undefined ? [defaultKeyDirectory()] : [defaultKeyDirectory(), configured];
}

/** The path with its existing ancestors resolved, the rest appended. */
export function canonicalPath(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.push(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      head = parent;
    }
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Why the configuration file cannot be believed about host-owned settings.
 * Closed vocabulary. */
export type ConfigurationProblem =
  | "config_link" | "config_not_regular" | "config_not_owned" | "config_writable_by_others"
  | "config_directory_writable_by_others" | "config_inside_workspace" | "config_exposed_to_session";

/**
 * Whether the configuration file may decide host-owned settings (the key
 * directory) — K1'': a file a session could have written is not the
 * operator's word. Refused when it is a link or not a regular file, not the
 * user's own, writable by the group or the world, in a directory the group or
 * the world can write, inside one of `writableRoots` (the diagnosing
 * workspace), or once granted to a fenced session (the exposure marker the
 * fence leaves in the default key directory, which the session cannot
 * remove). An absent file is trusted: it states nothing. Never throws.
 */
export function configurationTrust(writableRoots: readonly string[] = []): ConfigurationProblem | undefined {
  const path = configPath();
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (stat.isSymbolicLink()) return "config_link";
  if (!stat.isFile()) return "config_not_regular";
  if (uid !== undefined && stat.uid !== uid) return "config_not_owned";
  if ((stat.mode & 0o022) !== 0) return "config_writable_by_others";
  try {
    const parent = statSync(dirname(path));
    if ((uid !== undefined && parent.uid !== uid) || (parent.mode & 0o022) !== 0) return "config_directory_writable_by_others";
  } catch {
    return "config_directory_writable_by_others";
  }
  const canonical = canonicalPath(path);
  for (const root of writableRoots) {
    if (within(canonicalPath(root), canonical)) return "config_inside_workspace";
  }
  if (existsSync(join(defaultKeyDirectory(), CONFIG_EXPOSURE_MARKER))) return "config_exposed_to_session";
  return undefined;
}

export interface HostOwnedDenials {
  /** Directories the session may neither read nor write, whole (key directories). */
  readonly subpaths: readonly string[];
  /** Directories the session may read but not write (the sessions area). */
  readonly writeSubpaths: readonly string[];
  /** Paths the session may not write: the configuration file, and every
   * directory between a writable root and a protected path (no rename, no
   * replacement). */
  readonly literals: readonly string[];
  /** Writable roots that lie inside a write-denied area (a ledger session's
   * scratch under sessions/): granted again after the denials. */
  readonly regrants: readonly string[];
}

/**
 * What the fence must deny a session whose writable roots are these (K1''):
 * host-owned state is host-owned — the configuration file, the default and
 * the configured key directory, and the sessions area — whenever a writable
 * root contains it, with every directory between the root and it unwritable.
 */
export function hostOwnedDenials(writableRoots: readonly string[]): HostOwnedDenials {
  const hidden = keyDirectories().map(canonicalPath);
  const readOnly = [canonicalPath(join(dokkabiHome(), "sessions"))];
  const files = [canonicalPath(configPath())];
  const roots = writableRoots.map(canonicalPath);
  const subpaths = new Set<string>();
  const writeSubpaths = new Set<string>();
  const literals = new Set<string>();
  const protect = (root: string, path: string, into: Set<string>) => {
    if (!within(root, path)) return;
    into.add(path);
    for (let current = dirname(path); current !== root && within(root, current); current = dirname(current)) literals.add(current);
  };
  for (const root of roots) {
    for (const path of hidden) protect(root, path, subpaths);
    for (const path of readOnly) protect(root, path, writeSubpaths);
    for (const path of files) protect(root, path, literals);
  }
  const regrants = roots.filter((root) => [...writeSubpaths].some((area) => root !== area && within(area, root)));
  return { subpaths: [...subpaths], writeSubpaths: [...writeSubpaths], literals: [...literals], regrants };
}

/** Kept for callers that only need the directories to hide. */
export function hostOwnedInsideWorkspace(workspaceRoot: string): string[] {
  return [...hostOwnedDenials([workspaceRoot]).subpaths];
}

function writeMarker(directory: string, name: string, text: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text, 0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Record that a session was granted a writable root containing host-owned
 * state: `exposed` in every key directory it contains (the key is never used
 * again), and `config-exposed` in the default key directory when it contains
 * the configuration file (the file is never believed about host-owned
 * settings until the operator rotates the key). Best effort and idempotent;
 * never throws — a fence that could not record still denies.
 */
export function recordHostOwnedExposure(writableRoots: readonly string[]): void {
  const denials = hostOwnedDenials(writableRoots);
  for (const directory of keyDirectories()) {
    if (!denials.subpaths.includes(canonicalPath(directory))) continue;
    try {
      writeMarker(directory, KEY_EXPOSURE_MARKER, "a fenced session was granted a writable root containing this directory\n");
    } catch {
      // The deny rules still hold.
    }
  }
  if (denials.literals.includes(canonicalPath(configPath()))) {
    try {
      writeMarker(defaultKeyDirectory(), CONFIG_EXPOSURE_MARKER, "a fenced session was granted a writable root containing the configuration file\n");
    } catch {
      // The deny rules still hold.
    }
  }
}
