import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { EventLog } from "./event-log.ts";
import type { EventInput } from "./schema.ts";
import { acquireBlobGcScope } from "./blob-gc-scope.ts";
import {
  assembleBody, CHAIN_LIMIT, decodeManifest, encodeManifest, hollowBody, LIST_SIZE, type Manifest, manifestReferences,
  manifestSegments, manifestTextParts, parseStoredFile, partsClosure, PartsIntegrityError, type PartsSource, type ResolvedManifest,
  runsOf, sha256, splitBody, splitSignature, type StoredKind, storedName,
} from "./blob-parts.ts";

const DIGEST = /^[0-9a-f]{64}$/;

export class BlobIntegrityError extends Error {
  readonly code = "blob_integrity" as const;

  constructor(readonly digest: string, detail?: string) {
    super(`blob content digest mismatch for sha256:${digest.slice(0, 7)}...${detail ? ` (${detail})` : ""}`);
    this.name = "BlobIntegrityError";
  }
}

/** A body stored as parts by `putParts`: the files that call created (to be
 * made durable before the row that names the body is appended) and the
 * commit that lets later bodies of the same stream chain to it once that row
 * is appended. */
export interface StoredParts {
  digest: string;
  written: string[];
  commit(): void;
}

/** The chain state of one writer (one session log): per stream, the last
 * committed manifest with each array's element digests, and the part and
 * list files this writer has checked on disk. */
export class PartsWriter {
  readonly heads = new Map<string, { digest: string; depth: number; runs: string[][]; manifest: string }>();
  readonly known = new Set<string>();
}

/** What the sampled durable reload read and checked (each stored file once). */
export interface StoredFileMemo {
  files: Set<string>;
  depths: Map<string, number>;
  filesRead: number;
  bytesRead: number;
}
export function storedFileMemo(): StoredFileMemo {
  return { files: new Set(), depths: new Map(), filesRead: 0, bytesRead: 0 };
}
export type VerifiedBody =
  | { layout: "whole"; text: string }
  | { layout: "parts"; manifest: Manifest; hollow: string };

const PART_CACHE_BYTES = 32 * 1024 * 1024;
const RESOLVED_CACHE = 4;

function writeFileAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
  try { renameSync(temp, path); } catch (error) {
    try { unlinkSync(temp); } catch { /* the rename's error is the one reported */ }
    throw error;
  }
}

/**
 * Content-addressed blob store beside the session log (issue #18): raw tool
 * stdout and graph bodies never enter the JSONL — events carry digests, the
 * store holds the bytes under 0600 files sharded by the digest prefix.
 *
 * A provider payload or send body may instead be stored as parts (D53,
 * blob-parts.ts): `<digest>.manifest` plus `.part` and `.list` files shared
 * by every body of the session. `get` returns the same bytes either way and
 * checks them against the digest; `has` answers for either layout.
 *
 * GC (0.1.0): anything on disk that no event's `payload.blob` still names —
 * directly, or through a named body's manifests — is orphan data. Plugin
 * digests and plan digests are not blob references.
 */
export class BlobStore {
  /** Checked parts this handle has read, least recently used first. */
  private readonly partCache = new Map<string, string>();
  private partCacheBytes = 0;
  private readonly resolved = new Map<string, ResolvedManifest>();

  constructor(readonly root: string) {}

  /** The blob store that lives next to a session log: sessions/<id>/blobs. */
  static forSession(logPath: string): BlobStore {
    return new BlobStore(join(dirname(logPath), "blobs"));
  }

  /** Store a body; returns its sha256 digest. Same bytes, same digest. */
  put(body: string): string {
    const digest = createHash("sha256").update(body).digest("hex");
    const path = this.pathOf(digest);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, body, { mode: 0o600 });
    }
    return digest;
  }

  /** Write the blob first, then append. A put failure never touches the log. */
  putAndAppend(log: EventLog, event: EventInput, body: string): string {
    const digest = this.put(body);
    log.append({
      ...event,
      payload: { ...(event.payload ?? {}), blob: digest, blob_bytes: Buffer.byteLength(body) },
    });
    return digest;
  }

  /**
   * Store a body as parts, chained to the last body `writer` committed for
   * `stream` while the arrays it carries only grow. Undefined when the body
   * is already stored whole or cannot be split: the caller stores it whole.
   *
   * Nothing is trusted that was not checked: every file this call writes is
   * read back and checked against its digest, a part already on disk that
   * this writer has not checked is read and checked (a damaged one is
   * rewritten), and the body is reassembled from the manifest as written —
   * its base as committed — and must give `body`'s digest and length, or the
   * body is stored whole instead.
   */
  putParts(body: string, writer: PartsWriter, stream: string): StoredParts | undefined {
    const digest = sha256(body);
    if (existsSync(this.pathOf(digest))) return undefined;
    const manifestPath = this.fileOf(storedName(digest, "manifest"));
    if (existsSync(manifestPath)) {
      // A retry after an append that did not happen: the parts are stored.
      try { if (this.readParts(digest) === body) return { digest, written: [], commit() {} }; } catch { /* stored whole below */ }
      return undefined;
    }
    let plan: ReturnType<BlobStore["planParts"]>;
    // Splitting is pure: a body it cannot handle is stored whole, never refused.
    try { plan = this.planParts(body, digest, writer, stream); } catch { return undefined; }
    if (!plan) return undefined;
    if (plan.stale) {
      writer.known.clear();
      writer.heads.clear();
    }
    const written: string[] = [], ensured = new Set<string>();
    const ensure = (name: string, content: string, checksum: string): void => {
      if (writer.known.has(name) || ensured.has(name)) return;
      const path = this.fileOf(name);
      if (!existsSync(path) || sha256(readFileSync(path)) !== checksum) {
        writeFileAtomic(path, content);
        if (sha256(readFileSync(path)) !== checksum) throw new PartsIntegrityError(digest, "a written part differs");
        written.push(path);
      }
      ensured.add(name);
    };
    try {
      for (const [item, text] of plan.texts) ensure(storedName(item, "part"), text, item);
      for (const [list, text] of plan.lists) ensure(storedName(list, "list"), text, list);
      writeFileAtomic(manifestPath, plan.encoded);
      written.push(manifestPath);
      // Reassemble from the manifest as it now is on disk, its base as committed.
      const cache = new Map<string, ResolvedManifest>();
      if (plan.base) cache.set(plan.base.digest, { manifest: decodeManifest(plan.base.manifest, plan.base.digest), runs: plan.base.runs });
      const source: PartsSource = {
        manifest: name => name === digest ? readFileSync(manifestPath, "utf8") : undefined,
        list: list => plan.lists.get(list),
        part: item => plan.texts.get(item),
      };
      // `body` hashes to `digest`: equal text is the recorded digest.
      assembleBody(digest, source, cache, body);
    } catch (error) {
      if (!(error instanceof PartsIntegrityError)) throw error;
      // Never leave a manifest that does not reassemble; the parts are
      // orphans until a later body names them or GC removes them.
      try { if (existsSync(manifestPath)) unlinkSync(manifestPath); } catch { /* GC removes it */ }
      return undefined;
    }
    return {
      digest, written,
      commit: () => {
        for (const name of ensured) writer.known.add(name);
        writer.heads.set(plan.key, { digest, depth: plan.manifest.depth, runs: plan.digests, manifest: plan.encoded });
      },
    };
  }

  /** The manifest, parts and lists of a split body (no file is touched but
   * the base manifest, read to confirm it is still what was committed). */
  private planParts(body: string, digest: string, writer: PartsWriter, stream: string) {
    const pieces = splitBody(body);
    if (!pieces) return undefined;
    const runs = runsOf(pieces), key = `${stream}\n${splitSignature(pieces)}`;
    const digests = runs.map(run => run.items.map(item => sha256(item)));
    const texts = new Map<string, string>(), lists = new Map<string, string>();
    runs.forEach((run, index) => run.items.forEach((item, at) => texts.set(digests[index]![at]!, item)));
    let base = writer.heads.get(key);
    // A head whose manifest is no longer what was committed means the store
    // changed under this writer: nothing it checked before is trusted.
    const stale = base !== undefined && !this.fileHolds(storedName(base.digest, "manifest"), base.manifest);
    if (base && (stale || base.depth + 1 >= CHAIN_LIMIT || base.runs.length !== runs.length)) base = undefined;
    const keeps = digests.map((items, index) => {
      const prior = base?.runs[index] ?? [];
      let kept = 0;
      while (kept < prior.length && kept < items.length && prior[kept] === items[kept]) kept += 1;
      return kept;
    });
    const kept = keeps.reduce((sum, value) => sum + value, 0);
    const added = digests.reduce((sum, items, index) => sum + items.length - keeps[index]!, 0);
    // A chain continues while it keeps at least what it adds; a replace
    // (compaction, reseed, a new prefix) or the chain limit starts a full one.
    if (!base || kept === 0 || kept < added) base = undefined;
    const segments = manifestSegments(pieces, index => {
      const items = digests[index]!;
      if (base) return { keep: keeps[index]!, parts: items.slice(keeps[index]!) };
      const whole = Math.floor(items.length / LIST_SIZE) * LIST_SIZE, named: string[] = [];
      for (let at = 0; at < whole; at += LIST_SIZE) {
        const listed = JSON.stringify(items.slice(at, at + LIST_SIZE)), list = sha256(listed);
        lists.set(list, listed);
        named.push(list);
      }
      return { ...(named.length ? { lists: named } : {}), parts: items.slice(whole) };
    }, text => {
      const item = sha256(text);
      texts.set(item, text);
      return item;
    });
    const manifest: Manifest = { base: base ? base.digest : null, bytes: Buffer.byteLength(body),
      depth: base ? base.depth + 1 : 0, digest, segments };
    return { key, digests, texts, lists, base, manifest, encoded: encodeManifest(manifest), stale };
  }

  /** Read a body back by digest, in either layout, checked against the digest.
   * Fails explicitly when absent; a damaged or incomplete split body fails
   * with BlobIntegrityError. */
  get(digest: string): string {
    if (!DIGEST.test(digest)) {
      throw new Error(`blob digest must be 64 hex chars, got ${JSON.stringify(digest)}`);
    }
    const path = this.pathOf(digest);
    if (existsSync(path)) {
      const body = readFileSync(path, "utf8");
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== digest) {
        throw new BlobIntegrityError(digest);
      }
      return body;
    }
    if (existsSync(this.fileOf(storedName(digest, "manifest")))) {
      return this.readParts(digest);
    }
    throw new Error(`missing blob ${digest} under ${this.root}`);
  }

  /** Whether a body is stored, in either layout (its parts are not read). */
  has(digest: string): boolean {
    return DIGEST.test(digest) && (existsSync(this.pathOf(digest)) || existsSync(this.fileOf(storedName(digest, "manifest"))));
  }

  /** Whether a body is stored as parts (its manifest exists). */
  hasParts(digest: string): boolean {
    return DIGEST.test(digest) && !existsSync(this.pathOf(digest)) && existsSync(this.fileOf(storedName(digest, "manifest")));
  }

  /** Absolute path of a whole-body digest file (whether or not it exists). */
  pathOf(digest: string): string {
    return join(this.root, digest.slice(0, 2), digest);
  }

  /** Absolute path of a stored file name (`ab/<digest>[.part|.list|.manifest]`). */
  fileOf(name: string): string {
    return join(this.root, name);
  }

  /** Delete one digest file. Returns bytes removed, or 0 if absent. */
  remove(digest: string): number {
    if (!DIGEST.test(digest)) {
      return 0;
    }
    return this.removeFile(storedName(digest, "whole"));
  }

  /** Delete one stored file by name. Returns bytes removed, or 0 if absent. */
  removeFile(name: string): number {
    const [shard, file] = name.split("/");
    if (!shard || !file || !parseStoredFile(shard, file)) {
      return 0;
    }
    const path = this.fileOf(name);
    if (!existsSync(path)) {
      return 0;
    }
    const bytes = statSync(path).size;
    // unlink the file; rmdir empty shard best-effort (some FS reject rm on dirs).
    unlinkSync(path);
    const dir = dirname(path);
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
      }
    } catch {
      // Leaving an empty shard is harmless; the next put recreates as needed.
    }
    return bytes;
  }

  /** The stored file names a body needs: its whole file, or its manifest,
   * the manifests it chains to, their lists and parts (manifests and lists
   * are read and checked; parts are only named). Names in `seen` are skipped. */
  bodyFiles(digest: string, seen: Set<string> = new Set()): string[] {
    const whole = storedName(digest, "whole");
    if (existsSync(this.fileOf(whole))) {
      if (seen.has(whole)) return [];
      seen.add(whole);
      return [whole];
    }
    return partsClosure(digest, name => {
      const path = this.fileOf(name);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }, seen);
  }

  /**
   * The sampled durable reload's read of one body (D53). A whole body is read
   * and checked against its digest, as always. A split body's manifest, the
   * manifests it chains to, their lists and parts are each read and checked
   * against their own digest once per `memo` — so a reload reads the session's
   * unique bytes, not every body — and the body's skeleton is returned with
   * its arrays emptied. That the files reassemble to the body's digest was
   * checked when the body was written; files that still match their own
   * digests reassemble to the same bytes.
   */
  verifyBody(digest: string, memo: StoredFileMemo): VerifiedBody {
    if (!DIGEST.test(digest)) throw new Error(`blob digest must be 64 hex chars, got ${JSON.stringify(digest)}`);
    const path = this.pathOf(digest);
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      memo.filesRead += 1;
      memo.bytesRead += bytes.length;
      const text = bytes.toString("utf8");
      if (sha256(text) !== digest) throw new BlobIntegrityError(digest);
      return { layout: "whole", text };
    }
    if (!existsSync(this.fileOf(storedName(digest, "manifest")))) throw new Error(`missing blob ${digest} under ${this.root}`);
    try {
      const manifest = this.verifyManifest(digest, memo, 0);
      // The skeleton's own large text is read again for the skeleton; the
      // arrays' elements are not.
      const texts = new Map<string, string>();
      for (const part of manifestTextParts(manifest)) if (!texts.has(part)) texts.set(part, this.readChecked(part, "part", memo));
      return { layout: "parts", manifest, hollow: hollowBody(manifest, part => texts.get(part)!) };
    } catch (error) {
      if (error instanceof PartsIntegrityError) throw new BlobIntegrityError(digest, error.message);
      throw error;
    }
  }

  private verifyManifest(digest: string, memo: StoredFileMemo, depth: number): Manifest {
    if (depth >= CHAIN_LIMIT) throw new PartsIntegrityError(digest, "manifest chain is too long");
    const name = storedName(digest, "manifest"), path = this.fileOf(name);
    if (!existsSync(path)) throw new PartsIntegrityError(digest, "manifest is missing");
    const bytes = readFileSync(path);
    memo.filesRead += 1;
    memo.bytesRead += bytes.length;
    const manifest = decodeManifest(bytes.toString("utf8"), digest);
    if (manifest.base !== null) {
      const baseName = storedName(manifest.base, "manifest");
      if (!memo.files.has(baseName)) this.verifyManifest(manifest.base, memo, depth + 1);
      if (memo.depths.get(manifest.base) !== manifest.depth - 1) throw new PartsIntegrityError(digest, "manifest depth differs from its base");
    }
    const { lists, parts } = manifestReferences(manifest);
    for (const list of lists) {
      if (memo.files.has(storedName(list, "list"))) continue;
      let items: unknown;
      try { items = JSON.parse(this.readChecked(list, "list", memo)); } catch (error) {
        throw error instanceof PartsIntegrityError ? error : new PartsIntegrityError(digest, "list is not JSON");
      }
      if (!Array.isArray(items)) throw new PartsIntegrityError(digest, "list is malformed");
      for (const item of items) {
        if (typeof item !== "string" || !DIGEST.test(item)) throw new PartsIntegrityError(digest, "list is malformed");
        if (!memo.files.has(storedName(item, "part"))) this.readChecked(item, "part", memo);
      }
    }
    for (const part of parts) if (!memo.files.has(storedName(part, "part"))) this.readChecked(part, "part", memo);
    memo.files.add(name);
    memo.depths.set(digest, manifest.depth);
    return manifest;
  }

  /** A part's or list's text, checked against its digest (counted in `memo`). */
  private readChecked(digest: string, kind: "part" | "list", memo?: StoredFileMemo): string {
    const name = storedName(digest, kind), path = this.fileOf(name);
    if (!existsSync(path)) throw new PartsIntegrityError(digest, `${kind} sha256:${digest.slice(0, 7)}... is missing`);
    const bytes = readFileSync(path);
    if (memo) {
      memo.filesRead += 1;
      memo.bytesRead += bytes.length;
    }
    if (sha256(bytes) !== digest) throw new PartsIntegrityError(digest, `${kind} sha256:${digest.slice(0, 7)}... does not match its digest`);
    memo?.files.add(name);
    return bytes.toString("utf8");
  }

  private fileHolds(name: string, content: string): boolean {
    try { return readFileSync(this.fileOf(name), "utf8") === content; } catch { return false; }
  }

  /** Reassemble a split body. Parts read through this handle are cached
   * (bounded): each was checked against its digest when read, and the body
   * is checked against its own digest on every call. */
  private readParts(digest: string): string {
    const source: PartsSource = {
      manifest: name => {
        const path = this.fileOf(storedName(name, "manifest"));
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
      },
      list: list => existsSync(this.fileOf(storedName(list, "list"))) ? this.readChecked(list, "list") : undefined,
      part: item => {
        const cached = this.partCache.get(item);
        if (cached !== undefined) {
          this.partCache.delete(item);
          this.partCache.set(item, cached);
          return cached;
        }
        if (!existsSync(this.fileOf(storedName(item, "part")))) return undefined;
        const text = this.readChecked(item, "part");
        this.partCache.set(item, text);
        this.partCacheBytes += text.length;
        for (const [old, value] of this.partCache) {
          if (this.partCacheBytes <= PART_CACHE_BYTES) break;
          this.partCache.delete(old);
          this.partCacheBytes -= value.length;
        }
        return text;
      },
    };
    try {
      const body = assembleBody(digest, source, this.resolved);
      while (this.resolved.size > RESOLVED_CACHE) this.resolved.delete(this.resolved.keys().next().value!);
      return body;
    } catch (error) {
      this.resolved.clear();
      if (error instanceof PartsIntegrityError) throw new BlobIntegrityError(digest, error.message);
      throw error;
    }
  }
}

type Logged = { name?: string; payload?: Record<string, unknown> };

/**
 * Digests the session log still needs. `payload.blob` names an event body
 * (a `tool/source` row names its recorded tool-result source this way);
 * `payload.source_blob` names typed evidence retained by MAEK provenance;
 * `payload.source_refs` (#223 R4') lists the tool-result sources a retained
 * consumer still holds — an active lesson or frame (#227), a batch child
 * (#228) — as digests or `{ digest }` records; an entry counts only for a
 * source the log recorded, so the source outlives the transcript message it
 * came from and nothing else can be rooted through it. Plugin digests, plan digests, and args
 * digests name other things.
 */
export function collectReferencedBlobs(events: readonly Logged[]): Set<string> {
  const refs = new Set<string>();
  // Tool-result sources the log itself recorded (a host-minted `tool/source`
  // row, or a historical `tool/result` body): the only digests a
  // `source_refs` entry can hold alive (#223 R4'). A digest named nowhere
  // else by a typed row roots nothing, however it got into a payload.
  const sources = new Set<string>();
  for (const event of events) {
    for (const field of [event.payload?.blob, event.payload?.source_blob]) {
      if (typeof field === "string" && DIGEST.test(field)) {
        refs.add(field);
      }
    }
    if ((event.name === "tool/source" || event.name === "tool/result") && typeof event.payload?.blob === "string") sources.add(event.payload.blob);
  }
  for (const event of events) {
    const held = event.payload?.source_refs;
    if (!Array.isArray(held)) continue;
    for (const item of held) {
      const digest = typeof item === "string" ? item
        : item && typeof item === "object" ? (item as { digest?: unknown }).digest : undefined;
      if (typeof digest === "string" && sources.has(digest)) refs.add(digest);
    }
  }
  return refs;
}

/** Every stored file under the store: whole bodies, parts, lists and
 * manifests, as `ab/<name>` with the digest and kind the name gives. */
export function listStoredFiles(store: BlobStore): Array<{ name: string; digest: string; kind: StoredKind }> {
  if (!existsSync(store.root)) {
    return [];
  }
  const out: Array<{ name: string; digest: string; kind: StoredKind }> = [];
  for (const shard of readdirSync(store.root)) {
    if (!/^[0-9a-f]{2}$/.test(shard)) {
      continue;
    }
    const dir = join(store.root, shard);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const parsed = parseStoredFile(shard, name);
      if (parsed) {
        out.push({ name: `${shard}/${name}`, ...parsed });
      }
    }
  }
  return out;
}

/** Every well-formed whole-body digest file currently under the store. */
export function listBlobDigests(store: BlobStore): string[] {
  return listStoredFiles(store).filter(file => file.kind === "whole").map(file => file.digest);
}

/** Every stored file the bodies `digests` need, each once (whole files, or a
 * split body's manifests, lists and parts). `complete` is false when a split
 * body's manifest, a manifest it chains to, or a list could not be read: its
 * files are then unknown. A digest nothing on disk stores is a gap, not an
 * unknown. */
export function referencedStoredFiles(store: BlobStore, digests: Iterable<string>): { names: Set<string>; complete: boolean } {
  const names = new Set<string>();
  let complete = true;
  for (const digest of digests) {
    if (!store.has(digest)) continue;
    try { store.bodyFiles(digest, names); } catch { complete = false; }
  }
  return { names, complete };
}

export interface BlobGcResult {
  dry_run: boolean;
  kept: number;
  removed: string[];
  bytes_freed: number;
  referenced: number;
  on_disk: number;
  /** A refused collection records counts but never mutates stored files. */
  refused?: string;
}

export interface BlobGcRoots {
  roots: Iterable<string>;
  complete: boolean;
}

/**
 * Drop stored files this session log no longer references: a whole body no
 * row names, a manifest no named body reaches, and a list or part no such
 * manifest names. If a named body's manifest or list cannot be read, its
 * files are unknown, and no file is removed. Destructive collection owns
 * both session execution fences before refreshing any roots.
 *
 * Effect first so a rejected append cancels the delete. dry-run still
 * records both events and leaves the files alone.
 */
export function gcSessionBlobs(input: {
  log: EventLog;
  dryRun?: boolean;
  store?: BlobStore;
  /** Further roots the log itself does not list: the digests the session's
   * current and retained model-input views hold (#223 R4). */
  roots?: Iterable<string> | (() => Iterable<string> | BlobGcRoots);
}): BlobGcResult {
  const dryRun = input.dryRun === true;
  if (input.log.isReadOnly) throw new Error("blob GC requires a writable EventLog for durable observations");
  const scope = dryRun ? undefined : acquireBlobGcScope(dirname(input.log.path));
  try {
    return collectSessionBlobs(input, scope && !scope.acquired ? scope.reason : undefined);
  } finally { if (scope?.acquired) scope.release(); }
}

function collectSessionBlobs(input: {
  log: EventLog;
  dryRun?: boolean;
  store?: BlobStore;
  roots?: Iterable<string> | (() => Iterable<string> | BlobGcRoots);
}, refusal?: string): BlobGcResult {
  const dryRun = input.dryRun === true;
  const store = input.store ?? BlobStore.forSession(input.log.path);
  input.log.refresh();
  const referenced = collectReferencedBlobs(input.log.events);
  let complete = true;
  // A callback reads mutable view/checkpoint roots only after exclusion and
  // a durable log refresh. A partial scan never authorizes any sweep.
  try {
    const scan = typeof input.roots === "function" ? input.roots() : input.roots ?? [];
    const roots = "complete" in scan ? scan.roots : scan;
    if ("complete" in scan && !scan.complete) complete = false;
    for (const digest of roots) if (DIGEST.test(digest)) referenced.add(digest);
  } catch { complete = false; }
  const onDisk = listStoredFiles(store);
  // Closure names alone do not prove missing parts or whole bodies readable.
  // A single memo verifies shared parts only once across retained roots.
  const memo = storedFileMemo();
  for (const digest of referenced) {
    if (memo.files.has(storedName(digest, "manifest"))) continue;
    try {
      const verified = store.verifyBody(digest, memo);
      if (verified.layout === "whole") memo.files.add(storedName(digest, "whole"));
    } catch { complete = false; }
  }
  const refused = refusal ?? (!complete ? "incomplete_roots" : undefined);
  // A whole file is named by its digest (as before split storage); a
  // split-layout file by its name.
  const label = (file: { name: string; digest: string; kind: StoredKind }) =>
    file.kind === "whole" ? file.digest : file.name.slice(3);
  const orphans = refused ? [] : onDisk.filter((file) => file.kind === "whole" ? !referenced.has(file.digest)
    : !memo.files.has(file.name)).sort((a, b) => label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0);

  input.log.append({
    kind: "effect",
    name: "blob/gc",
    payload: {
      dry_run: dryRun,
      referenced: referenced.size,
      on_disk: onDisk.length,
      orphan: orphans.length,
      ...(refused ? { refused } : {}),
    },
  });

  const removed: string[] = [];
  let bytes = 0;
  for (const file of orphans) {
    if (dryRun) {
      removed.push(label(file));
      if (existsSync(store.fileOf(file.name))) {
        try {
          bytes += statSync(store.fileOf(file.name)).size;
        } catch {
          // count stays best-effort on dry-run
        }
      }
      continue;
    }
    const freed = store.removeFile(file.name);
    if (freed > 0 || !existsSync(store.fileOf(file.name))) {
      removed.push(label(file));
      bytes += freed;
    }
  }

  const kept = onDisk.length - removed.length;
  input.log.append({
    kind: "observe",
    name: "blob/gc_result",
    payload: {
      dry_run: dryRun,
      kept,
      removed: removed.length,
      bytes_freed: bytes,
      // Cap the digest list so the event stays small; full set is recoverable
      // by re-running dry-run against the same log.
      digests: removed.slice(0, 32),
      ...(refused ? { refused } : {}),
    },
  });

  return {
    dry_run: dryRun,
    kept,
    removed,
    bytes_freed: bytes,
    referenced: referenced.size,
    on_disk: onDisk.length,
    ...(refused ? { refused } : {}),
  };
}
