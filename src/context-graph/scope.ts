import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import type { EventRecord } from "../host/schema.ts";
import { recordedBase } from "../work/session-base.ts";

/**
 * §130 S1, as one shared derivation: the session's repository scope — the
 * identity of the ROOT the session works on (its device and inode, which no
 * path spelling changes), bound to the base record the log names. The
 * context-graph plugin's boot recording and the branch-context
 * prepare-boundary refresh both call this, so they can never disagree.
 *
 * A leaf module on purpose: the plugin stays free of the context-graph
 * runtime when the feature is off (G6). Returns undefined when the root
 * cannot be identified now — the caller then fails closed rather than
 * rebinding by path.
 */
export function repositoryScopeOf(log: { readonly events: readonly EventRecord[] }, workspaceRoot: string):
  { id: string; source: "base_record" | "root_inode" } | undefined {
  let root: { dev: bigint | number; ino: bigint | number };
  try {
    root = statSync(realpathSync(resolve(workspaceRoot)), { bigint: true });
  } catch {
    return undefined;
  }
  const base = recordedBase(log.events);
  const identity = { dev: String(root.dev), ino: String(root.ino), base: base?.digest ?? null };
  return {
    id: `repo:${createHash("sha256").update(canonicalJson(identity)).digest("hex").slice(0, 32)}`,
    source: base === undefined ? "root_inode" : "base_record",
  };
}
