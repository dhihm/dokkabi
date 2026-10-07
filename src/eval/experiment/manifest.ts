import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../host/canonical.ts";
import { manifestSchema, type ExperimentManifest, type ScheduledRun } from "./schema.ts";

export const sourceDigest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function requireUnique(values: readonly (string | number)[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${name}`);
}
/** Sealing this exact file before dispatch is the caller's responsibility.
 * The later inventory binds its bytes; results never mutate the schedule. */
export function expandExperimentManifest(input: unknown): { manifest: ExperimentManifest; scheduled: ScheduledRun[] } {
  const manifest = manifestSchema.parse(input);
  requireUnique(manifest.tasks.map(row => row.id), "task");
  requireUnique(manifest.conditions.map(row => row.id), "condition");
  requireUnique(manifest.replicates, "replicate");
  requireUnique(manifest.sources.map(row => row.id), "manifest source");
  const size = manifest.tasks.length * manifest.conditions.length * manifest.replicates.length;
  if (size > 1000000) throw new Error("schedule exceeds one million rows");
  for (const task of manifest.tasks) for (const [field, kind] of [["scope", "scope"], ["oracle", "oracle_definition"], ["rubric", "rubric"]] as const) {
    if (!manifest.sources.some(source => source.id === task[field] && source.kind === kind)) throw new Error(`task ${field} source is not predeclared`);
  }
  const scheduled: ScheduledRun[] = [];
  for (const task of manifest.tasks) for (const condition of manifest.conditions) for (const replicate of manifest.replicates) {
    scheduled.push({ key: sourceDigest(canonicalJson([manifest.study_id, manifest.study_version, task.id, condition.id, replicate])),
      task: task.id, condition: condition.id, replicate, system: condition.system, scope: task.scope, oracle: task.oracle, rubric: task.rubric });
  }
  return { manifest, scheduled: scheduled.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) };
}

/** Refuse symlinks in every component and bind a regular file's exact bytes.
 * This is bundle containment, not a substitute for an external checkpoint. */
export function readBundleFile(root: string, path: string): { path: string; bytes: Buffer } {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("unsafe source path");
  const canonicalRoot = realpathSync(root);
  let current = canonicalRoot;
  for (const [index, part] of path.split("/").entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < path.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("source must be a contained regular file");
    if (index === path.split("/").length - 1 && stat.size > 256 * 1024 * 1024) throw new Error("source exceeds 256 MiB per-file limit");
  }
  const bytes = readFileSync(current);
  if (realpathSync(current) !== resolve(canonicalRoot, path)) throw new Error("source changed containment");
  return { path: current, bytes };
}
