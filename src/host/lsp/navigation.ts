import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { redactText, stripTerminalControls } from "../redact.ts";
import { redactForEmission } from "../tool-result-input.ts";
import { isSecretWorkspacePath, type CommitReceipt } from "../workspace-versions.ts";
import { DocumentText, readRange, type LspRange } from "./positions.ts";
import { LSP_DOCUMENT_MAX_BYTES, type DiagnosticsProvider } from "./provider.ts";
import type { Lease, OwnerState, ServerOwner } from "./server.ts";
import type { DiagnosticState } from "./state.ts";
import { containedFile, containedFileFromUri, fileUri, type Containment } from "./uri.ts";

/**
 * #229 — version-bound navigation over the shared server seam (design memo
 * §134, N1/N2/N5).
 *
 * N1 Every query is bound to the host-verified root, path, content digest,
 *    host-numbered document version and server generation. The document's
 *    current bytes are sent through #222's provider (`syncCurrent`) and the
 *    query is not asked until the server PROVED it processed that version —
 *    the same proof passive diagnostics use (a matched batch for that
 *    generation and version; tsserver: its completed check of exactly those
 *    bytes). A sent notification is no proof: without one the query is a
 *    `timeout` (reason `sync_unproven`). An answer is `current` only while
 *    the generation, the latest sent version and the bytes on disk are still
 *    the binding's; otherwise it is `stale` with its reason and carries no
 *    locations. A valid empty answer (`empty`), an absent server
 *    (`unavailable`), a `timeout` and an `unsupported` method are four
 *    distinct statuses; nothing here is an empty success.
 * N2 Positions are UTF-16 against the pinned bytes and mapped to byte
 *    offsets exactly (positions.ts); every returned location is a file
 *    inside the root through no link (uri.ts) or it is omitted and counted;
 *    bounds: 200 locations, 32 KiB of previews, omissions counted by reason.
 * N5 One server owner shared with #222: a lease per profile, released on
 *    dispose; a late answer of an ended generation is discarded and counted.
 */

export const LSP_NAV_LOCATIONS_MAX = 200;
export const LSP_NAV_PREVIEW_MAX_BYTES = 32 * 1024;
export const LSP_NAV_SYNC_PROOF_MS = 20_000;
export const LSP_NAV_REQUEST_MS = 20_000;
/** One preview line's bytes; longer lines are cut with a marker. */
const PREVIEW_LINE_MAX_BYTES = 512;
const NAME_MAX_CHARS = 256;
export const NAVIGATION_SOURCE = "lsp-navigation";

export type NavigationMethod = "definition" | "references" | "symbols" | "prepare_rename";
export type NavigationStatus = "current" | "empty" | "stale" | "unavailable" | "timeout" | "unsupported";

export type NavigationRecordName = "lsp/navigation" | "lsp/rename_plan" | "lsp/rename_intent" | "lsp/rename_commit" | "lsp/rename_outcome" | "lsp/rename_rollback";
export type NavigationRecord = (name: NavigationRecordName, payload: Record<string, unknown>) => number | void;

/** A 0-based UTF-16 position, as the Language Server Protocol counts. */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspBoundDocument {
  readonly rootId: string;
  /** The path as the volume folds it (N2''). */
  readonly relativePath: string;
  /** The file's identity (device:inode) at binding. */
  readonly identity: string;
  readonly sourceDigest: string;
  readonly documentVersion: number;
  readonly serverGeneration: string;
  readonly profile: string;
}

export interface NavigationLocation {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly startByte: number;
  readonly endByte: number;
  /** The start line's text as data (controls stripped, redacted, bounded);
   * empty when the preview bound was reached. */
  readonly preview: string;
  readonly name?: string;
  readonly kind?: SymbolKind;
  readonly depth?: number;
  readonly declaration?: boolean;
  readonly endDefaulted?: boolean;
}

export interface NavigationAnswer {
  readonly requestRef: string;
  readonly method: NavigationMethod;
  readonly status: NavigationStatus;
  /** A code of the closed enumeration (R1); never server text. */
  readonly reason?: NavigationReason;
  /** Server or host text behind the code, redacted at emission (R1). */
  readonly detail?: string;
  readonly document?: LspBoundDocument;
  readonly position?: LspPosition;
  readonly locations: readonly NavigationLocation[];
  readonly omitted: Readonly<Record<string, number>>;
  readonly prepare?: { readonly placeholder: string; readonly line: number; readonly character: number; readonly startByte: number; readonly endByte: number };
  readonly proof?: "version_matched";
  readonly latencyMs: number;
}

/** What `lsp_servers` provides (#222, extended by #229). */
export interface LspServersCapability {
  owner(profile: string): ServerOwner | undefined;
  /** The document contract: `syncCurrent` and `stateOf` (proofs). */
  readonly provider?: DiagnosticsProvider;
  readonly replay?: boolean;
  readonly root?: string;
  readonly rootId?: string;
}

export interface LspNavigatorOptions {
  readonly servers: LspServersCapability;
  /** Real path of the workspace root, and its identity. */
  readonly root: string;
  readonly rootId: string;
  readonly record?: NavigationRecord;
  readonly now?: () => number;
  readonly syncProofMs?: number;
  readonly requestMs?: number;
  readonly locationsMax?: number;
  readonly previewMaxBytes?: number;
  readonly maxDocumentBytes?: number;
}

/** One text edit the server proposed, as data, mapped by the planner. A
 * tsserver location carries its declared prefix/suffix (N2'''); an LSP edit
 * declares none, so its text must be the new name itself. */
export interface ServerTextEdit {
  readonly range: LspRange;
  readonly newText: string;
  readonly prefixText?: string;
  readonly suffixText?: string;
}

export interface RenameServerTarget {
  readonly path: string;
  readonly identity: string;
  readonly abs: string;
  readonly bytes: Buffer;
  readonly text: DocumentText;
  readonly edits: readonly ServerTextEdit[];
}

export type RenameServerResult =
  | {
    readonly ok: true;
    readonly requestRef: string;
    readonly document: LspBoundDocument;
    readonly position: LspPosition;
    readonly oldName: string;
    readonly targets: readonly RenameServerTarget[];
    readonly latencyMs: number;
  }
  | {
    readonly ok: false;
    readonly requestRef: string;
    readonly status: "stale" | "unavailable" | "timeout" | "unsupported";
    readonly reason: NavigationReason;
    readonly detail?: string;
    readonly document?: LspBoundDocument;
    /** The name the server gave when the refusal is about it (data, redacted). */
    readonly oldName?: string;
    readonly latencyMs: number;
  };

type Bound =
  | {
    readonly ok: true;
    readonly document: LspBoundDocument;
    readonly text: DocumentText;
    readonly bytes: Uint8Array;
    readonly abs: string;
    readonly lease: Lease;
    readonly owner: ServerOwner;
    readonly state: DiagnosticState;
    readonly protocol: "lsp" | "tsserver";
  }
  | { readonly ok: false; readonly status: NavigationStatus; readonly reason: string; readonly detail?: string; readonly profile?: string };

interface RawLocation {
  readonly uri?: string;
  readonly file?: string;
  readonly range: LspRange;
  readonly name?: string;
  readonly kind?: SymbolKind;
  readonly depth?: number;
  readonly declaration?: boolean;
}

type Normalised =
  | { readonly kind: "locations"; readonly items: readonly RawLocation[] }
  | { readonly kind: "prepare"; readonly range: LspRange; readonly placeholder?: string }
  | { readonly kind: "refused"; readonly reason: string; readonly detail?: string };

/** The wire adapter per protocol: how each method is asked and read. */
interface MethodAdapter {
  supports(method: NavigationMethod | "rename", capabilities: Readonly<Record<string, unknown>> | undefined): boolean;
  request(lease: Lease, method: NavigationMethod | "rename", bound: Bound & { ok: true }, position: LspPosition | undefined, newName?: string): Promise<unknown>;
  normalise(method: NavigationMethod, raw: unknown, bound: Bound & { ok: true }): Normalised;
  rename(raw: unknown, bound: Bound & { ok: true }, newName: string): RenameRaw;
}

type RenameRaw =
  | { readonly ok: true; readonly oldName?: string; readonly edits: ReadonlyArray<{ readonly uri?: string; readonly file?: string; readonly version?: number | null; readonly range: LspRange; readonly newText: string; readonly prefixText?: string; readonly suffixText?: string }> }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

const LSP_SYMBOL_KINDS: Record<number, SymbolKind> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor",
  10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number", 17: "boolean",
  18: "array", 19: "object", 20: "key", 21: "null", 22: "enum_member", 23: "struct", 24: "event", 25: "operator", 26: "type_parameter",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const plain = stripTerminalControls(value);
  const points = Array.from(plain);
  return points.length > NAME_MAX_CHARS ? `${points.slice(0, NAME_MAX_CHARS).join("")}…` : plain;
}

/** R1': a symbol kind is a code of a closed enumeration - the LSP kinds and
 * tsserver's script element kinds mapped onto them; anything else is `other`. */
export const SYMBOL_KINDS = [
  "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function",
  "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum_member", "struct", "event", "operator",
  "type_parameter", "type", "parameter", "alias", "getter", "setter", "label", "keyword", "other",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];
const SYMBOL_KIND_SET: ReadonlySet<string> = new Set(SYMBOL_KINDS);
const TSSERVER_KINDS: ReadonlyMap<string, SymbolKind> = new Map<string, SymbolKind>([
  ["script", "file"], ["module", "module"], ["class", "class"], ["local class", "class"], ["interface", "interface"], ["type", "type"], ["enum", "enum"],
  ["enum member", "enum_member"], ["var", "variable"], ["local var", "variable"], ["using", "variable"], ["await using", "variable"], ["function", "function"],
  ["local function", "function"], ["method", "method"], ["getter", "getter"], ["setter", "setter"], ["property", "property"], ["accessor", "property"],
  ["constructor", "constructor"], ["call", "method"], ["index", "property"], ["construct", "constructor"], ["parameter", "parameter"], ["type parameter", "type_parameter"],
  ["primitive type", "type"], ["label", "label"], ["alias", "alias"], ["const", "constant"], ["let", "variable"], ["directory", "file"], ["external module name", "module"],
  ["keyword", "keyword"], ["string", "string"],
]);
function boundedKind(value: unknown): SymbolKind {
  if (typeof value === "number") return (LSP_SYMBOL_KINDS[value] as SymbolKind | undefined) ?? "other";
  if (typeof value !== "string") return "other";
  return TSSERVER_KINDS.get(value) ?? (SYMBOL_KIND_SET.has(value) ? (value as SymbolKind) : "other");
}

const LSP_ADAPTER: MethodAdapter = {
  supports(method, capabilities) {
    if (!capabilities) return false;
    if (method === "definition") return capabilities.definitionProvider !== undefined && capabilities.definitionProvider !== false;
    if (method === "references") return capabilities.referencesProvider !== undefined && capabilities.referencesProvider !== false;
    if (method === "symbols") return capabilities.documentSymbolProvider !== undefined && capabilities.documentSymbolProvider !== false;
    const rename = capabilities.renameProvider;
    if (method === "rename") return rename !== undefined && rename !== false;
    return isRecord(rename) && rename.prepareProvider === true;
  },
  request(lease, method, bound, position, newName) {
    const textDocument = { uri: fileUri(bound.abs) };
    if (method === "symbols") return lease.request("textDocument/documentSymbol", { textDocument });
    if (method === "definition") return lease.request("textDocument/definition", { textDocument, position });
    if (method === "references") return lease.request("textDocument/references", { textDocument, position, context: { includeDeclaration: true } });
    if (method === "prepare_rename") return lease.request("textDocument/prepareRename", { textDocument, position });
    return lease.request("textDocument/rename", { textDocument, position, newName });
  },
  normalise(method, raw, bound) {
    if (method === "symbols") {
      const items: RawLocation[] = [];
      const uri = fileUri(bound.abs);
      const walk = (list: unknown, depth: number) => {
        if (!Array.isArray(list)) return;
        for (const entry of list) {
          if (!isRecord(entry) || items.length >= 4 * LSP_NAV_LOCATIONS_MAX) continue;
          if (isRecord(entry.location)) {
            // SymbolInformation: flat.
            const range = readRange(entry.location.range);
            if (range) items.push({ uri: typeof entry.location.uri === "string" ? entry.location.uri : uri, range, name: boundedName(entry.name), kind: boundedKind(entry.kind), depth: 1, declaration: true });
            continue;
          }
          const range = readRange(entry.selectionRange) ?? readRange(entry.range);
          if (range) items.push({ uri, range, name: boundedName(entry.name), kind: boundedKind(entry.kind), depth, declaration: true });
          walk(entry.children, depth + 1);
        }
      };
      walk(raw, 1);
      return { kind: "locations", items };
    }
    if (method === "prepare_rename") {
      if (raw === null || raw === undefined) return { kind: "refused", reason: "not_renameable" };
      if (!isRecord(raw)) return { kind: "refused", reason: "malformed" };
      if (raw.defaultBehavior === true) return { kind: "refused", reason: "default_behavior_unsupported" };
      const range = readRange(raw.range) ?? readRange(raw);
      if (!range) return { kind: "refused", reason: "malformed" };
      return { kind: "prepare", range, ...(typeof raw.placeholder === "string" ? { placeholder: boundedName(raw.placeholder) } : {}) };
    }
    const list = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const items: RawLocation[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      // Location, or LocationLink (targetUri/targetSelectionRange).
      const range = readRange(entry.targetSelectionRange) ?? readRange(entry.targetRange) ?? readRange(entry.range);
      const uri = typeof entry.targetUri === "string" ? entry.targetUri : typeof entry.uri === "string" ? entry.uri : undefined;
      if (range && uri !== undefined) items.push({ uri, range });
    }
    return { kind: "locations", items };
  },
  rename(raw) {
    if (raw === null || raw === undefined) return { ok: true, edits: [] };
    if (!isRecord(raw)) return { ok: false, reason: "malformed" };
    const edits: Array<{ uri?: string; version?: number | null; range: LspRange; newText: string }> = [];
    const readEdits = (uri: string, version: number | null | undefined, list: unknown): string | undefined => {
      if (!Array.isArray(list)) return "malformed";
      for (const edit of list) {
        if (!isRecord(edit)) return "malformed";
        // A SnippetTextEdit or an AnnotatedTextEdit is still a text edit; anything without a range/newText is not.
        const range = readRange(edit.range);
        if (!range || typeof edit.newText !== "string") return "malformed";
        edits.push({ uri, ...(version !== undefined ? { version } : {}), range, newText: edit.newText });
      }
      return undefined;
    };
    if (Array.isArray(raw.documentChanges)) {
      for (const change of raw.documentChanges) {
        if (!isRecord(change)) return { ok: false, reason: "malformed" };
        if (typeof change.kind === "string") return { ok: false, reason: "resource_operation" };
        const textDocument = isRecord(change.textDocument) ? change.textDocument : undefined;
        if (!textDocument || typeof textDocument.uri !== "string") return { ok: false, reason: "malformed" };
        const version = textDocument.version === null ? null : typeof textDocument.version === "number" ? textDocument.version : undefined;
        const failed = readEdits(textDocument.uri, version, change.edits);
        if (failed) return { ok: false, reason: failed };
      }
    } else if (isRecord(raw.changes)) {
      for (const [uri, list] of Object.entries(raw.changes)) {
        const failed = readEdits(uri, undefined, list);
        if (failed) return { ok: false, reason: failed };
      }
    } else if (raw.changes !== undefined || raw.documentChanges !== undefined) {
      return { ok: false, reason: "malformed" };
    }
    if (raw.changeAnnotations !== undefined && edits.length === 0 && raw.documentChanges === undefined) return { ok: false, reason: "malformed" };
    return { ok: true, edits };
  },
};

/** tsserver: 1-based lines and offsets, absolute file names. */
function tsPosition(position: LspPosition): { line: number; offset: number } {
  return { line: position.line + 1, offset: position.character + 1 };
}

function tsRange(start: unknown, end: unknown): LspRange | undefined {
  const read = (value: unknown): LspPosition | undefined => {
    if (!isRecord(value) || typeof value.line !== "number" || typeof value.offset !== "number") return undefined;
    return { line: value.line - 1, character: value.offset - 1 };
  };
  const s = read(start);
  const e = read(end);
  return s && e ? { start: s, end: e } : undefined;
}

const TSSERVER_ADAPTER: MethodAdapter = {
  supports(method, capabilities) {
    return capabilities !== undefined && (method === "prepare_rename" || method === "rename"
      ? isRecord(capabilities.renameProvider)
      : capabilities[`${method === "symbols" ? "documentSymbol" : method}Provider`] === true);
  },
  request(lease, method, bound, position) {
    const file = bound.abs;
    if (method === "symbols") return lease.request("navtree", { file });
    const at = tsPosition(position!);
    if (method === "definition") return lease.request("definition", { file, ...at });
    if (method === "references") return lease.request("references", { file, ...at });
    return lease.request("rename", { file, ...at, findInStrings: false, findInComments: false });
  },
  normalise(method, raw) {
    if (method === "symbols") {
      const items: RawLocation[] = [];
      const walk = (node: unknown, depth: number) => {
        if (!isRecord(node) || items.length >= 4 * LSP_NAV_LOCATIONS_MAX) return;
        const spans = Array.isArray(node.spans) ? node.spans : [];
        const first = isRecord(spans[0]) ? spans[0] : undefined;
        const nameSpan = isRecord(node.nameSpan) ? node.nameSpan : first;
        const range = nameSpan ? tsRange(nameSpan.start, nameSpan.end) : undefined;
        if (depth > 0 && range) items.push({ range, name: boundedName(node.text), kind: boundedKind(node.kind), depth, declaration: true });
        if (Array.isArray(node.childItems)) for (const child of node.childItems) walk(child, depth + 1);
      };
      walk(raw, 0);
      return { kind: "locations", items };
    }
    if (method === "prepare_rename") {
      if (!isRecord(raw) || !isRecord(raw.info)) return { kind: "refused", reason: "malformed" };
      if (raw.info.canRename !== true) return { kind: "refused", reason: "not_renameable", ...(typeof raw.info.localizedErrorMessage === "string" ? { detail: boundedName(raw.info.localizedErrorMessage) } : {}) };
      const span = isRecord(raw.info.triggerSpan) ? raw.info.triggerSpan : undefined;
      const range = span ? tsRange(span.start, span.end) : undefined;
      if (!range) return { kind: "refused", reason: "malformed" };
      return { kind: "prepare", range, ...(typeof raw.info.displayName === "string" ? { placeholder: boundedName(raw.info.displayName) } : {}) };
    }
    const list = method === "references" ? (isRecord(raw) && Array.isArray(raw.refs) ? raw.refs : []) : Array.isArray(raw) ? raw : [];
    const items: RawLocation[] = [];
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.file !== "string") continue;
      const range = tsRange(entry.start, entry.end);
      if (range) items.push({ file: entry.file, range, ...(entry.isDefinition === true ? { declaration: true } : {}) });
    }
    return { kind: "locations", items };
  },
  rename(raw, _bound, newName) {
    if (!isRecord(raw) || !isRecord(raw.info)) return { ok: false, reason: "malformed" };
    if (raw.info.canRename !== true) return { ok: false, reason: "not_renameable", ...(typeof raw.info.localizedErrorMessage === "string" ? { detail: boundedName(raw.info.localizedErrorMessage) } : {}) };
    const edits: Array<{ file: string; range: LspRange; newText: string; prefixText?: string; suffixText?: string }> = [];
    if (!Array.isArray(raw.locs)) return { ok: false, reason: "malformed" };
    for (const group of raw.locs) {
      if (!isRecord(group) || typeof group.file !== "string" || !Array.isArray(group.locs)) return { ok: false, reason: "malformed" };
      for (const span of group.locs) {
        if (!isRecord(span)) return { ok: false, reason: "malformed" };
        const range = tsRange(span.start, span.end);
        if (!range) return { ok: false, reason: "malformed" };
        const prefix = typeof span.prefixText === "string" ? span.prefixText : "";
        const suffix = typeof span.suffixText === "string" ? span.suffixText : "";
        edits.push({ file: group.file, range, newText: `${prefix}${newName}${suffix}`, ...(prefix ? { prefixText: prefix } : {}), ...(suffix ? { suffixText: suffix } : {}) });
      }
    }
    return { ok: true, ...(typeof raw.info.displayName === "string" ? { oldName: raw.info.displayName } : {}), edits };
  },
};

class RequestTimeout extends Error {
  constructor() {
    super("request_timeout");
    this.name = "RequestTimeout";
  }
}

export class LspNavigator {
  private readonly leases = new Map<string, Lease>();
  private disposed = false;
  private readonly now: () => number;
  readonly stats = { queries: 0, lateDiscarded: 0 };

  constructor(private readonly options: LspNavigatorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** N1: a bound, proven query; N2: exact positions; bounded, recorded. */
  async query(input: { readonly method: NavigationMethod; readonly path: string; readonly position?: LspPosition }, signal?: AbortSignal): Promise<NavigationAnswer> {
    const requestRef = `nq_${randomBytes(16).toString("hex")}`;
    const started = this.now();
    this.stats.queries += 1;
    const base = { requestRef, method: input.method, ...(input.position ? { position: input.position } : {}) };
    const finish = (answer: Omit<NavigationAnswer, "requestRef" | "method" | "latencyMs" | "locations" | "omitted" | "reason"> & { reason?: string; locations?: readonly NavigationLocation[]; omitted?: Readonly<Record<string, number>> }, profile?: string): NavigationAnswer => {
      const closed = answer.reason !== undefined ? closedReason(answer.reason, answer.detail) : undefined;
      const { reason: _raw, detail: _rawDetail, ...rest } = answer;
      void _raw; void _rawDetail;
      const full: NavigationAnswer = { ...base, locations: [], omitted: {}, ...rest, ...(closed ? { reason: closed.reason } : {}), ...(closed?.detail !== undefined ? { detail: closed.detail } : {}), latencyMs: this.now() - started };
      this.record("lsp/navigation", {
        request: requestRef, method: input.method, path: safePath(input.path),
        ...(input.position ? { line: input.position.line, character: input.position.character } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(full.document ? { profile: full.document.profile, generation: full.document.serverGeneration, version: full.document.documentVersion, source_digest: full.document.sourceDigest } : {}),
        status: full.status, ...(full.reason !== undefined ? { reason: full.reason } : {}), ...(full.detail !== undefined ? { detail: full.detail } : {}),
        count: full.locations.length, ...(Object.keys(full.omitted).length > 0 ? { omitted: full.omitted } : {}),
        ...(full.proof ? { proof: full.proof } : {}), latency_ms: full.latencyMs,
      });
      return full;
    };
    if (this.disposed) return finish({ status: "unavailable", reason: "disposed" });
    const bound = await this.bind(input.path, signal);
    if (!bound.ok) return finish({ status: bound.status, reason: bound.reason, ...(bound.detail !== undefined ? { detail: bound.detail } : {}) }, bound.profile);
    const { document, text } = bound;
    if (input.method !== "symbols") {
      if (!input.position) return finish({ status: "unsupported", reason: "position_required", document });
      const offset = text.byteOffset(input.position);
      if (typeof offset === "string") return finish({ status: "unsupported", reason: `position_${offset}`, document });
    }
    const adapter = bound.protocol === "tsserver" ? TSSERVER_ADAPTER : LSP_ADAPTER;
    if (!adapter.supports(input.method, bound.lease.capabilities())) return finish({ status: "unsupported", reason: "method_not_declared", document });
    const asked = await this.ask(adapter.request(bound.lease, input.method, bound, input.position), signal, () => {
      this.stats.lateDiscarded += 1;
      this.record("lsp/navigation", { request: requestRef, method: input.method, path: safePath(input.path), profile: document.profile, generation: document.serverGeneration, version: document.documentVersion, outcome: "late_discarded", status: "stale", reason: "late_after_timeout" });
    });
    if (!asked.ok) return finish({ status: asked.status, reason: asked.reason, ...(asked.detail !== undefined ? { detail: asked.detail } : {}), document });
    const freshness = this.freshness(bound);
    if (freshness !== undefined) return finish({ status: "stale", reason: freshness, document });
    const normalised = adapter.normalise(input.method, asked.value, bound);
    if (normalised.kind === "refused") return finish({ status: "unsupported", reason: normalised.reason, ...(normalised.detail !== undefined ? { detail: normalised.detail } : {}), document });
    if (normalised.kind === "prepare") {
      const mapped = text.mapRange(normalised.range);
      if (typeof mapped === "string") return finish({ status: "unsupported", reason: "invalid_range", document });
      const placeholder = normalised.placeholder ?? text.text.slice(utf16Index(text, mapped.start), utf16Index(text, mapped.end));
      // N2': an empty range or name is not a renameable symbol.
      if (mapped.endByte <= mapped.startByte || !validNewName(bound.protocol, placeholder)) return finish({ status: "unsupported", reason: "not_renameable", document });
      return finish({
        status: "current", document, proof: "version_matched",
        prepare: { placeholder: redactForEmission(placeholder), line: mapped.start.line, character: mapped.start.character, startByte: mapped.startByte, endByte: mapped.endByte },
      });
    }
    const { locations, omitted } = this.mapLocations(normalised.items, bound);
    return finish({ status: locations.length === 0 && Object.keys(omitted).length === 0 ? "empty" : locations.length === 0 ? "empty" : "current", document, proof: "version_matched", locations, omitted });
  }

  /**
   * The rename round trip for the planner (N2/N2'/N2''/N3/B1): bound like a
   * query, the server's WorkspaceEdit read as data, every named document
   * validated inside the root through no link and keyed by its host
   * identity (a single external URI, link, resource operation, malformed
   * edit, secret path, or two spellings/links of one file refuses the whole
   * answer), the target count bounded before any file is read, each
   * target's bytes pinned and returned for exact mapping. The symbol's name
   * must be a non-empty identifier by the host's rule. Nothing is written.
   */
  async rename(input: { readonly path: string; readonly position: LspPosition; readonly newName: string; readonly targetsMax?: number }, signal?: AbortSignal): Promise<RenameServerResult> {
    const requestRef = `nq_${randomBytes(16).toString("hex")}`;
    const started = this.now();
    const fail = (status: "stale" | "unavailable" | "timeout" | "unsupported", raw: string, document?: LspBoundDocument, detail?: string): RenameServerResult => {
      const closed = closedReason(raw, detail);
      return { ok: false, requestRef, status, reason: closed.reason, ...(closed.detail !== undefined ? { detail: closed.detail } : {}), ...(document ? { document } : {}), latencyMs: this.now() - started };
    };
    if (this.disposed) return fail("unavailable", "disposed");
    const bound = await this.bind(input.path, signal);
    if (!bound.ok) return fail(bound.status === "current" || bound.status === "empty" ? "unavailable" : bound.status, bound.reason, undefined, bound.detail);
    const { document, text } = bound;
    const offset = text.byteOffset(input.position);
    if (typeof offset === "string") return fail("unsupported", `position_${offset}`, document);
    if (!validNewName(bound.protocol, input.newName)) return fail("unsupported", "new_name_invalid", document);
    const adapter = bound.protocol === "tsserver" ? TSSERVER_ADAPTER : LSP_ADAPTER;
    const capabilities = bound.lease.capabilities();
    if (!adapter.supports("rename", capabilities)) return fail("unsupported", "method_not_declared", document);
    // The symbol's name at the position: prepareRename when declared, else the
    // non-empty edit that covers the position names it (its original text).
    let oldName: string | undefined;
    if (adapter.supports("prepare_rename", capabilities)) {
      const prepared = await this.ask(adapter.request(bound.lease, "prepare_rename", bound, input.position), signal, () => { this.stats.lateDiscarded += 1; });
      if (!prepared.ok) return fail(prepared.status, prepared.reason, document, prepared.detail);
      const normalised = adapter.normalise("prepare_rename", prepared.value, bound);
      if (normalised.kind === "refused") return fail("unsupported", normalised.reason, document, normalised.detail);
      if (normalised.kind === "prepare") {
        const mapped = text.mapRange(normalised.range);
        if (typeof mapped === "string") return fail("unsupported", "invalid_range", document);
        // N2': an empty placeholder or an empty range names nothing — refused, never "".
        oldName = normalised.placeholder ?? Buffer.from(bound.bytes).subarray(mapped.startByte, mapped.endByte).toString("utf8");
        if (!validNewName(bound.protocol, oldName)) return { ...fail("unsupported", "symbol_name_invalid", document), oldName: redactForEmission(oldName) };
        if (redactForEmission(oldName) !== oldName) return { ...fail("unsupported", "symbol_name_unrecordable", document), oldName: redactForEmission(oldName) };
      }
    }
    const asked = await this.ask(adapter.request(bound.lease, "rename", bound, input.position, input.newName), signal, () => { this.stats.lateDiscarded += 1; });
    if (!asked.ok) return fail(asked.status, asked.status === "unavailable" && asked.code === -32602 ? "new_name_rejected" : asked.reason, document, asked.detail);
    const freshness = this.freshness(bound);
    if (freshness !== undefined) return fail("stale", freshness, document);
    const raw = adapter.rename(asked.value, bound, input.newName);
    if (!raw.ok) return fail("unsupported", raw.reason, document, raw.detail);
    // N2''/B1: every named document is a host identity (folded path + inode);
    // two names of one identity refuse the answer; the count is bounded
    // before any file is read.
    const targetsMax = input.targetsMax ?? 64;
    const named = new Map<string, { abs: string; identity: string; edits: ServerTextEdit[] }>();
    const identities = new Map<string, string>();
    for (const edit of raw.edits) {
      const contained = edit.uri !== undefined ? containedFileFromUri(this.options.root, edit.uri) : containedFile(this.options.root, edit.file);
      if (!contained.ok) return fail("unsupported", contained.reason === "not_file_uri" ? "external_uri" : contained.reason, document);
      const host = hostIdentity(this.options.root, contained.abs);
      if (!host) return fail("unsupported", "unreadable", document);
      if (isSecretWorkspacePath(host.rel)) return fail("unsupported", "secret_path", document);
      const known = identities.get(host.identity);
      if (known !== undefined && known !== host.rel) return fail("unsupported", "duplicate_target", document);
      identities.set(host.identity, host.rel);
      if (host.rel === document.relativePath && edit.version !== undefined && edit.version !== null && edit.version !== document.documentVersion) {
        return fail("stale", "version_mismatch", document);
      }
      let target = named.get(host.rel);
      if (!target) {
        if (named.size >= targetsMax) return fail("unsupported", "oversize_files", document);
        target = { abs: host.abs, identity: host.identity, edits: [] };
        named.set(host.rel, target);
      }
      target.edits.push({ range: edit.range, newText: edit.newText, ...(edit.prefixText !== undefined ? { prefixText: edit.prefixText } : {}), ...(edit.suffixText !== undefined ? { suffixText: edit.suffixText } : {}) });
    }
    const targets: RenameServerTarget[] = [];
    for (const [rel, target] of named) {
      const pinned = rel === document.relativePath ? { bytes: Buffer.from(bound.bytes), text } : this.readTarget(target.abs);
      if (typeof pinned === "string") return fail("unsupported", pinned, document);
      targets.push({ path: rel, abs: target.abs, identity: target.identity, bytes: pinned.bytes, text: pinned.text, edits: target.edits });
    }
    const name = oldName ?? raw.oldName ?? nameAtPosition(bound, input.position, targets.find((target) => target.path === document.relativePath)?.edits ?? [], text);
    // N2': the symbol's text is a non-empty identifier or the answer is nothing.
    if (name === undefined || !validNewName(bound.protocol, name)) {
      const refused = fail("unsupported", "symbol_name_invalid", document);
      return name === undefined ? refused : { ...refused, oldName: redactForEmission(name) };
    }
    // R2: a name the rows could only carry redacted cannot be planned — its
    // record, and a rollback derived from it, would not name it.
    if (redactForEmission(name) !== name) return { ...fail("unsupported", "symbol_name_unrecordable", document), oldName: redactForEmission(name) };
    return {
      ok: true, requestRef, document, position: input.position, oldName: redactForEmission(name), latencyMs: this.now() - started, targets,
    };
  }
  /**
   * N5: after a multi-file apply, every committed receipt is fed to #222's
   * provider once more, in order, so each renamed file is checked against
   * the others' NEW bytes (a file checked while a sibling still held its old
   * name would otherwise keep that stale error until its next commit). The
   * provider coalesces; nothing waits.
   */
  recheck(receipts: readonly CommitReceipt[]): void {
    const provider = this.options.servers.provider;
    if (!provider || this.disposed) return;
    void this.recheckLater(provider, receipts);
  }

  /** The re-feed waits for each file's first check to settle (the server
   * checks one document at a time, so by then it holds every new version),
   * bounded by the proof window; then every receipt is fed once more. */
  private async recheckLater(provider: DiagnosticsProvider, receipts: readonly CommitReceipt[]): Promise<void> {
    const deadline = this.now() + (this.options.syncProofMs ?? LSP_NAV_SYNC_PROOF_MS);
    for (const receipt of receipts) {
      while (!this.disposed && this.now() < deadline && provider.statusOf(receipt.after.path) === "pending") await Bun.sleep(10);
    }
    if (this.disposed) return;
    for (const receipt of receipts) provider.recheck(receipt);
  }

  /** Every lease released: the last consumer's release ends the process. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const leases = [...this.leases.values()];
    this.leases.clear();
    await Promise.all(leases.map((lease) => lease.release()));
  }

  // -------------------------------------------------------------- binding

  private async bind(path: string, signal?: AbortSignal): Promise<Bound> {
    const provider = this.options.servers.provider;
    if (!provider || this.options.servers.replay) return { ok: false, status: "unavailable", reason: "no_provider" };
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\u0000")) return { ok: false, status: "unsupported", reason: "path_malformed_uri" };
    const resolved = provider.profileOf(path);
    if (!resolved.ok) return { ok: false, status: "unavailable", reason: resolved.reason === "no_profile" ? "no_profile" : "profile_unavailable", detail: resolved.reason, ...(resolved.profile !== undefined ? { profile: resolved.profile } : {}) };
    const profile = resolved.profile;
    const owner = this.options.servers.owner(profile.id);
    if (!owner) return { ok: false, status: "unavailable", reason: "no_owner", profile: profile.id };
    if (owner.state === "disposed") return { ok: false, status: "unavailable", reason: "disposed", profile: profile.id };
    if (owner.state === "unavailable") return { ok: false, status: "unavailable", reason: "server_unavailable", detail: owner.reason ?? "unavailable", profile: profile.id };
    let lease = this.leases.get(profile.id);
    if (!lease) {
      try {
        lease = owner.acquire("navigation");
      } catch {
        return { ok: false, status: "unavailable", reason: "disposed", profile: profile.id };
      }
      this.leases.set(profile.id, lease);
    }
    // N2'': the model's spelling is folded to the host identity before
    // anything is keyed by it (`./a.ts`, case and normalisation variants).
    const contained = containedFile(this.options.root, join(this.options.root, path));
    if (!contained.ok) return { ok: false, status: "unsupported", reason: `path_${contained.reason}`, profile: profile.id };
    const host = hostIdentity(this.options.root, contained.abs);
    if (!host) return { ok: false, status: "unsupported", reason: "path_unreadable", profile: profile.id };
    path = host.rel;
    // S3: a credential file is never bound, synced or sent - refused before any read.
    if (isSecretWorkspacePath(path)) return { ok: false, status: "unsupported", reason: "secret_path", profile: profile.id };
    const sync = provider.syncCurrent(path, "navigation");
    if (!sync.ok) {
      const unsupported = sync.reason === "over_10_mib" || sync.reason === "not_utf8" || sync.reason.startsWith("path_");
      return { ok: false, status: unsupported ? "unsupported" : "unavailable", reason: sync.reason, profile: profile.id };
    }
    const state = provider.stateOf(profile.id)!;
    const deadline = this.now() + (this.options.syncProofMs ?? LSP_NAV_SYNC_PROOF_MS);
    // The proof (D1): a matched batch for this generation and version.
    for (;;) {
      if (signal?.aborted) return { ok: false, status: "unavailable", reason: "aborted", profile: profile.id };
      const ownerState = stateOf(owner);
      if (ownerState === "unavailable" || ownerState === "disposed") return { ok: false, status: "unavailable", reason: "server_unavailable", detail: owner.reason ?? ownerState, profile: profile.id };
      if (owner.generation !== sync.generation) return { ok: false, status: "stale", reason: "generation_ended", profile: profile.id };
      const matched = state.currentMatched(path);
      if (matched && matched.documentVersion === sync.version && matched.generation === sync.generation) break;
      const latest = state.latestSent(path);
      if (!latest || latest.version !== sync.version) return { ok: false, status: "stale", reason: "superseded", profile: profile.id };
      if (this.now() >= deadline) return { ok: false, status: "timeout", reason: "sync_unproven", profile: profile.id };
      await Bun.sleep(5);
    }
    const text = DocumentText.fromBytes(sync.bytes);
    if (!text) return { ok: false, status: "unsupported", reason: "not_utf8", profile: profile.id };
    return {
      ok: true,
      document: { rootId: this.options.rootId, relativePath: path, identity: host.identity, sourceDigest: sync.digest, documentVersion: sync.version, serverGeneration: sync.generation, profile: profile.id },
      text, bytes: sync.bytes, abs: sync.abs, lease, owner, state, protocol: profile.protocol ?? "lsp",
    };
  }

  /** Why the binding no longer holds at answer time, if it does not. */
  private freshness(bound: Bound & { ok: true }): string | undefined {
    if (bound.owner.generation !== bound.document.serverGeneration) return "generation_ended";
    const latest = bound.state.latestSent(bound.document.relativePath);
    if (!latest || latest.version !== bound.document.documentVersion || latest.generation !== bound.document.serverGeneration) return "superseded";
    const contained = containedFile(this.options.root, join(this.options.root, bound.document.relativePath));
    if (!contained.ok) return `source_${contained.reason}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(contained.abs);
    } catch {
      return "source_unreadable";
    }
    return createHash("sha256").update(bytes).digest("hex") === bound.document.sourceDigest ? undefined : "source_changed";
  }

  /** One request, bounded; an answer after the bound is discarded (`late`). */
  private async ask(request: Promise<unknown>, signal: AbortSignal | undefined, late: () => void):
    Promise<{ ok: true; value: unknown } | { ok: false; status: "stale" | "unavailable" | "timeout" | "unsupported"; reason: string; detail?: string; code?: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const timeout = new Promise<RequestTimeout>((resolve) => { timer = setTimeout(() => resolve(new RequestTimeout()), this.options.requestMs ?? LSP_NAV_REQUEST_MS); });
    const abort = new Promise<"aborted">((resolve) => { signal?.addEventListener("abort", () => resolve("aborted"), { once: true }); });
    try {
      const outcome = await Promise.race([request.then((value) => ({ value }), (error: unknown) => ({ error })), timeout, abort]);
      settled = true;
      if (outcome === "aborted") return { ok: false, status: "unavailable", reason: "aborted" };
      if (outcome instanceof RequestTimeout) {
        settled = false;
        return { ok: false, status: "timeout", reason: "request_timeout" };
      }
      if ("error" in outcome) {
        const error = outcome.error as { message?: string; code?: number; detail?: string } | undefined;
        const message = error?.message ?? "";
        if (message === "generation_ended" || message === "lease_released") return { ok: false, status: "stale", reason: "generation_ended" };
        if (error?.code === -32601) return { ok: false, status: "unsupported", reason: "method_not_found", ...(error.detail !== undefined ? { detail: error.detail } : {}) };
        if (message.startsWith("unavailable:")) return { ok: false, status: "unavailable", reason: "server_unavailable", detail: message.slice("unavailable:".length).trim() };
        if (message === "not_ready") return { ok: false, status: "unavailable", reason: "not_ready" };
        const detail = `${error?.code !== undefined ? `code ${error.code}` : "no code"}${error?.detail !== undefined ? `: ${error.detail}` : ""}`;
        return { ok: false, status: "unavailable", reason: "server_error", detail, ...(error?.code !== undefined ? { code: error.code } : {}) };
      }
      return { ok: true, value: outcome.value };
    } finally {
      if (timer) clearTimeout(timer);
      if (!settled) {
        // A late answer of this generation (or its rejection) is discarded.
        void request.then(() => late(), () => undefined);
      }
    }
  }

  // -------------------------------------------------------------- mapping

  private readTarget(abs: string): { bytes: Buffer; text: DocumentText } | string {
    const max = this.options.maxDocumentBytes ?? LSP_DOCUMENT_MAX_BYTES;
    let bytes: Buffer;
    try {
      // B1': the size is known before a byte is read.
      if (lstatSync(abs).size > max) return "target_over_10_mib";
      bytes = readFileSync(abs);
    } catch {
      return "target_unreadable";
    }
    if (bytes.length > max) return "target_over_10_mib";
    const text = DocumentText.fromBytes(bytes);
    if (!text) return "target_not_utf8";
    return { bytes, text };
  }

  private mapLocations(items: readonly RawLocation[], bound: Bound & { ok: true }): { locations: NavigationLocation[]; omitted: Record<string, number> } {
    const omitted: Record<string, number> = {};
    const count = (reason: string) => { omitted[reason] = (omitted[reason] ?? 0) + 1; };
    const locations: NavigationLocation[] = [];
    const documents = new Map<string, { text: DocumentText } | string>();
    const locationsMax = this.options.locationsMax ?? LSP_NAV_LOCATIONS_MAX;
    const previewMax = this.options.previewMaxBytes ?? LSP_NAV_PREVIEW_MAX_BYTES;
    let previewBytes = 0;
    for (const item of items) {
      if (locations.length >= locationsMax) {
        count("location_bound");
        continue;
      }
      const contained: Containment = item.uri !== undefined ? containedFileFromUri(this.options.root, item.uri) : item.file !== undefined ? containedFile(this.options.root, item.file) : { ok: true, rel: bound.document.relativePath, abs: bound.abs };
      if (!contained.ok) {
        count(contained.reason === "not_file_uri" ? "external_uri" : contained.reason);
        continue;
      }
      if (isSecretWorkspacePath(contained.rel)) {
        count("secret_path");
        continue;
      }
      let document = documents.get(contained.rel);
      if (document === undefined) {
        if (contained.rel === bound.document.relativePath) document = { text: bound.text };
        else {
          const read = this.readTarget(contained.abs);
          document = typeof read === "string" ? read : { text: read.text };
        }
        documents.set(contained.rel, document);
      }
      if (typeof document === "string") {
        count(document);
        continue;
      }
      const mapped = document.text.mapRange(item.range);
      if (typeof mapped === "string") {
        count("invalid_range");
        continue;
      }
      let preview = previewLine(document.text, mapped.start.line);
      const cost = Buffer.byteLength(preview, "utf8");
      if (previewBytes + cost > previewMax) {
        count("preview_bound");
        preview = "";
      } else previewBytes += cost;
      locations.push({
        path: contained.rel,
        line: mapped.start.line, character: mapped.start.character, endLine: mapped.end.line, endCharacter: mapped.end.character,
        startByte: mapped.startByte, endByte: mapped.endByte, preview,
        ...(item.name !== undefined ? { name: redactForEmission(item.name) } : {}),
        ...(item.kind !== undefined ? { kind: item.kind } : {}),
        ...(item.depth !== undefined ? { depth: item.depth } : {}),
        ...(item.declaration !== undefined ? { declaration: item.declaration } : {}),
        ...(mapped.endDefaulted ? { endDefaulted: true } : {}),
      });
    }
    return { locations, omitted };
  }

  private record(name: NavigationRecordName, payload: Record<string, unknown>): number | undefined {
    try {
      const seq = this.options.record?.(name, redactedRow(payload));
      return typeof seq === "number" ? seq : undefined;
    } catch {
      // Observability never changes what the navigator answers.
      return undefined;
    }
  }
}

/** The owner's state read afresh (a getter; never narrowed by an earlier check). */
function stateOf(owner: ServerOwner): OwnerState {
  return owner.state;
}

/** The UTF-16 index of a validated position in the text. */
function utf16Index(text: DocumentText, position: LspPosition): number {
  let index = 0;
  let line = 0;
  const value = text.text;
  while (line < position.line && index < value.length) {
    const next = value.indexOf("\n", index);
    const cr = value.indexOf("\r", index);
    const stop = next < 0 ? (cr < 0 ? value.length : cr) : cr >= 0 && cr < next ? cr : next;
    index = stop + (value[stop] === "\r" && value[stop + 1] === "\n" ? 2 : 1);
    line += 1;
  }
  return index + position.character;
}

/** The symbol's text at the position when no prepare answer named it: the
 * edit of the bound document that covers the position, its original bytes. */
function nameAtPosition(bound: Bound & { ok: true }, position: LspPosition, edits: readonly ServerTextEdit[], text: DocumentText): string | undefined {
  for (const edit of edits) {
    const mapped = text.mapRange(edit.range);
    if (typeof mapped === "string" || mapped.endByte <= mapped.startByte) continue;
    const at = text.byteOffset(position);
    if (typeof at === "string") continue;
    if (mapped.startByte <= at && at <= mapped.endByte) return Buffer.from(bound.bytes).subarray(mapped.startByte, mapped.endByte).toString("utf8");
  }
  return undefined;
}

/** One line of a document as data: controls stripped, redacted, bounded. */
export function previewLine(text: DocumentText, line: number): string {
  const value = text.text;
  let index = 0;
  for (let current = 0; current < line && index < value.length; current += 1) {
    const next = value.indexOf("\n", index);
    if (next < 0) return "";
    index = next + 1;
  }
  let end = value.indexOf("\n", index);
  if (end < 0) end = value.length;
  if (value[end - 1] === "\r") end -= 1;
  let body = value.slice(index, end);
  if (Buffer.byteLength(body, "utf8") > PREVIEW_LINE_MAX_BYTES) {
    let cut = "";
    for (const character of body) {
      if (Buffer.byteLength(cut + character, "utf8") > PREVIEW_LINE_MAX_BYTES - 1) break;
      cut += character;
    }
    body = `${cut}…`;
  }
  return redactForEmission(stripTerminalControls(body));
}

/** A path for a durable row: never a credential shape. */
export function safePath(path: string): string {
  return redactText(path);
}

/**
 * N2'': a contained file's host identity — the path as the volume folds it
 * (realpath of a link-free path: case and normalisation) and its
 * device:inode. Undefined when the file cannot be examined or the folded
 * path leaves the root.
 */
export function hostIdentity(root: string, abs: string): { readonly rel: string; readonly abs: string; readonly identity: string } | undefined {
  try {
    const real = realpathSync.native(abs);
    const inside = relative(root, real);
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    const stat = lstatSync(real, { bigint: true });
    if (!stat.isFile()) return undefined;
    return { rel: inside.split(sep).join("/"), abs: real, identity: `${stat.dev}:${stat.ino}` };
  } catch {
    return undefined;
  }
}

/** R1: the closed enumeration of reason codes; anything else is `unknown`
 * with the raw text (host-generated, or a server's, redacted) as `detail`. */
export const NAVIGATION_REASONS = [
  "disposed", "aborted", "no_provider", "no_profile", "profile_unavailable", "no_owner", "server_unavailable", "not_ready", "no_lease", "no_generation",
  "sync_unproven", "generation_ended", "superseded", "source_changed", "source_unreadable", "source_outside_root", "source_link", "source_not_regular_file", "source_malformed_uri",
  "request_timeout", "late_after_timeout", "server_error", "method_not_declared", "method_not_found", "position_required",
  "position_invalid_utf8", "position_not_integer", "position_line_out_of_range", "position_character_out_of_range", "position_inside_surrogate_pair", "position_inverted_range",
  "path_not_file_uri", "path_malformed_uri", "path_outside_root", "path_link", "path_not_regular_file", "path_unreadable",
  "over_10_mib", "not_utf8", "unreadable", "external_uri", "malformed_uri", "outside_root", "link", "not_regular_file",
  "malformed", "not_renameable", "default_behavior_unsupported", "invalid_range", "resource_operation", "secret_path", "duplicate_target", "version_mismatch",
  "oversize_files", "oversize_patch", "target_unreadable", "target_over_10_mib", "target_not_utf8", "symbol_name_invalid", "new_name_invalid", "new_name_rejected",
  "edit_text_mismatch", "edit_text_unexpected", "overlapping_edits", "no_edits", "read_only", "no_version_authority", "unrecorded",
  "unknown_plan_ref", "plan_used", "plan_not_ready", "not_applied", "no_log", "interrupted", "interrupted_before_first_commit", "original_unrecorded", "symbol_name_unrecordable", "external_change", "path_unresolved", "unknown",
] as const;
export type NavigationReason = (typeof NAVIGATION_REASONS)[number];
const REASON_SET: ReadonlySet<string> = new Set(NAVIGATION_REASONS);

/** R2/R1': a row's payload built through the redactor - every string of it
 * (nested objects and arrays included) passes the emission redactor, so the
 * event log's own secret rejection cannot fire on a server's or a model's
 * text and drop a lifecycle row. Numbers, booleans and null pass as they are. */
export function redactedRow<T>(value: T): T {
  if (typeof value === "string") return redactForEmission(stripTerminalControls(value)) as T;
  if (Array.isArray(value)) return value.map((item) => redactedRow(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactedRow(item);
    return out as T;
  }
  return value;
}

export function closedReason(raw: string, detail?: string): { readonly reason: NavigationReason; readonly detail?: string } {
  const safe = detail !== undefined ? redactForEmission(stripTerminalControls(detail)).slice(0, 200) : undefined;
  if (REASON_SET.has(raw)) return { reason: raw as NavigationReason, ...(safe !== undefined ? { detail: safe } : {}) };
  const text = redactForEmission(stripTerminalControls(raw)).slice(0, 200);
  return { reason: "unknown", detail: safe !== undefined ? `${text}: ${safe}` : text };
}

const TS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw",
  "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements", "interface", "package", "private",
  "protected", "public", "await",
]);

/**
 * N3: the host's own rule for a new name before the server is asked — an
 * identifier of the profile's language (tsserver: ECMAScript IdentifierName
 * minus reserved words; LSP: a Unicode identifier shape, the server's own
 * language rule decides the rest). Never whitespace, controls or NUL.
 */
export function validNewName(protocol: "lsp" | "tsserver", name: unknown): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > NAME_MAX_CHARS) return false;
  if (/[\p{C}\s]/u.test(name)) return false;
  if (protocol === "tsserver") {
    return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u.test(name) && !TS_RESERVED.has(name);
  }
  return /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u.test(name);
}
