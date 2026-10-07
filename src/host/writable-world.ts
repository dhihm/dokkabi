import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { EventLog } from "./event-log.ts";
import { bwrapMountTable, type SandboxPolicy } from "./sandbox.ts";

/**
 * THE SESSION'S WRITABLE WORLD, STATED ONCE (W, D57g, design memo §120/§121).
 *
 * The image's authority is the set of locations a session can write: W = the
 * workspace, the sandbox home, the sandbox temp, the scratch, and any other
 * writable path a policy of the session grants. Everything else is
 * host-owned (read-only to the session) or unknown. Every reader of tree
 * identity takes W from here — images (execution-receipt.ts), change sets and
 * tamper counts (base-record.ts), the kept-case target decision, caseGreenOn
 * and acceptV2 through those images, the require-plan guard and immobility
 * through the session's listing — and follows a link into W by what it
 * reaches (link-identity.ts, W1). No second definition exists.
 *
 *   `tree`       the tree being digested (its real path);
 *   `roots`      other writable roots the host can see (Seatbelt's per-policy
 *                home and temp, the scratch, a phase's writable paths), real
 *                paths;
 *   `unseen`     writable locations in a namespace the host cannot see
 *                (bwrap's private mounts — the tmpfs at /tmp, so its HOME
 *                and TMPDIR, and the shm of its fresh /dev; a Docker
 *                container's writable layer — everything but the /testbed
 *                mount): a link whose resolution enters one is unknown;
 *   `visible`    roots a bwrap world binds at their own paths (the
 *                workspace, the scratch, the tool cache, …) — read from the
 *                policy's actual mount table (sandbox.ts bwrapMountTable),
 *                kept only when every bwrap policy of the world over this
 *                tree binds them (a policy over another tree — a judged
 *                run's copy — binds that tree, and decides nothing here):
 *                the host sees there what the execution sees, even under a
 *                private mount (a tree under /tmp). A location is unseen
 *                exactly when the deepest of these holding it is unseen;
 *   `aliases`    path mappings of the backend (Docker /testbed → the
 *                workspace): a link target is mapped before it is resolved;
 *   `hostOwned`  host-owned locations INSIDE the tree (W2: a session
 *                directory the layout puts under the workspace — the
 *                sandbox denies the session every write to it): excluded from
 *                the image by path; a row the host appends never moves it.
 *
 * Residuals, stated: the remote side of an ssh case is not covered (its
 * receipt covers only the local tree); POSIX shm, mach services and the
 * pasteboard under Seatbelt, and a localhost server, are writable state
 * outside W that the image cannot see.
 */
export interface WritableWorld {
  readonly tree: string;
  readonly roots: readonly string[];
  readonly unseen: readonly string[];
  readonly visible: readonly string[];
  readonly aliases: readonly { readonly from: string; readonly to: string }[];
  readonly hostOwned: readonly string[];
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const SESSION_POLICIES = new WeakMap<EventLog, Set<SandboxPolicy>>();

/** A policy a session's log created (sandbox.ts createPolicy): part of that
 * session's writable world for as long as the process lives. */
export function registerSessionPolicy(log: EventLog, policy: SandboxPolicy): void {
  let policies = SESSION_POLICIES.get(log);
  if (policies === undefined) {
    policies = new Set();
    SESSION_POLICIES.set(log, policies);
  }
  policies.add(policy);
}

/** The session directory of a log when it lies inside `tree` (W2): a
 * host-owned location there. */
export function hostOwnedSessionDir(logPath: string, tree: string): string | undefined {
  const treeReal = real(tree);
  const dir = real(dirname(resolve(logPath)));
  if (treeReal === undefined || dir === undefined) return undefined;
  return within(treeReal, dir) && dir !== treeReal ? dir : undefined;
}

/** The writable world a set of policies grants over `tree`. */
export function writableWorldOf(tree: string, policies: Iterable<SandboxPolicy>, hostOwned: readonly string[] = []): WritableWorld {
  const treeReal = real(tree) ?? resolve(tree);
  const roots = new Set<string>();
  const unseen = new Set<string>();
  // Visible roots per bwrap policy: those over THIS tree decide (a judged
  // run's policy over a copy binds the copy, never this tree, and says
  // nothing about what this tree's executions see); others only when none
  // is over it.
  let visible: Set<string> | undefined;
  let visibleElsewhere: Set<string> | undefined;
  const aliases: { from: string; to: string }[] = [];
  // A mount point as the policy spells it and as the host's real path.
  const spellings = (path: string) => {
    const resolved = real(path);
    return resolved === undefined || resolved === path ? [path] : [path, resolved];
  };
  const add = (path: string | undefined) => {
    if (path === undefined) return;
    const resolved = real(path);
    if (resolved !== undefined && !within(treeReal, resolved)) roots.add(resolved);
  };
  for (const policy of policies) {
    if (policy.disabled === true) continue;
    for (const path of policy.writablePaths ?? []) add(path);
    if (policy.mode !== "read-only") add(policy.scratchRoot);
    // The session's tool-cache directory (G3): writable by its executions,
    // not part of the image — a link into it is followed like any link in W.
    if (policy.mode !== "read-only") add(policy.toolCacheDir);
    if (policy.backend === "seatbelt" && policy.mode !== "read-only") {
      add(policy.sandboxHome);
      add(policy.sandboxTemp);
    }
    if (policy.backend === "bwrap") {
      // The policy's actual mount table (sandbox.ts bwrapMountTable): its
      // private mounts are unseen, a root bound at its own path is visible
      // — only when every bwrap policy of the world binds it so.
      const table = bwrapMountTable(policy);
      for (const path of table.private) for (const spelled of spellings(path)) unseen.add(spelled);
      const bound = new Set(table.samePath.flatMap(spellings));
      const overTree = (real(policy.workspaceRoot) ?? resolve(policy.workspaceRoot)) === treeReal;
      if (overTree) visible = visible === undefined ? bound : new Set([...visible].filter((path) => bound.has(path)));
      else visibleElsewhere = visibleElsewhere === undefined ? bound : new Set([...visibleElsewhere].filter((path) => bound.has(path)));
    }
    if (policy.backend === "docker") {
      aliases.push({ from: "/testbed", to: treeReal });
      unseen.add("/");
    }
  }
  return {
    tree: treeReal,
    roots: [...roots].sort(),
    unseen: [...unseen].sort(),
    // The tree and every root of W are bound at their own paths by every
    // execution that can reach them (the session's over the tree, the
    // scratch and the tool cache with it): visible, whatever private mount
    // holds them — the most specific mount decides (D57i).
    visible: [...new Set([...(visible ?? visibleElsewhere ?? []), ...(unseen.size > 0 && !unseen.has("/") ? [treeReal, ...roots] : [])])].sort(),
    aliases,
    hostOwned: hostOwned.map((path) => real(path) ?? path).filter((path) => within(treeReal, path)),
  };
}

/** The writable world of the session behind `log` over `tree`: every policy
 * it created, and its own directory when that lies inside the tree. */
export function sessionWritableWorld(log: EventLog, tree: string): WritableWorld {
  const owned = hostOwnedSessionDir(log.path, tree);
  return writableWorldOf(tree, SESSION_POLICIES.get(log) ?? [], owned === undefined ? [] : [owned]);
}

/** A world with nothing but the tree (a copy the host made, a test). */
export function treeOnlyWorld(tree: string): WritableWorld {
  return writableWorldOf(tree, []);
}

// The predicates compare BYTES: a path the host walked is bytes (a name
// need not be UTF-8), the world's roots are the UTF-8 bytes of their real
// paths. Never a latin1 or lossy decoding of either.
function withinBytes(root: Buffer, path: Buffer): boolean {
  if (path.equals(root)) return true;
  const prefix = root.length > 0 && root[root.length - 1] === 0x2f ? root : Buffer.concat([root, Buffer.from("/")]);
  return path.length > prefix.length && path.subarray(0, prefix.length).equals(prefix);
}
const bytes = (value: string | Buffer): Buffer => (typeof value === "string" ? Buffer.from(value, "utf8") : value);

/** Whether `path` (absolute, physical) lies in W: the tree or a root. */
export function inWritableWorld(world: WritableWorld, path: string | Buffer): boolean {
  const at = bytes(path);
  return withinBytes(bytes(world.tree), at) || world.roots.some((root) => withinBytes(bytes(root), at));
}

/** Whether `path` lies in a namespace the host cannot see: the deepest
 * mount holding it is private (a root bound at its own path inside a
 * private mount is visible); Docker's `/` is everything outside W. */
export function inUnseenWorld(world: WritableWorld, path: string | Buffer): boolean {
  return unseenKind(world, path) !== undefined;
}

/**
 * How `path` is unseen: `persistent` — a namespace that outlives an
 * execution (a Docker container's layer, everything outside W there);
 * `ephemeral` — a mount private to each execution and empty at its start
 * (bwrap's tmpfs at /tmp, its fresh /dev's shm), where the deepest mount
 * holding the path is private; undefined when the host sees it.
 */
export function unseenKind(world: WritableWorld, path: string | Buffer): "persistent" | "ephemeral" | undefined {
  const at = bytes(path);
  let hidden = -1;
  for (const root of world.unseen) {
    if (root === "/") {
      if (!inWritableWorld(world, at)) return "persistent";
      continue;
    }
    const spelled = bytes(root);
    if (withinBytes(spelled, at)) hidden = Math.max(hidden, spelled.length);
  }
  if (hidden < 0) return undefined;
  let seen = -1;
  for (const root of world.visible ?? []) {
    const spelled = bytes(root);
    if (withinBytes(spelled, at)) seen = Math.max(seen, spelled.length);
  }
  return hidden > seen ? "ephemeral" : undefined;
}

/** A link target as the backend's world spells it, mapped to the host's
 * path (Docker `/testbed/…` → the workspace); unchanged otherwise. */
export function mapAlias(world: WritableWorld, target: Buffer): Buffer {
  for (const alias of world.aliases) {
    const from = bytes(alias.from);
    if (target.equals(from)) return bytes(alias.to);
    if (target.length > from.length && target[from.length] === 0x2f && target.subarray(0, from.length).equals(from)) {
      return Buffer.concat([bytes(alias.to), target.subarray(from.length)]);
    }
  }
  return target;
}

/**
 * A location as W names it, independent of where the tree lies: in the tree,
 * `t:` and its path relative to the tree; in the k-th other root, `r<k>:`
 * and its path relative to that root; elsewhere, `a:` and the absolute path
 * (base64 of the bytes). An identity made from it (a link to nothing, to an
 * empty target, through a file) is the same for a copy of the tree.
 */
export function worldSpelling(world: WritableWorld, path: Buffer): string {
  const under = (root: Buffer): Buffer | undefined => {
    if (path.equals(root)) return Buffer.alloc(0);
    return withinBytes(root, path) ? path.subarray(root[root.length - 1] === 0x2f ? root.length : root.length + 1) : undefined;
  };
  const inTree = under(bytes(world.tree));
  if (inTree !== undefined) return `t:${inTree.toString("base64")}`;
  for (const [k, root] of world.roots.entries()) {
    const rel = under(bytes(root));
    if (rel !== undefined) return `r${k}:${rel.toString("base64")}`;
  }
  return `a:${path.toString("base64")}`;
}
