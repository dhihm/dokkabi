import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The operator's toolchain, made visible to the sandboxed shell.
 *
 * The Seatbelt world enumerated system roots and the workspace and nothing
 * else, and the child PATH was the six system directories. On an Apple
 * Silicon Mac that left every Homebrew tool — python3, gh, node, uv, rg —
 * unreadable and unnamed: the shell answered "Operation not permitted" and
 * the model, unable to see why, spent turns on echo, tee, and heredocs before
 * the run died. bwrap had the same gap for /opt and the home toolchains.
 *
 * These roots are read and execute only. Writes still go to the workspace
 * and the session's private HOME, and the directories that hold credentials
 * — ~/.ssh, ~/.config (gh tokens), ~/.dokkabi, ~/.cargo/credentials.toml,
 * ~/.npmrc, the huggingface token under ~/.cache — are deliberately absent:
 * the list names package roots and caches, never a config directory.
 *
 * DOKKABI_SANDBOX_TOOLCHAIN=deny keeps the old enumerated world for a host
 * whose toolchain must stay invisible; like DOKKABI_SANDBOX_NET it is read
 * once when the policy is created and sealed into it.
 */

export const SANDBOX_TOOLCHAIN_ENV = "DOKKABI_SANDBOX_TOOLCHAIN";

const SYSTEM_TOOLCHAIN_ROOTS: readonly string[] = [
  "/opt/homebrew",
  "/opt/local",
  "/nix",
  "/opt/conda",
  "/opt/miniconda3",
  "/opt/anaconda3",
  "/snap",
];

/** Relative to the operator's HOME. Package roots and caches only. */
const HOME_TOOLCHAIN_ROOTS: readonly string[] = [
  ".bun",
  ".deno",
  ".nvm",
  ".pyenv",
  ".rustup",
  ".rbenv",
  ".sdkman",
  ".cargo/bin",
  ".cargo/registry",
  ".cache/uv",
  ".cache/pip",
  ".cache/pypoetry",
  ".cache/go-build",
  ".cache/ms-playwright",
  ".local/bin",
  ".local/lib",
  ".local/share/uv",
  ".local/share/pnpm",
  ".local/share/mise",
  ".local/pipx",
  "go/bin",
  "go/pkg",
  "miniconda3",
  "anaconda3",
  "micromamba",
];

export function toolchainDenied(env: NodeJS.Dict<string> = process.env): boolean {
  const configured = env[SANDBOX_TOOLCHAIN_ENV]?.trim();
  if (configured && configured !== "allow" && configured !== "deny") {
    throw new Error(`${SANDBOX_TOOLCHAIN_ENV} must be allow or deny`);
  }
  return configured === "deny";
}

/**
 * The toolchain roots that exist on this host, canonical, sorted, deduped.
 * Empty when the knob says deny. A root inside the workspace is left out:
 * the workspace is already visible and writable, and listing it twice would
 * only confuse the profile.
 */
export function toolchainRoots(input: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.Dict<string>;
  readonly home?: string;
  readonly exists?: (path: string) => boolean;
} = { workspaceRoot: process.cwd() }): readonly string[] {
  if (toolchainDenied(input.env)) return [];
  const exists = input.exists ?? isDirectory;
  const home = input.home ?? homedir();
  const candidates = [
    ...SYSTEM_TOOLCHAIN_ROOTS,
    ...HOME_TOOLCHAIN_ROOTS.map((relativePath) => join(home, relativePath)),
  ];
  const workspace = canonical(input.workspaceRoot) ?? resolve(input.workspaceRoot);
  const roots = new Set<string>();
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const real = canonical(candidate) ?? candidate;
    if (real === workspace || real.startsWith(`${workspace}/`)) continue;
    roots.add(real);
  }
  return [...roots].sort();
}

/** The bin directories among the roots, for the child PATH. */
export function toolchainBinDirs(
  roots: readonly string[],
  exists: (path: string) => boolean = isDirectory,
): readonly string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    if (root.endsWith("/bin")) {
      dirs.push(root);
      continue;
    }
    for (const name of ["bin", "sbin"]) {
      const dir = join(root, name);
      if (exists(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
