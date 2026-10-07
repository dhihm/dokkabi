import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BlobIntegrityError, BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import { assertNoSecrets, containsPrivateInfrastructureValue } from "../host/redact.ts";
import { KnowledgeIndex } from "./index.ts";
import { knowledgeDocumentPath, reservedKnowledgePath } from "./layout.ts";
import { parseKnowledgeMarkdown, serializeKnowledgeMarkdown, sha256, slug } from "./markdown.ts";
import { CURRENT_WIKI_SCHEMA, migrateKnowledgeMarkdown } from "./ontology.ts";
import { projectWorkCheckpoint } from "./worklog.ts";
import type {
  JournalRecordInput,
  KnowledgeAgingResult,
  KnowledgeDocument,
  KnowledgeEvidence,
  KnowledgeFollowOptions,
  KnowledgeGraph,
  KnowledgeKind,
  KnowledgeMetadata,
  KnowledgeMigrationResult,
  KnowledgeMaintenanceResult,
  KnowledgeLintIssue,
  KnowledgeProfile,
  KnowledgePromoteInput,
  KnowledgePublishInput,
  KnowledgePublishResult,
  KnowledgeQuery,
  KnowledgeScope,
  KnowledgeSearchHit,
  KnowledgeService,
  KnowledgeVaultStatus,
  KnowledgeWriteResult,
} from "./types.ts";

export interface GitCommandRequest {
  argv: readonly string[];
  cwd: string;
  stdin?: string;
}

export interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (request: GitCommandRequest) => Promise<GitCommandResult>;

const IDENTIFIER = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;
const MAX_BODY_BYTES = 1_000_000;
const MAX_PUBLISH_PATHS = 100;
/** Aging writes per maintenance pass, per direction (refresh, demote). The
 * pass converges over successive milestones instead of churning the vault. */
const MAX_AGING_WRITES = 16;
/** Id-list bound for the recorded knowledge/aging summary event. */
const MAX_AGING_EVENT_IDS = 64;

export function createKnowledgeService(input: {
  log: EventLog;
  profile?: KnowledgeProfile;
  gitRunner?: GitCommandRunner;
}): KnowledgeService {
  const replay = input.log.isReadOnly;
  const index = input.profile && !replay ? new KnowledgeIndex(input.profile) : undefined;
  const store = BlobStore.forSession(input.log.path);
  const replayResults = replay
    ? input.log.events.filter((event) => event.name === "knowledge/result" && typeof event.payload.result_digest === "string")
    : [];
  const replayReads = replay
    ? input.log.events.filter((event) => event.name === "knowledge/read_result" && typeof event.payload.result_digest === "string")
    : [];
  let queryCursor = 0;
  let readCursor = 0;
  const ownedPaths = new Map<string, string>();
  const retryablePushHeads = new Map<string, string>();
  for (const event of input.log.events) {
    if (event.name === "knowledge/write_result" && event.payload.status === "written" && typeof event.payload.path_digest === "string" && typeof event.payload.result_digest === "string") {
      ownedPaths.set(event.payload.path_digest, event.payload.result_digest);
    }
    if (event.name === "knowledge/publish_result" && typeof event.payload.commit_scope_digest === "string") {
      if (event.payload.status === "failed" && event.payload.commit_created === true) {
        retryablePushHeads.set(event.payload.commit_scope_digest, typeof event.payload.commit_head === "string" ? event.payload.commit_head : "missing");
      } else if (event.payload.status === "published") {
        retryablePushHeads.delete(event.payload.commit_scope_digest);
      }
    }
  }

  function requireIndex(refresh = true): KnowledgeIndex {
    if (!index) throw new Error("knowledge vault is unavailable outside a recorded replay result");
    if (refresh) index.refresh();
    return index;
  }

  function recorded<T>(inputEvent: "knowledge/query" | "knowledge/lint", op: string, request: unknown, compute: () => T): T {
    assertNoSecrets(request);
    const requestDigest = sha256(canonicalJson(request));
    if (replay) {
      const event = replayResults[queryCursor++];
      if (!event || event.payload.op !== op || event.payload.request_digest !== requestDigest) {
        throw new Error(`knowledge replay query mismatch at ${op}`);
      }
      return readRecordedBlob<T>(event.payload, store);
    }
    input.log.append({ kind: "effect", name: inputEvent, payload: { op, request_digest: requestDigest } });
    let result: T;
    try {
      result = compute();
      assertSafeKnowledgeBody(result);
    } catch (error) {
      input.log.append({
        kind: "observe",
        name: "knowledge/result",
        payload: { op, request_digest: requestDigest, status: "failed", reason: stableFailure(error) },
      });
      throw error;
    }
    const body = canonicalJson(result);
    const resultDigest = sha256(body);
    store.putAndAppend(input.log, {
      kind: "observe",
      name: "knowledge/result",
      payload: {
        op,
        request_digest: requestDigest,
        result_digest: resultDigest,
        result_count: Array.isArray(result) ? result.length : 1,
      },
    }, body);
    return result;
  }

  const service: KnowledgeService = {
    profile: input.profile,

    /**
     * The owning project of a document, without reading it.
     *
     * A scope CHECK must not be a recorded read: routing it through `read`
     * appends a knowledge/read effect, writes the foreign document's body
     * into the session BlobStore, and puts its stable id into the replay
     * contract's KnowledgeReadReference — leaking exactly the id the check
     * exists to withhold, and doing it once per traversed node.
     */
    /** Does the vault hold this id at all? Distinguishes a vault-level lint
     * row (`meta:ontology`, which names no document) from a real document
     * that simply has no project — a shared one, which IS out of scope. */
    hasDocument(id: string): boolean {
      if (!input.profile) return false;
      if (input.log.isReadOnly) return service.read(id) !== undefined;
      try {
        return requireIndex(false).read(id) !== undefined;
      } catch {
        return false;
      }
    },

    documentProject(id: string): string | undefined {
      if (!input.profile) return undefined;
      // Replay has no index; `read` is the method with the recorded branch,
      // so a read-only session answers from its log. Without this every
      // document looks foreign in replay AND the refusals consume no query
      // cursor, desyncing the next recorded read.
      if (input.log.isReadOnly) return service.read(id)?.metadata.project;
      try {
        // No refresh: this runs inside per-node and per-issue filters, and
        // refresh() re-walks and re-parses the whole vault. The tool call that
        // reached this filter already refreshed, so the snapshot is current.
        return requireIndex(false).read(id)?.metadata.project;
      } catch {
        return undefined;
      }
    },

    search(query: KnowledgeQuery): KnowledgeSearchHit[] {
      const normalized = normalizeQuery(query);
      return recorded("knowledge/query", "search", normalized, () => requireIndex().search(normalized));
    },

    brief(briefInput) {
      const statement = cleanText(briefInput.statement, "briefing statement", 2_000);
      const limit = Math.max(1, Math.min(8, Math.trunc(briefInput.limit ?? 3)));
      const maxBytes = Math.max(1_000, Math.min(32_000, Math.trunc(briefInput.maxBytes ?? 12_000)));
      const request = {
        statement,
        ...(briefInput.project ? { project: validateOptionalIdentifier(briefInput.project, "project", true)! } : {}),
        limit,
        max_bytes: maxBytes,
      };
      return recorded("knowledge/query", "brief", request, () => {
        const current = requireIndex();
        const hits = current.search({ text: statement, ...(request.project ? { project: request.project } : {}), limit: limit * 2 });
        const selected = hits.slice(0, limit);
        const related = new Set<string>();
        for (const hit of selected) {
          for (const node of current.follow(hit.id, { depth: 1, limit: 20 }).nodes) {
            if (node.id === hit.id) continue;
            const relatedDocument = current.read(node.id);
            // The forgetting zone holds for the related neighborhood too:
            // search excludes archived docs, so the expansion must not
            // re-advertise their ids through a link from a live hit (#110).
            if (relatedDocument?.metadata.lifecycle === "archive") continue;
            // A repository-scoped briefing is a closed view. Graph traversal
            // may discover cross-project edges for linting, but neither the
            // foreign document nor even its stable ID may enter child bytes.
            if (request.project && relatedDocument?.metadata.project !== request.project) continue;
            related.add(node.id);
          }
        }
        const evidenceBlockers = new Set(current.lint()
          .filter((issue) => issue.severity === "error" && [
            "missing_evidence", "invalid_evidence", "invalid_metadata", "ontology_domain", "ontology_range", "scope_leakage",
          ].includes(issue.code))
          .map((issue) => issue.document));
        const sufficient = selected.some((hit) =>
          hit.truth_state === "current"
            && (current.read(hit.id)?.metadata.evidence.length ?? 0) > 0
            && !evidenceBlockers.has(hit.id)
        );
        const revision = request.project
          ? current.projectRevision(request.project)
          : current.status().revision_digest;
        let text = [
          `[knowledge briefing; sufficiency=${sufficient ? "sufficient" : "insufficient"}; revision=${revision.slice(0, 12)}]`,
          ...selected.flatMap((hit) => {
            const document = current.read(hit.id)!;
            return [`- ${hit.id} status=${hit.status} truth=${hit.truth_state} digest=${hit.digest}`, boundedBody(document.body, 3_000)];
          }),
          ...(related.size > 0 ? [`related=${[...related].sort().join(",")}`] : []),
        ].join("\n");
        let truncated = false;
        if (Buffer.byteLength(text) > maxBytes) {
          text = Buffer.from(text).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
          truncated = true;
        }
        return {
          text,
          document_ids: selected.map((hit) => hit.id),
          related_ids: [...related].sort(),
          sufficiency: sufficient ? "sufficient" as const : "insufficient" as const,
          revision_digest: revision,
          truncated,
        };
      });
    },

    read(id: string): KnowledgeDocument | undefined {
      const documentId = validateDocumentId(id);
      const request = { document_id: documentId };
      const requestDigest = sha256(canonicalJson(request));
      if (replay) {
        const event = replayReads[readCursor++];
        if (!event || event.payload.document_id !== documentId || event.payload.request_digest !== requestDigest) {
          throw new Error(`knowledge replay read mismatch at ${documentId}`);
        }
        return readRecordedBlob<KnowledgeDocument | null>(event.payload, store) ?? undefined;
      }
      input.log.append({ kind: "effect", name: "knowledge/read", payload: { document_id: documentId, request_digest: requestDigest } });
      let result: KnowledgeDocument | null;
      try {
        result = requireIndex().read(documentId) ?? null;
        assertSafeKnowledgeBody(result);
      } catch (error) {
        input.log.append({
          kind: "observe",
          name: "knowledge/read_result",
          payload: { document_id: documentId, request_digest: requestDigest, status: "failed", reason: stableFailure(error) },
        });
        throw error;
      }
      const body = canonicalJson(result);
      store.putAndAppend(input.log, {
        kind: "observe",
        name: "knowledge/read_result",
        payload: {
          document_id: documentId,
          request_digest: requestDigest,
          result_digest: sha256(body),
          found: result !== null,
        },
      }, body);
      return result ?? undefined;
    },

    follow(id: string, options: KnowledgeFollowOptions = {}): KnowledgeGraph {
      const request = { document_id: validateDocumentId(id), ...normalizeFollow(options) };
      return recorded("knowledge/query", "follow", request, () => requireIndex().follow(request.document_id, request));
    },

    status(): KnowledgeVaultStatus {
      const status = recorded("knowledge/query", "status", {}, () => requireIndex().status());
      if (!replay) appendSafeStatus(input.log, status);
      return status;
    },

    lint(): KnowledgeLintIssue[] {
      const issues = recorded("knowledge/lint", "lint", {}, () => requireIndex().lint());
      if (!replay) appendLintSummary(input.log, issues);
      return issues;
    },

    async record(recordInput: JournalRecordInput): Promise<KnowledgeWriteResult> {
      assertWritable(input.log, input.profile);
      const profile = input.profile!;
      const normalized = normalizeRecord(recordInput, profile.visibility ?? "private");
      if (visibilityRank(normalized.visibility) > visibilityRank(profile.visibility ?? "private")) {
        throw new Error("knowledge record visibility exceeds the active profile policy");
      }
      const identity = recordIdentity(normalized);
      const path = documentPath(profile, normalized.scope, normalized.kind, normalized.title, normalized.project, normalized.task);
      const existing = requireIndex().read(identity);
      if (existing && existing.metadata.kind !== normalized.kind) {
        throw new Error("knowledge stable ID collides with a different document kind");
      }
      const now = new Date().toISOString();
      const section = normalized.research
        ? researchSection(now, normalized.summary, normalized.research)
        : [
            `## ${now} — ${normalized.summary}`,
            "",
            normalized.summary,
            ...(normalized.details ? ["", normalized.details] : []),
          ].join("\n");
      const body = existing ? `${existing.body.trim()}\n\n${section}\n` : `# ${normalized.title}\n\n${section}\n`;
      const metadata = {
        schema: CURRENT_WIKI_SCHEMA,
        id: identity,
        kind: normalized.kind,
        scope: normalized.scope,
        ...(normalized.project ? { project: normalized.project } : {}),
        ...(normalized.task ? { task: normalized.task } : {}),
        status: normalized.status,
        visibility: normalized.visibility,
        types: unique([...(existing?.metadata.types ?? []), ...normalized.types]),
        relations: uniqueRelations([...(existing?.metadata.relations ?? []), ...normalized.relations]),
        evidence: uniqueEvidence([...(existing?.metadata.evidence ?? []), ...normalized.evidence]),
        aliases: existing?.metadata.aliases ?? [],
        tags: unique([...(existing?.metadata.tags ?? []), ...normalized.tags]),
        created_at: existing?.metadata.created_at ?? now,
        updated_at: now,
      } as const;
      const document = parseKnowledgeMarkdown(path, serializeKnowledgeMarkdown({
        id: identity,
        path,
        title: normalized.title,
        body,
        metadata: { ...metadata },
      }), { layout: profile.layout });
      return service.writeDocument({ document, ...(existing ? { expectedDigest: existing.digest } : {}) });
    },

    async promote(promoteInput: KnowledgePromoteInput): Promise<KnowledgeWriteResult> {
      assertWritable(input.log, input.profile);
      const sourceId = validateDocumentId(promoteInput.sourceId);
      const source = requireIndex().read(sourceId);
      if (!source) throw new Error(`unknown knowledge document ${sourceId}`);
      if (source.metadata.status !== "verified") {
        throw new Error("knowledge promotion requires a verified source");
      }
      if (source.metadata.evidence.length === 0) {
        throw new Error("knowledge promotion requires source-backed evidence");
      }
      assertSafeKnowledgeBody(source);
      const scope = promoteInput.scope;
      const project = scope === "project" ? validateOptionalIdentifier(promoteInput.project, "project", true) : undefined;
      const title = cleanText(promoteInput.title ?? source.title, "title", 200);
      assertSafeKnowledgeBody({ project, title });
      const visibility = promoteInput.visibility ?? source.metadata.visibility;
      if (visibilityRank(visibility) > visibilityRank(input.profile!.visibility ?? "private")) {
        throw new Error("knowledge promotion visibility exceeds the active profile policy");
      }
      if (visibilityRank(visibility) > visibilityRank(source.metadata.visibility) && promoteInput.allowVisibilityPromotion !== true) {
        throw new Error("knowledge promotion across visibility requires explicit policy");
      }
      const kind = promoteInput.kind ?? (source.metadata.kind === "decision" ? "decision" : "claim");
      const id = scope === "shared" ? `shared:${slug(title)}` : `project:${project}:${slug(title)}`;
      const path = documentPath(input.profile!, scope, kind, title, project, undefined);
      const existing = requireIndex().read(id);
      if (existing && (existing.metadata.kind !== kind || !existing.metadata.relations.some((relation) => relation.predicate === "wiki:derivedFrom" && relation.target === source.id))) {
        throw new Error("knowledge promotion target already exists; record a contradiction or choose a distinct title");
      }
      const now = new Date().toISOString();
      const document = parseKnowledgeMarkdown(path, serializeKnowledgeMarkdown({
        id,
        path,
        title,
        body: source.body,
        metadata: {
          ...source.metadata,
          id,
          kind,
          scope,
          ...(project ? { project } : {}),
          task: undefined,
          status: promoteInput.status ?? "verified",
          visibility,
          types: unique([`wiki:${kind === "claim" || kind === "concept" ? "Claim" : capitalize(kind)}`]),
          relations: uniqueRelations([
            ...source.metadata.relations,
            { predicate: "wiki:derivedFrom", target: source.id, evidence: `document:${source.digest}` },
          ]),
          evidence: uniqueEvidence([
            ...source.metadata.evidence,
            { kind: "document", locator: `document:${source.id}`, digest: source.digest },
          ]),
          created_at: existing?.metadata.created_at ?? now,
          updated_at: now,
        },
      }), { layout: input.profile!.layout });
      assertSafeKnowledgeBody(document);
      input.log.append({
        kind: "effect",
        name: "knowledge/promote",
        payload: { source_id: source.id, target_id: id, target_scope: scope },
      });
      try {
        const result = await service.writeDocument({ document, ...(existing ? { expectedDigest: existing.digest } : {}) });
        input.log.append({
          kind: "observe",
          name: "knowledge/promote_result",
          payload: { source_id: source.id, target_id: id, status: result.status, result_digest: result.digest },
        });
        return result;
      } catch (error) {
        input.log.append({
          kind: "observe",
          name: "knowledge/promote_result",
          payload: { source_id: source.id, target_id: id, status: "failed", reason: stableFailure(error) },
        });
        throw error;
      }
    },

    async resolve(resolveInput) {
      assertWritable(input.log, input.profile);
      const sourceId = validateDocumentId(resolveInput.sourceId);
      const targetId = validateDocumentId(resolveInput.targetId);
      if (sourceId === targetId) throw new Error("knowledge relation cannot target itself");
      if (resolveInput.relation !== "wiki:contradicts" && resolveInput.relation !== "wiki:supersedes") throw new Error("unsupported knowledge resolution relation");
      const current = requireIndex();
      const source = current.read(sourceId);
      const target = current.read(targetId);
      if (!source || !target) throw new Error("knowledge resolution requires existing source and target documents");
      const evidence = normalizeEvidence(resolveInput.evidence);
      const relation = { predicate: resolveInput.relation, target: targetId, evidence: evidence.locator };
      const document = parseKnowledgeMarkdown(source.path, serializeKnowledgeMarkdown({
        ...source,
        metadata: {
          ...source.metadata,
          relations: uniqueRelations([...source.metadata.relations, relation]),
          evidence: uniqueEvidence([...source.metadata.evidence, evidence]),
          updated_at: new Date().toISOString(),
        },
      }), { layout: input.profile!.layout });
      assertSafeKnowledgeBody(document);
      input.log.append({
        kind: "effect",
        name: "knowledge/resolve",
        payload: {
          document_id: sourceId,
          target_id: targetId,
          relation: resolveInput.relation,
          base_digest: source.digest,
          evidence_digest: sha256(canonicalJson(evidence)),
        },
      });
      try {
        const result = await service.writeDocument({ document, expectedDigest: source.digest });
        input.log.append({
          kind: "observe",
          name: "knowledge/resolve_result",
          payload: { document_id: sourceId, target_id: targetId, status: result.status, result_digest: result.digest },
        });
        return result;
      } catch (error) {
        input.log.append({
          kind: "observe",
          name: "knowledge/resolve_result",
          payload: { document_id: sourceId, target_id: targetId, status: "failed", reason: stableFailure(error) },
        });
        throw error;
      }
    },

    async migrate(documentId): Promise<KnowledgeMigrationResult> {
      assertWritable(input.log, input.profile);
      const id = validateDocumentId(documentId);
      const document = requireIndex().read(id);
      if (!document) throw new Error(`unknown knowledge document ${id}`);
      const absolute = safeVaultPath(input.profile!, document.path);
      const previous = readFileSync(absolute, "utf8");
      const migration = migrateKnowledgeMarkdown(document.path, previous);
      if (!migration.changed) return { id, from: migration.from, to: migration.to, changed: false, digest: migration.digest };
      assertSafeKnowledgeBody(migration.raw);
      input.log.append({ kind: "effect", name: "knowledge/migrate", payload: { document_id: id, from: migration.from, to: migration.to, base_digest: sha256(previous), result_digest: migration.digest } });
      try {
        const parsed = parseKnowledgeMarkdown(document.path, migration.raw, { layout: input.profile!.layout });
        await service.writeDocument({ document: parsed, expectedDigest: document.digest });
        input.log.append({ kind: "observe", name: "knowledge/migrate_result", payload: { document_id: id, status: "written", from: migration.from, to: migration.to, result_digest: migration.digest } });
        return { id, from: migration.from, to: migration.to, changed: true, digest: migration.digest };
      } catch (error) {
        input.log.append({ kind: "observe", name: "knowledge/migrate_result", payload: { document_id: id, status: "failed", reason: stableFailure(error) } });
        throw error;
      }
    },

    async checkpoint(checkpointInput) {
      assertWritable(input.log, input.profile);
      const projected = projectWorkCheckpoint(checkpointInput);
      const current = requireIndex();
      const id = `task:${validateOptionalIdentifier(projected.task, "task", true)}:worklog`;
      const existing = current.read(id);
      if (existing?.body.includes(`dokkabi-checkpoint:${projected.checkpointDigest}`)) {
        return { status: "unchanged", id, path: existing.path, digest: existing.digest, previous_digest: existing.digest, revision_digest: current.status().revision_digest };
      }
      const path = documentPath(input.profile!, "task", "worklog", projected.title, undefined, projected.task);
      const body = existing ? `${existing.body.trim()}\n\n${projected.body}\n` : `# ${projected.title}\n\n${projected.body}\n`;
      const document = parseKnowledgeMarkdown(path, serializeKnowledgeMarkdown({
        id,
        path,
        title: projected.title,
        body,
        metadata: {
          schema: CURRENT_WIKI_SCHEMA,
          id,
          kind: "worklog",
          scope: "task",
          task: projected.task,
          status: "active",
          visibility: input.profile!.visibility ?? "private",
          types: ["wiki:Worklog"],
          relations: [],
          evidence: projected.evidence,
          aliases: [],
          tags: ["dokkabi-worklog"],
        },
      }), { layout: input.profile!.layout });
      return service.writeDocument({ document, ...(existing ? { expectedDigest: existing.digest } : {}) });
    },

    async maintain(goalId): Promise<KnowledgeMaintenanceResult> {
      assertWritable(input.log, input.profile);
      const task = validateOptionalIdentifier(goalId, "goal", true)!;
      const previous = previousLintFingerprints(input.log.events);
      const existingId = `task:${task}:error`;
      const existingBefore = requireIndex().read(existingId);
      for (const match of existingBefore?.body.matchAll(/\b[a-f0-9]{64}\b/gu) ?? []) previous.add(match[0]);
      const issues = service.lint();
      const reportDigest = sha256(canonicalJson(issues.map((issue) => issue.fingerprint ?? "missing")));
      const recurringIssues = issues.filter((issue) => issue.fingerprint && previous.has(issue.fingerprint));
      const withAging = async (base: KnowledgeMaintenanceResult): Promise<KnowledgeMaintenanceResult> => {
        const aging = await runKnowledgeAging();
        return aging ? { ...base, aging } : base;
      };
      if (recurringIssues.length === 0) return withAging({ issues: issues.length, recurring: 0, report_digest: reportDigest });
      const fingerprints = unique(recurringIssues.map((issue) => issue.fingerprint!));
      const marker = sha256(canonicalJson(fingerprints));
      if (existingBefore?.body.includes(`dokkabi-error-book:${marker}`)) {
        return withAging({ issues: issues.length, recurring: fingerprints.length, report_digest: reportDigest });
      }
      const summaryEvent = [...input.log.events].reverse().find((event) => event.name === "knowledge/lint_summary");
      if (!summaryEvent) throw new Error("knowledge maintenance requires recorded lint evidence");
      const entry = [
        `<!-- dokkabi-error-book:${marker} -->`,
        `## ${summaryEvent.ts} — Recurring compiler defects`,
        "",
        ...recurringIssues
          .sort((a, b) => a.code.localeCompare(b.code) || a.fingerprint!.localeCompare(b.fingerprint!))
          .map((issue) => `- ${issue.code}: ${issue.fingerprint}`),
      ].join("\n");
      const title = `Error Book for ${task}`;
      const path = documentPath(input.profile!, "task", "error", title, undefined, task);
      const body = existingBefore ? `${existingBefore.body.trim()}\n\n${entry}\n` : `# ${title}\n\n${entry}\n`;
      const evidence: KnowledgeEvidence = { kind: "event", locator: `event:${summaryEvent.hash}`, digest: summaryEvent.hash };
      const document = parseKnowledgeMarkdown(path, serializeKnowledgeMarkdown({
        id: existingId,
        path,
        title,
        body,
        metadata: {
          schema: CURRENT_WIKI_SCHEMA,
          id: existingId,
          kind: "error",
          scope: "task",
          task,
          status: "active",
          visibility: input.profile!.visibility ?? "private",
          types: ["wiki:Incident"],
          relations: [],
          evidence: uniqueEvidence([...(existingBefore?.metadata.evidence ?? []), evidence]),
          aliases: [],
          tags: ["dokkabi-error-book"],
          created_at: existingBefore?.metadata.created_at ?? summaryEvent.ts,
          updated_at: summaryEvent.ts,
        },
      }), { layout: input.profile!.layout });
      const errorBook = await service.writeDocument({ document, ...(existingBefore ? { expectedDigest: existingBefore.digest } : {}) });
      return withAging({ issues: issues.length, recurring: fingerprints.length, report_digest: reportDigest, error_book: errorBook });
    },

    async writeDocument(writeInput): Promise<KnowledgeWriteResult> {
      assertWritable(input.log, input.profile);
      const profile = input.profile!;
      const document = writeInput.document;
      validateDocumentId(document.id);
      const absolute = safeVaultPath(profile, document.path);
      const previous = existsSync(absolute) ? sha256(readFileSync(absolute, "utf8")) : undefined;
      if (writeInput.expectedDigest !== undefined && previous !== writeInput.expectedDigest) {
        throw new Error(`stale knowledge write for ${document.id}`);
      }
      if (writeInput.expectedDigest === undefined && previous !== undefined) {
        throw new Error(`knowledge write would overwrite existing ${document.id} without a base digest`);
      }
      const raw = serializeKnowledgeMarkdown(document);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error("knowledge document exceeds the 1 MB write limit");
      assertSafeKnowledgeBody(raw);
      const digest = sha256(raw);
      if (previous === digest) {
        return { status: "unchanged", id: document.id, path: document.path, digest, previous_digest: previous, revision_digest: requireIndex().status().revision_digest };
      }
      const bodyBlob = store.put(raw);
      input.log.append({
        kind: "effect",
        name: "knowledge/write",
        payload: {
          document_id: document.id,
          path_digest: sha256(document.path),
          content_digest: digest,
          content_bytes: Buffer.byteLength(raw),
          base_digest: previous ?? "missing",
          blob: bodyBlob,
          blob_bytes: Buffer.byteLength(raw),
        },
      });
      try {
        mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
        assertNoSymlinkBetween(realpathSync(profile.root), dirname(absolute));
        const current = existsSync(absolute) ? sha256(readFileSync(absolute, "utf8")) : undefined;
        if (current !== previous) throw new Error(`stale knowledge write for ${document.id}`);
        const temporary = `${absolute}.dokkabi-tmp-${process.pid}-${Date.now()}`;
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, raw);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, absolute);
        chmodSync(absolute, 0o600);
        requireIndex().refresh();
        const status = requireIndex().status();
        const revision = status.revision_digest;
        input.log.append({
          kind: "observe",
          name: "knowledge/write_result",
          payload: {
            document_id: document.id,
            path_digest: sha256(document.path),
            status: "written",
            result_digest: digest,
            revision_digest: revision,
            documents: status.documents,
            relations: status.relations,
            orphans: status.orphans,
            errors: status.errors,
            warnings: status.warnings,
          },
        });
        ownedPaths.set(sha256(document.path), digest);
        return { status: "written", id: document.id, path: document.path, digest, ...(previous ? { previous_digest: previous } : {}), revision_digest: revision };
      } catch (error) {
        input.log.append({
          kind: "observe",
          name: "knowledge/write_result",
          payload: { document_id: document.id, path_digest: sha256(document.path), status: "failed", reason: stableFailure(error) },
        });
        throw error;
      }
    },

    async publish(publishInput: KnowledgePublishInput): Promise<KnowledgePublishResult> {
      assertPublishable(input.log, input.profile);
      const profile = input.profile!;
      const publisher = profile.publisher;
      if (publisher.kind !== "git") throw new Error("knowledge profile has no git publisher");
      const paths = unique(publishInput.paths.map((path) => normalizeLogicalPath(path))).sort();
      if (paths.length === 0 || paths.length > MAX_PUBLISH_PATHS) throw new Error("knowledge publish requires 1 to 100 exact paths");
      assertSafeKnowledgeBody(paths);
      const contentDigests: string[] = [];
      for (const path of paths) {
        const absolute = safeVaultPath(profile, path);
        if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error(`knowledge publish path is not a file: ${path}`);
        const owned = ownedPaths.get(sha256(path));
        const current = sha256(readFileSync(absolute, "utf8"));
        if (!owned || current !== owned) throw new Error("knowledge publish requires an unchanged transaction-owned path");
        contentDigests.push(current);
      }
      const message = cleanText(publishInput.message ?? "knowledge checkpoint", "commit message", 200);
      assertSafeKnowledgeBody(message);
      if (publishInput.push === true && !publisher.push) throw new Error("knowledge profile does not grant git push");
      const messageBlob = store.put(`${message}\n`);
      const pathDigests = paths.map((path) => sha256(path));
      const commitScopeDigest = sha256(canonicalJson({ path_digests: pathDigests, content_digests: contentDigests }));
      const publicationDigest = sha256(canonicalJson({ commit_scope_digest: commitScopeDigest, message_digest: sha256(message), push: publishInput.push === true }));
      input.log.append({
        kind: "effect",
        name: "knowledge/publish",
        payload: {
          path_digests: pathDigests,
          path_count: paths.length,
          publication_digest: publicationDigest,
          commit_scope_digest: commitScopeDigest,
          message_digest: sha256(message),
          push: publishInput.push === true,
          blob: messageBlob,
          blob_bytes: Buffer.byteLength(`${message}\n`),
        },
      });
      let commitCreated = false;
      let commitHead: string | undefined;
      try {
        const run = input.gitRunner ?? defaultGitRunner;
        const overlap = await run({ argv: ["git", "status", "--porcelain", "--", ...paths], cwd: profile.root });
        if (overlap.status !== 0) throw new Error("knowledge git status failed");
        if (overlap.stdout.split(/\r?\n/u).some((line) => line.length >= 2 && line[0] !== " " && line.slice(0, 2) !== "??")) {
          throw new Error("knowledge publish refuses an overlapping staged path");
        }
        await requireGitSuccess(run, { argv: ["git", "add", "--", ...paths], cwd: profile.root }, "stage");
        const diff = await run({ argv: ["git", "diff", "--cached", "--quiet", "--", ...paths], cwd: profile.root });
        if (diff.status === 0) {
          if (publishInput.push === true) {
            const expectedHead = retryablePushHeads.get(commitScopeDigest);
            if (!expectedHead) {
              input.log.append({ kind: "observe", name: "knowledge/publish_result", payload: { status: "unchanged", path_count: paths.length, publication_digest: publicationDigest, commit_scope_digest: commitScopeDigest } });
              return { status: "unchanged", paths };
            }
            if (expectedHead === "missing") throw new Error("knowledge git cannot verify the transaction-owned commit head");
            const actualHead = await readGitHead(run, profile.root);
            if (actualHead !== expectedHead) throw new Error("knowledge git branch head changed after the transaction-owned commit");
            await requireGitSuccess(run, { argv: ["git", "push", "--no-verify", publisher.remote], cwd: profile.root }, "push");
            retryablePushHeads.delete(commitScopeDigest);
            input.log.append({ kind: "observe", name: "knowledge/publish_result", payload: { status: "published", path_count: paths.length, publication_digest: publicationDigest, commit_scope_digest: commitScopeDigest } });
            return { status: "published", paths };
          }
          input.log.append({ kind: "observe", name: "knowledge/publish_result", payload: { status: "unchanged", path_count: paths.length, publication_digest: publicationDigest, commit_scope_digest: commitScopeDigest } });
          return { status: "unchanged", paths };
        }
        if (diff.status !== 1) throw new Error("knowledge git staged-diff check failed");
        await requireGitSuccess(run, { argv: ["git", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-F", "-", "--", ...paths], cwd: profile.root, stdin: `${message}\n` }, "commit");
        commitCreated = true;
        let status: KnowledgePublishResult["status"] = "committed";
        if (publishInput.push === true) {
          commitHead = await readGitHead(run, profile.root);
          retryablePushHeads.set(commitScopeDigest, commitHead);
          await requireGitSuccess(run, { argv: ["git", "push", "--no-verify", publisher.remote], cwd: profile.root }, "push");
          retryablePushHeads.delete(commitScopeDigest);
          status = "published";
        }
        input.log.append({ kind: "observe", name: "knowledge/publish_result", payload: { status, path_count: paths.length, publication_digest: publicationDigest, commit_scope_digest: commitScopeDigest, ...(commitHead ? { commit_head: commitHead } : {}) } });
        return { status, paths };
      } catch (error) {
        if (commitCreated) retryablePushHeads.set(commitScopeDigest, commitHead ?? "missing");
        input.log.append({ kind: "observe", name: "knowledge/publish_result", payload: { status: "failed", path_count: paths.length, publication_digest: publicationDigest, commit_scope_digest: commitScopeDigest, ...(commitCreated ? { commit_created: true } : {}), ...(commitHead ? { commit_head: commitHead } : {}), reason: stableFailure(error) } });
        throw error;
      }
    },
  };
  /** #110 knowledge lifecycle. Runs only when the profile opts in. Reference
   * signals are a pure projection of this session's recorded knowledge/read
   * events; "now" is the newest recorded event timestamp, never a live
   * clock. Every mutation goes through the guarded writeDocument path, and
   * deletion is never performed — only reported. The pass rewrites ONLY
   * documents it can reproduce byte-for-byte from its own serializer:
   * operator-authored files with custom frontmatter or non-canonical bytes
   * are spared and reported as skipped, never normalized. */
  async function runKnowledgeAging(): Promise<KnowledgeAgingResult | undefined> {
    const policy = input.profile?.aging;
    if (!policy) return undefined;
    const nowTs = input.log.events.at(-1)?.ts;
    if (nowTs === undefined) return undefined;
    const today = nowTs.slice(0, 10);
    // Whole-day arithmetic on both sides: touch stamps are date-only, so a
    // full-precision "now" against a midnight touch would age a document up
    // to a day early. Compare midnights to midnights.
    const now = Date.parse(today);
    if (Number.isNaN(now)) return undefined;
    const dayMs = 86_400_000;
    // One snapshot for the whole pass — requireIndex() rescans the vault,
    // and a pass that re-read it per document stalled every checkpoint.
    const index = requireIndex();
    const skipped: string[] = [];
    const touchedPaths: string[] = [];
    const rewrite = async (
      document: KnowledgeDocument,
      patch: Partial<Pick<KnowledgeMetadata, "lifecycle" | "last_referenced">>,
    ): Promise<boolean> => {
      try {
        const canonical = serializeKnowledgeMarkdown(document);
        if (sha256(canonical) !== document.digest) return false; // not ours to normalize
        const next = parseKnowledgeMarkdown(document.path, serializeKnowledgeMarkdown({
          id: document.id,
          path: document.path,
          title: document.title,
          body: document.body,
          metadata: { ...document.metadata, ...patch },
        }), { layout: input.profile!.layout });
        await service.writeDocument({ document: next, expectedDigest: document.digest });
        touchedPaths.push(document.path);
        return true;
      } catch {
        // A stale CAS or invalid id skips this document, never the milestone.
        return false;
      }
    };
    // 1. Refresh — a doc read this session keeps living, and reading an
    // archived doc revives it out of the forgetting zone. Bounded per pass.
    const referenced = new Set(
      input.log.events
        .filter((event) => event.name === "knowledge/read" && typeof event.payload.document_id === "string")
        .map((event) => event.payload.document_id as string),
    );
    const refreshed: string[] = [];
    for (const id of referenced) {
      if (refreshed.length >= MAX_AGING_WRITES) break;
      const document = index.read(id);
      if (!document) continue;
      const revive = document.metadata.lifecycle === "archive";
      if (!revive && document.metadata.last_referenced === today) continue;
      const patch = revive ? { last_referenced: today, lifecycle: undefined } : { last_referenced: today };
      if (await rewrite(document, patch)) refreshed.push(id);
      else skipped.push(id);
    }
    // 2. Demote to the forgetting zone / 3. report deletion candidates.
    const archived: string[] = [];
    const candidates: string[] = [];
    for (const document of index.list()) {
      const meta = document.metadata;
      if (meta.lifecycle === "core") continue;
      // A document read this session never ages in the same pass, even when
      // the refresh budget ran out before it was stamped.
      if (referenced.has(document.id)) continue;
      const touched = meta.last_referenced ?? meta.updated_at ?? meta.created_at;
      // updated_at/created_at may carry full timestamps; slice to the date so
      // both sides of the subtraction sit on midnights.
      const touchedMs = touched === undefined ? Number.NaN : Date.parse(touched.slice(0, 10));
      if (Number.isNaN(touchedMs)) continue; // an undated doc never ages
      const idleDays = (now - touchedMs) / dayMs;
      if (meta.lifecycle === "archive") {
        if (idleDays > policy.archiveAfterDays + policy.deleteAfterDays) candidates.push(document.id);
        continue;
      }
      if (idleDays > policy.archiveAfterDays && archived.length < MAX_AGING_WRITES) {
        if (await rewrite(document, { lifecycle: "archive" })) archived.push(document.id);
        else skipped.push(document.id);
      }
    }
    const aging: KnowledgeAgingResult = {
      now: today,
      refreshed: [...refreshed].sort(),
      archived: [...archived].sort(),
      delete_candidates: [...candidates].sort(),
      skipped: unique(skipped).sort(),
      touched_paths: unique(touchedPaths).sort(),
    };
    // The recorded summary bounds every id list so one huge vault cannot
    // bloat the log; the full lists stay in the maintenance result.
    const bounded = (values: string[]) => values.slice(0, MAX_AGING_EVENT_IDS);
    input.log.append({
      kind: "observe",
      name: "knowledge/aging",
      payload: {
        now: today,
        archive_after_days: policy.archiveAfterDays,
        delete_after_days: policy.deleteAfterDays,
        refreshed: bounded(aging.refreshed),
        archived: bounded(aging.archived),
        delete_candidates: bounded(aging.delete_candidates),
        skipped: bounded(aging.skipped),
        refreshed_count: aging.refreshed.length,
        archived_count: aging.archived.length,
        delete_candidate_count: aging.delete_candidates.length,
        skipped_count: aging.skipped.length,
      },
    });
    return aging;
  }

  return service;
}

function appendSafeStatus(log: EventLog, status: KnowledgeVaultStatus): void {
  log.append({
    kind: "observe",
    name: "knowledge/profile",
    payload: {
      profile: status.profile,
      dialect: status.dialect,
      layout: status.layout,
      writable: status.writable,
      publishable: status.publishable,
      documents: status.documents,
      relations: status.relations,
      orphans: status.orphans,
      errors: status.errors,
      warnings: status.warnings,
      revision_digest: status.revision_digest,
    },
  });
}

function appendLintSummary(log: EventLog, issues: readonly KnowledgeLintIssue[]): void {
  const fingerprints = unique(issues.flatMap((issue) => issue.fingerprint ? [issue.fingerprint] : [])).slice(0, 256);
  log.append({
    kind: "observe",
    name: "knowledge/lint_summary",
    payload: {
      issue_count: issues.length,
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      report_digest: sha256(canonicalJson(issues)),
      fingerprints,
      truncated: fingerprints.length < issues.length,
    },
  });
}

function previousLintFingerprints(events: readonly import("../host/schema.ts").EventRecord[]): Set<string> {
  const values = new Set<string>();
  for (const event of events) {
    if (event.name !== "knowledge/lint_summary" || !Array.isArray(event.payload.fingerprints)) continue;
    for (const value of event.payload.fingerprints) if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) values.add(value);
  }
  return values;
}

function readRecordedBlob<T>(payload: Record<string, unknown>, store: BlobStore): T {
  const blob = typeof payload.blob === "string" ? payload.blob : "";
  let body: string;
  try {
    body = store.get(blob);
  } catch (error) {
    if (error instanceof BlobIntegrityError) {
      throw new Error("knowledge replay blob digest mismatch");
    }
    throw new Error("knowledge replay blob is unavailable");
  }
  const expected = typeof payload.result_digest === "string" ? payload.result_digest : "";
  if (sha256(body) !== expected) throw new Error("knowledge replay result digest mismatch");
  return JSON.parse(body) as T;
}

function assertWritable(log: EventLog, profile: KnowledgeProfile | undefined): void {
  if (log.isReadOnly) throw new Error("knowledge replay is read-only");
  if (!profile?.permissions.write) throw new Error("active knowledge profile does not grant writes");
}

function assertPublishable(log: EventLog, profile: KnowledgeProfile | undefined): void {
  assertWritable(log, profile);
  if (!profile?.permissions.publish) throw new Error("active knowledge profile does not grant publish");
}

function safeVaultPath(profile: KnowledgeProfile, logicalPath: string): string {
  const path = normalizeLogicalPath(logicalPath);
  if (reservedKnowledgePath(path)) throw new Error("knowledge path targets reserved metadata or credential state");
  if (lstatSync(profile.root).isSymbolicLink()) throw new Error("knowledge vault root cannot be a symbolic link");
  const root = realpathSync(profile.root);
  const absolute = resolve(root, ...path.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("knowledge path escapes the vault");
  assertNoSymlinkBetween(root, existsSync(absolute) ? absolute : dirname(absolute));
  return absolute;
}

function assertNoSymlinkBetween(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("knowledge path escapes the vault");
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("knowledge path contains a symbolic link");
  }
}

function normalizeLogicalPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("knowledge path must be a relative logical path without traversal");
  }
  return path;
}

function normalizeQuery(query: KnowledgeQuery): KnowledgeQuery {
  if (query.kind && !["task", "worklog", "research", "claim", "decision", "experiment", "procedure", "incident", "artifact", "source", "concept", "error"].includes(query.kind)) {
    throw new Error("unsupported knowledge kind filter");
  }
  if (query.status && !["draft", "active", "verified", "deprecated"].includes(query.status)) {
    throw new Error("unsupported knowledge status filter");
  }
  if (query.truth_state && !["unverified", "current", "contested", "superseded", "deprecated"].includes(query.truth_state)) {
    throw new Error("unsupported knowledge truth-state filter");
  }
  return {
    ...(query.text?.trim() ? { text: cleanText(query.text, "query", 500) } : {}),
    ...(query.scope ? { scope: query.scope } : {}),
    ...(query.project ? { project: validateOptionalIdentifier(query.project, "project", true)! } : {}),
    ...(query.task ? { task: validateOptionalIdentifier(query.task, "task", true)! } : {}),
    ...(query.types?.length ? { types: unique(query.types.map((value) => cleanText(value, "type", 100))) } : {}),
    ...(query.tags?.length ? { tags: unique(query.tags.map((value) => cleanText(value, "tag", 100))) } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.truth_state ? { truth_state: query.truth_state } : {}),
    ...(query.include_archived === true ? { include_archived: true } : {}),
    limit: Math.max(1, Math.min(100, Math.trunc(query.limit ?? 10))),
  };
}

function normalizeFollow(options: KnowledgeFollowOptions): KnowledgeFollowOptions {
  return {
    ...(options.predicate ? { predicate: cleanText(options.predicate, "predicate", 100) } : {}),
    direction: options.direction ?? "both",
    depth: Math.max(1, Math.min(4, Math.trunc(options.depth ?? 1))),
    limit: Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50))),
  };
}

function normalizeRecord(input: JournalRecordInput, defaultVisibility: "private" | "team" | "public" = "private") {
  if (!["worklog", "research", "decision", "error"].includes(input.kind)) throw new Error("unsupported journal kind");
  if (!["task", "project", "shared"].includes(input.scope)) throw new Error("unsupported knowledge scope");
  const project = validateOptionalIdentifier(input.project, "project", input.scope === "project");
  const task = validateOptionalIdentifier(input.task, "task", input.scope === "task");
  const researchInput = input.research as Partial<NonNullable<JournalRecordInput["research"]>> | undefined;
  const research = researchInput ? {
    hypothesis: cleanText(researchInput.hypothesis, "research hypothesis", 10_000),
    method: cleanText(researchInput.method, "research method", 20_000),
    setup: cleanText(researchInput.setup, "research setup", 20_000),
    results: cleanText(researchInput.results, "research results", 50_000),
    analysis: cleanText(researchInput.analysis, "research analysis", 50_000),
    conclusion: cleanText(researchInput.conclusion, "research conclusion", 20_000),
    sources: Array.isArray(researchInput.sources)
      ? uniqueEvidence(researchInput.sources.map(normalizeEvidence))
      : (() => { throw new Error("knowledge research sources are required"); })(),
  } : undefined;
  if (input.kind === "research" && input.status === "verified" && !research) {
    throw new Error("verified research requires structured fields");
  }
  if (research && research.sources.length === 0) throw new Error("structured research requires source evidence");
  const evidence = uniqueEvidence([...(input.evidence ?? []).map(normalizeEvidence), ...(research?.sources ?? [])]);
  const normalized = {
    kind: input.kind,
    scope: input.scope,
    ...(project ? { project } : {}),
    ...(task ? { task } : {}),
    title: cleanText(input.title, "title", 200),
    summary: cleanText(input.summary, "summary", 2_000),
    ...(input.details?.trim() ? { details: cleanText(input.details, "details", 100_000) } : {}),
    status: input.status ?? (input.kind === "research" && !research ? "draft" : "active"),
    visibility: input.visibility ?? defaultVisibility,
    tags: unique((input.tags ?? []).map((value) => cleanText(value, "tag", 100))),
    types: unique(input.types?.map((value) => cleanText(value, "type", 100)) ?? [defaultType(input.kind)]),
    relations: uniqueRelations(input.relations ?? []),
    evidence,
    ...(research ? { research } : {}),
  };
  assertSafeKnowledgeBody(normalized);
  return normalized;
}

function recordIdentity(input: ReturnType<typeof normalizeRecord>): string {
  if (input.scope === "task") return `task:${input.task}:${input.kind}`;
  if (input.scope === "project") return `project:${input.project}:${slug(input.title)}`;
  return `shared:${slug(input.title)}`;
}

function documentPath(
  profile: KnowledgeProfile,
  scope: KnowledgeScope,
  kind: KnowledgeKind,
  title: string,
  project?: string,
  task?: string,
): string {
  return knowledgeDocumentPath({ layout: profile.layout, scope, kind, title, ...(project ? { project } : {}), ...(task ? { task } : {}) });
}

function validateDocumentId(value: string): string {
  const id = cleanText(value, "document id", 300);
  if (!/^[\p{L}\p{N}._-]+(?::[\p{L}\p{N}._-]+)+$/u.test(id)) throw new Error("invalid knowledge document id");
  assertSafeKnowledgeBody(id);
  return id;
}

function validateOptionalIdentifier(value: string | undefined, label: string, required: boolean): string | undefined {
  const clean = value?.trim();
  if (!clean) {
    if (required) throw new Error(`${label} is required for this knowledge scope`);
    return undefined;
  }
  if (!IDENTIFIER.test(clean)) throw new Error(`invalid knowledge ${label}`);
  return clean;
}

function cleanText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string") throw new Error(`knowledge ${label} is required`);
  const clean = value.trim();
  if (!clean) throw new Error(`knowledge ${label} cannot be empty`);
  if (clean.length > limit) throw new Error(`knowledge ${label} exceeds ${limit} characters`);
  return clean;
}

function assertSafeKnowledgeBody(value: unknown): void {
  assertNoSecrets(value);
  if (containsPrivateInfrastructureValue(value)) {
    throw new Error("knowledge write contains private infrastructure; keep it in protected runtime configuration");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueRelations<T extends { predicate: string; target: string; evidence?: string }>(values: T[]): T[] {
  const rows = new Map<string, T>();
  for (const value of values) {
    const predicate = cleanText(value.predicate, "relation predicate", 100);
    const target = validateDocumentId(value.target);
    const evidence = value.evidence ? cleanText(value.evidence, "relation evidence", 300) : undefined;
    if (evidence && !/^#[^\s]+$/u.test(evidence) && !/^(?:event|artifact|commit|test|document|source|operator):[^\s]+$/u.test(evidence)) {
      throw new Error("invalid knowledge relation evidence locator");
    }
    const row = { ...value, predicate, target, ...(evidence ? { evidence } : {}) } as T;
    rows.set(canonicalJson(row), row);
  }
  return [...rows.values()].sort((a, b) => a.predicate.localeCompare(b.predicate) || a.target.localeCompare(b.target));
}

function normalizeEvidence(value: KnowledgeEvidence): KnowledgeEvidence {
  if (!value || !["event", "artifact", "commit", "test", "document", "source", "operator"].includes(value.kind)) throw new Error("invalid knowledge evidence kind");
  const locator = cleanText(value.locator, "evidence locator", 400);
  if (!/^(?:event|artifact|commit|test|document|source|operator):[^\s]+$/u.test(locator)) throw new Error("invalid knowledge evidence locator");
  const digest = value.digest?.trim();
  if (digest && !/^[a-f0-9]{40,64}$/u.test(digest)) throw new Error("invalid knowledge evidence digest");
  return { kind: value.kind, locator, ...(digest ? { digest } : {}) };
}

function uniqueEvidence(values: KnowledgeEvidence[]): KnowledgeEvidence[] {
  const rows = new Map<string, KnowledgeEvidence>();
  for (const value of values) rows.set(canonicalJson(value), value);
  return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.locator.localeCompare(b.locator));
}

function defaultType(kind: KnowledgeKind): string {
  if (kind === "research") return "wiki:ResearchNote";
  if (kind === "error") return "wiki:Incident";
  if (kind === "concept") return "wiki:Claim";
  return `wiki:${capitalize(kind)}`;
}

function researchSection(
  now: string,
  summary: string,
  research: NonNullable<ReturnType<typeof normalizeRecord>["research"]>,
): string {
  return [
    `## ${now} — ${summary}`,
    "",
    summary,
    "",
    "### Hypothesis", research.hypothesis,
    "", "### Method", research.method,
    "", "### Setup", research.setup,
    "", "### Results", research.results,
    "", "### Analysis", research.analysis,
    "", "### Conclusion", research.conclusion,
    "", "### Sources", ...research.sources.map((source) => `- ${source.locator}${source.digest ? ` (${source.digest})` : ""}`),
  ].join("\n");
}

function visibilityRank(value: string): number {
  return value === "public" ? 3 : value === "team" ? 2 : 1;
}

function boundedBody(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value.trim();
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "").trim()}\n[truncated; use wiki_read for the complete document]`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

const defaultGitRunner: GitCommandRunner = async (request) => {
  const result = spawnSync(request.argv[0]!, [...request.argv.slice(1)], {
    cwd: request.cwd,
    encoding: "utf8",
    env: gitEnvironment(process.env),
    timeout: 30_000,
    input: request.stdin,
    stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 1_000_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "SSH_AUTH_SOCK" && /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL)/iu.test(key)) continue;
    safe[key] = value;
  }
  safe.GIT_TERMINAL_PROMPT = "0";
  safe.GCM_INTERACTIVE = "Never";
  return safe;
}

async function requireGitSuccess(
  runner: GitCommandRunner,
  request: GitCommandRequest,
  stage: string,
): Promise<void> {
  const result = await runner(request);
  if (result.status !== 0) throw new Error(`knowledge git ${stage} failed`);
}

async function readGitHead(runner: GitCommandRunner, cwd: string): Promise<string> {
  const result = await runner({ argv: ["git", "rev-parse", "HEAD"], cwd });
  const head = result.stdout.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("knowledge git commit head verification failed");
  return head;
}

function stableFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("secret") || message.includes("private infrastructure")) return "content_rejected";
  if (message.includes("stale") || message.includes("overwrite")) return "conflict";
  if (message.includes("git")) return "git_failed";
  if (message.includes("symlink") || message.includes("escapes") || message.includes("traversal")) return "path_rejected";
  return "operation_failed";
}
