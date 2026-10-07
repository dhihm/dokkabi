// @effect-diagnostics nodeBuiltinImport:off
/**
 * Behavioral gate tests for the shared workspace-lifecycle authority at the
 * REAL service entry points: TerminalManager (open/attach-create/write/
 * restart incl. a dormant restart), WorkspaceFileSystem.writeFile (incl.
 * symlink editor targets), and the policy's own fail-closed
 * canonicalization. Reactor-level gates with mutator spies live in
 * CheckpointReactor.test.ts / ProviderCommandReactor.test.ts (same claiming
 * fixtures). Durable lease-store behavior lives in
 * WorkspaceLifecycleOwnership.lease.test.ts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import {
  WorkspaceLifecycleOwnership,
  WorkspaceOwnershipError,
  WorkspaceLifecycleOwnershipLive,
} from "./WorkspaceLifecycleOwnership.ts";
import { WorkspaceLifecycleOwnershipClaiming } from "./WorkspaceLifecycleOwnership.testFixtures.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ServerConfig from "../../config.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../../processRunner.ts";
import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";

const NodeServicesLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const isWorkspaceOwnershipError = Schema.is(WorkspaceOwnershipError);

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

/** A fake enabled harness instance claiming exact roots. */
const registryClaiming = (roots: string[]) => {
  const instance = {
    instanceId: undefined as never,
    driverKind: undefined as never,
    continuationIdentity: undefined as never,
    displayName: undefined,
    accentColor: undefined,
    enabled: true,
    snapshot: undefined as never,
    adapter: {
      provider: undefined as never,
      capabilities: {
        sessionModelSwitch: "unsupported",
        workspaceLifecycle: "harness",
        workspaceRoots: roots,
      },
    } as never,
    textGeneration: undefined as never,
  };
  return Layer.succeed(
    ProviderInstanceRegistry,
    ProviderInstanceRegistry.of({
      getInstance: () => Effect.succeed(instance),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Effect.never as never,
      subscribeChanges: Effect.die("not implemented") as never,
    }),
  );
};

const policyClaiming = (roots: string[], baseDir: string) =>
  WorkspaceLifecycleOwnershipLive.pipe(
    Layer.provide(registryClaiming(roots)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    // The policy layer (and layerTest's derivation) need platform services
    // INSIDE this build, not around the consuming effect.
    Layer.provide(NodeServices.layer),
  );

describe("WorkspaceLifecycleOwnershipLive (real canonicalization)", () => {
  effectIt.effect("zero active sessions with an enabled configured root still claims it", () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(() => makeTempDir("dk-policy-root-"));
      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyClaiming([root], makeTempDir("dk-lease-"))),
      );
      const inside = NodePath.join(root, "nested", "new-file.ts");
      expect(yield* ownership.pathIsHarnessOwned(inside)).toBe(true);
      expect(yield* ownership.pathIsHarnessOwned(root)).toBe(true);
    }),
  );

  effectIt.effect(
    "symlink aliases into the claimed root are protected; lexical lookalike siblings are not",
    () =>
      Effect.gen(function* () {
        const root = makeTempDir("dk-policy-symlink-");
        const inside = NodePath.join(root, "inner");
        NodeFS.mkdirSync(inside);
        const alias = `${root}-alias`;
        NodeFS.symlinkSync(root, alias, "dir");
        tempDirs.push(alias);
        const sibling = `${root}-sibling`;
        NodeFS.mkdirSync(sibling);
        tempDirs.push(sibling);

        const ownership = yield* WorkspaceLifecycleOwnership.pipe(
          Effect.provide(policyClaiming([root], makeTempDir("dk-lease-"))),
        );
        // Alias resolves INTO the claimed root.
        expect(yield* ownership.pathIsHarnessOwned(NodePath.join(alias, "inner"))).toBe(true);
        // Exact lexical sibling stays allowed.
        expect(yield* ownership.pathIsHarnessOwned(sibling)).toBe(false);
        void inside;
      }),
  );

  effectIt.effect("a missing claimed root fails closed — never a silent no-claim", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(makeTempDir("dk-policy-missing-"), "does-not-exist");
      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyClaiming([missing], makeTempDir("dk-lease-"))),
      );
      const result = yield* ownership.harnessOwnedRoots.pipe(
        Effect.map((roots): { ok: true; roots: ReadonlyArray<string> } => ({ ok: true, roots })),
        Effect.catch((error): Effect.Effect<{ ok: false; error: unknown }, never> =>
          Effect.succeed({ ok: false, error }),
        ),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(isWorkspaceOwnershipError(result.error)).toBe(true);
      }
      // Path decisions fail closed too (the claim cannot be established).
      const pathDecision = yield* ownership.pathIsHarnessOwned(NodePath.join(missing, "x")).pipe(
        Effect.map((): boolean => false),
        Effect.orElseSucceed((): boolean => true),
      );
      expect(pathDecision).toBe(true);
    }),
  );

  effectIt.effect("a dangling symlink refuses rather than appearing safe", () =>
    Effect.gen(function* () {
      const root = makeTempDir("dk-policy-dangling-");
      const dangling = NodePath.join(root, "dangling-link");
      NodeFS.symlinkSync(NodePath.join(root, "gone-target"), dangling, "file");
      const ownership = yield* WorkspaceLifecycleOwnership.pipe(
        Effect.provide(policyClaiming([root], makeTempDir("dk-lease-"))),
      );
      const decision = yield* ownership.pathIsHarnessOwned(dangling).pipe(
        Effect.map((): boolean => false),
        Effect.orElseSucceed((): boolean => true),
      );
      expect(decision).toBe(true);
    }),
  );
});

/** Mutable policy double: flip ownership after a session exists. */
function mutablePolicy(claim: { roots: string[] }) {
  return Layer.succeed(
    WorkspaceLifecycleOwnership,
    WorkspaceLifecycleOwnership.of({
      harnessOwnedRoots: Effect.sync(() => [...claim.roots]),
      instanceIsHarnessOwned: () => Effect.sync(() => claim.roots.length > 0),
      pathIsHarnessOwned: (target: string) =>
        Effect.sync(() =>
          claim.roots.some((root) => {
            const relative = NodePath.relative(root, target);
            return (
              relative === "" ||
              (!NodePath.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${NodePath.sep}`))
            );
          }),
        ),
    }),
  );
}

/**
 * Deterministic PTY lifecycle fake (the canonical Manager.test.ts shape):
 * spawn is observable, kill records signals, and listeners can be driven
 * explicitly. Inert kill/onExit doubles hang real teardown paths, so gate
 * tests use the same observable process as the canonical suite.
 */
class GatePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  exited = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
  }

  onData(): () => void {
    return () => {};
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    this.exited = true;
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class GatePtyAdapter {
  readonly spawns = vi.fn();
  readonly processes: GatePtyProcess[] = [];
  private nextPid = 7000;

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    return Effect.sync(() => {
      this.spawns(input);
      const process = new GatePtyProcess(this.nextPid++);
      this.processes.push(process);
      return process;
    });
  }
}

describe("terminal mutation gates (real TerminalManager)", () => {
  /** Resolve a policy layer into the service value makeWithOptions wants. */
  const ownershipFromLayer = (policy: Layer.Layer<WorkspaceLifecycleOwnership>) =>
    Effect.provide(Effect.service(WorkspaceLifecycleOwnership), policy);

  /**
   * Poll the manager until an EXISTING session reaches a status.
   * attachStream without cwd never creates or restarts a session, and the
   * snapshot event carries the authoritative status.
   */
  const waitForTerminalStatus = (
    manager: TerminalManager.TerminalManager["Service"],
    threadId: string,
    terminalId: string,
    status: string,
  ) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + 5_000;
      for (;;) {
        let latest: string | undefined;
        yield* manager.attachStream({ threadId, terminalId }, (event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") {
              latest = event.snapshot.status;
            }
          }),
        );
        if (latest === status) return;
        if ((yield* Clock.currentTimeMillis) > deadline) {
          return yield* Effect.die(new Error(`terminal status did not become ${status}`));
        }
        yield* Effect.sleep("10 millis");
      }
    });

  effectIt.live(
    "open and attach-stream creation refuse in a claimed root; zero process spawns",
    () =>
      Effect.gen(function* () {
        const root = makeTempDir("dk-terminal-gate-");
        const claim = { roots: [] as string[] };
        const pty = new GatePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: NodePath.join(makeTempDir("dk-terminal-logs-"), "terminals"),
          ptyAdapter: pty,
          workspaceOwnership: yield* ownershipFromLayer(mutablePolicy(claim)),
          processKillGraceMs: 1,
        }).pipe(Effect.provide(NodeServicesLayer));

        claim.roots.push(root);
        const threadId = "thread-dk-gate";
        const openFailure = yield* Effect.flip(
          manager.open({
            threadId,
            terminalId: "t1",
            cwd: NodePath.join(root, "inner"),
          }),
        );
        expect((openFailure as { _tag?: string })._tag).toBe("TerminalWorkspaceOwnershipError");

        const attachFailure = yield* Effect.flip(
          manager.attachStream({ threadId, terminalId: "t2", cwd: root }, () => Effect.void),
        );
        expect((attachFailure as { _tag?: string })._tag).toBe("TerminalWorkspaceOwnershipError");
        // Zero mutator calls: the pty never spawned a process.
        expect(pty.spawns).not.toHaveBeenCalled();

        // A sibling workspace stays allowed (the process does spawn).
        claim.roots.length = 0;
        const sibling = makeTempDir("dk-terminal-sibling-");
        const siblingOpen = yield* manager.open({ threadId, terminalId: "t3", cwd: sibling });
        expect(pty.spawns).toHaveBeenCalledTimes(1);
        expect(["starting", "running"]).toContain(siblingOpen.status);
      }).pipe(Effect.scoped),
  );

  effectIt.live(
    "write and restart refuse a session whose cwd became claimed; dormant restart too",
    () =>
      Effect.gen(function* () {
        const root = makeTempDir("dk-terminal-dormant-");
        const claim = { roots: [] as string[] };
        const pty = new GatePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: NodePath.join(makeTempDir("dk-terminal-logs-"), "terminals"),
          ptyAdapter: pty,
          workspaceOwnership: yield* ownershipFromLayer(mutablePolicy(claim)),
          processKillGraceMs: 1,
        }).pipe(Effect.provide(NodeServicesLayer));

        const threadId = "thread-dk-dormant";
        // Create the session BEFORE the claim (the only way one can exist).
        const opened = yield* manager.open({
          threadId,
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: root,
        });
        expect(["starting", "running"]).toContain(opened.status);
        const spawned = pty.processes[0]!;

        claim.roots.push(root);

        // Input to a claimed workspace is refused before the pty sees bytes.
        const writeFailure = yield* Effect.flip(
          manager.write({ threadId, terminalId: DEFAULT_TERMINAL_ID, data: "ls\n" }),
        );
        expect((writeFailure as { _tag?: string })._tag).toBe("TerminalWorkspaceOwnershipError");
        expect(spawned.writes).toEqual([]);

        // Restart of the live session refuses before stopping/respawning it.
        const restartFailure = yield* Effect.flip(
          manager.restart({
            threadId,
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: root,
            cols: 80,
            rows: 24,
          }),
        );
        expect((restartFailure as { _tag?: string })._tag).toBe("TerminalWorkspaceOwnershipError");
        expect(spawned.killSignals).toEqual([]);

        // A dormant (exited) session restart in the claimed root refuses too.
        claim.roots.length = 0;
        spawned.emitExit({ exitCode: 0, signal: null });
        yield* waitForTerminalStatus(manager, threadId, DEFAULT_TERMINAL_ID, "exited");
        claim.roots.push(root);
        const dormantRestartFailure = yield* Effect.flip(
          manager.restart({
            threadId,
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: root,
            cols: 80,
            rows: 24,
          }),
        );
        expect((dormantRestartFailure as { _tag?: string })._tag).toBe(
          "TerminalWorkspaceOwnershipError",
        );
        // Exactly one spawn ever: every refused path ran before pty effects.
        expect(pty.spawns).toHaveBeenCalledTimes(1);
      }).pipe(Effect.scoped),
  );
});

describe("workspace editor write gate (real WorkspaceFileSystem)", () => {
  /** The Live policy builds with a PlatformError channel; fixtures are never. */
  type PolicyLayer = Layer.Layer<WorkspaceLifecycleOwnership, PlatformError.PlatformError>;

  const makeLayer = (policy: PolicyLayer) =>
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(Layer.mergeAll(WorkspacePaths.layer, policy)),
      Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
      Layer.provideMerge(VcsDriverRegistry.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(NodeServicesLayer),
    );

  const provideLayer = <A, E>(
    effect: Effect.Effect<A, E, WorkspaceFileSystem.WorkspaceFileSystem>,
    policy: PolicyLayer,
  ) => Effect.provide(effect, makeLayer(policy));

  effectIt.effect(
    "writeFile refuses inside a claimed root; reads stay available; sibling allowed",
    () =>
      Effect.gen(function* () {
        const claimed = makeTempDir("dk-wsfs-claimed-");
        const sibling = makeTempDir("dk-wsfs-sibling-");
        NodeFS.writeFileSync(NodePath.join(claimed, "keep.txt"), "original\n");
        const fs = yield* provideLayer(
          Effect.service(WorkspaceFileSystem.WorkspaceFileSystem),
          WorkspaceLifecycleOwnershipClaiming([claimed]),
        );

        const refusal = yield* Effect.flip(
          fs.writeFile({ cwd: claimed, relativePath: "keep.txt", contents: "mutated\n" }),
        );
        expect((refusal as { _tag?: string })._tag).toBe("WorkspaceFileOwnershipError");
        expect(NodeFS.readFileSync(NodePath.join(claimed, "keep.txt"), "utf8")).toBe("original\n");

        // Reads remain available in the claimed workspace.
        const read = yield* fs.readFile({ cwd: claimed, relativePath: "keep.txt" });
        expect(read.contents).toBe("original\n");

        // Sibling workspace unaffected.
        const write = yield* fs.writeFile({
          cwd: sibling,
          relativePath: "ok.txt",
          contents: "fine\n",
        });
        expect(write.relativePath).toBe("ok.txt");
      }),
  );

  effectIt.effect(
    "a write target under a claimed subroot is refused even when the outer root is unclaimed",
    () =>
      Effect.gen(function* () {
        const workspace = makeTempDir("dk-wsfs-target-");
        const fs = yield* provideLayer(
          Effect.service(WorkspaceFileSystem.WorkspaceFileSystem),
          WorkspaceLifecycleOwnershipClaiming([NodePath.join(workspace, "sub")]),
        );
        const inside = yield* Effect.flip(
          fs.writeFile({
            cwd: workspace,
            relativePath: "sub/new.txt",
            contents: "x\n",
          }),
        );
        expect((inside as { _tag?: string })._tag).toBe("WorkspaceFileOwnershipError");
        // The unclaimed sibling directory of the subroot stays writable.
        const outside = yield* fs.writeFile({
          cwd: workspace,
          relativePath: "elsewhere/new.txt",
          contents: "fine\n",
        });
        expect(outside.relativePath).toBe("elsewhere/new.txt");
      }),
  );

  effectIt.effect(
    "the ACTUAL symlink editor target decides: into the claimed root refuses, out of it stays allowed",
    () =>
      Effect.gen(function* () {
        const claimed = makeTempDir("dk-wsfs-link-target-");
        const workspace = makeTempDir("dk-wsfs-link-ws-");
        NodeFS.mkdirSync(NodePath.join(workspace, "app-area"));
        NodeFS.writeFileSync(NodePath.join(claimed, "harness-file.txt"), "harness\n");
        NodeFS.writeFileSync(NodePath.join(workspace, "app-area", "app-file.txt"), "app\n");
        // Two editor entries from the UNCLAIMED workspace root: one symlink
        // resolves INTO the claimed root, one stays inside the workspace.
        NodeFS.symlinkSync(
          NodePath.join(claimed, "harness-file.txt"),
          NodePath.join(workspace, "into-harness.txt"),
          "file",
        );
        NodeFS.symlinkSync(
          NodePath.join(workspace, "app-area", "app-file.txt"),
          NodePath.join(workspace, "inside.txt"),
          "file",
        );
        // The REAL policy canonicalizes the write target: the claiming fixture
        // is lexical and cannot prove symlink-target authority.
        const fs = yield* provideLayer(
          Effect.service(WorkspaceFileSystem.WorkspaceFileSystem),
          policyClaiming([claimed], makeTempDir("dk-lease-")),
        );

        const intoHarness = yield* Effect.flip(
          fs.writeFile({
            cwd: workspace,
            relativePath: "into-harness.txt",
            contents: "smuggled\n",
          }),
        );
        expect((intoHarness as { _tag?: string })._tag).toBe("WorkspaceFileOwnershipError");
        expect(NodeFS.readFileSync(NodePath.join(claimed, "harness-file.txt"), "utf8")).toBe(
          "harness\n",
        );

        const inside = yield* fs.writeFile({
          cwd: workspace,
          relativePath: "inside.txt",
          contents: "allowed\n",
        });
        expect(inside.relativePath).toBe("inside.txt");
        expect(
          NodeFS.readFileSync(NodePath.join(workspace, "app-area", "app-file.txt"), "utf8"),
        ).toBe("allowed\n");
      }),
  );
});
