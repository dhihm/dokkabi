import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerRunnerSpec } from "./case-runners.ts";
import { validateRunnerSpec } from "./runner-spec.ts";

export interface LoadedRunner {
  id: string;
  source: "workspace" | "home";
  file: string;
}

export interface RunnerLoadResult {
  /** Specs newly registered by THIS sweep (content-addressed; reloads are silent). */
  registered: LoadedRunner[];
  /** Malformed files as concrete, feedable errors: "<file>: <reason>". */
  errors: string[];
}

// Content digests already accepted this process — a sweep after every model
// turn must stay cheap and must not re-announce unchanged specs.
const seen = new Set<string>();

/**
 * Register case-runner specs from disk. Two sources, in override order:
 *
 * 1. `<homeDir>/runners/*.json` — operator-installed, skill-style.
 * 2. `<workspaceRoot>/work/runners/*.json` — model-written during decompose
 *    (work/ is writable in that phase); the model's spec wins on id conflict.
 *
 * This is the autonomy path for an unknown ecosystem: instead of a dead-end
 * refusal, the model authors a declarative spec and the same seal judges it.
 * The caller logs every accepted spec as an observe event.
 */
export function loadRunnerSpecs(input: {
  workspaceRoot: string;
  homeDir?: string;
}): RunnerLoadResult {
  const registered: LoadedRunner[] = [];
  const errors: string[] = [];
  const sources: Array<{ dir: string; source: LoadedRunner["source"] }> = [
    ...(input.homeDir ? [{ dir: join(input.homeDir, "runners"), source: "home" as const }] : []),
    { dir: join(input.workspaceRoot, "work", "runners"), source: "workspace" as const },
  ];
  for (const { dir, source } of sources) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
      const file = join(dir, name);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        errors.push(`${name}: unreadable (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      const digest = createHash("sha256").update(text).digest("hex");
      if (seen.has(digest)) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        errors.push(`${name}: not valid JSON — a runner spec is one JSON object`);
        continue;
      }
      const { spec, errors: specErrors } = validateRunnerSpec(parsed);
      if (!spec) {
        errors.push(...specErrors.map((reason) => `${name}: ${reason}`));
        continue;
      }
      registerRunnerSpec(spec);
      seen.add(digest);
      registered.push({ id: spec.id, source, file });
    }
  }
  return { registered, errors };
}
