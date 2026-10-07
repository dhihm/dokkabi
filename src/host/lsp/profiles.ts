import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { lspDialect, tsserverDialect } from "./dialects.ts";
import type { DialectFactory } from "./server.ts";

/**
 * #222 D3 — explicitly configured server profiles only (v1: TypeScript and
 * Python). Nothing is installed or downloaded; a profile whose server is not
 * present is `unavailable`, and the session goes on without it.
 *
 * - `DOKKABI_LSP_DIAGNOSTICS=typescript,python` turns the feature on (D6:
 *   opt-in until measured). Unset: the plugin is not configured.
 * - TypeScript runs the workspace's own `node_modules/typescript/lib/
 *   tsserver.js` (resolved inside the workspace; a link out of it is refused)
 *   with the host's runtime, inside the session's sandbox policy.
 * - Python runs `DOKKABI_LSP_PYTHON_ARGV`, a JSON array whose first element
 *   is an absolute executable path, set by the operator — never a command a
 *   repository names.
 */

export type ProfileId = "typescript" | "python";
export const PROFILE_IDS: readonly ProfileId[] = ["typescript", "python"];
export const LSP_ENABLE_ENV = "DOKKABI_LSP_DIAGNOSTICS";
export const LSP_PYTHON_ARGV_ENV = "DOKKABI_LSP_PYTHON_ARGV";

export interface ServerProfile {
  readonly id: ProfileId | string;
  readonly extensions: readonly string[];
  readonly languageId: (path: string) => string;
  readonly argv: readonly string[];
  readonly dialect: DialectFactory;
  /** The wire dialect the profile speaks (#229 picks its method adapter);
   * absent means the Language Server Protocol. */
  readonly protocol?: "lsp" | "tsserver";
}

export type ProfileResolution =
  | { readonly ok: true; readonly profile: ServerProfile }
  | { readonly ok: false; readonly id: string; readonly reason: string };

export const TYPESCRIPT_EXTENSIONS = ["ts", "tsx", "mts", "cts"] as const;
export const PYTHON_EXTENSIONS = ["py", "pyi"] as const;

/** The ids the operator enabled, or why the value is invalid. */
export function enabledProfileIds(env: NodeJS.Dict<string> = process.env):
  | { readonly configured: false }
  | { readonly configured: true; readonly ids: ProfileId[] }
  | { readonly configured: true; readonly invalid: string } {
  const raw = env[LSP_ENABLE_ENV]?.trim();
  if (!raw) return { configured: false };
  const ids = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const unknown = ids.filter((id) => !(PROFILE_IDS as readonly string[]).includes(id));
  if (ids.length === 0 || unknown.length > 0) return { configured: true, invalid: `unknown profile ${unknown.join(",") || "(none)"}` };
  return { configured: true, ids: [...new Set(ids)] as ProfileId[] };
}

export function resolveProfile(id: ProfileId, input: {
  readonly root: string;
  readonly runtime?: string;
  readonly env?: NodeJS.Dict<string>;
}): ProfileResolution {
  if (id === "typescript") {
    const script = workspaceFile(input.root, "node_modules/typescript/lib/tsserver.js");
    if (!script) return { ok: false, id, reason: "typescript_server_absent" };
    return {
      ok: true,
      profile: {
        id,
        extensions: TYPESCRIPT_EXTENSIONS,
        languageId: (path) => (path.endsWith("x") ? "typescriptreact" : "typescript"),
        argv: [input.runtime ?? process.execPath, script, "--disableAutomaticTypingAcquisition", "--locale", "en"],
        dialect: tsserverDialect(),
        protocol: "tsserver",
      },
    };
  }
  const raw = (input.env ?? process.env)[LSP_PYTHON_ARGV_ENV];
  if (!raw) return { ok: false, id, reason: "python_server_not_configured" };
  let argv: unknown;
  try {
    argv = JSON.parse(raw);
  } catch {
    return { ok: false, id, reason: "python_argv_invalid" };
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32 || !argv.every((part) => typeof part === "string" && !part.includes("\u0000"))
    || !isAbsolute(argv[0] as string)) {
    return { ok: false, id, reason: "python_argv_invalid" };
  }
  return {
    ok: true,
    profile: { id, extensions: PYTHON_EXTENSIONS, languageId: () => "python", argv: argv as string[], dialect: lspDialect(), protocol: "lsp" },
  };
}

/** A regular file inside the root after resolving links, or undefined. */
function workspaceFile(root: string, rel: string): string | undefined {
  try {
    const real = realpathSync.native(join(root, rel));
    const inside = relative(root, real);
    if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return undefined;
    return lstatSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

export function profileFor(profiles: readonly ServerProfile[], path: string): ServerProfile | undefined {
  const extension = path.includes(".") ? path.split(".").at(-1)!.toLowerCase() : "";
  return profiles.find((profile) => profile.extensions.includes(extension));
}
