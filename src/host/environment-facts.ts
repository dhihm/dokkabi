import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The execution-environment facts a session publishes to the model.
 *
 * A session starts with a curated sandbox PATH (host/sandbox-env.ts) and no
 * surface that says which commands resolve, where the workspace's own project
 * environments live, or even what the working directory is, so the model used
 * to spend its first turns discovering interpreters. This module probes those
 * facts once, at boot, and renders them as one fixed "## Environment" section
 * of the sealed system prompt (boot.ts).
 *
 * The probe READS THE FILESYSTEM ONLY. It never spawns or executes anything:
 * workspace binaries are untrusted, and running one outside the sandbox would
 * be an escape. There is no branching on language, repository, or task — one
 * fixed command list, one declarative marker table, one fixed manifest list —
 * and the rendered text states facts with no advice. No clock, pid, or rev
 * ever enters the data, so prefix.ts assertNoRuntimeMarkers passes and the
 * same filesystem yields byte-identical facts.
 */

/** The observe row carrying one session's facts (docs/event-log.md). */
export const HOST_ENVIRONMENT_EVENT = "host/environment";
/** Prompt contribution identity and fixed projection order: the host's facts
 * land ahead of every plugin and pack contribution, right after the base
 * prompt, at the same place on every boot. */
export const HOST_ENVIRONMENT_PROMPT_OWNER = "host:environment";
export const HOST_ENVIRONMENT_PROMPT_ORDER = -1000;

/** At most this many entries per list, so a hostile or enormous tree cannot
 * grow the sealed prefix without bound. */
export const MAX_ENVIRONMENT_FACT_ENTRIES = 64;
/** Every string in the facts is capped, so no path or version can smuggle an
 * unbounded payload into the prefix or the event log. */
export const MAX_ENVIRONMENT_FACT_STRING = 256;

/** One fixed, language-neutral set of common command names: interpreters,
 * package managers, build tools, and git. */
export const ENVIRONMENT_COMMAND_NAMES: readonly string[] = Object.freeze([
  "python3", "python", "pip", "pip3", "uv", "poetry", "pytest", "tox",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "go", "cargo", "rustc",
  "java", "javac", "mvn", "gradle",
  "ruby", "gem", "bundle",
  "php", "composer", "dotnet",
  "gcc", "cc", "clang", "make", "cmake", "git",
]);

/** One declarative row per workspace-local environment convention. Adding a
 * convention is adding a row: `marker` is the directory-relative path whose
 * existence marks the environment, `bin` the directory-relative bin dir the
 * model would call into, and `version` names the marker file that carries a
 * version line when the convention has one. */
export interface ProjectEnvironmentMarker {
  readonly kind: string;
  readonly marker: string;
  readonly bin: string;
  readonly version?: "pyvenv.cfg";
}

export const PROJECT_ENVIRONMENT_MARKERS: readonly ProjectEnvironmentMarker[] = Object.freeze([
  { kind: "python-venv", marker: "pyvenv.cfg", bin: "bin", version: "pyvenv.cfg" },
  { kind: "node-modules", marker: "node_modules/.bin", bin: "node_modules/.bin" },
  { kind: "vendor-bin", marker: "vendor/bin", bin: "vendor/bin" },
]);

/** Top-level project files whose presence is reported, names only. */
export const PROJECT_MANIFEST_NAMES: readonly string[] = Object.freeze([
  "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "requirements.txt",
  "package.json", "go.mod", "Cargo.toml", "pom.xml", "build.gradle",
  "Gemfile", "composer.json", "Makefile", "CMakeLists.txt",
]);

/** The Playwright browser cache directory, relative to an exposed toolchain
 * root, and the browser directories inside it (D38). Detection is the LAYOUT
 * and nothing else: a directory named like a Playwright browser download,
 * holding the executable at the place that layout puts it. */
const PLAYWRIGHT_CACHE_DIR = "ms-playwright";
const PLAYWRIGHT_BROWSER_DIR_PREFIXES: readonly string[] = Object.freeze([
  "chromium-", "chromium_headless_shell-",
]);
/** Root-relative binaries inside one Playwright browser directory, in the
 * order the facts report them: the headless shell first, the full browser
 * after it. */
const PLAYWRIGHT_BROWSER_BINARIES: readonly string[] = Object.freeze([
  "chrome-linux/headless_shell", "chrome-linux/chrome",
]);
/** The command names a system-installed Chromium answers to; looked up on the
 * sandbox PATH exactly as the command set above is. */
const SYSTEM_BROWSER_NAMES: readonly string[] = Object.freeze([
  "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
]);

/** Workspace-root scripts that mark a repository's own test runner, names
 * only (CASE-ERGONOMICS item 1d): the model-facing data the plan tool's
 * runner_script finding is derived from. A Makefile counts only when it
 * declares a test target. */
export const TEST_RUNNER_MARKER_PATHS: readonly string[] = Object.freeze([
  "tests/runtests.py", "bin/test", "manage.py", "tox.ini", "noxfile.py",
]);

/** Directories the workspace scan never descends into: VCS metadata is not a
 * project environment, and everything inside node_modules is dependency
 * internals (a package's own node_modules/.bin is still found as a marker of
 * its parent directory, without descending). */
const SCAN_SKIP_DIRS: readonly string[] = [".git", "node_modules"];
const MAX_SCAN_DEPTH = 2;
const PYVENV_VERSION_READ_BYTES = 4096;

export interface EnvironmentCommandFact {
  readonly name: string;
  readonly path: string;
}

/** One headless browser executable the session's world already carries (D38):
 * the name it is called by and the absolute path it lives at. */
export interface EnvironmentBrowserFact {
  readonly name: string;
  readonly path: string;
}

export interface ProjectEnvironmentFact {
  readonly kind: string;
  /** Workspace-relative environment root ("." for the workspace root itself). */
  readonly root: string;
  /** Workspace-relative bin directory. */
  readonly bin: string;
  readonly version?: string;
  /** True when the bin dir's absolute path is on the sandbox PATH — which,
   * for an environment under the execution root, the composition below makes
   * true for every shell the host runs there (projectEnvironmentBinDirs). */
  readonly on_path: boolean;
}

export interface EnvironmentFacts {
  readonly workspace_root: string;
  readonly platform: string;
  readonly arch: string;
  readonly shell: string;
  readonly commands: readonly EnvironmentCommandFact[];
  readonly missing: readonly string[];
  readonly project_environments: readonly ProjectEnvironmentFact[];
  readonly manifests: readonly string[];
  /** Workspace-root test-runner scripts present, names only. Optional so a
   * recorded row from before the field existed parses and re-renders exactly
   * as it was recorded (replay equality). */
  readonly test_runners?: readonly string[];
  /** Headless browser executables found in the session's world (D38). Absent
   * when none was found — which is also what a recorded row from before the
   * field existed carries, so such a row re-renders byte-identically. */
  readonly browsers?: readonly EnvironmentBrowserFact[];
}

/**
 * Probe the execution-environment facts of one workspace. `sandboxPath` is
 * the PATH string the model's shell will actually see (boot.ts computes it
 * through the same construction as the session's sandbox policy). Pure
 * filesystem reads; deterministic for a given filesystem; frozen and
 * JSON-safe. Throws when the workspace root itself cannot be enumerated —
 * the boot wiring records that as an error row and moves on.
 */
export function probeEnvironmentFacts(input: {
  readonly workspaceRoot: string;
  readonly sandboxPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly shell: string;
  /** The read-only toolchain roots the session's sandbox exposes
   * (host/sandbox-toolchain.ts). Passed in rather than imported: this module's
   * dependencies are pinned to node:fs and node:path so the probe can never
   * gain an execution surface. Absent means none are exposed. */
  readonly toolchainRoots?: readonly string[];
}): EnvironmentFacts {
  const workspaceRoot = resolve(input.workspaceRoot);
  const pathDirs = input.sandboxPath.split(":").filter((entry) => entry.length > 0);

  const commands: EnvironmentCommandFact[] = [];
  const missing: string[] = [];
  for (const name of ENVIRONMENT_COMMAND_NAMES) {
    const found = firstExecutableOnPath(pathDirs, name);
    if (found !== undefined) {
      commands.push({ name: boundString(name), path: boundString(found) });
    } else {
      missing.push(boundString(name));
    }
  }
  commands.sort((left, right) => byString(left.name, right.name));
  missing.sort(byString);

  const projectEnvironments = scanProjectEnvironments(workspaceRoot, pathDirs);
  const manifests = PROJECT_MANIFEST_NAMES
    .filter((name) => existsSync(join(workspaceRoot, name)))
    .sort(byString)
    .slice(0, MAX_ENVIRONMENT_FACT_ENTRIES)
    .map(boundString);
  const testRunners = probeTestRunners(workspaceRoot);
  const browsers = scanHeadlessBrowsers(input.toolchainRoots ?? [], pathDirs);

  return freezeFacts({
    workspace_root: boundString(workspaceRoot),
    platform: boundString(input.platform),
    arch: boundString(input.arch),
    shell: boundString(input.shell),
    commands: commands.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES),
    missing: missing.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES),
    project_environments: projectEnvironments,
    manifests,
    test_runners: testRunners,
    // Absent when nothing was found, so a world without a browser records and
    // renders exactly what it did before this field existed.
    ...(browsers.length > 0 ? { browsers } : {}),
  });
}

/** The two filesystem questions the browser scan asks, injectable so the scan
 * is a pure function of its answers. */
export interface BrowserScanFilesystem {
  /** Child directory names of a directory; empty when it cannot be read. */
  readonly listDirs: (dir: string) => readonly string[];
  /** True for an existing regular file that carries an executable bit. */
  readonly isExecutable: (path: string) => boolean;
}

const defaultBrowserScanFilesystem: BrowserScanFilesystem = Object.freeze({
  listDirs: (dir: string): readonly string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  isExecutable: (path: string): boolean => {
    try {
      const stat = statSync(path);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  },
});

/**
 * The headless browser executables a session can already run (D38): the ones
 * under the exposed toolchain roots in the Playwright cache layout, then the
 * ones answering a Chromium command name on the sandbox PATH.
 *
 * Detection is the directory layout and the command names alone — no product
 * is looked up by version, and no marker table for environments is involved.
 * The executable bit is required, the list is bounded like every other fact
 * list, and the order is fixed (roots in the order given, browser directories
 * sorted, the headless shell before the full browser, then the PATH dirs in
 * PATH order), so the same filesystem yields the same list.
 */
export function scanHeadlessBrowsers(
  toolchainRoots: readonly string[],
  pathDirs: readonly string[],
  filesystem: BrowserScanFilesystem = defaultBrowserScanFilesystem,
): EnvironmentBrowserFact[] {
  const found: EnvironmentBrowserFact[] = [];
  const seen = new Set<string>();
  const record = (path: string): void => {
    if (seen.has(path) || found.length >= MAX_ENVIRONMENT_FACT_ENTRIES) return;
    if (!filesystem.isExecutable(path)) return;
    seen.add(path);
    found.push({ name: boundString(path.split("/").at(-1) ?? ""), path: boundString(path) });
  };
  for (const root of toolchainRoots) {
    // The cache is reached as <root>/ms-playwright; a root that IS the cache
    // directory (the toolchain list exposes ~/.cache/ms-playwright itself) is
    // read in place, so the same layout is found either way.
    const caches = root.split("/").at(-1) === PLAYWRIGHT_CACHE_DIR
      ? [root, join(root, PLAYWRIGHT_CACHE_DIR)]
      : [join(root, PLAYWRIGHT_CACHE_DIR)];
    for (const cache of caches) {
      const dirs = [...filesystem.listDirs(cache)]
        .filter((name) => PLAYWRIGHT_BROWSER_DIR_PREFIXES.some((prefix) => name.startsWith(prefix)))
        .sort(byString);
      for (const dir of dirs) {
        for (const binary of PLAYWRIGHT_BROWSER_BINARIES) record(join(cache, dir, binary));
      }
    }
  }
  for (const dir of pathDirs) {
    for (const name of SYSTEM_BROWSER_NAMES) record(join(dir, name));
  }
  return found;
}

/**
 * The absolute bin directories of every project environment detected under
 * one EXECUTION root, in the probe's own order. The single sandbox PATH
 * composition (host/sandbox-env.ts) prepends exactly these, so a workspace's
 * own environment is on PATH for every shell the host runs there — the
 * model's tools, the final case pass on the live root, and the base pass
 * inside its copy, which carries its own. No activation script is sourced:
 * a relocatable environment works by PATH alone.
 *
 * Detection is the marker table above and nothing else — no repository, task
 * or tool name enters here. Only a bin directory that RESOLVES INSIDE the
 * execution root counts: an environment reached through a link out of the
 * tree is not this root's to publish. Pure filesystem reads, deterministic
 * for a given filesystem, and never throws — a root that cannot be
 * enumerated simply carries no environments, which leaves PATH as it was.
 */
export function projectEnvironmentBinDirs(executionRoot: string): readonly string[] {
  const root = resolve(executionRoot);
  const canonicalRoot = canonicalDirectory(root);
  if (canonicalRoot === undefined) return Object.freeze([]);
  let detected: readonly ProjectEnvironmentFact[];
  try {
    detected = scanProjectEnvironments(root, []);
  } catch {
    return Object.freeze([]);
  }
  const dirs: string[] = [];
  for (const environment of detected) {
    const canonical = canonicalDirectory(join(root, environment.bin));
    if (canonical === undefined) continue;
    if (!pathInside(canonicalRoot, canonical)) continue;
    if (!dirs.includes(canonical)) dirs.push(canonical);
  }
  return Object.freeze(dirs);
}

/** The canonical path of an existing directory; undefined for anything else
 * (missing, a file, a dangling link, unreadable). */
function canonicalDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Render the one fixed "## Environment" section. Plain facts in a fixed
 * order: no advice, no clock, no rev — the text is a pure function of the
 * facts, so a recorded row replays byte-identically. Absolute paths render
 * account-normalized (`/home/<user>/…` and `/Users/<user>/…` become `~/…`):
 * the account name is the only sensitive part, the model works from the
 * `~/` spelling the rest of the toolchain already accepts, and the recorded
 * row keeps the absolute values so the probe record stays exact. */
export function renderEnvironmentFacts(facts: EnvironmentFacts): string {
  const workspaceRoot = normalizeRenderedPath(facts.workspace_root);
  const lines: string[] = [
    "## Environment",
    "",
    `Commands run in ${workspaceRoot} on ${facts.platform}/${facts.arch} with ${facts.shell}.`,
    "",
  ];
  if (facts.commands.length > 0) {
    lines.push("Commands on PATH:");
    for (const command of facts.commands) {
      lines.push(`- ${command.name} -> ${normalizeRenderedPath(command.path)}`);
    }
  } else {
    lines.push("Commands on PATH: none of the common command set resolved.");
  }
  lines.push("");
  lines.push(facts.missing.length > 0
    ? `Commands not on PATH: ${facts.missing.join(", ")}.`
    : "Commands not on PATH: none.");
  lines.push("");
  if (facts.project_environments.length > 0) {
    lines.push("Project environments:");
    for (const environment of facts.project_environments) {
      const version = environment.version === undefined ? "" : `, version ${environment.version}`;
      // The fact the model needs is not "a directory is listed somewhere":
      // it is whether the command it is about to record resolves the same way
      // when the host re-runs it. The composition puts every environment of
      // the execution root on that PATH, so the section states it plainly.
      const location = environment.on_path
        ? "on PATH for every command the host runs in this workspace: yes"
        : `not on PATH, absolute bin ${normalizeRenderedPath(`${facts.workspace_root}/${environment.bin}`)}`;
      lines.push(`- ${environment.kind} at ${environment.root}: bin ${environment.bin}${version}, ${location}.`);
    }
  } else {
    lines.push("Project environments: none found within two levels of the workspace root.");
  }
  lines.push("");
  lines.push(facts.manifests.length > 0
    ? `Project manifests: ${facts.manifests.join(", ")}.`
    : "Project manifests: none of the common set are present.");
  // Rendered only when the facts carry the field, so a recorded row from
  // before it existed re-renders byte-identically on replay.
  if (facts.test_runners !== undefined) {
    lines.push("");
    lines.push(facts.test_runners.length > 0
      ? `Repository test runners: ${facts.test_runners.join(", ")}.`
      : "Repository test runners: none of the common set are present.");
  }
  // Rendered only when one was found: a world with no browser says nothing,
  // exactly as it did before the field existed. The first entry carries the
  // line; any further ones are named after it rather than repeating it.
  if (facts.browsers !== undefined && facts.browsers.length > 0) {
    lines.push("");
    lines.push(`Headless browser: ${normalizeRenderedPath(facts.browsers[0]!.path)} (Chromium; run it with`
      + " --headless=new --remote-debugging-port=<port> and speak CDP over Node's built-in WebSocket;"
      + " no package install needed).");
    if (facts.browsers.length > 1) {
      lines.push(`Other headless browsers: ${facts.browsers.slice(1)
        .map((browser) => normalizeRenderedPath(browser.path)).join(", ")}.`);
    }
  }
  return lines.join("\n");
}

/** The workspace-root test-runner scripts that exist, names only, sorted. A
 * Makefile is read byte-capped and counts only with a test target — the
 * read is still a pure filesystem fact, deterministic for a given tree. */
function probeTestRunners(workspaceRoot: string): string[] {
  const found: string[] = [];
  for (const path of TEST_RUNNER_MARKER_PATHS) {
    if (existsSync(join(workspaceRoot, path))) found.push(path);
  }
  const makefile = join(workspaceRoot, "Makefile");
  if (existsSync(makefile) && makefileHasTestTarget(makefile)) found.push("Makefile");
  return found.sort(byString).slice(0, MAX_ENVIRONMENT_FACT_ENTRIES).map(boundString);
}

const MAKEFILE_READ_BYTES = 16_384;

/** True when the Makefile declares a `test` target at line start. */
function makefileHasTestTarget(path: string): boolean {
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAKEFILE_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, MAKEFILE_READ_BYTES, 0);
    text = buffer.toString("utf8", 0, bytesRead);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return /^(?:[^\t#][ \t]*)?test[ \t]*:/mu.test(text);
}

/** The same account-name stripping as normalizeHomePaths (host/redact.ts),
 * duplicated deliberately: this module's import list is pinned to node:fs
 * and node:path (tests/environment-facts.test.ts), so the probe can never
 * gain an execution surface by growing a dependency. */
function normalizeRenderedPath(text: string): string {
  return text.replaceAll(/\/(?:home|Users)\/[A-Za-z0-9._-]+(\/|$)/g, "~$1");
}

/**
 * Read a recorded host/environment payload back into facts. Returns undefined
 * for an error row and for anything this build cannot read — both register no
 * prompt contribution, which reproduces the original boot's prefix exactly.
 */
export function environmentFactsFromPayload(payload: Record<string, unknown>): EnvironmentFacts | undefined {
  if (typeof payload.error === "string") return undefined;
  const { workspace_root, platform, arch, shell, commands, missing, project_environments, manifests } = payload;
  if (typeof workspace_root !== "string" || typeof platform !== "string"
    || typeof arch !== "string" || typeof shell !== "string") return undefined;
  if (!Array.isArray(commands) || !Array.isArray(missing)
    || !Array.isArray(project_environments) || !Array.isArray(manifests)) return undefined;
  const parsedCommands: EnvironmentCommandFact[] = [];
  for (const command of commands) {
    if (!isRecord(command) || typeof command.name !== "string" || typeof command.path !== "string") {
      return undefined;
    }
    parsedCommands.push({ name: boundString(command.name), path: boundString(command.path) });
  }
  const parsedEnvironments: ProjectEnvironmentFact[] = [];
  for (const environment of project_environments) {
    if (!isRecord(environment) || typeof environment.kind !== "string"
      || typeof environment.root !== "string" || typeof environment.bin !== "string"
      || typeof environment.on_path !== "boolean"
      || (environment.version !== undefined && typeof environment.version !== "string")) {
      return undefined;
    }
    parsedEnvironments.push({
      kind: boundString(environment.kind),
      root: boundString(environment.root),
      bin: boundString(environment.bin),
      ...(environment.version === undefined ? {} : { version: boundString(environment.version) }),
      on_path: environment.on_path,
    });
  }
  if (!missing.every((name) => typeof name === "string")) return undefined;
  if (!manifests.every((name) => typeof name === "string")) return undefined;
  if (payload.test_runners !== undefined
    && (!Array.isArray(payload.test_runners) || !payload.test_runners.every((name) => typeof name === "string"))) {
    return undefined;
  }
  // A payload with no `browsers` field is a recording from before it existed
  // (or a world with no browser): it stays valid and carries no field.
  let parsedBrowsers: EnvironmentBrowserFact[] | undefined;
  if (payload.browsers !== undefined) {
    if (!Array.isArray(payload.browsers)) return undefined;
    parsedBrowsers = [];
    for (const browser of payload.browsers) {
      if (!isRecord(browser) || typeof browser.name !== "string" || typeof browser.path !== "string") {
        return undefined;
      }
      parsedBrowsers.push({ name: boundString(browser.name), path: boundString(browser.path) });
    }
  }
  return freezeFacts({
    workspace_root: boundString(workspace_root),
    platform: boundString(platform),
    arch: boundString(arch),
    shell: boundString(shell),
    commands: parsedCommands.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES),
    missing: missing.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES).map(boundString),
    project_environments: parsedEnvironments.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES),
    manifests: manifests.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES).map(boundString),
    ...(payload.test_runners === undefined
      ? {}
      : { test_runners: (payload.test_runners as string[]).slice(0, MAX_ENVIRONMENT_FACT_ENTRIES).map(boundString) }),
    ...(parsedBrowsers === undefined ? {} : { browsers: parsedBrowsers.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES) }),
  });
}

/** The bounded error class an error row carries: a coarse, secret-free label
 * (never the message, which could carry paths), fit for the event log. */
export function environmentProbeErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "error";
  const normalized = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 64) || "error";
}

/** The first executable regular file named `name` along the PATH dirs, as
 * found — a symlink is reported by its own path, never resolved. */
function firstExecutableOnPath(pathDirs: readonly string[], name: string): string | undefined {
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Missing, dangling, or unreadable entries simply do not resolve.
    }
  }
  return undefined;
}

/** One detected environment: the fact the probe publishes, and the
 * workspace-relative directory the environment OCCUPIES — the directory the
 * marker path itself names (`<venv>` for `pyvenv.cfg`, `<dir>/node_modules`
 * for `node_modules/.bin`, `<dir>/vendor` for `vendor/bin`), so the marker
 * table stays the one place a convention is declared. */
interface ScannedEnvironment {
  readonly fact: ProjectEnvironmentFact;
  readonly dir: string;
}

function scanProjectEnvironments(
  workspaceRoot: string,
  pathDirs: readonly string[],
): ProjectEnvironmentFact[] {
  return scanProjectEnvironmentEntries(workspaceRoot, pathDirs).map((entry) => entry.fact);
}

function scanProjectEnvironmentEntries(
  workspaceRoot: string,
  pathDirs: readonly string[],
): ScannedEnvironment[] {
  const found: ScannedEnvironment[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const marker of PROJECT_ENVIRONMENT_MARKERS) {
      if (!existsSync(join(dir, marker.marker))) continue;
      const rootRelative = relativePosix(workspaceRoot, dir);
      const binRelative = rootRelative === "." ? marker.bin : `${rootRelative}/${marker.bin}`;
      const version = marker.version === undefined
        ? undefined
        : pyvenvVersion(join(dir, marker.version));
      const markerDir = [
        ...(rootRelative === "." ? [] : rootRelative.split("/")),
        ...marker.marker.split("/").slice(0, -1),
      ].join("/");
      found.push({
        fact: {
          kind: boundString(marker.kind),
          root: boundString(rootRelative),
          bin: boundString(binRelative),
          ...(version === undefined ? {} : { version: boundString(version) }),
          on_path: binOnPath(join(workspaceRoot, binRelative), pathDirs),
        },
        dir: markerDir === "" ? "." : markerDir,
      });
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    for (const name of listChildDirs(dir)) {
      // Nested trees that cannot be read contribute nothing; only the root's
      // own enumeration failure is fatal (it propagates out of visit below).
      try {
        visit(join(dir, name), depth + 1);
      } catch {
        continue;
      }
    }
  };
  visit(workspaceRoot, 0);
  found.sort((left, right) => byString(left.fact.bin, right.fact.bin) || byString(left.fact.kind, right.fact.kind));
  return found.slice(0, MAX_ENVIRONMENT_FACT_ENTRIES);
}

/**
 * The workspace-relative directories the detected project environments
 * occupy, in the probe's own order — the marker table above and nothing else,
 * so a convention is still added by adding a row. The workspace ROOT itself
 * never appears: a root that carries a marker is the project, not an
 * environment inside it.
 *
 * The base-tree observation (work/ledger-base.ts) asks this before it removes
 * the untracked files a session authored: an environment is what a recorded
 * case needs in order to run at all, so it stays. Pure filesystem reads,
 * deterministic for a given filesystem, and never throws — a root that
 * cannot be enumerated simply carries no environments.
 */
export function projectEnvironmentDirs(executionRoot: string): readonly string[] {
  let entries: readonly ScannedEnvironment[];
  try {
    entries = scanProjectEnvironmentEntries(resolve(executionRoot), []);
  } catch {
    return Object.freeze([]);
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.dir === "." || dirs.includes(entry.dir)) continue;
    dirs.push(entry.dir);
  }
  return Object.freeze(dirs);
}

/** Child directory names of `dir`, sorted, with .git and node_modules left
 * out. Symlinked children are not followed: the scan stays on the real tree,
 * which keeps it finite and deterministic. */
function listChildDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SCAN_SKIP_DIRS.includes(entry.name))
    .map((entry) => entry.name)
    .sort(byString);
}

/** True when the bin dir's absolute path appears on the sandbox PATH. A
 * symlinked bin dir also matches its canonical form, because workspace PATH
 * entries are canonicalized when the sandbox environment is built. */
function binOnPath(binAbsolute: string, pathDirs: readonly string[]): boolean {
  if (pathDirs.includes(binAbsolute)) return true;
  try {
    const canonical = realpathSync(binAbsolute);
    return canonical !== binAbsolute && pathDirs.includes(canonical);
  } catch {
    return false;
  }
}

/** The version of a Python virtual environment: version_info when present,
 * else the plain version line. The read is byte-capped — the file belongs to
 * the workspace, so its size is not trusted. */
function pyvenvVersion(path: string): string | undefined {
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(PYVENV_VERSION_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, PYVENV_VERSION_READ_BYTES, 0);
    text = buffer.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return /^version_info\s*=\s*(\S+)\s*$/mu.exec(text)?.[1]
    ?? /^version\s*=\s*(\S+)\s*$/mu.exec(text)?.[1];
}

function relativePosix(root: string, dir: string): string {
  if (dir === root) return ".";
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return dir.startsWith(prefix) ? dir.slice(prefix.length).split(sep).join("/") : dir;
}

function boundString(value: string): string {
  return value.length <= MAX_ENVIRONMENT_FACT_STRING ? value : value.slice(0, MAX_ENVIRONMENT_FACT_STRING);
}

function byString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeFacts(facts: EnvironmentFacts): EnvironmentFacts {
  for (const command of facts.commands) Object.freeze(command);
  for (const environment of facts.project_environments) Object.freeze(environment);
  Object.freeze(facts.commands);
  Object.freeze(facts.missing);
  Object.freeze(facts.project_environments);
  Object.freeze(facts.manifests);
  if (facts.test_runners !== undefined) Object.freeze(facts.test_runners);
  if (facts.browsers !== undefined) {
    for (const browser of facts.browsers) Object.freeze(browser);
    Object.freeze(facts.browsers);
  }
  return Object.freeze(facts);
}
