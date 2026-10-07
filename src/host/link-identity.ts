import { lstatSync, readlinkSync, type BigIntStats } from "node:fs";
import { inWritableWorld, mapAlias, unseenKind, worldSpelling, type WritableWorld } from "./writable-world.ts";

/**
 * THE ONE LINK RULE (W1, D57g, design memo §120/§121): a symbolic link is
 * identified by its target bytes AND — whenever its resolution passes
 * through or ends in the session's writable world W — by the identity of what
 * it resolves to: a file by its content, a directory by its listing identity,
 * anything else by what it is. Chains are followed to a bound (32 links); a
 * cycle, a component the host cannot read, a target beyond the bound, or a
 * resolution entering a namespace the host cannot see (bwrap's private /tmp,
 * a Docker container's own layer) is UNKNOWN. A link resolving entirely
 * outside W is identified by its target bytes alone. Targets are mapped
 * through the backend's path aliases first (Docker `/testbed`).
 *
 * The walk is the host's own, component by component by lstat, from the
 * link's own (physical) directory or from `/`; `..` climbs the physical path
 * the walk holds, never a lexical one. Images (execution-receipt.ts), change
 * sets and tamper counts (base-record.ts, through the listing's resolved
 * path) and so the kept-case target decision and caseGreenOn all take a
 * link's identity from here — there is no second link rule.
 */

export const LINK_HOPS_MAX = 32;

export type LinkResolution =
  /** Entirely outside W: the target bytes alone identify the link. */
  | { readonly kind: "outside" }
  /** A regular file reached in (or through) W: identified by its content. */
  | { readonly kind: "file"; readonly path: Buffer; readonly stat: BigIntStats }
  /** A directory reached in (or through) W. */
  | { readonly kind: "dir"; readonly path: Buffer; readonly stat: BigIntStats }
  /** Anything else reached in (or through) W — nothing there, a special
   * file, a file where a directory was needed — by what it is. */
  | { readonly kind: "other"; readonly identity: string }
  | { readonly kind: "unknown"; readonly why: string };

const SLASH = 0x2f;

function split(path: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (let at = 0; at <= path.length; at += 1) {
    if (at === path.length || path[at] === SLASH) {
      if (at > from) out.push(path.subarray(from, at));
      from = at + 1;
    }
  }
  return out;
}

const join = (parts: readonly Buffer[]) => (parts.length === 0 ? Buffer.from("/") : Buffer.concat(parts.flatMap((part) => [Buffer.from("/"), part])));
const isDot = (part: Buffer) => part.length === 1 && part[0] === 0x2e;
const isDotDot = (part: Buffer) => part.length === 2 && part[0] === 0x2e && part[1] === 0x2e;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "error";
}

/**
 * Resolve the link at `linkPath` (absolute, physical: the link's parent
 * directory holds no link) whose target bytes are `target`, in `world`.
 */
export function resolveLinkIdentity(linkPath: Buffer, target: Buffer, world: WritableWorld): LinkResolution {
  // A pass through a mount private to each execution (bwrap's tmpfs at
  // /tmp outside every root bound at its own path): the execution sees an
  // empty place there, the host something else. A resolution that touches
  // W as well is unknown; one entirely outside W is its target bytes, as
  // any link outside W (D57i).
  const state = { hidden: false };
  const resolved = resolveWalk(linkPath, target, world, state);
  if (!state.hidden || resolved.kind === "outside" || resolved.kind === "unknown") return resolved;
  return { kind: "unknown", why: "it resolves into a namespace the host cannot see" };
}

/** Whether `path` is a directory on the way to a root bound at its own
 * path: the fence makes it (bwrap `--dir`), so a walk passes it alike. */
function ancestorOfVisible(world: WritableWorld, path: Buffer): boolean {
  const prefix = path[path.length - 1] === SLASH ? path : Buffer.concat([path, Buffer.from("/")]);
  return world.visible.some((root) => {
    const spelled = Buffer.from(root);
    return spelled.length > prefix.length && spelled.subarray(0, prefix.length).equals(prefix);
  });
}

function resolveWalk(linkPath: Buffer, target: Buffer, world: WritableWorld, state: { hidden: boolean }): LinkResolution {
  /** Whether `path` is unseen for good (persistent); an ephemeral place is
   * noted and walked on. */
  const unseen = (path: Buffer): boolean => {
    const kind = unseenKind(world, path);
    if (kind === "ephemeral") state.hidden = true;
    return kind === "persistent";
  };
  if (target.length === 0) return inWritableWorld(world, linkPath) ? { kind: "other", identity: "empty" } : { kind: "outside" };
  let touched = false;
  let hops = 0;
  const seen = new Set<string>();
  const touch = (path: Buffer) => {
    if (!touched && inWritableWorld(world, path)) touched = true;
  };
  const start = (from: Buffer[], spelled: Buffer): { cur: Buffer[]; queue: Buffer[] } | { unknown: string } => {
    const mapped = spelled[0] === SLASH ? mapAlias(world, spelled) : spelled;
    if (mapped[0] === SLASH) {
      if (unseen(mapped)) return { unknown: "it resolves into a namespace the host cannot see" };
      return { cur: [], queue: split(mapped) };
    }
    return { cur: [...from], queue: split(mapped) };
  };
  const first = start(split(linkPath).slice(0, -1), target);
  if ("unknown" in first) return { kind: "unknown", why: first.unknown };
  let { cur, queue } = first;
  for (;;) {
    const part = queue.shift();
    if (part === undefined) break;
    if (isDot(part)) continue;
    if (isDotDot(part)) {
      cur.pop();
      continue;
    }
    const next = [...cur, part];
    const path = join(next);
    let stat: BigIntStats | undefined;
    try {
      stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    } catch (error) {
      return { kind: "unknown", why: `a component of its resolution cannot be read (${errorCode(error)})` };
    }
    touch(path);
    // Every component the walk passes: one only a private tmpfs holds —
    // not a bound root, nor a directory the fence makes on the way to one —
    // is empty for the execution (D57i).
    if (stat !== undefined && unseenKind(world, path) === "ephemeral" && !ancestorOfVisible(world, path)) state.hidden = true;
    if (stat === undefined) {
      if (unseen(path)) return { kind: "unknown", why: "it resolves into a namespace the host cannot see" };
      return touched ? { kind: "other", identity: `missing:${worldSpelling(world, path)}` } : { kind: "outside" };
    }
    if (stat.isSymbolicLink()) {
      hops += 1;
      if (hops > LINK_HOPS_MAX) return { kind: "unknown", why: "its chain of links goes beyond the bound" };
      const key = `${stat.dev}:${stat.ino}`;
      if (seen.has(key)) return { kind: "unknown", why: "its chain of links is a cycle" };
      seen.add(key);
      let hop: Buffer;
      try {
        hop = readlinkSync(path, { encoding: "buffer" }) as Buffer;
      } catch (error) {
        return { kind: "unknown", why: `a link on its way cannot be read (${errorCode(error)})` };
      }
      if (hop.length === 0) return touched ? { kind: "other", identity: `empty:${worldSpelling(world, path)}` } : { kind: "outside" };
      const again = start(cur, hop);
      if ("unknown" in again) return { kind: "unknown", why: again.unknown };
      cur = again.cur;
      queue = [...again.queue, ...queue];
      continue;
    }
    if (stat.isDirectory()) {
      cur = next;
      continue;
    }
    if (unseen(path)) return { kind: "unknown", why: "it resolves into a namespace the host cannot see" };
    if (queue.length > 0) return touched ? { kind: "other", identity: `notdir:${worldSpelling(world, path)}` } : { kind: "outside" };
    if (!touched) return { kind: "outside" };
    if (!stat.isFile()) return { kind: "other", identity: `special:${path.toString("base64")}:${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}:${stat.mode}` };
    return { kind: "file", path, stat };
  }
  const path = join(cur);
  touch(path);
  if (unseen(path)) return { kind: "unknown", why: "it resolves into a namespace the host cannot see" };
  if (!touched) return { kind: "outside" };
  let stat: BigIntStats | undefined;
  try {
    stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    return { kind: "unknown", why: `its directory cannot be read (${errorCode(error)})` };
  }
  if (stat === undefined || !stat.isDirectory()) return { kind: "other", identity: `missing:${worldSpelling(world, path)}` };
  return { kind: "dir", path, stat };
}
