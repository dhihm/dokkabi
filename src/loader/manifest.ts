import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../host/canonical.ts";

const PluginIdSchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/u);
const AssetIdSchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/u);
const RelativePathSchema = z.string().min(1);

const ManifestEntrySchema = z.union([
  z.object({ id: PluginIdSchema, path: RelativePathSchema }).strict(),
  z.object({ id: PluginIdSchema, package: RelativePathSchema }).strict(),
]);

const ManifestSchema = z.object({ plugins: z.array(ManifestEntrySchema) }).strict();

const PromptSchema = z.object({
  id: AssetIdSchema,
  path: RelativePathSchema,
}).strict();

const SkillSchema = z.object({
  id: AssetIdSchema,
  description: z.string().min(1),
  path: RelativePathSchema,
}).strict();

const PackageAssetSchema = z.object({
  id: AssetIdSchema,
  path: RelativePathSchema,
}).strict();

const PackageSchema = z.object({
  schema_version: z.literal(1),
  id: PluginIdSchema,
  module: RelativePathSchema,
  assets: z.array(PackageAssetSchema).default([]),
  prompts: z.array(PromptSchema).default([]),
  skills: z.array(SkillSchema).default([]),
}).strict();

export type ResolvedPrompt = {
  readonly id: string;
  readonly body: string;
  readonly digest: string;
};

export type ResolvedAsset = ResolvedPrompt;

export type ResolvedSkill = ResolvedPrompt & {
  readonly description: string;
};

export type ResolvedPlugin = {
  readonly id: string;
  readonly kind: "module" | "package";
  readonly modulePath: string;
  readonly digest: string;
  readonly snapshot: string;
  readonly assets: readonly ResolvedAsset[];
  readonly prompts: readonly ResolvedPrompt[];
  readonly skills: readonly ResolvedSkill[];
};

export type ResolvedManifest = {
  readonly digest: string;
  readonly plugins: readonly ResolvedPlugin[];
};

export class PluginManifestError extends Error {
  readonly name = "PluginManifestError";

  constructor(readonly source: string, message: string) {
    super(`${source}: ${message}`);
  }
}

export function resolvePluginManifest(manifestPath: string): ResolvedManifest {
  const manifest = parseJson(ManifestSchema, manifestPath);
  assertUnique(manifest.plugins.map((entry) => entry.id), manifestPath, "plugin id");
  const root = dirname(manifestPath);
  const plugins = manifest.plugins.map((entry) =>
    "path" in entry
      ? resolveModule(entry.id, resolve(root, entry.path))
      : resolvePackage(entry.id, packagePath(root, entry.package)),
  );
  const digest = sha256(canonicalJson(plugins.map((plugin) => ({
    id: plugin.id,
    kind: plugin.kind,
    digest: plugin.digest,
  }))));
  return { digest, plugins };
}

function resolveModule(id: string, modulePath: string): ResolvedPlugin {
  const moduleBody = readText(modulePath);
  const snapshot = canonicalJson({ schema_version: 0, id, module: moduleBody });
  return {
    id,
    kind: "module",
    modulePath,
    digest: sha256(snapshot),
    snapshot,
    assets: [],
    prompts: [],
    skills: [],
  };
}

function resolvePackage(id: string, descriptorPath: string): ResolvedPlugin {
  const descriptor = parseJson(PackageSchema, descriptorPath);
  if (descriptor.id !== id) {
    throw new PluginManifestError(descriptorPath, `package id ${descriptor.id} does not match manifest id ${id}`);
  }
  assertUnique(descriptor.prompts.map((asset) => asset.id), descriptorPath, "prompt id");
  assertUnique(descriptor.skills.map((asset) => asset.id), descriptorPath, "skill id");
  assertUnique(descriptor.assets.map((asset) => asset.id), descriptorPath, "asset id");
  const root = dirname(descriptorPath);
  const modulePath = packageFile(root, descriptor.module, "module");
  const moduleBody = readText(modulePath);
  const prompts = descriptor.prompts.map((asset) => readPrompt(root, asset));
  const skills = descriptor.skills.map((asset) => readSkill(root, asset));
  const assets = descriptor.assets.map((asset) => readAsset(root, asset));
  const snapshot = canonicalJson({
    descriptor,
    module: moduleBody,
    assets: assets.map(({ id: assetId, body }) => ({ id: assetId, body })),
    prompts: prompts.map(({ id: assetId, body }) => ({ id: assetId, body })),
    skills: skills.map(({ id: assetId, description, body }) => ({ id: assetId, description, body })),
  });
  return {
    id,
    kind: "package",
    modulePath,
    digest: sha256(snapshot),
    snapshot,
    assets,
    prompts,
    skills,
  };
}

function readAsset(root: string, asset: z.infer<typeof PackageAssetSchema>): ResolvedAsset {
  const body = readText(packageFile(root, asset.path, `asset ${asset.id}`));
  return { id: asset.id, body, digest: sha256(body) };
}

function readPrompt(root: string, asset: z.infer<typeof PromptSchema>): ResolvedPrompt {
  const body = readText(packageFile(root, asset.path, `prompt ${asset.id}`));
  return { id: asset.id, body, digest: sha256(body) };
}

function readSkill(root: string, asset: z.infer<typeof SkillSchema>): ResolvedSkill {
  const body = readText(packageFile(root, asset.path, `skill ${asset.id}`));
  return { id: asset.id, description: asset.description, body, digest: sha256(body) };
}

function packagePath(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new PluginManifestError(path, "package paths must be relative to the manifest");
  }
  return resolve(root, path);
}

function packageFile(root: string, path: string, label: string): string {
  if (isAbsolute(path)) {
    throw new PluginManifestError(path, `${label} path must be relative to its package`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginManifestError(path, `${label} escapes its package root`);
  }
  return absolute;
}

function parseJson<T>(schema: z.ZodType<T>, path: string): T {
  let value: unknown;
  try {
    value = JSON.parse(readText(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PluginManifestError(path, `invalid JSON: ${message}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PluginManifestError(path, z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PluginManifestError(path, message);
  }
}

function assertUnique(values: readonly string[], source: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PluginManifestError(source, `duplicate ${label} ${value}`);
    }
    seen.add(value);
  }
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
