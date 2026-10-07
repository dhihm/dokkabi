/**
 * Dokkabi harness ProviderDriver.
 *
 * Explicit, opt-in and disabled by default: an instance exists only when
 * the operator configures an external loopback gateway or explicitly opts
 * into the bundled harness for an absolute workspace path. The token value is
 * resolved server-side only. `supportsMultipleInstances` is false — the
 * gateway owns ONE recorded workspace session.
 *
 * Discovery is the authenticated `workbench.handshake` ONLY: the snapshot
 * advertises the harness's actual configured route/model and optional
 * route-qualified catalog (an explicit
 * unprobed identity before the kernel opens — no bind, no boot, no model
 * call, no invented discovery thread), so the operator can pick the real
 * model BEFORE the first thread. An unconfigured or disabled instance
 * instantiates safely as a disabled/error snapshot without ever opening a
 * socket; a configured instance whose gateway is down instantiates as an
 * error snapshot too — driver creation never fails.
 *
 * Text generation REFUSES by design: every Dokkabi model input is an
 * explicit operator submit through the harness's recorded model-input
 * contract, so no background commit/PR/branch/title generation exists that
 * could create a hidden harness turn.
 *
 * @module provider/Drivers/DokkabiDriver
 */
import {
  DokkabiSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { acquireBundledGateway } from "../dokkabi/BundledGateway.ts";

import { makeDokkabiAdapter } from "../Layers/DokkabiAdapter.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { probeDokkabiGateway, type DokkabiGatewayProbeResult } from "../dokkabi/gatewayProbe.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("dokkabi");
const decodeDokkabiSettings = Schema.decodeSync(DokkabiSettings);

export type DokkabiDriverEnv = Crypto.Crypto;

/**
 * Use the authenticated harness catalog when live selection is supported.
 * Keep the current bare slug for saved threads and legacy peers. Connection
 * state describes credentials only; catalog membership is not readiness.
 */
export function dokkabiModelsFromHandshake(
  model: string | undefined,
  catalog: readonly {
    route: string;
    provider: string;
    model: string;
    name: string;
    connected: boolean;
  }[] = [],
  route?: string,
): ServerProviderModel[] {
  const legacy: ServerProviderModel[] =
    model === undefined || model.trim().length === 0
      ? []
      : [
          {
            slug: model,
            name: model,
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ];
  const seen = new Set<string>();
  return [
    ...legacy,
    ...catalog.flatMap((entry) => {
      const slug = `${entry.route}/${entry.model}`;
      if (seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: `${entry.route} · ${entry.name}${entry.connected ? "" : " (sign in required)"}`,
          isCustom: false,
          isDefault: legacy.length === 0 && entry.route === route && entry.model === model,
          capabilities: null,
        },
      ];
    }),
  ];
}

/** Refusing text generation: no hidden harness model input, ever. */
const makeRefusingTextGeneration = () =>
  TextGeneration.of({
    generateCommitMessage: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateCommitMessage",
          detail: "The Dokkabi harness owns model input; commit-message generation is unavailable.",
        }),
      ),
    generatePrContent: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generatePrContent",
          detail: "The Dokkabi harness owns model input; PR-content generation is unavailable.",
        }),
      ),
    generateBranchName: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "The Dokkabi harness owns model input; branch-name generation is unavailable.",
        }),
      ),
    generateThreadTitle: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "The Dokkabi harness owns model input; thread-title generation is unavailable.",
        }),
      ),
  });

export const DokkabiDriver: ProviderDriver<DokkabiSettings, DokkabiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Dokkabi",
    compatibilityAuthority: "protocol",
    // The gateway owns one recorded workspace session; a second instance
    // would be a competing authority over the same workspace.
    supportsMultipleInstances: false,
  },
  configSchema: DokkabiSettings,
  defaultConfig: (): DokkabiSettings => decodeDokkabiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      void environment;
      let effectiveConfig = {
        ...config,
        // The registry already resolves explicit disables and schema defaults.
        // Normalized instance config omits its legacy enabled field.
        enabled,
      } satisfies DokkabiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      // Selecting the bundled runtime never authorizes an external fallback.
      // Preserve saved settings, but exclude external pairing from this adapter
      // even if bundled startup fails before a private endpoint is acquired.
      if (effectiveConfig.runtimeMode === "bundled") {
        effectiveConfig = { ...effectiveConfig, gatewayUrl: "", tokenEnv: "" };
      }

      let startupFailure: string | undefined;
      const bundled =
        effectiveConfig.enabled && effectiveConfig.runtimeMode === "bundled"
          ? yield* acquireBundledGateway({
              resourceRoot: process.env.DOKKABI_BUNDLED_RUNTIME ?? "",
              workspace: effectiveConfig.workspacePath,
              ownerKey: String(instanceId),
            }).pipe(
              Effect.catch((error) => {
                startupFailure = error.message;
                return Effect.void;
              }),
            )
          : undefined;
      if (bundled !== undefined) {
        effectiveConfig = {
          ...effectiveConfig,
          gatewayUrl: bundled.gatewayUrl,
          tokenEnv: bundled.tokenEnv,
        };
      }

      const configured =
        startupFailure === undefined &&
        effectiveConfig.enabled &&
        effectiveConfig.gatewayUrl.length > 0 &&
        effectiveConfig.tokenEnv.length > 0 &&
        effectiveConfig.workspacePath.length > 0;

      // The adapter itself is always constructible: URL/token validation is
      // a session-time gate, so a disabled or half-configured default
      // instance never fails registry creation and never opens a socket.
      const adapter = yield* makeDokkabiAdapter({
        enabled: effectiveConfig.enabled,
        gatewayUrl: effectiveConfig.gatewayUrl,
        tokenEnv: effectiveConfig.tokenEnv,
        ...(bundled !== undefined ? { env: bundled.credentialEnvironment } : {}),
        workspacePath: effectiveConfig.workspacePath,
        instanceId,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Dokkabi adapter: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        ),
      );

      const changes = yield* Queue.unbounded<ServerProvider>();
      const scope = yield* Effect.scope;

      const stampSnapshot = (fields: {
        readonly status: ServerProvider["status"];
        readonly modelReadiness?: ServerProvider["modelReadiness"];
        readonly message?: string;
        readonly authStatus: ServerProvider["auth"]["status"];
        readonly models?: ReadonlyArray<ServerProviderModel>;
      }): Effect.Effect<ServerProvider> =>
        DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.map((checkedAt) =>
            stampIdentity({
              enabled: effectiveConfig.enabled,
              installed: configured,
              version: null,
              status: fields.status,
              ...(fields.modelReadiness !== undefined
                ? { modelReadiness: fields.modelReadiness }
                : {}),
              auth: { status: fields.authStatus, type: "gateway-token" },
              checkedAt,
              ...(fields.message !== undefined ? { message: fields.message } : {}),
              models: fields.models ?? [],
              slashCommands: [],
              skills: [],
            }),
          ),
        );

      const snapshotFromProbe = (
        probe: DokkabiGatewayProbeResult,
      ): Effect.Effect<ServerProvider> => {
        if (!probe.ok) {
          return stampSnapshot({
            status: "error",
            message: probe.reason,
            authStatus: probe.kind === "unauthenticated" ? "unauthenticated" : "unknown",
          });
        }
        const identity = probe.identity;
        const models = dokkabiModelsFromHandshake(
          identity.model,
          identity.capabilities.modelChange ? identity.models : undefined,
          identity.route,
        );
        // The harness's permission policy is authoritative and never
        // app-selected: R2 supports an explicit bypass workspace only, and a
        // mismatch is visible BEFORE any bind attempt.
        if (identity.permissionMode !== "bypass") {
          return stampSnapshot({
            status: "warning",
            message:
              `The gateway workspace runs permission mode '${identity.permissionMode}'. ` +
              "This app supports explicit full-access (bypass) harness workspaces only; " +
              "switch the harness's default permission mode before starting a thread.",
            authStatus: "authenticated",
            models,
          });
        }
        if (!identity.ready) {
          const unprobed = identity.routeSource === "configured" && identity.kernelOpen === false;
          return stampSnapshot({
            status: "warning",
            modelReadiness: unprobed ? "unprobed" : "unavailable",
            message: unprobed
              ? "Model availability will be checked when the conversation connects."
              : (identity.reason ?? "The selected model is unavailable."),
            authStatus: "authenticated",
            models,
          });
        }
        return stampSnapshot({
          status: "ready",
          modelReadiness: "ready",
          authStatus: "authenticated",
          models,
        });
      };

      const probeGateway = () =>
        Effect.suspend(() => {
          const failure = bundled?.failure();
          return failure !== undefined
            ? Effect.succeed({ ok: false as const, kind: "unreachable" as const, reason: failure })
            : probeDokkabiGateway({
                gatewayUrl: effectiveConfig.gatewayUrl,
                tokenEnv: effectiveConfig.tokenEnv,
                ...(bundled !== undefined ? { env: bundled.credentialEnvironment } : {}),
              });
        });

      let current: ServerProvider;
      if (!effectiveConfig.enabled) {
        current = yield* stampSnapshot({ status: "disabled", authStatus: "unauthenticated" });
      } else if (!configured) {
        current = yield* stampSnapshot({
          status: "error",
          message:
            startupFailure ??
            "Dokkabi needs a loopback gateway URL, a token environment variable name and the gateway workspace path.",
          authStatus: "unauthenticated",
        });
      } else {
        // Discovery: one authenticated handshake. No bind, no kernel boot,
        // no model call — the identity is the operator's saved harness
        // selection (or the open kernel's live identity), never invented.
        current = yield* probeGateway().pipe(Effect.flatMap(snapshotFromProbe));
      }

      const publish = (next: ServerProvider): Effect.Effect<ServerProvider> =>
        Effect.gen(function* () {
          const failure = bundled?.failure();
          current =
            failure === undefined
              ? next
              : yield* stampSnapshot({
                  status: "error",
                  authStatus: "unknown",
                  message: failure,
                });
          yield* Queue.offer(changes, current);
          return current;
        }).pipe(Effect.uninterruptible);

      if (bundled !== undefined) {
        yield* Effect.promise(() => bundled.exited).pipe(
          Effect.flatMap(() =>
            stampSnapshot({
              status: "error",
              authStatus: "unknown",
              message: bundled.failure() ?? "The bundled Dokkabi gateway stopped.",
            }),
          ),
          Effect.flatMap(publish),
          Effect.forkIn(scope, { uninterruptible: false }),
        );
      }

      // Serialize the probe itself, not just publication: an older response
      // must never overwrite a newer lifecycle observation.
      const refreshGate = yield* Semaphore.make(1);
      const refresh = configured
        ? refreshGate.withPermits(1)(
            probeGateway().pipe(Effect.flatMap(snapshotFromProbe), Effect.flatMap(publish)),
          )
        : Effect.sync(() => current);
      const refreshAfterOperation = <A, E>(operation: Effect.Effect<A, E>) =>
        operation.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
              ? Effect.void
              : refresh.pipe(
                  // A diagnostic must never delay or replace an actual result.
                  // Defects keep the last observation and emit a sanitized log.
                  Effect.catchDefect(() =>
                    Effect.logError("Dokkabi provider readiness refresh failed."),
                  ),
                  Effect.forkIn(scope, { uninterruptible: false }),
                  Effect.asVoid,
                ),
          ),
        );

      const snapshotShape: ServerProviderShape = {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          ),
        // Deferred view of CURRENT state — never a construction-time copy.
        getSnapshot: Effect.sync(() => current),
        refresh,
        streamChanges: Stream.fromQueue(changes),
        applyUsageLimits: () => Effect.void,
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: effectiveConfig.enabled,
        snapshot: snapshotShape,
        adapter: {
          ...adapter,
          // Always probe the configured parent endpoint, including child binds.
          // Refresh never binds or submits; interruption remains interruptible.
          startSession: (input) => refreshAfterOperation(adapter.startSession(input)),
          sendTurn: (input) => refreshAfterOperation(adapter.sendTurn(input)),
        },
        textGeneration: makeRefusingTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
