import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { durableResearchFile, researchContains, researchHash } from "./environment.ts";

type FileRow = { path: string; sha256: string; bytes: number; mode: "regular" | "executable" | "symlink" };
export type ComparatorArtifactCapture = { workspace: string; root: string; git: string; base_tree: string };
function git(capture: Omit<ComparatorArtifactCapture, "base_tree">, args: string[], input?: Buffer): Buffer {
  return execFileSync(capture.git, ["--git-dir", join(capture.root, "git"), ...(args[0] === "init" ? [] : ["--work-tree", join(capture.root, "snapshot")]),
    "-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", "core.attributesfile=/dev/null", "-c", "core.hooksPath=/dev/null", ...args],
  { env: { PATH: "/usr/bin:/bin", HOME: capture.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    input, maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
}
/** Directories that are the workspace's ENVIRONMENT or its generated caches,
 * never the candidate's work: version control internals, dependency installs,
 * tool caches and virtual environments. Capturing them would spend the 256 MB
 * / 100000-file backstop on files the deliverable filter drops downstream, and
 * would diff the environment rather than the model's edits. A directory name
 * alone never excludes a model-authored source dir; membership in this fixed
 * set or the pyvenv.cfg marker below is the only ground for exclusion. */
const EXCLUDED_ARTIFACT_DIRS = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".tox", ".nox", ".hypothesis", ".venv", "venv", ".eggs"]);
export function isExcludedArtifactDir(dirEntryName: string, absPath: string): boolean {
  if (EXCLUDED_ARTIFACT_DIRS.has(dirEntryName)) return true;
  if (dirEntryName.endsWith(".egg-info") || dirEntryName.endsWith(".dist-info")) return true;
  // A Python virtual environment under any other name is identified by the
  // pyvenv.cfg marker it directly contains, not by what it is called.
  return existsSync(join(absPath, "pyvenv.cfg"));
}
function snapshot(capture: Omit<ComparatorArtifactCapture, "base_tree">): FileRow[] {
  const target = join(capture.root, "snapshot");
  rmSync(target, { recursive: true, force: true }); mkdirSync(target);
  const files: FileRow[] = []; let total = 0;
  const walk = (source: string, destination: string, prefix: string) => {
    for (const name of readdirSync(source).sort()) {
      if (name === ".git") continue;
      const path = prefix ? `${prefix}/${name}` : name, from = join(source, name), to = join(destination, name), stat = lstatSync(from);
      if (stat.isDirectory()) { if (isExcludedArtifactDir(name, from)) continue; mkdirSync(to); walk(from, to, path); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("unsupported candidate file type");
      const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(from)) : readFileSync(from);
      total += bytes.length;
      if (total > 256 * 1024 * 1024 || files.length >= 100000) throw new Error("candidate artifact exceeds capture boundary");
      if (stat.isSymbolicLink()) symlinkSync(bytes.toString("utf8"), to);
      else { durableResearchFile(to, bytes); if (stat.mode & 0o111) chmodSync(to, 0o700); }
      files.push({ path, sha256: researchHash(bytes), bytes: bytes.length, mode: stat.isSymbolicLink() ? "symlink" : stat.mode & 0o111 ? "executable" : "regular" });
    }
  };
  walk(capture.workspace, target, "");
  git(capture, ["read-tree", "--empty"]);
  const entries: string[] = [];
  const regular = files.filter(row => row.mode !== "symlink");
  for (let index = 0; index < regular.length; index += 256) {
    const batch = regular.slice(index, index + 256);
    const hashes = git(capture, ["hash-object", "-w", "--no-filters", "--", ...batch.map(row => join(target, row.path))]).toString("utf8").trim().split("\n");
    if (hashes.length !== batch.length) throw new Error("artifact hash count mismatch");
    batch.forEach((row, i) => entries.push(`${row.mode === "executable" ? "100755" : "100644"} ${hashes[i]}\t${row.path}\0`));
  }
  for (const row of files.filter(row => row.mode === "symlink")) {
    const hash = git(capture, ["hash-object", "-w", "--stdin"], Buffer.from(readlinkSync(join(target, row.path)))).toString("utf8").trim();
    entries.push(`120000 ${hash}\t${row.path}\0`);
  }
  git(capture, ["update-index", "-z", "--index-info"], Buffer.from(entries.join("")));
  return files;
}
/** The baseline index lives outside candidate Git. Candidate commits, staging,
 * ignores, diff drivers and hooks cannot redefine the captured comparison. */
export function beginComparatorArtifact(workspace: string, controlRoot: string, gitExecutable: string): ComparatorArtifactCapture {
  const root = join(realpathSync(controlRoot), "candidate-artifact"), candidate = realpathSync(workspace);
  if (!isAbsolute(gitExecutable) || researchContains(candidate, root)) throw new Error("artifact control must be outside the workspace");
  mkdirSync(root, { mode: 0o700 });
  const capture = { workspace: candidate, root, git: gitExecutable };
  mkdirSync(join(root, "snapshot"));
  git(capture, ["init", "--bare", "--quiet", join(root, "git")]);
  const files = snapshot(capture), base_tree = git(capture, ["write-tree"]).toString("utf8").trim();
  durableResearchFile(join(root, "baseline.json"), JSON.stringify({ base_tree, files }) + "\n");
  return { ...capture, base_tree };
}
export function freezeComparatorArtifact(capture: ComparatorArtifactCapture) {
  durableResearchFile(join(capture.root, "freeze.started"), "one final freeze\n");
  const files = snapshot(capture), final_tree = git(capture, ["write-tree"]).toString("utf8").trim();
  const bytes = git(capture, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", capture.base_tree, final_tree, "--"]);
  const path = join(capture.root, "final.patch"); durableResearchFile(path, bytes);
  const result = { base_tree: capture.base_tree, final_tree, patch: { path, sha256: researchHash(bytes), bytes: bytes.length }, files };
  durableResearchFile(join(capture.root, "final.json"), JSON.stringify(result) + "\n");
  return result;
}
