import type { CaseSpeculationProfile } from "./case-runners.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type AuthorizedCaseRecipe = Readonly<{
  recipeId: string;
  planDigest: string;
  caseDigest: string;
  runnerId: string;
  tool: "bash";
  args: Readonly<{ command: string; timeout?: number }>;
  sourceDigest: string;
  redMeans: string;
  profile?: CaseSpeculationProfile;
}>;

export type AuthorizedBuildCaseRecipe = AuthorizedCaseRecipe & Readonly<{ profile: CaseSpeculationProfile }>;

export type AuthorizedCaseSource = Readonly<{ digest: string; bytes: number }>;

export function inspectAuthorizedCaseSource(workspaceRoot: string, relativePath: string): AuthorizedCaseSource | undefined {
  try {
    const root = realpathSync(workspaceRoot);
    const path = realpathSync(resolve(root, relativePath));
    const rel = relative(root, path);
    const stat = lstatSync(path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !stat.isFile() || stat.isSymbolicLink()) return undefined;
    const bytes = readFileSync(path);
    return Object.freeze({ digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength });
  } catch {
    return undefined;
  }
}

export function sourceDigestForAuthorizedCase(workspaceRoot: string, relativePath: string): string | undefined {
  return inspectAuthorizedCaseSource(workspaceRoot, relativePath)?.digest;
}
