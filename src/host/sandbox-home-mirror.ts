import { mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * The sandbox home mirrors the operator's home-relative spelling of every
 * bound root (workspace, git common dir, toolchain) so that the `~/…` paths
 * durable records carry after home-path normalization resolve inside the
 * sandbox too: without the mirror, `~` is the sandbox home (bwrap
 * /tmp/dokkabi-home; a per-policy temp home under Seatbelt), and a copied
 * `~/x/y` path named a directory the child could not enter. Each mirror is a
 * symlink at the same home-relative path pointing at the root's real path —
 * which both native backends already bind or allow at that real path — so a
 * symlink grants no access its target did not already have, and nothing else
 * of the operator's home becomes visible.
 */

/** Home-relative paths the sandbox policy already claims through XDG-style
 * environment variables; a root whose home-relative path is one of these is
 * not mirrored — the collision is recorded, never silently dropped. */
export const SANDBOX_HOME_RESERVED_DIRS: readonly string[] = [
  ".cache",
  ".config",
  ".local/share",
  ".bun/install/cache",
];

export interface HomeMirror {
  /** The root's real absolute path, the symlink target. */
  readonly root: string;
  /** Path relative to the operator's real home, no leading slash. */
  readonly homePath: string;
  /** Where the symlink lives inside the sandbox home. */
  readonly sandboxPath: string;
}

export interface HomeMirrorPlan {
  readonly mirrors: readonly HomeMirror[];
  /** `<reason>:<root>` for every root not mirrored — `home` when the root is
   * the home itself, `outside` when it lies elsewhere, `xdg` on collision,
   * `nested` when an already-mirrored ancestor resolves the root already. */
  readonly skipped: readonly string[];
}

export function planHomeMirrors(input: {
  readonly home?: string;
  readonly sandboxHome: string;
  readonly roots: readonly string[];
}): HomeMirrorPlan {
  const home = resolve(input.home ?? homedir());
  const sandboxHome = resolve(input.sandboxHome);
  const skipped: string[] = [];
  const mirrors: HomeMirror[] = [];
  const seen = new Set<string>();
  const mirrored = new Set<string>();
  // Ascending home-relative order puts every ancestor before its descendants
  // (an ancestor's path is a prefix followed by "/"), so by the time a nested
  // root is reached the mirror that would resolve it is already planned.
  const sorted = [...new Set(input.roots.map((root) => resolve(root)))]
    .map((root) => ({ root, rel: relative(home, root) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const { root, rel } of sorted) {
    if (rel === "") {
      skipped.push(`home:${root}`);
      continue;
    }
    if (rel.startsWith("..") || isAbsolute(rel)) {
      skipped.push(`outside:${root}`);
      continue;
    }
    if (SANDBOX_HOME_RESERVED_DIRS.includes(rel)) {
      skipped.push(`xdg:${root}`);
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    // A root under an already-mirrored root needs no symlink of its own: the
    // ancestor's mirror keeps the identical relative layout, so ~/ancestor/inner
    // resolves through it to the real inner path. Mirroring it anyway would
    // have bwrap --symlink onto a directory its own --dir just created.
    const parts = rel.split("/");
    if (parts.slice(1).some((_, i) => mirrored.has(parts.slice(0, i + 1).join("/")))) {
      skipped.push(`nested:${root}`);
      continue;
    }
    mirrored.add(rel);
    mirrors.push({ root, homePath: rel, sandboxPath: `${sandboxHome}/${rel}` });
  }
  mirrors.sort((a, b) => (a.homePath < b.homePath ? -1 : a.homePath > b.homePath ? 1 : 0));
  return { mirrors, skipped: [...new Set(skipped)].sort() };
}

/** The sandbox paths that will be symlinks; a directory must never be created
 * at or beneath one of them — mkdir would follow an existing symlink into the
 * operator's real tree, and bwrap --dir followed by --symlink at the same path
 * fails outright. */
function assertNoDirUnderSymlink(dirs: readonly string[], mirrors: readonly HomeMirror[]): void {
  for (const dir of dirs) {
    for (const mirror of mirrors) {
      if (dir === mirror.sandboxPath || dir.startsWith(`${mirror.sandboxPath}/`)) {
        throw new Error(
          `home mirror invariant violated: directory ${dir} would be created at or beneath symlink ${mirror.sandboxPath} -> ${mirror.root}`,
        );
      }
    }
  }
}

/**
 * The bwrap argv fragment that materializes the mirror inside the sandbox:
 * `--dir` for every intermediate directory under the sandbox home, then one
 * `--symlink <root> <sandbox path>` per mirrored root. The real target paths
 * are bound earlier in the same argv, so each symlink resolves.
 */
export function homeMirrorBwrapArgs(
  sandboxHome: string,
  roots: readonly string[],
  home?: string,
): string[] {
  const plan = planHomeMirrors({ sandboxHome, roots, ...(home ? { home } : {}) });
  const dirs = new Set<string>();
  for (const mirror of plan.mirrors) {
    let current = resolve(sandboxHome);
    for (const part of mirror.homePath.split("/").slice(0, -1)) {
      current = `${current}/${part}`;
      dirs.add(current);
    }
  }
  assertNoDirUnderSymlink([...dirs], plan.mirrors);
  return [
    ...[...dirs].sort().flatMap((dir) => ["--dir", dir]),
    ...plan.mirrors.flatMap((mirror) => ["--symlink", mirror.root, mirror.sandboxPath]),
  ];
}

/**
 * Create the same symlink tree inside a Seatbelt sandbox home before exec —
 * Seatbelt has no mount namespace, so the host builds the mirror directly.
 */
export function materializeHomeMirrors(mirrors: readonly HomeMirror[]): void {
  assertNoDirUnderSymlink(
    mirrors.map((mirror) => dirname(mirror.sandboxPath)),
    mirrors,
  );
  for (const mirror of mirrors) {
    mkdirSync(dirname(mirror.sandboxPath), { recursive: true });
    try {
      symlinkSync(mirror.root, mirror.sandboxPath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? Reflect.get(error, "code")
        : undefined;
      if (code !== "EEXIST") throw error;
    }
  }
}
