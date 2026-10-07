import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventRecord } from "./schema.ts";
import type { CommitReceipt, SpanSpec, SpansPlan, WorkspaceVersionsApi } from "./workspace-versions.ts";
import { redactForEmission } from "./tool-result-input.ts";
import { DocumentText } from "./lsp/positions.ts";
import {
  closedReason,
  hostIdentity,
  LspNavigator,
  previewLine,
  redactedRow,
  safePath,
  validNewName,
  type LspBoundDocument,
  type LspPosition,
  type NavigationReason,
  type NavigationRecord,
} from "./lsp/navigation.ts";
import { containedFile } from "./lsp/uri.ts";

export { validNewName };

/**
 * #229 — rename plans and their application (design memo §134/§135:
 * N2', N2'', N3, N4, R1, M7, O1, O2, B1).
 * Lives beside host/lsp/ rather than inside it: it is the one LSP module that
 * writes (through #221), and host/lsp/ stays the read-only, verdict-free
 * diagnostics and navigation code (#222 D6's scan covers that directory).
 *
 * N3  `plan` records a normalised, immutable, host-owned plan under a
 *     host-issued `planRef`: per target (a host identity, N2'') the before
 *     digest, the byte spans the server's edits map to over those exact
 *     bytes, the after digest and bounded previews. `apply` takes only a
 *     planRef — never edits a model rewrote.
 * N2' An edit is the symbol's own text or nothing: the name is a non-empty
 *     identifier by the host's rule, every span is non-empty and equals it,
 *     and two spans never touch (`start <= previous end` refused) — checked
 *     here and again by the authority's span application.
 * M7  Every write is a `spans` change carrying a plan the AUTHORITY minted
 *     for this writer (`mintPlan`, host-only); the authority applies the
 *     plan's own spans and digest, never a caller's.
 * N4/O1 `apply` preflights every target before the first write; the outcome
 *     is a pure function of the commits: `conflict` with none (a refusal at
 *     the first commit included), `partial` with some, `applied` with all;
 *     an effect the authority could not record is `unresolved`.
 * O2  `rollback` derives from the recorded rows (the intent's targets and
 *     edits, the commit rows' after digests), never from memory; a plan with
 *     a recorded intent is never evicted; unapplied plans are bounded.
 * R1  Reason codes are the closed enumeration; server text only in `detail`,
 *     redacted.
 */

export const LSP_RENAME_FILES_MAX = 64;
export const LSP_RENAME_PATCH_MAX_BYTES = 1024 * 1024;
export const LSP_RENAME_PLANS_MAX = 32;
export const LSP_RENAME_PREVIEW_MAX_BYTES = 32 * 1024;

export type RenameCrashPoint = "after_intent" | "after_commit";

export interface RenameEdit {
  readonly startByte: number;
  readonly endByte: number;
  readonly replacement: string;
  /** The bytes replaced, as text: the symbol's name (for rollback). */
  readonly original: string;
}

export interface RenamePlanTarget {
  /** A host-minted id the rows key this target by (O2'). */
  readonly target: string;
  /** The path as the volume folds it (N2''). */
  readonly path: string;
  readonly identity: string;
  readonly beforeDigest: string;
  readonly beforeBytes: number;
  readonly afterDigest: string;
  readonly afterBytes: number;
  readonly edits: readonly RenameEdit[];
  /** `line: text` after the edits, one per changed line, bounded. */
  readonly preview: readonly string[];
}

export interface RenamePlan {
  readonly planRef: string;
  readonly requestRef: string;
  readonly profile?: string;
  readonly serverGeneration?: string;
  readonly document?: LspBoundDocument;
  readonly position: LspPosition;
  readonly oldName?: string;
  readonly newName: string;
  readonly status: "ready" | "stale" | "unsupported";
  readonly reason?: NavigationReason;
  readonly detail?: string;
  readonly documents: readonly RenamePlanTarget[];
  readonly files: number;
  readonly edits: number;
  readonly patchBytes: number;
  readonly previewOmitted: number;
}

export type RenameOutcomeStatus = "applied" | "unchanged" | "conflict" | "partial" | "cancelled" | "unresolved" | "unrecorded";

export interface RenameOutcome {
  readonly planRef: string;
  readonly status: RenameOutcomeStatus;
  readonly reason?: string;
  readonly committedReceipts: string[];
  readonly committedPaths: string[];
  readonly unresolvedPaths: string[];
  readonly refused: Array<{ readonly path: string; readonly code: string; readonly detail: string }>;
}

export interface RollbackOutcome {
  readonly planRef: string;
  readonly status: "rolled_back" | "partial" | "nothing" | "cancelled";
  readonly reason?: string;
  readonly rolledBack: readonly string[];
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly committedReceipts: readonly string[];
}

export type MintSpansPlan = (targets: ReadonlyArray<{ readonly path: string; readonly beforeDigest: string; readonly identity?: string; readonly spans: readonly SpanSpec[] }>) => SpansPlan | undefined;

export interface LspRenamerOptions {
  readonly navigator: LspNavigator;
  readonly versions: WorkspaceVersionsApi;
  /** The registered writer (#221): the apply tool's own object. */
  readonly writer: object;
  /** Test seam only: replaces the authority's own `mintSpansPlan` (M7''). */
  readonly mintPlan?: MintSpansPlan;
  readonly root: string;
  readonly rootId: string;
  readonly log?: { readonly events: readonly EventRecord[]; readonly isReadOnly: boolean };
  readonly record?: NavigationRecord;
  readonly filesMax?: number;
  readonly patchMaxBytes?: number;
  readonly previewMaxBytes?: number;
  readonly now?: () => number;
  /** Test seam: a throw here is a crash at that boundary. */
  readonly crash?: (point: RenameCrashPoint, planRef: string, index?: number) => void;
  /** Test seam: runs right before a target's commit (a racing writer). */
  readonly beforeCommit?: (path: string, index: number) => void;
  readonly applyTool?: string;
  readonly rollbackTool?: string;
}

interface Entry {
  readonly plan: RenamePlan;
  used: boolean;
}

const PLAN_REF = /^rp_[0-9a-f]{32}$/u;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** O1: the outcome the commits alone determine. */
export function outcomeOf(targets: number, committed: number, unresolved: boolean): RenameOutcomeStatus {
  if (unresolved) return "unresolved";
  if (committed === 0) return "conflict";
  return committed >= targets ? "applied" : "partial";
}

export class LspRenamer {
  private readonly plans = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly applyTool: string;
  private readonly rollbackTool: string;
  private readonly mint: MintSpansPlan | undefined;

  constructor(private readonly options: LspRenamerOptions) {
    this.now = options.now ?? Date.now;
    // M7'': the authority this renamer was constructed with mints, or nothing does.
    const instance = options.versions.mintSpansPlan;
    this.mint = options.mintPlan ?? (typeof instance === "function" ? (targets) => instance.call(options.versions, targets) : undefined);
    this.applyTool = options.applyTool ?? "lsp_rename_apply";
    this.rollbackTool = options.rollbackTool ?? "lsp_rename_rollback";
    if (options.log && !options.log.isReadOnly) this.reconcile(options.log.events);
  }

  get(planRef: string): RenamePlan | undefined {
    return this.plans.get(planRef)?.plan;
  }

  // ------------------------------------------------------------------ plan

  async plan(input: { readonly path: string; readonly position: LspPosition; readonly newName: string }, callId = "", signal?: AbortSignal): Promise<RenamePlan> {
    const planRef = `rp_${randomBytes(16).toString("hex")}`;
    const filesMax = this.options.filesMax ?? LSP_RENAME_FILES_MAX;
    const patchMax = this.options.patchMaxBytes ?? LSP_RENAME_PATCH_MAX_BYTES;
    const previewMax = this.options.previewMaxBytes ?? LSP_RENAME_PREVIEW_MAX_BYTES;
    const newName = typeof input.newName === "string" ? input.newName : "";
    const position = Object.freeze({ line: Number(input.position?.line), character: Number(input.position?.character) });
    const finish = (plan: Omit<RenamePlan, "planRef" | "position" | "newName" | "files" | "edits" | "patchBytes" | "previewOmitted" | "documents" | "reason" | "detail"> & Partial<Pick<RenamePlan, "files" | "edits" | "patchBytes" | "previewOmitted" | "documents">> & { reason?: string; detail?: string }): RenamePlan => {
      const closed = plan.reason !== undefined ? closedReason(plan.reason, plan.detail) : undefined;
      const { reason: _raw, detail: _rawDetail, ...rest } = plan;
      void _raw; void _rawDetail;
      const documents = Object.freeze((plan.documents ?? []).map((target) => Object.freeze({
        ...target, edits: Object.freeze(target.edits.map((edit) => Object.freeze({ ...edit }))), preview: Object.freeze([...target.preview]),
      })));
      const full: RenamePlan = Object.freeze({
        planRef, position, newName, files: documents.length,
        edits: documents.reduce((sum, target) => sum + target.edits.length, 0),
        patchBytes: plan.patchBytes ?? 0, previewOmitted: plan.previewOmitted ?? 0,
        ...rest, ...(closed ? { reason: closed.reason } : {}), ...(closed?.detail !== undefined ? { detail: closed.detail } : {}), documents,
      });
      // R2: the row is built through the redactor and written before the plan
      // exists; a plan whose row could not be written is `unrecorded`.
      const row = redactedRow({
        plan: planRef, request: full.requestRef, call: callId,
        ...(full.profile !== undefined ? { profile: full.profile } : {}),
        ...(full.serverGeneration !== undefined ? { generation: full.serverGeneration } : {}),
        ...(full.document ? { version: full.document.documentVersion, source_digest: full.document.sourceDigest, path: safePath(full.document.relativePath), identity: full.document.identity } : { path: safePath(String(input.path).slice(0, 4096)) }),
        line: position.line, character: position.character,
        ...(full.oldName !== undefined ? { old_name: safePath(full.oldName) } : {}), new_name: safePath(newName),
        status: full.status, ...(full.reason !== undefined ? { reason: full.reason } : {}), ...(full.detail !== undefined ? { detail: full.detail } : {}),
        files: full.files, edits: full.edits, patch_bytes: full.patchBytes,
        bounds: { files_max: filesMax, patch_max_bytes: patchMax },
        documents: full.documents.map((target) => ({ target: target.target, path: safePath(target.path), path_digest: pathDigest(target.path), identity: target.identity, before: target.beforeDigest, after: target.afterDigest, bytes: target.beforeBytes, edits: target.edits.length })),
      });
      try {
        this.record("lsp/rename_plan", row);
      } catch {
        return Object.freeze({ ...full, status: "unsupported", reason: "unrecorded", documents: Object.freeze([]), files: 0, edits: 0, patchBytes: 0 });
      }
      this.plans.set(planRef, { plan: full, used: false });
      // O2: only unapplied plans are bounded; one with a recorded intent stays.
      const unapplied = [...this.plans.entries()].filter(([, entry]) => !entry.used);
      for (const [ref] of unapplied.slice(0, Math.max(0, unapplied.length - LSP_RENAME_PLANS_MAX))) this.plans.delete(ref);
      return full;
    };
    if (this.options.log?.isReadOnly) return finish({ requestRef: "", status: "unsupported", reason: "read_only" });
    if (this.mint === undefined) return finish({ requestRef: "", status: "unsupported", reason: "no_version_authority" });
    if (!validNewName("lsp", newName) && !validNewName("tsserver", newName)) return finish({ requestRef: "", status: "unsupported", reason: "new_name_invalid" });
    const result = await this.options.navigator.rename({ path: input.path, position, newName, targetsMax: filesMax }, signal);
    if (!result.ok) {
      return finish({
        requestRef: result.requestRef, status: result.status === "stale" ? "stale" : "unsupported", reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        ...(result.oldName !== undefined ? { oldName: result.oldName } : {}),
        ...(result.document ? { document: result.document, profile: result.document.profile, serverGeneration: result.document.serverGeneration } : {}),
      });
    }
    const head = { requestRef: result.requestRef, document: result.document, profile: result.document.profile, serverGeneration: result.document.serverGeneration, oldName: result.oldName };
    const refuse = (reason: NavigationReason): RenamePlan => finish({ ...head, status: "unsupported", reason });
    if (result.targets.length > filesMax) return refuse("oversize_files");
    const targets: RenamePlanTarget[] = [];
    let patchBytes = 0;
    let previewBytes = 0;
    let previewOmitted = 0;
    let editCount = 0;
    for (const target of result.targets) {
      const edits: RenameEdit[] = [];
      for (const edit of target.edits) {
        const mapped = target.text.mapRange(edit.range);
        if (typeof mapped === "string") return refuse("invalid_range");
        // N2': non-empty, the symbol's own text.
        if (mapped.endByte <= mapped.startByte) return refuse("invalid_range");
        const original = target.bytes.subarray(mapped.startByte, mapped.endByte).toString("utf8");
        if (original !== result.oldName) return refuse("edit_text_mismatch");
        // N2''': the replacement is exactly prefix + newName + suffix, where the
        // prefix/suffix are the server's declared values for this location and
        // each matches the dialect's closed shape (`old: `, `old as `, ` as old`).
        if (!declaredReplacement(edit, newName, result.oldName)) return refuse("edit_text_unexpected");
        edits.push({ startByte: mapped.startByte, endByte: mapped.endByte, replacement: edit.newText, original });
      }
      edits.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
      // N2': two identifier occurrences cannot touch — `start <= previous end` is refused.
      for (let index = 1; index < edits.length; index += 1) {
        if (edits[index]!.startByte <= edits[index - 1]!.endByte) return refuse("overlapping_edits");
      }
      for (const edit of edits) patchBytes += (edit.endByte - edit.startByte) + Buffer.byteLength(edit.replacement, "utf8");
      if (patchBytes > patchMax) return refuse("oversize_patch");
      if (edits.length === 0) continue;
      editCount += edits.length;
      const after = applyEdits(target.bytes, edits);
      const afterText = DocumentText.fromBytes(after);
      const preview: string[] = [];
      const seen = new Set<number>();
      for (const edit of edits) {
        const line = lineOfByte(target.text, edit.startByte);
        if (seen.has(line)) continue;
        seen.add(line);
        const text = afterText ? `${line + 1}: ${previewLine(afterText, line)}` : `${line + 1}: (not UTF-8 after the edit)`;
        const cost = Buffer.byteLength(text, "utf8");
        if (previewBytes + cost > previewMax) {
          previewOmitted += 1;
          continue;
        }
        previewBytes += cost;
        preview.push(text);
      }
      targets.push({
        target: `rt_${randomBytes(8).toString("hex")}`,
        path: target.path, identity: target.identity, beforeDigest: sha256(target.bytes), beforeBytes: target.bytes.length,
        afterDigest: sha256(after), afterBytes: after.length, edits, preview,
      });
    }
    if (editCount === 0) return refuse("no_edits");
    const own = targets.find((target) => target.path === result.document.relativePath);
    if (own && own.beforeDigest !== result.document.sourceDigest) return finish({ ...head, status: "stale", reason: "source_changed" });
    return finish({ ...head, status: "ready", documents: targets, patchBytes, previewOmitted });
  }

  // ----------------------------------------------------------------- apply

  async apply(planRef: string, callId = "", signal?: AbortSignal): Promise<RenameOutcome> {
    const ref = typeof planRef === "string" && PLAN_REF.test(planRef) ? planRef : undefined;
    const entry = ref !== undefined ? this.plans.get(ref) : undefined;
    const finish = (outcome: Omit<RenameOutcome, "planRef" | "committedReceipts" | "committedPaths" | "unresolvedPaths" | "refused"> & Partial<RenameOutcome>): RenameOutcome => {
      const full: RenameOutcome = { planRef: ref ?? "", committedReceipts: [], committedPaths: [], unresolvedPaths: [], refused: [], ...outcome };
      try {
        this.record("lsp/rename_outcome", redactedRow({
          plan: ref ?? safePath(String(planRef).slice(0, 64)), call: callId, status: full.status,
          ...(full.reason !== undefined ? { reason: full.reason } : {}),
          committed: full.committedReceipts, committed_paths: full.committedPaths.map(safePath), committed_targets: full.committedPaths.map((path) => entry?.plan.documents.find((target) => target.path === path)?.target ?? pathDigest(path)),
          unresolved_paths: full.unresolvedPaths.map(safePath), unresolved_targets: full.unresolvedPaths.map((path) => entry?.plan.documents.find((target) => target.path === path)?.target ?? pathDigest(path)),
          ...(full.refused.length > 0 ? { refused: full.refused.map((entry) => ({ path: safePath(entry.path), path_digest: pathDigest(entry.path), code: entry.code })) } : {}),
        }));
      } catch {
        // R2: the terminal row could not be written; the outcome says so and
        // a restart reconciles from the authority's rows.
        return { ...full, status: "unrecorded", reason: "unrecorded" };
      }
      return full;
    };
    if (!entry) return finish({ status: "cancelled", reason: "unknown_plan_ref" });
    if (entry.used) return finish({ status: "cancelled", reason: "plan_used" });
    if (entry.plan.status !== "ready") return finish({ status: "cancelled", reason: "plan_not_ready" });
    if (this.options.log?.isReadOnly) return finish({ status: "cancelled", reason: "read_only" });
    if (signal?.aborted) return finish({ status: "cancelled", reason: "aborted" });
    entry.used = true;
    const plan = entry.plan;
    // M7: the authority mints the spans plan for this writer; without one, nothing is authorised.
    const minted = this.mint?.(plan.documents.map((target) => ({ path: target.path, beforeDigest: target.beforeDigest, identity: target.identity, spans: spansOf(target.edits) })));
    if (!minted) return finish({ status: "cancelled", reason: "no_version_authority" });
    // R2: the intent row - built through the redactor, lengths kept so a
    // rollback can be derived even where a text had to be redacted - is
    // written before the first authorization; without it nothing is written.
    try {
      this.record("lsp/rename_intent", redactedRow({
        plan: plan.planRef, call: callId, tool: this.applyTool, spans_plan: minted.ref,
        targets: plan.documents.map((target) => ({
          target: target.target, path: safePath(target.path), path_digest: pathDigest(target.path), identity: target.identity, before: target.beforeDigest, after: target.afterDigest,
          edits: target.edits.map((edit) => ({
            start: edit.startByte, end: edit.endByte,
            replacement: edit.replacement, replacement_bytes: Buffer.byteLength(edit.replacement, "utf8"), replacement_redacted: redactForEmission(edit.replacement) !== edit.replacement,
            original: edit.original, original_bytes: Buffer.byteLength(edit.original, "utf8"), original_redacted: redactForEmission(edit.original) !== edit.original,
          })),
        })),
      }));
    } catch {
      return finish({ status: "unrecorded", reason: "unrecorded" });
    }
    this.options.crash?.("after_intent", plan.planRef);
    // N4: every target preflighted before the first write.
    const grants: Array<Awaited<ReturnType<WorkspaceVersionsApi["authorize"]>> & { ok: true }> = [];
    const refused: Array<{ path: string; code: string; detail: string }> = [];
    for (const target of plan.documents) {
      const decision = await this.options.versions.authorize({
        caller: this.options.writer, path: target.path, callId, tool: this.applyTool, change: { kind: "spans", plan: minted },
      });
      if (decision.ok) grants.push(decision);
      else refused.push({ path: target.path, code: decision.code, detail: decision.detail });
    }
    if (refused.length > 0) {
      const unchanged = plan.documents.every((target) => this.liveDigest(target.path) === target.afterDigest);
      return finish({ status: unchanged ? "unchanged" : "conflict", refused });
    }
    const committedReceipts: string[] = [];
    const committedPaths: string[] = [];
    const receipts: CommitReceipt[] = [];
    let unresolved = false;
    let unrecorded = false;
    for (const [index, decision] of grants.entries()) {
      const target = plan.documents[index]!;
      this.options.beforeCommit?.(target.path, index);
      const result = await this.options.versions.commit(decision.grant);
      if (result.status === "committed") {
        committedReceipts.push(result.receipt.operationId);
        committedPaths.push(target.path);
        receipts.push(result.receipt);
        try {
          this.record("lsp/rename_commit", redactedRow({ plan: plan.planRef, call: callId, target: target.target, path: safePath(target.path), path_digest: pathDigest(target.path), operation: result.receipt.operationId, after: result.receipt.after.digest, index }));
        } catch {
          // R2: nothing is written after a step that could not be recorded.
          unrecorded = true;
          break;
        }
        this.options.crash?.("after_commit", plan.planRef, index);
        continue;
      }
      if (result.status === "refused") refused.push({ path: target.path, code: result.code, detail: result.detail });
      else unresolved = true;
      break;
    }
    const unresolvedPaths = plan.documents.map((target) => target.path).filter((path) => !committedPaths.includes(path));
    // O1: the commits alone say what happened.
    const status = unrecorded ? "unrecorded" : outcomeOf(plan.documents.length, committedPaths.length, unresolved);
    const outcome = finish({ status, ...(unrecorded ? { reason: "unrecorded" } : {}), committedReceipts, committedPaths, unresolvedPaths, refused });
    // N5: #222 re-checks every committed file against the others' new bytes.
    if (receipts.length > 1) this.options.navigator.recheck(receipts);
    return outcome;
  }

  // -------------------------------------------------------------- rollback

  /**
   * O2: a rollback is derived from the rows — the intent's targets and edits
   * and the commits the authority recorded for that apply — never from a
   * plan in memory; each file is reverted through the authority only while
   * its bytes still equal the recorded after digest, as its own commit.
   */
  async rollback(planRef: string, callId = ""): Promise<RollbackOutcome> {
    const ref = typeof planRef === "string" && PLAN_REF.test(planRef) ? planRef : undefined;
    const ids = new Map<string, string>();
    const idOf = (path: string) => ids.get(path) ?? pathDigest(path);
    const finish = (outcome: Omit<RollbackOutcome, "planRef" | "rolledBack" | "kept" | "committedReceipts"> & Partial<RollbackOutcome>): RollbackOutcome => {
      const full: RollbackOutcome = { planRef: ref ?? "", rolledBack: [], kept: [], committedReceipts: [], ...outcome };
      try {
        this.record("lsp/rename_rollback", redactedRow({
          plan: ref ?? safePath(String(planRef).slice(0, 64)), call: callId, status: full.status,
          ...(full.reason !== undefined ? { reason: full.reason } : {}),
          rolled_back: full.rolledBack.map(safePath), rolled_back_targets: full.rolledBack.map((path) => idOf(path)),
        kept: full.kept.map((entry) => ({ path: safePath(entry.path), target: idOf(entry.path), reason: entry.reason })), committed: full.committedReceipts,
        }));
      } catch {
        return { ...full, status: "cancelled", reason: "unrecorded" };
      }
      return full;
    };
    if (ref === undefined) return finish({ status: "cancelled", reason: "unknown_plan_ref" });
    const log = this.options.log;
    if (!log) return finish({ status: "cancelled", reason: "no_log" });
    if (log.isReadOnly) return finish({ status: "cancelled", reason: "read_only" });
    const recorded = recordedApply(log.events, ref, this.options.rootId);
    if (!recorded) return finish({ status: "cancelled", reason: "not_applied" });
    // In plan order (the files are independent; the rows list them so).
    const candidates = [...recorded.committed.keys()].filter((id) => !recorded.settled.has(id));
    if (candidates.length === 0) return finish({ status: "nothing" });
    const rolledBack: string[] = [];
    const kept: Array<{ path: string; reason: string }> = [];
    const receipts: string[] = [];
    const remembered = this.plans.get(ref)?.plan.documents ?? [];
    for (const id of candidates) {
      const target = recorded.targets.get(id)!;
      const after = recorded.committed.get(id)!;
      // O2': the target is its id + identity; the path to write is resolved
      // from this process's plan, from the row when it was recordable, or
      // from the identity on disk — never from redacted display text.
      const path = remembered.find((document) => document.target === id)?.path
        ?? (target.pathRedacted ? this.pathOfIdentity(target.identity) : target.path);
      if (path === undefined) {
        kept.push({ path: target.path, reason: "path_unresolved" });
        continue;
      }
      ids.set(path, id);
      const live = this.liveDigest(path);
      if (live === undefined) {
        kept.push({ path, reason: "unreadable" });
        continue;
      }
      if (live !== after) {
        // N4: an external writer's later change is never erased (and, once
        // recorded here, never revisited).
        kept.push({ path, reason: "external_change" });
        continue;
      }
      if (target.edits.some((edit) => edit.originalRedacted)) {
        // The rows could not carry the symbol's original text (a credential
        // shape): what to write back is unknown, so the file is kept.
        kept.push({ path, reason: "original_unrecorded" });
        continue;
      }
      const minted = this.mint?.([{ path, beforeDigest: after, identity: target.identity, spans: inverseSpans(target.edits) }]);
      if (!minted) {
        kept.push({ path, reason: "no_version_authority" });
        continue;
      }
      const decision = await this.options.versions.authorize({ caller: this.options.writer, path, callId, tool: this.rollbackTool, change: { kind: "spans", plan: minted } });
      if (!decision.ok) {
        kept.push({ path, reason: decision.code });
        continue;
      }
      const result = await this.options.versions.commit(decision.grant);
      if (result.status !== "committed") {
        kept.push({ path, reason: result.status === "refused" ? result.code : "unresolved" });
        continue;
      }
      rolledBack.push(path);
      receipts.push(result.receipt.operationId);
    }
    return finish({ status: rolledBack.length === candidates.length ? "rolled_back" : "partial", rolledBack, kept, committedReceipts: receipts });
  }

  // ------------------------------------------------------------ reconcile

  /**
   * RESTART (N4/O1): an `lsp/rename_intent` with no `lsp/rename_outcome` is
   * an apply a crash interrupted. Its outcome is rebuilt from the
   * authority's own rows (`workspace/mutation_committed` of the apply's
   * call, and the dangling intents the authority reconciled as unresolved),
   * keyed by the folded path, and recorded once; nothing is written and the
   * plan is not restored.
   */
  private reconcile(events: readonly EventRecord[]): void {
    const open = new Map<string, RecordedIntent>();
    for (const event of events) {
      const p = event.payload;
      if (event.name === "lsp/rename_intent" && typeof p.plan === "string") open.set(p.plan, readIntent(event));
      else if (event.name === "lsp/rename_outcome" && typeof p.plan === "string") open.delete(p.plan);
    }
    for (const [plan, intent] of open) {
      const { committed, unresolved } = commitsOf(events, intent, this.options.rootId);
      const committedIds = [...intent.targets.keys()].filter((id) => committed.has(id));
      const unresolvedIds = [...intent.targets.keys()].filter((id) => !committed.has(id));
      const live: Record<string, string> = {};
      let evidence = false;
      for (const [id, target] of intent.targets) {
        const path = target.pathRedacted ? this.pathOfIdentity(target.identity) : target.path;
        const digest = path === undefined ? undefined : this.liveDigest(path);
        const state = digest === undefined ? "unknown" : digest === target.after ? "after" : digest === target.before ? "before" : "other";
        if (!committed.has(id) && state !== "before") evidence = true;
        live[target.path] = state;
      }
      const display = (id: string) => intent.targets.get(id)!.path;
      // O3: live evidence beats absence - a target not recorded as committed
      // that no longer holds its before bytes is unresolved, never "not
      // applied"; `cancelled` needs no rows AND every target at `before`.
      const base = outcomeOf(intent.targets.size, committedIds.length, unresolved.size > 0 || evidence);
      const status = base === "conflict" ? "cancelled" : base;
      this.record("lsp/rename_outcome", redactedRow({
        plan, call: intent.call, status, reconciled: true,
        reason: status === "cancelled" ? "interrupted_before_first_commit" : "interrupted",
        committed: committedIds.map((id) => committed.get(id)!.operation), committed_paths: committedIds.map(display), committed_targets: committedIds,
        unresolved_paths: unresolvedIds.map(display), unresolved_targets: unresolvedIds,
        live,
      }));
    }
  }

  /** O2': the folded path of a file by its identity (device:inode), found by a
   * bounded, link-free walk of the root — for a target whose path the rows
   * could carry only redacted. */
  private pathOfIdentity(identity: string): string | undefined {
    const [dev, ino] = identity.split(":");
    let visited = 0;
    const walk = (dir: string, rel: string): string | undefined => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return undefined;
      }
      for (const name of entries) {
        if ((visited += 1) > 50_000) return undefined;
        const abs = join(dir, name);
        let stat;
        try {
          stat = lstatSync(abs, { bigint: true });
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        const here = rel ? `${rel}/${name}` : name;
        if (stat.isFile() && String(stat.dev) === dev && String(stat.ino) === ino) return here;
        if (stat.isDirectory() && name !== "node_modules" && name !== ".git") {
          const found = walk(abs, here);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    return walk(this.options.root, "");
  }

  private liveDigest(path: string): string | undefined {
    const contained = containedFile(this.options.root, join(this.options.root, path));
    if (!contained.ok) return undefined;
    const host = hostIdentity(this.options.root, contained.abs);
    if (!host || host.rel !== path) return undefined;
    try {
      return sha256(readFileSync(host.abs));
    } catch {
      return undefined;
    }
  }

  /** R2: a lifecycle row that cannot be written is an error the step sees. */
  private record(name: Parameters<NavigationRecord>[0], payload: Record<string, unknown>): void {
    this.options.record?.(name, payload);
  }
}

// ---------------------------------------------------------------- rows

interface RecordedTarget {
  /** The display path (redacted when it had to be). */
  readonly path: string;
  readonly pathDigest: string;
  readonly pathRedacted: boolean;
  readonly identity: string;
  readonly before: string;
  readonly after: string;
  readonly edits: ReadonlyArray<RenameEdit & { readonly replacementBytes: number; readonly originalRedacted: boolean }>;
}

interface RecordedIntent {
  readonly call: string;
  readonly seq: number;
  /** By host-minted target id (O2'). */
  readonly targets: Map<string, RecordedTarget>;
}

function readIntent(event: EventRecord): RecordedIntent {
  const p = event.payload;
  const targets = new Map<string, RecordedTarget>();
  for (const [order, raw] of (Array.isArray(p.targets) ? (p.targets as unknown[]) : []).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const target = raw as Record<string, unknown>;
    if (typeof target.path !== "string") continue;
    const id = typeof target.target === "string" ? target.target : `legacy_${order}`;
    const pathDigest = typeof target.path_digest === "string" ? target.path_digest : sha256(Buffer.from(target.path, "utf8")).slice(0, 16);
    const edits: Array<RenameEdit & { replacementBytes: number; originalRedacted: boolean }> = [];
    for (const item of Array.isArray(target.edits) ? (target.edits as unknown[]) : []) {
      if (!item || typeof item !== "object") continue;
      const edit = item as Record<string, unknown>;
      if (typeof edit.start === "number" && typeof edit.end === "number" && typeof edit.replacement === "string" && typeof edit.original === "string") {
        edits.push({
          startByte: edit.start, endByte: edit.end, replacement: edit.replacement, original: edit.original,
          replacementBytes: typeof edit.replacement_bytes === "number" ? edit.replacement_bytes : Buffer.byteLength(edit.replacement, "utf8"),
          originalRedacted: edit.original_redacted === true,
        });
      }
    }
    targets.set(id, {
      path: target.path, pathDigest, pathRedacted: pathDigest !== sha256(Buffer.from(target.path, "utf8")).slice(0, 16),
      identity: String(target.identity ?? ""), before: String(target.before ?? ""), after: String(target.after ?? ""), edits,
    });
  }
  return { call: typeof p.call === "string" ? p.call : "", seq: event.seq, targets };
}

/** The authority's own path key in a row (`path_digest`), host-minted. */
function pathDigest(path: string): string {
  return sha256(Buffer.from(path, "utf8")).slice(0, 16);
}

/** The commits the authority recorded for an apply, by folded path, and the
 * targets it left unresolved. */
function commitsOf(events: readonly EventRecord[], intent: RecordedIntent, rootId: string): { committed: Map<string, { operation: string; after: string }>; unresolved: Set<string> } {
  const committed = new Map<string, { operation: string; after: string }>();
  const unresolved = new Set<string>();
  const dangling = new Map<string, string>();
  // O2': the authority's rows are matched by their host-minted `path_digest`.
  const byDigest = new Map<string, string>();
  for (const [id, target] of intent.targets) byDigest.set(target.pathDigest, id);
  for (const event of events) {
    if (event.seq <= intent.seq) continue;
    const p = event.payload;
    if (!event.name.startsWith("workspace/") || p.root !== rootId) continue;
    const id = typeof p.path_digest === "string" ? byDigest.get(p.path_digest) : undefined;
    const operation = typeof p.operation === "string" ? p.operation : undefined;
    if (id === undefined || operation === undefined) continue;
    const ours = intent.call !== "" && p.call === intent.call;
    if (event.name === "workspace/mutation_intent" && ours) dangling.set(operation, id);
    else if (event.name === "workspace/mutation_committed" && (ours || dangling.has(operation))) {
      const after = p.after && typeof p.after === "object" ? String((p.after as { digest?: unknown }).digest ?? "") : "";
      committed.set(id, { operation, after });
      dangling.delete(operation);
    } else if (event.name === "workspace/mutation_refused" && dangling.has(operation)) dangling.delete(operation);
    else if (event.name === "workspace/mutation_reconciled" && dangling.has(operation)) {
      dangling.delete(operation);
      if (p.outcome === "unresolved") unresolved.add(id);
    }
  }
  for (const id of dangling.values()) unresolved.add(id);
  return { committed, unresolved };
}

/** What the rows say of one plan's apply: its targets (with edits), the
 * commits in plan order, and the paths a rollback already settled. */
function recordedApply(events: readonly EventRecord[], plan: string, rootId: string): { targets: RecordedIntent["targets"]; committed: Map<string, string>; settled: Set<string> } | undefined {
  const intentRow = events.find((event) => event.name === "lsp/rename_intent" && event.payload.plan === plan);
  if (!intentRow) return undefined;
  const intent = readIntent(intentRow);
  const { committed } = commitsOf(events, intent, rootId);
  const ordered = new Map<string, string>();
  for (const id of intent.targets.keys()) {
    const commit = committed.get(id);
    if (commit) ordered.set(id, commit.after);
  }
  const settled = new Set<string>();
  for (const event of events) {
    if (event.name !== "lsp/rename_rollback" || event.payload.plan !== plan) continue;
    for (const id of Array.isArray(event.payload.rolled_back_targets) ? (event.payload.rolled_back_targets as unknown[]) : []) if (typeof id === "string") settled.add(id);
    for (const entry of Array.isArray(event.payload.kept) ? (event.payload.kept as unknown[]) : []) {
      if (entry && typeof entry === "object" && (entry as { reason?: unknown }).reason === "external_change" && typeof (entry as { target?: unknown }).target === "string") settled.add((entry as { target: string }).target);
    }
  }
  return { targets: intent.targets, committed: ordered, settled };
}

/** N2'''': the closed affix set is what tsserver declares when asked
 * (`providePrefixAndSuffixTextForRename`): a prefix `old: ` (shorthand
 * property, the property keeps its name) or `old as ` (import/export
 * specifier), or a suffix `: old` / ` as old` — one of them, never both; an
 * LSP edit declares none. The replacement is exactly prefix + newName +
 * suffix, and the affix's identifier is the old name. */
const TS_PREFIXES = (old: string) => [`${old}: `, `${old} as `];
const TS_SUFFIXES = (old: string) => [`: ${old}`, ` as ${old}`];
export function declaredReplacement(edit: { readonly newText: string; readonly prefixText?: string; readonly suffixText?: string }, newName: string, oldName: string): boolean {
  const prefix = edit.prefixText ?? "";
  const suffix = edit.suffixText ?? "";
  if (prefix !== "" && suffix !== "") return false;
  if (prefix !== "" && !TS_PREFIXES(oldName).includes(prefix)) return false;
  if (suffix !== "" && !TS_SUFFIXES(oldName).includes(suffix)) return false;
  return edit.newText === `${prefix}${newName}${suffix}`;
}

function spansOf(edits: readonly RenameEdit[]): SpanSpec[] {
  return edits.map((edit) => ({ start: edit.startByte, end: edit.endByte, replacement: edit.replacement }));
}

/** The spans that undo `edits` over the after bytes (edits sorted, disjoint). */
export function inverseSpans(edits: ReadonlyArray<RenameEdit & { readonly replacementBytes?: number }>): SpanSpec[] {
  const out: SpanSpec[] = [];
  let delta = 0;
  for (const edit of edits) {
    const start = edit.startByte + delta;
    const length = edit.replacementBytes ?? Buffer.byteLength(edit.replacement, "utf8");
    out.push({ start, end: start + length, replacement: edit.original });
    delta += length - (edit.endByte - edit.startByte);
  }
  return out;
}

export function applyEdits(bytes: Buffer, edits: readonly RenameEdit[]): Buffer {
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(bytes.subarray(cursor, edit.startByte), Buffer.from(edit.replacement, "utf8"));
    cursor = edit.endByte;
  }
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts);
}

/** The 0-based line holding a byte offset of the document. */
function lineOfByte(text: DocumentText, byte: number): number {
  let line = 0;
  for (; line + 1 < text.lineCount; line += 1) {
    const next = text.byteOffset({ line: line + 1, character: 0 });
    if (typeof next === "string" || next > byte) break;
  }
  return line;
}
