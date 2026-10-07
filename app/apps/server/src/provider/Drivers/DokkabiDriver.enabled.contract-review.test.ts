import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  DokkabiSettings,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import { DokkabiDriver } from "./DokkabiDriver.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

describe("Dokkabi normalized instance enable authority", () => {
  for (const enabled of [true, false])
    it.effect(`the resolved envelope ${enabled} survives a missing normalized legacy flag`, () =>
      Effect.gen(function* () {
        const rawConfig = { gatewayUrl: "", tokenEnv: "", workspacePath: "" },
          config = yield* Schema.decodeEffect(DokkabiSettings)(rawConfig);
        expect(config.enabled).toBe(false);
        const resolved = resolveProviderInstanceEnabled({
          driver: DokkabiDriver.driverKind,
          enabled,
          config: rawConfig,
        });
        expect(resolved).toBe(enabled);
        const instance = yield* DokkabiDriver.create({
          instanceId: ProviderInstanceId.make("dokkabi"),
          displayName: "Dokkabi",
          accentColor: undefined,
          environment: [],
          enabled: resolved,
          config,
        });
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot.enabled).toBe(enabled);
        expect(snapshot.status).toBe(enabled ? "error" : "disabled");
        expect(snapshot.models).toEqual([]);
      }).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Effect.scoped),
    );
});
