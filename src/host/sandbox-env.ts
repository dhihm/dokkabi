import { createHash } from "node:crypto";
import { acceleratorToolPaths } from "./sandbox-accelerator.ts";
import { projectEnvironmentBinDirs } from "./environment-facts.ts";
import { proxyEnvironment } from "./sandbox-proxy.ts";
import { toolchainBinDirs } from "./sandbox-toolchain.ts";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const SANDBOX_DOKKABI_HOME = "/tmp/dokkabi-home";
export const SANDBOX_BUN_BIN = "/dokkabi-runtime/bin";

const SYSTEM_PATH: readonly string[] = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

const SAFE_HOST_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TZ", "NO_COLOR", "FORCE_COLOR"] as const;

/**
 * Build the complete environment visible to a model-controlled command.
 * Provider credentials, auth sockets, proxy credentials, and operator HOME
 * are deliberately not inherited. The returned object is snapshotted into
 * the host-sealed sandbox policy so later ambient changes cannot alter it.
 */
export function createSandboxEnvironment(input: {
  readonly workspaceRoot: string;
  readonly mode: string;
  readonly backend: string;
  readonly runtimeExecutable?: string;
  /** Accelerator device nodes bound into this world; their tool directories
   * join PATH only when a device was actually bound. */
  readonly devicePaths?: readonly string[];
  readonly dockerPython?: string;
  /** Host-private roots provisioned for one Seatbelt policy. */
  readonly sandboxHome?: string;
  readonly sandboxTemp?: string;
  readonly hostEnv?: NodeJS.Dict<string>;
  /** Toolchain roots the world exposes; their bin directories join PATH
   * ahead of the system directories, the way the operator's own shell has
   * them (sandbox-toolchain.ts). */
  readonly toolchainRoots?: readonly string[];
  /** The session's tool-cache directory (tool-cache.ts), when this world
   * is the session's own tree; absent, caches stay in the policy's own home. */
  readonly toolCacheDir?: string;
  /** Whose cache `toolCacheDir` is (G3', D57h): the session's (shared,
   * Python bytecode written and read there — the default) or a judged run's
   * own (fresh per execution; Python bytecode neither written nor read). */
  readonly toolCacheRole?: "session" | "judged";
}): Readonly<Record<string, string>> {
  const hostEnv = input.hostEnv ?? process.env;
  // A bound accelerator whose tools are off the default PATH is an accelerator
  // the run cannot see: WSL keeps nvidia-smi in /usr/lib/wsl/lib, so the binary
  // is present, readable, and "command not found" (sandbox-accelerator.ts).
  //
  // The execution root's own project environments lead the whole list. A
  // workspace carries a relocatable environment the host itself built, and it
  // was on no PATH the host composed: the model activated it by hand in its
  // shell, recorded the case without the activation, and the re-run resolved
  // the bare word to the system interpreter or to nothing (CASE-PARITY-A).
  // The environments are DETECTED by the probe's marker table — never a
  // listed repository, task or tool name — and each root gets its own: the
  // live workspace for the model's tools and the final case pass, the copy
  // for the base pass, which carries its own environment. A root with no
  // environment leaves the list exactly as it was.
  const path: string[] = [
    ...projectEnvironmentBinDirs(input.workspaceRoot),
    ...toolchainBinDirs(input.toolchainRoots ?? []),
    ...SYSTEM_PATH,
    ...acceleratorToolPaths(input.devicePaths ?? []),
  ];
  const canonicalWorkspace = canonicalPath(input.workspaceRoot);
  for (const entry of (hostEnv.PATH ?? "").split(":")) {
    if (!entry || !isAbsolute(entry)) continue;
    const canonicalEntry = canonicalPath(entry);
    if (canonicalWorkspace && canonicalEntry && pathInside(canonicalWorkspace, canonicalEntry)) {
      path.unshift(canonicalEntry);
    }
  }
  if (
    (input.backend === "bwrap" || input.backend === "seatbelt")
    && input.runtimeExecutable
    && isAbsolute(input.runtimeExecutable)
  ) {
    const runtimeDir = dirname(input.runtimeExecutable);
    if (!runtimeDir.startsWith("/usr/") && runtimeDir !== "/usr" && !path.includes(runtimeDir)) {
      path.unshift(runtimeDir);
    }
  }
  if (input.backend === "docker" && input.dockerPython && isAbsolute(input.dockerPython)) {
    path.unshift(dirname(input.dockerPython), "/opt/miniconda3/bin");
  }
  if (input.backend === "bwrap" && input.runtimeExecutable && isAbsolute(input.runtimeExecutable)) {
    // The installed Bun binary may be named bun.exe. Its namespace command
    // is bound by the host, independent of installation symlinks and PATH.
    path.unshift(SANDBOX_BUN_BIN);
  }

  const sandboxHome = input.sandboxHome ?? SANDBOX_DOKKABI_HOME;
  const sandboxTemp = input.sandboxTemp ?? "/tmp";
  if (!isAbsolute(sandboxHome) || !isAbsolute(sandboxTemp)) {
    throw new Error("sandbox home and temporary roots must be absolute");
  }

  const sessionPython = input.toolCacheDir !== undefined && input.toolCacheRole !== "judged";
  const env: Record<string, string> = {
    HOME: sandboxHome,
    DOKKABI_HOME: sandboxHome,
    DOKKABI_SANDBOX_WORKSPACE: input.workspaceRoot,
    DOKKABI_SANDBOX_MODE: input.mode,
    TMPDIR: sandboxTemp,
    TMP: sandboxTemp,
    TEMP: sandboxTemp,
    SHELL: "/bin/bash",
    PATH: [...new Set(path)].join(":"),
    XDG_CONFIG_HOME: `${sandboxHome}/.config`,
    XDG_DATA_HOME: `${sandboxHome}/.local/share`,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    // Imports never mutate candidate bytes: bytecode goes to the cache
    // prefix, outside the tree. Only an execution with the session's own
    // cache directory writes it (G3, D57g); every other one — a judged run
    // with its own fresh directory included (G3', D57h) — writes none and
    // reads none.
    ...(sessionPython ? {} : { PYTHONDONTWRITEBYTECODE: "1" }),
    ...toolCacheEnvironment(
      toolCacheRootOf({ toolCacheDir: input.toolCacheDir, backend: input.backend, sandboxHome }),
      sessionPython ? "write" : "none",
    ),
  };
  for (const key of SAFE_HOST_KEYS) {
    const value = hostEnv[key];
    if (value && value.length <= 256 && !value.includes("\0") && !value.includes("\n")) {
      env[key] = value;
    }
  }
  // On a proxied network the way out is the proxy address, and clearing it
  // made a writable world with an open network behave like a closed one.
  // A URL carrying userinfo is still refused — that is the credential the
  // allowlist exists to stop (sandbox-proxy.ts).
  Object.assign(env, proxyEnvironment(hostEnv).env);
  return Object.freeze(env);
}

/**
 * Keys a fixture manifest requires ABSENT from a checker's environment
 * (fixture-manifest.ts: nothing the candidate can set may change what the
 * checker loads) that the host itself sets, to one fixed value, for G3. The
 * value is the host's constant, never the session's: the checker check
 * accepts exactly this value for the key and refuses every other one.
 */
export const HOST_FIXED_CHECKER_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ PYTEST_ADDOPTS: "-p no:cacheprovider" });

/**
 * G3 (D57g, design memo §121): a case run leaves the session's tree
 * unchanged. Every tool cache the host knows is redirected OUTSIDE the tree,
 * under one root `C`: the session's tool-cache directory (tool-cache.ts —
 * one per session and tree, shared by its executions, so a second run is
 * warm); for a run the host judges (G3', D57h: the final case pass, the base
 * pass, the verify step, rechecks, verifier copies, managed checkers), that
 * run's own directory, emptied before and after each execution
 * (tool-cache.ts renewJudgedToolCache); or, for any other execution (a
 * read-only phase, a world with no session), the policy's own home
 * (`$HOME/.cache/dokkabi-tools`; a Docker world's `/tmp/dokkabi-tools`). The variables, all
 * of them, with `C` the root:
 *   Python   PYTHONPYCACHEPREFIX = C/python with the session's directory
 *            (bytecode written and read there, never in the tree); otherwise
 *            /dev/null/dokkabi-pycache — a path that is never a directory —
 *            with PYTHONDONTWRITEBYTECODE=1 (nothing written, nothing read).
 *            Either way an in-tree `__pycache__` is never read.
 *   pytest   PYTEST_ADDOPTS = "-p no:cacheprovider" (no `.pytest_cache`; the
 *            one value a managed checker accepts, HOST_FIXED_CHECKER_ENVIRONMENT)
 *   XDG      XDG_CACHE_HOME = C/xdg (tools that follow XDG)
 *   pip, uv  PIP_CACHE_DIR = C/pip, UV_CACHE_DIR = C/uv
 *   mypy     MYPY_CACHE_DIR = C/mypy;  ruff  RUFF_CACHE_DIR = C/ruff
 *   Hypothesis HYPOTHESIS_STORAGE_DIRECTORY = C/hypothesis
 *   npm      npm_config_cache = C/npm;  yarn  YARN_CACHE_FOLDER = C/yarn
 *   pnpm     npm_config_store_dir = C/pnpm-store, npm_config_cache_dir = C/pnpm-cache
 *   bun      BUN_INSTALL_CACHE_DIR = C/bun
 *   node     NODE_COMPILE_CACHE = C/node-compile;  Babel  BABEL_CACHE_PATH = C/babel.json
 *   Go       GOCACHE = C/go-build, GOMODCACHE = C/go-mod
 *   Jest     no variable exists: its cacheDirectory is os.tmpdir(), the
 *            policy's own temporary directory (TMPDIR), outside the tree.
 * Build outputs are product, never redirected. A tool the host does not
 * redirect makes its run `changed`: visible, not credited (G1) — fixed by
 * adding its redirect here.
 */
/** A Docker world's cache root: the container's own /tmp (its writable
 * layer, never the /testbed tree). */
export const DOCKER_TOOL_CACHE_ROOT = "/tmp/dokkabi-tools";

/** The root `C` of a policy's tool caches (above): its session or judged
 * directory when it has one, else its home's (a Docker world's /tmp). The
 * case environment contract names it as a private root of its own (G3',
 * D57h), whichever of these it is, so the same checker run under a judged
 * policy and under a policy with no cache directory states one contract. */
export function toolCacheRootOf(input: { readonly toolCacheDir?: string; readonly backend?: string; readonly sandboxHome?: string }): string {
  return input.toolCacheDir ?? (input.backend === "docker" ? DOCKER_TOOL_CACHE_ROOT : `${input.sandboxHome ?? SANDBOX_DOKKABI_HOME}/.cache/dokkabi-tools`);
}

export function toolCacheEnvironment(root: string, python: "write" | "none"): Record<string, string> {
  return {
    PYTHONPYCACHEPREFIX: python === "write" ? `${root}/python` : "/dev/null/dokkabi-pycache",
    ...HOST_FIXED_CHECKER_ENVIRONMENT,
    XDG_CACHE_HOME: `${root}/xdg`,
    PIP_CACHE_DIR: `${root}/pip`,
    UV_CACHE_DIR: `${root}/uv`,
    MYPY_CACHE_DIR: `${root}/mypy`,
    RUFF_CACHE_DIR: `${root}/ruff`,
    HYPOTHESIS_STORAGE_DIRECTORY: `${root}/hypothesis`,
    npm_config_cache: `${root}/npm`,
    YARN_CACHE_FOLDER: `${root}/yarn`,
    npm_config_store_dir: `${root}/pnpm-store`,
    npm_config_cache_dir: `${root}/pnpm-cache`,
    BUN_INSTALL_CACHE_DIR: `${root}/bun`,
    NODE_COMPILE_CACHE: `${root}/node-compile`,
    BABEL_CACHE_PATH: `${root}/babel.json`,
    GOCACHE: `${root}/go-build`,
    GOMODCACHE: `${root}/go-mod`,
  };
}

export function sandboxEnvironmentDigest(env: Readonly<Record<string, string>>): string {
  return createHash("sha256")
    .update(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\0"))
    .digest("hex")
    .slice(0, 16);
}

function canonicalPath(value: string): string | undefined {
  try {
    return realpathSync(resolve(value));
  } catch {
    return undefined;
  }
}

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
