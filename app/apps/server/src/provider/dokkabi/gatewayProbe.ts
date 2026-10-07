/**
 * One-shot authenticated gateway discovery probe.
 *
 * The driver uses this to learn the ACTUAL configured route/model before any
 * session exists: `workbench.handshake` only reads the harness's saved
 * selection (or the open kernel's live identity) — it never binds, boots a
 * kernel, stages a note or invokes a model. There is no discovery thread.
 *
 * Every failure is classified, never thrown: a down gateway, a missing token
 * variable or an invalid configuration becomes an honest error snapshot
 * instead of a failed driver instantiation. Surfaced reasons pass the
 * transport's redaction choke point and never contain the token.
 *
 * @module provider/dokkabi/gatewayProbe
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  decodeResult,
  HandshakeResponse,
  WORKBENCH_PROTOCOL_VERSION,
  type HandshakeResponse as HandshakeResult,
} from "./WorkbenchProtocol.ts";
import {
  validateGatewayUrl,
  validateTokenEnvName,
  workbenchRequest,
  WorkbenchTransport,
  type WorkbenchSocket,
} from "./WorkbenchTransport.ts";

export interface DokkabiGatewayProbeInput {
  readonly gatewayUrl: string;
  readonly tokenEnv: string;
  /** Environment read at call time; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Bound on the WHOLE probe (connect + handshake round trip). */
  readonly timeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Test seam; production uses the global WebSocket. */
  readonly socketFactory?: (url: string, protocols?: ReadonlyArray<string>) => WorkbenchSocket;
}

export type DokkabiGatewayProbeFailureKind =
  | "config"
  | "unauthenticated"
  | "unreachable"
  | "protocol";

export type DokkabiGatewayProbeResult =
  | { readonly ok: true; readonly identity: HandshakeResult }
  | {
      readonly ok: false;
      readonly kind: DokkabiGatewayProbeFailureKind;
      readonly reason: string;
    };

const DEFAULT_PROBE_TIMEOUT_MS = 12_000;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const classifyTransportFailure = (
  detail: string,
): {
  readonly ok: false;
  readonly kind: DokkabiGatewayProbeFailureKind;
  readonly reason: string;
} =>
  detail.includes("pairing token environment variable")
    ? { ok: false, kind: "unauthenticated", reason: detail }
    : { ok: false, kind: "unreachable", reason: detail };

/**
 * Probe the gateway once. The transport is always closed afterwards — a
 * probe never leaves a connection (and never holds a binding) behind.
 */
export const probeDokkabiGateway = (
  input: DokkabiGatewayProbeInput,
): Effect.Effect<DokkabiGatewayProbeResult, never> =>
  Effect.gen(function* () {
    const urlCheck = validateGatewayUrl(input.gatewayUrl);
    if (!urlCheck.ok) {
      return { ok: false, kind: "config", reason: urlCheck.reason };
    }
    const tokenEnvCheck = validateTokenEnvName(input.tokenEnv);
    if (!tokenEnvCheck.ok) {
      return { ok: false, kind: "config", reason: tokenEnvCheck.reason };
    }
    const transport = new WorkbenchTransport({
      url: urlCheck.url,
      tokenEnv: input.tokenEnv,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.connectTimeoutMs !== undefined ? { connectTimeoutMs: input.connectTimeoutMs } : {}),
      ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
      ...(input.socketFactory !== undefined ? { socketFactory: input.socketFactory } : {}),
    });
    const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    return yield* workbenchRequest(transport, "workbench.handshake", {
      version: WORKBENCH_PROTOCOL_VERSION,
    }).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((reply) =>
        Option.match(reply, {
          onNone: () =>
            Effect.succeed({
              ok: false as const,
              kind: "unreachable" as const,
              reason: `gateway handshake probe timed out after ${timeoutMs}ms`,
            }),
          onSome: (response) =>
            response.error !== undefined
              ? Effect.succeed({
                  ok: false as const,
                  kind: "protocol" as const,
                  reason: transport.redactText(response.error.message),
                })
              : decodeResult({
                  method: "workbench.handshake",
                  schema: HandshakeResponse,
                  result: response.result,
                }).pipe(
                  Effect.map((identity): DokkabiGatewayProbeResult => ({ ok: true, identity })),
                  Effect.catch((error): Effect.Effect<DokkabiGatewayProbeResult, never> =>
                    Effect.succeed({
                      ok: false as const,
                      kind: "protocol" as const,
                      reason: transport.redactText(describe(error)),
                    }),
                  ),
                ),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(classifyTransportFailure(transport.redactText(describe(error)))),
      ),
      Effect.ensuring(Effect.sync(() => transport.close())),
    );
  });
