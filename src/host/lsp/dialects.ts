import { encodeJsonLine, encodeLspFrame, isRecord } from "./protocol.ts";
import { fileUri } from "./uri.ts";
import type { Dialect, DialectFactory, DialectIo, DocumentSync } from "./server.ts";

/** A check tsserver never completes is abandoned (the document stays not
 * inspected) so the next one can be asked. */
export const TSSERVER_CHECK_MS = 60_000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The Language Server Protocol, full-document sync (#222 L1). The host
 * advertises `versionSupport`; a `publishDiagnostics` without a version is
 * passed on as unversioned (D1 makes it `unverified`). Requests the server
 * makes of the client are answered with empty results, never acted on.
 */
export function lspDialect(): DialectFactory {
  return (io: DialectIo): Dialect => {
    let nextId = 1;
    const pending = new Map<number, Pending>();
    const opened = new Set<string>();
    let closed = false;
    let capabilities: Readonly<Record<string, unknown>> | undefined;
    const request = (method: string, params: unknown): Promise<unknown> => {
      if (closed) return Promise.reject(new Error("generation_ended"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          io.send({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error("send_failed"));
        }
      });
    };
    return {
      encode: encodeLspFrame,
      async handshake() {
        const result = await request("initialize", {
          processId: null,
          clientInfo: { name: "dokkabi" },
          rootUri: fileUri(io.root),
          workspaceFolders: [{ uri: fileUri(io.root), name: "workspace" }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: false, willSave: false },
              publishDiagnostics: { versionSupport: true, relatedInformation: false },
            },
            general: { positionEncodings: ["utf-16"] },
          },
        });
        const declared = isRecord(result) && isRecord(result.capabilities) ? result.capabilities : {};
        capabilities = Object.freeze({ ...declared });
        io.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      },
      capabilities() {
        return capabilities;
      },
      sync(doc: DocumentSync) {
        const uri = fileUri(doc.abs);
        if (!opened.has(uri)) {
          opened.add(uri);
          io.send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
            textDocument: { uri, languageId: doc.languageId, version: doc.version, text: doc.text },
          } });
        } else {
          io.send({ jsonrpc: "2.0", method: "textDocument/didChange", params: {
            textDocument: { uri, version: doc.version },
            contentChanges: [{ text: doc.text }],
          } });
        }
      },
      receive(message) {
        const method = typeof message.method === "string" ? message.method : undefined;
        if (method === undefined && (typeof message.id === "number" || typeof message.id === "string")) {
          const entry = typeof message.id === "number" ? pending.get(message.id) : undefined;
          if (!entry) {
            io.discard("unmatched_response");
            return;
          }
          pending.delete(message.id as number);
          if ("error" in message && message.error !== undefined) entry.reject(serverError(message.error));
          else entry.resolve(message.result);
          return;
        }
        if (method === "textDocument/publishDiagnostics") {
          const params = isRecord(message.params) ? message.params : {};
          io.batch({
            uri: typeof params.uri === "string" ? params.uri : undefined,
            ...(typeof params.version === "number" ? { version: params.version } : {}),
            diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
          });
          return;
        }
        if (method !== undefined && message.id !== undefined) {
          // A request of the server: answered, never acted on.
          const params = isRecord(message.params) ? message.params : {};
          const result = method === "workspace/configuration"
            ? (Array.isArray(params.items) ? params.items.map(() => null) : [])
            : method === "client/registerCapability" || method === "window/workDoneProgress/create"
              || method === "client/unregisterCapability" ? null : undefined;
          io.send(result === undefined
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not supported" } }
            : { jsonrpc: "2.0", id: message.id, result });
        }
        // Any other notification (logs, progress, telemetry) is ignored.
      },
      request,
      close() {
        closed = true;
        for (const entry of pending.values()) entry.reject(new Error("generation_ended"));
        pending.clear();
      },
    };
  };
}

/** A server's error as data: the code it gave (LSP `-32601` is "method not
 * found") and a bounded message; nothing in it is acted on. */
function serverError(error: unknown): Error & { code?: number; detail?: string } {
  const record = isRecord(error) ? error : {};
  const out = new Error("server_error") as Error & { code?: number; detail?: string };
  if (typeof record.code === "number") out.code = record.code;
  if (typeof record.message === "string") out.detail = record.message.slice(0, 200);
  return out;
}

/** What tsserver speaks of the methods #229 uses (it declares nothing). */
const TSSERVER_CAPABILITIES: Readonly<Record<string, unknown>> = Object.freeze({
  definitionProvider: true,
  referencesProvider: true,
  documentSymbolProvider: true,
  renameProvider: { prepareProvider: true },
});

const TS_SCRIPT_KIND: Record<string, string> = { ts: "TS", mts: "TS", cts: "TS", tsx: "TSX", js: "JS", mjs: "JS", cjs: "JS", jsx: "JSX" };

/**
 * TypeScript's own server protocol (#222 L4). tsserver carries no document
 * version, so the dialect makes one exact by construction: it sends a
 * document's bytes (`open` with the full content) and asks for that file's
 * errors (`geterr`), and starts no other check until tsserver reports that
 * request complete. tsserver handles requests in order, so the syntactic
 * and semantic diagnostics that arrive for that file before completion
 * describe exactly the bytes sent — the batch carries that version. A check
 * that never completes leaves the document not inspected.
 *
 * Documents synchronised together (#229 N5, after a multi-file rename) are
 * all OPENED before any of them is checked, so a check never runs against a
 * sibling's earlier bytes: syncs of one turn are batched by a zero timer,
 * every queued document is opened first, then the checks run one at a time.
 * Per document (D1'): while its check is in flight nothing is sent for it —
 * a re-sync waits for `requestCompleted`, then is opened and checked.
 */
export function tsserverDialect(options: { readonly checkMs?: number } = {}): DialectFactory {
  return (io: DialectIo): Dialect => {
    let seq = 0;
    const pending = new Map<number, Pending>();
    /** Synchronised, not yet opened at tsserver. */
    const queue: DocumentSync[] = [];
    /** Opened, awaiting their check, in open order. */
    const checks: DocumentSync[] = [];
    const opened = new Set<string>();
    const openedVersion = new Map<string, number>();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let checking: {
      readonly seq: number;
      readonly doc: DocumentSync;
      syntax?: unknown[];
      semantic?: unknown[];
      timer: ReturnType<typeof setTimeout>;
    } | undefined;
    const send = (command: string, args: unknown): number => {
      seq += 1;
      io.send({ seq, type: "request", command, arguments: args });
      return seq;
    };
    const request = (command: string, args: unknown): Promise<unknown> => {
      if (closed) return Promise.reject(new Error("generation_ended"));
      return new Promise((resolve, reject) => {
        let id: number;
        try {
          id = send(command, args);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("send_failed"));
          return;
        }
        pending.set(id, { resolve, reject });
      });
    };
    const finish = () => {
      if (checking) clearTimeout(checking.timer);
      checking = undefined;
      pump();
    };
    const pump = () => {
      if (closed) return;
      // Every queued document is opened before any check starts — except the
      // one under check (D1'): it is re-opened only after `requestCompleted`.
      for (let index = 0; index < queue.length;) {
        const doc = queue[index]!;
        if (checking && checking.doc.abs === doc.abs) {
          index += 1;
          continue;
        }
        queue.splice(index, 1);
        if (opened.has(doc.abs)) send("close", { file: doc.abs });
        opened.add(doc.abs);
        openedVersion.set(doc.abs, doc.version);
        const extension = doc.abs.split(".").at(-1) ?? "";
        send("open", { file: doc.abs, fileContent: doc.text, scriptKindName: TS_SCRIPT_KIND[extension] ?? "TS", projectRootPath: io.root });
        const waiting = checks.findIndex((entry) => entry.abs === doc!.abs);
        if (waiting >= 0) checks.splice(waiting, 1);
        checks.push(doc);
      }
      if (checking) return;
      for (let doc = checks.shift(); doc; doc = checks.shift()) {
        // A newer open of the same file replaced these bytes: its own check follows.
        if (openedVersion.get(doc.abs) !== doc.version) continue;
        const id = send("geterr", { files: [doc.abs], delay: 0 });
        checking = { seq: id, doc, timer: setTimeout(finish, options.checkMs ?? TSSERVER_CHECK_MS) };
        return;
      }
    };
    const schedule = () => {
      if (scheduled || closed) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        try {
          pump();
        } catch {
          // A failed write ended the generation through the owner.
        }
      }, 0);
    };
    return {
      encode: encodeJsonLine,
      async handshake() {
        // N2'''': the server declares its rename affixes (`old: `, `: old`, `old as `, ` as old`).
        await request("configure", { hostInfo: "dokkabi", preferences: { providePrefixAndSuffixTextForRename: true } });
      },
      capabilities() {
        return TSSERVER_CAPABILITIES;
      },
      sync(doc) {
        const index = queue.findIndex((entry) => entry.abs === doc.abs);
        if (index >= 0) queue.splice(index, 1);
        queue.push(doc);
        schedule();
      },
      receive(message) {
        if (message.type === "response") {
          const id = typeof message.request_seq === "number" ? message.request_seq : undefined;
          const entry = id === undefined ? undefined : pending.get(id);
          if (entry && id !== undefined) {
            pending.delete(id);
            if (message.success === true) entry.resolve(message.body);
            else entry.reject(serverError({ message: message.message }));
          }
          return;
        }
        if (message.type !== "event") return;
        const body = isRecord(message.body) ? message.body : {};
        if (message.event === "syntaxDiag" || message.event === "semanticDiag") {
          if (!checking || body.file !== checking.doc.abs) {
            io.discard("unrequested");
            return;
          }
          const list = Array.isArray(body.diagnostics) ? body.diagnostics : [];
          if (message.event === "syntaxDiag") checking.syntax = list;
          else checking.semantic = list;
          return;
        }
        if (message.event === "requestCompleted") {
          if (!checking || body.request_seq !== checking.seq) return;
          const { doc, syntax, semantic } = checking;
          if (syntax && semantic) {
            io.batch({ file: doc.abs, version: doc.version, diagnostics: [...syntax, ...semantic].map(tsserverDiagnostic) });
          }
          finish();
        }
      },
      request,
      close() {
        closed = true;
        if (checking) clearTimeout(checking.timer);
        checking = undefined;
        if (scheduled) clearTimeout(scheduled);
        scheduled = undefined;
        queue.length = 0;
        checks.length = 0;
        for (const entry of pending.values()) entry.reject(new Error("generation_ended"));
        pending.clear();
      },
    };
  };
}

/** tsserver positions are 1-based lines and 1-based UTF-16 offsets. */
function tsserverDiagnostic(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const start = isRecord(value.start) ? value.start : {};
  const end = isRecord(value.end) ? value.end : {};
  const position = (point: Record<string, unknown>) => ({
    line: typeof point.line === "number" ? point.line - 1 : -1,
    character: typeof point.offset === "number" ? point.offset - 1 : -1,
  });
  const severity = value.category === "error" ? 1 : value.category === "warning" ? 2 : value.category === "suggestion" ? 4 : 3;
  return {
    range: { start: position(start), end: position(end) },
    severity,
    message: value.text,
    ...(value.code !== undefined ? { code: `TS${String(value.code)}` } : {}),
  };
}
