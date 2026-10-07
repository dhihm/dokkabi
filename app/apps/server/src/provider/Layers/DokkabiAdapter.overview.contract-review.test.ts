/**
 * R3 recorded-overview adapter tests (docs/internals/dokkabi-overview-r3.md):
 * the authenticated thread routes through its persisted provider instance and
 * the gateway's own binding; foreign instance/thread/source identities fail
 * closed; a replaced generation fails closed even when the response claims
 * resnapshot; unavailable or unsupported capabilities never become empty
 * success or trigger writer recovery; unsupported is reserved for the
 * documented missing method; an overview poll never advances the transcript
 * resume cursors.
 *
 * @module provider/Layers/DokkabiAdapter.overview.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";

import { ProviderInstanceId, type ProviderWorkbenchOverview, ThreadId } from "@t3tools/contracts";

import { makeDokkabiAdapter, type DokkabiAdapterError } from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { FakeGateway, emptyOverview } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-overview-1");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-test";

process.env.DOKKABI_TEST_TOKEN = "non-secret-test-fixture";

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

interface Bundle {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly gateway: FakeGateway;
}

const setup = (
  gateway: FakeGateway = new FakeGateway(),
): Effect.Effect<Bundle, DokkabiAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4174",
        tokenEnv: "DOKKABI_TEST_TOKEN",
        workspacePath: gateway.workspacePath,
        instanceId: INSTANCE_ID,
      },
      {
        clientId: CLIENT_ID,
        pollIntervalMs: 40,
        cancelSettlementWaitMs: 200,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore));
    return { adapter, gateway };
  });

describe("independent recorded overview continuity", () => {
  it.live("refuses a divergent gateway hash at the persisted sequence", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
      const { adapter } = yield* setup(gateway);
      const persisted = {
        binding: gateway.binding,
        sessionId: gateway.sessionId,
        gatewayCursor: {
          seq: 1,
          hash: hex64("gateway-1"),
          generation: hex64("gateway-generation"),
        },
      };
      gateway.setOverview({
        ...emptyOverview(),
        gatewayCursor: {
          seq: 1,
          hash: hex64("divergent-ledger-row"),
          generation: hex64("gateway-generation"),
        },
      });
      const result = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, persisted));
      expect(Exit.isFailure(result)).toBe(true);
      expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
    }),
  );
  it.live("refuses measured tokens when no usage records exist", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
      const { adapter } = yield* setup(gateway);
      const empty = emptyOverview();
      const usage = empty.usage as ProviderWorkbenchOverview["usage"];
      gateway.setOverview({
        ...empty,
        usage: {
          ...usage,
          input: { total: 10, missing: 0, latestSource: { seq: 1, hash: hex64("invented-usage") } },
        },
      });
      const result = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, {
          binding: gateway.binding,
          sessionId: gateway.sessionId,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
