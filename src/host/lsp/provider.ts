import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommitReceipt } from "../workspace-versions.ts";
import { canonicalJson } from "../canonical.ts";
import { redactText, stripTerminalControls } from "../redact.ts";
import {
  contributionKey,
  type ContributionItem,
  type ContributionOffer,
  type ModelInputBoundary,
  type ModelInputContributor,
} from "../model-input-contributions.ts";
import { DocumentText, readRange } from "./positions.ts";
import { profileFor, type ServerProfile } from "./profiles.ts";
import { ServerOwner, type Lease, type RawBatch, type ServerEvent, type SpawnService } from "./server.ts";
import { diagnosticIdentity, DiagnosticState, type DiagnosticBatch, type SafeDiagnostic, type Severity } from "./state.ts";
import { containedFile, containedFileFromUri } from "./uri.ts";

/**
 * #222 — the passive diagnostics provider (TS-20 `DiagnosticsProvider`).
 *
 * `committed(receipt)` returns at once (the write path never waits, D3): the
 * receipt's path is queued and, after the coalescing window, its current
 * bytes are read, checked against the receipt's digest and sent to the
 * profile's server as a new host-numbered version. Batches are bound by D1
 * (state.ts), mapped by D4 (uri.ts, positions.ts) and offered, bounded by
 * D5, at the next provider-request boundary through the recorded
 * `model_input_contributions` seam (D2). Nothing here reads or writes a
 * verdict, a receipt or completion (D6).
 */

export const LSP_COALESCE_MS = 500;
export const LSP_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const LSP_FILE_DIAGNOSTICS_MAX = 20;
export const LSP_FILE_BATCH_MAX_BYTES = 8 * 1024;
/** Documents tracked per profile, and bytes retained for mapping. */
export const LSP_DOCUMENTS_MAX = 512;
/** Documents a consumer (#229) may keep synchronised beyond the committed
 * ones; the least recently synchronised are forgotten first. */
export const LSP_CONSUMER_DOCUMENTS_MAX = 64;
export const LSP_RETAINED_BYTES_MAX = 64 * 1024 * 1024;
/** Diagnostics considered per server batch; the rest are counted, not parsed. */
const RAW_DIAGNOSTICS_MAX = 1_000;
const MESSAGE_MAX_CHARS = 1_024;

export const DIAGNOSTICS_SOURCE = "lsp-diagnostics";

/** What `syncCurrent` did (#229). */
export type SyncCurrentOutcome =
  | {
    readonly ok: true;
    readonly profile: string;
    readonly generation: string;
    /** The host-numbered version the bytes carry to this generation. */
    readonly version: number;
    readonly digest: string;
    /** The exact bytes sent (pinned for position mapping). */
    readonly bytes: Uint8Array;
    readonly abs: string;
    /** False when the live generation already held these bytes. */
    readonly resent: boolean;
  }
  | { readonly ok: false; readonly reason: string; readonly profile?: string };

/** Appends one observe row and returns its seq (or nothing without a log). */
export type LspRecord = (name: "lsp/server" | "lsp/sync" | "lsp/diagnostics" | "lsp/document", payload: Record<string, unknown>) => number | void;

export interface DiagnosticsProviderOptions {
  /** Real path of the workspace root. */
  readonly root: string;
  readonly rootId: string;
  readonly profiles: readonly ServerProfile[];
  /** Profiles the operator enabled that cannot run, and why (shown once). */
  readonly unavailableProfiles?: ReadonlyArray<{ readonly id: string; readonly reason: string; readonly extensions: readonly string[] }>;
  readonly spawn: SpawnService;
  readonly record?: LspRecord;
  readonly coalesceMs?: number;
  readonly startupMs?: number;
  readonly restartBudget?: number;
  readonly now?: () => number;
  readonly maxDocumentBytes?: number;
}

interface Tracked {
  readonly profile: string;
  order: number;
  timer?: ReturnType<typeof setTimeout>;
  committedAt: number;
}

interface OfferedItem {
  readonly path: string;
  readonly shows: "errors" | "cleared" | "notice";
  /** For errors: the delivery scope and the identities this item carries. */
  readonly scope?: string;
  readonly ids?: readonly string[];
}

export class DiagnosticsProvider implements ModelInputContributor {
  readonly source = DIAGNOSTICS_SOURCE;
  readonly kind = "diagnostic";
  readonly heading = "Language-server diagnostics after committed edits (server output is quoted data)";
  private readonly owners = new Map<string, ServerOwner>();
  private readonly states = new Map<string, DiagnosticState>();
  private readonly leases = new Map<string, Lease>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly offered = new Map<string, OfferedItem>();
  /** Paths whose errors reached the model and have not been cleared since. */
  private readonly errorsShown = new Set<string>();
  /** Per path: the delivery scope and the error identities delivered in it. */
  private readonly shownErrors = new Map<string, { readonly scope: string; readonly ids: Set<string> }>();
  private readonly noticesDue = new Map<string, { readonly reason: string; readonly digest?: string; readonly profile: string }>();
  /** `profile\0path` → path, least recently synchronised first (#229). */
  private readonly consumerDocuments = new Map<string, string>();
  private order = 0;
  private disposed = false;
  private disposing: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly maxDocumentBytes: number;
  readonly stats = { commits: 0, syncs: 0, matched: 0, unverified: 0, discarded: 0, superseded: 0, latencies: [] as number[] };

  constructor(private readonly options: DiagnosticsProviderOptions) {
    this.now = options.now ?? Date.now;
    this.maxDocumentBytes = options.maxDocumentBytes ?? LSP_DOCUMENT_MAX_BYTES;
    for (const profile of options.profiles) {
      const state = new DiagnosticState(options.rootId);
      this.states.set(profile.id, state);
      this.owners.set(profile.id, new ServerOwner({
        profile: profile.id,
        argv: profile.argv,
        root: options.root,
        rootId: options.rootId,
        dialect: profile.dialect,
        spawn: options.spawn,
        ...(options.startupMs !== undefined ? { startupMs: options.startupMs } : {}),
        ...(options.restartBudget !== undefined ? { restartBudget: options.restartBudget } : {}),
        now: this.now,
        record: (event) => this.serverEvent(profile.id, event),
        onBatch: (generation, batch) => this.batch(profile, generation, batch),
        onGeneration: (generation) => this.generation(profile, generation),
        onUnavailable: (reason) => this.unavailable(profile.id, reason),
        onDiscard: (generation, reason) => this.discardRow(profile.id, generation, undefined, reason),
      }));
    }
  }

  /** The owners, for a consumer that shares a server (#229): acquire a lease. */
  owner(profile: string): ServerOwner | undefined {
    return this.owners.get(profile);
  }

  /** The configured profile for a path, or why there is none (#229). */
  profileOf(path: string): { readonly ok: true; readonly profile: ServerProfile } | { readonly ok: false; readonly reason: string; readonly profile?: string } {
    const profile = profileFor(this.options.profiles, path);
    if (profile) return { ok: true, profile };
    const missing = this.options.unavailableProfiles?.find((entry) => entry.extensions.includes(extensionOf(path)));
    return missing ? { ok: false, reason: missing.reason, profile: missing.id } : { ok: false, reason: "no_profile" };
  }

  /**
   * #229 (the shared document contract): send a path's CURRENT bytes to its
   * profile's server as the next host-numbered version, whatever the commit
   * receipts say — a consumer holding its own lease asks for this before a
   * query. The proof that the server processed that version is the same as
   * for diagnostics (D1): `stateOf(profile).currentMatched(path)` for the
   * returned version. Bytes already sent to the live generation and still
   * current are not sent again. Never waits.
   */
  syncCurrent(path: string, consumer: string): SyncCurrentOutcome {
    if (this.disposed) return { ok: false, reason: "disposed" };
    const resolved = this.profileOf(path);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, ...(resolved.profile !== undefined ? { profile: resolved.profile } : {}) };
    const profile = resolved.profile;
    const state = this.states.get(profile.id)!;
    const contained = containedFile(this.options.root, join(this.options.root, path));
    if (!contained.ok) return { ok: false, reason: `path_${contained.reason}`, profile: profile.id };
    let bytes: Buffer;
    try {
      if (lstatSync(contained.abs).size > this.maxDocumentBytes) return { ok: false, reason: "over_10_mib", profile: profile.id };
      bytes = readFileSync(contained.abs);
    } catch {
      return { ok: false, reason: "unreadable", profile: profile.id };
    }
    if (bytes.length > this.maxDocumentBytes) return { ok: false, reason: "over_10_mib", profile: profile.id };
    const text = DocumentText.fromBytes(bytes);
    if (!text) return { ok: false, reason: "not_utf8", profile: profile.id };
    const owner = this.owners.get(profile.id)!;
    if (owner.state === "unavailable" || owner.state === "disposed") return { ok: false, reason: owner.reason ?? owner.state, profile: profile.id };
    const generation = owner.generation;
    if (generation === undefined) return { ok: false, reason: "no_lease", profile: profile.id };
    const digest = createHash("sha256").update(bytes).digest("hex");
    const latest = state.latestSent(path);
    if (latest && latest.generation === generation && latest.digest === digest) {
      this.touchConsumerDocument(profile.id, path);
      return { ok: true, profile: profile.id, generation, version: latest.version, digest, bytes: latest.bytes, abs: contained.abs, resent: false };
    }
    const sent = state.send(path, digest, bytes, this.now());
    if (!sent) return { ok: false, reason: "no_generation", profile: profile.id };
    this.touchConsumerDocument(profile.id, path);
    const queued = owner.sync({ path, abs: contained.abs, version: sent.version, text: text.text, languageId: profile.languageId(path) });
    this.stats.syncs += 1;
    this.record("lsp/sync", {
      profile: profile.id, generation: sent.generation, path: safePath(path), version: sent.version,
      digest, bytes: bytes.length, queued, consumer,
    });
    return { ok: true, profile: profile.id, generation: sent.generation, version: sent.version, digest, bytes, abs: contained.abs, resent: true };
  }

  /** Consumer-synchronised documents are bounded separately from the
   * committed ones: beyond LSP_CONSUMER_DOCUMENTS_MAX the least recently
   * synchronised untracked document is forgotten. */
  private touchConsumerDocument(profile: string, path: string): void {
    const key = `${profile}\0${path}`;
    this.consumerDocuments.delete(key);
    this.consumerDocuments.set(key, path);
    while (this.consumerDocuments.size > LSP_CONSUMER_DOCUMENTS_MAX) {
      const [oldestKey, oldest] = this.consumerDocuments.entries().next().value!;
      this.consumerDocuments.delete(oldestKey);
      if (!this.tracked.has(oldest)) this.states.get(oldestKey.split("\0")[0]!)?.forget(oldest);
    }
  }

  stateOf(profile: string): DiagnosticState | undefined {
    return this.states.get(profile);
  }

  statusOf(path: string): string | undefined {
    const tracked = this.tracked.get(path);
    return tracked ? this.states.get(tracked.profile)?.status(path) : undefined;
  }

  // -------------------------------------------------------------- commits

  /** The `workspace_versions` observer: never waits, never throws. */
  committed(receipt: CommitReceipt): void {
    try {
      this.observe(receipt, true);
    } catch {
      // An observer can neither undo nor delay a committed write.
    }
  }

  /** #229 (B1): a consumer asks for a committed receipt to be checked once
   * more (after a multi-file apply); the same path as `committed`, but the
   * commit is not counted twice. */
  recheck(receipt: CommitReceipt): void {
    try {
      this.observe(receipt, false);
    } catch {
      // As above.
    }
  }

  private observe(receipt: CommitReceipt, count: boolean): void {
    if (this.disposed || receipt.after.rootId !== this.options.rootId) return;
    const path = receipt.after.path;
    const profile = profileFor(this.options.profiles, path);
    if (!profile) {
      const missing = this.options.unavailableProfiles?.find((entry) => entry.extensions.includes(extensionOf(path)));
      if (missing) this.noticesDue.set(path, { reason: missing.reason, digest: receipt.after.digest, profile: missing.id });
      return;
    }
    if (count) this.stats.commits += 1;
    const state = this.states.get(profile.id)!;
    let tracked = this.tracked.get(path);
    if (!tracked) this.tracked.set(path, tracked = { profile: profile.id, order: 0, committedAt: 0 });
    tracked.order = (this.order += 1);
    tracked.committedAt = this.now();
    state.committed(path, receipt.after.digest, receipt.operationId);
    this.noticesDue.delete(path);
    this.bound(profile.id, path);
    if (receipt.after.bytes > this.maxDocumentBytes) {
      state.unsupported(path, "over_10_mib");
      this.noticesDue.set(path, { reason: "over_10_mib", digest: receipt.after.digest, profile: profile.id });
      this.record("lsp/document", { profile: profile.id, path: safePath(path), status: "unsupported", reason: "over_10_mib", bytes: receipt.after.bytes });
      return;
    }
    if (tracked.timer) clearTimeout(tracked.timer);
    const coalesce = this.options.coalesceMs ?? LSP_COALESCE_MS;
    tracked.timer = setTimeout(() => {
      tracked!.timer = undefined;
      this.flush(profile, path);
    }, coalesce);
  }

  /** What the provider retains is bounded: at most DOCUMENTS_MAX tracked
   * documents and RETAINED_BYTES_MAX of sent bytes per profile; the least
   * recently committed are forgotten first (a later batch for one of them
   * is `unrequested`). */
  private bound(profile: string, keep: string): void {
    const state = this.states.get(profile)!;
    const byAge = [...this.tracked.entries()].filter(([, tracked]) => tracked.profile === profile)
      .sort((a, b) => a[1].order - b[1].order).map(([path]) => path);
    while (byAge.length > 0 && (byAge.length > LSP_DOCUMENTS_MAX || state.retainedBytes > LSP_RETAINED_BYTES_MAX)) {
      const path = byAge.shift()!;
      if (path === keep) continue;
      const tracked = this.tracked.get(path);
      if (tracked?.timer) clearTimeout(tracked.timer);
      this.tracked.delete(path);
      this.errorsShown.delete(path);
      this.shownErrors.delete(path);
      state.forget(path);
    }
    while (this.noticesDue.size > LSP_DOCUMENTS_MAX) this.noticesDue.delete(this.noticesDue.keys().next().value!);
  }

  /** Read, check and send one document's current bytes. */
  private flush(profile: ServerProfile, path: string): void {
    if (this.disposed) return;
    const state = this.states.get(profile.id)!;
    const committedDigest = state.document(path)?.committedDigest;
    const contained = containedFile(this.options.root, join(this.options.root, path));
    if (!contained.ok) {
      state.unavailable(path, `path_${contained.reason}`);
      this.noticesDue.set(path, { reason: `path_${contained.reason}`, profile: profile.id });
      return;
    }
    let bytes: Buffer;
    try {
      if (lstatSync(contained.abs).size > this.maxDocumentBytes) {
        state.unsupported(path, "over_10_mib");
        this.noticesDue.set(path, { reason: "over_10_mib", digest: committedDigest, profile: profile.id });
        return;
      }
      bytes = readFileSync(contained.abs);
    } catch {
      state.unavailable(path, "unreadable");
      return;
    }
    if (bytes.length > this.maxDocumentBytes) {
      state.unsupported(path, "over_10_mib");
      this.noticesDue.set(path, { reason: "over_10_mib", digest: committedDigest, profile: profile.id });
      return;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== committedDigest) {
      // The bytes are not the committed version: a later commit will come,
      // or an external writer changed them — not inspected either way.
      this.stats.superseded += 1;
      this.record("lsp/document", { profile: profile.id, path: safePath(path), status: "superseded", reason: "bytes_differ_from_receipt" });
      return;
    }
    // N1'/N1'': version identity is content - the committed bytes the live
    // generation already holds are not sent again; the result that matched
    // exactly these bytes still stands (the committed-digest check above
    // comes first: an external revert never reaffirms).
    const already = state.latestSent(path);
    if (already && already.generation === this.owners.get(profile.id)!.generation && already.digest === digest && digest === committedDigest) {
      state.reaffirm(path);
      this.record("lsp/document", { profile: profile.id, path: safePath(path), status: "unchanged", version: already.version });
      return;
    }
    const text = DocumentText.fromBytes(bytes);
    if (!text) {
      state.unsupported(path, "not_utf8");
      this.noticesDue.set(path, { reason: "not_utf8", digest, profile: profile.id });
      return;
    }
    const owner = this.owners.get(profile.id)!;
    if (!this.leases.has(profile.id) && owner.state !== "disposed") this.leases.set(profile.id, owner.acquire("diagnostics"));
    if (owner.state === "unavailable" || owner.generation === undefined) {
      state.unavailable(path, owner.reason ?? "unavailable");
      this.noticesDue.set(path, { reason: owner.reason ?? "unavailable", digest, profile: profile.id });
      return;
    }
    const sent = state.send(path, digest, bytes, this.now());
    if (!sent) return;
    this.bound(profile.id, path);
    const queued = owner.sync({ path, abs: contained.abs, version: sent.version, text: text.text, languageId: profile.languageId(path) });
    this.stats.syncs += 1;
    this.record("lsp/sync", {
      profile: profile.id, generation: sent.generation, path: safePath(path), version: sent.version,
      digest, bytes: bytes.length, queued,
    });
  }

  private generation(profile: ServerProfile, generation: string): void {
    const state = this.states.get(profile.id)!;
    const resend = state.paths().filter((path) => this.tracked.has(path) && (state.document(path)?.sent.length ?? 0) > 0);
    state.newGeneration(generation);
    // The documents the previous generation had: re-sent to this one as new
    // versions (after the caller that started it has sent its own).
    queueMicrotask(() => {
      for (const path of resend) if (!this.tracked.get(path)?.timer) this.flush(profile, path);
    });
  }

  private unavailable(profile: string, reason: string): void {
    const state = this.states.get(profile);
    if (!state) return;
    for (const path of state.paths()) {
      const status = state.status(path);
      if (status === "pending" || status === "unverified") {
        state.unavailable(path, reason);
        // A document only a consumer synchronised (#229) owes the model no notice.
        if (this.tracked.has(path)) this.noticesDue.set(path, { reason, digest: state.document(path)?.committedDigest, profile });
      }
    }
  }

  // -------------------------------------------------------------- batches

  private batch(profile: ServerProfile, generation: string, raw: RawBatch): void {
    if (this.disposed) return;
    const state = this.states.get(profile.id)!;
    const named = raw.uri !== undefined ? containedFileFromUri(this.options.root, raw.uri) : containedFile(this.options.root, raw.file);
    if (!named.ok) {
      state.discard("unrequested");
      this.discardRow(profile.id, generation, undefined, `uri_${named.reason}`);
      return;
    }
    const path = named.rel;
    const classified = state.classify({ generation, path, ...(raw.version !== undefined ? { version: raw.version } : {}) });
    if (classified.kind === "discard") {
      state.discard(classified.reason);
      this.stats.discarded += 1;
      this.discardRow(profile.id, generation, path, classified.reason, raw.version);
      return;
    }
    const sent = classified.sent;
    const matched = classified.kind === "matched";
    const text = sent ? DocumentText.fromBytes(sent.bytes) : undefined;
    const omitted: Record<string, number> = {};
    const count = (reason: string, by = 1) => { omitted[reason] = (omitted[reason] ?? 0) + by; };
    const diagnostics: SafeDiagnostic[] = [];
    if (raw.diagnostics.length > RAW_DIAGNOSTICS_MAX) count("server_batch_bound", raw.diagnostics.length - RAW_DIAGNOSTICS_MAX);
    for (const value of raw.diagnostics.slice(0, RAW_DIAGNOSTICS_MAX)) {
      const safe = safeDiagnostic(value, text, matched);
      if (typeof safe === "string") count(safe);
      else diagnostics.push(safe);
    }
    diagnostics.sort(compareDiagnostics);
    const bodyDigest = createHash("sha256").update(canonicalJson(diagnostics.map((d) => ({ ...d })))).digest("hex");
    const receivedAt = this.now();
    const latency = sent ? receivedAt - sent.sentAt : undefined;
    const batch: DiagnosticBatch = {
      generation, rootId: this.options.rootId, path,
      ...(matched && sent ? { sourceDigest: sent.digest, documentVersion: sent.version } : {}),
      freshness: matched ? "matched" : "unverified",
      diagnostics, receivedEvent: 0, omitted, bodyDigest,
    };
    const applied = state.apply(batch);
    // D1'': a same-version batch that only drops diagnostics changed nothing
    // (its drop is ignored); one that adds is a match whose additions count.
    const onlyRetracted = matched && applied.kind === "applied" && applied.added === 0 && applied.retracted > 0;
    const row = this.record("lsp/diagnostics", {
      profile: profile.id, generation, path: safePath(path),
      ...(raw.version !== undefined ? { version: raw.version } : {}),
      freshness: matched && !onlyRetracted ? "matched" : "unverified",
      outcome: onlyRetracted ? "retraction_ignored" : matched ? "matched" : "unverified",
      count: diagnostics.length,
      errors: diagnostics.filter((d) => d.severity === "error").length,
      ...(applied.retracted > 0 ? { retraction_ignored: applied.retracted, added: applied.added,
        state_errors: applied.batch?.diagnostics.filter((d) => d.severity === "error").length ?? 0 } : {}),
      ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
      ...(matched && sent ? { source_digest: sent.digest } : {}),
      ...(latency !== undefined ? { latency_ms: latency } : {}),
      body_digest: bodyDigest,
    });
    // The state holds the (merged) batch: it now names the row that recorded it.
    if (applied.batch) (applied.batch as { receivedEvent: number }).receivedEvent = row ?? 0;
    if (onlyRetracted) return;
    if (matched) {
      this.stats.matched += 1;
      if (latency !== undefined) this.stats.latencies.push(latency);
    } else this.stats.unverified += 1;
    if (matched) this.noticesDue.delete(path);
  }

  private discardRow(profile: string, generation: string, path: string | undefined, reason: string, version?: number): void {
    this.record("lsp/diagnostics", {
      profile, generation, ...(path !== undefined ? { path: safePath(path) } : {}),
      ...(version !== undefined ? { version } : {}), outcome: "discarded", reason,
    });
  }

  private serverEvent(profile: string, event: ServerEvent): void {
    this.record("lsp/server", { profile, ...event });
  }

  // ------------------------------------------------------ the seam (D2/D5)

  offer(_boundary: ModelInputBoundary): ContributionOffer | undefined {
    if (this.disposed) return undefined;
    const items: ContributionItem[] = [];
    const omissions = new Map<string, number>();
    const notInspected: string[] = [];
    const paths = [...new Set([...this.tracked.keys(), ...this.noticesDue.keys()])]
      .sort((a, b) => (this.tracked.get(a)?.order ?? 0) - (this.tracked.get(b)?.order ?? 0));
    for (const path of paths) {
      const tracked = this.tracked.get(path);
      const state = tracked ? this.states.get(tracked.profile) : undefined;
      const status = state?.status(path);
      const notice = this.noticesDue.get(path);
      if (notice && (!state || status === "unavailable" || status === "unsupported" || status === undefined)) {
        const key = contributionKey([DIAGNOSTICS_SOURCE, notice.profile, path, "notice", notice.reason, notice.digest]);
        this.offered.set(key, { path, shows: "notice" });
        items.push({
          key,
          freshness: status === "unsupported" ? "unsupported" : "unavailable",
          text: `${quotePath(path)} — not inspected (${notice.profile}: ${noticeText(notice.reason)}); this is not a clean result`,
          facts: { profile: notice.profile, path: safePath(path), reason: notice.reason },
        });
        continue;
      }
      if (!state || !tracked) continue;
      const matched = state.currentMatched(path);
      if (matched) {
        const errors = matched.diagnostics.filter((d) => d.severity === "error");
        if (errors.length === 0) {
          if (!this.errorsShown.has(path)) continue;
          const key = contributionKey([DIAGNOSTICS_SOURCE, tracked.profile, path, operationOf(state, path), matched.sourceDigest, "cleared"]);
          this.offered.set(key, { path, shows: "cleared" });
          items.push({
            key, freshness: "matched",
            text: `${quotePath(path)} — no errors (${tracked.profile}, matched: version ${matched.documentVersion} of ${short(matched.sourceDigest)}); the errors shown earlier are cleared`,
            facts: { profile: tracked.profile, path: safePath(path), version: matched.documentVersion ?? 0, errors: 0, source_digest: matched.sourceDigest ?? "" },
          });
          continue;
        }
        const scope = `matched|${operationOf(state, path) ?? ""}|${matched.sourceDigest ?? ""}`;
        const item = this.deltaItem(tracked.profile, path, scope, errors, matched, true, omissions,
          `matched: version ${matched.documentVersion} of ${short(matched.sourceDigest)}`, "matched",
          { version: matched.documentVersion ?? 0, source_digest: matched.sourceDigest ?? "" });
        if (item) items.push(item);
        continue;
      }
      const advisory = state.advisory(path);
      const advisoryErrors = advisory?.diagnostics.filter((d) => d.severity === "error") ?? [];
      if (advisory && advisoryErrors.length > 0) {
        const latest = state.latestSent(path);
        const scope = `unverified|${latest?.operation ?? ""}|${latest?.digest ?? ""}`;
        const item = this.deltaItem(tracked.profile, path, scope, advisoryErrors, advisory, false, omissions,
          "unverified: the server bound no document version, so these may describe earlier bytes", "unverified", {});
        if (item) items.push(item);
        continue;
      }
      // Committed, nothing current arrived (or only an empty unverified
      // advisory): not inspected — recorded, never shown as clean.
      if (status === "pending" || status === "unverified") notInspected.push(safePath(path));
    }
    if (items.length === 0 && notInspected.length === 0 && omissions.size === 0) return undefined;
    return {
      items,
      omissions: [...omissions].map(([reason, count]) => ({ reason, count })),
      notInspected,
    };
  }

  /**
   * Delivery by error identity (path, commit, range, code, message): only the
   * errors of this scope (a matched version, or the unverified advisory of a
   * commit) that were not delivered yet are offered, so a batch that grows
   * within one version delivers its delta once; the per-file bound applies
   * to what this scope has delivered in total.
   */
  private deltaItem(profile: string, path: string, scope: string, errors: readonly SafeDiagnostic[], batch: DiagnosticBatch,
    exact: boolean, omissions: Map<string, number>, describe: string, freshness: string,
    facts: Record<string, string | number>): ContributionItem | undefined {
    const record = this.shownErrors.get(path);
    const shown = record?.scope === scope ? record.ids : new Set<string>();
    const pending = errors.filter((d) => !shown.has(diagnosticIdentity(d)));
    if (pending.length === 0) return undefined;
    const room = LSP_FILE_DIAGNOSTICS_MAX - shown.size;
    if (room <= 0) {
      omissions.set("file_count_bound", (omissions.get("file_count_bound") ?? 0) + pending.length);
      return undefined;
    }
    const rendered = renderErrors(pending, batch, exact, room);
    rendered.omitted.forEach((value, reason) => omissions.set(reason, (omissions.get(reason) ?? 0) + value));
    const ids = pending.slice(0, rendered.shown).map(diagnosticIdentity);
    if (ids.length === 0) return undefined;
    const key = contributionKey([DIAGNOSTICS_SOURCE, profile, path, scope, ...[...ids].sort()]);
    this.offered.set(key, { path, shows: "errors", scope, ids });
    const earlier = shown.size > 0 ? `, new since the ${shown.size} shown earlier` : "";
    return {
      key, freshness,
      text: `${quotePath(path)} — ${pending.length} error${pending.length === 1 ? "" : "s"}${earlier} (${profile}, ${describe})\n${rendered.text}`,
      facts: { profile, path: safePath(path), errors: errors.length, shown: rendered.shown, delivered_before: shown.size, ...facts },
    };
  }

  delivered(keys: readonly string[]): void {
    for (const key of keys) {
      const item = this.offered.get(key);
      if (!item) continue;
      if (item.shows === "errors" && item.scope !== undefined && item.ids) {
        const record = this.shownErrors.get(item.path);
        const ids = record?.scope === item.scope ? record.ids : new Set<string>();
        for (const id of item.ids) ids.add(id);
        this.shownErrors.set(item.path, { scope: item.scope, ids });
      }
      if (item.shows === "errors") this.errorsShown.add(item.path);
      else if (item.shows === "cleared") this.errorsShown.delete(item.path);
      else this.noticesDue.delete(item.path);
    }
  }

  // ------------------------------------------------------------ lifecycle

  /** The owning task was aborted: every server ends now; what arrives late
   * is discarded; documents are not inspected from here on. */
  async abort(reason = "aborted"): Promise<void> {
    for (const tracked of this.tracked.values()) if (tracked.timer) clearTimeout(tracked.timer);
    await Promise.all([...this.owners.values()].map((owner) => owner.abort(reason)));
  }

  /** Unload / task end: end every server once; nothing afterwards. */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.disposed = true;
      for (const tracked of this.tracked.values()) if (tracked.timer) clearTimeout(tracked.timer);
      for (const state of this.states.values()) state.dispose();
      await Promise.all([...this.owners.values()].map((owner) => owner.dispose()));
      this.leases.clear();
    })();
  }

  private record(name: Parameters<LspRecord>[0], payload: Record<string, unknown>): number | undefined {
    try {
      const seq = this.options.record?.(name, payload);
      return typeof seq === "number" ? seq : undefined;
    } catch {
      // Observability never changes what the provider decides.
      return undefined;
    }
  }
}

/** The "version" of an item's once-only key is the committed receipt: a
 * revert to earlier bytes is a new commit and is reported again; a server
 * restart that re-sends the same commit is not. */
function operationOf(state: DiagnosticState, path: string): string | undefined {
  return state.latestSent(path)?.operation ?? state.document(path)?.committedOperation;
}

function extensionOf(path: string): string {
  return path.includes(".") ? path.split(".").at(-1)!.toLowerCase() : "";
}

const SEVERITY: Record<number, Severity> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, information: 2, hint: 3 };

/** D4: one server diagnostic as data, or why it was dropped. */
function safeDiagnostic(value: unknown, text: DocumentText | undefined, exact: boolean): SafeDiagnostic | string {
  if (!value || typeof value !== "object") return "malformed";
  const record = value as Record<string, unknown>;
  const range = readRange(record.range);
  if (!range) return "invalid_range";
  if (!text) return "invalid_utf8";
  const mapped = text.mapRange(range);
  if (typeof mapped === "string") return "invalid_range";
  // An unspecified severity is treated as an error (the client decides, and
  // hiding one would be worse than showing it).
  const severity = record.severity === undefined ? "error" : SEVERITY[record.severity as number];
  if (!severity) return "malformed";
  const message = typeof record.message === "string" ? boundedMessage(record.message) : "";
  const code = typeof record.code === "string" || typeof record.code === "number"
    ? String(record.code).replace(/[^A-Za-z0-9_.:-]/gu, "").slice(0, 32) : undefined;
  return {
    severity,
    message,
    ...(code ? { code } : {}),
    line: mapped.start.line,
    character: mapped.start.character,
    endLine: mapped.end.line,
    endCharacter: mapped.end.character,
    ...(exact ? { startByte: mapped.startByte, endByte: mapped.endByte } : {}),
  };
}

function boundedMessage(message: string): string {
  const plain = stripTerminalControls(message);
  const points = Array.from(plain);
  return points.length > MESSAGE_MAX_CHARS ? `${points.slice(0, MESSAGE_MAX_CHARS).join("")}…` : plain;
}

function compareDiagnostics(a: SafeDiagnostic, b: SafeDiagnostic): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line || a.character - b.character
    || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0);
}

/** D5: at most 20 diagnostics and 8 KiB per file batch; what is left out
 * is counted with its reason and said in the item. */
function renderErrors(errors: readonly SafeDiagnostic[], batch: DiagnosticBatch, exact: boolean, room = LSP_FILE_DIAGNOSTICS_MAX): {
  text: string; shown: number; omitted: Map<string, number>;
} {
  const omitted = new Map<string, number>();
  const lines: string[] = [];
  let bytes = 0;
  let shown = 0;
  for (const [index, diagnostic] of errors.entries()) {
    if (index >= room) {
      omitted.set("file_count_bound", errors.length - room);
      break;
    }
    const line = `  ${diagnostic.line + 1}:${diagnostic.character + 1}`
      + (exact && diagnostic.startByte !== undefined ? ` (bytes ${diagnostic.startByte}-${diagnostic.endByte})` : "")
      + ` ${diagnostic.severity}${diagnostic.code ? ` ${diagnostic.code}` : ""}: ${JSON.stringify(diagnostic.message)}`;
    const cost = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + cost > LSP_FILE_BATCH_MAX_BYTES) {
      omitted.set("file_byte_bound", errors.length - index);
      break;
    }
    bytes += cost;
    shown += 1;
    lines.push(line);
  }
  const batchOmitted = Object.entries(batch.omitted).reduce((sum, [, value]) => sum + value, 0);
  const left = [...omitted.values()].reduce((sum, value) => sum + value, 0);
  if (left > 0) lines.push(`  [${left} more error${left === 1 ? "" : "s"} omitted: ${[...omitted.keys()].join(", ")}]`);
  if (batchOmitted > 0) lines.push(`  [${batchOmitted} server diagnostic${batchOmitted === 1 ? "" : "s"} dropped: ${Object.keys(batch.omitted).join(", ")}]`);
  return { text: lines.join("\n"), shown, omitted };
}

function noticeText(reason: string): string {
  if (reason === "over_10_mib") return "the document is over 10 MiB, unsupported";
  if (reason === "not_utf8") return "the document is not UTF-8, unsupported";
  return `server unavailable: ${reason}`;
}

function short(digest: string | undefined): string {
  return digest ? `sha256:${digest.slice(0, 12)}` : "unknown bytes";
}

/** A path as data in the suffix: plain when it is plain, JSON-quoted when it
 * carries anything that could look like structure. */
function quotePath(path: string): string {
  return /^[A-Za-z0-9_./@+-]+$/u.test(path) ? path : JSON.stringify(path);
}

/** A path for a durable row: never a credential shape. */
function safePath(path: string): string {
  return redactText(path);
}
