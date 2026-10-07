import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { containsPrivateInfrastructure, containsSecret, redactText } from "../../host/redact.ts";
import { publishArchiveDirectory } from "../../host/safe-archive.ts";
import { artifactJson, assertExternalArtifact, withAnchoredResearch, type ResearchArchivePlan, type ResearchCheckpoint } from "./archive.ts";
import { durableResearchFile, researchHash, researchRead } from "./environment.ts";

const reasons = z.enum(["credential", "private-log", "private-path", "license", "unsupported-binary", "not-selected"]);
const publicPath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u).refine(value => !value.split("/").some(part => !part || part === "." || part === "..")
  && !/(?:^|\/)(?:auth\.json|\.env[^/]*|id_rsa|id_ed25519|[^/]*\.(?:pem|key|jsonl))$/iu.test(value));
const rule = z.discriminatedUnion("action", [
  z.strictObject({ artifact: z.string(), action: z.literal("copy"), path: publicPath }),
  z.strictObject({ artifact: z.string(), action: z.literal("sanitize"), path: publicPath }),
  z.strictObject({ artifact: z.string(), action: z.literal("withhold"), reason: reasons }),
]);
export const researchReleasePolicySchema = z.strictObject({ schema_version: z.literal(1), namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  rules: z.array(rule), replacements: z.array(z.strictObject({ literal: z.string().min(1), replacement: z.string() })) });
export type ResearchReleasePolicy = z.infer<typeof researchReleasePolicySchema>;
const utf8 = (body: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(body);
export function researchPublicId(namespace: string, id: string): string { return "artifact-" + researchHash(artifactJson([namespace, id])).slice(0, 24); }
function safeText(text: string): void {
  if (containsSecret(text) || containsPrivateInfrastructure(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error("public candidate contains protected or non-text content");
}
type Snapshot = { plan: ResearchArchivePlan; checkpoint: ResearchCheckpoint; files: Map<string, Buffer> };
function derive(snapshot: Snapshot, policy: ResearchReleasePolicy) {
  const rules = new Map(policy.rules.map(row => [row.artifact, row]));
  if (rules.size !== policy.rules.length || rules.size !== snapshot.plan.artifacts.length
    || snapshot.plan.artifacts.some(row => !rules.has(row.id))) throw new Error("release policy must select or withhold every artifact exactly once");
  const files = new Map<string, Buffer>(), executable = new Set<string>(), entries: Record<string, unknown>[] = [], bridge: Record<string, unknown>[] = [];
  const substitutions = [...policy.replacements];
  for (const session of snapshot.plan.sessions) substitutions.push({ literal: session.id, replacement: researchPublicId(policy.namespace, session.id) });
  if (new Set(substitutions.map(row => row.literal)).size !== substitutions.length) throw new Error("ambiguous release substitutions");
  // One pass over original text prevents replacements from cascading into a
  // later rule. Longest literal wins; ties cannot exist after the check above.
  substitutions.sort((a, b) => b.literal.length - a.literal.length || (a.literal < b.literal ? -1 : 1));
  const pattern = substitutions.length ? new RegExp(substitutions.map(row => row.literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu") : null;
  const replacements = new Map(substitutions.map(row => [row.literal, row.replacement]));
  const policyHash = researchHash(artifactJson(policy));
  for (const artifact of [...snapshot.plan.artifacts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const rule = rules.get(artifact.id)!, publicId = researchPublicId(policy.namespace, artifact.id), source = snapshot.files.get(artifact.path)!;
    const common = { public_id: publicId, source_sha256: artifact.sha256, transformation_sha256: researchHash(artifactJson({ version: 1, policy_sha256: policyHash, public_id: publicId, action: rule.action })) };
    bridge.push({ ...common, private_id: artifact.id, private_path: artifact.path });
    if (rule.action === "withhold") {
      entries.push({ ...common, action: rule.action, reason: rule.reason, output_sha256: null, output_path: null,
        verification: "original bytes unavailable in public candidate; private anchor and archive required" });
      continue;
    }
    if (rule.path === "release.json" || files.has(rule.path)) throw new Error("duplicate or reserved public path");
    safeText(rule.path);
    if (rule.action === "copy" && ["log", "blob", "receipt"].includes(artifact.kind)) throw new Error("private evidence requires sanitization or withholding");
    let text = utf8(source);
    if (rule.action === "sanitize") {
      if (pattern) text = text.replace(pattern, literal => replacements.get(literal)!);
      text = `Sanitized research derivative. Original replay is unavailable from these bytes.\n\n${redactText(text)}`;
    }
    safeText(text);
    // Private identities may appear in selected source as well as native logs.
    for (const session of snapshot.plan.sessions) if (text.includes(session.id)) throw new Error("private session identity remains in public candidate");
    const output = Buffer.from(text);
    if (rule.action === "sanitize" && output.equals(source)) throw new Error("sanitized derivative must have distinct bytes");
    files.set(rule.path, output);
    if (rule.action === "copy" && snapshot.checkpoint.artifacts.find(row => row.id === artifact.id)!.executable) executable.add(rule.path);
    entries.push({ ...common, action: rule.action, output_sha256: researchHash(output), output_path: rule.path, executable: executable.has(rule.path),
      verification: rule.action === "copy" ? "selected source byte identity only; bundle replay requires private archive" : "derived text only; original transcript and chain hashes do not apply" });
  }
  const manifest = { schema_version: 1, kind: "selected-research-release", namespace: policy.namespace,
    checkpoint_sha256: researchHash(artifactJson(snapshot.checkpoint)), policy_sha256: policyHash, transformation_version: 1,
    original_replay_available: false, review_scope: "operator-selected text and registered substitutions; pattern screening is not exhaustive disclosure review", entries };
  safeText(artifactJson(manifest).toString()); files.set("release.json", artifactJson(manifest));
  return { files, executable, manifest, bridge: { schema_version: 1, kind: "private-release-provenance", checkpoint_sha256: manifest.checkpoint_sha256,
    release_manifest_sha256: researchHash(artifactJson(manifest)), policy_sha256: policyHash, entries: bridge } };
}
function readPolicy(path: string): ResearchReleasePolicy {
  return researchReleasePolicySchema.parse(JSON.parse(utf8(researchRead(dirname(resolve(path)), basename(path)))));
}
function equalDirectory(root: string, files: Map<string, Buffer>, executable: ReadonlySet<string>): void {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error("release symlink refused");
      if (entry.isDirectory()) walk(join(dir, entry.name), relative + "/");
      else if (entry.isFile()) found.push(relative);
      else throw new Error("release special file refused");
    }
  };
  walk(root, "");
  if (found.length !== files.size || found.some(path => !files.get(path)?.equals(researchRead(root, path)))) throw new Error("release provenance or output inventory mismatch");
  if (found.some(path => ((lstatSync(join(root, path)).mode & 0o111) !== 0) !== executable.has(path))) throw new Error("release executable mode mismatch");
}
export function exportResearchRelease(input: { root: string; anchorPath: string; policyPath: string; destDir: string; bridgePath: string }) {
  assertExternalArtifact(input.root, input.destDir); assertExternalArtifact(input.root, input.bridgePath);
  assertExternalArtifact(input.destDir, input.bridgePath); assertExternalArtifact(input.destDir, input.anchorPath);
  assertExternalArtifact(input.root, input.policyPath);
  const policy = readPolicy(input.policyPath);
  return withAnchoredResearch(input.root, input.anchorPath, snapshot => {
    const result = derive(snapshot, policy);
    if (!artifactJson(policy).equals(artifactJson(readPolicy(input.policyPath)))) throw new Error("release policy changed during acquisition");
    // Retain the private bridge first. A later publication failure leaves an
    // inspectable intent record, never an untraceable public candidate.
    durableResearchFile(input.bridgePath, artifactJson(result.bridge));
    publishArchiveDirectory(input.destDir, result.files, staging => equalDirectory(staging, result.files, result.executable), result.executable);
    return { status: "local-candidate" as const, manifest_sha256: researchHash(artifactJson(result.manifest)), original_replay_available: false };
  });
}
export function verifyResearchRelease(input: { root: string; anchorPath: string; policyPath: string; destDir: string; bridgePath: string }) {
  assertExternalArtifact(input.root, input.destDir); assertExternalArtifact(input.destDir, input.bridgePath);
  const policy = readPolicy(input.policyPath);
  return withAnchoredResearch(input.root, input.anchorPath, snapshot => {
    const expected = derive(snapshot, policy); equalDirectory(resolve(input.destDir), expected.files, expected.executable);
    if (!researchRead(dirname(resolve(input.bridgePath)), basename(input.bridgePath)).equals(artifactJson(expected.bridge))) throw new Error("private release bridge mismatch");
    return { status: "matched" as const, manifest_sha256: researchHash(artifactJson(expected.manifest)), original_replay_available: false };
  });
}
