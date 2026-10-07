/** Actual owned launcher + SQLite provider bridge; explicitly selected qualification only. */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type WorkbenchCode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../src/config.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as Analytics from "../src/telemetry/AnalyticsService.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import * as SessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";
import { WorkspaceLifecycleOwnership } from "../src/orchestration/Services/WorkspaceLifecycleOwnership.ts";
import * as Directory from "../src/provider/Services/ProviderSessionDirectory.ts";
import * as Registry from "../src/provider/Services/ProviderAdapterRegistry.ts";
import * as Service from "../src/provider/Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeDokkabiAdapter } from "../src/provider/Layers/DokkabiAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { WorkbenchTransport } from "../src/provider/dokkabi/WorkbenchTransport.ts";

const cryptoService = Crypto.make({
  randomBytes: (length) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm, bytes) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(bytes).digest()),
    ),
});

export const actualRecoveryConfigured = () =>
  Boolean(process.env.DOKKABI_ACTUAL_HARNESS_ROOT && process.env.DOKKABI_ACTUAL_BUN);

/** Runtime evidence is retained even on failed assertions. No credential is serialized. */
export const acquireActualCodeRecovery = Effect.fn("acquireActualCodeRecovery")(function* (
  identity = "a",
) {
  const harnessRoot = process.env.DOKKABI_ACTUAL_HARNESS_ROOT!;
  const bun = process.env.DOKKABI_ACTUAL_BUN!;
  if (!NodePath.isAbsolute(harnessRoot) || !NodePath.isAbsolute(bun))
    return yield* Effect.die("Qualification requires absolute harness and Bun paths.");
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dk-rpc-")));
  const workspace = NodePath.join(root, "project"),
    home = NodePath.join(root, "home"),
    runtimeDirectory = NodePath.join(root, "runtime");
  for (const path of [workspace, home, runtimeDirectory]) NodeFS.mkdirSync(path, { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(workspace, "a.ts"), "export const value = 1;\n");
  // The actual idle collector pauses on invalid policy; no model turn creates it.
  NodeFS.writeFileSync(NodePath.join(workspace, ".dashboardignore"), Buffer.from([0xff]));
  const pairingToken = NodeCrypto.randomBytes(32).toString("base64url");
  const tokenEnv = "DOKKABI_ACTUAL_RECOVERY_PRIVATE_TOKEN";
  const credentialEnvironment = { [tokenEnv]: pairingToken };
  const child = NodeChildProcess.spawn(
    bun,
    [NodePath.join(harnessRoot, "scripts/desktop-child.ts")],
    {
      cwd: "/",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        DOKKABI_HOME: home,
        DOKKABI_PI_AUTH: NodePath.join(home, "absent-auth.json"),
        DOKKABI_ROUTE: "replay",
        DOKKABI_CODE_EVOLUTION_VERSIONS: "1",
        DOKKABI_CODE_EVOLUTION_CAPTURE_PATHS: '["a.ts"]',
        DOKKABI_CODE_EVOLUTION_IDLE: "1",
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8192).split(pairingToken).join("[redacted]");
  });
  child.stdout!.resume();
  child.stdin!.on("error", () => {});
  const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      NodeFS.writeFileSync(NodePath.join(root, "child-stderr.txt"), stderr, { mode: 0o600 });
    }),
  );
  const ready = yield* Effect.promise(
    () =>
      new Promise<{ httpUrl: string; workspace: string }>((resolve, reject) => {
        const stream = child.stdio[3] as NodeStream.Readable;
        let text = "";
        const timer = setTimeout(
          () => reject(new Error("Actual child readiness timed out.")),
          15_000,
        );
        stream.on("data", (chunk) => {
          text += String(chunk);
          if (Buffer.byteLength(text) > 4096) {
            clearTimeout(timer);
            reject(new Error("Actual ready exceeded bound."));
          }
        });
        stream.on("end", () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("Actual child did not publish readiness."));
          }
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stdin!.end(JSON.stringify({ schema: 1, workspace, runtimeDirectory, pairingToken }));
      }),
  );
  if (ready.workspace !== workspace)
    return yield* Effect.die("Actual child ready workspace mismatch.");
  const gatewayUrl = ready.httpUrl.replace(/^http:/, "ws:") + "/ws";
  const transport = new WorkbenchTransport({
    url: new URL(gatewayUrl),
    tokenEnv,
    env: credentialEnvironment,
    requestTimeoutMs: 5000,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => transport.close()));
  const threadId = ThreadId.make(`actual-code-recovery-${identity}`),
    instanceId = ProviderInstanceId.make(`actual-dokkabi-${identity}`);
  const binding = { clientId: `actual-app-code-recovery-${identity}`, threadId };
  const rpc = async (
    method: "workbench.bind" | "workbench.read" | "workbench.record",
    params: unknown,
  ) => {
    const response = await transport.request(method, params);
    if (response.error) throw new Error(transport.redactText(response.error.message));
    return response.result;
  };
  yield* Effect.promise(() =>
    rpc("workbench.bind", { version: 1, ...binding, workspacePath: workspace }),
  );
  const read = (yield* Effect.promise(() => rpc("workbench.read", { version: 1, binding }))) as {
    sessionCursor: WorkbenchCode["sessionCursor"];
    gatewayCursor: WorkbenchCode["gatewayCursor"];
  };
  const adapter = yield* makeDokkabiAdapter(
    {
      enabled: true,
      gatewayUrl,
      tokenEnv,
      env: credentialEnvironment,
      workspacePath: workspace,
      instanceId,
    },
    {
      clientId: binding.clientId,
      pollIntervalMs: 30,
      cancelSettlementWaitMs: 200,
      socketFactory: undefined,
    },
  ).pipe(Effect.provideService(Crypto.Crypto, cryptoService));
  const adapters = new Map([[instanceId, adapter]]);
  const registry: Registry.ProviderAdapterRegistry["Service"] = {
    getByInstance: (id) =>
      adapters.has(id)
        ? Effect.succeed(adapters.get(id)!)
        : Effect.die("Foreign instance in actual qualification."),
    getInstanceInfo: (id) =>
      Effect.succeed({
        instanceId: id,
        driverKind: adapter.provider,
        displayName: undefined,
        enabled: true,
        continuationIdentity: { driverKind: adapter.provider, continuationKey: "actual-recovery" },
      }),
    listInstances: () => Effect.succeed([instanceId]),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  };
  const persistence = SessionRuntime.layer.pipe(
    Layer.provide(
      makeSqlitePersistenceLive(NodePath.join(root, "app.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(persistence));
  const layer = Layer.mergeAll(
    directory,
    makeProviderServiceLive().pipe(
      Layer.provide(directory),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(Registry.ProviderAdapterRegistry, registry)),
      Layer.provide(
        Layer.succeed(WorkspaceLifecycleOwnership, {
          harnessOwnedRoots: Effect.succeed([workspace]),
          instanceIsHarnessOwned: (id) => Effect.succeed(id === instanceId),
          pathIsHarnessOwned: (path) =>
            Effect.succeed(path === workspace || path.startsWith(workspace + "/")),
        }),
      ),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(ServerConfig.layerTest(root, root).pipe(Layer.provide(NodeServices.layer))),
      Layer.provideMerge(Analytics.layerTest),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    ),
  );
  const context = yield* Layer.build(layer);
  const services = yield* Effect.gen(function* () {
    const providerService = Context.get(context, Service.ProviderService);
    const directory = Context.get(context, Directory.ProviderSessionDirectory);
    yield* directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("dokkabi"),
      providerInstanceId: instanceId,
      resumeCursor: {
        binding,
        sessionId: read.sessionCursor.sessionId,
        sessionCursor: read.sessionCursor,
        gatewayCursor: read.gatewayCursor,
      },
    });
    return { providerService, directory };
  });
  const resumeCursor = {
    binding,
    sessionId: read.sessionCursor.sessionId,
    sessionCursor: read.sessionCursor,
    gatewayCursor: read.gatewayCursor,
  };
  return {
    ...services,
    root,
    workspace,
    home,
    runtimeDirectory,
    threadId,
    instanceId,
    binding,
    transport,
    rpc,
    adapter,
    resumeCursor,
    attachPeer: (peer: {
      instanceId: ProviderInstanceId;
      threadId: ThreadId;
      adapter: typeof adapter;
      resumeCursor: unknown;
    }) =>
      Effect.gen(function* () {
        adapters.set(peer.instanceId, peer.adapter);
        yield* services.directory.upsert({
          threadId: peer.threadId,
          provider: peer.adapter.provider,
          providerInstanceId: peer.instanceId,
          resumeCursor: peer.resumeCursor,
        });
      }),
    snapshot: () => services.providerService.getWorkbenchCode(threadId, {}),
    events: () =>
      Effect.sync(() =>
        NodeFS.readFileSync(
          NodePath.join(home, "sessions", read.sessionCursor.sessionId, "events.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                name: string;
                seq: number;
                hash: string;
                payload: Record<string, unknown>;
              },
          ),
      ),
    record: (name: string, value: unknown) =>
      Effect.sync(() =>
        NodeFS.writeFileSync(NodePath.join(root, name), JSON.stringify(value, null, 2), {
          mode: 0o600,
        }),
      ),
    prepareResume: Effect.sync(() =>
      NodeFS.writeFileSync(NodePath.join(workspace, ".dashboardignore"), ""),
    ),
  };
});
