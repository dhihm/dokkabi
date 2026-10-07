import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { expandHomePath } from "./workspace-path.ts";

/** Credential file names withheld by workspace and pinned-repository tools.
 * Keep this independent of plugins so mutation authority shares the policy. */
const SECRET_FILES = /(?:^|\/)(?:auth\.json|\.env(?:\..+)?|credentials(?:\..+)?|id_rsa|id_ed25519|\.npmrc)$/iu;

export function isSecretPath(path: string): boolean {
  return SECRET_FILES.test(path.replaceAll("\\", "/"));
}

/** Admission checks what the spelling reaches, without exposing the resolved
 * name. This is not an IO capability: containment and no-follow opens still
 * apply at execution. Unknown paths retain their existing kind/boundary errors.
 * Git object paths must use isSecretPath instead of the mutable worktree. */
export function isSecretWorkspaceTarget(root: string, path: string): boolean {
  if (isSecretPath(path)) return true;
  try {
    const canonicalRoot = realpathSync(resolve(root));
    const target = realpathSync(resolve(root, expandHomePath(path)));
    const rel = relative(canonicalRoot, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    return isSecretPath(rel);
  } catch {
    return false;
  }
}

/** No resolved path or credential bytes are permitted in refusal text. */
export const CREDENTIAL_PATH_REFUSAL = "secret file access refused (credential policy)";
export function credentialPathRefusal(): Error {
  return new Error(CREDENTIAL_PATH_REFUSAL);
}
