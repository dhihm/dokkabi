import { codeSessionIsBound } from "../code-evolution/session-binding.ts";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { BlobStore } from "./blob-store.ts";
import { canonicalJson } from "./canonical.ts";
import { EventLog } from "./event-log.ts";
import { readRecordedMutation, type MutationReceiptRequest } from "./code-evolution-receipts.ts";
import { assertNoSecrets } from "./redact.ts";
import type { EventInput, EventRecord } from "./schema.ts";
import {
  captureMaterial,
  CodeVersionRefusal,
  digestSchema,
  fileSchema,
  graphSchema,
  layoutSchema,
  LIMITS,
  materialIdentity,
  policySchema,
  referenceSchema,
  refuse,
  safePath,
  sha,
  type MaterialIdentity,
  type Reference,
} from "../code-evolution/material.ts";

export const versionReadSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  version: referenceSchema,
  digest: digestSchema,
});
export type VersionReadRequest = z.infer<typeof versionReadSchema>;
const captureSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  expected: referenceSchema,
  paths: z.array(z.string().refine(safePath)).min(1).max(LIMITS.paths),
  previous: versionReadSchema.nullable(),
  links: z
    .array(z.strictObject({ path: z.string().refine(safePath), commit: referenceSchema }))
    .max(LIMITS.paths)
    .default([]),
});
export type VersionCaptureRequest = z.input<typeof captureSchema>;
const identitySchema = z.strictObject({
  parser: z.strictObject({ name: z.string(), version: z.string() }),
  importDigest: digestSchema,
  redaction: z.strictObject({ version: z.literal(1), candidate: digestSchema, host: digestSchema }),
  adapter: digestSchema,
});
const headerSchema = z.strictObject({
  schema: z.literal("code-evolution-v1"),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  sessionId: z.string().min(1).max(256),
  workspaceKey: digestSchema,
  requestDigest: digestSchema,
  source: referenceSchema,
  intent: referenceSchema,
  previous: versionReadSchema.nullable(),
  identity: identitySchema,
  rootId: z.string().regex(/^\d+:\d+$/),
});
const linkSchema = z.strictObject({
  path: z.string().refine(safePath),
  request: z.strictObject({
    sessionId: z.string(),
    source: referenceSchema,
    commit: referenceSchema,
    file: z.strictObject({
      root: z.string(),
      path: z.string().refine(safePath),
      digest: digestSchema,
      bytes: z.number().int().nonnegative().max(LIMITS.file),
    }),
  }),
  receipt: z.json(),
});
const envelopeSchema = headerSchema.extend({
  scope: z.array(z.string().refine(safePath)).min(1).max(LIMITS.paths),
  files: z.array(fileSchema).max(LIMITS.paths),
  graph: graphSchema,
  graphDigest: digestSchema,
  layout: layoutSchema,
  policies: z.array(policySchema).length(2),
  diff: z.record(z.string(), z.json()),
  coverage: z.record(z.string(), z.json()),
  stats: z.strictObject({
    bytesRead: z.number().int().nonnegative().max(LIMITS.total),
    parsed: z.number().int().nonnegative().max(LIMITS.paths),
    reused: z.number().int().nonnegative().max(LIMITS.paths),
  }),
  links: z.array(linkSchema).max(LIMITS.paths),
});
export type StructuralVersion = z.infer<typeof envelopeSchema>;
export type VersionResult = { reference: VersionReadRequest; value: StructuralVersion };
function reference(row: EventRecord): Reference {
  return { seq: row.seq, hash: row.hash };
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function matching(rows: readonly EventRecord[], wanted: Reference) {
  const row = rows[wanted.seq - 1];
  if (!row || row.seq !== wanted.seq || row.hash !== wanted.hash) refuse("reference_mismatch");
  return row;
}
function validateRows(rows: readonly EventRecord[], sessionId: string) {
  if (
    rows.some(
      (row) =>
        typeof row.name !== "string" ||
        !row.payload ||
        typeof row.payload !== "object" ||
        Array.isArray(row.payload),
    )
  )
    refuse("retained_log_invalid");
  if (!codeSessionIsBound(rows, sessionId)) refuse("session_binding_invalid");
  for (const row of rows.filter((r) => r.name === "code/version")) {
    if (
      row.kind !== "observe" ||
      !headerSchema.safeParse(row.payload.header).success ||
      !digestSchema.safeParse(row.payload.blob).success ||
      !digestSchema.safeParse(row.payload.graphDigest).success ||
      !Number.isSafeInteger(row.payload.blob_bytes) ||
      Number(row.payload.blob_bytes) < 0 ||
      Number(row.payload.blob_bytes) > LIMITS.envelope
    )
      refuse("publication_binding_invalid");
  }
}
function verifiedRows(path: string, sessionId: string) {
  let log: EventLog;
  try {
    log = new EventLog(path, { readOnly: true });
  } catch {
    return refuse("retained_log_invalid");
  }
  const rows = log.events;
  validateRows(rows, sessionId);
  return rows;
}
function durable(log: EventLog, build: () => readonly EventInput[]): readonly EventRecord[] {
  let rejection: string | undefined;
  let rows: readonly EventRecord[];
  try {
    rows = log.appendBatchDurable(() => {
      try {
        return build();
      } catch (error) {
        if (error instanceof CodeVersionRefusal) {
          rejection = error.code;
          return [];
        }
        throw error;
      }
    });
  } catch {
    return refuse("durable_publication_failed");
  }
  if (rejection) refuse(rejection);
  return rows;
}
function syncStoredBody(store: BlobStore, digest: string, body: string) {
  if (store.get(digest) !== body) refuse("retained_body_invalid");
  // The body and newly created shard/root must precede its durable event.
  for (const path of [
    store.pathOf(digest),
    dirname(store.pathOf(digest)),
    store.root,
    dirname(store.root),
  ]) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** Optional trusted-host capture. Renderer requests cannot choose an owner,
 * log, blob path or root. Cold reads never open the captured workspace. */
export class CodeEvolutionVersionService {
  readonly #log: EventLog;
  readonly #sessionId: string;
  readonly #workspaceRoot: string;
  readonly #workspaceKey: string;
  readonly #identity: MaterialIdentity;
  readonly #store: BlobStore;
  #revoked = false;
  constructor(owner: { log: EventLog; sessionId: string; workspaceRoot: string }) {
    this.#log = owner.log;
    this.#sessionId = owner.sessionId;
    this.#workspaceRoot = resolve(owner.workspaceRoot);
    this.#workspaceKey = sha(this.#workspaceRoot);
    this.#identity = materialIdentity();
    this.#store = BlobStore.forSession(owner.log.path);
  }
  revoke() {
    this.#revoked = true;
  }
  read(input: unknown): VersionResult {
    if (this.#revoked) refuse("revoked");
    const parsed = versionReadSchema.safeParse(input);
    if (!parsed.success) refuse("invalid_request");
    const request = parsed.data;
    if (request.sessionId !== this.#sessionId) refuse("foreign_session");
    const rows = verifiedRows(this.#log.path, this.#sessionId);
    const row = matching(rows, request.version);
    if (row.kind !== "observe" || row.name !== "code/version") refuse("not_published");
    const header = headerSchema.safeParse(row.payload.header);
    if (
      !header.success ||
      header.data.sessionId !== this.#sessionId ||
      header.data.workspaceKey !== this.#workspaceKey ||
      row.payload.blob !== request.digest ||
      !Number.isSafeInteger(row.payload.blob_bytes) ||
      Number(row.payload.blob_bytes) > LIMITS.envelope ||
      Number(row.payload.blob_bytes) < 0
    )
      refuse("publication_binding_invalid");
    if (!equal(header.data.identity, this.#identity)) refuse("unsupported_identity");
    if (
      rows.filter(
        (r) =>
          r.name === "code/version" &&
          (r.payload.header as { id?: unknown } | null)?.id === header.data.id,
      ).length !== 1
    )
      refuse("duplicate_publication");
    let text: string;
    try {
      text = this.#store.get(request.digest);
    } catch {
      return refuse("retained_body_invalid");
    }
    if (
      Buffer.byteLength(text) !== row.payload.blob_bytes ||
      Buffer.byteLength(text) > LIMITS.envelope
    )
      refuse("retained_body_invalid");
    let body: StructuralVersion;
    try {
      body = envelopeSchema.parse(JSON.parse(text));
      assertNoSecrets(body);
    } catch {
      return refuse("retained_body_invalid");
    }
    const actualHeader = headerSchema.parse(
      Object.fromEntries(
        Object.keys(header.data).map((k) => [k, body[k as keyof StructuralVersion]]),
      ),
    );
    if (
      !equal(header.data, actualHeader) ||
      !equal(
        body.scope,
        body.files.map((f) => f.path),
      ) ||
      !equal(body.scope, [...new Set(body.scope)].sort()) ||
      sha(canonicalJson(body.graph)) !== body.graphDigest ||
      row.payload.graphDigest !== body.graphDigest
    )
      refuse("retained_body_invalid");
    const retainedRequest = {
      id: body.id,
      expected: body.source,
      paths: body.scope,
      previous: body.previous,
      links: body.links
        .map((link) => ({ path: link.path, commit: link.request.commit }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    if (sha(canonicalJson(retainedRequest)) !== body.requestDigest)
      refuse("capture_binding_invalid");
    if (
      rows.filter((r) => r.name === "code/capture_started" && r.payload.id === body.id).length !== 1
    )
      refuse("capture_binding_invalid");
    const source = matching(rows, body.source),
      intent = matching(rows, body.intent);
    if (
      source.seq >= intent.seq ||
      intent.seq !== source.seq + 1 ||
      intent.seq >= row.seq ||
      row.seq !== intent.seq + 1 ||
      intent.kind !== "observe" ||
      intent.name !== "code/capture_started" ||
      !equal(intent.payload, {
        id: body.id,
        sessionId: body.sessionId,
        workspaceKey: body.workspaceKey,
        requestDigest: body.requestDigest,
        source: body.source,
        paths: body.scope.length,
        request: retainedRequest,
      })
    )
      refuse("capture_binding_invalid");
    if (body.previous) {
      if (body.previous.sessionId !== this.#sessionId || body.previous.version.seq > source.seq)
        refuse("previous_binding_invalid");
      const prior = matching(rows, body.previous.version);
      const priorHeader = headerSchema.safeParse(prior.payload.header);
      if (
        prior.name !== "code/version" ||
        prior.kind !== "observe" ||
        prior.payload.blob !== body.previous.digest ||
        !priorHeader.success ||
        priorHeader.data.rootId !== body.rootId ||
        priorHeader.data.workspaceKey !== body.workspaceKey ||
        !equal(priorHeader.data.identity, body.identity)
      )
        refuse("previous_binding_invalid");
    }
    for (const file of body.files) {
      if (
        file.sanitized &&
        (sha(file.sanitized.text) !== file.sanitized.digest ||
          Buffer.byteLength(file.sanitized.text) !== file.sanitized.bytes)
      )
        refuse("retained_body_invalid");
      if (
        (file.status === "parsed" || file.status === "parse_failed") !==
        Boolean(file.original && file.sanitized && file.analysis && file.receiptPath)
      )
        refuse("retained_body_invalid");
    }
    for (const policy of body.policies)
      if (
        (policy.digest === null && policy.text !== "") ||
        (policy.digest !== null && sha(policy.text) !== policy.digest)
      )
        refuse("retained_body_invalid");
    const linkPaths = new Set<string>();
    for (const link of body.links) {
      const file = body.files.find((f) => f.path === link.path);
      if (
        linkPaths.has(link.path) ||
        !file?.original ||
        file.receiptPath !== link.request.file.path ||
        !equal(link.request.source, body.source) ||
        link.request.file.root !== body.rootId ||
        !equal(file.original, { digest: link.request.file.digest, bytes: link.request.file.bytes })
      )
        refuse("link_binding_invalid");
      linkPaths.add(link.path);
      let receipt: unknown;
      try {
        receipt = readRecordedMutation(
          { logPath: this.#log.path, sessionId: this.#sessionId, rootId: body.rootId },
          link.request,
        );
      } catch {
        return refuse("link_binding_invalid");
      }
      if (!equal(receipt, link.receipt)) refuse("link_binding_invalid");
    }
    return { reference: request, value: body };
  }
  capture(input: unknown): VersionResult {
    if (this.#revoked) refuse("revoked");
    if (this.#log.isReadOnly) refuse("read_only");
    const parsed = captureSchema.safeParse(input);
    if (!parsed.success) refuse("invalid_request");
    const request = parsed.data;
    request.paths.sort();
    request.links.sort((a, b) => a.path.localeCompare(b.path));
    if (
      new Set(request.paths).size !== request.paths.length ||
      new Set(request.links.map((l) => l.path)).size !== request.links.length
    )
      refuse("duplicate_paths");
    try {
      assertNoSecrets(request);
    } catch {
      return refuse("invalid_request");
    }
    const requestDigest = sha(canonicalJson(request));
    const rows = verifiedRows(this.#log.path, this.#sessionId);
    const existing = rows.filter(
      (r) =>
        r.name === "code/version" &&
        (r.payload.header as { id?: unknown } | null)?.id === request.id,
    );
    if (existing.length) {
      if (
        existing.length !== 1 ||
        (existing[0]!.payload.header as { requestDigest?: unknown }).requestDigest !== requestDigest
      )
        refuse("idempotency_conflict");
      const row = existing[0]!;
      return this.read({
        sessionId: this.#sessionId,
        version: reference(row),
        digest: row.payload.blob,
      });
    }
    if (rows.some((r) => r.name === "code/capture_started" && r.payload.id === request.id))
      refuse("capture_unresolved");
    const prior = request.previous ? this.read(request.previous).value : null;
    let intent: EventRecord;
    const retained = (events: readonly EventRecord[], bytes = 0) => {
      const versions = events.filter((r) => r.name === "code/version");
      if (versions.length >= LIMITS.versions) refuse("version_limit");
      const sizes = versions.map((r) => r.payload.blob_bytes);
      if (
        sizes.some((n) => !Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > LIMITS.envelope)
      )
        refuse("retention_metadata_invalid");
      if (sizes.reduce<number>((sum, n) => sum + Number(n), bytes) > LIMITS.retained)
        refuse("retention_bytes_limit");
    };
    let concurrent: EventRecord | undefined;
    const started = durable(this.#log, () => {
      validateRows(this.#log.events, this.#sessionId);
      const published = this.#log.events.filter(
        (r) =>
          r.name === "code/version" && (r.payload.header as { id?: unknown }).id === request.id,
      );
      if (published.length) {
        if (
          published.length !== 1 ||
          (published[0]!.payload.header as { requestDigest?: unknown }).requestDigest !==
            requestDigest
        )
          refuse("idempotency_conflict");
        concurrent = published[0]!;
        return [];
      }
      if (!equal(reference(this.#log.events.at(-1)!), request.expected)) refuse("stale_source");
      if (
        this.#log.events.some(
          (r) => r.name === "code/capture_started" && r.payload.id === request.id,
        )
      )
        refuse("capture_unresolved");
      retained(this.#log.events);
      return [
        {
          kind: "observe",
          name: "code/capture_started",
          payload: {
            id: request.id,
            sessionId: this.#sessionId,
            workspaceKey: this.#workspaceKey,
            requestDigest,
            source: request.expected,
            paths: request.paths.length,
            request,
          },
        },
      ];
    });
    if (concurrent)
      return this.read({
        sessionId: this.#sessionId,
        version: reference(concurrent),
        digest: concurrent.payload.blob,
      });
    intent = started[0]!;
    try {
      const material = captureMaterial(this.#workspaceRoot, request.paths, prior);
      if (prior && prior.rootId !== material.rootId) refuse("workspace_identity_changed");
      const links = request.links.map((link) => {
        const file = material.files.find((f) => f.path === link.path);
        if (!file?.original || !file.receiptPath || !file.sanitized)
          refuse("link_file_unavailable");
        const query: MutationReceiptRequest = {
          sessionId: this.#sessionId,
          source: request.expected,
          commit: link.commit,
          file: { root: material.rootId, path: file.receiptPath, ...file.original },
        };
        let receipt: ReturnType<typeof readRecordedMutation>;
        try {
          receipt = readRecordedMutation(
            { logPath: this.#log.path, sessionId: this.#sessionId, rootId: material.rootId },
            query,
          );
        } catch {
          return refuse("link_binding_invalid");
        }
        return { path: link.path, request: query, receipt };
      });
      const header = headerSchema.parse({
        schema: "code-evolution-v1",
        id: request.id,
        sessionId: this.#sessionId,
        workspaceKey: this.#workspaceKey,
        requestDigest,
        source: request.expected,
        intent: reference(intent),
        previous: request.previous,
        identity: this.#identity,
        rootId: material.rootId,
      });
      const body = envelopeSchema.parse({ ...header, scope: request.paths, ...material, links });
      assertNoSecrets(body);
      const text = canonicalJson(body),
        bytes = Buffer.byteLength(text);
      if (bytes > LIMITS.envelope) refuse("envelope_limit");
      // Refuse an over-budget envelope before placing an orphan on disk.
      // Publication rechecks the same owner/head/budget after storage.
      durable(this.#log, () => {
        validateRows(this.#log.events, this.#sessionId);
        if (!equal(reference(this.#log.events.at(-1)!), reference(intent)))
          refuse("capture_head_changed");
        retained(this.#log.events, bytes);
        return [];
      });
      const digest = this.#store.put(text);
      syncStoredBody(this.#store, digest, text);
      const published = durable(this.#log, () => {
        validateRows(this.#log.events, this.#sessionId);
        if (!equal(reference(this.#log.events.at(-1)!), reference(intent)))
          refuse("capture_head_changed");
        retained(this.#log.events, bytes);
        return [
          {
            kind: "observe",
            name: "code/version",
            payload: { header, graphDigest: body.graphDigest, blob: digest, blob_bytes: bytes },
          },
        ];
      });
      return this.read({ sessionId: this.#sessionId, version: reference(published[0]!), digest });
    } catch (error) {
      const code = error instanceof CodeVersionRefusal ? error.code : "capture_failed";
      // A published row can be recovered through its idempotent retry; a
      // failed acknowledgement must never erase or replace that observation.
      if (
        !this.#log.events.some(
          (r) =>
            r.name === "code/version" &&
            (r.payload.header as { id?: unknown } | null)?.id === request.id,
        )
      ) {
        try {
          this.#log.appendDurable({
            kind: "observe",
            name: "code/capture_refused",
            payload: { id: request.id, source: request.expected, code },
          });
        } catch {
          throw new CodeVersionRefusal("refusal_publication_failed", code);
        }
      }
      return refuse(code);
    }
  }
}
