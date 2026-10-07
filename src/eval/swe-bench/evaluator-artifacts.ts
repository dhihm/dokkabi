import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", ".venv", "node_modules"]);
const EVALUATOR_CACHE_DIRECTORIES = new Set([".pytest_cache", "__pycache__"]);

export interface EvaluatorArtifactScrubResult {
  readonly removedDirectories: number;
  readonly removedFiles: number;
}

export function scrubEvaluatorArtifacts(workspace: string): EvaluatorArtifactScrubResult {
  let removedDirectories = 0;
  let removedFiles = 0;

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (EVALUATOR_CACHE_DIRECTORIES.has(entry.name)) {
          rmSync(path, { recursive: true, force: true });
          removedDirectories += 1;
          continue;
        }
        visit(path);
        continue;
      }
      if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
        rmSync(path, { force: true });
        removedFiles += 1;
      }
    }
  }

  visit(workspace);
  return { removedDirectories, removedFiles };
}
