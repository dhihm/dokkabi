import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Dokkabi.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Dokkabi.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
  pathLayer: Layer.Layer<Path.Path> = NodePath.layerPosix,
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    // Path comes from pathLayer alone: merging NodeServices.layer here would
    // also provide Path (host semantics), hiding the platform-specific layer
    // under test.
    Layer.provide(Layer.mergeAll(pathLayer, DesktopConfig.layerTest(env))),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
  pathLayer: Layer.Layer<Path.Path> = NodePath.layerPosix,
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(makeEnvironmentLayer(overrides, env, pathLayer)),
  );

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: " /tmp/t3 ",
          T3CODE_COMMIT_HASH: " 0123456789abcdef ",
          T3CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          T3CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          T3CODE_OTLP_METRICS_URL: " http://127.0.0.1:4318/v1/metrics ",
          T3CODE_OTLP_LOGS_URL: " http://127.0.0.1:4318/v1/logs ",
          T3CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
          T3CODE_OTLP_HEADERS: "authorization=Basic%20abc%3D%3D,x-tenant=t3",
          T3CODE_OTLP_PROTOCOL: "http/protobuf",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/t3");
      assert.equal(environment.stateDir, "/tmp/t3/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/t3/userdata/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/t3/userdata/client-settings.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/t3/userdata/saved-environments.json",
      );
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/t3/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3/userdata/browser-artifacts");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.serverRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, "com.dhihm.dokkabi.dev");
      assert.equal(environment.linuxWmClass, "dokkabi-app-dev");
      assert.equal(environment.linuxDesktopEntryName, "com.dhihm.Dokkabi.Development.desktop");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.devRemoteT3ServerEntryPath, Option.some("/remote/server.mjs"));
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.deepEqual(environment.otlpMetricsUrl, Option.some("http://127.0.0.1:4318/v1/metrics"));
      assert.deepEqual(environment.otlpLogsUrl, Option.some("http://127.0.0.1:4318/v1/logs"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
      assert.deepEqual(
        environment.otlpHeaders,
        Option.some({
          authorization: "Basic abc==",
          "x-tenant": "t3",
        }),
      );
      assert.equal(environment.otlpProtocol, "http/protobuf");
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/t3/userdata");
      assert.equal(environment.logDir, "/tmp/t3/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3/userdata/browser-artifacts");
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
      assert.equal(environment.otlpProtocol, "http/json");
    }),
  );

  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("uses the stable desktop entry as the packaged Linux portal identity", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "linux",
        isPackaged: true,
        appPath: "/tmp/.mount_t3code/resources/app.asar",
        resourcesPath: "/tmp/.mount_t3code/resources",
      });

      assert.equal(environment.linuxDesktopEntryName, "com.dhihm.Dokkabi.desktop");
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.dokkabi-app/dev");
      assert.equal(production.stateDir, "/Users/alice/.dokkabi-app/userdata");
    }),
  );

  it.effect("uses a configured app user model id override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_APP_USER_MODEL_ID: " com.dhihm.dokkabi.dev.local ",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.appUserModelId, "com.dhihm.dokkabi.dev.local");
    }),
  );

  it.effect("exposes a trimmed absolute user data dir override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
          T3CODE_DESKTOP_USER_DATA_DIR: " /private/tmp/dokkabi-qa/electron ",
        },
      );

      assert.deepEqual(
        environment.desktopUserDataDirOverride,
        Option.some("/private/tmp/dokkabi-qa/electron"),
      );
    }),
  );

  it.effect("keeps the user data dir override unset for absent or blank values", () =>
    Effect.gen(function* () {
      const absent = yield* makeEnvironment({}, { T3CODE_HOME: "/tmp/t3" });
      const blank = yield* makeEnvironment(
        {},
        { T3CODE_HOME: "/tmp/t3", T3CODE_DESKTOP_USER_DATA_DIR: "   " },
      );

      assert.deepEqual(absent.desktopUserDataDirOverride, Option.none());
      assert.deepEqual(blank.desktopUserDataDirOverride, Option.none());
    }),
  );

  it.effect("refuses a relative user data dir override instead of using operator data", () =>
    Effect.gen(function* () {
      const error = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
          T3CODE_DESKTOP_USER_DATA_DIR: "dokkabi-qa/electron",
        },
      ).pipe(Effect.flip);

      assert.instanceOf(error, Config.ConfigError);
      assert.include(error.message, "T3CODE_DESKTOP_USER_DATA_DIR");
      assert.include(error.message, "dokkabi-qa/electron");
    }),
  );

  it.effect("accepts a Windows drive-absolute override under Windows path semantics", () =>
    Effect.gen(function* () {
      const windowsDrivePath = "C:\\Users\\alice\\dokkabi-qa\\electron";

      const windows = yield* makeEnvironment(
        { platform: "win32" },
        { T3CODE_DESKTOP_USER_DATA_DIR: windowsDrivePath },
        NodePath.layerWin32,
      );
      assert.deepEqual(windows.desktopUserDataDirOverride, Option.some(windowsDrivePath));
    }),
  );

  it.effect("refuses a Windows drive path under POSIX path semantics", () =>
    Effect.gen(function* () {
      const posixError = yield* makeEnvironment(
        {},
        { T3CODE_DESKTOP_USER_DATA_DIR: "C:\\Users\\alice\\dokkabi-qa\\electron" },
      ).pipe(Effect.flip);

      assert.instanceOf(posixError, Config.ConfigError);
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});

describe("Dokkabi downstream isolation", () => {
  it.effect("defaults to Dokkabi identity and independent application state", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();
      assert.equal(environment.branding.baseName, "Dokkabi");
      assert.equal(environment.displayName, "Dokkabi (Alpha)");
      assert.equal(environment.baseDir, "/Users/alice/.dokkabi-app");
      assert.equal(environment.stateDir, "/Users/alice/.dokkabi-app/userdata");
      assert.equal(environment.userDataDirName, "dokkabi-app");
      assert.equal(environment.appUserModelId, "com.dhihm.dokkabi");
    }),
  );
});
