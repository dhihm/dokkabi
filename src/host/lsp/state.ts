import { createHash } from "node:crypto";

/**
 * #222 D1 — freshness is a proof, not a timestamp.
 *
 * The host numbers every document version it sends to a server generation
 * and records the digest of the exact bytes it sent. A batch is `matched`
 * only when its generation is the current one and its version is the latest
 * version the host sent for that document; a batch without a version is an
 * `unverified` advisory; a batch of an older generation, an older version or
 * a version the host never sent is discarded with a recorded reason and
 * never touches newer state. A document is `clean` only from a matched batch
 * with no error — an empty unverified, stale or unavailable result is "not
 * inspected", never clean.
 */

export type Freshness = "matched" | "unverified" | "stale";

export type DocumentStatus =
  /** Committed; no matched result for its latest version yet. */
  | "pending"
  | "errors"
  | "clean"
  /** Only an unversioned advisory describes it. */
  | "unverified"
  | "unavailable"
  | "unsupported";

export type DiscardReason =
  | "old_generation"
  | "stale_version"
  | "unknown_version"
  | "unrequested"
  | "disposed";

export type Severity = "error" | "warning" | "information" | "hint";

export interface SafeDiagnostic {
  readonly severity: Severity;
  /** Server text as data: terminal controls stripped, bounded. */
  readonly message: string;
  readonly code?: string;
  readonly line: number;
  readonly character: number;
  readonly endLine: number;
  readonly endCharacter: number;
  /** Byte offsets in the sent bytes; absent for an unverified batch whose
   * bytes are not known to be the ones it describes. */
  readonly startByte?: number;
  readonly endByte?: number;
}

export interface DiagnosticBatch {
  readonly generation: string;
  readonly rootId: string;
  readonly path: string;
  readonly sourceDigest?: string;
  readonly documentVersion?: number;
  readonly freshness: Freshness;
  readonly diagnostics: readonly SafeDiagnostic[];
  /** The seq of the row that recorded the batch (0 without a log). */
  readonly receivedEvent: number;
  /** Diagnostics this batch dropped and why (invalid range, bounds, …). */
  readonly omitted: Readonly<Record<string, number>>;
  readonly bodyDigest: string;
}

export interface SentVersion {
  readonly generation: string;
  readonly version: number;
  readonly digest: string;
  /** The exact bytes sent — kept for the newest version only (an older
   * version's batch is stale and never mapped). */
  bytes: Uint8Array;
  readonly sentAt: number;
  /** The commit receipt whose bytes these are. */
  readonly operation?: string;
}

interface DocumentState {
  status: DocumentStatus;
  /** The digest and operation of the newest committed receipt. */
  committedDigest?: string;
  committedOperation?: string;
  /** Versions sent to the current generation, newest last (bounded). */
  sent: SentVersion[];
  /** The newest matched batch (any version); only its version can rise. */
  matched?: DiagnosticBatch;
  advisory?: DiagnosticBatch;
  reason?: string;
}

export interface ApplyOutcome {
  readonly kind: "applied" | "ignored";
  /** Diagnostics this batch added to the document's state. */
  readonly added: number;
  /** Same-version diagnostics this batch dropped; kept, not retracted (D1''). */
  readonly retracted: number;
  /** The state's batch after the merge. */
  readonly batch?: DiagnosticBatch;
}

function compareIdentity(a: SafeDiagnostic, b: SafeDiagnostic): number {
  const rank = { error: 0, warning: 1, information: 2, hint: 3 } as const;
  return rank[a.severity] - rank[b.severity] || a.line - b.line || a.character - b.character
    || (diagnosticIdentity(a) < diagnosticIdentity(b) ? -1 : diagnosticIdentity(a) > diagnosticIdentity(b) ? 1 : 0);
}

/** The union of two diagnostic lists by identity, in a stable order. */
export function mergeDiagnostics(kept: readonly SafeDiagnostic[], incoming: readonly SafeDiagnostic[]): SafeDiagnostic[] {
  const byId = new Map<string, SafeDiagnostic>();
  for (const d of [...kept, ...incoming]) if (!byId.has(diagnosticIdentity(d))) byId.set(diagnosticIdentity(d), d);
  return [...byId.values()].sort(compareIdentity);
}

export function diagnosticsDigest(diagnostics: readonly SafeDiagnostic[]): string {
  return createHash("sha256").update(diagnostics.map(diagnosticIdentity).join("\n")).digest("hex");
}

function mergeCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, value);
  return out;
}

/** What makes two diagnostics the same one: severity, range, code, message. */
export function diagnosticIdentity(d: SafeDiagnostic): string {
  return `${d.severity}|${d.line}:${d.character}-${d.endLine}:${d.endCharacter}|${d.code ?? ""}|${d.message}`;
}

/** Sent versions retained per document for binding and discard reasons. */
const SENT_KEPT = 8;
const EMPTY = new Uint8Array(0);

export type Classification =
  | { readonly kind: "matched"; readonly sent: SentVersion }
  | { readonly kind: "unverified"; readonly sent?: SentVersion }
  | { readonly kind: "discard"; readonly reason: DiscardReason };

export class DiagnosticState {
  private readonly documents = new Map<string, DocumentState>();
  private generation: string | undefined;
  private nextVersion = new Map<string, number>();
  private disposed = false;
  /** Every discard, by reason (the dashboard's count). */
  readonly discards: Record<string, number> = {};
  /** Same-version batches that would have retracted an error (D1'). */
  retractions = 0;

  constructor(readonly rootId: string) {}

  get currentGeneration(): string | undefined {
    return this.generation;
  }

  paths(): string[] {
    return [...this.documents.keys()];
  }

  document(path: string): Readonly<DocumentState> | undefined {
    return this.documents.get(path);
  }

  status(path: string): DocumentStatus | undefined {
    return this.documents.get(path)?.status;
  }

  /** A commit receipt arrived: the document awaits a result for its new
   * bytes. What an earlier version said is not a statement about these. */
  committed(path: string, digest: string, operation?: string): void {
    if (this.disposed) return;
    const doc = this.doc(path);
    doc.committedDigest = digest;
    doc.committedOperation = operation;
    doc.status = "pending";
    doc.reason = undefined;
  }

  unsupported(path: string, reason: string): void {
    if (this.disposed) return;
    const doc = this.doc(path);
    doc.status = "unsupported";
    doc.reason = reason;
  }

  /** The server cannot inspect this document now: not inspected, never
   * clean. A matched result for the latest sent version stays what it is. */
  unavailable(path: string, reason: string): void {
    if (this.disposed) return;
    const doc = this.doc(path);
    if (this.isCurrentMatched(doc)) return;
    doc.status = "unavailable";
    doc.reason = reason;
  }

  /** A new server generation: nothing it has not been sent can match. */
  newGeneration(generation: string): void {
    if (this.disposed) return;
    this.generation = generation;
    for (const doc of this.documents.values()) {
      doc.sent = [];
      if (doc.status === "errors" || doc.status === "clean" || doc.status === "unverified") {
        // The old generation's word still describes the bytes it matched;
        // the document is re-sent and awaits the new one.
        doc.status = "pending";
      }
    }
  }

  /** The host is about to send `bytes` (digest `digest`) to the current
   * generation: the version number it will carry. */
  send(path: string, digest: string, bytes: Uint8Array, now: number): SentVersion | undefined {
    if (this.disposed || this.generation === undefined) return undefined;
    const doc = this.doc(path);
    const version = (this.nextVersion.get(path) ?? 0) + 1;
    this.nextVersion.set(path, version);
    const sent: SentVersion = { generation: this.generation, version, digest, bytes, sentAt: now,
      ...(doc.committedOperation !== undefined ? { operation: doc.committedOperation } : {}) };
    for (const older of doc.sent) older.bytes = EMPTY;
    doc.sent.push(sent);
    if (doc.sent.length > SENT_KEPT) doc.sent.splice(0, doc.sent.length - SENT_KEPT);
    if (doc.status !== "unsupported") doc.status = "pending";
    return sent;
  }

  /** N1' (#229): a commit whose bytes the live generation already holds is
   * not re-sent; the document's status is what its matched result says. */
  reaffirm(path: string): void {
    if (this.disposed) return;
    const doc = this.documents.get(path);
    if (!doc || doc.status === "unsupported") return;
    if (this.isCurrentMatched(doc) && doc.matched) doc.status = doc.matched.diagnostics.some((d) => d.severity === "error") ? "errors" : "clean";
  }

  latestSent(path: string): SentVersion | undefined {
    return this.documents.get(path)?.sent.at(-1);
  }

  /** D1: bind a server batch to what the host sent, or say why not. */
  classify(input: { readonly generation: string; readonly path: string; readonly version?: number }): Classification {
    if (this.disposed) return { kind: "discard", reason: "disposed" };
    if (input.generation !== this.generation) return { kind: "discard", reason: "old_generation" };
    const doc = this.documents.get(input.path);
    const latest = doc?.sent.at(-1);
    if (!doc || !latest) return { kind: "discard", reason: "unrequested" };
    if (input.version === undefined) return { kind: "unverified", sent: latest };
    if (!Number.isSafeInteger(input.version)) return { kind: "discard", reason: "unknown_version" };
    const sent = doc.sent.find((entry) => entry.version === input.version && entry.generation === input.generation);
    if (input.version < latest.version) return { kind: "discard", reason: "stale_version" };
    if (!sent) return { kind: "discard", reason: "unknown_version" };
    return { kind: "matched", sent };
  }

  /** Record a discard (the caller records the row). */
  discard(reason: DiscardReason): void {
    this.discards[reason] = (this.discards[reason] ?? 0) + 1;
  }

  /** Apply a classified batch. A matched batch never lowers the matched
   * version; an unverified one never makes a document clean. */
  apply(batch: DiagnosticBatch): ApplyOutcome {
    const ignored: ApplyOutcome = { kind: "ignored", added: 0, retracted: 0 };
    if (this.disposed || batch.generation !== this.generation) return ignored;
    const doc = this.documents.get(batch.path);
    if (!doc) return ignored;
    if (batch.freshness === "matched") {
      const latest = doc.sent.at(-1);
      if (!latest || batch.documentVersion !== latest.version) return ignored;
      if (doc.matched && doc.matched.generation === batch.generation
        && (doc.matched.documentVersion ?? 0) > (batch.documentVersion ?? 0)) return ignored;
      let next = batch;
      let added = batch.diagnostics.length;
      let retracted = 0;
      // D1'': within one (generation, version) the bytes did not change, so
      // the diagnostics are merged ADDITIVELY: what a later batch adds is
      // accepted, what it drops is kept and the drop is counted as a
      // retraction that was ignored. Only a newer version (a new commit)
      // replaces the set — and only that can clear it.
      if (doc.matched && doc.matched.generation === batch.generation && doc.matched.documentVersion === batch.documentVersion) {
        const merged = mergeDiagnostics(doc.matched.diagnostics, batch.diagnostics);
        const incoming = new Set(batch.diagnostics.map(diagnosticIdentity));
        retracted = doc.matched.diagnostics.filter((d) => !incoming.has(diagnosticIdentity(d))).length;
        added = merged.length - doc.matched.diagnostics.length;
        next = { ...batch, diagnostics: merged, bodyDigest: diagnosticsDigest(merged),
          omitted: mergeCounts(doc.matched.omitted, batch.omitted) };
        this.retractions += retracted > 0 ? 1 : 0;
      }
      doc.matched = next;
      doc.advisory = undefined;
      if (doc.status !== "unsupported") doc.status = next.diagnostics.some((d) => d.severity === "error") ? "errors" : "clean";
      doc.reason = undefined;
      return { kind: "applied", added, retracted, batch: next };
    }
    if (batch.freshness === "unverified") {
      doc.advisory = batch;
      if (!this.isCurrentMatched(doc) && doc.status !== "unsupported") doc.status = "unverified";
      return { kind: "applied", added: batch.diagnostics.length, retracted: 0, batch };
    }
    return ignored;
  }

  /** The matched batch for the latest sent version, if one arrived. */
  currentMatched(path: string): DiagnosticBatch | undefined {
    const doc = this.documents.get(path);
    return doc && this.isCurrentMatched(doc) ? doc.matched : undefined;
  }

  advisory(path: string): DiagnosticBatch | undefined {
    const doc = this.documents.get(path);
    return doc && !this.isCurrentMatched(doc) ? doc.advisory : undefined;
  }

  /** Stop tracking a document (a bound on what the host retains): a later
   * batch for it is `unrequested`. */
  forget(path: string): void {
    this.documents.delete(path);
  }

  /** Bytes retained for mapping, all documents together. */
  get retainedBytes(): number {
    let total = 0;
    for (const doc of this.documents.values()) total += doc.sent.at(-1)?.bytes.length ?? 0;
    return total;
  }

  dispose(): void {
    this.disposed = true;
    this.generation = undefined;
    this.documents.clear();
  }

  private isCurrentMatched(doc: DocumentState): boolean {
    const latest = doc.sent.at(-1);
    return doc.matched !== undefined && latest !== undefined
      && doc.matched.generation === latest.generation && doc.matched.documentVersion === latest.version;
  }

  private doc(path: string): DocumentState {
    let doc = this.documents.get(path);
    if (!doc) this.documents.set(path, doc = { status: "pending", sent: [] });
    return doc;
  }
}
