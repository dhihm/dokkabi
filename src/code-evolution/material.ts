import { createHash } from "node:crypto";
import { fstatSync, readFileSync, readSync, realpathSync } from "node:fs";
import { z } from "zod";
import ts from "typescript";
import { canonicalJson } from "../host/canonical.ts";
import { assertNoSecrets, containsSecret, redactText } from "../host/redact.ts";
import { foldWorkspaceKey } from "../host/workspace-versions.ts";
import {
  openBeneath,
  readOpened,
  safeRoot,
  LinkSafetyError,
  type SafeRoot,
} from "../work/link-safe-fs.ts";
import { analyzeSource } from "./standalone/extractor.js";
import {
  compileIgnore,
  isExcludedPath,
  isSupportedSource,
  redactSecrets,
} from "./standalone/security.js";
import { assembleGraph } from "./standalone/graph.js";
import { LayoutManager } from "./standalone/layout.js";
import { diffText, structuralChanges } from "./standalone/diff.js";

export const LIMITS = Object.freeze({
  paths: 128,
  file: 256 * 1024,
  total: 2 * 1024 * 1024,
  envelope: 8 * 1024 * 1024,
  nodes: 20_000,
  versions: 32,
  retained: 64 * 1024 * 1024,
  policy: 64 * 1024,
  diffLines: 1000,
});
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const referenceSchema = z.strictObject({
  seq: z.number().int().positive(),
  hash: digestSchema,
});
export type Reference = z.infer<typeof referenceSchema>;
export function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    !containsSecret(path) &&
    path.split("/").every((p) => p !== "" && p !== "." && p !== "..")
  );
}
export class CodeVersionRefusal extends Error {
  constructor(
    readonly code: string,
    readonly causeCode?: string,
  ) {
    super(`Code evolution version refused: ${code}`);
    this.name = "CodeVersionRefusal";
  }
}
export function refuse(code: string): never {
  throw new CodeVersionRefusal(code);
}
const jsonObject = z.record(z.string(), z.json());
const nodeSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    path: z.string(),
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite(),
    h: z.number().finite(),
  })
  .catchall(z.json());
export const graphSchema = z.strictObject({
  nodes: z.array(nodeSchema).max(LIMITS.nodes),
  edges: z.array(jsonObject).max(LIMITS.nodes * 4),
  diagnostics: z.array(jsonObject).max(LIMITS.nodes),
});
export type StructuralGraph = z.infer<typeof graphSchema>;
const analysisSchema = z.strictObject({
  language: z.string(),
  lines: z.number().int().nonnegative(),
  symbols: z.array(jsonObject).max(LIMITS.nodes),
  imports: z.array(jsonObject).max(LIMITS.nodes),
  diagnostics: z.array(jsonObject).max(LIMITS.nodes),
});
export type Analysis = z.infer<typeof analysisSchema>;
const slot = z.number().int().nonnegative().max(LIMITS.nodes);
export const layoutSchema = z.strictObject({
  modules: z.record(z.string(), slot),
  files: z.record(z.string(), z.strictObject({ module: z.string(), slot })),
  symbols: z.record(z.string(), z.record(z.string(), slot)),
});
export type LayoutState = z.infer<typeof layoutSchema>;
const byteVersion = z.strictObject({
  digest: digestSchema,
  bytes: z.number().int().nonnegative().max(LIMITS.file),
});
export const fileSchema = z.strictObject({
  path: z.string().refine(safePath),
  receiptPath: z.string().refine(safePath).nullable(),
  status: z.enum([
    "parsed",
    "parse_failed",
    "excluded",
    "unsupported",
    "missing",
    "unavailable",
    "oversized",
    "invalid_utf8",
  ]),
  original: byteVersion.nullable(),
  sanitized: byteVersion
    .extend({
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(LIMITS.file * 2),
      text: z.string(),
    })
    .nullable(),
  analysis: analysisSchema.nullable(),
});
export type CapturedFile = z.infer<typeof fileSchema>;
export const policySchema = z.strictObject({
  path: z.enum([".gitignore", ".dashboardignore"]),
  digest: digestSchema.nullable(),
  text: z.string().max(LIMITS.policy),
});

/** Installed implementation identity, never a hash of mutable workspace source. */
export function materialIdentity() {
  const base = new URL("./standalone/", import.meta.url);
  const manifestText = readFileSync(new URL("import-manifest.json", base), "utf8");
  const manifest = z
    .strictObject({
      schemaVersion: z.literal(1),
      candidateInventory: digestSchema,
      provenanceSha256: digestSchema,
      scope: z.string(),
      files: z.record(z.string(), digestSchema),
      parserRuntime: z.strictObject({
        name: z.literal("typescript"),
        version: z.string(),
        license: z.literal("Apache-2.0"),
        licenseSha256: digestSchema,
        noticesSha256: digestSchema,
      }),
    })
    .parse(JSON.parse(manifestText));
  const names = ["extractor.js", "security.js", "graph.js", "layout.js", "diff.js"];
  if (
    canonicalJson(Object.keys(manifest.files).sort()) !== canonicalJson(names.sort()) ||
    ts.version !== manifest.parserRuntime.version
  )
    refuse("implementation_identity_invalid");
  for (const name of names)
    if (sha(readFileSync(new URL(name, base))) !== manifest.files[name])
      refuse("implementation_identity_invalid");
  for (const [name, wanted] of [
    ["PROVENANCE.md", manifest.provenanceSha256],
    ["notices/LICENSE.txt", manifest.parserRuntime.licenseSha256],
    ["notices/ThirdPartyNoticeText.txt", manifest.parserRuntime.noticesSha256],
  ] as const)
    if (sha(readFileSync(new URL(name, base))) !== wanted)
      refuse("implementation_identity_invalid");
  return {
    parser: { name: "typescript", version: ts.version },
    importDigest: sha(manifestText),
    redaction: {
      version: 1,
      candidate: manifest.files["security.js"]!,
      host: sha(readFileSync(new URL("../host/redact.ts", import.meta.url))),
    },
    adapter: sha(readFileSync(new URL("./material.ts", import.meta.url))),
  };
}
export type MaterialIdentity = ReturnType<typeof materialIdentity>;

function boundedRead(
  root: SafeRoot,
  path: string,
  max: number,
  keySink?: (key: string) => void,
): Buffer | "oversized" | undefined {
  const file = openBeneath(root, Buffer.from(path), "code observation");
  if (!file) return undefined;
  try {
    if (file.size > max) return "oversized";
    const bytes = readOpened(file, file.size);
    const final = fstatSync(file.fd, { bigint: true });
    if (
      bytes.length !== file.size ||
      readSync(file.fd, Buffer.alloc(1), 0, 1, file.size) !== 0 ||
      final.size !== BigInt(file.size) ||
      final.mtimeNs !== file.mtimeNs
    )
      refuse("source_changed_during_read");
    file.verify();
    if (keySink) {
      const key = foldWorkspaceKey(root.text, path);
      if (!key || !safePath(key)) refuse("source_scope_invalid");
      file.verify();
      keySink(key);
    }
    return bytes;
  } finally {
    file.close();
  }
}
function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function lineCount(text: string): number {
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

export function captureMaterial(
  workspaceRoot: string,
  paths: string[],
  previous: { files: CapturedFile[]; graph: StructuralGraph; layout: LayoutState } | null,
) {
  const root = safeRoot(realpathSync(workspaceRoot), "code evolution workspace");
  const policies = [".gitignore", ".dashboardignore"].map((path) => {
    let bytes: ReturnType<typeof boundedRead>;
    try {
      bytes = boundedRead(root, path, LIMITS.policy);
    } catch {
      return refuse("ignore_policy_unavailable");
    }
    if (bytes === "oversized") refuse("ignore_policy_oversized");
    let text = "";
    try {
      text = bytes === undefined ? "" : decode(bytes);
      assertNoSecrets(text);
    } catch {
      refuse("ignore_policy_invalid");
    }
    return policySchema.parse({ path, text, digest: bytes === undefined ? null : sha(bytes) });
  });
  const matcher = compileIgnore(policies.map((p) => p.text).join("\n"));
  const previousFiles = new Map(previous?.files.map((f) => [f.path, f]) ?? []);
  const files: CapturedFile[] = [];
  let bytesRead = 0,
    parsed = 0,
    reused = 0;
  const keys = new Set<string>();
  for (const path of paths) {
    const f: CapturedFile = {
      path,
      receiptPath: null,
      status: "missing",
      original: null,
      sanitized: null,
      analysis: null,
    };
    files.push(f);
    if (isExcludedPath(path, matcher)) {
      f.status = "excluded";
      continue;
    }
    if (!isSupportedSource(path)) {
      f.status = "unsupported";
      continue;
    }
    let bytes: ReturnType<typeof boundedRead>;
    let key: string | undefined;
    try {
      bytes = boundedRead(root, path, LIMITS.file, (folded) => {
        key = folded;
      });
    } catch (error) {
      if (error instanceof CodeVersionRefusal) throw error;
      if (
        error instanceof LinkSafetyError ||
        (typeof error === "object" && error !== null && "code" in error)
      ) {
        f.status = "unavailable";
        continue;
      }
      throw error;
    }
    if (bytes === undefined) continue;
    if (bytes === "oversized") {
      f.status = "oversized";
      continue;
    }
    bytesRead += bytes.length;
    if (bytesRead > LIMITS.total) refuse("source_total_limit");
    f.original = { digest: sha(bytes), bytes: bytes.length };
    let text: string;
    try {
      text = decode(bytes);
    } catch {
      f.status = "invalid_utf8";
      continue;
    }
    if (!key || !safePath(key)) refuse("source_scope_invalid");
    if (keys.has(key)) refuse("duplicate_file_alias");
    keys.add(key);
    f.receiptPath = key;
    const old = previousFiles.get(path);
    if (old?.original?.digest === f.original.digest && old.sanitized && old.analysis) {
      f.sanitized = old.sanitized;
      f.analysis = old.analysis;
      f.status = old.status;
      reused++;
    } else {
      const sanitized = redactText(redactSecrets(text));
      assertNoSecrets(sanitized);
      f.sanitized = {
        text: sanitized,
        digest: sha(sanitized),
        bytes: Buffer.byteLength(sanitized),
      };
      f.analysis = analysisSchema.parse(analyzeSource(path, sanitized, sha(key)));
      f.status = f.analysis.diagnostics.some((d) => d.severity === "error")
        ? "parse_failed"
        : "parsed";
      parsed++;
    }
  }
  const layout = new LayoutManager(previous?.layout);
  const graphFiles = new Map<
    string,
    { uid: string; hash: string; size: number; analysis: Analysis }
  >();
  for (const f of files)
    if (f.sanitized && f.analysis && f.receiptPath)
      graphFiles.set(f.path, {
        uid: sha(f.receiptPath),
        hash: f.sanitized.digest,
        size: f.sanitized.bytes,
        analysis: f.analysis,
      });
  // Bound aggregate nodes before the imported layout allocates its graph.
  if (
    [...graphFiles.values()].reduce(
      (sum, f) => sum + f.analysis.symbols.length + f.analysis.imports.length + 2,
      0,
    ) > LIMITS.nodes
  )
    refuse("graph_node_limit");
  const graph = graphSchema.parse(assembleGraph(graphFiles, layout));
  const changes = files.map((f) => {
    const old = previousFiles.get(f.path);
    const before = old?.sanitized?.text ?? "",
      after = f.sanitized?.text ?? "";
    const exact = before === after || lineCount(before) + lineCount(after) <= LIMITS.diffLines;
    return {
      path: f.path,
      status: f.status,
      originalChanged: old?.original?.digest !== f.original?.digest,
      textDiff: exact
        ? { kind: "exact", value: diffText(before, after) }
        : {
            kind: "summary_only",
            reason: "line_diff_budget",
            beforeLines: lineCount(before),
            afterLines: lineCount(after),
          },
    };
  });
  const outOfScope = (previous?.files ?? [])
    .filter((f) => !paths.includes(f.path))
    .map((f) => f.path);
  const result = {
    rootId: `${root.dev}:${root.ino}`,
    files,
    graph,
    graphDigest: sha(canonicalJson(graph)),
    layout: layoutSchema.parse(layout.toJSON()),
    policies,
    diff: {
      structural: JSON.parse(
        JSON.stringify(structuralChanges(previous?.graph ?? null, graph, changes)),
      ),
      files: changes,
      outOfScope,
    },
    coverage: {
      scope: "explicit_selected_paths",
      consistency: "checked_per_file_non_atomic",
      coordinateSpace: "sanitized_utf16_lines",
      selected: paths.length,
      statuses: files.map((f) => ({ path: f.path, status: f.status })),
      outOfScope,
    },
    stats: { bytesRead, parsed, reused },
  };
  assertNoSecrets(result);
  return result;
}
