import type { Api, Model } from "@earendil-works/pi-ai";
import type { LlmRoute } from "../loader/types.ts";

/**
 * Stored is not connected.
 *
 * `dokkabi login` printed `[connected]` the moment the provider library
 * accepted a credential, and `dokkabi status` agreed, and the route still
 * could not answer. What had actually been stored was the harness's own
 * refusal text — "credential values are never accepted as arguments" — pasted
 * back into the prompt after `--api-key <value>` was rejected. Eighty-seven
 * characters with spaces in them, and both surfaces called it connected.
 *
 * Nothing about the value's shape would have caught that reliably; providers
 * differ and a shape rule is a guess. What settles it is asking the provider.
 * One minimal request costs a second, and a route that answers it is a route
 * that will answer the run.
 *
 * The alternative is finding out on the first turn of a fortnight-long run.
 */

export interface CredentialCheck {
  readonly ok: boolean;
  /** What the provider said, bounded and already safe to print. */
  readonly detail?: string;
}

/** The smallest question a provider can be asked. */
const PROBE_PROMPT = "ok";

export async function verifyRouteCredential(
  route: LlmRoute,
  modelId?: string,
  timeoutMs = 30_000,
): Promise<CredentialCheck> {
  let model: Model<Api>;
  try {
    model = await route.resolveModel(modelId) as Model<Api>;
  } catch (error) {
    return { ok: false, detail: shortReason(error) };
  }

  try {
    // One token is enough: the question is whether the credential is accepted,
    // not what the model has to say. Draining the stream is what forces the
    // request — a stream that is created and dropped never reaches the wire.
    const stream = (route.streamCredentialProbe ? route.streamCredentialProbe(model, timeoutMs) : route.stream(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: PROBE_PROMPT }] }] },
      { maxOutputTokens: 1, timeoutMs },
    )) as AsyncIterable<Record<string, unknown>>;
    // Drain it. Stopping at the first event was the whole bug in the first
    // cut of this: a route emits a "start" before it has spoken to anyone, so
    // breaking there reported a refused credential as connected. One token
    // makes the full drain cheap, and a rejection arrives either as a throw or
    // as an error event partway through.
    let refusal: string | undefined;
    for await (const event of stream) {
      const kind = String(event?.type ?? "");
      if (kind === "error") {
        // The stream's own shape: { type: "error", reason, error }. `reason`
        // is the short classification and `error` the provider's words; the
        // classification alone is what an operator can act on.
        // `error` is the assistant message the turn died on, and the words
        // that matter sit in its errorMessage; `reason` alone is the string
        // "error", which tells an operator nothing.
        const failed = event.error as { errorMessage?: unknown } | undefined;
        refusal = shortReason(failed?.errorMessage ?? event.reason ?? "stream reported an error");
        break;
      }
      const stop = (event as { message?: { stopReason?: unknown; errorMessage?: unknown } }).message;
      if (stop && (stop.stopReason === "error" || stop.stopReason === "aborted")) {
        refusal = shortReason(stop.errorMessage ?? `model stop=${String(stop.stopReason)}`);
        break;
      }
    }
    return refusal === undefined ? { ok: true } : { ok: false, detail: refusal };
  } catch (error) {
    return { ok: false, detail: shortReason(error) };
  }
}

/** The readable part of an error object, wherever the provider put it. */
function messageFrom(value: Record<string, unknown>): string {
  for (const key of ["errorMessage", "reason", "message", "error", "detail", "code"]) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) return found;
    if (typeof found === "object" && found !== null) {
      const nested = messageFrom(found as Record<string, unknown>);
      if (nested && nested !== "no detail") return nested;
    }
  }
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") return json;
  } catch {
    // circular or unserialisable: fall through
  }
  return "no detail";
}

/**
 * A provider's complaint, trimmed to one line and capped.
 *
 * Providers echo request bodies into their errors, and a body can carry the
 * credential that was just refused. One line and 200 characters is enough to
 * tell "token expired or incorrect" from "model not found", which is the whole
 * job here.
 */
function shortReason(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    // A provider's error arrives as an object as often as an Error, and
    // String() on one is "[object Object]" — which told an operator nothing
    // about a credential that had just been refused.
    : typeof error === "object" && error !== null
      ? messageFrom(error as Record<string, unknown>)
      : String(error);
  const line = raw.split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line || "no detail";
}
