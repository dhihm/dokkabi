import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSealedHostGit } from "../host/git-authority.ts";

const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_COMMITS = 200;
const MAX_FILES_PER_COMMIT = 16;
const MAX_RULES = 512;
const MAX_GIT_RUNTIME_MS = 5_000;
const SECRET_PATH = /(?:^|\/)(?:auth\.json|\.env(?:\..+)?|credentials(?:\..+)?|id_rsa|id_ed25519|\.npmrc)$/i;

export interface CoEditRule {
  readonly source: string;
  readonly target: string;
  readonly count: number;
}

export function parseCoEditHistory(text: string): CoEditRule[] {
  if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) return [];
  const commits: string[][] = [];
  let current: string[] | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (line === "--COMMIT--") {
      if (current) commits.push(current);
      if (commits.length === MAX_COMMITS) break;
      current = [];
      continue;
    }
    const path = safeRepositoryPath(line);
    if (current && path && !current.includes(path)) current.push(path);
  }
  if (current && commits.length < MAX_COMMITS) commits.push(current);

  const counts = new Map<string, number>();
  for (const files of commits) {
    if (files.length < 2 || files.length > MAX_FILES_PER_COMMIT) continue;
    for (const source of files) {
      for (const target of files) {
        if (source === target) continue;
        const key = JSON.stringify([source, target]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [source, target] = JSON.parse(key) as [string, string];
      return { source, target, count };
    })
    .sort(compareRules)
    .slice(0, MAX_RULES)
    .sort((left, right) => comparePath(left.source, right.source) || comparePath(left.target, right.target));
}

/** The co-edit rules of the workspace's recent history, read through the
 * sealed boundary (S2, D57e): the workspace is a tree sessions write, and a
 * plain `git log` there reads its configuration (log.showSignature runs
 * gpg.program, include.path reaches any file). */
export function compileGitCoEdits(workspaceRoot: string): CoEditRule[] {
  const root = resolve(workspaceRoot);
  let run: ReturnType<typeof spawnSealedHostGit>;
  try {
    run = spawnSealedHostGit(root, ["log", "--pretty=format:--COMMIT--", "--name-only", "--no-renames", "-n", String(MAX_COMMITS)], {
      timeoutMs: MAX_GIT_RUNTIME_MS,
    });
  } catch {
    return [];
  }
  if (run.exitCode !== 0 || run.stdout.length > MAX_HISTORY_BYTES) return [];
  return parseCoEditHistory(run.stdout.toString("utf8"));
}

export function relatedCoEdits(
  rules: readonly CoEditRule[],
  sources: readonly string[],
  limit = 4,
): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const sourceSet = new Set(sources);
  const seen = new Set<string>();
  return rules
    .filter((rule) => sourceSet.has(rule.source) && !sourceSet.has(rule.target))
    .sort((left, right) => right.count - left.count || comparePath(left.target, right.target))
    .flatMap((rule) => {
      if (seen.has(rule.target) || seen.size >= limit) return [];
      seen.add(rule.target);
      return [rule.target];
    });
}

function safeRepositoryPath(value: string): string | undefined {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.length > 512 || path.includes("\0") || path.includes("\n")) return undefined;
  if (isAbsolute(path) || SECRET_PATH.test(path)) return undefined;
  const resolved = resolve("/repo", path);
  const inside = relative("/repo", resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return path;
}

function compareRules(left: CoEditRule, right: CoEditRule): number {
  return right.count - left.count
    || comparePath(left.source, right.source)
    || comparePath(left.target, right.target);
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
