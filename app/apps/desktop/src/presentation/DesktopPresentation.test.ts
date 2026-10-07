// @effect-diagnostics nodeBuiltinImport:off -- Real temporary files exercise the watcher, atomic renames and permission boundaries through the node APIs the service layers wrap.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePathService from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PRESENTATION_SCHEMA_VERSION, type PresentationAppliedState } from "@t3tools/contracts";

import * as DesktopPresentation from "./DesktopPresentation.ts";

const DEFAULTS_JSON = `${JSON.stringify(
  {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    tokens: { transition: { durationMs: 160 } },
    layout: {
      mainWindow: { minWidth: 840, minHeight: 620, defaultWidth: 1100, defaultHeight: 780 },
      navigation: { minWidth: 200, defaultWidth: 240, maxWidth: 320 },
      conversation: { minWidth: 480 },
      rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
      inlineBreakpoint: 1200,
    },
  },
  null,
  2,
)}\n`;

interface TestContext {
  readonly service: DesktopPresentation.DesktopPresentation["Service"];
  readonly configPath: string;
  readonly auditPath: string;
  readonly artifactDirectory: string;
  readonly minimums: Array<{ readonly width: number; readonly height: number }>;
}

// Plain filesystem helpers: raw node:fs/node:path stay outside Effect
// context, matching the desktop codebase convention (see snapShot tests).
interface PresentationTestPaths {
  readonly desktopDir: string;
  readonly configPath: string;
  readonly auditPath: string;
  readonly artifactDirectory: string;
}

const presentationTestPaths = (homeDir: string): PresentationTestPaths => {
  const desktopDir = NodePath.join(homeDir, "desktop");
  return {
    desktopDir,
    configPath: NodePath.join(desktopDir, "presentation.json"),
    auditPath: NodePath.join(desktopDir, "presentation-audit.json"),
    artifactDirectory: NodePath.join(desktopDir, "presentation-artifacts"),
  };
};

const seedPresentationTestHome = async (
  paths: PresentationTestPaths,
  options: {
    readonly seedConfig?: string;
    readonly makeAuditPathUnwritable?: boolean;
    readonly blockArtifacts?: boolean;
  },
): Promise<void> => {
  await NodeFS.promises.mkdir(paths.desktopDir, { recursive: true });
  if (options.seedConfig !== undefined) {
    await NodeFS.promises.writeFile(paths.configPath, options.seedConfig, "utf8");
  }
  if (options.makeAuditPathUnwritable === true) {
    // A directory where the audit file would live makes every append fail.
    await NodeFS.promises.mkdir(paths.auditPath, { recursive: true });
  }
  if (options.blockArtifacts === true) {
    // A regular file where the artifact directory would live makes every
    // artifact retention fail while audit stays writable.
    await NodeFS.promises.writeFile(paths.artifactDirectory, "not a directory", "utf8");
  }
};

const makeTempHomeDir = (): Promise<string> =>
  NodeFS.promises.mkdtemp(NodePath.join("/private/tmp", "dokkabi-presentation-"));

const removeDir = (dir: string): Promise<void> =>
  NodeFS.promises.rm(dir, { recursive: true, force: true });

const writeFileRaw = (path: string, contents: string): Promise<void> =>
  NodeFS.promises.writeFile(path, contents, "utf8");

const chmodPath = (path: string, mode: number): Promise<void> => NodeFS.promises.chmod(path, mode);

const removePath = (path: string, options?: { readonly force?: boolean }): Promise<void> =>
  NodeFS.promises.rm(path, options).catch(() => undefined);

const joinArtifactPath = (artifactDirectory: string, digest: string): string =>
  NodePath.join(artifactDirectory, `${digest}.json`);

const realHomePresentationConfigPath = (): string =>
  NodePath.join(NodeOS.homedir(), ".dokkabi", "desktop", "presentation.json");

const runTest = <A>(
  options: {
    readonly seedConfig?: string;
    readonly watch?: boolean;
    readonly makeAuditPathUnwritable?: boolean;
    readonly blockArtifacts?: boolean;
    readonly maxFileBytes?: number;
    readonly onPreparedBeforeReplace?: (configPath: string) => Effect.Effect<void>;
    readonly fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
  },
  body: (context: TestContext) => Generator<Effect.Effect<unknown, never, never>, A, any>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const homeDir = yield* makeTempHome();
    const paths = presentationTestPaths(homeDir);
    yield* Effect.promise(() => seedPresentationTestHome(paths, options));
    const minimums: TestContext["minimums"] = [];
    const presentationLayer = DesktopPresentation.layer({
      configPath: paths.configPath,
      auditPath: paths.auditPath,
      defaultsJson: DEFAULTS_JSON,
      debounceMs: 30,
      ...(options.watch === undefined ? {} : { watch: options.watch }),
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
      ...(options.onPreparedBeforeReplace === undefined
        ? {}
        : { onPreparedBeforeReplace: options.onPreparedBeforeReplace }),
      windowIntegration: {
        applyMinimums: (minimum) =>
          Effect.sync(() => {
            minimums.push(minimum);
          }),
        pushState: () => Effect.void,
      },
    }).pipe(
      Layer.provideMerge(options.fileSystemLayer ?? NodeFileSystem.layer),
      Layer.provideMerge(NodePathService.layer),
    );
    // The layer must stay built for the whole body: providing it around the
    // service yield alone would close the watcher before the body runs.
    const program = Effect.gen(function* () {
      const service = yield* DesktopPresentation.DesktopPresentation;
      return yield* Effect.gen(() =>
        body({
          service,
          configPath: paths.configPath,
          auditPath: paths.auditPath,
          artifactDirectory: paths.artifactDirectory,
          minimums,
        }),
      );
    });
    return yield* program.pipe(Effect.provide(presentationLayer));
  }).pipe(Effect.scoped);

const makeTempHome = (): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.promise(makeTempHomeDir), (dir) =>
    Effect.promise(() => removeDir(dir)),
  );

const readDisk = (path: string): Promise<string | null> =>
  NodeFS.promises.readFile(path, "utf8").catch(() => null);

const atomicWrite = (path: string, contents: string): Promise<void> => {
  const tempPath = `${path}.${process.pid}.external.tmp`;
  return NodeFS.promises
    .writeFile(tempPath, contents, "utf8")
    .then(() => NodeFS.promises.rename(tempPath, path));
};

const overrideDocument = (tokens: Record<string, unknown>): string =>
  JSON.stringify({ schemaVersion: PRESENTATION_SCHEMA_VERSION, tokens });

const prettyOverrideDocument = (tokens: Record<string, unknown>): string =>
  `${JSON.stringify({ schemaVersion: PRESENTATION_SCHEMA_VERSION, tokens }, null, 2)}\n`;

const layoutOnlyDocument = (layout: Record<string, unknown>): string =>
  JSON.stringify({ schemaVersion: PRESENTATION_SCHEMA_VERSION, layout });

const unknownTokensDocument = (tokens: Record<string, unknown>): string =>
  JSON.stringify({ schemaVersion: PRESENTATION_SCHEMA_VERSION, tokens });

const decodeAuditEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ operation: Schema.String, outcome: Schema.String })),
);

describe("DOKKABI presentation path resolution", () => {
  it("prefers an absolute DOKKABI_HOME and appends desktop/presentation.json", () => {
    expect(
      DesktopPresentation.resolveDokkabiHome({
        env: { DOKKABI_HOME: "/tmp/dokkabi-home" },
        homeDirectory: "/Users/operator",
      }),
    ).toEqual({ ok: true, home: "/tmp/dokkabi-home" });
    expect(
      DesktopPresentation.resolvePresentationPaths({
        dokkabiHome: "/tmp/dokkabi-home",
        joinPath: NodePath.join,
      }),
    ).toEqual({
      configPath: "/tmp/dokkabi-home/desktop/presentation.json",
      auditPath: "/tmp/dokkabi-home/desktop/presentation-audit.json",
    });
  });

  it("falls back to ~/.dokkabi when DOKKABI_HOME is missing or empty", () => {
    expect(
      DesktopPresentation.resolveDokkabiHome({ env: {}, homeDirectory: "/Users/operator" }),
    ).toEqual({ ok: true, home: "/Users/operator/.dokkabi" });
    expect(
      DesktopPresentation.resolveDokkabiHome({
        env: { DOKKABI_HOME: "  " },
        homeDirectory: "/Users/operator",
      }),
    ).toEqual({ ok: true, home: "/Users/operator/.dokkabi" });
  });

  it("rejects a relative DOKKABI_HOME instead of silently using a real home", () => {
    const resolution = DesktopPresentation.resolveDokkabiHome({
      env: { DOKKABI_HOME: "relative/path" },
      homeDirectory: "/Users/operator",
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toContain("absolute");
    }
  });

  it("resolves absolute paths with platform semantics, including Windows drives", () => {
    expect(
      DesktopPresentation.resolveDokkabiHome({
        env: { DOKKABI_HOME: "C:\\Users\\operator\\.dokkabi" },
        homeDirectory: "C:\\Users\\operator",
        isAbsolute: NodePath.win32.isAbsolute,
      }),
    ).toEqual({ ok: true, home: "C:\\Users\\operator\\.dokkabi" });
    expect(
      DesktopPresentation.resolveDokkabiHome({
        env: { DOKKABI_HOME: "relative\\path" },
        homeDirectory: "C:\\Users\\operator",
        isAbsolute: NodePath.win32.isAbsolute,
      }).ok,
    ).toBe(false);
  });
});

describe("desktop presentation host service", () => {
  it.effect("starts from resource defaults when no override file exists", () =>
    runTest({ watch: false }, function* (context) {
      const state = yield* context.service.getState;
      expect(state.status).toBe("defaults");
      expect(state.revision).toBeGreaterThan(0);
      expect(state.config.layout.mainWindow.minWidth).toBe(840);
      expect(state.config.layout.conversation.minWidth).toBe(480);
      expect(state.error).toBeNull();
      expect(state.overrideDocument).toBeNull();
    }),
  );

  it.effect("cold-starts an invalid file into defaults with a visible error", () =>
    runTest({ watch: false, seedConfig: "{ not json" }, function* (context) {
      const state = yield* context.service.getState;
      expect(state.status).toBe("invalid");
      expect(state.config.layout.mainWindow.minWidth).toBe(840);
      expect(state.error).not.toBeNull();
      expect(state.error?.line).not.toBeNull();
      expect(yield* Effect.promise(() => readDisk(context.configPath))).toBe("{ not json");
    }),
  );

  it.effect("saves a valid candidate atomically and returns an applied receipt", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      const result = yield* context.service.save({
        expectedRevision: before.revision,
        document: overrideDocument({ color: { background: "#101418" } }),
      });
      expect(result.type).toBe("applied");
      if (result.type !== "applied") return;
      expect(result.state.status).toBe("applied");
      expect(result.state.revision).toBe(before.revision + 1);
      expect(result.state.config.tokens.color.background).toBe("#101418");
      expect(yield* context.service.getState).toEqual(result.state);
      const onDisk = yield* Effect.promise(() => readDisk(context.configPath));
      expect(onDisk).toContain("#101418");
    }),
  );

  it.effect("retains content-addressed config artifacts and an append-only audit journal", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      const saved = yield* context.service.save({
        expectedRevision: before.revision,
        document: overrideDocument({ color: { background: "#101418" } }),
      });
      expect(saved.type).toBe("applied");
      const reset = yield* context.service.reset;
      expect(reset.type).toBe("applied");

      const auditText = yield* Effect.promise(() => readDisk(context.auditPath));
      expect(auditText).not.toBeNull();
      const entries = auditText!
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeAuditEntry(line));
      // Save: prepared + applied. Reset: prepared + defaults. Nothing is
      // rewritten or truncated away.
      expect(entries.map((entry) => `${entry.operation}:${entry.outcome}`)).toEqual([
        "save:prepared",
        "save:applied",
        "reset:prepared",
        "reset:defaults",
      ]);

      const appliedState = saved.type === "applied" ? saved.state : yield* context.service.getState;
      const artifactPath = joinArtifactPath(context.artifactDirectory, appliedState.digest);
      const artifact = yield* Effect.promise(() => readDisk(artifactPath));
      expect(artifact).not.toBeNull();
      expect(artifact).toContain("#101418");
      expect(artifact).toContain('"schemaVersion":1');
    }),
  );

  it.effect("rejects an invalid save without touching disk and reports field pointers", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      const result = yield* context.service.save({
        expectedRevision: before.revision,
        document: JSON.stringify({
          schemaVersion: PRESENTATION_SCHEMA_VERSION,
          tokens: { color: { nope: "#fff" } },
        }),
      });
      expect(result.type).toBe("invalid");
      if (result.type !== "invalid") return;
      expect(result.issues.some((issue) => issue.path === "/tokens/color/nope")).toBe(true);
      expect(yield* Effect.promise(() => readDisk(context.configPath))).toBeNull();
    }),
  );

  it.effect("returns a typed conflict for a stale expected revision", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      const result = yield* context.service.save({
        expectedRevision: before.revision + 7,
        document: JSON.stringify({ schemaVersion: PRESENTATION_SCHEMA_VERSION }),
      });
      expect(result.type).toBe("conflict");
      expect(yield* Effect.promise(() => readDisk(context.configPath))).toBeNull();
    }),
  );

  it.effect(
    "conflicts and preserves bytes when an external edit lands during save preparation",
    () =>
      runTest(
        {
          watch: false,
          // Deterministic race: the external edit lands after audit/artifact
          // preparation but before the final disk recheck and replace.
          onPreparedBeforeReplace: (configPath) =>
            Effect.promise(() =>
              atomicWrite(configPath, overrideDocument({ color: { text: "#f4f4f5" } })),
            ),
        },
        function* (context) {
          const before = yield* context.service.getState;
          const result = yield* context.service.save({
            expectedRevision: before.revision,
            document: overrideDocument({ color: { background: "#101418" } }),
          });
          expect(result.type).toBe("conflict");
          const onDisk = yield* Effect.promise(() => readDisk(context.configPath));
          expect(onDisk).toContain("#f4f4f5");
          expect(yield* context.service.getState).toEqual(before);
        },
      ),
  );

  it.effect("does not clobber an external edit that the host has not observed", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { accent: "#00ff00" } })),
      );
      const result = yield* context.service.save({
        expectedRevision: before.revision,
        document: overrideDocument({ color: { accent: "#ff0000" } }),
      });
      expect(result.type).toBe("conflict");
      const onDisk = yield* Effect.promise(() => readDisk(context.configPath));
      expect(onDisk).toContain("#00ff00");
    }),
  );

  it.effect("lets the editor repair an observed invalid file with the current revision", () =>
    runTest({ watch: false, seedConfig: "{ not json" }, function* (context) {
      const invalid = yield* context.service.getState;
      expect(invalid.status).toBe("invalid");
      const result = yield* context.service.save({
        expectedRevision: invalid.revision,
        document: overrideDocument({ color: { background: "#101418" } }),
      });
      expect(result.type).toBe("applied");
      if (result.type !== "applied") return;
      expect(result.state.status).toBe("applied");
      expect(result.state.error).toBeNull();
      const onDisk = yield* Effect.promise(() => readDisk(context.configPath));
      expect(onDisk).toContain("#101418");
    }),
  );

  it.effect("restores shipped defaults when token resets are saved", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      const overridden = yield* context.service.save({
        expectedRevision: before.revision,
        document: overrideDocument({
          color: { background: "#101418" },
          transition: { durationMs: 300 },
        }),
      });
      expect(overridden.type).toBe("applied");
      const current = yield* context.service.getState;
      expect(current.config.tokens.transition.durationMs).toBe(300);
      const reset = yield* context.service.save({
        expectedRevision: current.revision,
        document: overrideDocument({ transition: { durationMs: null } }),
      });
      expect(reset.type).toBe("applied");
      if (reset.type !== "applied") return;
      // The null reset restores the shipped default number rather than
      // producing an invalid resolved config; a fresh document also drops
      // the previously overridden color back to the theme base.
      expect(reset.state.config.tokens.transition.durationMs).toBe(160);
      expect(reset.state.config.tokens.color.background).toBeNull();
    }),
  );

  it.effect(
    "refuses the save when the audit writer is unavailable and leaves the override untouched",
    () =>
      runTest({ watch: false, makeAuditPathUnwritable: true }, function* (context) {
        const before = yield* context.service.getState;
        const result = yield* context.service.save({
          expectedRevision: before.revision,
          document: overrideDocument({ color: { background: "#101418" } }),
        });
        expect(result.type).toBe("error");
        if (result.type !== "error") return;
        expect(result.message).toContain("audit");
        expect(result.state).toEqual(before);
        expect(yield* Effect.promise(() => readDisk(context.configPath))).toBeNull();
        expect(yield* context.service.getState).toEqual(before);
      }),
  );

  it.effect("refuses reset when the audit writer is unavailable and keeps the override", () =>
    runTest(
      {
        watch: false,
        makeAuditPathUnwritable: true,
        seedConfig: overrideDocument({ color: { background: "#101418" } }),
      },
      function* (context) {
        const before = yield* context.service.getState;
        expect(before.status).toBe("applied");
        const result = yield* context.service.reset;
        expect(result.type).toBe("error");
        const onDisk = yield* Effect.promise(() => readDisk(context.configPath));
        expect(onDisk).toContain("#101418");
        expect(yield* context.service.getState).toEqual(before);
      },
    ),
  );

  it.effect("reset removes only the presentation override and returns to defaults", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      yield* context.service.save({
        expectedRevision: before.revision,
        document: overrideDocument({ color: { background: "#101418" } }),
      });
      const result = yield* context.service.reset;
      expect(result.type).toBe("applied");
      if (result.type !== "applied") return;
      expect(result.state.status).toBe("defaults");
      expect(yield* Effect.promise(() => readDisk(context.configPath))).toBeNull();
    }),
  );

  it.effect("bounds the accepted file size before reading or writing", () =>
    runTest({ watch: false, maxFileBytes: 2048 }, function* (context) {
      const oversized = `${" ".repeat(3000)}${JSON.stringify({
        schemaVersion: PRESENTATION_SCHEMA_VERSION,
      })}`;
      yield* Effect.promise(() => writeFileRaw(context.configPath, oversized));
      const state = yield* context.service.reload;
      expect(state.status).toBe("invalid");
      expect(state.error?.kind).toBe("io");
      expect(state.config.layout.mainWindow.minWidth).toBe(840);

      const before = yield* context.service.getState;
      const result = yield* context.service.save({
        expectedRevision: before.revision,
        document: oversized,
      });
      expect(result.type).toBe("invalid");
    }),
  );

  it.effect("preserves last-valid with a visible I/O error when the file cannot be read", () =>
    runTest({ watch: false }, function* (context) {
      const seeded = yield* context.service.save({
        expectedRevision: 1,
        document: overrideDocument({ color: { background: "#101418" } }),
      });
      expect(seeded.type).toBe("applied");
      yield* Effect.promise(() => chmodPath(context.configPath, 0o000));
      const errored = yield* context.service.reload;
      expect(errored.status).toBe("invalid");
      expect(errored.error?.kind).toBe("io");
      expect(errored.config.tokens.color.background).toBe("#101418");
      const revisionWithError = errored.revision;
      // Reload while still unreadable: identical observation, no churn.
      const again = yield* context.service.reload;
      expect(again.revision).toBe(revisionWithError);
      yield* Effect.promise(() => chmodPath(context.configPath, 0o644));
      const recovered = yield* context.service.reload;
      expect(recovered.status).toBe("applied");
      expect(recovered.error).toBeNull();
      expect(recovered.revision).toBeGreaterThan(revisionWithError);
    }),
  );

  it.effect("bounds the accepted save document size", () =>
    runTest({ watch: false }, function* (context) {
      const before = yield* context.service.getState;
      const result = yield* context.service.save({
        expectedRevision: before.revision,
        document: `${" ".repeat(300_000)}${JSON.stringify({
          schemaVersion: PRESENTATION_SCHEMA_VERSION,
        })}`,
      });
      expect(result.type).toBe("invalid");
    }),
  );

  it.effect("reset recovers from an oversized override without reading its bytes", () =>
    runTest({ watch: false, maxFileBytes: 2048 }, function* (context) {
      const oversized = `${" ".repeat(3000)}${JSON.stringify({
        schemaVersion: PRESENTATION_SCHEMA_VERSION,
      })}`;
      yield* Effect.promise(() => writeFileRaw(context.configPath, oversized));
      const errored = yield* context.service.reload;
      expect(errored.status).toBe("invalid");
      expect(errored.error?.kind).toBe("io");
      const result = yield* context.service.reset;
      expect(result.type).toBe("applied");
      if (result.type !== "applied") return;
      expect(result.state.status).toBe("defaults");
      expect(yield* Effect.promise(() => readDisk(context.configPath))).toBeNull();
    }),
  );
});

/**
 * FileSystem service seam for deterministic watcher-failure tests: everything
 * delegates to the real Node layer; `watch` dies on demand so the host's
 * stopped-watcher path can be exercised without breaking real file I/O.
 */
const makeSwitchableWatchFileSystem = (): {
  readonly layer: Layer.Layer<FileSystem.FileSystem>;
  readonly setWatchFailing: (failing: boolean) => void;
} => {
  let failing = false;
  const layer = Layer.unwrap(
    Effect.map(Layer.build(NodeFileSystem.layer), (context) =>
      Layer.succeed(FileSystem.FileSystem, {
        ...Context.get(context, FileSystem.FileSystem),
        watch: (watchPath, watchOptions) =>
          failing
            ? Stream.die(new Error(`simulated watcher failure on ${watchPath}`))
            : Context.get(context, FileSystem.FileSystem).watch(watchPath, watchOptions),
      } satisfies FileSystem.FileSystem),
    ),
  );
  return {
    layer,
    setWatchFailing: (value) => {
      failing = value;
    },
  };
};

describe("desktop presentation watch lifecycle", () => {
  it.live("publishes one whole revision after an external atomic rename edit", () =>
    runTest({}, function* (context) {
      const before = yield* context.service.getState;
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ radius: { panel: "0.75rem" } })),
      );
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "applied",
      );
      expect(state.config.tokens.radius.panel).toBe("0.75rem");
      expect(state.revision).toBe(before.revision + 1);
      expect(state.overrideDocument).not.toBeNull();
    }),
  );

  it.live("keeps last-valid and reports a pointer error on an invalid external edit", () =>
    runTest({}, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { background: "#101418" } })),
      );
      const applied = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "applied",
      );
      yield* Effect.promise(() => atomicWrite(context.configPath, "{ invalid"));
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "invalid",
      );
      expect(state.config.tokens.color.background).toBe("#101418");
      expect(state.error?.line).not.toBeNull();
      expect(state.revision).toBeGreaterThan(applied.revision);
      expect(yield* Effect.promise(() => readDisk(context.configPath))).toBe("{ invalid");
    }),
  );

  it.live("publishes a new revision for different raw bytes even at an equal config digest", () =>
    runTest({}, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { background: "#101418" } })),
      );
      const first = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "applied",
      );
      // Same resolved config, different raw document (pretty-printed).
      const rewritten = prettyOverrideDocument({ color: { background: "#101418" } });
      yield* Effect.promise(() => atomicWrite(context.configPath, rewritten));
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "applied" && candidate.overrideDocument === rewritten,
      );
      expect(state.digest).toBe(first.digest);
      expect(state.revision).toBeGreaterThan(first.revision);
    }),
  );

  it.live("rejects unknown properties from external edits while retaining last-valid", () =>
    runTest({}, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, layoutOnlyDocument({ navigation: { defaultWidth: 280 } })),
      );
      yield* waitForRevision(context.service, (candidate) => candidate.status === "applied");
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, unknownTokensDocument({ ghost: {} })),
      );
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "invalid",
      );
      expect(state.config.layout.navigation.defaultWidth).toBe(280);
      expect(state.error?.path).toBe("/tokens/ghost");
    }),
  );

  it.live("returns to defaults when the override file is deleted", () =>
    runTest({}, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { background: "#101418" } })),
      );
      yield* waitForRevision(context.service, (candidate) => candidate.status === "applied");
      yield* Effect.promise(() => removePath(context.configPath));
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "defaults",
      );
      expect(state.config.tokens.color.background).toBeNull();
      expect(state.overrideDocument).toBeNull();
    }),
  );

  it.live("applies native minimums when the layout changes", () =>
    runTest({}, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(
          context.configPath,
          layoutOnlyDocument({
            mainWindow: { minWidth: 900, minHeight: 700, defaultWidth: 1200, defaultHeight: 800 },
          }),
        ),
      );
      yield* waitForRevision(
        context.service,
        (candidate) => candidate.config.layout.mainWindow.minWidth === 900,
      );
      const sawMinimum = () =>
        context.minimums.some((minimum) => minimum.width === 900 && minimum.height === 700);
      yield* waitForCondition(sawMinimum);
      expect(sawMinimum()).toBe(true);
    }),
  );

  it.live("retains a content-addressed artifact for every applied external revision", () =>
    runTest({}, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { background: "#101418" } })),
      );
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "applied",
      );
      const artifactPath = joinArtifactPath(context.artifactDirectory, state.digest);
      const artifact = yield* Effect.promise(() => readDisk(artifactPath));
      expect(artifact).not.toBeNull();
      expect(artifact).toContain("#101418");
    }),
  );

  it.live("keeps last-valid when artifact retention fails and recovers when storage returns", () =>
    runTest({ blockArtifacts: true }, function* (context) {
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { text: "#f4f4f5" } })),
      );
      const refused = yield* waitForRevision(
        context.service,
        (candidate) => candidate.status === "invalid" && candidate.error?.kind === "io",
      );
      // The valid external edit was not applied while storage was broken.
      expect(refused.config.tokens.color.text).toBeNull();

      yield* Effect.promise(() => removePath(context.artifactDirectory, { force: true }));
      // Same content: the uncommitted observation retries and recovers.
      const state = yield* context.service.reload;
      expect(state.status).toBe("applied");
      expect(state.config.tokens.color.text).toBe("#f4f4f5");
      expect(state.error).toBeNull();
    }),
  );

  it.live(
    "applies an external edit but surfaces an audit I/O failure instead of a clean audit",
    () =>
      runTest({ makeAuditPathUnwritable: true }, function* (context) {
        yield* Effect.promise(() =>
          atomicWrite(context.configPath, overrideDocument({ color: { surface: "#fafafa" } })),
        );
        const state = yield* waitForRevision(
          context.service,
          (candidate) => candidate.status === "applied",
        );
        expect(state.config.tokens.color.surface).toBe("#fafafa");
        expect(state.error?.kind).toBe("io");
        expect(state.error?.message).toContain("audit");
      }),
  );

  it.live("stops watching after disposal", () =>
    runTest({}, function* (context) {
      const before = yield* context.service.getState;
      yield* context.service.dispose;
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { background: "#101418" } })),
      );
      yield* Effect.sleep(400);
      const state = yield* context.service.getState;
      expect(state.revision).toBe(before.revision);
      // Intentional dispose publishes no error state at all.
      expect(state.error).toBeNull();
      expect(state.status).toBe(before.status);
    }),
  );

  it.live("publishes a visible I/O error when the watcher fails, keeping last-valid", () => {
    const seam = makeSwitchableWatchFileSystem();
    seam.setWatchFailing(true);
    return runTest(
      {
        seedConfig: overrideDocument({ color: { background: "#101418" } }),
        fileSystemLayer: seam.layer,
      },
      function* (context) {
        const applied = yield* context.service.getState;
        expect(applied.status).toBe("applied");
        // The dying watcher surfaces monotonically as an I/O error while
        // the last-valid configuration (and disk bytes) survive.
        const errored = yield* waitForRevision(
          context.service,
          (candidate) => candidate.status === "invalid" && candidate.error?.kind === "io",
        );
        expect(errored.error?.message).toContain("watcher stopped");
        expect(errored.revision).toBeGreaterThan(applied.revision);
        expect(errored.config.tokens.color.background).toBe("#101418");
        expect(yield* Effect.promise(() => readDisk(context.configPath))).toContain("#101418");
      },
    );
  });

  it.live("reattaches the watch on explicit reload and clears the stopped diagnostic", () => {
    const seam = makeSwitchableWatchFileSystem();
    seam.setWatchFailing(true);
    return runTest({ fileSystemLayer: seam.layer }, function* (context) {
      const errored = yield* waitForRevision(
        context.service,
        (candidate) => candidate.error?.message.includes("watcher stopped") === true,
      );
      expect(errored.error).not.toBeNull();

      // Explicit Reload recovery: the watch is armed again on the
      // configured directory and the diagnostic clears.
      seam.setWatchFailing(false);
      const recovered = yield* context.service.reload;
      expect(recovered.error).toBeNull();
      expect(recovered.revision).toBeGreaterThan(errored.revision);

      // The reattached watch publishes real external edits again.
      yield* Effect.promise(() =>
        atomicWrite(context.configPath, overrideDocument({ color: { text: "#f4f4f5" } })),
      );
      const state = yield* waitForRevision(
        context.service,
        (candidate) => candidate.config.tokens.color.text === "#f4f4f5",
      );
      expect(state.error).toBeNull();
    });
  });
});

describe("desktop presentation sender validation", () => {
  it.effect("only trusts explicitly registered renderer senders", () =>
    runTest({ watch: false }, function* (context) {
      expect(context.service.isTrustedSender(1)).toBe(false);
      yield* context.service.registerTrustedSender(1);
      expect(context.service.isTrustedSender(1)).toBe(true);
      yield* context.service.unregisterTrustedSender(1);
      expect(context.service.isTrustedSender(1)).toBe(false);
    }),
  );

  it.effect(
    "reference-counts overlapping subscriptions so a stale unsubscribe keeps the newer one",
    () =>
      runTest({ watch: false }, function* (context) {
        // StrictMode: subscribe (gen 1), subscribe (gen 2), unsubscribe (gen 1).
        yield* context.service.registerTrustedSender(7);
        yield* context.service.registerTrustedSender(7);
        yield* context.service.unregisterTrustedSender(7);
        expect(context.service.isTrustedSender(7)).toBe(true);
        yield* context.service.unregisterTrustedSender(7);
        expect(context.service.isTrustedSender(7)).toBe(false);
        // Unregistering an unknown sender is a no-op.
        yield* context.service.unregisterTrustedSender(7);
        expect(context.service.isTrustedSender(7)).toBe(false);
      }),
  );
});

describe("desktop presentation home isolation", () => {
  it.effect("never resolves state from the operator's real home", () =>
    runTest({ watch: false }, function* (context) {
      const state = yield* context.service.getState;
      expect(state.location).toBe(context.configPath);
      expect(state.location).not.toBe(realHomePresentationConfigPath());
    }),
  );
});

function waitForRevision(
  service: DesktopPresentation.DesktopPresentation["Service"],
  predicate: (state: PresentationAppliedState) => boolean,
  maxAttempts = 200,
): Effect.Effect<PresentationAppliedState> {
  const loop = (attempt: number): Effect.Effect<PresentationAppliedState> =>
    service.getState.pipe(
      Effect.filterOrElse(predicate, () =>
        Effect.sleep(25).pipe(
          Effect.flatMap(() =>
            attempt <= 0 ? Effect.die("waitForRevision timed out") : loop(attempt - 1),
          ),
        ),
      ),
    );
  return Effect.orDie(loop(maxAttempts));
}

function waitForCondition(predicate: () => boolean, maxAttempts = 200): Effect.Effect<void> {
  const loop = (attempt: number): Effect.Effect<void> =>
    Effect.suspend(() =>
      predicate()
        ? Effect.void
        : Effect.sleep(25).pipe(
            Effect.flatMap(() =>
              attempt <= 0 ? Effect.die("waitForCondition timed out") : loop(attempt - 1),
            ),
          ),
    );
  return Effect.orDie(loop(maxAttempts));
}
