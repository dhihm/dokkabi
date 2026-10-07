import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { containsSecret } from "./redact.ts";

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SKILL_ID = /^[a-z][a-z0-9._-]{0,127}$/u;
const MAX_TREE_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 64;

export interface ManagedPluginFile {
  readonly path: string;
  readonly body: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface ManagedPluginCandidate {
  readonly id: string;
  readonly skillName: string;
  readonly description: string;
  readonly repository: string;
  readonly commit: string;
  readonly sourcePath: string;
  readonly license: string;
  readonly digest: string;
  readonly files: readonly ManagedPluginFile[];
  readonly totalBytes: number;
  readonly references: readonly string[];
}

export interface ManagedPluginInspectRequest {
  readonly repository: string;
  readonly ref?: string;
  readonly path?: string;
  readonly id?: string;
}

export type GithubJsonReader = (endpoint: string, maxBytes?: number) => Promise<unknown>;

interface GithubTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  readonly size?: number;
}

/** Inspect only public GitHub data. No repository code is executed and no
 * credential is sent; callers separately gate persistence of the exact bytes. */
export async function inspectManagedPlugin(
  request: ManagedPluginInspectRequest,
  readJson: GithubJsonReader = readPublicGithubJson,
): Promise<ManagedPluginCandidate> {
  const repository = normalizeRepository(request.repository);
  const metadata = object(await readJson(`repos/${repository}`), "repository metadata");
  if (metadata.private !== false) throw new Error("managed plugins require a public GitHub repository");
  const defaultBranch = string(metadata.default_branch, "default branch", 128);
  const requestedRef = request.ref?.trim() || defaultBranch;
  if (!REF.test(requestedRef) || requestedRef.includes("..") || requestedRef.includes("//")) {
    throw new Error("invalid managed plugin ref");
  }
  const commitResponse = object(
    await readJson(`repos/${repository}/commits/${encodeURIComponent(requestedRef)}`),
    "commit metadata",
  );
  const commit = string(commitResponse.sha, "commit sha", 40);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("GitHub returned an invalid commit sha");
  const commitBody = object(commitResponse.commit, "commit body");
  const commitTree = object(commitBody.tree, "commit tree");
  const treeSha = string(commitTree.sha, "tree sha", 40);
  if (!/^[a-f0-9]{40}$/u.test(treeSha)) throw new Error("GitHub returned an invalid tree sha");
  const treeResponse = object(
    await readJson(`repos/${repository}/git/trees/${treeSha}?recursive=1`, MAX_TREE_RESPONSE_BYTES),
    "repository tree",
  );
  if (treeResponse.truncated === true) throw new Error("managed plugin repository tree is truncated");
  if (!Array.isArray(treeResponse.tree)) throw new Error("GitHub returned an invalid repository tree");
  const tree = treeResponse.tree.map(parseTreeEntry);
  const sourcePath = request.path === undefined
    ? autoDetectSkillRoot(tree)
    : normalizeRelativePath(request.path, "skill path");
  const fileMap = await materializeSkillFiles(repository, tree, sourcePath, readJson);
  await includeLicense(repository, tree, fileMap, readJson);
  const skill = fileMap.get("SKILL.md");
  if (!skill) throw new Error(`managed plugin ${sourcePath} has no SKILL.md`);
  const frontmatter = parseSkillFrontmatter(skill.body);
  const id = request.id?.trim() || frontmatter.name;
  if (!SKILL_ID.test(id)) throw new Error("invalid managed plugin id");
  const files = [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (files.length > MAX_FILES) throw new Error(`managed plugin file limit is ${MAX_FILES}`);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`managed plugin byte limit is ${MAX_TOTAL_BYTES}`);
  const licenseObject = plainObject(metadata.license) ? metadata.license : {};
  const license = typeof licenseObject.spdx_id === "string" && licenseObject.spdx_id.length <= 64
    ? licenseObject.spdx_id
    : "NOASSERTION";
  const references = referencedFiles(skill.body).filter((path) => fileMap.has(path));
  const digest = candidateDigest({
    id,
    skillName: frontmatter.name,
    repository,
    commit,
    sourcePath,
    license,
    files,
  });
  return Object.freeze({
    id,
    skillName: frontmatter.name,
    description: frontmatter.description,
    repository,
    commit,
    sourcePath,
    license,
    digest,
    files: Object.freeze(files),
    totalBytes,
    references: Object.freeze(references),
  });
}

export function candidateDigest(input: Pick<
  ManagedPluginCandidate,
  "id" | "skillName" | "repository" | "commit" | "sourcePath" | "license" | "files"
>): string {
  return sha256(canonicalJson({
    format: 1,
    id: input.id,
    skill_name: input.skillName,
    repository: input.repository,
    commit: input.commit,
    source_path: input.sourcePath,
    license: input.license,
    files: input.files.map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes })),
  }));
}

export async function readPublicGithubJson(endpoint: string, maxBytes = 1024 * 1024): Promise<unknown> {
  if (!/^repos\/[A-Za-z0-9._%?=&/-]+$/u.test(endpoint) || endpoint.includes("..")) {
    throw new Error("invalid public GitHub API endpoint");
  }
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Dokkabi-managed-plugin-inspector",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("public GitHub response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("public GitHub response is too large");
  if (!response.ok) throw new Error(`public GitHub inspection failed with HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("public GitHub returned invalid JSON");
  }
}

async function materializeSkillFiles(
  repository: string,
  tree: readonly GithubTreeEntry[],
  sourcePath: string,
  readJson: GithubJsonReader,
): Promise<Map<string, ManagedPluginFile>> {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  const prefix = `${sourcePath}/`;
  const selected = tree.filter((entry) => entry.path.startsWith(prefix));
  if (selected.length === 0) throw new Error(`managed plugin path not found: ${sourcePath}`);
  const files = new Map<string, ManagedPluginFile>();
  const addBlob = async (entry: GithubTreeEntry, destination: string): Promise<void> => {
    if (entry.type !== "blob" || entry.mode !== "100644") {
      throw new Error(`managed plugins accept only non-executable regular files: ${entry.path}`);
    }
    const path = normalizeRelativePath(destination, "managed plugin file");
    if (files.has(path)) throw new Error(`duplicate managed plugin file: ${path}`);
    if ((entry.size ?? 0) > MAX_FILE_BYTES) throw new Error(`managed plugin file is too large: ${path}`);
    const body = await readBlob(repository, entry, readJson);
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_FILE_BYTES) throw new Error(`managed plugin file is too large: ${path}`);
    if (containsSecret(body)) throw new Error(`managed plugin file contains protected-value material: ${path}`);
    files.set(path, Object.freeze({ path, body, digest: sha256(body), bytes }));
    if (files.size > MAX_FILES || [...files.values()].reduce((total, file) => total + file.bytes, 0) > MAX_TOTAL_BYTES) {
      throw new Error("managed plugin package exceeds its bounded content limit");
    }
  };

  for (const entry of selected) {
    if (entry.type === "tree") continue;
    const destination = posix.relative(sourcePath, entry.path);
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new Error(`managed plugin submodules are not supported: ${entry.path}`);
    }
    if (entry.mode !== "120000") {
      await addBlob(entry, destination);
      continue;
    }
    const targetText = (await readBlob(repository, entry, readJson)).trim();
    if (!targetText || targetText.length > 512 || targetText.includes("\0") || posix.isAbsolute(targetText)) {
      throw new Error(`invalid managed plugin symlink: ${entry.path}`);
    }
    const targetPath = posix.normalize(posix.join(posix.dirname(entry.path), targetText));
    normalizeRelativePath(targetPath, "managed plugin symlink target");
    const target = byPath.get(targetPath);
    if (!target) throw new Error(`unresolved managed plugin symlink: ${entry.path}`);
    if (target.type === "blob") {
      if (target.mode === "120000") throw new Error(`nested managed plugin symlink: ${target.path}`);
      await addBlob(target, destination);
      continue;
    }
    if (target.type !== "tree") throw new Error(`unsupported managed plugin symlink target: ${target.path}`);
    const linked = tree.filter((candidate) => candidate.path.startsWith(`${targetPath}/`));
    for (const candidate of linked) {
      if (candidate.type === "tree") continue;
      if (candidate.mode === "120000" || candidate.type === "commit") {
        throw new Error(`nested managed plugin link or submodule: ${candidate.path}`);
      }
      await addBlob(candidate, posix.join(destination, posix.relative(targetPath, candidate.path)));
    }
  }
  return files;
}

async function includeLicense(
  repository: string,
  tree: readonly GithubTreeEntry[],
  files: Map<string, ManagedPluginFile>,
  readJson: GithubJsonReader,
): Promise<void> {
  const source = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]
    .map((name) => tree.find((entry) => entry.path === name && entry.type === "blob" && entry.mode === "100644"))
    .find((entry) => entry !== undefined);
  if (!source) return;
  const body = await readBlob(repository, source, readJson);
  if (containsSecret(body)) throw new Error("managed plugin license contains protected-value material");
  const path = "_SOURCE_LICENSE";
  files.set(path, Object.freeze({ path, body, digest: sha256(body), bytes: Buffer.byteLength(body) }));
}

async function readBlob(
  repository: string,
  entry: GithubTreeEntry,
  readJson: GithubJsonReader,
): Promise<string> {
  const response = object(
    await readJson(`repos/${repository}/git/blobs/${entry.sha}`, Math.min(MAX_FILE_BYTES * 2, (entry.size ?? 0) * 2 + 4096)),
    `blob ${entry.path}`,
  );
  if (response.encoding !== "base64" || typeof response.content !== "string") {
    throw new Error(`GitHub returned an unsupported blob encoding: ${entry.path}`);
  }
  const bytes = Buffer.from(response.content.replaceAll(/\s/gu, ""), "base64");
  if (entry.size !== undefined && bytes.length !== entry.size) throw new Error(`GitHub blob size changed: ${entry.path}`);
  if (bytes.includes(0)) throw new Error(`managed plugin binary file is unsupported: ${entry.path}`);
  const body = bytes.toString("utf8");
  if (!Buffer.from(body, "utf8").equals(bytes)) throw new Error(`managed plugin file is not UTF-8: ${entry.path}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/u.test(body)) {
    throw new Error(`managed plugin file contains terminal controls: ${entry.path}`);
  }
  return body;
}

function autoDetectSkillRoot(tree: readonly GithubTreeEntry[]): string {
  const candidates = tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith("/SKILL.md"))
    .map((entry) => posix.dirname(entry.path));
  const codex = candidates.filter((path) => /^codex\/skills\/[^/]+$/u.test(path));
  const ordinary = candidates.filter((path) => /^skills\/[^/]+$/u.test(path));
  const preferred = codex.length > 0 ? codex : ordinary;
  if (preferred.length === 1) return preferred[0]!;
  if (preferred.length === 0) throw new Error("no compatible SKILL.md root was found");
  throw new Error(`multiple compatible skills found; choose path: ${preferred.slice(0, 8).join(", ")}`);
}

function parseTreeEntry(value: unknown): GithubTreeEntry {
  const entry = object(value, "tree entry");
  const path = normalizeRelativePath(string(entry.path, "tree path", 1024), "tree path");
  const mode = string(entry.mode, "tree mode", 6);
  const type = entry.type;
  if (type !== "blob" && type !== "tree" && type !== "commit") throw new Error("invalid GitHub tree entry type");
  const sha = string(entry.sha, "tree sha", 40);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("invalid GitHub tree entry sha");
  const size = entry.size;
  if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 0)) {
    throw new Error("invalid GitHub tree entry size");
  }
  return { path, mode, type, sha, ...(typeof size === "number" ? { size } : {}) };
}

function parseSkillFrontmatter(body: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(body);
  if (!match) throw new Error("managed plugin SKILL.md needs YAML frontmatter");
  const name = /^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/mu.exec(match[1]!)?.[1]?.trim() ?? "";
  const description = /^description:\s*['"]?([^\r\n]+?)['"]?\s*$/mu.exec(match[1]!)?.[1]?.trim() ?? "";
  if (!SKILL_ID.test(name)) throw new Error("managed plugin SKILL.md has an invalid name");
  if (!description || Buffer.byteLength(description) > 2048 || containsSecret(description)) {
    throw new Error("managed plugin SKILL.md has an invalid description");
  }
  return { name, description };
}

function referencedFiles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/(?:`|\()((?:references|assets)\/[A-Za-z0-9._/-]+)(?:`|\))/gu)) {
    try {
      found.add(normalizeRelativePath(match[1]!, "skill reference"));
    } catch {
      // An unsafe external instruction never becomes an installed dependency.
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeRepository(value: string): string {
  const repository = value.trim();
  const name = repository.slice(repository.indexOf("/") + 1);
  if (!REPOSITORY.test(repository) || name === "." || name === "..") {
    throw new Error("invalid managed plugin repository");
  }
  return repository;
}

export function normalizeRelativePath(value: string, label: string): string {
  if (!value || value.length > 1024 || value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) {
    throw new Error(`invalid ${label}`);
  }
  const normalized = posix.normalize(value.replace(/^\.\//u, "").replace(/\/+$/u, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value.replace(/^\.\//u, "").replace(/\/+$/u, "")) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!plainObject(value)) throw new Error(`invalid ${label}`);
  return value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || /[\0\r\n]/u.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
