import { treeCoverageNow } from "../host/base-record.ts";
import { walkCovered } from "../host/coverage.ts";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSealedHostGit } from "../host/git-authority.ts";

export interface RuntimeArtifactManifest {
  readonly paths: readonly string[];
  readonly digest: string;
}

const SECRET_SEGMENT = /^(?:\.env(?:\..+)?|auth\.json|credentials(?:\..+)?|id_rsa|id_ed25519|\.npmrc|\.netrc|\.ssh|\.aws|\.gnupg|\.dokkabi(?:-home)?|\.pi|\.git)$/i;
const SECRET_SUFFIX = /\.(?:pem|key|p12|pfx)$/i;

export function isSensitiveRuntimePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized) return true;
  if (normalized === ".swe-test.patch" || normalized.startsWith(".dokkabi-swarm-input/")) return true;
  const segments = normalized.split("/");
  return segments.some((segment) => SECRET_SEGMENT.test(segment)) || SECRET_SUFFIX.test(normalized);
}

/** The locations the tree's rules ignore (and the fixed host exclusions),
 * as the HOST's own walk finds them (I2, D57g) — never git's index or
 * ignore machinery. */
function gitIgnoredRoots(root: string): string[] {
  const walked = walkCovered(root, treeCoverageNow(root));
  return walked.regions
    .filter((region) => region.why !== "special")
    .map((region) => region.path.toString())
    .filter((path) => path.length > 0 && !isSensitiveRuntimePath(path))
    .sort();
}

function digestPath(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  if (isSensitiveRuntimePath(relative)) return;
  const absolute = join(root, relative);
  const stat = lstatSync(absolute);
  hash.update(relative).update("\0").update(String(stat.mode)).update("\0");
  if (stat.isSymbolicLink()) {
    hash.update("link\0").update(readlinkSync(absolute)).update("\0");
    return;
  }
  if (stat.isDirectory()) {
    hash.update("dir\0");
    for (const entry of readdirSync(absolute).sort()) {
      digestPath(hash, root, join(relative, entry));
    }
    return;
  }
  hash.update("file\0").update(readFileSync(absolute)).update("\0");
}

export function runtimeArtifactManifest(root: string): RuntimeArtifactManifest {
  const paths = gitIgnoredRoots(root);
  const hash = createHash("sha256");
  for (const path of paths) digestPath(hash, root, path);
  return { paths, digest: hash.digest("hex") };
}

function copyArtifactTree(sourceRoot: string, targetRoot: string, relative: string): void {
  if (isSensitiveRuntimePath(relative)) return;
  const source = join(sourceRoot, relative);
  const target = join(targetRoot, relative);
  const stat = lstatSync(source);
  mkdirSync(dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(target, { mode: stat.mode & 0o777 });
    for (const entry of readdirSync(source).sort()) {
      copyArtifactTree(sourceRoot, targetRoot, join(relative, entry));
    }
    chmodSync(target, stat.mode & 0o777);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported runtime artifact: ${relative}`);
  }
  copyFileSync(source, target, constants.COPYFILE_FICLONE);
  chmodSync(target, stat.mode & 0o777);
}

export function materializeRuntimeArtifacts(
  sourceRoot: string,
  targetRoot: string,
  manifest: RuntimeArtifactManifest,
): void {
  const current = runtimeArtifactManifest(sourceRoot);
  if (current.digest !== manifest.digest) {
    throw new Error("source runtime artifacts changed while allocating a swarm world");
  }
  for (const path of manifest.paths) {
    copyArtifactTree(sourceRoot, targetRoot, path);
  }
  const copied = runtimeArtifactManifest(targetRoot);
  if (copied.digest !== manifest.digest) {
    throw new Error("swarm runtime artifact copy does not match the source manifest");
  }
}
