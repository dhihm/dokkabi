// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem failures verify durable preference boundaries.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePathService from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  RecordCompanionPreferencesDocument,
  RECORD_COMPANION_PREFERENCES_MAX_BYTES,
} from "@t3tools/contracts";
import { RecordCompanionPreferences, layerFromInput } from "./RecordCompanionPreferences.ts";

const entry = () => ({
  view: { tab: "record" as const, pin: null, after: null, selectedSeq: 7 },
  bounds: { x: 10, y: 20, width: 760, height: 680 },
});
const storeLayer = (path: string) =>
  layerFromInput({ preferencesPath: path }).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodePathService.layer),
  );
const withPath = <E>(body: (path: string) => Effect.Effect<void, E, never>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFs.mkdtemp("/private/tmp/dokkabi-r6-prefs-review-")),
    (directory) => body(NodePath.join(directory, "preferences.json")),
    (directory) => Effect.promise(() => NodeFs.rm(directory, { recursive: true, force: true })),
  );

const decodeWritten = Schema.decodeUnknownSync(
  Schema.fromJsonString(RecordCompanionPreferencesDocument),
);
const tryMutation = (view: { selectedSeq: number | null }) => {
  try {
    view.selectedSeq = 900;
  } catch {
    /* Frozen values are also safe. */
  }
};
const rawDocument = (key: string) =>
  JSON.stringify({ schemaVersion: 1, scopes: { [key]: entry() } });

describe("independent durable preference boundaries", () => {
  it.effect("a failed rename preserves the prior in-memory and durable selection", () =>
    withPath((path) =>
      Effect.gen(function* () {
        const store = yield* RecordCompanionPreferences;
        yield* store.setScope("scope", entry());
        const prior = yield* Effect.promise(() => NodeFs.readFile(path, "utf8"));
        yield* Effect.promise(async () => {
          await NodeFs.unlink(path);
          await NodeFs.mkdir(path);
        });
        const failed = yield* Effect.flip(
          store.setScope("scope", { ...entry(), view: { ...entry().view, selectedSeq: 9 } }),
        );
        expect(failed.operation).toBe("rename");
        expect((yield* store.getScope("scope"))?.view.selectedSeq).toBe(7);
        yield* Effect.promise(async () => {
          await NodeFs.rmdir(path);
          await NodeFs.writeFile(path, prior);
        });
        yield* store.setScope("other", entry());
        const written = decodeWritten(yield* Effect.promise(() => NodeFs.readFile(path, "utf8")));
        expect(written.scopes.scope?.view.selectedSeq).toBe(7);
        expect(yield* Effect.promise(() => NodeFs.readdir(NodePath.dirname(path)))).toEqual([
          "preferences.json",
        ]);
      }).pipe(Effect.provide(storeLayer(path))),
    ),
  );

  it.effect("returned preferences cannot mutate retained state or a later durable write", () =>
    withPath((path) =>
      Effect.gen(function* () {
        const store = yield* RecordCompanionPreferences;
        yield* store.setScope("scope", entry());
        const returned = yield* store.getScope("scope");
        expect(returned).not.toBeNull();
        if (returned) {
          tryMutation(returned.view as { selectedSeq: number | null });
        }
        expect((yield* store.getScope("scope"))?.view.selectedSeq).toBe(7);
        yield* store.setScope("other", entry());
        const written = decodeWritten(yield* Effect.promise(() => NodeFs.readFile(path, "utf8")));
        expect(written.scopes.scope?.view.selectedSeq).toBe(7);
      }).pipe(Effect.provide(storeLayer(path))),
    ),
  );

  it.effect("oversized UTF-8 input is refused before restoring any scope", () =>
    withPath((path) =>
      Effect.gen(function* () {
        const key = "한".repeat(Math.ceil(RECORD_COMPANION_PREFERENCES_MAX_BYTES / 3));
        const raw = rawDocument(key);
        expect(raw.length).toBeLessThan(RECORD_COMPANION_PREFERENCES_MAX_BYTES);
        expect(Buffer.byteLength(raw)).toBeGreaterThan(RECORD_COMPANION_PREFERENCES_MAX_BYTES);
        yield* Effect.promise(() => NodeFs.writeFile(path, raw));
        yield* Effect.gen(function* () {
          const store = yield* RecordCompanionPreferences;
          expect(yield* store.getScope(key)).toBeNull();
        }).pipe(Effect.provide(storeLayer(path)));
      }),
    ),
  );
});
