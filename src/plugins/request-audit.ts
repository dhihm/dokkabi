import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Api, type AssistantMessage, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { deriveCodexContinuation, providerHttpPayload, providerRequestUrl } from "./provider-representation.ts";
import type { EventLog } from "../host/event-log.ts";
import { canonicalJson } from "../host/canonical.ts";
import { containsSecret, redactText, stripTerminalControls } from "../host/redact.ts";
import { assertProviderRequestGuards } from "../host/provider-request-guard.ts";
import { appendProviderBody, consumeProviderInput, inputData, inputDigest, inputReference, liveProviderInputs,
  providerContext, providerModel, providerOptions, reloadProviderInputs,
  requireProviderInput, assertProviderSeal, ProviderInputError, observeProviderInputRefusal, type InputReference, type LiveProviderInputs, type ProviderInputRecord } from "../host/provider-input.ts";

/** This registry certifies representation boundaries, not remote inference.
 * Adapters without an injectable HTTP or observed WebSocket send refuse. */
export const AUDITED_PROVIDER_APIS = new Set([
  "openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages",
]);
interface RequestAudit {
  log: EventLog;
  request: ProviderInputRecord;
  model: Model<Api>;
  originalModel: unknown;
  originalContext: unknown;
  originalOptions: unknown;
  payload?: Record<string, unknown>;
  payloadRef?: InputReference;
  response?: AssistantMessage;
  responseRef?: InputReference;
  lastSend?: InputReference;
  refusal?: ProviderInputError;
}
const scope = new AsyncLocalStorage<RequestAudit>();
const sockets = new WeakMap<WebSocket, RequestAudit>();
const originalFetch = globalThis.fetch;
let installedSend: typeof WebSocket.prototype.send | undefined;

function object(value: unknown): Record<string, unknown> {
  requireProviderInput(value !== null && typeof value === "object" && !Array.isArray(value), "adapter payload is not an object");
  return value as Record<string, unknown>;
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function assertCurrent(audit: RequestAudit): LiveProviderInputs {
  if (audit.refusal) throw audit.refusal;
  assertProviderRequestGuards(audit.log, audit.request);
  audit.log.assertCanRequestModel();
  assertProviderSeal(audit.log, audit.request.context);
  requireProviderInput(inputDigest(providerContext(audit.originalContext)) === audit.request.contextDigest
    && same(providerModel(audit.originalModel), audit.request.model)
    && same(providerOptions(audit.originalOptions), audit.request.options), "input changed before actual send");
  const { projection, messagesDigest } = liveProviderInputs(audit.log);
  requireProviderInput(projection.request(audit.request.ref) !== undefined, "send request receipt was lost");
  // The request's context is the projection's own, never-mutated transcript
  // array while no transcript row has been appended since the admission.
  requireProviderInput(projection.state.ref && !projection.state.pending
    && (projection.state.messages === audit.request.context.messages
      || messagesDigest === inputDigest(audit.request.context.messages)), "send transcript state changed");
  requireProviderInput(audit.payload && audit.payloadRef, "send occurred before adapter payload observation");
  return projection;
}

function recordSend(audit: RequestAudit, transport: string, bytes: Uint8Array,
  decoded: unknown, transformation: Record<string, unknown>): void {
  const projection = assertCurrent(audit);
  const ordinal = projection.sendCount + 1;
  let sampleAudit: Record<string, unknown> | undefined;
  if (ordinal % 20 === 0) {
    // The durable reload stays whole on purpose (D44): the log and every
    // stored byte its rows name are re-read from disk and re-verified, so a
    // body damaged after an earlier reload is caught here. It reads, checks
    // and drops one body at a time (D51): it never holds the session's bodies
    // at once. A body stored as parts (D53) is checked file by file, each
    // unique part once, so the pass reads the session's unique bytes, once
    // per twenty sends; the live projection above reads each body once.
    const reconstructed = reloadProviderInputs(audit.log);
    const request = reconstructed.request(audit.request.ref);
    requireProviderInput(request && request.contextDigest === audit.request.contextDigest
      && reconstructed.sendCount + 1 === ordinal, "sampled durable reload differs");
    sampleAudit = { source: "durable-log-reload", source_head: reconstructed.head,
      context_digest: request.contextDigest, payload_digest: inputDigest(audit.payload) };
  }
  const event = appendProviderBody(audit.log, "provider/send", {
    version: 1, request: audit.request.ref, payload: audit.payloadRef, context_digest: audit.request.contextDigest,
    ordinal, sample_denominator: 20, sample_selected: ordinal % 20 === 0,
    ...(sampleAudit ? { sample_audit: sampleAudit } : {}),
    transport, encoded_body: Buffer.from(bytes).toString("base64"), encoded_bytes: bytes.byteLength,
    encoded_digest: createHash("sha256").update(bytes).digest("hex"), decoded_body: decoded,
    transformation, observation: "before_transport_dispatch",
  }, () => {
    const latest = assertCurrent(audit);
    requireProviderInput(latest.sendCount + 1 === ordinal,
      "concurrent send ordinal changed");
  });
  audit.lastSend = inputReference(event);
}

function auditedFetch(audit: RequestAudit): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    try {
    assertCurrent(audit);
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requireProviderInput(request.method === "POST", "unsupported provider HTTP method");
    const url = new URL(request.url), expected = providerRequestUrl(audit.model.api, audit.model.baseUrl);
    requireProviderInput(url.origin === expected.origin && url.pathname === expected.pathname
      && !url.username && !url.password, "provider destination changed");
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const encoding = request.headers.get("content-encoding") ?? "identity";
    requireProviderInput(encoding === "identity" || encoding === "zstd", "unsupported request body encoding");
    const decodedBytes = encoding === "zstd" ? zstdDecompressSync(bytes) : bytes;
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes)); }
    catch { throw new ProviderInputError("provider body is not exact UTF-8 JSON"); }
    requireProviderInput(same(decoded, providerHttpPayload(audit.model.api, audit.payload!)), "HTTP body differs after adapter hook");
    recordSend(audit, "http", bytes, decoded, { kind: audit.model.api === "anthropic-messages" ? "anthropic-stream" : "identity", encoding });
    // No await or mutable callback occurs between the durable receipt and dispatch.
    const response = await originalFetch(request, { redirect: "manual" });
    requireProviderInput(response.status < 300 || response.status >= 400, "provider redirects are not admitted");
    return response;
    } catch (error) {
      if (error instanceof ProviderInputError) audit.refusal = observeProviderInputRefusal(audit.log, error, "http_send") as ProviderInputError;
      throw error;
    }
  }) as typeof fetch;
}

/** One process-wide plugin observer; request authority is async-local and
 * socket continuation is per physical socket. This also covers constructors
 * cached by the pinned Pi adapter before a later request. Unrelated sockets
 * outside an admitted provider scope retain their original behavior. */
function installWebSocketSendObserver(): void {
  requireProviderInput(typeof globalThis.WebSocket === "function", "WebSocket transport is unavailable");
  if (installedSend) {
    requireProviderInput(WebSocket.prototype.send === installedSend, "WebSocket send observer was replaced");
    return;
  }
  const original = WebSocket.prototype.send;
  const wrapped: typeof original = function (this: WebSocket, data) {
    const audit = scope.getStore();
    if (!audit) return original.call(this, data);
    try {
    assertCurrent(audit);
    requireProviderInput(audit.model.api === "openai-codex-responses", "unsupported provider WebSocket protocol");
    requireProviderInput(typeof data === "string", "unsupported WebSocket frame representation");
    const url = new URL(this.url), expected = providerRequestUrl(audit.model.api, audit.model.baseUrl, true);
    requireProviderInput(url.href === expected.href, "provider WebSocket destination changed");
    const actual = object(JSON.parse(data)), full = audit.payload!;
    const { type, ...body } = actual;
    requireProviderInput(type === "response.create", "unsupported provider WebSocket frame");
    const previous = sockets.get(this);
    let transformation: Record<string, unknown> = { kind: "codex-full" };
    if (!same(body, full)) {
      requireProviderInput(previous?.log === audit.log, "cached WebSocket has no same-log predecessor");
      const delta = previous.response && previous.responseRef && previous.payload
        ? deriveCodexContinuation({ model: previous.request.model, tools: previous.request.context.tools,
          payload: previous.payload, assistant: previous.response }, full) : undefined;
      requireProviderInput(delta && same(body, delta), "WebSocket body differs after adapter hook");
      transformation = { kind: "codex-cache-delta", previous_request: previous.request.ref,
        previous_response: previous.responseRef, previous_send: previous.lastSend };
    }
    recordSend(audit, "websocket", new TextEncoder().encode(data), actual, transformation);
    sockets.set(this, audit);
    return original.call(this, data);
    } catch (error) {
      if (error instanceof ProviderInputError) audit.refusal = observeProviderInputRefusal(audit.log, error, "websocket_send") as ProviderInputError;
      throw error;
    }
  };
  WebSocket.prototype.send = wrapped;
  installedSend = wrapped;
}

/** Consume a host admission, observe the actual pinned adapter and protect every
 * transport attempt. The caller's custom payload/fetch callbacks have no authority. */
export function streamWithRequestAudit(log: EventLog, model: Model<Api>, context: unknown,
  options: SimpleStreamOptions | undefined,
  stream: (model: Model<Api>, context: unknown, options: SimpleStreamOptions) => AssistantMessageEventStream): AssistantMessageEventStream {
  try {
  const request = consumeProviderInput(log, model, context, options);
  requireProviderInput(AUDITED_PROVIDER_APIS.has(model.api), `unsupported adapter boundary: ${model.api}`);
  requireProviderInput(!options?.onPayload && !options?.fetch, "unadmitted payload or fetch callback");
  if (model.api === "openai-codex-responses" && options?.transport !== "sse") installWebSocketSendObserver();
  const audit: RequestAudit = { log, request, model, originalModel: model, originalContext: context, originalOptions: options };
  const bounded: SimpleStreamOptions = {
    ...options,
    fetch: auditedFetch(audit),
    onPayload: (payload) => {
      try {
      const data = object(inputData(payload));
      const event = appendProviderBody(log, "provider/payload", { version: 1, request: request.ref,
        context_digest: request.contextDigest, adapter: model.api, payload: data });
      audit.payload = data;
      audit.payloadRef = inputReference(event);
      return freeze(inputData(data));
      } catch (error) {
        if (error instanceof ProviderInputError) audit.refusal = observeProviderInputRefusal(log, error, "adapter_payload") as ProviderInputError;
        throw error;
      }
    },
  };
  const result = createAssistantMessageEventStream();
  scope.run(audit, () => {
    void (async () => {
      try {
        const incoming = stream(model, context, bounded);
        for await (const original of incoming) {
          const event = original.type === "error" && audit.refusal
            ? { ...original, error: { ...original.error, errorMessage: audit.refusal.message } } : original;
          if (event.type === "done" || event.type === "error") {
            const assistant = event.type === "done" ? event.message : event.error;
            const observed = appendProviderBody(log, "provider/response", { version: 1,
              request: request.ref, send: audit.lastSend ?? null, assistant });
            audit.response = inputData(assistant) as AssistantMessage;
            audit.responseRef = inputReference(observed);
          }
          result.push(event);
        }
        result.end();
      } catch (error) {
        observeProviderInputRefusal(log, error, "adapter_stream");
        const detail = redactText(stripTerminalControls(error instanceof Error ? error.message : "adapter execution failed"));
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api,
          provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          errorMessage: containsSecret(detail) ? "[redacted adapter failure]" : detail.slice(0, 480) };
        result.push({ type: "error", reason: "error", error: message });
        result.end();
      }
    })();
  });
  return result;
  } catch (error) { throw observeProviderInputRefusal(log, error, "request_audit"); }
}
