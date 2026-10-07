import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import { sealedGitConfigFile, spawnSealedHostGit } from "../host/git-authority.ts";

const OBJECT_ID = /^[a-f0-9]{40,64}$/u;

/** Clone-stable repository identity. Paths and raw remotes never enter the
 * returned canonical material: root object IDs are intrinsic to history and a
 * network origin, when present, is normalized and hashed independently. */
export function swarmRepositoryDigest(workspaceRoot: string): string {
  const shallowResult = spawnSealedHostGit(workspaceRoot, ["rev-parse", "--is-shallow-repository"]);
  if (shallowResult.exitCode !== 0) throw new Error("cannot determine whether swarm repository is shallow");
  const shallow = shallowResult.stdout.toString().trim();
  if (shallow === "true") throw new Error("cannot derive swarm repository identity from a shallow history");
  if (shallow !== "false") throw new Error("swarm repository shallow state is invalid");

  const rootsResult = spawnSealedHostGit(workspaceRoot, ["rev-list", "--max-parents=0", "HEAD"]);
  if (rootsResult.exitCode !== 0) throw new Error("cannot derive swarm repository roots");
  const roots = [...new Set(rootsResult.stdout.toString().trim().split(/\s+/u).filter(Boolean))].sort();
  if (roots.length === 0 || roots.some((root) => !OBJECT_ID.test(root))) {
    throw new Error("swarm repository has invalid root object ids");
  }

  // The origin as the repository's own config file states it, read as data
  // (S2: no sealed git reads a repository's configuration; includes are not
  // followed).
  const originResult = sealedGitConfigFile(workspaceRoot, ["--get", "remote.origin.url"]);
  if (originResult.exitCode !== 0 && originResult.exitCode !== 1) {
    throw new Error("cannot derive swarm repository origin identity");
  }
  const origin = originResult.exitCode === 0
    ? normalizedNetworkOrigin(originResult.stdout.toString())
    : undefined;
  const identity = {
    format: 1,
    roots,
    ...(origin ? { originDigest: sha256(origin) } : {}),
  };
  return sha256(canonicalJson(identity));
}

function normalizedNetworkOrigin(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(value);
  if (!value.includes("://") && scp && !/^[A-Za-z]:[\\/]/u.test(value)) {
    return normalizedHostPath(scp[1]!, scp[2]!);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Local clone paths are deliberately omitted. Root object IDs retain a
    // clone-stable identity without hashing host-private filesystem paths.
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:" &&
    parsed.protocol !== "git:") return undefined;
  return normalizedHostPath(parsed.host, parsed.pathname);
}

function normalizedHostPath(host: string, path: string): string | undefined {
  const hostname = host.trim().toLowerCase();
  const repository = path.trim().replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  if (!hostname || !repository || /[\0\r\n]/u.test(`${hostname}${repository}`)) return undefined;
  return `${hostname}/${repository}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
