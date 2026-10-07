import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { BlobStore } from "./blob-store.ts";
import { canonicalJson } from "./canonical.ts";
import type { EventLog } from "./event-log.ts";
import { assertImageSources, materializeExecutionImageInto, within } from "./execution-image.ts";
import { prepareCheckpointInputImport } from "./checkpoint-input-import.ts";
import { readBranchCheckpoint, type BranchCheckpointReceipt } from "./branch-checkpoint.ts";
import { validateImportedCheckpointSource, type ImportedCheckpointSource, type CheckpointImportBundle } from "./provider-input.ts";
import { spawnSealedHostGit } from "./git-authority.ts";
import { liveWritersOf } from "./live-writers.ts";
import { assertNoOwnedResourceMounts, OwnedResourceMountError } from "./owned-resource-mounts.ts";
import { containsSecret, redactText, stripTerminalControls } from "./redact.ts";
import { projectSessionReplaySchemas, type EventRecord } from "./schema.ts";
import { validateExecutionImage, type ExecutionImage, type ImageEntry } from "../work/evidence/execution-view.ts";

/** R8-02 persistent branch workspaces (docs/desktop-branches-r8.md): an
 * authenticated complete checkpoint becomes an independently owned persistent
 * workspace with the exact captured working bytes and an isolated standalone
 * Git metadata directory, under an explicit owner-selected runtime/model
 * policy.
 *
 * The immutable retained image and the mutable persistent workspace are two
 * separate authorities: acquisition verifies the restored tree against the
 * derived image exactly once — again inside the ready admission callback —
 * while reopening revalidates retained evidence, ownership, the recorded
 * selection and current Git/symlink/mount containment, and permits
 * legitimate later edits, commits and ref changes. The original parent
 * workspace, its log and its metadata are never written. This API records a
 * selection; it never claims a provider call, installs source credentials or
 * environment, or exposes a runnable branch.
 *
 * The writer, the live reader and cold replay share one closed lifecycle
 * validator, so a receipt the fold would refuse can never be written. */

export const BRANCH_WORKSPACE_SCHEMA = "branch-workspace-v1";
/** Closed safe identifier: the shape checkpoint ids use. */
export const BRANCH_WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const REASON_PATTERN = /^[a-z][a-z0-9_]{1,99}$/u;
const MAX_SESSION_ID_BYTES = 256;
const MAX_POLICY_FIELD_BYTES = 256;
const MAX_RESOURCE_ROOT_BYTES = 4096;
const MAX_CONTAINMENT_ENTRIES = 100_000;

export class BranchWorkspaceError extends Error {
  constructor(readonly code: string, detail?: string) {
    // Refusal text is a code plus at most a sanitized bounded detail; a
    // detail that still looks like a secret is dropped entirely.
    const safe = detail === undefined ? "" : redactText(stripTerminalControls(detail));
    super(`branch-workspace: ${code}${safe && !containsSecret(safe) ? `: ${safe.slice(0, 240)}` : ""}`);
    this.name = "BranchWorkspaceError";
  }
}

function fail(code: string, detail?: string): never {
  throw new BranchWorkspaceError(code, detail);
}

const sha256Hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const currentUid = (): number => process.getuid?.() ?? -1;

// ---------------------------------------------------------------------------
// Closed receipt contract, shared by the host writer and cold replay.
// ---------------------------------------------------------------------------

const digestField = z.string().regex(DIGEST_PATTERN);
const sourceRefSchema = z.object({
  session: z.string().min(1).max(MAX_SESSION_ID_BYTES),
  checkpoint: z.string().regex(BRANCH_WORKSPACE_ID_PATTERN),
  digest: digestField,
  head: z.object({ seq: z.number().int().positive(), hash: digestField }).strict(),
}).strict();
const modelPolicySchema = z.object({
  route: z.string().min(1).max(MAX_POLICY_FIELD_BYTES),
  model: z.object({
    provider: z.string().min(1).max(MAX_POLICY_FIELD_BYTES),
    id: z.string().min(1).max(MAX_POLICY_FIELD_BYTES),
  }).strict(),
}).strict();
const resourceRefSchema = z.object({
  root: z.string().startsWith("/").max(MAX_RESOURCE_ROOT_BYTES),
  owner: digestField,
}).strict();
const rootIdentitySchema = z.object({
  uid: z.number().int().nonnegative(),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().positive(),
  mode: z.literal(0o700),
}).strict();
const identityFields = {
  schema: z.literal(BRANCH_WORKSPACE_SCHEMA),
  id: z.string().regex(BRANCH_WORKSPACE_ID_PATTERN),
  session: z.string().min(1).max(MAX_SESSION_ID_BYTES),
};

export const branchWorkspaceReceiptSchemas = {
  /** The intent binds the full selection before anything is allocated: the
   * source authority, the retained bundle and the policy/runtime the ready
   * receipt must repeat exactly. */
  "branch/workspace_intent": z.object({
    ...identityFields,
    source: sourceRefSchema,
    source_blob: digestField,
    policy: modelPolicySchema,
    runtime: digestField,
  }).strict(),
  "branch/workspace_ready": z.object({
    ...identityFields,
    source: sourceRefSchema,
    source_blob: digestField,
    original_image: digestField,
    derived_image: digestField,
    layout: z.enum(["ordinary", "linked", "none"]),
    index: digestField.nullable(),
    config: z.literal("inert_v1"),
    policy: modelPolicySchema,
    history: z.record(z.string(), z.unknown()),
    runtime: digestField,
    resource: resourceRefSchema,
    root: rootIdentitySchema,
    workspace: z.string().startsWith("/").max(MAX_RESOURCE_ROOT_BYTES),
  }).strict(),
  "branch/workspace_failed": z.object({ ...identityFields, source: sourceRefSchema, reason: z.string().regex(REASON_PATTERN) }).strict(),
  "branch/workspace_release": z.object({ ...identityFields, source: sourceRefSchema, resource: resourceRefSchema }).strict(),
  "branch/workspace_closed": z.object({ ...identityFields, source: sourceRefSchema, resource: resourceRefSchema }).strict(),
} as const;

export type BranchWorkspaceReceiptName = keyof typeof branchWorkspaceReceiptSchemas;
export type BranchWorkspaceIntent = Readonly<z.infer<typeof branchWorkspaceReceiptSchemas["branch/workspace_intent"]>>;
export type BranchWorkspaceReady = Readonly<z.infer<typeof branchWorkspaceReceiptSchemas["branch/workspace_ready"]>>;
export type BranchWorkspaceFailed = Readonly<z.infer<typeof branchWorkspaceReceiptSchemas["branch/workspace_failed"]>>;
export type BranchWorkspaceModelPolicy = Readonly<z.infer<typeof modelPolicySchema>>;

/** The host-only inert Git configuration every derived repository gets: no
 * include, no extension, no hook path, no helper command, no alternate
 * store. Original config content is retained evidence only and is never
 * executed; reopening requires these exact bytes to still be in place. */
const INERT_GIT_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
const inertConfigEnvelope = canonicalJson({ encoding: "base64", data: Buffer.from(INERT_GIT_CONFIG, "utf8").toString("base64") });
const INERT_CONFIG_BLOB = sha256Hex(inertConfigEnvelope);
const INERT_CONFIG_BYTES = Buffer.byteLength(INERT_GIT_CONFIG);
const INERT_CONFIG_SHA = sha256Hex(INERT_GIT_CONFIG);

/** The deterministic mode0600 owner descriptor: exactly the binding fields
 * of the ready receipt, nothing else, so cold replay re-derives its digest
 * from retained evidence alone and any live reader compares the file. */
function ownerDescriptorOf(payload: {
  session: string; id: string; source: unknown; source_blob: string;
  original_image: string; derived_image: string; policy: unknown;
  runtime: string; root: { uid: number; dev: number; ino: number; mode: 0o700 };
}): Record<string, unknown> {
  return {
    schema_version: 1,
    schema: BRANCH_WORKSPACE_SCHEMA,
    session: payload.session,
    id: payload.id,
    source: structuredClone(payload.source),
    source_blob: payload.source_blob,
    original_image: payload.original_image,
    derived_image: payload.derived_image,
    policy: structuredClone(payload.policy),
    runtime: payload.runtime,
    root: { ...payload.root },
    workspace: "0",
  };
}

// ---------------------------------------------------------------------------
// Derivation: a portable standalone image derived purely from the retained
// source manifest and its retained body bytes. Never from the live parent.
// ---------------------------------------------------------------------------

export type BranchWorkspaceGitLayout = "ordinary" | "linked" | "none";

export interface BranchWorkspaceDerivation {
  readonly manifest: ExecutionImage;
  readonly digest: string;
  readonly layout: BranchWorkspaceGitLayout;
  readonly index: string | null;
  readonly originalDigest: string;
  readonly basePolicy: string;
}

/** Authenticate and decode one retained file body. Pure given the reader. */
function fileBytes(entry: ImageEntry, read: (blob: string) => string): Buffer {
  if (entry.kind !== "file") fail("branch_workspace_entry_not_file");
  const text = read(entry.blob);
  if (Buffer.byteLength(text) !== entry.blob_bytes) fail("branch_workspace_body_bytes");
  let body: { encoding?: unknown; data?: unknown };
  try {
    body = JSON.parse(text) as { encoding?: unknown; data?: unknown };
  } catch {
    return fail("branch_workspace_body_invalid");
  }
  const data = typeof body.data === "string" ? body.data : "";
  const bytes = Buffer.from(data, "base64");
  if (body.encoding !== "base64" || bytes.toString("base64") !== data
    || bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
    fail("branch_workspace_body_mismatch");
  }
  return bytes;
}

/** The scanner's depth-first pre-order with sorted directory listings: a
 * parent precedes its children, and "a/x" precedes "a-x", because the walk
 * recurses into "a" before visiting the later sibling. */
function compareScanPaths(left: string, right: string): number {
  if (left === right) return 0;
  if (left === ".") return -1;
  if (right === ".") return 1;
  const a = left.split("/"), b = right.split("/");
  for (let index = 0; ; index += 1) {
    if (index >= a.length) return index >= b.length ? 0 : -1;
    if (index >= b.length) return 1;
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
}

/** A ".git" path segment anywhere below the top level is a nested
 * repository's metadata — a distinct repository boundary, not a file. */
function hasNestedGitSegment(path: string): boolean {
  if (path === "." || path === ".git") return false;
  const segments = path.split("/");
  return segments.slice(segments[0] === ".git" ? 1 : 0).some(segment => segment === ".git");
}

/** Read the original config as data only: include/includeIf would pull in
 * files outside the capture, and extensions can require formats this bounded
 * SHA-1/files support cannot read. Both refuse. */
function assertConfigSupported(text: string): void {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[\t\r]/gu, " ").trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\]/u.exec(line);
    if (section) {
      const name = section[1]!.toLowerCase();
      if (name === "include" || name === "includeif" || name === "extensions") {
        fail("branch_workspace_config_unsupported");
      }
    }
  }
}

function inertConfigEntry(configSource: ImageEntry | undefined): ImageEntry {
  return {
    path: ".git/config",
    kind: "file",
    mode: configSource?.kind === "file" ? configSource.mode : 0o644,
    mtime_ns: configSource?.kind === "file" ? configSource.mtime_ns : "0",
    bytes: INERT_CONFIG_BYTES,
    sha256: INERT_CONFIG_SHA,
    blob: INERT_CONFIG_BLOB,
    blob_bytes: Buffer.byteLength(inertConfigEnvelope),
  };
}

/** Derive the standalone child image from the retained checkpoint image.
 * Ordinary Git keeps HEAD/index/objects/refs/logs with an inert config and
 * no hooks or administrative pointers. Conventional linked metadata combines
 * the captured common tree with the checkout-local HEAD/index/logs/refs into
 * a real standalone `.git` directory; pointers back to the original root are
 * verified as data, then discarded. Alternates, includes, extensions,
 * submodules, nested repositories, Git symlinks and external workspace
 * symlinks refuse before any publication. Deterministic in the retained
 * evidence alone, so cold replay re-derives the same digest. */
export function deriveBranchWorkspaceImage(
  source: ExecutionImage,
  read: (blob: string) => string,
  options: { workspace: string },
): BranchWorkspaceDerivation {
  if (typeof options.workspace !== "string" || !options.workspace.startsWith("/")) {
    fail("branch_workspace_target_invalid");
  }
  const sourceDigest = sha256Hex(canonicalJson(source));
  const workspaceTree = source.trees[0]!;
  const workspaceTarget = workspaceTree.target;
  const workspaceEntries = new Map(workspaceTree.entries.map(entry => [entry.path, entry] as const));

  // Workspace symlink policy: relative links resolving inside the captured
  // workspace only. Anything under .git is Git metadata and refuses.
  for (const entry of workspaceTree.entries) {
    if (entry.kind !== "symlink") continue;
    if (entry.path === ".git" || entry.path.startsWith(".git/") || hasNestedGitSegment(entry.path)) {
      fail("branch_workspace_git_symlink");
    }
    if (entry.target.startsWith("/")) fail("branch_workspace_link_external");
    const resolved = resolve(dirname(join(workspaceTarget, entry.path)), entry.target);
    if (resolved !== workspaceTarget && !within(workspaceTarget, resolved)) {
      fail("branch_workspace_link_external");
    }
  }

  const derived = new Map<string, ImageEntry>();
  let layout: BranchWorkspaceGitLayout;
  let index: string | null = null;
  const gitEntry = workspaceEntries.get(".git");

  const copyWorkspaceEntry = (entry: ImageEntry): void => {
    if (hasNestedGitSegment(entry.path)) fail("branch_workspace_git_nested");
    derived.set(entry.path, entry);
  };

  if (gitEntry === undefined) {
    if (source.trees.length !== 1) fail("branch_workspace_git_metadata_unavailable");
    layout = "none";
    for (const entry of workspaceTree.entries) copyWorkspaceEntry(entry);
  } else if (gitEntry.kind === "directory") {
    if (source.trees.length !== 1) fail("branch_workspace_git_metadata_unavailable");
    layout = "ordinary";
    let configSource: ImageEntry | undefined;
    for (const entry of workspaceTree.entries) {
      if (entry.path === "." || entry.path === ".git") { derived.set(entry.path, entry); continue; }
      if (!entry.path.startsWith(".git/")) { copyWorkspaceEntry(entry); continue; }
      // Inside the captured .git directory.
      if (entry.kind === "symlink") fail("branch_workspace_git_symlink");
      if (entry.path.endsWith(".lock") || entry.path.endsWith(".pid")) fail("branch_workspace_worktree_admin_unresolved");
      if (entry.path === ".git/commondir" || entry.path === ".git/gitdir") fail("branch_workspace_git_pointer_unresolved");
      if ([".git/objects/info/alternates", ".git/objects/info/http-alternates"].includes(entry.path)) fail("branch_workspace_alternates_unsupported");
      if (entry.path === ".git/modules" || entry.path.startsWith(".git/modules/")) fail("branch_workspace_submodule_unsupported");
      if (entry.path === ".git/hooks" || entry.path.startsWith(".git/hooks/")) continue;
      if (entry.path === ".git/worktrees" || entry.path.startsWith(".git/worktrees/")) continue;
      if (entry.path === ".git/config") {
        assertConfigSupported(fileBytes(entry, read).toString("utf8"));
        configSource = entry;
        continue;
      }
      if (entry.path === ".git/index") {
        if (entry.kind !== "file") fail("branch_workspace_index_unavailable");
        fileBytes(entry, read);
        index = entry.sha256;
      }
      derived.set(entry.path, entry);
    }
    derived.set(".git/config", inertConfigEntry(configSource));
  } else if (gitEntry.kind === "file") {
    if (source.trees.length !== 2) fail("branch_workspace_git_metadata_unavailable");
    layout = "linked";
    const commonTree = source.trees[1]!;
    const commonTarget = commonTree.target;
    const pointer = fileBytes(gitEntry, read).toString("utf8");
    const match = /^gitdir: (.+)$/u.exec(pointer.trim());
    if (!match || pointer.trim().includes("\n")) fail("branch_workspace_git_link_invalid");
    const resolved = resolve(workspaceTarget, match[1]!);
    const adminRoot = join(commonTarget, "worktrees");
    const name = relative(adminRoot, resolved);
    if (name === "" || name === "." || name === ".." || name.includes("/") || resolved !== join(adminRoot, name)) {
      fail("branch_workspace_git_link_unresolved");
    }
    const commonEntries = new Map(commonTree.entries.map(entry => [entry.path, entry] as const));
    const prefix = `worktrees/${name}/`;
    const adminGitdir = commonEntries.get(`${prefix}gitdir`);
    const adminCommondir = commonEntries.get(`${prefix}commondir`);
    const adminHead = commonEntries.get(`${prefix}HEAD`);
    const adminIndex = commonEntries.get(`${prefix}index`);
    if (!adminGitdir || adminGitdir.kind !== "file" || !adminCommondir || adminCommondir.kind !== "file"
      || !adminHead || adminHead.kind !== "file") {
      fail("branch_workspace_worktree_admin_unresolved");
    }
    // The administrative pointers must resolve, as data, to exactly this
    // checkout and common tree before they are discarded.
    const adminDir = join(adminRoot, name);
    const backlink = fileBytes(adminGitdir, read).toString("utf8").trim();
    if (resolve(adminDir, backlink) !== join(workspaceTarget, ".git")) fail("branch_workspace_worktree_admin_unresolved");
    const commonPointer = fileBytes(adminCommondir, read).toString("utf8").trim();
    if (resolve(adminDir, commonPointer) !== commonTarget) fail("branch_workspace_worktree_admin_unresolved");
    // Preserve checkout-local data generically. Only storage/config/helper
    // roles are special: importing them could introduce shared or executable
    // authority. Ordinary commit/merge/message data is not an admin pointer.
    const localData = (local: string, entry: ImageEntry): boolean => {
      if (entry.kind === "symlink") fail("branch_workspace_git_symlink");
      if (hasNestedGitSegment(local)) fail("branch_workspace_git_nested");
      const top = local.split("/")[0]!;
      if (local.endsWith(".lock") || local.endsWith(".pid")) fail("branch_workspace_worktree_admin_unresolved");
      if (local === "gitdir" || local === "commondir") return false;
      if (top === "hooks") return false;
      if (local === "config" || local === "config.worktree") {
        assertConfigSupported(fileBytes(entry, read).toString("utf8"));
        return false;
      }
      if (["objects", "packed-refs", "worktrees", "modules"].includes(top)) {
        fail("branch_workspace_worktree_admin_unresolved");
      }
      if (top === "refs" && local !== "refs" && !["bisect", "rewritten", "worktree"].includes(local.split("/")[1]!)) {
        fail("branch_workspace_worktree_admin_unresolved");
      }
      return true;
    };
    for (const [path, entry] of commonEntries) {
      if (path.startsWith(prefix)) localData(path.slice(prefix.length), entry);
    }
    // Common metadata becomes the standalone child .git; the worktree admin
    // namespace and hooks are dropped, checkout-local files override.
    let configSource: ImageEntry | undefined;
    for (const [path, entry] of commonEntries) {
      if (path === ".") continue;
      if (path === "worktrees" || path.startsWith("worktrees/")) continue;
      if (path === "hooks" || path.startsWith("hooks/")) continue;
      if (path === "config") {
        assertConfigSupported(fileBytes(entry, read).toString("utf8"));
        configSource = entry;
        continue;
      }
      if (path.endsWith(".lock") || path.endsWith(".pid")) fail("branch_workspace_worktree_admin_unresolved");
      if (path === "HEAD" || path === "index" || path === "logs/HEAD") continue;
      if (entry.kind === "symlink") fail("branch_workspace_git_symlink");
      if (hasNestedGitSegment(path)) fail("branch_workspace_git_nested");
      if (["objects/info/alternates", "objects/info/http-alternates"].includes(path)) fail("branch_workspace_alternates_unsupported");
      if (path === "modules" || path.startsWith("modules/")) fail("branch_workspace_submodule_unsupported");
      derived.set(`.git/${path}`, { ...entry, path: `.git/${path}` });
    }
    const commonRoot = commonEntries.get(".");
    derived.set(".git", {
      path: ".git",
      kind: "directory",
      mode: commonRoot?.kind === "directory" ? commonRoot.mode : 0o755,
      mtime_ns: commonRoot?.kind === "directory" ? commonRoot.mtime_ns : "0",
    });
    derived.set(".git/HEAD", { ...adminHead, path: ".git/HEAD" });
    if (adminIndex && adminIndex.kind === "file") {
      fileBytes(adminIndex, read);
      index = adminIndex.sha256;
      derived.set(".git/index", { ...adminIndex, path: ".git/index" });
    }
    for (const [path, entry] of commonEntries) {
      if (!path.startsWith(prefix)) continue;
      const local = path.slice(prefix.length);
      if (localData(local, entry)) derived.set(`.git/${local}`, { ...entry, path: `.git/${local}` });
    }
    derived.set(".git/config", inertConfigEntry(configSource));
    for (const entry of workspaceTree.entries) {
      if (entry.path === ".git") continue;
      copyWorkspaceEntry(entry);
    }
  } else {
    fail("branch_workspace_git_symlink");
  }

  const entries = [...derived.values()].sort((left, right) => compareScanPaths(left.path, right.path));
  // The derived image is a standalone child selection: no source environment
  // or private root is carried as an executable selection.
  const transformation = {
    schema: BRANCH_WORKSPACE_SCHEMA,
    version: 1,
    source_digest: sourceDigest,
    layout,
    index,
    config: "inert_v1",
    workspace: options.workspace,
  };
  const manifest: ExecutionImage = {
    schema_version: 1,
    workspace: options.workspace,
    base_policy: sha256Hex(canonicalJson(transformation)).slice(0, 16),
    runtime: source.runtime,
    environment: {},
    trees: [{ target: options.workspace, entries }],
  };
  const validated = validateExecutionImage(manifest);
  return {
    manifest: validated,
    digest: sha256Hex(canonicalJson(validated)),
    layout,
    index,
    originalDigest: sourceDigest,
    basePolicy: manifest.base_policy,
  };
}

// ---------------------------------------------------------------------------
// The one closed lifecycle validator: writer, live reader and cold replay
// all enforce the same sequence and field bindings, so the fold can never
// reject a receipt this host wrote.
// ---------------------------------------------------------------------------

export interface BranchWorkspaceLifecycleRow {
  readonly row: EventRecord;
  readonly name: BranchWorkspaceReceiptName;
  readonly payload: unknown;
}

export interface BranchWorkspaceLifecycleEntry {
  intent?: { row: EventRecord; payload: BranchWorkspaceIntent };
  ready?: { row: EventRecord; payload: BranchWorkspaceReady };
  failed?: { row: EventRecord; payload: BranchWorkspaceFailed };
  released: boolean;
  closed: boolean;
}

export interface BranchWorkspaceLifecycle {
  readonly ordered: readonly BranchWorkspaceLifecycleRow[];
  readonly byId: ReadonlyMap<string, BranchWorkspaceLifecycleEntry>;
}

/** One closed lifecycle per session identifier: receipts exist only under
 * the `branch-workspace-v1` feature generation, bind the governing session,
 * and follow one intent → one terminal → one release → one closure sequence
 * whose source, bundle, policy, runtime and resource fields repeat the
 * earlier receipts exactly. Anything else refuses fail-closed. */
export function validateBranchWorkspaceLifecycle(events: readonly EventRecord[]): BranchWorkspaceLifecycle {
  const featureStart = projectSessionReplaySchemas(events).featureStart.get(BRANCH_WORKSPACE_SCHEMA);
  const ordered: BranchWorkspaceLifecycleRow[] = [];
  const byId = new Map<string, BranchWorkspaceLifecycleEntry>();
  let governing: string | undefined;
  for (const row of events) {
    if (row.name === "session/open") {
      const id = row.payload.session_id ?? row.payload.id;
      if (typeof id === "string") governing = id;
    }
    if (!row.name.startsWith("branch/workspace_")) continue;
    if (!Object.hasOwn(branchWorkspaceReceiptSchemas, row.name)) fail("branch_workspace_receipt_unknown");
    if (row.kind !== "observe" || featureStart === undefined || row.seq <= featureStart) {
      fail("branch_workspace_feature_generation");
    }
    const name = row.name as BranchWorkspaceReceiptName;
    const bind = (value: { session: string; id: string }): BranchWorkspaceLifecycleEntry => {
      if (governing === undefined || value.session !== governing) fail("branch_workspace_session_binding");
      const key = canonicalJson([value.session, value.id]);
      let entry = byId.get(key);
      if (!entry) {
        entry = { released: false, closed: false };
        byId.set(key, entry);
      }
      return entry;
    };
    if (name === "branch/workspace_intent") {
      const parsed = branchWorkspaceReceiptSchemas["branch/workspace_intent"].safeParse(row.payload);
      if (!parsed.success) fail("branch_workspace_receipt_binding");
      const value = parsed.data;
      const entry = bind(value);
      if (entry.intent || entry.ready || entry.failed || entry.released || entry.closed) {
        fail("branch_workspace_intent_duplicate");
      }
      entry.intent = { row, payload: value };
      ordered.push({ row, name, payload: value });
      continue;
    }
    if (name === "branch/workspace_ready") {
      const parsed = branchWorkspaceReceiptSchemas["branch/workspace_ready"].safeParse(row.payload);
      if (!parsed.success) fail("branch_workspace_receipt_binding");
      const value = parsed.data;
      const entry = bind(value);
      if (!entry.intent || entry.ready || entry.failed || entry.released || entry.closed
        || !sameJson(entry.intent.payload.source, value.source)
        || entry.intent.payload.source_blob !== value.source_blob
        || entry.intent.payload.runtime !== value.runtime
        || !sameJson(entry.intent.payload.policy, value.policy)) {
        fail("branch_workspace_ready_invalid");
      }
      entry.ready = { row, payload: value };
      ordered.push({ row, name, payload: value });
      continue;
    }
    if (name === "branch/workspace_failed") {
      const parsed = branchWorkspaceReceiptSchemas["branch/workspace_failed"].safeParse(row.payload);
      if (!parsed.success) fail("branch_workspace_receipt_binding");
      const value = parsed.data;
      const entry = bind(value);
      if (!entry.intent || entry.ready || entry.failed || entry.released || entry.closed
        || !sameJson(entry.intent.payload.source, value.source)) {
        fail("branch_workspace_failed_invalid");
      }
      entry.failed = { row, payload: value };
      ordered.push({ row, name, payload: value });
      continue;
    }
    if (name === "branch/workspace_release") {
      const parsed = branchWorkspaceReceiptSchemas["branch/workspace_release"].safeParse(row.payload);
      if (!parsed.success) fail("branch_workspace_receipt_binding");
      const value = parsed.data;
      const entry = bind(value);
      if (!entry.ready || entry.failed || entry.released || entry.closed
        || !sameJson(entry.ready.payload.source, value.source)
        || !sameJson(entry.ready.payload.resource, value.resource)) {
        fail("branch_workspace_release_invalid");
      }
      entry.released = true;
      ordered.push({ row, name, payload: value });
      continue;
    }
    const parsed = branchWorkspaceReceiptSchemas["branch/workspace_closed"].safeParse(row.payload);
    if (!parsed.success) fail("branch_workspace_receipt_binding");
    const value = parsed.data;
    const entry = bind(value);
    if (!entry.ready || !entry.released || entry.closed
      || !sameJson(entry.ready.payload.source, value.source)
      || !sameJson(entry.ready.payload.resource, value.resource)) {
      fail("branch_workspace_closed_invalid");
    }
    entry.closed = true;
    ordered.push({ row, name, payload: value });
  }
  return { ordered, byId };
}

// ---------------------------------------------------------------------------
// Retained-evidence verification, shared by the live reader and cold replay.
// No live workspace, no source root, no spawn: only this log and its store.
// ---------------------------------------------------------------------------

/** Where a pure fold reads retained evidence bodies. The workspace host
 * reads its session's BlobStore; a cold retained-prefix verifier (R8-04
 * branch decisions) reads the exact same bodies from an inline bundle. The
 * type is the minimal seam both satisfy — the validator itself is shared,
 * never copied. */
export type RetainedBodyStore = Pick<BlobStore, "get">;

function retainedImage(events: readonly EventRecord[], store: RetainedBodyStore, digest: string, readySeq: number): ExecutionImage {
  const row = events.find(item => item.seq < readySeq && item.kind === "observe"
    && item.name === "execution_view/image" && item.payload.blob === digest);
  if (!row) fail("branch_workspace_image_row_missing");
  let text: string;
  try {
    text = store.get(digest);
  } catch (error) {
    return fail("branch_workspace_image_unavailable", error instanceof Error ? error.message : undefined);
  }
  if (typeof row.payload.blob_bytes !== "number" || row.payload.blob_bytes !== Buffer.byteLength(text)) {
    fail("branch_workspace_image_bytes");
  }
  try {
    const image = validateExecutionImage(JSON.parse(text));
    if (sha256Hex(canonicalJson(image)) !== digest) fail("branch_workspace_image_digest");
    return image;
  } catch (error) {
    if (error instanceof BranchWorkspaceError) throw error;
    return fail("branch_workspace_image_invalid");
  }
}

function verifyImageBodies(image: ExecutionImage, store: RetainedBodyStore): void {
  const read = (blob: string): string => {
    try {
      return store.get(blob);
    } catch (error) {
      return fail("branch_workspace_body_unavailable", error instanceof Error ? error.message : undefined);
    }
  };
  for (const tree of image.trees) {
    for (const entry of tree.entries) {
      if (entry.kind === "file") fileBytes(entry, read);
    }
  }
}

/** Verify one ready receipt against the retained evidence alone: the source
 * bundle authenticates, both images are digest-bound to their retained rows
 * and bodies, the derived image re-derives deterministically from the
 * original with the recorded layout and index digest, the historical model
 * metadata is exactly the source's, and the owner descriptor digest follows
 * deterministically from the receipt fields. */
export function verifyRetainedBranchWorkspace(
  events: readonly EventRecord[],
  store: RetainedBodyStore,
  payload: BranchWorkspaceReady,
  readySeq: number,
): void {
  let bundleText: string;
  try {
    bundleText = store.get(payload.source_blob);
  } catch (error) {
    return fail("branch_workspace_source_blob_unavailable", error instanceof Error ? error.message : undefined);
  }
  let parsedBundle: unknown;
  try {
    parsedBundle = JSON.parse(bundleText);
  } catch {
    return fail("branch_workspace_source_blob_invalid");
  }
  let facts: ImportedCheckpointSource;
  try {
    facts = validateImportedCheckpointSource(parsedBundle);
  } catch (error) {
    return fail("branch_workspace_source_refused", error instanceof Error ? error.message : undefined);
  }
  if (facts.sourceSession !== payload.source.session || facts.checkpointId !== payload.source.checkpoint
    || facts.checkpointDigest !== payload.source.digest
    || facts.head.seq !== payload.source.head.seq || facts.head.hash !== payload.source.head.hash) {
    fail("branch_workspace_source_binding");
  }
  if (!sameJson(payload.history, facts.state.metadata ?? {})) fail("branch_workspace_history_mismatch");
  const bundleManifest = (parsedBundle as { manifest?: { workspaceImage?: { digest?: unknown } } }).manifest;
  if (bundleManifest?.workspaceImage?.digest !== payload.original_image) fail("branch_workspace_original_binding");
  const read = (blob: string): string => {
    try {
      return store.get(blob);
    } catch (error) {
      return fail("branch_workspace_body_unavailable", error instanceof Error ? error.message : undefined);
    }
  };
  const originalImage = retainedImage(events, store, payload.original_image, readySeq);
  const derivedImage = retainedImage(events, store, payload.derived_image, readySeq);
  verifyImageBodies(originalImage, store);
  verifyImageBodies(derivedImage, store);
  if (originalImage.runtime !== payload.runtime || derivedImage.runtime !== payload.runtime) {
    fail("branch_workspace_runtime_binding");
  }
  const derivation = deriveBranchWorkspaceImage(originalImage, read, { workspace: payload.workspace });
  if (derivation.digest !== payload.derived_image || derivation.layout !== payload.layout
    || derivation.index !== payload.index || derivation.originalDigest !== payload.original_image) {
    fail("branch_workspace_derived_mismatch");
  }
  // The owner descriptor is deterministic in the receipt fields alone: cold
  // replay re-derives its digest without any live filesystem.
  if (sha256Hex(canonicalJson(ownerDescriptorOf(payload))) !== payload.resource.owner) {
    fail("branch_workspace_owner_binding");
  }
  if (payload.workspace !== join(payload.resource.root, "0")) fail("branch_workspace_workspace_binding");
}

// ---------------------------------------------------------------------------
// Current-state containment and the sole owned-resource deletion path.
// ---------------------------------------------------------------------------

/** Current containment of the live workspace: a real `.git` directory whose
 * configuration is still the exact inert bytes this host installed — no
 * helper, no linked-worktree or submodule metadata, no alternate object
 * store, no administrative pointer, no symlinked Git metadata, no nested
 * repository — and workspace symlinks that stay relative and internal.
 * Legitimate changed, added or committed files stay fine. */
function assertWorkspaceContainment(workspace: string): void {
  const dotGit = join(workspace, ".git");
  if (existsSync(dotGit)) {
    const stat = lstatSync(dotGit);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("branch_workspace_git_link_present");
    // Repository configuration is execution policy: it must remain the exact
    // inert bytes, so no include, worktree pointer, helper or alternate can
    // be introduced by editing it.
    const config = join(dotGit, "config");
    const configStat = lstatSync(config);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size !== INERT_CONFIG_BYTES
      || sha256Hex(readFileSync(config)) !== INERT_CONFIG_SHA) {
      fail("branch_workspace_config_changed");
    }
    const refused: readonly [string, string][] = [
      ["hooks", "branch_workspace_git_helper_present"],
      ["worktrees", "branch_workspace_git_pointer_present"],
      ["modules", "branch_workspace_submodule_present"],
      ["commondir", "branch_workspace_git_pointer_present"],
      ["gitdir", "branch_workspace_git_pointer_present"],
      ["objects/info/alternates", "branch_workspace_git_pointer_present"],
      ["objects/info/http-alternates", "branch_workspace_git_pointer_present"],
    ];
    for (const [path, code] of refused) {
      if (existsSync(join(dotGit, path))) fail(code);
    }
  }
  let visited = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (++visited > MAX_CONTAINMENT_ENTRIES) fail("branch_workspace_containment_limit");
      if (!name || /[\\\0\r\n]/u.test(name) || name.normalize("NFC") !== name) fail("branch_workspace_path_invalid");
      const full = join(dir, name), rel = relative(workspace, full);
      const segments = rel.split("/");
      if (segments.slice(1).some(segment => segment === ".git")) fail("branch_workspace_git_nested");
      const stat = lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(full);
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (rel === ".git" || rel.startsWith(".git/")) fail("branch_workspace_git_symlink");
        const target = readlinkSync(full);
        if (target.startsWith("/")) fail("branch_workspace_link_external");
        const resolved = resolve(dirname(full), target);
        if (resolved !== workspace && !within(workspace, resolved)) fail("branch_workspace_link_external");
        continue;
      }
      if (stat.isFile()) continue;
      fail("branch_workspace_file_type");
    }
  };
  walk(workspace);
}

/** Native Git reads retained metadata as data through the existing sealed
 * host boundary. No repository configuration, hook or helper executes. */
function assertInitialGit(workspace: string, layout: BranchWorkspaceGitLayout): void {
  if (layout === "none") return;
  const run = (args: string[], input?: string) => {
    const result = spawnSealedHostGit(workspace, args, { treeIndex: "state-as-data", ...(input === undefined ? {} : { input }) });
    if (result.exitCode !== 0) fail("branch_workspace_git_data_invalid");
    return result.stdout.toString("utf8");
  };
  // The sealed view can replace an unreadable/invalid HEAD with a harmless
  // placeholder. That protects its commands; it is not source authority.
  const recordedHead = readFileSync(join(workspace, ".git/HEAD"), "utf8");
  const reference = /^ref: (refs\/[^\r\n\0]+)\n?$/u.exec(recordedHead);
  if (reference) {
    run(["check-ref-format", reference[1]!]);
    if (run(["symbolic-ref", "-q", "HEAD"]).trim() !== reference[1]) fail("branch_workspace_git_head_invalid");
  } else if (!/^[a-fA-F0-9]{40}\n?$/u.test(recordedHead)) {
    fail("branch_workspace_git_head_invalid");
  }
  const head = spawnSealedHostGit(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.exitCode === 0) {
    const oid = head.stdout.toString("utf8").trim();
    if (!/^[a-f0-9]{40}$/u.test(oid)) fail("branch_workspace_git_format_unsupported");
    run(["cat-file", "-e", `${oid}^{commit}`]);
    run(["rev-list", "--objects", oid]);
  } else {
    // An unborn branch is valid only when no ref defines its commit yet.
    const ref = run(["symbolic-ref", "-q", "HEAD"]).trim();
    if (!ref.startsWith("refs/heads/") || run(["for-each-ref", "--format=%(refname)"]).split("\n").includes(ref)) {
      fail("branch_workspace_git_head_unavailable");
    }
  }
  const entries = run(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  const objects = new Set<string>();
  for (const entry of entries) {
    const match = /^([0-7]{6}) ([a-f0-9]{40}) [0-3]\t[^\0]+$/u.exec(entry);
    if (!match) fail("branch_workspace_git_index_invalid");
    if (!["100644", "100755", "120000"].includes(match[1]!)) fail("branch_workspace_git_index_unsupported");
    objects.add(match[2]!);
  }
  if (objects.size) {
    const ids = [...objects].sort();
    const result = run(["cat-file", "--batch-check"], ids.join("\n") + "\n").trimEnd().split("\n");
    if (result.length !== ids.length || result.some((line, index) => !line.startsWith(ids[index]! + " blob ") || !/ blob [0-9]+$/u.test(line))) {
      fail("branch_workspace_git_index_objects_missing");
    }
  }
}

/** The production mount gate, mapped into this module's refusal codes. */
function assertResourceUnmounted(root: string): void {
  try {
    assertNoOwnedResourceMounts(root);
  } catch (error) {
    if (error instanceof OwnedResourceMountError) {
      fail(error.code === "resource_mount_active" ? "branch_workspace_mount_active" : "branch_workspace_mount_table");
    }
    throw error;
  }
}

/** The sole deletion path of an owned resource root. The mount table is
 * checked before any traversal or chmod and rechecked immediately before
 * removal; the exact inode identity this caller verified must still be the
 * directory being removed. A refusal leaves the tree intact. */
function removeOwnedResource(root: string, expected: { uid: number; dev: number; ino: number }): void {
  assertResourceUnmounted(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expected.uid
    || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    fail("branch_workspace_resource_identity");
  }
  const unlock = (path: string): void => {
    const current = lstatSync(path);
    if (current.isDirectory() && !current.isSymbolicLink()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) unlock(join(path, name));
    }
  };
  unlock(root);
  assertResourceUnmounted(root);
  rmSync(root, { recursive: true, force: true });
}

/** The session identity of the log's own open row; the receipts are bound to
 * exactly this session. */
function governingSessionOf(events: readonly EventRecord[]): string | undefined {
  let session: string | undefined;
  for (const row of events) {
    if (row.name !== "session/open") continue;
    const id = row.payload.session_id ?? row.payload.id;
    if (typeof id === "string") session = id;
  }
  return session;
}

/** The full live ownership/containment verification of one recorded ready
 * workspace, as the workspace service's own read/release path applies it: the
 * mount table before any traversal, the resource root's inode identity
 * (uid/dev/ino/mode 0700), the mode0600 owner descriptor's identity, digest
 * and binding, and the current workspace containment. R8-03: the context
 * graph's boundary reassessment calls the SAME function — never a partial
 * copy — so a swapped resource container inode or a tampered marker refuses
 * identically wherever it is checked. No runtime/model authority here. */
export function verifyBranchWorkspaceLiveResource(payload: BranchWorkspaceReady): void {
  const root = payload.resource.root;
  assertResourceUnmounted(root);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch {
    return fail("branch_workspace_resource_unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== currentUid()
    || (rootStat.mode & 0o777) !== 0o700
    || rootStat.uid !== payload.root.uid || rootStat.dev !== payload.root.dev
    || rootStat.ino !== payload.root.ino || (rootStat.mode & 0o777) !== payload.root.mode) {
    fail("branch_workspace_resource_identity");
  }
  const ownerPath = join(root, "owner.json");
  let ownerStat: ReturnType<typeof lstatSync>;
  try {
    ownerStat = lstatSync(ownerPath);
  } catch {
    return fail("branch_workspace_owner_unavailable");
  }
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1
    || ownerStat.uid !== rootStat.uid || (ownerStat.mode & 0o777) !== 0o600) {
    fail("branch_workspace_owner_identity");
  }
  const ownerBytes = readFileSync(ownerPath);
  if (sha256Hex(ownerBytes) !== payload.resource.owner) fail("branch_workspace_owner_changed");
  let owner: unknown;
  try {
    owner = JSON.parse(ownerBytes.toString());
  } catch {
    return fail("branch_workspace_owner_invalid");
  }
  if (!sameJson(owner, ownerDescriptorOf(payload))) fail("branch_workspace_owner_binding");
  let workspaceStat: ReturnType<typeof lstatSync>;
  try {
    workspaceStat = lstatSync(payload.workspace);
  } catch {
    return fail("branch_workspace_workspace_unavailable");
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) fail("branch_workspace_workspace_invalid");
  assertWorkspaceContainment(payload.workspace);
}

/** The active closed lifecycle predicate (R8-03): the one shared ready
 * outcome for a session/workspace identifier — present, not failed, not
 * released, not closed — through the same lifecycle validator the host
 * writer and replay use. Anything else is unknown or spent authority. */
export function activeBranchWorkspaceReady(events: readonly EventRecord[], sessionId: string, id: string):
  { row: EventRecord; payload: BranchWorkspaceReady } | undefined {
  let lifecycle: BranchWorkspaceLifecycle;
  try {
    lifecycle = validateBranchWorkspaceLifecycle(events);
  } catch {
    return undefined;
  }
  const entry = lifecycle.byId.get(canonicalJson([sessionId, id]));
  if (!entry?.ready || entry.failed || entry.released || entry.closed) return undefined;
  return { row: entry.ready.row, payload: entry.ready.payload };
}

// ---------------------------------------------------------------------------
// The bound host-only service.
// ---------------------------------------------------------------------------

export interface BranchWorkspaceOptions {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly storageRoot: string;
  readonly runtimeExecutable: string;
  readonly modelPolicy: BranchWorkspaceModelPolicy;
  /** External resources this acquisition would need. None are capturable, so
   * any non-empty list refuses before any intent is recorded. */
  readonly requiredExternalResources?: readonly string[];
}

export interface BranchWorkspaceRequest {
  readonly id: string;
  readonly sourceLog: EventLog;
  readonly parentSession: string;
  readonly checkpointId: string;
  readonly checkpointDigest: string;
}

export interface BranchWorkspaceDescriptor {
  readonly id: string;
  readonly session: string;
  readonly workspace: string;
  readonly resource: Readonly<{ root: string; owner: string }>;
}

function appendWorkspaceFailed(log: EventLog, sessionId: string, id: string, source: unknown, error: unknown): void {
  const reason = error instanceof BranchWorkspaceError && REASON_PATTERN.test(error.code)
    ? error.code
    : "branch_workspace_acquire_failed";
  try {
    log.appendBatchDurable(() => [{
      kind: "observe",
      name: "branch/workspace_failed",
      payload: { schema: BRANCH_WORKSPACE_SCHEMA, id, session: sessionId, source, reason },
    }]);
  } catch {
    // The original failure stays fatal even when its receipt cannot land.
  }
}

export class BranchWorkspaceService {
  private readonly log: EventLog;
  private readonly sessionId: string;
  private readonly storageRoot: string;
  private readonly runtimeExecutable: string;
  private readonly modelPolicy: BranchWorkspaceModelPolicy;
  private readonly requiredExternalResources: readonly string[] | undefined;

  constructor(options: BranchWorkspaceOptions) {
    if (!options || typeof options !== "object") fail("branch_workspace_configuration_invalid");
    if (!options.log || typeof options.log.path !== "string" || !Array.isArray(options.log.events)) {
      fail("branch_workspace_configuration_invalid", "log");
    }
    if (typeof options.sessionId !== "string" || options.sessionId.length === 0
      || Buffer.byteLength(options.sessionId) > MAX_SESSION_ID_BYTES) {
      fail("branch_workspace_configuration_invalid", "sessionId");
    }
    if (typeof options.storageRoot !== "string" || !options.storageRoot.startsWith("/")
      || options.storageRoot.length > MAX_RESOURCE_ROOT_BYTES) {
      fail("branch_workspace_configuration_invalid", "storageRoot");
    }
    if (typeof options.runtimeExecutable !== "string" || !options.runtimeExecutable.startsWith("/")
      || options.runtimeExecutable.length > MAX_RESOURCE_ROOT_BYTES) {
      fail("branch_workspace_configuration_invalid", "runtimeExecutable");
    }
    const policy = modelPolicySchema.safeParse(options.modelPolicy);
    if (!policy.success) fail("branch_workspace_configuration_invalid", "modelPolicy");
    if (options.requiredExternalResources !== undefined
      && (!Array.isArray(options.requiredExternalResources)
        || options.requiredExternalResources.some(item => typeof item !== "string"))) {
      fail("branch_workspace_configuration_invalid", "requiredExternalResources");
    }
    this.log = options.log;
    this.sessionId = options.sessionId;
    this.storageRoot = options.storageRoot;
    this.runtimeExecutable = options.runtimeExecutable;
    this.modelPolicy = policy.data;
    this.requiredExternalResources = options.requiredExternalResources;
  }

  /** Acquire once: every closed precondition is checked before the durable
   * intent — including the feature generation and the full selection the
   * intent binds; the exclusive entry is allocated only after it; readiness
   * lands only from a durable callback whose admission guard re-verifies the
   * exact restored image, ownership and mount state. An exact confirmed
   * repeat answers from retained evidence with zero new rows; anything else
   * about a spent identifier refuses. */
  acquire(request: BranchWorkspaceRequest): BranchWorkspaceDescriptor {
    if (!request || typeof request !== "object") fail("branch_workspace_request_invalid");
    const { id, sourceLog, parentSession, checkpointId, checkpointDigest } = request;
    if (typeof id !== "string" || !BRANCH_WORKSPACE_ID_PATTERN.test(id)) fail("branch_workspace_id_invalid");
    if (!sourceLog || typeof sourceLog.path !== "string" || !Array.isArray(sourceLog.events)) {
      fail("branch_workspace_source_log_invalid");
    }
    if (typeof parentSession !== "string" || parentSession.length === 0
      || Buffer.byteLength(parentSession) > MAX_SESSION_ID_BYTES) {
      fail("branch_workspace_source_session_invalid");
    }
    if (typeof checkpointId !== "string" || !BRANCH_WORKSPACE_ID_PATTERN.test(checkpointId)) {
      fail("branch_workspace_source_checkpoint_invalid");
    }
    if (typeof checkpointDigest !== "string" || !DIGEST_PATTERN.test(checkpointDigest)) {
      fail("branch_workspace_source_digest_invalid");
    }
    if (this.log.isReadOnly) fail("branch_workspace_read_only");
    this.assertSessionBinding();
    if (this.requiredExternalResources && this.requiredExternalResources.length > 0) {
      fail("branch_workspace_external_resources_unavailable");
    }

    // Idempotence and conflict before any new evidence or allocation: a
    // ready resource answers only for the exact confirmed source.
    const existing = this.lifecycleEntry(id);
    if (existing.closed) fail("branch_workspace_closed");
    if (existing.failed) fail("branch_workspace_identifier_failed");
    if (existing.ready) {
      if (existing.released) fail("branch_workspace_release_unresolved");
      const ready = existing.ready.payload;
      if (ready.source.session !== parentSession || ready.source.checkpoint !== checkpointId
        || ready.source.digest !== checkpointDigest) {
        fail("branch_workspace_source_conflict");
      }
      return this.read(id);
    }
    if (existing.intent) fail("branch_workspace_intent_unresolved");

    // Everything verifiable without allocating: the portable source bundle,
    // the checkpoint image, the runtime digest and the storage isolation.
    const storageRoot = this.canonicalStorageRoot();
    let prepared: CheckpointImportBundle;
    let facts: ImportedCheckpointSource;
    let receipt: BranchCheckpointReceipt;
    try {
      prepared = prepareCheckpointInputImport(sourceLog, parentSession, checkpointId, checkpointDigest);
      facts = validateImportedCheckpointSource(prepared);
      receipt = readBranchCheckpoint(sourceLog, parentSession, checkpointId, checkpointDigest);
    } catch (error) {
      throw error instanceof BranchWorkspaceError
        ? error
        : new BranchWorkspaceError("branch_workspace_source_refused", error instanceof Error ? error.message : undefined);
    }
    const originalImage = receipt.manifest.workspaceImage.manifest;
    const originalDigest = receipt.manifest.workspaceImage.digest;
    let runtimeDigest: string;
    try {
      runtimeDigest = sha256Hex(readFileSync(this.runtimeExecutable));
    } catch (error) {
      return fail("branch_workspace_runtime_unavailable", error instanceof Error ? error.message : undefined);
    }
    if (runtimeDigest !== originalImage.runtime) fail("branch_workspace_runtime_mismatch");
    const targets = originalImage.trees.map(tree => tree.target);
    this.assertStorageIsolation(storageRoot, targets, this.log.path, sourceLog.path);

    const entryRoot = join(storageRoot, id);
    const workspace = join(entryRoot, "0");
    const sourceStore = BlobStore.forSession(sourceLog.path);
    const derivation = deriveBranchWorkspaceImage(
      originalImage,
      blob => {
        try {
          return sourceStore.get(blob);
        } catch (error) {
          return fail("branch_workspace_body_unavailable", error instanceof Error ? error.message : undefined);
        }
      },
      { workspace },
    );
    const source = {
      session: parentSession,
      checkpoint: checkpointId,
      digest: checkpointDigest,
      head: { seq: facts.head.seq, hash: facts.head.hash },
    };
    // The retained source bundle is durable evidence before the intent that
    // names it: an interrupted acquisition leaves the bundle rooted.
    const store = BlobStore.forSession(this.log.path);
    const bundleDigest = store.put(canonicalJson(prepared));

    try {
      this.log.appendBatchDurable(() => {
        if (this.log.events.some(row => row.name.startsWith("branch/workspace_") && row.payload.id === id)) {
          throw new Error("branch workspace identifier appeared before intent append");
        }
        return [{
          kind: "observe" as const,
          name: "branch/workspace_intent",
          payload: {
            schema: BRANCH_WORKSPACE_SCHEMA,
            id,
            session: this.sessionId,
            source,
            source_blob: bundleDigest,
            policy: this.modelPolicy,
            runtime: runtimeDigest,
          },
        }];
      });
    } catch (error) {
      throw error instanceof BranchWorkspaceError
        ? error
        : new BranchWorkspaceError("branch_workspace_intent_refused", error instanceof Error ? error.message : undefined);
    }

    let allocatedIdentity: { uid: number; dev: number; ino: number } | undefined;
    let published = false;
    let readyPublicationEntered = false;
    try {
      // Every image body: standard execution_view/source and
      // execution_view/image observations keep the whole evidence packable
      // and GC-safe without the source log.
      const bodies: Array<{ blob: string; blob_bytes: number }> = [];
      const seenBlobs = new Set<string>();
      for (const tree of originalImage.trees) {
        for (const entry of tree.entries) {
          if (entry.kind !== "file" || seenBlobs.has(entry.blob)) continue;
          const text = sourceStore.get(entry.blob);
          if (Buffer.byteLength(text) !== entry.blob_bytes) fail("branch_workspace_body_bytes");
          store.put(text);
          bodies.push({ blob: entry.blob, blob_bytes: entry.blob_bytes });
          seenBlobs.add(entry.blob);
        }
      }
      if (!seenBlobs.has(INERT_CONFIG_BLOB)) {
        store.put(inertConfigEnvelope);
        bodies.push({ blob: INERT_CONFIG_BLOB, blob_bytes: Buffer.byteLength(inertConfigEnvelope) });
      }
      this.log.appendBatch(() => {
        const retained = new Map<string, number>();
        for (const row of this.log.events) {
          if (row.name !== "execution_view/source") continue;
          const blob = String(row.payload.blob), bytes = Number(row.payload.blob_bytes);
          if (retained.has(blob) && retained.get(blob) !== bytes) fail("branch_workspace_source_record_changed");
          retained.set(blob, bytes);
        }
        return bodies.flatMap(item => {
          if (!retained.has(item.blob)) {
            return [{ kind: "observe" as const, name: "execution_view/source", payload: { blob: item.blob, blob_bytes: item.blob_bytes } }];
          }
          if (retained.get(item.blob) !== item.blob_bytes) fail("branch_workspace_source_record_changed");
          return [];
        });
      });
      const appendImageRow = (image: ExecutionImage): void => {
        const files = image.trees.reduce((sum, tree) => sum + tree.entries.length, 0);
        const bytes = image.trees.reduce((sum, tree) => sum + tree.entries.reduce(
          (inner, entry) => inner + (entry.kind === "file" ? entry.bytes : 0), 0), 0);
        store.putAndAppend(this.log, {
          kind: "observe",
          name: "execution_view/image",
          payload: { schema_version: 1, files, bytes },
        }, canonicalJson(image));
      };
      appendImageRow(originalImage);
      appendImageRow(derivation.manifest);

      // The exclusive owned entry, then its mode0600 owner descriptor: the
      // deterministic binding fields of the ready receipt, nothing else.
      try {
        mkdirSync(entryRoot, { mode: 0o700 });
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") fail("branch_workspace_entry_allocated");
        throw error;
      }
      const rootStat = lstatSync(entryRoot);
      if ((rootStat.mode & 0o777) !== 0o700 || rootStat.uid !== currentUid()) fail("branch_workspace_root_identity");
      allocatedIdentity = { uid: rootStat.uid, dev: rootStat.dev, ino: rootStat.ino };
      const rootIdentity = { ...allocatedIdentity, mode: 0o700 as const };
      const readyPayload = {
        schema: BRANCH_WORKSPACE_SCHEMA,
        id,
        session: this.sessionId,
        source,
        source_blob: bundleDigest,
        original_image: originalDigest,
        derived_image: derivation.digest,
        layout: derivation.layout,
        index: derivation.index,
        config: "inert_v1" as const,
        policy: this.modelPolicy,
        history: structuredClone(facts.state.metadata ?? {}),
        runtime: runtimeDigest,
        resource: { root: entryRoot, owner: "" },
        root: rootIdentity,
        workspace,
      };
      const owner = canonicalJson(ownerDescriptorOf(readyPayload));
      const ownerDigest = sha256Hex(owner);
      readyPayload.resource = { root: entryRoot, owner: ownerDigest };
      writeFileSync(join(entryRoot, "owner.json"), owner, { mode: 0o600, flag: "wx" });

      // Materialize through the one existing image materializer, then verify
      // the restored tree byte-exact against the derived image.
      materializeExecutionImageInto(this.log, derivation.digest, derivation.manifest, entryRoot);
      assertResourceUnmounted(entryRoot);
      assertInitialGit(workspace, derivation.layout);
      assertImageSources(derivation.manifest, store, [workspace]);

      this.log.appendBatchDurable(() => {
        const current = this.lifecycleEntry(id);
        if (!current.intent || current.ready || current.failed || current.released || current.closed) {
          throw new Error("branch workspace lifecycle changed before ready");
        }
        // Admission guard: the exact restored image, the ownership of the
        // allocated root and its mount state must still hold at admission
        // time — a pre-admission edit refuses the whole publication.
        const stat = lstatSync(entryRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== allocatedIdentity!.uid
          || stat.dev !== allocatedIdentity!.dev || stat.ino !== allocatedIdentity!.ino
          || (stat.mode & 0o777) !== 0o700) {
          throw new Error("branch workspace root identity changed before admission");
        }
        if (sha256Hex(readFileSync(join(entryRoot, "owner.json"))) !== ownerDigest) {
          throw new Error("branch workspace owner changed before admission");
        }
        assertResourceUnmounted(entryRoot);
        assertImageSources(derivation.manifest, store, [workspace]);
        readyPublicationEntered = true;
        return [{
          kind: "observe" as const,
          name: "branch/workspace_ready",
          payload: readyPayload,
        }];
      });
      published = true;
    } catch (error) {
      // A validated publication may have reached durable storage even when
      // its acknowledgement throws. Retain its resource; reconnect reads the
      // actual outcome. Neither rollback nor a failure row is authoritative.
      if (readyPublicationEntered) fail("branch_workspace_publication_unknown");
      let cleanupUnknown = false;
      if (allocatedIdentity && !published) {
        // Reclaim only through the sole deletion path: mount-checked and
        // inode-bound. A refused cleanup leaves the allocated entry intact —
        // the unresolved intent is then the explicit unknown marker and no
        // clean failure is recorded for a resource that was not reclaimed.
        try {
          removeOwnedResource(entryRoot, allocatedIdentity);
        } catch {
          cleanupUnknown = true;
        }
      }
      if (!cleanupUnknown) {
        // Nothing was allocated, or the allocation was fully reclaimed: the
        // failure is clean and known.
        appendWorkspaceFailed(this.log, this.sessionId, id, source, error);
      }
      throw error instanceof BranchWorkspaceError
        ? error
        : new BranchWorkspaceError("branch_workspace_acquire_failed", error instanceof Error ? error.message : undefined);
    }
    return this.read(id);
  }

  /** Verified read: the stateless retained-evidence verification plus the
   * immutable ownership binding and current containment. Read appends
   * nothing and works on a read-only handle. */
  /** A live admission must use the workspace owner of the same child log. */
  isBoundTo(log: EventLog, sessionId: string): boolean {
    return !this.log.isReadOnly && this.sessionId === sessionId && resolve(this.log.path) === resolve(log.path);
  }

  read(id: string): BranchWorkspaceDescriptor {
    if (typeof id !== "string" || !BRANCH_WORKSPACE_ID_PATTERN.test(id)) fail("branch_workspace_id_invalid");
    this.assertSessionBinding();
    const entry = this.lifecycleEntry(id);
    if (!entry.intent) fail("branch_workspace_unknown");
    if (entry.failed) fail("branch_workspace_identifier_failed");
    if (!entry.ready) fail("branch_workspace_intent_unresolved");
    if (entry.released && !entry.closed) fail("branch_workspace_release_unresolved");
    if (entry.closed) fail("branch_workspace_closed");
    return this.verifyResource(entry.ready.row).descriptor;
  }

  /** Release exactly one owned resource: every check precedes the durable
   * release receipt; after the receipt — append observers may have replaced
   * the root — the live ownership, containment, writers and mounts are
   * reverified immediately before the sole deletion path runs; the closure
   * receipt lands last, and a closure that cannot land is an explicit
   * unknown, never a silent success. A confirmed closure is idempotent. */
  release(id: string): void {
    if (typeof id !== "string" || !BRANCH_WORKSPACE_ID_PATTERN.test(id)) fail("branch_workspace_id_invalid");
    if (this.log.isReadOnly) fail("branch_workspace_read_only");
    this.assertSessionBinding();
    const entry = this.lifecycleEntry(id);
    if (entry.closed) return;
    if (!entry.intent || entry.failed || !entry.ready) fail("branch_workspace_unknown");
    if (entry.released) fail("branch_workspace_release_unresolved");
    const verified = this.verifyResource(entry.ready.row);
    const payload = verified.payload;
    this.assertNoLiveWriters(payload.workspace);
    const resource = { root: payload.resource.root, owner: payload.resource.owner };
    try {
      this.log.appendBatchDurable(() => [{
        kind: "observe" as const,
        name: "branch/workspace_release",
        payload: { schema: BRANCH_WORKSPACE_SCHEMA, id, session: this.sessionId, source: payload.source, resource },
      }]);
    } catch (error) {
      throw new BranchWorkspaceError("branch_workspace_release_refused", error instanceof Error ? error.message : undefined);
    }
    // The durable intent may have run append observers that replaced the
    // root: reverify the live resource, then delete exactly this inode.
    verifyBranchWorkspaceLiveResource(payload);
    this.assertNoLiveWriters(payload.workspace);
    removeOwnedResource(resource.root, { uid: payload.root.uid, dev: payload.root.dev, ino: payload.root.ino });
    try {
      this.log.appendBatchDurable(() => [{
        kind: "observe" as const,
        name: "branch/workspace_closed",
        payload: { schema: BRANCH_WORKSPACE_SCHEMA, id, session: this.sessionId, source: payload.source, resource },
      }]);
    } catch (error) {
      // The removal is done and its receipt is missing: the pending release
      // is an explicit unknown, never retried automatically.
      throw new BranchWorkspaceError("branch_workspace_closure_unknown", error instanceof Error ? error.message : undefined);
    }
  }

  /** The writer's own gate: this session's open row must carry the current
   * replay feature generation, and the receipts bind exactly this session. */
  private assertSessionBinding(): void {
    this.log.refresh();
    if (projectSessionReplaySchemas(this.log.events).featureStart.get(BRANCH_WORKSPACE_SCHEMA) === undefined) {
      fail("branch_workspace_feature_generation");
    }
    const governing = governingSessionOf(this.log.events);
    if (governing === undefined || governing !== this.sessionId) fail("branch_workspace_session_binding");
  }

  private lifecycleEntry(id: string): BranchWorkspaceLifecycleEntry {
    const lifecycle = validateBranchWorkspaceLifecycle(this.log.events);
    return lifecycle.byId.get(canonicalJson([this.sessionId, id])) ?? { released: false, closed: false };
  }

  private assertNoLiveWriters(workspace: string): void {
    const writers = liveWritersOf(workspace);
    if (writers.length > 0) fail("branch_workspace_live_writers", writers[0]);
  }

  private canonicalStorageRoot(): string {
    let real: string;
    try {
      real = realpathSync(this.storageRoot);
    } catch {
      return fail("branch_workspace_storage_unavailable");
    }
    if (real !== this.storageRoot) fail("branch_workspace_storage_canonical");
    const stat = lstatSync(real);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() || (stat.mode & 0o777) !== 0o700) {
      fail("branch_workspace_storage_identity");
    }
    return real;
  }

  /** The storage root is outside every captured image root and both session
   * logs, in both directions: nothing allocated here can write the parent
   * trees or the evidence, and neither log can land inside an allocation. */
  private assertStorageIsolation(storageRoot: string, targets: readonly string[], childLogPath: string, sourceLogPath: string): void {
    for (const target of targets) {
      if (within(target, storageRoot) || within(storageRoot, target)) fail("branch_workspace_storage_overlap");
    }
    for (const logPath of [childLogPath, sourceLogPath]) {
      let area: string;
      try {
        area = realpathSync(dirname(logPath));
      } catch {
        return fail("branch_workspace_storage_overlap");
      }
      if (within(area, storageRoot) || within(storageRoot, area)) fail("branch_workspace_storage_overlap");
    }
  }

  /** The full immutable-and-current verification behind read and release. */
  private verifyResource(readyRow: EventRecord): { payload: BranchWorkspaceReady; descriptor: BranchWorkspaceDescriptor } {
    const parsed = branchWorkspaceReceiptSchemas["branch/workspace_ready"].safeParse(readyRow.payload);
    if (!parsed.success) fail("branch_workspace_ready_invalid");
    const payload = parsed.data;
    verifyRetainedBranchWorkspace(this.log.events, BlobStore.forSession(this.log.path), payload, readyRow.seq);

    // The recorded runtime/model selection is immutable authority: the live
    // executable must still hash to the captured runtime digest and the
    // configured policy must equal the recorded one.
    let runtimeDigest: string;
    try {
      runtimeDigest = sha256Hex(readFileSync(this.runtimeExecutable));
    } catch (error) {
      return fail("branch_workspace_runtime_unavailable", error instanceof Error ? error.message : undefined);
    }
    if (runtimeDigest !== payload.runtime) fail("branch_workspace_runtime_mismatch");
    if (!sameJson(this.modelPolicy, payload.policy)) fail("branch_workspace_policy_mismatch");

    const storageRoot = this.canonicalStorageRoot();
    if (dirname(payload.resource.root) !== storageRoot || basename(payload.resource.root) !== payload.id) {
      fail("branch_workspace_resource_moved");
    }
    if (payload.workspace !== join(payload.resource.root, "0")) fail("branch_workspace_workspace_binding");
    verifyBranchWorkspaceLiveResource(payload);
    const descriptor: BranchWorkspaceDescriptor = Object.freeze({
      id: payload.id,
      session: payload.session,
      workspace: payload.workspace,
      resource: Object.freeze({ root: payload.resource.root, owner: payload.resource.owner }),
    });
    return { payload, descriptor };
  }
}
