// @effect-diagnostics nodeBuiltinImport:off
/**
 * Durable lease-store tests for WorkspaceLifecycleOwnership: strict closed
 * {version:1, roots:string[]} validation (corruption, wrong version, excess
 * fields, duplicates, invalid roots), ENOENT-only empty start, persistence
 * ordering (admission persists BEFORE decisions), retention across
 * disable/removal/restart, persistence-failure refusal, concurrent
 * admissions, and vanished/retargeted retained roots.
 *
 * Each "restart" is a fresh WorkspaceLifecycleOwnershipLive build over the
 * same state directory — exactly what a process restart sees.
 *
 * @module orchestration/Services/WorkspaceLifecycleOwnership.lease.test
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  WorkspaceLifecycleOwnership,
  WorkspaceOwnershipError,
  WorkspaceLifecycleOwnershipLive,
} from "./WorkspaceLifecycleOwnership.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import { deriveServerPaths } from "../../config.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync("/tmp"), prefix));
  tempDirs.push(dir);
  return NodeFS.realpathSync(dir);
}

interface FixtureInstance {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly roots: ReadonlyArray<string>;
}

/** Map a fixture onto the registry instance fields the policy actually reads. */
const toRegistryInstance = (fixture: FixtureInstance) => ({
  instanceId: fixture.instanceId,
  driverKind: undefined as never,
  continuationIdentity: undefined as never,
  displayName: undefined,
  accentColor: undefined,
  enabled: fixture.enabled,
  snapshot: undefined as never,
  adapter: {
    provider: undefined as never,
    capabilities: {
      sessionModelSwitch: "unsupported",
      workspaceLifecycle: "harness",
      workspaceRoots: [...fixture.roots],
    },
  } as never,
  textGeneration: undefined as never,
});

/** A registry whose contents can change between service builds (config edit). */
const registryWith = (instances: () => ReadonlyArray<FixtureInstance>) =>
  Layer.succeed(
    ProviderInstanceRegistry,
    ProviderInstanceRegistry.of({
      getInstance: (instanceId) =>
        Effect.sync(() => {
          const fixture = instances().find(
            (instance) => instance.instanceId === String(instanceId),
          );
          return fixture === undefined ? undefined : (toRegistryInstance(fixture) as never);
        }),
      listInstances: Effect.sync(
        () => instances().map((fixture) => toRegistryInstance(fixture)) as never,
      ),
      listUnavailable: Effect.succeed([]),
      streamChanges: Effect.never as never,
      subscribeChanges: Effect.die("not implemented") as never,
    }),
  );

/** A fresh policy instance over the given base dir — the restart seam. */
const policyOver = (registry: Layer.Layer<ProviderInstanceRegistry>) => (baseDir: string) =>
  WorkspaceLifecycleOwnershipLive.pipe(
    Layer.provide(registry),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const leasePathFor = (baseDir: string) =>
  Effect.map(
    deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
    ({ stateDir }) => NodePath.join(stateDir, "workspace-ownership-leases.json"),
  );

const harnessInstance = (root: string, enabled = true): FixtureInstance => ({
  instanceId: "dk-fixture",
  enabled,
  roots: [root],
});

const expectOwnershipFailure = (effect: Effect.Effect<boolean, WorkspaceOwnershipError>) =>
  effect.pipe(
    Effect.map((): boolean => false),
    Effect.catch((error): Effect.Effect<boolean, never> => {
      expect((error as { _tag?: string })._tag).toBe("WorkspaceOwnershipError");
      return Effect.succeed(true);
    }),
  );

describe("WorkspaceLifecycleOwnership durable leases", () => {
  effectIt.effect.each([
    { name: "truncated JSON", contents: '{"version":1,"roots":[' },
    { name: "wrong version", contents: JSON.stringify({ version: 2, roots: [] }) },
    {
      name: "excess field",
      contents: JSON.stringify({ version: 1, roots: [], foreign: true }),
    },
    {
      name: "duplicate roots",
      contents: (root: string) => JSON.stringify({ version: 1, roots: [root, root] }),
    },
    {
      name: "relative root",
      contents: JSON.stringify({ version: 1, roots: ["relative/path"] }),
    },
    {
      name: "non-normalized root",
      contents: (root: string) =>
        JSON.stringify({ version: 1, roots: [`${root}${NodePath.sep}..${NodePath.sep}x`] }),
    },
  ] as const)("invalid lease content ($name) fails closed and is never rewritten", (variant) =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-lease-invalid-");
      const baseDir = makeTempDir("dk-lease-base-");
      const leasePath = yield* leasePathFor(baseDir);
      NodeFS.mkdirSync(NodePath.dirname(leasePath), { recursive: true });
      const contents =
        typeof variant.contents === "function" ? variant.contents(root) : variant.contents;
      NodeFS.writeFileSync(leasePath, contents);

      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => [harnessInstance(root, false)]))(baseDir)),
      );
      const refused = yield* expectOwnershipFailure(
        ownership.pathIsHarnessOwned(NodePath.join(root, "file.txt")),
      );
      expect(refused).toBe(true);
      // Fail closed also means fail quiet: the invalid store is never reset.
      expect(NodeFS.readFileSync(leasePath, "utf8")).toBe(contents);
    }),
  );

  effectIt.effect("only ENOENT starts empty; a never-enabled adapter reserves nothing", () =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-lease-disabled-");
      const baseDir = makeTempDir("dk-lease-base-");
      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => [harnessInstance(root, false)]))(baseDir)),
      );

      expect(yield* ownership.instanceIsHarnessOwned(ProviderInstanceId.make("dk-fixture"))).toBe(
        false,
      );
      expect(yield* ownership.pathIsHarnessOwned(NodePath.join(root, "file.txt"))).toBe(false);
      // A never-enabled adapter never creates a lease.
      const leasePath = yield* leasePathFor(baseDir);
      expect(NodeFS.existsSync(leasePath)).toBe(false);
    }),
  );

  effectIt.effect(
    "admission persists the root BEFORE returning true; disable and restart keep protection",
    () =>
      Effect.gen(function* () {
        const root = makeTempDir("dk-lease-admit-");
        const baseDir = makeTempDir("dk-lease-base-");
        const leasePath = yield* leasePathFor(baseDir);
        let instances: ReadonlyArray<FixtureInstance> = [harnessInstance(root)];

        const admitted = yield* WorkspaceLifecycleOwnership.pipe(
          Effect.provide(policyOver(registryWith(() => instances))(baseDir)),
        );
        expect(yield* admitted.instanceIsHarnessOwned(ProviderInstanceId.make("dk-fixture"))).toBe(
          true,
        );
        // Persisted before instanceIsHarnessOwned returned — not lazily on a
        // later path decision.
        expect(NodeFS.existsSync(leasePath)).toBe(true);

        // Config change (disable) plus a FRESH service build (restart): the
        // retained lease still owns the workspace.
        instances = [harnessInstance(root, false)];
        const restarted = yield* WorkspaceLifecycleOwnership.pipe(
          Effect.provide(policyOver(registryWith(() => instances))(baseDir)),
        );
        expect(
          yield* restarted.pathIsHarnessOwned(NodePath.join(root, "brand-new", "file.txt")),
        ).toBe(true);
        expect(yield* restarted.pathIsHarnessOwned(`${root}-sibling`)).toBe(false);
      }),
  );

  effectIt.effect("removal (not just disable) retains the root across a restart", () =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-lease-remove-");
      const baseDir = makeTempDir("dk-lease-base-");
      let instances: ReadonlyArray<FixtureInstance> = [harnessInstance(root)];

      const admitted = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => instances))(baseDir)),
      );
      expect(yield* admitted.instanceIsHarnessOwned(ProviderInstanceId.make("dk-fixture"))).toBe(
        true,
      );

      instances = [];
      const restarted = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => instances))(baseDir)),
      );
      expect(yield* restarted.pathIsHarnessOwned(root)).toBe(true);
    }),
  );

  effectIt.effect("a lease that cannot be persisted refuses the decision", () =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-lease-persist-");
      const secondRoot = makeTempDir("dk-lease-persist-2-");
      const baseDir = makeTempDir("dk-lease-base-");
      const leasePath = yield* leasePathFor(baseDir);
      let instances: ReadonlyArray<FixtureInstance> = [
        { ...harnessInstance(root), instanceId: "dk-a" },
      ];

      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => instances))(baseDir)),
      );
      expect(yield* ownership.instanceIsHarnessOwned(ProviderInstanceId.make("dk-a"))).toBe(true);

      // Make the lease store unwritable: the atomic sibling-temp write must
      // fail, and admitting a NEW root must refuse rather than return true
      // with an unpersisted lease. Restored in `ensuring` so cleanup works.
      NodeFS.chmodSync(NodePath.dirname(leasePath), 0o500);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          instances = [...instances, { instanceId: "dk-b", enabled: true, roots: [secondRoot] }];
          const refused = yield* expectOwnershipFailure(
            ownership.instanceIsHarnessOwned(ProviderInstanceId.make("dk-b")),
          );
          expect(refused).toBe(true);
        }),
        Effect.sync(() => {
          NodeFS.chmodSync(NodePath.dirname(leasePath), 0o700);
        }),
      );
    }),
  );

  effectIt.effect("concurrent admissions of different roots all persist", () =>
    Effect.gen(function* () {
      const rootA = makeTempDir("dk-lease-race-a-");
      const rootB = makeTempDir("dk-lease-race-b-");
      const baseDir = makeTempDir("dk-lease-base-");
      const registry = registryWith(() => [
        { instanceId: "dk-a", enabled: true, roots: [rootA] },
        { instanceId: "dk-b", enabled: true, roots: [rootB] },
      ]);
      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registry)(baseDir)),
      );

      yield* Effect.all(
        [
          ownership.instanceIsHarnessOwned(ProviderInstanceId.make("dk-a")),
          ownership.instanceIsHarnessOwned(ProviderInstanceId.make("dk-b")),
        ],
        { concurrency: "unbounded" },
      );
      const roots = yield* ownership.harnessOwnedRoots;
      expect(roots).toContain(rootA);
      expect(roots).toContain(rootB);
    }),
  );

  effectIt.effect("a vanished retained root fails closed instead of being dropped", () =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-lease-vanish-");
      const baseDir = makeTempDir("dk-lease-base-");
      const admitted = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => [harnessInstance(root)]))(baseDir)),
      );
      expect(yield* admitted.instanceIsHarnessOwned(ProviderInstanceId.make("dk-fixture"))).toBe(
        true,
      );

      NodeFS.rmSync(root, { recursive: true, force: true });
      const restarted = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => [harnessInstance(root, false)]))(baseDir)),
      );
      const refused = yield* expectOwnershipFailure(
        restarted.pathIsHarnessOwned(NodePath.join(root, "file.txt")),
      );
      expect(refused).toBe(true);
    }),
  );

  effectIt.effect("a retargeted (symlink-swapped) retained root fails closed", () =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-lease-retarget-");
      const elsewhere = makeTempDir("dk-lease-elsewhere-");
      const baseDir = makeTempDir("dk-lease-base-");
      const admitted = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => [harnessInstance(root)]))(baseDir)),
      );
      expect(yield* admitted.instanceIsHarnessOwned(ProviderInstanceId.make("dk-fixture"))).toBe(
        true,
      );

      // Swap the physical root for a symlink pointing elsewhere.
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.symlinkSync(elsewhere, root, "dir");
      const restarted = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyOver(registryWith(() => [harnessInstance(root, false)]))(baseDir)),
      );
      const refused = yield* expectOwnershipFailure(
        restarted.pathIsHarnessOwned(NodePath.join(root, "file.txt")),
      );
      expect(refused).toBe(true);
    }),
  );
});
