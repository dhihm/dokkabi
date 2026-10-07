import { posix } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { workspacePathReach } from "../plugins/workspace-tools.ts";

/**
 * #228 A2'/A2'': one fold for one decision. "The same read" — for a batch's
 * "same read twice" rule and for the loop's repeat-read cooldown alike — is
 * decided by what the path REACHES in the workspace (the file system's own
 * fold of case, normalisation and links; the inode when the file exists),
 * never by its spelling: `a`, `./a` and `a//` are one read. Without a root
 * (no workspace to ask) the spelling is normalised the same way for both.
 */
export function foldReadPath(root: string | undefined, path: string): string {
  const spelling = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (root !== undefined) {
    const reach = workspacePathReach(root, path);
    if (reach !== undefined) return `reach:${reach.relative.toString("hex")}${reach.inode ? `@${reach.inode}` : ""}`;
  }
  return `spelling:${spelling === "." ? "" : spelling}`;
}

/** The read tools whose calls have an identity worth folding. */
export const FOLDED_READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);

/**
 * The identity of one read call: the tool, the folded path and every other
 * argument as given (a window is part of the identity: the same file at
 * another offset is the next page, not the same read). Undefined for a tool
 * that is not a read, or a read that names nothing.
 */
export function readIdentityKey(tool: string, args: unknown, root?: string): string | undefined {
  if (!FOLDED_READ_TOOLS.has(tool) || !args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : "";
  if ((tool === "read" || tool === "ls") && path.length === 0) return undefined;
  if ((tool === "grep" || tool === "glob") && !(typeof record.pattern === "string" && record.pattern.length > 0)) return undefined;
  // The arguments that make a read another read — exactly the base's
  // (ad9d874) cooldown identity: a read's window, a grep's pattern and file
  // filter, a glob's pattern; a grep repeated with another `max_results` or
  // case flag is the same read and cools down as before.
  const identifying: Record<string, readonly string[]> = { read: ["offset", "limit"], grep: ["pattern", "glob"], glob: ["pattern"], ls: [] };
  const rest: Record<string, unknown> = {};
  for (const key of identifying[tool] ?? []) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") rest[key] = value;
  }
  // A glob's pattern is its path.
  const folded = tool === "glob" ? foldReadPath(undefined, String(record.pattern)) : path.length > 0 ? foldReadPath(root, path) : "";
  return `${tool}:${folded}:${canonicalJson(rest)}`;
}
