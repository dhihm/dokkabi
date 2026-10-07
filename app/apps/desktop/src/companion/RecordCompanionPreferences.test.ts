// @effect-diagnostics nodeBuiltinImport:off -- Real temporary files exercise atomic replacement, size refusal and crash-persistence boundaries through the same node APIs the store wraps.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePlatformFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";

import {
  EMPTY_RECORD_COMPANION_PREFERENCES,
  RecordCompanionPreferences,
  layerFromInput,
  sanitizeRecordCompanionPreferencesDocument,
  upsertScopePreferences,
} from "./RecordCompanionPreferences.ts";

const validPreferences = {
  view: {
    tab: "record",
    pin: {
      sessionId: "session-fixture",
      seq: 51,
      hash: "a".repeat(64),
      generation: "b".repeat(64),
    },
    after: null,
    selectedSeq: 4,
  },
  bounds: { x: 120, y: 80, width: 760, height: 680 },
} as const;

let tempDirCounter = 0;
function tempStorePath(): string {
  tempDirCounter += 1;
  return NodePath.join(
    NodeOs.tmpdir(),
    `dokkabi-record-companion-prefs-${process.pid}-${tempDirCounter}`,
    "record-companion-preferences.json",
  );
}
// Plain helpers: raw node:fs stays outside Effect context (codebase convention).
function listDirectoryPlain(directory: string): readonly string[] {
  return NodeFs.readdirSync(directory);
}
function readFileTextPlain(path: string): string {
  return NodeFs.readFileSync(path, "utf8");
}
function writeOversizePlain(path: string): void {
  NodeFs.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFs.writeFileSync(path, "x".repeat(300_000));
}

const storeLayer = (path: string) =>
  layerFromInput({ preferencesPath: path }).pipe(
    Layer.provideMerge(NodePlatformFileSystem.layer),
    Layer.provideMerge(NodePlatformPath.layer),
  );

describe("record companion preferences sanitization", () => {
  it("accepts a valid bounded document", () => {
    const document = sanitizeRecordCompanionPreferencesDocument({
      schemaVersion: 1,
      scopes: { '["env","thread",null]': validPreferences },
    });
    expect(document).not.toBeNull();
    expect(document?.scopes['["env","thread",null]']?.view.selectedSeq).toBe(4);
  });

  it("refuses unknown fields, wrong versions and out-of-bounds values whole", () => {
    expect(sanitizeRecordCompanionPreferencesDocument({ schemaVersion: 2, scopes: {} })).toBeNull();
    expect(sanitizeRecordCompanionPreferencesDocument(null)).toBeNull();
    expect(
      sanitizeRecordCompanionPreferencesDocument({
        schemaVersion: 1,
        scopes: { s: { ...validPreferences, extra: true } },
      }),
    ).toBeNull();
    expect(
      sanitizeRecordCompanionPreferencesDocument({
        schemaVersion: 1,
        scopes: {
          s: {
            view: { ...validPreferences.view, selectedSeq: -3 },
            bounds: validPreferences.bounds,
          },
        },
      }),
    ).toBeNull();
    expect(
      sanitizeRecordCompanionPreferencesDocument({
        schemaVersion: 1,
        scopes: {
          s: {
            view: validPreferences.view,
            bounds: { x: 0, y: 0, width: 9_999, height: 100 },
          },
        },
      }),
    ).toBeNull();
  });

  it("evicts the least recently used scope beyond the bound", () => {
    let document = EMPTY_RECORD_COMPANION_PREFERENCES;
    for (let index = 0; index < 300; index += 1) {
      document = upsertScopePreferences(document, `scope-${index}`, {
        view: { tab: "record", pin: null, after: null, selectedSeq: null },
        bounds: null,
      });
    }
    expect(Object.keys(document.scopes)).toHaveLength(256);
    expect(document.scopes["scope-0"]).toBeUndefined();
    expect(document.scopes["scope-299"]).toBeDefined();
    // Re-inserting refreshes recency: scope-44 survives the next eviction.
    document = upsertScopePreferences(document, "scope-44", {
      view: { tab: "record", pin: null, after: null, selectedSeq: null },
      bounds: null,
    });
    document = upsertScopePreferences(document, "scope-300", {
      view: { tab: "record", pin: null, after: null, selectedSeq: null },
      bounds: null,
    });
    expect(document.scopes["scope-44"]).toBeDefined();
    expect(document.scopes["scope-45"]).toBeUndefined();
  });
});

describe("record companion preferences store", () => {
  it.effect("persists sanitized scoped preferences atomically and restores them", () =>
    Effect.gen(function* () {
      const path = tempStorePath();
      const layer = storeLayer(path);
      yield* Effect.gen(function* () {
        const preferences = yield* RecordCompanionPreferences;
        yield* preferences.setScope('["env","thread","instance"]', validPreferences);
      }).pipe(Effect.provide(layer));

      // A second store instance over the same file restores the entry.
      yield* Effect.gen(function* () {
        const store = yield* RecordCompanionPreferences;
        expect(yield* store.getScope('["env","thread","instance"]')).toEqual(validPreferences);
      }).pipe(Effect.provide(storeLayer(path)));

      // No temp files remain beside the atomically replaced document.
      const entries = yield* Effect.sync(() => listDirectoryPlain(NodePath.dirname(path)));
      expect(entries).toEqual(["record-companion-preferences.json"]);
    }),
  );

  it.effect("refuses unsanitized entries without touching the durable document", () =>
    Effect.gen(function* () {
      const store = yield* RecordCompanionPreferences;
      yield* store.setScope("good", {
        view: { tab: "decisions", pin: null, after: null, selectedSeq: null },
        bounds: null,
      });
      const refusal = yield* Effect.flip(
        store.setScope("bad", {
          view: { tab: "record", pin: null, after: null, selectedSeq: 1e12 },
          bounds: null,
        } as never),
      );
      expect(refusal.operation).toBe("encode");
      expect(yield* store.getScope("bad")).toBeNull();
      expect(yield* store.getScope("good")).not.toBeNull();
    }).pipe(Effect.provide(storeLayer(tempStorePath()))),
  );

  it.effect("treats a refused document as empty preferences, never a partial splice", () => {
    const path = tempStorePath();
    return Effect.gen(function* () {
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.makeDirectory(NodePath.dirname(path), { recursive: true }),
        ),
        Effect.andThen(
          FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) =>
              fileSystem.writeFileString(
                path,
                JSON.stringify({ schemaVersion: 1, scopes: { tampered: { view: null } } }),
              ),
            ),
          ),
        ),
        Effect.provide(NodePlatformFileSystem.layer),
      );
      const store = yield* RecordCompanionPreferences;
      expect(yield* store.getScope("tampered")).toBeNull();
    }).pipe(Effect.provide(storeLayer(path)));
  });

  it.effect("rejects an oversized durable file before decoding any byte", () => {
    const path = tempStorePath();
    return Effect.gen(function* () {
      yield* Effect.sync(() => writeOversizePlain(path));
      const store = yield* RecordCompanionPreferences;
      expect(yield* store.getScope("any")).toBeNull();
      // The oversized file itself is untouched: refusal happened before read.
      expect(readFileTextPlain(path).length).toBe(300_000);
    }).pipe(Effect.provide(storeLayer(path)));
  });

  it.effect("keeps the previous committed document when the durable write fails", () => {
    const goodPath = tempStorePath();
    const brokenPath = `${tempStorePath()}-blocker/preferences.json`;
    return Effect.gen(function* () {
      // Commit one good entry durably first.
      yield* Effect.gen(function* () {
        const store = yield* RecordCompanionPreferences;
        yield* store.setScope("kept", {
          view: { tab: "record", pin: null, after: null, selectedSeq: 7 },
          bounds: null,
        });
      }).pipe(Effect.provide(storeLayer(goodPath)));

      // Break persistence: the preferences path sits under a plain FILE, so
      // directory creation (and thus the write) must fail.
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.makeDirectory(NodePath.dirname(NodePath.dirname(brokenPath)), {
            recursive: true,
          }),
        ),
        Effect.andThen(
          FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) =>
              fileSystem.writeFileString(NodePath.dirname(brokenPath), "not a directory"),
            ),
          ),
        ),
        Effect.provide(NodePlatformFileSystem.layer),
      );
      const failing = yield* Effect.flip(
        Effect.gen(function* () {
          const store = yield* RecordCompanionPreferences;
          yield* store.setScope("uncommitted", {
            view: { tab: "decisions", pin: null, after: null, selectedSeq: null },
            bounds: null,
          });
        }).pipe(Effect.provide(storeLayer(brokenPath))),
      );
      expect(failing.operation).toBe("write");

      // The failing store's memory never adopted the uncommitted entry.
      yield* Effect.gen(function* () {
        const store = yield* RecordCompanionPreferences;
        expect(yield* store.getScope("uncommitted")).toBeNull();
        expect(yield* store.getScope("kept")).toBeNull();
      }).pipe(Effect.provide(storeLayer(brokenPath)));

      // The good store still restores exactly its committed entry.
      yield* Effect.gen(function* () {
        const store = yield* RecordCompanionPreferences;
        const kept = yield* store.getScope("kept");
        expect(kept?.view.selectedSeq).toBe(7);
      }).pipe(Effect.provide(storeLayer(goodPath)));
    });
  });

  it.effect("defensive-copies getScope results so caller mutation cannot corrupt retention", () => {
    const path = tempStorePath();
    return Effect.gen(function* () {
      const store = yield* RecordCompanionPreferences;
      yield* store.setScope("scope", {
        view: { tab: "record", pin: null, after: null, selectedSeq: 3 },
        bounds: { x: 1, y: 2, width: 700, height: 600 },
      });
      const first = yield* store.getScope("scope");
      expect(first).not.toBeNull();
      (first as { view: { tab: string } }).view.tab = "decisions";
      (first?.bounds as { width: number }).width = 9_999;
      // A later durable write of ANOTHER scope still persists the original,
      // unmutated entry for "scope".
      yield* store.setScope("other", {
        view: { tab: "record", pin: null, after: null, selectedSeq: null },
        bounds: null,
      });
      const reread = yield* store.getScope("scope");
      expect(reread?.view.tab).toBe("record");
      expect(reread?.bounds?.width).toBe(700);
    }).pipe(Effect.provide(storeLayer(path)));
  });
});
