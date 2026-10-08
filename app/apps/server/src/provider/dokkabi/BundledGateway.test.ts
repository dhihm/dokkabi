// @effect-diagnostics globalTimers:off nodeBuiltinImport:off globalFetch:off
// Tests exercise native child files, deadlines and loopback HTTP with actual Bun children.
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as NodeCrypto from "node:crypto";
import { DokkabiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DokkabiDriver } from "../Drivers/DokkabiDriver.ts";
import { goldenHandshakeResponse } from "./WorkbenchProtocol.testFixtures.ts";
import { acquireBundledGateway, startBundledGateway } from "./BundledGateway.ts";

const bunPath = NodePath.join(NodeOS.homedir(), ".bun", "bin", "bun");
const revision = "a".repeat(40);
const cryptoService = Crypto.make({
  randomBytes: (length) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm, data) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

async function fixture(mode = "ready") {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(process.platform === "darwin" ? "/private/tmp" : NodeOS.tmpdir(), "bg-test-"),
  );
  const resourceRoot = NodePath.join(root, "runtime");
  const workspace = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(NodePath.join(resourceRoot, "bin"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(resourceRoot, "harness", "scripts"), { recursive: true });
  await NodeFSP.mkdir(workspace);
  await NodeFSP.link(await NodeFSP.realpath(bunPath), NodePath.join(resourceRoot, "bin", "bun"));
  const source = `import { writeFileSync, closeSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
    let bootstrap = ''; for await (const chunk of process.stdin) bootstrap += chunk;
    const input = JSON.parse(bootstrap);
    writeFileSync(input.runtimeDirectory + '/gateway.jsonl', JSON.stringify({ pid: process.pid,
      ownerChannel: input.ownerChannel === true, privateToken: /^[A-Za-z0-9_-]{32,256}$/.test(input.pairingToken), argv: process.argv.slice(2),
      inheritedPairing: Object.keys(process.env).some(key => key.startsWith('DOKKABI_BUNDLED_TOKEN_')),
      integrationEnvironment: Object.keys(process.env).filter(key => /^(?:ELECTRON_|T3_|AGENT_DEVICE_|VITE_)/.test(key) || ['NODE_OPTIONS','NODE_PATH','BUN_OPTIONS','BUN_PRELOAD','DOKKABI_BUNDLED_RUNTIME'].includes(key)),
      ordinaryEnvironment: process.env.DOKKABI_TEST_OPERATOR_VALUE, pathHead: process.env.PATH?.split(':')[0], childBunVersion: spawnSync('bun', ['--version'], {encoding:'utf8'}).stdout?.trim() }), { mode: 0o600 });
    writeFileSync(input.workspace + '/fixture-child.json', JSON.stringify({pid:process.pid, runtimeDirectory:input.runtimeDirectory}));
    process.stderr.write(input.pairingToken + ' '.repeat(20000));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === '/crash') { setTimeout(() => process.exit(9), 20); return new Response('crashing'); }
        if (url.pathname === '/health') return new Response('ok');
        const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(value => value.trim());
        if (url.searchParams.has('token') || !protocols.includes('dokkabi.rpc') || !protocols.includes('dokkabi.auth.' + encodeURIComponent(input.pairingToken))) return new Response('denied', {status:401});
        if (server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'dokkabi.rpc' } })) return undefined;
        return new Response('invalid', {status:400});
      },
      websocket: { message(socket, message) {
        const request = JSON.parse(message);
        if (request.method === 'workbench.bind') {
          socket.send(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{ok:true, sessionId:'fixture-session', workspacePath:input.workspace, reconnect:false}}));
          return;
        }
        if (request.method === 'workbench.read') {
          socket.send(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{cards:[], commands:[],state:{busy:false,activeCommandId:null},
            sessionCursor:{sessionId:'fixture-session',seq:0,hash:'a'.repeat(64),generation:'b'.repeat(64)},
            gatewayCursor:{seq:0,hash:'c'.repeat(64),generation:'d'.repeat(64)},resnapshot:false}}));
          return;
        }
        socket.send(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{...${JSON.stringify(goldenHandshakeResponse)}, workspacePath:input.workspace}}));
      } }
    });
    process.on('SIGTERM', () => { server.stop(true); writeFileSync(input.workspace + '/stopped', 'yes'); process.exit(0); });
    const ready = { schema:1, credentialLifetime:"owner-process", httpUrl:'http://127.0.0.1:' + server.port, workspace:input.workspace, runtime:{bunVersion:Bun.version, platform:process.platform, arch:process.arch} };
    const mode = ${JSON.stringify(mode)};
    if (mode === 'missing-owner') delete ready.credentialLifetime;
    if (mode === 'missing-runtime') delete ready.runtime;
    if (mode === 'wrong-bun') ready.runtime.bunVersion = '0.0.0';
    if (mode === 'wrong-platform') ready.runtime.platform = 'incorrect';
    if (mode === 'wrong-arch') ready.runtime.arch = 'incorrect';
    if (mode === 'wrong-workspace') ready.workspace = '/elsewhere';
    if (mode === 'wrong-revision') ready.harnessRevision = 'b'.repeat(40);
    if (mode === 'token-field') ready.pairingToken = input.pairingToken;
    if (mode === 'exit') process.exit(7);
    if (mode !== 'hang') {
      writeFileSync(3, mode === 'oversized' ? 'x'.repeat(4097) : mode === 'malformed' ? 'garbage' :
        mode === 'duplicate' ? JSON.stringify(ready) + '\\n' + JSON.stringify(ready) : JSON.stringify(ready) + '\\n');
      closeSync(3);
    }
  `;
  await NodeFSP.writeFile(NodePath.join(resourceRoot, "harness/scripts/desktop-child.ts"), source);
  const files = [];
  for (const path of ["bin/bun", "harness/scripts/desktop-child.ts"]) {
    const data = await NodeFSP.readFile(NodePath.join(resourceRoot, path));
    files.push({
      path,
      sha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
      size: data.length,
    });
  }
  const manifest = {
    schema: 1,
    platform: HostProcessPlatform.defaultValue(),
    arch: String(HostProcessArchitecture.defaultValue()),
    harnessRevision: revision,
    bunVersion: NodeChildProcess.execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim(),
    entry: "harness/scripts/desktop-child.ts",
    runtime: "bin/bun",
    files,
  };
  await NodeFSP.writeFile(NodePath.join(resourceRoot, "manifest.json"), JSON.stringify(manifest));
  return { resourceRoot, workspace, root, manifest, runtimeRoot: NodePath.join(root, "retained") };
}

const httpUrl = (gatewayUrl: string) => gatewayUrl.replace(/^ws:/, "http:").replace(/\/ws$/, "");

async function withFixture<A>(
  body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<A>,
  mode?: string,
) {
  const value = await fixture(mode);
  try {
    return await body(value);
  } finally {
    await NodeFSP.rm(value.root, { recursive: true, force: true });
  }
}

const decodeConfig = Schema.decodeEffect(DokkabiSettings);
const decodeObservation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, runtimeDirectory: Schema.String })),
);
const withFixtureEffect = <A, E, R>(
  body: (input: Awaited<ReturnType<typeof fixture>>) => Effect.Effect<A, E, R>,
  mode?: string,
) =>
  Effect.acquireRelease(
    Effect.promise(() => fixture(mode)),
    (input) => Effect.promise(() => NodeFSP.rm(input.root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(body), Effect.scoped, Effect.provideService(Crypto.Crypto, cryptoService));
const withResourceRoot = <A, E, R>(root: string, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = {
          resources: process.env.DOKKABI_BUNDLED_RUNTIME,
          home: process.env.DOKKABI_HOME,
        };
        process.env.DOKKABI_BUNDLED_RUNTIME = root;
        process.env.DOKKABI_HOME = NodePath.join(root, "..", "isolated-harness-home");
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous.resources === undefined) delete process.env.DOKKABI_BUNDLED_RUNTIME;
          else process.env.DOKKABI_BUNDLED_RUNTIME = previous.resources;
          if (previous.home === undefined) delete process.env.DOKKABI_HOME;
          else process.env.DOKKABI_HOME = previous.home;
        }),
    );
    return yield* body;
  });

describe("bundled gateway admission with actual child processes", () => {
  it("requires an absolute explicit workspace", async () => {
    await expect(
      startBundledGateway({ resourceRoot: "/missing", workspace: "relative" }),
    ).rejects.toThrow("absolute workspace");
  });
  it("starts on loopback port zero with private bootstrap and releases only its own child", () =>
    withFixture(async (input) => {
      const a = await startBundledGateway(input);
      const b = await startBundledGateway(input);
      try {
        expect(a.gatewayUrl).not.toBe(b.gatewayUrl);
        expect(a.runtimeDirectory).not.toBe(b.runtimeDirectory);
        expect(a.tokenEnv).not.toBe(b.tokenEnv);
        expect(a.credentialEnvironment[a.tokenEnv]).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(process.env[a.tokenEnv]).toBeUndefined();
        const observation = JSON.parse(
          await NodeFSP.readFile(NodePath.join(a.runtimeDirectory, "gateway.jsonl"), "utf8"),
        );
        expect(observation).toMatchObject({
          ownerChannel: true,
          privateToken: true,
          argv: [],
          inheritedPairing: false,
        });
        await a.stop();
        expect(a.credentialEnvironment[a.tokenEnv]).toBeUndefined();
        expect(await NodeFSP.readFile(NodePath.join(input.workspace, "stopped"), "utf8")).toBe(
          "yes",
        );
        expect(await (await fetch(httpUrl(b.gatewayUrl) + "/health")).text()).toBe("ok");
        expect(b.failure()).toBeUndefined();
      } finally {
        await a.stop();
        await b.stop();
      }
    }));
  it("removes app and preload controls while retaining operator harness environment", () =>
    withFixture(async (input) => {
      const values = {
        ELECTRON_RUN_AS_NODE: "1",
        T3_TEST_BACKEND_CONTROL: "private-app-control",
        AGENT_DEVICE_TEST: "private-device-control",
        VITE_TEST_CONTROL: "private-build-control",
        NODE_OPTIONS: "--no-warnings",
        NODE_PATH: "/not-a-harness-module-path",
        BUN_OPTIONS: "--no-warnings",
        BUN_PRELOAD: "/not-a-harness-preload",
        DOKKABI_BUNDLED_RUNTIME: input.resourceRoot,
        DOKKABI_TEST_OPERATOR_VALUE: "operator-harness-setting",
      };
      const previous = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, values);
      try {
        const gateway = await startBundledGateway(input);
        try {
          const observation = JSON.parse(
            await NodeFSP.readFile(
              NodePath.join(gateway.runtimeDirectory, "gateway.jsonl"),
              "utf8",
            ),
          );
          expect(observation.integrationEnvironment).toEqual([]);
          expect(observation.ordinaryEnvironment).toBe("operator-harness-setting");
          for (const [key, value] of Object.entries(values)) expect(process.env[key]).toBe(value);
        } finally {
          await gateway.stop();
        }
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }));
  it("exposes the pinned Bun to workspace commands with a restricted system PATH", () =>
    withFixture(async (input) => {
      const previous = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const gateway = await startBundledGateway(input);
        try {
          const observation = JSON.parse(
            await NodeFSP.readFile(
              NodePath.join(gateway.runtimeDirectory, "gateway.jsonl"),
              "utf8",
            ),
          );
          expect(observation.pathHead).toBe(NodePath.join(input.resourceRoot, "bin"));
          expect(observation.childBunVersion).toBe(input.manifest.bunVersion);
          expect(process.env.PATH).toBe("/usr/bin:/bin");
        } finally {
          await gateway.stop();
        }
      } finally {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
      }
    }));
  it.each([
    "missing-owner",
    "missing-runtime",
    "wrong-bun",
    "wrong-platform",
    "wrong-arch",
    "malformed",
    "duplicate",
    "oversized",
    "wrong-workspace",
    "wrong-revision",
    "token-field",
    "exit",
    "hang",
  ])("refuses %s readiness and clears temporary credentials", (mode) =>
    withFixture(async (input) => {
      const before = Object.keys(process.env).filter((key) =>
        key.startsWith("DOKKABI_BUNDLED_TOKEN_"),
      );
      const starting = startBundledGateway({ ...input, readinessTimeoutMs: 150 });
      try {
        await expect(starting).rejects.toThrow(/readiness|exited/);
      } finally {
        await (await starting.catch(() => undefined))?.stop();
      }
      expect(
        Object.keys(process.env).filter((key) => key.startsWith("DOKKABI_BUNDLED_TOKEN_")),
      ).toEqual(before);
    }, mode),
  );
  it.each(["target", "digest", "unsafe", "symlink", "version"])(
    "refuses %s payload before launch",
    (mode) =>
      withFixture(async (input) => {
        if (mode === "target") input.manifest.arch = "incorrect";
        if (mode === "digest") input.manifest.files[1]!.sha256 = "0".repeat(64);
        if (mode === "unsafe") input.manifest.files[1]!.path = "../outside";
        if (mode === "version") input.manifest.bunVersion = "0.0.0";
        if (mode === "symlink") {
          const entry = NodePath.join(input.resourceRoot, input.manifest.entry);
          await NodeFSP.rename(entry, entry + ".real");
          await NodeFSP.symlink(entry + ".real", entry);
        }
        await NodeFSP.writeFile(
          NodePath.join(input.resourceRoot, "manifest.json"),
          JSON.stringify(input.manifest),
        );
        await expect(startBundledGateway(input)).rejects.toThrow(/Bundled/);
      }),
  );
  it("permits verified internal dependency symlinks and refuses escaping links", () =>
    withFixture(async (input) => {
      await NodeFSP.symlink("./bin/bun", NodePath.join(input.resourceRoot, "internal-bun"));
      const gateway = await startBundledGateway(input);
      await gateway.stop();
      await NodeFSP.symlink(input.workspace, NodePath.join(input.resourceRoot, "outside"));
      await expect(startBundledGateway(input)).rejects.toThrow("symlink escapes");
    }));
  it("refuses unmanifested payload files", () =>
    withFixture(async (input) => {
      await NodeFSP.writeFile(NodePath.join(input.resourceRoot, "injected.ts"), "throw 1;");
      await expect(startBundledGateway(input)).rejects.toThrow("inventory");
    }));
  effectIt.live("waits for interrupted acquisition to release the actual child", () =>
    withFixtureEffect(
      (input) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make("sequential");
          const fiber = yield* acquireBundledGateway({ ...input, readinessTimeoutMs: 30_000 }).pipe(
            Scope.provide(scope),
            Effect.forkChild,
          );
          yield* Effect.promise(() =>
            expect
              .poll(async () => {
                try {
                  await NodeFSP.stat(NodePath.join(input.workspace, "fixture-child.json"));
                  return true;
                } catch {
                  return false;
                }
              })
              .toBe(true),
          );
          const observation = yield* decodeObservation(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(input.workspace, "fixture-child.json"), "utf8"),
            ),
          );
          yield* Fiber.interrupt(fiber);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(input.workspace, "stopped"), "utf8"),
            ),
          ).toBe("yes");
          yield* Scope.close(scope, Exit.void);
        }),
      "hang",
    ),
  );
  it("surfaces a crash and never replaces its child", () =>
    withFixture(async (input) => {
      const gateway = await startBundledGateway(input);
      const token = gateway.credentialEnvironment[gateway.tokenEnv]!;
      await fetch(httpUrl(gateway.gatewayUrl) + "/crash");
      await gateway.exited;
      expect(gateway.failure()).toContain("exited");
      expect(gateway.failure()).not.toContain(token);
      expect(gateway.credentialEnvironment[gateway.tokenEnv]).toBe(token);
      await expect(fetch(httpUrl(gateway.gatewayUrl) + "/health")).rejects.toThrow();
      await gateway.stop();
      expect(gateway.credentialEnvironment[gateway.tokenEnv]).toBeUndefined();
    }));
  effectIt.live("releases through its Effect owner scope", () =>
    withFixtureEffect((input) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const gateway = yield* acquireBundledGateway(input).pipe(Scope.provide(scope));
        yield* Scope.close(scope, Exit.void);
        expect(gateway.credentialEnvironment[gateway.tokenEnv]).toBeUndefined();
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(input.workspace, "stopped"), "utf8"),
          ),
        ).toBe("yes");
      }),
    ),
  );
  effectIt.live(
    "does not start a disabled bundled provider and surfaces invalid bundled configuration",
    () =>
      withFixtureEffect((input) =>
        withResourceRoot(
          input.resourceRoot,
          Effect.gen(function* () {
            for (const enabled of [false, true]) {
              const config = yield* decodeConfig({
                runtimeMode: "bundled",
                workspacePath: "relative",
              });
              const snapshot = yield* Effect.scoped(
                DokkabiDriver.create({
                  instanceId: ProviderInstanceId.make("bundled-disabled"),
                  displayName: "Dokkabi",
                  accentColor: undefined,
                  environment: [],
                  enabled,
                  config,
                }).pipe(Effect.flatMap((driver) => driver.snapshot.getSnapshot)),
              );
              expect(snapshot.status).toBe(enabled ? "error" : "disabled");
              if (enabled) expect(snapshot.message).toContain("absolute workspace");
            }
            yield* Effect.promise(() =>
              expect(
                NodeFSP.stat(NodePath.join(input.workspace, "fixture-child.json")),
              ).rejects.toThrow(),
            );
          }),
        ),
      ),
  );
  effectIt.live(
    "supports bundled driver discovery with no URL/token settings and publishes a crash",
    () =>
      withFixtureEffect((input) =>
        withResourceRoot(
          input.resourceRoot,
          Effect.gen(function* () {
            const config = yield* decodeConfig({
              enabled: true,
              runtimeMode: "bundled",
              workspacePath: input.workspace,
            });
            const driver = yield* DokkabiDriver.create({
              instanceId: ProviderInstanceId.make("bundled-test"),
              displayName: "Dokkabi",
              accentColor: undefined,
              environment: [],
              enabled: true,
              config,
            });
            const snapshot = yield* driver.snapshot.getSnapshot;
            expect(snapshot).toMatchObject({
              status: "warning",
              modelReadiness: "unprobed",
              installed: true,
            });
            expect(snapshot.models.map((model) => model.slug)).toEqual(["glm-5.3"]);
            const discoveryOwner = yield* decodeObservation(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(input.workspace, "fixture-child.json"), "utf8"),
              ),
            );
            const session = yield* driver.adapter.startSession({
              threadId: ThreadId.make("bundled-fixture-thread"),
              runtimeMode: "full-access",
              cwd: input.workspace,
            });
            expect(session.status).toBe("ready");
            const observation = yield* decodeObservation(
              yield* Effect.promise(() =>
                NodeFSP.readFile(NodePath.join(input.workspace, "fixture-child.json"), "utf8"),
              ),
            );
            expect(observation.pid).not.toBe(discoveryOwner.pid);
            process.kill(discoveryOwner.pid, "SIGKILL");
            yield* Stream.runCollect(
              driver.snapshot.streamChanges.pipe(
                Stream.filter((snapshot) => snapshot.status === "error"),
                Stream.take(1),
              ),
            );
            expect((yield* driver.snapshot.getSnapshot).status).toBe("error");
            expect((yield* driver.snapshot.refresh).message).toContain("exited");
          }),
        ),
      ),
  );
});
