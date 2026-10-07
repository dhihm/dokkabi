import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { evidenceDigest } from "./contract.ts";
import type { EvidenceBodies } from "./projection.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096).refine(value => value === "." || value.split("/").every(part => part && part !== "." && part !== ".." && !/[\\\0\r\n]/u.test(part)));
const mode = z.number().int().min(0).max(0o777);
const mtime_ns = z.string().regex(/^-?(0|[1-9][0-9]*)$/u);
const entry = z.discriminatedUnion("kind", [
  z.object({ path, kind: z.literal("directory"), mode, mtime_ns }).strict(),
  z.object({ path, kind: z.literal("file"), mode, mtime_ns, bytes: z.number().int().nonnegative(), sha256: digest, blob: digest, blob_bytes: z.number().int().positive() }).strict(),
  z.object({ path, kind: z.literal("symlink"), target: z.string().min(1).max(4096) }).strict(),
]);
export const executionImageSchema = z.object({
  schema_version: z.literal(1), workspace: z.string().startsWith("/"),
  base_policy: z.string().regex(/^[a-f0-9]{16}$/u), runtime: digest,
  environment: z.record(z.string(), z.string()),
  private_roots: z.object({ home: z.string().optional(), temp: z.string().optional(), tool_cache: z.string().optional() }).strict().optional(),
  trees: z.array(z.object({ target: z.string().startsWith("/"), entries: z.array(entry).min(1).max(100000) }).strict()).min(1).max(2),
}).strict();
export type ExecutionImage = z.infer<typeof executionImageSchema>;
export type ImageEntry = ExecutionImage["trees"][number]["entries"][number];
export const EXECUTION_VIEW_BODY_EVENTS = new Set(["execution_view/source", "execution_view/image", "execution_view/dispatch", "execution_view/result"]);
const refSchema = z.object({ seq: z.number().int().nonnegative(), hash: digest }).strict();
const dispatchSchema = z.object({
  schema_version: z.literal(1), image: digest, command: z.string().min(1), timeout_ms: z.number().int().positive(),
  policy: z.string().regex(/^[a-f0-9]{16}$/u), base_policy: z.string().regex(/^[a-f0-9]{16}$/u),
  environment: z.record(z.string(), z.string()), runtime: digest,
  resource: z.object({ root: z.string(), owner: digest }).strict(),
  boundary: z.array(z.string()).min(1), mappings: z.array(z.object({ source: z.string(), target: z.string() }).strict()).min(1).max(2),
}).strict();
const processSchema = z.object({
  exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), stdoutBase64: z.string().optional(), stderrBase64: z.string().optional(),
  rawExitCode: z.null().optional(), signal: z.string().optional(), error: z.string().optional(), timedOut: z.literal(true).optional(),
  maxBufferExceeded: z.literal(true).optional(), completionUnavailable: z.literal(true).optional(),
}).strict();
const resultSchema = z.object({ schema_version: z.literal(1), dispatch: refSchema, native: refSchema, process: processSchema, changed: z.boolean() }).strict();
const compositionSchema = z.object({ candidate: digest, checker: digest, paths: z.array(path).min(1), image: digest }).strict();
const observationSchema = z.object({ image: digest, trees_digest: digest, matched: z.boolean() }).strict();

/** An explicit checker closure replaces that closure completely. Everything
 * else, including Git metadata, belongs to the selected candidate image. */
export function composeExecutionImage(candidate: ExecutionImage, checker: ExecutionImage, paths: readonly string[]): ExecutionImage {
  if (candidate.workspace !== checker.workspace || candidate.base_policy !== checker.base_policy
    || candidate.runtime !== checker.runtime || canonicalJson(candidate.environment) !== canonicalJson(checker.environment)
    || canonicalJson(candidate.private_roots) !== canonicalJson(checker.private_roots)
    || canonicalJson(candidate.trees.map(tree => tree.target)) !== canonicalJson(checker.trees.map(tree => tree.target))) throw new Error("execution_image_composition_environment");
  if (!paths.length || paths.some(value => !path.safeParse(value).success || value === "." || value === ".git" || value.startsWith(".git/"))
    || new Set(paths).size !== paths.length) throw new Error("execution_image_composition_paths");
  const selected = (value: string) => paths.some(root => value === root || value.startsWith(root + "/"));
  const entries = new Map(candidate.trees[0]!.entries.filter(row => !selected(row.path)).map(row => [row.path, row]));
  const additions = checker.trees[0]!.entries.filter(row => selected(row.path));
  const source = new Map(checker.trees[0]!.entries.map(row => [row.path, row]));
  for (const row of additions) {
    let parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ".";
    while (!entries.has(parent)) {
      const directory = source.get(parent);
      if (directory?.kind !== "directory") throw new Error("execution_image_composition_parent");
      entries.set(parent, directory);
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : ".";
    }
    if (entries.get(parent)?.kind !== "directory") throw new Error("execution_image_composition_parent");
    entries.set(row.path, row);
  }
  const children = new Map<string, string[]>();
  for (const value of entries.keys()) if (value !== ".") {
    const parent = value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : ".";
    children.set(parent, [...children.get(parent) ?? [], value]);
  }
  const ordered: ImageEntry[] = [];
  const visit = (value: string) => { ordered.push(entries.get(value)!); for (const child of (children.get(value) ?? []).sort()) visit(child); };
  visit(".");
  if (ordered.length !== entries.size) throw new Error("execution_image_composition_parent");
  return validateExecutionImage({ ...candidate, trees: [{ ...candidate.trees[0], entries: ordered }, ...candidate.trees.slice(1)] });
}

export function validateExecutionImage(value: unknown): ExecutionImage {
  const image = executionImageSchema.parse(value);
  if (image.trees[0]!.target !== image.workspace) throw new Error("execution_image_workspace_mismatch");
  const targets = image.trees.map(tree => tree.target);
  const normalized = (value: string) => value.startsWith("/") && value !== "/" && !value.split("/").slice(1).some(p => !p || p === "." || p === ".." || /[\\\0\r\n]/u.test(p));
  if (targets.some(target => !normalized(target)) || targets.some((a, i) => targets.some((b, j) => i !== j && (a === b || a.startsWith(b + "/"))))) throw new Error("execution_image_mapping_overlap");
  for (const tree of image.trees) {
    const entries = new Map<string, ImageEntry>();
    for (const item of tree.entries) {
      if (entries.has(item.path) || (item.path === "." && item.kind !== "directory")) throw new Error("execution_image_path_collision");
      if (item.path !== ".") {
        const parent = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : ".";
        if (entries.get(parent)?.kind !== "directory") throw new Error("execution_image_parent_missing");
      }
      if (item.kind === "symlink" && /[\0\r\n]/u.test(item.target)) throw new Error("execution_image_link_invalid");
      entries.set(item.path, item);
    }
    if (!entries.has(".")) throw new Error("execution_image_root_missing");
  }
  return image;
}

function body(event: EventRecord, bodies: EvidenceBodies): unknown {
  const value = bodies.get(String(event.payload.blob));
  if (value === undefined || evidenceDigest(value) !== event.payload.blob || Buffer.byteLength(canonicalJson(value)) !== event.payload.blob_bytes) throw new Error("execution_view_body_mismatch");
  return value;
}

/** No live files or native processes are consulted when reconstructing a view. */
export function projectExecutionViews(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()) {
  const images: { digest: string; manifest: ExecutionImage }[] = [];
  // This invocation authenticates every body observation. Decoded immutable
  // source identity is reusable across images, not across projection calls.
  const sources = new Map<string, { blobBytes: number; bytes: number; sha256: string }>();
  const dispatches = new Map<number, { event: EventRecord; value: z.infer<typeof dispatchSchema> }>();
  const executions: { seq: number; image: string; completed: boolean; cleaned: boolean }[] = [];
  const references: { seq: number; name: string; digest: string }[] = [];
  for (const event of events) {
    if (!event.name.startsWith("execution_view/")) continue;
    if (event.kind !== "observe") throw new Error("execution_view_event_kind");
    references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(event.payload) });
    if (event.name === "execution_view/source") {
      const value = z.object({ encoding: z.literal("base64"), data: z.string() }).strict().parse(body(event, bodies));
      const key = String(event.payload.blob);
      if (!sources.has(key)) {
        const bytes = Buffer.from(value.data, "base64");
        if (bytes.toString("base64") !== value.data) throw new Error("execution_view_source_encoding");
        sources.set(key, { blobBytes: Buffer.byteLength(canonicalJson(value)), bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    } else if (event.name === "execution_view/image") {
      const manifest = validateExecutionImage(body(event, bodies));
      for (const tree of manifest.trees) for (const file of tree.entries) if (file.kind === "file") {
        const source = sources.get(file.blob);
        if (!source || source.blobBytes !== file.blob_bytes) throw new Error("execution_view_source_missing");
        // File hashes are over bytes, not their canonical base64 envelope.
        if (source.bytes !== file.bytes || source.sha256 !== file.sha256) throw new Error("execution_view_source_changed");
      }
      images.push({ digest: String(event.payload.blob), manifest });
    } else if (event.name === "execution_view/observation") {
      const value = observationSchema.parse(event.payload), image = images.find(row => row.digest === value.image);
      if (!image || value.matched !== (evidenceDigest(image.manifest.trees) === value.trees_digest)) throw new Error("execution_image_observation_binding");
    } else if (event.name === "execution_view/composition") {
      const value = compositionSchema.parse(event.payload);
      const candidate = images.find(row => row.digest === value.candidate), checker = images.find(row => row.digest === value.checker);
      const previous = events.find(row => row.seq === event.seq - 1);
      if (!candidate || !checker || previous?.name !== "execution_view/image" || previous.payload.blob !== value.image
        || evidenceDigest(composeExecutionImage(candidate.manifest, checker.manifest, value.paths)) !== value.image) throw new Error("execution_image_composition_binding");
    } else if (event.name === "execution_view/dispatch") {
      const value = dispatchSchema.parse(body(event, bodies)), image = images.find(row => row.digest === value.image);
      if (!image || value.base_policy !== image.manifest.base_policy || value.runtime !== image.manifest.runtime || canonicalJson(value.environment) !== canonicalJson(image.manifest.environment) ||
        canonicalJson(value.mappings.map(row => row.target)) !== canonicalJson(image.manifest.trees.map(row => row.target))) throw new Error("execution_view_dispatch_binding");
      for (const [ordinal, mapping] of value.mappings.entries()) if (mapping.source !== value.resource.root + "/" + ordinal || !value.boundary.some((arg, i) => ["--bind", "--ro-bind"].includes(arg) && value.boundary[i + 1] === mapping.source && value.boundary[i + 2] === mapping.target)) throw new Error("execution_view_boundary_mapping");
      for (const [key, val] of Object.entries(value.environment)) if (!value.boundary.some((arg, i) => arg === "--setenv" && value.boundary[i + 1] === key && value.boundary[i + 2] === val)) throw new Error("execution_view_boundary_environment");
      if (!value.boundary.includes("--clearenv") || !value.boundary.some((arg, i) => arg === "--chdir" && value.boundary[i + 1] === image.manifest.workspace)) throw new Error("execution_view_boundary_cwd");
      dispatches.set(event.seq, { event, value });
      executions.push({ seq: event.seq, image: value.image, completed: false, cleaned: false });
    } else if (event.name === "execution_view/result") {
      const value = resultSchema.parse(body(event, bodies)), start = dispatches.get(value.dispatch.seq);
      const native = events.find(row => row.seq === value.native.seq);
      if (!start || start.event.hash !== value.dispatch.hash || !native || native.hash !== value.native.hash || native.name !== "sandbox/exec" || native.kind !== "effect" ||
        native.seq <= start.event.seq || native.seq >= event.seq || native.payload.digest !== start.value.policy ||
        native.payload.command_digest !== createHash("sha256").update(start.value.command).digest("hex")) throw new Error("execution_view_native_binding");
      const execution = executions.find(row => row.seq === start.event.seq)!;
      if (execution.completed || execution.cleaned) throw new Error("execution_view_duplicate_result");
      execution.completed = true;
    } else if (event.name === "execution_view/cleanup") {
      const ref = refSchema.parse(event.payload.dispatch), start = dispatches.get(ref.seq);
      if (!start || start.event.hash !== ref.hash || event.payload.status !== "removed") throw new Error("execution_view_cleanup_binding");
      const execution = executions.find(row => row.seq === ref.seq)!;
      if (execution.cleaned) throw new Error("execution_view_duplicate_cleanup");
      execution.cleaned = true;
    } else if (event.name === "execution_view/refused") {
      if (typeof event.payload.reason !== "string" || !/^[a-z][a-z0-9_]{1,100}$/u.test(event.payload.reason)) throw new Error("execution_view_refusal_invalid");
    } else throw new Error("execution_view_unknown_event");
  }
  return { images, executions, references };
}
