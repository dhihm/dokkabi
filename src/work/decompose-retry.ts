import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { HOST_EXCLUDED_NAMES } from "../host/coverage.ts";

/**
 * Decompose retry budget: how many refusal-feedback turns a decompose may
 * burn before the host falls back. A CHANGED refusal means the model is
 * moving (file missing → nested structure → …) and earns another turn; the
 * SAME refusal twice means more turns will not change it. The fourth
 * sk-13241 envfix run burned its single retry on "file missing" and the
 * nested-structure lesson never reached the model.
 */
export interface DecomposeRetryState {
  attemptsLeft: number;
  lastKey: string | undefined;
}

export function decomposeRetryState(maxRetries = 2): DecomposeRetryState {
  return { attemptsLeft: maxRetries, lastKey: undefined };
}

/** True when another retry turn should run for these refusal errors. */
export function takeDecomposeRetry(
  state: DecomposeRetryState,
  errors: readonly string[],
  progressKey = "",
): boolean {
  if (errors.length === 0 || state.attemptsLeft <= 0) {
    return false;
  }
  const key = `${errors.join("\n")}\0${progressKey}`;
  if (state.lastKey === key) {
    return false;
  }
  state.lastKey = key;
  state.attemptsLeft -= 1;
  return true;
}

/** Consecutive identical refusal sets, not total attempts or invented progress. */
export interface DecomposeRefusalProgress {
  readonly key: string;
  readonly attempts: number;
}

export function recordDecomposeRefusal(previous: DecomposeRefusalProgress | undefined, errors: readonly string[]): DecomposeRefusalProgress {
  const key = JSON.stringify(errors);
  return { key, attempts: previous?.key === key ? previous.attempts + 1 : 1 };
}

/**
 * Digest only model-writable planning artifacts: every file and link below
 * `tests/` and `work/` (and `work/current.json`, which a live plan keeps
 * ignored), read by the host's own walk — never through a link, the fixed
 * host exclusions skipped — never by a git process: a git on the tree reads
 * the tree's configuration, which the session writes (S2, D57e). The digest
 * never enters the model prompt and exposes neither file contents nor
 * private path components.
 */
export function planningArtifactFingerprint(cwd: string): string {
  const digest = createHash("sha256");
  const excluded = new Set(HOST_EXCLUDED_NAMES);
  const visit = (rel: string, depth: number) => {
    const absolute = resolve(cwd, rel);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      digest.update(rel).update("\0<missing>\0");
      return;
    }
    if (stat.isSymbolicLink()) {
      digest.update(rel).update("\0<symlink>").update(readlinkSync(absolute)).update("\0");
    } else if (stat.isFile()) {
      digest.update(rel).update("\0").update(readFileSync(absolute)).update("\0");
    } else if (stat.isDirectory() && depth < 64) {
      let names: string[];
      try {
        names = readdirSync(absolute).sort();
      } catch {
        digest.update(rel).update("\0<unreadable>\0");
        return;
      }
      for (const name of names) if (!excluded.has(name)) visit(`${rel}/${name}`, depth + 1);
    } else {
      digest.update(rel).update("\0<non-file>\0");
    }
  };
  for (const top of ["tests", "work"]) visit(top, 0);
  if (!existsSync(resolve(cwd, "work"))) visit("work/current.json", 0);
  return digest.digest("hex");
}
