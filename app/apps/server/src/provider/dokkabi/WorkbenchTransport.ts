/**
 * Dokkabi workbench transport — JSON-RPC 2.0 over the gateway's
 * token-authenticated loopback WebSocket.
 *
 * Boundary rules:
 * - The configured URL must be a loopback `ws://` URL with no credentials,
 *   query or fragment. The client authenticates with private WebSocket protocols.
 * - The token is resolved ONLY here, in the server environment, from the
 *   named environment variable. It never travels to the renderer, is never
 *   persisted, and never appears in errors, logs or resume state: every
 *   surfaced message passes `redactToken`, and errors name the variable,
 *   never its value (raw and URL-encoded forms are both scrubbed).
 * - The connect attempt has its own bounded deadline (a gateway that never
 *   completes the WebSocket handshake cannot hang a Send forever); request
 *   timeouts are separate and there is no generation-time cap of any kind.
 * - Socket callbacks are fenced by connection epoch: a delayed close/error
 *   from an obsolete connection can never drop the current one. A malformed
 *   frame fails the pending request and closes the connection immediately;
 *   gateway broadcast NOTIFICATIONS (frames with a method and no id) are
 *   ignored, never treated as malformed and never invoking anything.
 *
 * @module provider/dokkabi/WorkbenchTransport
 */
// @effect-diagnostics globalTimers:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  decodeFrameOrNotification,
  encodeRequest,
  STRICT_DECODE_OPTIONS,
  workbenchParamsSchemas,
  type JsonRpcResponse,
  type WorkbenchMethod,
} from "./WorkbenchProtocol.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a configured gateway URL: loopback ws, no credentials/query. */
export function validateGatewayUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "gateway URL is empty" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "gateway URL is not a valid URL" };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, reason: `gateway URL must use ws:// (got ${url.protocol}//)` };
  }
  const host = url.hostname === "::1" ? "[::1]" : url.hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      ok: false,
      reason: `gateway URL must be loopback (127.0.0.1, localhost, ::1), got ${url.hostname}`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "gateway URL must not carry credentials" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "gateway URL must not carry a query or fragment" };
  }
  return { ok: true, url };
}

export class WorkbenchTransportError extends Schema.TaggedError<WorkbenchTransportError>()(
  "WorkbenchTransportError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Dokkabi gateway transport: ${this.detail}`;
  }
}

/** Minimal WebSocket surface so tests can inject a double. */
export interface WorkbenchSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "open", listener: () => void): void;
  addEventListener(event: "close", listener: (event: { code?: number }) => void): void;
  addEventListener(event: "error", listener: () => void): void;
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
}

export interface WorkbenchTransportOptions {
  /** Validated loopback ws:// URL (query/credentials forbidden). */
  readonly url: URL;
  /** Name of the environment variable holding the pairing token. */
  readonly tokenEnv: string;
  /** Environment read at call time; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
  /** Bounded handshake deadline, distinct from any work runtime. */
  readonly connectTimeoutMs?: number;
  /** Test seam; production uses the global WebSocket. */
  readonly socketFactory?: (url: string, protocols?: ReadonlyArray<string>) => WorkbenchSocket;
}

interface Pending {
  readonly id: number;
  resolve(response: JsonRpcResponse): void;
  reject(error: WorkbenchTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkbenchTransport {
  private readonly options: WorkbenchTransportOptions;
  private socket: WorkbenchSocket | undefined;
  private socketReady: Promise<void> | undefined;
  /**
   * Settles the current connect promise. Kept on the instance so ANY drop
   * path — connect deadline, close-before-open, error, malformed frame,
   * transport close — rejects a still-pending connect at the source instead
   * of leaving `await ensureSocket()` hung forever.
   */
  private settleSocketReady: ((error: WorkbenchTransportError | undefined) => void) | undefined;
  /** Increments per connection; fences stale callbacks. */
  private connectionEpoch = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Requests serialize: the R2 gateway mutates one binding at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: WorkbenchTransportOptions) {
    this.options = options;
  }

  /** The token value, resolved server-side. Never logged or persisted. */
  private resolveToken(): string | undefined {
    return (this.options.env ?? process.env)[this.options.tokenEnv];
  }

  /** Scrub the pairing token (raw, URI-encoded and form-encoded forms) from
   * any surfaced text. `URLSearchParams` encodes spaces as '+' and leaves
   * more characters unescaped than `encodeURIComponent`, so a leaked
   * query-string fragment needs its own replacement pass. */
  private redact(text: string): string {
    const token = this.resolveToken();
    if (token === undefined || token.length === 0) return text;
    let redacted = text.split(token).join("<redacted-token>");
    const variants = new Set([encodeURIComponent(token)]);
    const formEncoded = new URLSearchParams({ t: token }).toString().slice(2);
    if (formEncoded !== token) {
      variants.add(formEncoded);
    }
    for (const variant of variants) {
      if (variant !== token && variant.length > 0) {
        redacted = redacted.split(variant).join("<redacted-token>");
      }
    }
    return redacted;
  }

  /** The single redaction authority; adapters surface gateway text through it. */
  public readonly redactText = (text: string): string => this.redact(text);

  private buildSocketUrl():
    | { ok: true; url: string; protocols: ReadonlyArray<string> }
    | { ok: false; reason: string } {
    const token = this.resolveToken();
    if (token === undefined || token.length === 0) {
      // Name the variable, never the value.
      return {
        ok: false,
        reason: `pairing token environment variable '${this.options.tokenEnv}' is not set`,
      };
    }
    const url = new URL(this.options.url.toString());
    return {
      ok: true,
      url: url.toString(),
      protocols: ["dokkabi.rpc", `dokkabi.auth.${encodeURIComponent(token)}`],
    };
  }

  private dropSocket(reason: string): void {
    const socket = this.socket;
    const settle = this.settleSocketReady;
    this.socket = undefined;
    this.socketReady = undefined;
    this.settleSocketReady = undefined;
    const error = new WorkbenchTransportError({
      detail: this.redact(`${reason} — reconcile with workbench.commandStatus before any retry`),
    });
    // Root fix: a dropped connection can never leave its connect promise
    // pending. No-op when the connect already settled (open, or a previous
    // drop through another path).
    settle?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new WorkbenchTransportError({
          detail: this.redact(
            `${reason} — reconcile with workbench.commandStatus before any retry`,
          ),
        }),
      );
    }
    this.pending.clear();
    if (socket !== undefined) {
      try {
        socket.close(1000, "transport reset");
      } catch {
        // already closed
      }
    }
  }

  private ensureSocket(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new WorkbenchTransportError({ detail: "transport is closed" }));
    }
    if (this.socket !== undefined && this.socketReady !== undefined) {
      return this.socketReady;
    }
    const built = this.buildSocketUrl();
    if (!built.ok) {
      return Promise.reject(new WorkbenchTransportError({ detail: built.reason }));
    }
    const epoch = ++this.connectionEpoch;
    const factory =
      this.options.socketFactory ??
      ((url: string, protocols?: ReadonlyArray<string>) =>
        new WebSocket(url, protocols ? [...protocols] : undefined) as unknown as WorkbenchSocket);
    let socket: WorkbenchSocket;
    try {
      socket = factory(built.url, built.protocols);
    } catch (error) {
      return Promise.reject(
        new WorkbenchTransportError({
          detail: this.redact(`cannot open gateway socket: ${describe(error)}`),
        }),
      );
    }
    this.socket = socket;
    const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    // Bounded handshake deadline: a gateway that never completes the open
    // cannot hang a Send. The timer is a connection concern only — there is
    // no cap on any model/work runtime.
    let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      connectTimer = undefined;
      if (this.connectionEpoch === epoch && this.socket === socket) {
        this.dropSocket("gateway connection did not open in time");
      }
    }, connectTimeoutMs);
    const clearConnectTimer = () => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    const isCurrent = () => this.connectionEpoch === epoch && this.socket === socket;
    let connectSettled = false;
    this.socketReady = new Promise<void>((resolve, reject) => {
      this.settleSocketReady = (error) => {
        if (connectSettled) return;
        connectSettled = true;
        clearConnectTimer();
        if (error === undefined) resolve();
        else reject(error);
      };
    });
    // The connect promise may reject before any caller awaits it (timer,
    // close event); swallow that derived rejection so the process never sees
    // an unhandled one. Awaiting callers still observe the rejection.
    this.socketReady.catch(() => {});
    socket.addEventListener("open", () => {
      if (!isCurrent()) return;
      this.settleSocketReady?.(undefined);
    });
    socket.addEventListener("error", () => {
      if (!isCurrent()) return;
      this.settleSocketReady?.(
        new WorkbenchTransportError({ detail: "gateway socket connection failed" }),
      );
      this.dropSocket("gateway socket error during connect");
    });
    socket.addEventListener("close", () => {
      // Fenced by epoch: an obsolete connection's close leaves the
      // current one alone.
      if (!isCurrent()) return;
      this.settleSocketReady?.(
        new WorkbenchTransportError({ detail: "gateway socket closed before opening" }),
      );
      this.dropSocket("gateway connection closed");
    });
    socket.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      this.onFrame(event.data);
    });
    return this.socketReady;
  }

  private onFrame(data: unknown): void {
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    let frame: ReturnType<typeof decodeFrameOrNotification>;
    try {
      frame = decodeFrameOrNotification(raw);
    } catch {
      // Malformed frame: fail the pending request immediately and close —
      // an unterminated line must not hang any caller.
      this.dropSocket("gateway sent a malformed frame");
      return;
    }
    if (frame.kind === "notification") {
      // The shared gateway broadcasts to every surface (chat.opened,
      // terminal.output, …). The workbench client ignores them; a
      // notification never invokes anything here.
      return;
    }
    const response = frame.response;
    // A gateway error message can echo request context (including the
    // tokenized URL); redact before the message crosses the transport
    // boundary. Everything the app ever sees has passed through here.
    const safeResponse: JsonRpcResponse =
      response.error !== undefined
        ? {
            ...response,
            error: { ...response.error, message: this.redact(response.error.message) },
          }
        : response;
    const numericId = typeof response.id === "number" ? response.id : Number(response.id);
    const pending = this.pending.get(numericId);
    if (pending === undefined) return;
    this.pending.delete(numericId);
    clearTimeout(pending.timer);
    pending.resolve(safeResponse);
  }

  /** One JSON-RPC request/response round trip, serialized per transport. */
  public readonly request = (
    method: WorkbenchMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> => {
    // Client-side closed-schema validation: unknown keys, invalid ids and
    // unsupported shapes NEVER reach the wire, even though the gateway
    // validates again on its side. The failure names the issue, never the
    // payload (which is caller text, not a secret, but stays out of logs).
    const paramsCheck = validateRequestParams(method, params);
    if (!paramsCheck.ok) {
      return Promise.reject(
        new WorkbenchTransportError({
          detail: `${method} request invalid: ${paramsCheck.reason}`,
        }),
      );
    }
    // Only a disposable read (transcript or bounded explorer) may abandon
    // its wait: a queued one settles at once and never sends, an active one
    // releases its timer, listener and pending slot, and a late reply is
    // ignored. Writes keep their receipt and queue position even when their
    // caller is interrupted.
    const readSignal = isDisposableRead(method, params) ? signal : undefined;
    const interrupted = () =>
      new WorkbenchTransportError({ detail: `${method} read wait interrupted` });
    let abandoned = false;
    let abandonActive: (() => void) | undefined;
    const run = (): Promise<JsonRpcResponse> =>
      new Promise((resolve, reject) => {
        let id: number | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        const finish = (response: JsonRpcResponse | undefined, error?: unknown) => {
          if (finished) return;
          finished = true;
          abandonActive = undefined;
          if (id !== undefined) this.pending.delete(id);
          if (timer !== undefined) clearTimeout(timer);
          if (response !== undefined) resolve(response);
          else reject(error);
        };
        if (abandoned) {
          finish(undefined, interrupted());
          return;
        }
        if (readSignal !== undefined) abandonActive = () => finish(undefined, interrupted());
        void this.ensureSocket().then(
          () => {
            if (finished) return;
            id = this.nextId++;
            const requestId = id;
            const frame = encodeRequest(requestId, method, params);
            timer = setTimeout(
              () =>
                finish(
                  undefined,
                  new WorkbenchTransportError({
                    detail: `${method} timed out without a gateway response`,
                  }),
                ),
              this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            );
            this.pending.set(requestId, {
              id: requestId,
              timer,
              resolve: (response) => finish(response),
              reject: (error) => finish(undefined, error),
            });
            try {
              this.socket?.send(frame);
            } catch (error) {
              finish(
                undefined,
                new WorkbenchTransportError({
                  detail: this.redact(`${method} could not be sent: ${describe(error)}`),
                }),
              );
            }
          },
          (error) => finish(undefined, error),
        );
      });
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    if (readSignal === undefined) return next as Promise<JsonRpcResponse>;
    // One abort listener per disposable read, removed when it settles.
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      let listening = false;
      const detach = () => {
        if (!listening) return;
        listening = false;
        readSignal.removeEventListener("abort", abort);
      };
      function abort() {
        detach();
        abandoned = true;
        abandonActive?.();
        reject(interrupted());
      }
      if (readSignal.aborted) {
        abort();
        return;
      }
      listening = true;
      readSignal.addEventListener("abort", abort);
      next.then(
        (response) => {
          detach();
          resolve(response);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
    });
  };

  public close(): void {
    this.closed = true;
    this.dropSocket("transport closed");
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isWorkbenchTransportError = Schema.is(WorkbenchTransportError);

export const workbenchRequest = (
  transport: WorkbenchTransport,
  method: WorkbenchMethod,
  params: unknown,
  interruptibleRead = false,
) =>
  Effect.tryPromise({
    try: (signal) => transport.request(method, params, interruptibleRead ? signal : undefined),
    catch: (error) =>
      isWorkbenchTransportError(error)
        ? error
        : new WorkbenchTransportError({
            detail: describe(error),
          }),
  });

/** Reads whose wait may be abandoned: the background transcript read and
 * the pure bounded explorer reads, direct or inside a validated branch
 * envelope. Params were already checked against the closed protocol before
 * admission. */
const DISPOSABLE_READ_METHODS: ReadonlySet<string> = new Set([
  "workbench.read",
  "workbench.record.index",
  "workbench.record.body",
  "workbench.graph.explore",
]);
const isDisposableRead = (method: WorkbenchMethod, params: unknown): boolean =>
  DISPOSABLE_READ_METHODS.has(method) ||
  (method === "workbench.branchSession" &&
    DISPOSABLE_READ_METHODS.has((params as { readonly method: string }).method));

/** Validate a configured tokenEnv name (never its value). A name that does
 * not even look like an identifier is NEVER echoed — an operator who pasted
 * the token itself into the name field must not have it bounced back into
 * logs or error surfaces. */
export function validateTokenEnvName(name: string): { ok: true } | { ok: false; reason: string } {
  if (name.length === 0) return { ok: false, reason: "token environment variable name is empty" };
  if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
    // Only obviously-benign identifier typos are echoed back. Dots are
    // excluded on purpose: pasted tokens (JWT-style and friends) commonly
    // contain them and must never be bounced into logs or error surfaces.
    const echoable = name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name);
    return {
      ok: false,
      reason: echoable
        ? `token environment variable name '${name}' is not a valid variable name`
        : "token environment variable name is not a valid variable name (invalid characters or too long; value withheld)",
    };
  }
  return { ok: true };
}

const formatParamsIssue = SchemaIssue.makeFormatterDefault();
type ParamsIssue = Parameters<typeof formatParamsIssue>[0];

/** Closed-schema validation of one outbound request's params. The formatted
 * issue carries field paths and expected-vs-actual shapes; it is length-capped
 * so a pathological payload cannot flood logs. Request params never carry the
 * pairing token, so the detail cannot leak it. */
function validateRequestParams(
  method: WorkbenchMethod,
  params: unknown,
): { ok: true } | { ok: false; reason: string } {
  const schema = workbenchParamsSchemas[method];
  try {
    Schema.decodeUnknownSync(schema, STRICT_DECODE_OPTIONS)(params);
    return { ok: true };
  } catch (error) {
    const issue = (error as { issue?: ParamsIssue }).issue;
    const detail =
      issue === undefined || issue === null
        ? ""
        : `: ${JSON.stringify(formatParamsIssue(issue))}`.slice(0, 300);
    return {
      ok: false,
      reason: `params did not match the closed v1 ${method} request schema${detail}`,
    };
  }
}
