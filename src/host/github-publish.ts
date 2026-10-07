import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { containsSecret } from "./redact.ts";
import { WorkspacePathAnchor } from "./workspace-path.ts";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 200;
const TARGET_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const BRANCH_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,255}$/u;
const SAFE_SHA = /^[A-Za-z0-9_-]{1,64}$/u;
const PROTECTED_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
]);

export interface GithubPublishFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface GithubPublishSnapshot {
  readonly sourcePath: string;
  readonly files: readonly GithubPublishFile[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly treeDigest: string;
}

export interface GithubPublishRunnerInput {
  readonly target: string;
  readonly snapshot: GithubPublishSnapshot;
  readonly message: string;
}

export interface GithubPublishRunnerResult {
  readonly status: number;
  readonly commitSha?: string;
  readonly branch?: string;
}

export type GithubPublishRunner = (
  input: GithubPublishRunnerInput,
) => Promise<GithubPublishRunnerResult>;

export interface GithubApiRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly endpoint: string;
  readonly input?: string;
}

export interface GithubApiResponse {
  readonly status: number;
  readonly body: string;
}

export type GithubApiRunner = (request: GithubApiRequest) => Promise<GithubApiResponse>;

/** Capture a text-only directory through the fd-anchored workspace boundary. */
export function captureGithubPublishTree(input: {
  readonly workspaceRoot: string;
  readonly sourcePath: string;
}): GithubPublishSnapshot {
  const sourcePath = input.sourcePath.trim().replaceAll("\\", "/").replace(/\/$/u, "");
  if (!sourcePath || sourcePath === "." || containsSecret(sourcePath)) {
    throw new Error("GitHub publish requires one relative workspace subdirectory");
  }
  const anchor = new WorkspacePathAnchor(input.workspaceRoot);
  try {
    anchor.assertDirectory(sourcePath);
    const paths: string[] = [];
    collectFiles(anchor, sourcePath, sourcePath, paths, new Set<string>());
    paths.sort();
    if (paths.length === 0) throw new Error("GitHub publish source directory has no safe regular files");
    if (paths.length > MAX_FILES) throw new Error(`GitHub publish exceeds the ${MAX_FILES}-file limit`);

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const files: GithubPublishFile[] = [];
    let totalBytes = 0;
    const digest = createHash("sha256");
    for (const workspacePath of paths) {
      const relativePath = workspacePath.slice(sourcePath.length + 1);
      if (containsSecret(relativePath)) {
        throw new Error(`GitHub publish refused secret-shaped filename: ${relativePath}`);
      }
      if (protectedFilename(relativePath)) {
        throw new Error(`GitHub publish refused protected filename: ${relativePath}`);
      }
      const bytes = anchor.readFile(workspacePath);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error(`GitHub publish file exceeds the ${MAX_FILE_BYTES}-byte limit: ${relativePath}`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`GitHub publish exceeds the ${MAX_TOTAL_BYTES}-byte total limit`);
      }
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new Error(`GitHub publish accepts UTF-8 text files only: ${relativePath}`);
      }
      if (containsSecret(text)) {
        throw new Error(`GitHub publish refused secret-shaped content: ${relativePath}`);
      }
      const content = Uint8Array.from(bytes);
      const contentDigest = createHash("sha256").update(content).digest("hex");
      digest.update(relativePath).update("\0").update(contentDigest).update("\0");
      files.push({ path: relativePath, content });
    }
    return {
      sourcePath,
      files,
      fileCount: files.length,
      totalBytes,
      treeDigest: digest.digest("hex"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub publish")) throw error;
    throw new Error(`GitHub publish source is outside the safe workspace boundary: ${sourcePath}`);
  } finally {
    anchor.close();
  }
}

/** Build one additive Git Data API commit. Existing remote paths absent from
 * the local snapshot remain because the current tree is supplied as base_tree. */
export async function publishGithubTreeWithApi(input: {
  readonly target: string;
  readonly snapshot: GithubPublishSnapshot;
  readonly message: string;
  readonly api?: GithubApiRunner;
}): Promise<GithubPublishRunnerResult> {
  if (!validTarget(input.target)) return { status: 2 };
  if (
    !input.message.trim()
    || Buffer.byteLength(input.message) > MAX_MESSAGE_BYTES
    || containsSecret(input.message)
  ) return { status: 2 };
  const api = input.api ?? defaultGithubApiRunner;
  const repository = await api({ method: "GET", endpoint: `repos/${input.target}` });
  if (repository.status !== 0) return { status: repository.status };
  const metadata = jsonObject(repository.body);
  if (metadata?.private !== true) return { status: 3 };
  const branch = typeof metadata.default_branch === "string" ? metadata.default_branch : "";
  if (!BRANCH_PATTERN.test(branch)) return { status: 4 };
  const ref = await api({
    method: "GET",
    endpoint: `repos/${input.target}/git/ref/heads/${encodeURIComponent(branch)}`,
  });
  const branchless = ref.status !== 0
    && metadata.size === 0
    && githubHttpStatus(ref.body) === 409;
  if (ref.status !== 0 && !branchless) return { status: ref.status };

  let headSha: string | undefined;
  let baseTree: string | undefined;
  let files = [...input.snapshot.files];
  if (branchless) {
    const initial = files.shift();
    if (!initial) return { status: 4 };
    const initialized = await api({
      method: "PUT",
      endpoint: `repos/${input.target}/contents/${encodeRepositoryPath(initial.path)}`,
      input: JSON.stringify({
        message: "Initialize repository for workspace publishing",
        content: Buffer.from(initial.content).toString("base64"),
      }),
    });
    if (initialized.status !== 0) return { status: initialized.status };
    headSha = nestedString(jsonObject(initialized.body), "commit", "sha");
    if (!headSha || !SAFE_SHA.test(headSha)) return { status: 4 };
    if (files.length === 0) return { status: 0, commitSha: headSha, branch };
    const commit = await api({
      method: "GET",
      endpoint: `repos/${input.target}/git/commits/${headSha}`,
    });
    if (commit.status !== 0) return { status: commit.status };
    baseTree = nestedString(jsonObject(commit.body), "tree", "sha");
    if (!baseTree || !SAFE_SHA.test(baseTree)) return { status: 4 };
  } else {
    headSha = nestedString(jsonObject(ref.body), "object", "sha");
    if (!headSha || !SAFE_SHA.test(headSha)) return { status: 4 };
    const commit = await api({
      method: "GET",
      endpoint: `repos/${input.target}/git/commits/${headSha}`,
    });
    if (commit.status !== 0) return { status: commit.status };
    baseTree = nestedString(jsonObject(commit.body), "tree", "sha");
    if (!baseTree || !SAFE_SHA.test(baseTree)) return { status: 4 };
  }

  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of files) {
    const blob = await api({
      method: "POST",
      endpoint: `repos/${input.target}/git/blobs`,
      input: JSON.stringify({
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
      }),
    });
    if (blob.status !== 0) return { status: blob.status };
    const sha = stringField(jsonObject(blob.body), "sha");
    if (!sha || !SAFE_SHA.test(sha)) return { status: 4 };
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha });
  }

  const tree = await api({
    method: "POST",
    endpoint: `repos/${input.target}/git/trees`,
    input: JSON.stringify({ ...(baseTree ? { base_tree: baseTree } : {}), tree: treeEntries }),
  });
  if (tree.status !== 0) return { status: tree.status };
  const treeSha = stringField(jsonObject(tree.body), "sha");
  if (!treeSha || !SAFE_SHA.test(treeSha)) return { status: 4 };

  const commit = await api({
    method: "POST",
    endpoint: `repos/${input.target}/git/commits`,
    input: JSON.stringify({
      message: input.message,
      tree: treeSha,
      parents: headSha ? [headSha] : [],
    }),
  });
  if (commit.status !== 0) return { status: commit.status };
  const commitSha = stringField(jsonObject(commit.body), "sha");
  if (!commitSha || !SAFE_SHA.test(commitSha)) return { status: 4 };

  const update = await api({
    method: "PATCH",
    endpoint: `repos/${input.target}/git/refs/heads/${encodeURIComponent(branch)}`,
    input: JSON.stringify({ sha: commitSha, force: false }),
  });
  return update.status === 0
    ? { status: 0, commitSha, branch }
    : { status: update.status };
}

export const defaultGithubPublishRunner: GithubPublishRunner = async (input) =>
  publishGithubTreeWithApi(input);

function collectFiles(
  anchor: WorkspacePathAnchor,
  directory: string,
  sourceRoot: string,
  paths: string[],
  visited: Set<string>,
): void {
  for (const entry of anchor.list(directory).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === ".git") continue;
    const path = `${directory}/${entry.name}`;
    if (entry.kind === "directory") {
      if (visited.has(entry.identity)) continue;
      visited.add(entry.identity);
      collectFiles(anchor, path, sourceRoot, paths, visited);
    } else if (entry.kind === "file") {
      paths.push(path);
      if (paths.length > MAX_FILES) throw new Error(`GitHub publish exceeds the ${MAX_FILES}-file limit`);
    }
  }
}

function protectedFilename(path: string): boolean {
  const name = basename(path).toLowerCase();
  return PROTECTED_FILENAMES.has(name)
    || name.endsWith(".pem")
    || name.endsWith(".key")
    || name.startsWith(".env.");
}

function validTarget(target: string): boolean {
  if (!TARGET_PATTERN.test(target) || containsSecret(target)) return false;
  const repo = target.slice(target.indexOf("/") + 1);
  return repo !== "." && repo !== "..";
}

function encodeRepositoryPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function jsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function githubHttpStatus(body: string): number | undefined {
  const status = jsonObject(body)?.status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  if (typeof status === "string" && /^\d{3}$/u.test(status)) return Number(status);
  return undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function nestedString(
  value: Record<string, unknown> | undefined,
  parent: string,
  key: string,
): string | undefined {
  const nested = value?.[parent];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? stringField(nested as Record<string, unknown>, key)
    : undefined;
}

const defaultGithubApiRunner: GithubApiRunner = async (request) => {
  const args = ["api", request.endpoint];
  if (request.method !== "GET") args.push("--method", request.method, "--input", "-");
  // gh starts outside every workspace (S2, D57e): nothing it asks git about
  // a current repository can read a tree's configuration.
  const result = spawnSync("gh", args, {
    cwd: "/",
    encoding: "utf8",
    env: process.env,
    input: request.input,
    maxBuffer: 2_000_000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { status: result.status ?? -1, body: result.stdout ?? "" };
};
