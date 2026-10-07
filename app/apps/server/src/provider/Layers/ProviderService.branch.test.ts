/**
 * Targeted ProviderService acceptance for the R8 prepared-branch facade
 * (docs/internals/dokkabi-branches-r8.md): startWorkbenchBranch validates
 * the real target through the orchestration read models on BOTH the fresh
 * and the existing-durable-binding path, adopts a confirmed ready child
 * with a durably persisted binding, acknowledges an explicit unknown (never
 * ready) when that persistence fails, reconciles a same source/command
 * retry after confirmed adoption WITHOUT re-sending the start or repeating
 * session.started, reconciles a restart through the recorded durable
 * binding, and refuses foreign durable sources, missing targets, a changed
 * command/recorded child and an unconfirmed application. The durable
 * worktree-metadata publication boundary is exercised with a failing-then-
 * succeeding engine dispatch (including across a restart), and a changed
 * current parent model never rejects the pinned independent child.
 *
 * @module provider/Layers/ProviderService.branch.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  WorkspaceLifecycleOwnership,
  type WorkspaceLifecycleOwnershipShape,
} from "../../orchestration/Services/WorkspaceLifecycleOwnership.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectorDecodeError } from "../../orchestration/Errors.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import {
  FakeGateway,
  gatewayDoubleTsForSeq,
  type FakeCommand,
  type FakeSocket,
} from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const HARNESS_INSTANCE = ProviderInstanceId.make("dokkabi");
const APP_INSTANCE = ProviderInstanceId.make("codex");
const APP_DRIVER = ProviderDriverKind.make("codex");
const TOKEN_ENV = "DOKKABI_BRANCH_SERVICE_TEST_TOKEN";
const PARENT_THREAD = ThreadId.make("thread-branch-parent");
const CHILD_THREAD = ThreadId.make("thread-branch-child");
const CLIENT_ID = "dokkabi-branch-service-test";

process.env[TOKEN_ENV] = "non-secret-test-fixture";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

const tempDirs: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gateway double extension: the R8 decision/checkpoint/branchSession subset,
// mirroring the harness wire (flat checkpoint response, decisionWire snapshot
// envelopes, branchSession routing into an isolated child session).
// ---------------------------------------------------------------------------

interface FakeChildSession {
  readonly id: string;
  readonly sessionId: string;
  /** Mutable so a descriptor-mutation negative can move the child root. */
  workspacePath: string;
  readonly decisionId: string;
  readonly parent: { clientId: string; threadId: string };
  binding: { clientId: string; threadId: string } | undefined;
  readonly generation: string;
  seq: number;
}

interface FakeDecision {
  readonly id: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly recommendation: string;
  readonly rationale: string;
  revision: number;
  selected: { option: string; commandId: string; ref: { seq: number; hash: string } } | null;
  application: { commandId: string; ref: { seq: number; hash: string } } | null;
}

const CHILD_WORKSPACE = "/tmp/dokkabi-fake-child-workspace";
const CHILD_SESSION_ID = "child-fake01";
const CHILD_ID = "child-0001";

class BranchFakeGateway extends FakeGateway {
  /** "drop" loses the start response (the effect happened at the host). */
  startMode: "ready" | "drop" = "ready";
  /**
   * Whether an admitted application's runtime is CONFIRMED: false models the
   * host state "application admitted, execution still unknown" — status then
   * answers the application_pending snapshot instead of a ready child.
   */
  startConfirmed = true;
  /** The pinned child model; falls back to the parent's current model. */
  childModel: string | undefined = undefined;
  readonly child: FakeChildSession = {
    id: CHILD_ID,
    sessionId: CHILD_SESSION_ID,
    workspacePath: CHILD_WORKSPACE,
    decisionId: "dec-1",
    parent: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
    binding: undefined,
    generation: hex64("child-generation-1"),
    seq: 40,
  };
  decision: FakeDecision | undefined;
  private decisionSeq = 10;
  private checkpoints = new Map<string, { seq: number; hash: string }>();

  private readonly decisionWire = (): Record<string, unknown> => {
    const decision = this.decision!;
    return {
      id: decision.id,
      revision: decision.revision,
      state:
        decision.revision === 0
          ? "awaiting"
          : decision.revision === 1
            ? "selected"
            : "application_pending",
      kind: "branch",
      question: decision.question,
      options: decision.options,
      recommendation: decision.recommendation,
      rationale: decision.rationale,
      policy: null,
      openedAt: 0,
      selected:
        decision.selected === null
          ? null
          : {
              option: decision.selected.option,
              actor: "human",
              commandId: decision.selected.commandId,
              at: 0,
              ref: decision.selected.ref,
            },
      application:
        decision.application === null
          ? null
          : {
              commandId: decision.application.commandId,
              state: "unknown",
              ref: decision.application.ref,
            },
      alternateOf: null,
      citations: {
        open: 10,
        selected: decision.selected?.ref.seq ?? null,
        application: decision.application?.ref.seq ?? null,
      },
    };
  };

  private readonly childIdentity = (): Record<string, unknown> => ({
    version: 1,
    workspacePath: this.child.workspacePath,
    sessionId: this.child.sessionId,
    capabilities: {
      submit: true,
      cancel: true,
      read: true,
      detach: true,
      attachments: false,
      continuation: false,
      compaction: false,
      rollback: false,
      approvals: false,
      userInput: false,
      modelChange: false,
    },
    route: this.route,
    ...((this.childModel ?? this.model) !== undefined
      ? { model: this.childModel ?? this.model }
      : {}),
    ready: true,
    routeSource: "kernel",
    permissionMode: this.permissionMode,
    kernelOpen: true,
    ...(this.child.binding !== undefined ? { bound: this.child.binding } : {}),
  });

  private readonly childReadResult = (): Record<string, unknown> => ({
    cards: [
      {
        kind: "system",
        seq: 41,
        ts: gatewayDoubleTsForSeq(41),
        event: "branch/imported",
        text: "imported child context",
      },
    ],
    state: { busy: false, activeCommandId: null },
    commands: [] as ReadonlyArray<FakeCommand>,
    sessionCursor: {
      sessionId: this.child.sessionId,
      seq: this.child.seq,
      hash: hex64(`child-${this.child.generation}-${this.child.seq}`),
      generation: this.child.generation,
    },
    gatewayCursor: { seq: 1, hash: hex64("child-gateway-1"), generation: hex64("child-gateway") },
    resnapshot: false,
  });

  private readonly decisionsView = (): Record<string, unknown> => {
    const items =
      this.decision === undefined
        ? []
        : [
            {
              id: this.decision.id,
              state:
                this.decision.revision === 0
                  ? "awaiting"
                  : this.decision.revision === 1
                    ? "selected"
                    : "application_pending",
              revision: this.decision.revision,
              kind: "branch",
              question: this.decision.question,
              options: this.decision.options,
              recommendation: this.decision.recommendation,
              rationale: this.decision.rationale,
              policy: null,
              selected:
                this.decision.selected === null
                  ? null
                  : {
                      option: this.decision.selected.option,
                      actor: "human",
                      commandId: this.decision.selected.commandId,
                      seq: this.decision.selected.ref.seq,
                    },
              application:
                this.decision.application === null
                  ? null
                  : {
                      commandId: this.decision.application.commandId,
                      state: "unknown",
                      seq: this.decision.application.ref.seq,
                    },
              alternateOf: null,
              citations: {
                open: 10,
                selected: this.decision.selected?.ref.seq ?? null,
                application: this.decision.application?.ref.seq ?? null,
              },
            },
          ];
    // A head at a fixed large seq (same session identity/generation as the
    // parent reads) satisfies the adapter's continuity checks for this view.
    const viewSeq = 10_000;
    return {
      version: 1,
      state: this.decision === undefined ? "missing" : "available",
      ...(this.decision === undefined
        ? { reason: "this session recorded no branch decision rows" }
        : {}),
      decisions: items,
      total: items.length,
      omitted: 0,
      sessionCursor: {
        sessionId: this.sessionId,
        seq: viewSeq,
        hash: hex64(`session-${this.sessionGeneration}-${viewSeq}`),
        generation: this.sessionGeneration,
      },
      gatewayCursor: { seq: 1, hash: hex64("gateway-1"), generation: hex64("gateway-generation") },
      execution: {
        supported: true,
        detail: "prepared conversation only — never applied or verified work",
      },
    };
  };

  private readonly childDescriptor = (): Record<string, unknown> => ({
    id: this.child.id,
    sessionId: this.child.sessionId,
    workspacePath: this.child.workspacePath,
    parent: { ...this.child.parent },
    binding: { clientId: this.child.parent.clientId, threadId: String(CHILD_THREAD) },
  });

  override dispatch(method: string, params: unknown, socket: FakeSocket, requestId: number): void {
    this.requests.push({ method, params });
    const record = params as Record<string, unknown>;
    switch (method) {
      case "workbench.decisions": {
        socket.reply(requestId, { result: this.decisionsView() });
        return;
      }
      case "workbench.checkpoint": {
        if (record.operation === "create") {
          const id = String(record.id);
          const expected = record.expectedSource as { seq: number; hash: string };
          const existing = this.checkpoints.get(id);
          if (
            existing !== undefined &&
            (existing.seq !== expected.seq || existing.hash !== expected.hash)
          ) {
            socket.reply(requestId, {
              error: {
                code: -32603,
                message: "checkpoint refused: same id with a different expected source",
              },
            });
            return;
          }
          this.checkpoints.set(id, { seq: expected.seq, hash: expected.hash });
          socket.reply(requestId, {
            result: {
              version: 1,
              state: "ready",
              id,
              digest: hex64(`checkpoint-${id}-${expected.seq}`),
              source: {
                seq: expected.seq,
                hash: expected.hash,
                generation: Number.parseInt(this.sessionGeneration.slice(0, 8), 16),
              },
              imageDigest: hex64(`image-${id}`),
              inputDigest: hex64(`input-${id}`),
              prefixHash: hex64(`prefix-${id}`),
              coverage: {
                providerInput: "complete",
                workspace_files: "retained",
                git_metadata: "retained",
                external_resources: "unavailable",
                restart_scope: "isolated_materialization",
                decision_execution: "unsupported",
                branch_execution: "unsupported",
              },
            },
          });
          return;
        }
        socket.reply(requestId, {
          error: { code: -32603, message: "checkpoint read is not exercised by this double" },
        });
        return;
      }
      case "workbench.decision": {
        const operation = String(record.operation);
        if (operation === "open") {
          const definition = record.definition as Record<string, unknown>;
          const id = String(definition.id);
          if (this.decision !== undefined && this.decision.id !== id) {
            socket.reply(requestId, {
              error: { code: -32603, message: "decision already opened with different contents" },
            });
            return;
          }
          if (this.decision === undefined) {
            this.decisionSeq += 1;
            this.decision = {
              id,
              question: String(definition.question),
              options: definition.options as FakeDecision["options"],
              recommendation: String(definition.recommendation),
              rationale: String(definition.rationale),
              revision: 0,
              selected: null,
              application: null,
            };
          }
          socket.reply(requestId, {
            result: { version: 1, state: "available", decision: this.decisionWire() },
          });
          return;
        }
        if (operation === "select") {
          const decision = this.decision;
          if (decision === undefined || decision.id !== String(record.id)) {
            socket.reply(requestId, {
              result: { version: 1, state: "unknown", reason: "branch_decision_unknown" },
            });
            return;
          }
          if (decision.selected === null) {
            if (decision.revision !== Number(record.expectedRevision)) {
              socket.reply(requestId, {
                error: { code: -32603, message: "branch_decision_revision_conflict" },
              });
              return;
            }
            this.decisionSeq += 1;
            decision.selected = {
              option: String(record.option),
              commandId: String(record.commandId),
              ref: { seq: this.decisionSeq, hash: hex64(`decision-${this.decisionSeq}`) },
            };
            decision.revision = 1;
          }
          socket.reply(requestId, {
            result: { version: 1, state: "available", decision: this.decisionWire() },
          });
          return;
        }
        if (operation === "start") {
          const decision = this.decision;
          if (decision === undefined || decision.id !== String(record.id)) {
            socket.reply(requestId, {
              result: { version: 1, state: "unknown", reason: "branch_decision_unknown" },
            });
            return;
          }
          if (decision.selected === null) {
            socket.reply(requestId, {
              result: { version: 1, state: "conflict", reason: "branch_runtime_not_selected" },
            });
            return;
          }
          if (decision.application === null) {
            this.decisionSeq += 1;
            decision.application = {
              commandId: String(record.commandId),
              ref: { seq: this.decisionSeq, hash: hex64(`application-${this.decisionSeq}`) },
            };
            decision.revision = 2;
          }
          if (String(record.childThreadId) !== String(CHILD_THREAD)) {
            socket.reply(requestId, {
              error: { code: -32603, message: "child thread mismatch for this recorded child" },
            });
            return;
          }
          if (this.startMode === "drop") {
            this.startMode = "ready";
            socket.drop();
            return;
          }
          socket.reply(requestId, {
            result: {
              version: 1,
              state: "ready",
              decision: this.decisionWire(),
              child: this.childDescriptor(),
            },
          });
          return;
        }
        if (operation === "status") {
          const decision = this.decision;
          if (decision === undefined || decision.id !== String(record.id)) {
            socket.reply(requestId, {
              result: { version: 1, state: "unknown", reason: "branch_decision_unknown" },
            });
            return;
          }
          if (decision.application !== null && this.startConfirmed) {
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "ready",
                decision: this.decisionWire(),
                child: this.childDescriptor(),
              },
            });
            return;
          }
          socket.reply(requestId, {
            result: { version: 1, state: "available", decision: this.decisionWire() },
          });
          return;
        }
        socket.reply(requestId, {
          error: { code: -32602, message: `unknown decision operation ${operation}` },
        });
        return;
      }
      case "workbench.branchSession": {
        const parentBinding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== parentBinding.clientId ||
          this.binding.threadId !== parentBinding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "branchSession refused: parent owner is not bound" },
          });
          return;
        }
        if (String(record.childId) !== this.child.id) {
          socket.reply(requestId, {
            error: { code: -32603, message: "branchSession refused: unknown child id" },
          });
          return;
        }
        const innerMethod = String(record.method);
        const inner = record.params as Record<string, unknown>;
        if (innerMethod === "workbench.handshake") {
          socket.reply(requestId, { result: this.childIdentity() });
          return;
        }
        if (innerMethod === "workbench.bind") {
          if (String(inner.workspacePath) !== this.child.workspacePath) {
            socket.reply(requestId, {
              error: {
                code: -32603,
                message: `workspace mismatch — the child gateway owns ${this.child.workspacePath}`,
              },
            });
            return;
          }
          this.child.binding = {
            clientId: String(inner.clientId),
            threadId: String(inner.threadId),
          };
          socket.reply(requestId, {
            result: {
              ok: true,
              sessionId: this.child.sessionId,
              workspacePath: this.child.workspacePath,
              reconnect: false,
            },
          });
          return;
        }
        if (innerMethod === "workbench.read") {
          socket.reply(requestId, { result: this.childReadResult() });
          return;
        }
        socket.reply(requestId, {
          error: { code: -32601, message: `Method not found: ${innerMethod}` },
        });
        return;
      }
      default:
        super.dispatch(method, params, socket, requestId);
    }
  }

  countDecisionStarts(): number {
    return this.requests.filter(
      (request) =>
        request.method === "workbench.decision" &&
        (request.params as Record<string, unknown>).operation === "start",
    ).length;
  }

  countChildHandshakes(): number {
    return this.requests.filter(
      (request) =>
        request.method === "workbench.branchSession" &&
        (request.params as Record<string, unknown>).method === "workbench.handshake",
    ).length;
  }
}

// ---------------------------------------------------------------------------
// Test stack (mirrors ProviderService.overview.test.ts) plus a projection
// read-model double carrying the parent and target thread shells.
// ---------------------------------------------------------------------------

const ownershipLayer = (input: {
  readonly roots: ReadonlyArray<string>;
  readonly harnessInstances: ReadonlyArray<string>;
}) =>
  Layer.succeed(WorkspaceLifecycleOwnership, {
    harnessOwnedRoots: Effect.succeed(input.roots),
    instanceIsHarnessOwned: (instanceId: ProviderInstanceId) =>
      Effect.succeed(input.harnessInstances.includes(String(instanceId))),
    pathIsHarnessOwned: (path: string) =>
      Effect.succeed(input.roots.some((root) => path === root || path.startsWith(`${root}/`))),
  } satisfies WorkspaceLifecycleOwnershipShape);

const threadShell = (input: {
  readonly id: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly session: boolean;
}): OrchestrationThreadShell =>
  ({
    id: input.id,
    projectId: "proj-branch-1",
    title: "shell",
    modelSelection: { instanceId: String(input.instanceId) },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: input.session ? { status: "running" } : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as unknown as OrchestrationThreadShell;

const projectionLayer = (input: {
  readonly parent: boolean;
  readonly target: boolean;
  readonly targetSession: boolean;
}) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        String(threadId) === String(PARENT_THREAD) && input.parent
          ? Option.some(
              threadShell({ id: PARENT_THREAD, instanceId: HARNESS_INSTANCE, session: true }),
            )
          : String(threadId) === String(CHILD_THREAD) && input.target
            ? Option.some(
                threadShell({
                  id: CHILD_THREAD,
                  instanceId: HARNESS_INSTANCE,
                  session: input.targetSession,
                }),
              )
            : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

const makeStaticRegistry = (
  entries: ReadonlyArray<readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]>,
): ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] => {
  const adapters = new Map(entries);
  return {
    getByInstance: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter
        ? Effect.succeed(adapter)
        : Effect.die(`unknown instance ${String(instanceId)} in the branch test registry`);
    },
    getInstanceInfo: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter
        ? Effect.succeed({
            instanceId,
            driverKind: adapter.provider,
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind: adapter.provider,
              continuationKey: `${adapter.provider}:instance:${String(instanceId)}`,
            },
          })
        : Effect.die(`unknown instance ${String(instanceId)}`);
    },
    listInstances: () => Effect.succeed([...adapters.keys()]),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

/**
 * Engine double for the durable worktree-metadata publication boundary: it
 * records every dispatch and can fail the NEXT thread.meta.update once (the
 * facade must then acknowledge unknown, and an explicit same-source retry
 * must repair it — with no second start or adoption).
 */
interface EngineBehavior {
  failNextMetaUpdate: boolean;
  readonly dispatched: Array<{
    readonly type: string;
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly worktreePath: unknown;
  }>;
}

const engineLayer = (behavior: EngineBehavior) =>
  Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: unknown) =>
      Effect.gen(function* () {
        const record = command as {
          readonly type: string;
          readonly commandId: string;
          readonly threadId: ThreadId;
          readonly worktreePath: unknown;
        };
        if (record.type === "thread.meta.update" && behavior.failNextMetaUpdate) {
          behavior.failNextMetaUpdate = false;
          return yield* Effect.fail(
            new OrchestrationProjectorDecodeError({
              eventType: "thread.meta.updated",
              issue: "engine double injected metadata failure",
            }),
          );
        }
        behavior.dispatched.push(record);
        return { sequence: behavior.dispatched.length };
      }),
  } as unknown as OrchestrationEngineShape);

const buildStack = (input: {
  readonly dbPath: string;
  readonly registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"];
  readonly projection: Parameters<typeof projectionLayer>[0];
  readonly engine?: EngineBehavior;
}) => {
  const repositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(makeSqlitePersistenceLive(input.dbPath).pipe(Layer.provide(NodeServices.layer))),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(repositoryLayer));
  const serviceLayer = Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, input.registry)),
      Layer.provide(directoryLayer),
      Layer.provide(projectionLayer(input.projection)),
      // Always provided: a working engine double records metadata dispatches;
      // tests inject failures through the behavior flag. Without an engine,
      // the facade's metadata publication is skipped entirely.
      Layer.provide(engineLayer(input.engine ?? { failNextMetaUpdate: false, dispatched: [] })),
      Layer.provide(
        ownershipLayer({
          roots: ["/tmp/dokkabi-fake-workspace"],
          harnessInstances: [String(HARNESS_INSTANCE)],
        }),
      ),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    ),
    directoryLayer,
  );
  return serviceLayer;
};

const acquireHarnessAdapter = (
  gateway: BranchFakeGateway,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = Scope.makeUnsafe("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore));
    return yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4175",
        tokenEnv: TOKEN_ENV,
        workspacePath: gateway.workspacePath,
        instanceId: HARNESS_INSTANCE,
      },
      {
        clientId: CLIENT_ID,
        pollIntervalMs: 25,
        cancelSettlementWaitMs: 150,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
  });

import * as Exit from "effect/Exit";

/** Start the PARENT conversation through the real adapter, then record its
 * durable binding — the recorded parent the decision facade resolves. */
const startParentAndRecord = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): Effect.Effect<ProviderSession, ProviderAdapterError> =>
  adapter.startSession({
    threadId: PARENT_THREAD,
    runtimeMode: "full-access",
  } as ProviderSessionStartInput);

describe("ProviderService.startWorkbenchBranch (R8 facade)", () => {
  it.live(
    "adopts a confirmed ready child, persists its binding, and reconciles a same-command retry without a second start",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-branch-ready-"), "orchestration.sqlite");
        const gateway = new BranchFakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(adapter);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: adapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });

          // Open + select + start through the facade.
          const opened = yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Ship the retry loop or the cache first?",
            options: [
              { id: "opt-1", label: "Retry loop" },
              { id: "opt-2", label: "Cache" },
            ],
            recommendation: "opt-1",
            rationale: "The retry loop unblocks the cache work.",
          });
          expect(opened.state).toBe("available");
          const selected = yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          expect(selected.state).toBe("available");

          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("ready");
          expect(started.child?.workspacePath).toBe(CHILD_WORKSPACE);
          expect(started.child?.binding.threadId).toBe(String(CHILD_THREAD));

          // The child binding is durably adopted with the CURRENT adapter
          // snapshot, carrying the recorded child descriptor.
          const childBinding = yield* directory.getBinding(CHILD_THREAD);
          expect(Option.isSome(childBinding)).toBe(true);
          if (Option.isSome(childBinding)) {
            expect(childBinding.value.providerInstanceId).toBe(HARNESS_INSTANCE);
            const cursor = childBinding.value.resumeCursor as Record<string, unknown>;
            expect(cursor.child).toMatchObject({
              id: CHILD_ID,
              sessionId: CHILD_SESSION_ID,
              workspacePath: CHILD_WORKSPACE,
            });
          }

          expect(gateway.countDecisionStarts()).toBe(1);
          const childHandshakesAfterStart = gateway.countChildHandshakes();
          expect(childHandshakesAfterStart).toBe(1);

          // Same source/command retry AFTER confirmed adoption: reconciled
          // from the recorded state — no second start, no repeated child
          // handshake (no repeated session.started or adoption).
          const retried = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(retried.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
          expect(gateway.countChildHandshakes()).toBe(childHandshakesAfterStart);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "acknowledges an explicit unknown (never ready) when the child binding cannot be durably persisted",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-branch-persist-"), "orchestration.sqlite");
        const gateway = new BranchFakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(adapter);
        // Persistence-failure injection: the registry's adapter hides the
        // child from listSessions, so the serialized snapshot boundary sees
        // a missing session and the durable adoption cannot be attested.
        const hidingAdapter: ProviderAdapterShape<ProviderAdapterError> = {
          ...adapter,
          listSessions: () =>
            Effect.map(adapter.listSessions(), (sessions) =>
              sessions.filter((session) => session.threadId !== CHILD_THREAD),
            ),
        };
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, hidingAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: adapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          // The harness prepared the child, but the app adoption is not
          // durable: the answer is an explicit unknown that retains the
          // prepared fact — never an acknowledged ready.
          expect(started.state).toBe("unknown");
          expect(started.reason).toContain("could not durably adopt");
          const childBinding = yield* directory.getBinding(CHILD_THREAD);
          expect(Option.isNone(childBinding)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "reconciles a restart through the recorded durable binding without re-sending the start",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-branch-restart-"), "orchestration.sqlite");
        const gateway = new BranchFakeGateway();
        // First incarnation: adopt the child and persist its durable binding.
        const firstAdapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(firstAdapter);
        const childSnapshotBeforeRestart = yield* Effect.gen(function* () {
          const directoryLayerSeed = ProviderSessionDirectoryLive.pipe(
            Layer.provide(
              ProviderSessionRuntime.layer.pipe(
                Layer.provide(
                  makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
                ),
              ),
            ),
          );
          return yield* Effect.gen(function* () {
            const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
            yield* directory.upsert({
              threadId: PARENT_THREAD,
              provider: firstAdapter.provider,
              providerInstanceId: HARNESS_INSTANCE,
              runtimeMode: "full-access",
              status: "running",
              resumeCursor: parentSession.resumeCursor,
            });
            yield* firstAdapter.createWorkbenchDecision!(
              PARENT_THREAD,
              {
                id: "dec-1",
                question: "Which cut first?",
                options: [
                  { id: "opt-1", label: "A" },
                  { id: "opt-2", label: "B" },
                ],
                recommendation: "opt-1",
                rationale: "A unblocks B.",
              },
              parentSession.resumeCursor,
            );
            yield* firstAdapter.selectWorkbenchDecision!(
              PARENT_THREAD,
              {
                id: "dec-1",
                commandId: "decision-select-test",
                expectedRevision: 0,
                option: "opt-1",
              },
              parentSession.resumeCursor,
            );
            const started = yield* firstAdapter.startWorkbenchBranch!(
              PARENT_THREAD,
              {
                id: "dec-1",
                commandId: "decision-start-test",
                expectedRevision: 1,
                childThreadId: CHILD_THREAD,
              },
              parentSession.resumeCursor,
            );
            expect(started.state).toBe("ready");
            const childSnapshot = (yield* firstAdapter.listSessions()).find(
              (session) => session.threadId === CHILD_THREAD,
            );
            expect(childSnapshot?.resumeCursor).toBeDefined();
            yield* directory.upsert({
              threadId: CHILD_THREAD,
              provider: firstAdapter.provider,
              providerInstanceId: HARNESS_INSTANCE,
              runtimeMode: "full-access",
              status: "running",
              resumeCursor: childSnapshot!.resumeCursor,
            });
          }).pipe(Effect.scoped, Effect.provide(directoryLayerSeed));
        });
        void childSnapshotBeforeRestart;

        // Second incarnation over the same gateway (host state survives the
        // app restart; the app's live adapter state does not).
        const secondAdapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, secondAdapter]]),
          projection: { parent: true, target: true, targetSession: true },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("ready");
          expect(started.child?.sessionId).toBe(CHILD_SESSION_ID);
          // Exactly ONE start ever reached the host across both incarnations.
          expect(gateway.countDecisionStarts()).toBe(1);
          // The restart adoption performed exactly one fresh child handshake.
          expect(gateway.countChildHandshakes()).toBe(2);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live("refuses a foreign durable source on the target and a missing target thread", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-branch-negative-"), "orchestration.sqlite");
      const gateway = new BranchFakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const parentSession = yield* startParentAndRecord(adapter);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        projection: { parent: true, target: true, targetSession: false },
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: PARENT_THREAD,
          provider: adapter.provider,
          providerInstanceId: HARNESS_INSTANCE,
          runtimeMode: "full-access",
          status: "running",
          resumeCursor: parentSession.resumeCursor,
        });
        yield* service.createWorkbenchDecision(PARENT_THREAD, {
          id: "dec-1",
          question: "Which cut first?",
          options: [
            { id: "opt-1", label: "A" },
            { id: "opt-2", label: "B" },
          ],
          recommendation: "opt-1",
          rationale: "A unblocks B.",
        });
        yield* service.selectWorkbenchDecision(PARENT_THREAD, {
          id: "dec-1",
          commandId: "decision-select-test",
          expectedRevision: 0,
          option: "opt-1",
        });

        // Foreign durable source on the target: refuse, no start sent.
        yield* directory.upsert({
          threadId: CHILD_THREAD,
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
          status: "stopped",
          resumeCursor: {
            binding: { clientId: "other", threadId: String(CHILD_THREAD) },
            sessionId: "other",
          },
        });
        const foreignError = yield* Effect.flip(
          service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          }),
        );
        expect(String(foreignError)).toContain("foreign source");
        expect(gateway.countDecisionStarts()).toBe(0);

        // Missing target thread: refuse before any wire effect.
        const missingError = yield* Effect.flip(
          service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: ThreadId.make("thread-never-created"),
          }),
        );
        expect(String(missingError)).toContain("does not exist");
        expect(gateway.countDecisionStarts()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "a failed worktree metadata publication answers unknown and a same-source retry repairs it once — no second start or adoption",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-branch-metadata-"), "orchestration.sqlite");
        const gateway = new BranchFakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(adapter);
        const engine: EngineBehavior = { failNextMetaUpdate: true, dispatched: [] };
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          projection: { parent: true, target: true, targetSession: false },
          engine,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: adapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          // The harness prepared the child and the binding persisted, but the
          // metadata publication failed: NOT app-ready — explicit unknown.
          expect(started.state).toBe("unknown");
          expect(started.reason).toContain("workspace");
          expect(started.reason).toContain("no second start");
          expect(Option.isSome(yield* directory.getBinding(CHILD_THREAD))).toBe(true);
          expect(gateway.countDecisionStarts()).toBe(1);
          const handshakesAfterFirst = gateway.countChildHandshakes();
          expect(handshakesAfterFirst).toBe(1);
          expect(engine.dispatched).toHaveLength(0);
          // Explicit same-source retry: repairs the metadata ONCE through the
          // durable reconcile path — no second start, no repeated adoption.
          const repaired = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(repaired.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
          expect(gateway.countChildHandshakes()).toBe(handshakesAfterFirst);
          expect(engine.dispatched).toHaveLength(1);
          expect(engine.dispatched[0]!.commandId).toBe(`branch-worktree-${String(CHILD_THREAD)}`);
          expect(engine.dispatched[0]!.worktreePath).toBe(CHILD_WORKSPACE);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "a second adapter incarnation (no live adapter state, still-bound gateway parent) repairs a metadata-failed preparation through the durable binding — one adoption, still one start",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-branch-metadata-restart-"),
          "orchestration.sqlite",
        );
        const gateway = new BranchFakeGateway();
        const firstAdapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(firstAdapter);
        const failingEngine: EngineBehavior = { failNextMetaUpdate: true, dispatched: [] };
        const outerScope = yield* Effect.scope;
        // First incarnation: the start confirms and the binding persists, but
        // the metadata publication fails → explicit unknown.
        const firstLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, firstAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
          engine: failingEngine,
        });
        const firstContext = yield* Layer.buildWithScope(firstLayer, outerScope);
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: firstAdapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("unknown");
          expect(gateway.countDecisionStarts()).toBe(1);
        }).pipe(Effect.provideContext(firstContext));

        // Second incarnation over the same gateway: the retry repairs the
        // metadata through the durable binding with exactly one restart
        // adoption and no second start.
        const secondAdapter = yield* acquireHarnessAdapter(gateway);
        const repairingEngine: EngineBehavior = { failNextMetaUpdate: false, dispatched: [] };
        const secondLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, secondAdapter]]),
          projection: { parent: true, target: true, targetSession: true },
          engine: repairingEngine,
        });
        const secondContext = yield* Layer.buildWithScope(secondLayer, outerScope);
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const repaired = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(repaired.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
          // One adoption in each incarnation.
          expect(gateway.countChildHandshakes()).toBe(2);
          expect(repairingEngine.dispatched).toHaveLength(1);
          expect(repairingEngine.dispatched[0]!.worktreePath).toBe(CHILD_WORKSPACE);
        }).pipe(Effect.provideContext(secondContext));
        // BOUNDARY: both service layers stay open here, so the gateway's
        // parent owner transport binding is NEVER detached — this proves the
        // durable-binding reconcile against a FRESH adapter (no live state)
        // while the harness parent stays bound. It is NOT a full app
        // restart: a real first-service dispose runs stopAll/detach, and the
        // actual post-detach reattachment is asserted separately below.
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a changed command and a changed recorded child on retry — no re-send, no adoption",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-branch-changed-"), "orchestration.sqlite");
        const gateway = new BranchFakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(adapter);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: adapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
          const handshakesAfterStart = gateway.countChildHandshakes();

          // A DIFFERENT command is not the recorded application: unknown,
          // never re-sent.
          const changedCommand = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-different",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(changedCommand.state).toBe("unknown");
          expect(changedCommand.reason).toContain("command");
          expect(gateway.countDecisionStarts()).toBe(1);

          // A CHANGED recorded child (the host moved the child workspace) no
          // longer equals the durable child binding: unknown, no re-send, no
          // re-adoption — a plausible child id never substitutes the source.
          gateway.child.workspacePath = "/tmp/dokkabi-fake-child-workspace-moved";
          const changedChild = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(changedChild.state).toBe("unknown");
          expect(changedChild.reason).toContain("durable child");
          expect(gateway.countDecisionStarts()).toBe(1);
          expect(gateway.countChildHandshakes()).toBe(handshakesAfterStart);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "with no durable binding, a ready recorded status reconciles without a second start once persistence recovers",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-branch-nobinding-ready-"),
          "orchestration.sqlite",
        );
        const gateway = new BranchFakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(adapter);
        // Persistence-failure injection the FIRST attempt only: the child is
        // hidden from listSessions so the durable adoption cannot be
        // attested; the retry sees the real snapshot again.
        const hideChild = { value: true };
        const hidingAdapter: ProviderAdapterShape<ProviderAdapterError> = {
          ...adapter,
          listSessions: () =>
            Effect.map(adapter.listSessions(), (sessions) =>
              hideChild.value
                ? sessions.filter((session) => session.threadId !== CHILD_THREAD)
                : sessions,
            ),
        };
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, hidingAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: adapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          // The harness confirmed the child, but nothing is durable app-side.
          expect(started.state).toBe("unknown");
          expect(gateway.countDecisionStarts()).toBe(1);
          const handshakesAfterFirst = gateway.countChildHandshakes();
          expect(Option.isNone(yield* directory.getBinding(CHILD_THREAD))).toBe(true);

          // Retry with persistence recovered: the RECORDED ready status
          // reconciles — no second start, no repeated adoption — and the
          // binding becomes durable.
          hideChild.value = false;
          const reconciled = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(reconciled.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
          expect(gateway.countChildHandshakes()).toBe(handshakesAfterFirst);
          expect(Option.isSome(yield* directory.getBinding(CHILD_THREAD))).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "an admitted-but-unconfirmed application stays unknown across retries — the start is never re-sent",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-branch-nobinding-unknown-"),
          "orchestration.sqlite",
        );
        const gateway = new BranchFakeGateway();
        // The start's acknowledgement is lost AND the host holds the
        // application as admitted-but-unconfirmed.
        gateway.startMode = "drop";
        gateway.startConfirmed = false;
        const adapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(adapter);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: adapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("unknown");
          expect(gateway.countDecisionStarts()).toBe(1);
          expect(Option.isNone(yield* directory.getBinding(CHILD_THREAD))).toBe(true);

          // The recorded application is admitted but NOT confirmed: every
          // retry reads the status first and stays unknown — never re-sent.
          const retried = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(retried.state).toBe("unknown");
          expect(retried.reason).toContain("admitted but not confirmed");
          expect(gateway.countDecisionStarts()).toBe(1);
          expect(gateway.countChildHandshakes()).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "a second-adapter retry adopts with the RECORDED preparation model — a changed current parent model never rejects the pinned child (still-bound gateway parent)",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-branch-pinned-model-"),
          "orchestration.sqlite",
        );
        const gateway = new BranchFakeGateway();
        // Preparation time: parent and child both boot 'glm-5.3'.
        const firstAdapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(firstAdapter);
        const outerScope = yield* Effect.scope;
        const firstLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, firstAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        const firstContext = yield* Layer.buildWithScope(firstLayer, outerScope);
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: firstAdapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("ready");
          // The durable child binding carries the preparation-time model.
          const childBinding = yield* directory.getBinding(CHILD_THREAD);
          expect(Option.isSome(childBinding)).toBe(true);
          if (Option.isSome(childBinding)) {
            expect((childBinding.value.resumeCursor as Record<string, unknown>).parentModel).toBe(
              "glm-5.3",
            );
          }
        }).pipe(Effect.provideContext(firstContext));

        // The PARENT's current model changed; the host keeps the child
        // source-bound to its recorded preparation model.
        gateway.model = "glm-5.4";
        gateway.childModel = "glm-5.3";
        const secondAdapter = yield* acquireHarnessAdapter(gateway);
        const secondLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, secondAdapter]]),
          projection: { parent: true, target: true, targetSession: true },
        });
        const secondContext = yield* Layer.buildWithScope(secondLayer, outerScope);
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const restarted = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          // The pinned child reconciles under its RECORDED model; using the
          // parent's changed current model would have refused it.
          expect(restarted.state).toBe("ready");
          expect(restarted.child?.sessionId).toBe(CHILD_SESSION_ID);
          expect(gateway.countDecisionStarts()).toBe(1);
        }).pipe(Effect.provideContext(secondContext));
        // BOUNDARY: the first service layer stays open, so the gateway's
        // parent owner binding is never detached — the pinned-model retry is
        // proven against a fresh adapter while the harness parent stays
        // bound (see the metadata test above; a full app restart is separate).
      }).pipe(Effect.scoped),
  );

  it.live(
    "primary: explicit reconcile after REAL dispose reattaches the recorded parent without Send or repeated start",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-branch-post-detach-"), "orchestration.sqlite");
        const gateway = new BranchFakeGateway();
        const firstAdapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(firstAdapter);
        const firstLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, firstAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        // First incarnation truly DISPOSES at the end of this block: the
        // service finalizer runs stopAll, which detaches the parent (and the
        // adopted child) at the gateway — a real app shutdown.
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: firstAdapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
          yield* service.createWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            question: "Which cut first?",
            options: [
              { id: "opt-1", label: "A" },
              { id: "opt-2", label: "B" },
            ],
            recommendation: "opt-1",
            rationale: "A unblocks B.",
          });
          yield* service.selectWorkbenchDecision(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-select-test",
            expectedRevision: 0,
            option: "opt-1",
          });
          const started = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(started.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(firstLayer));

        // Post-detach incarnation: a fresh adapter over the same gateway.
        // The durable bindings survive, but the gateway's parent owner
        // transport binding was released by the dispose. The explicit
        // reconcile explicitly reattaches the exact persisted parent before
        // adopting the same confirmed child. Reads remain pure and no start
        // creation or model Send is re-sent.
        const secondAdapter = yield* acquireHarnessAdapter(gateway);
        const secondLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, secondAdapter]]),
          projection: { parent: true, target: true, targetSession: true },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const recovered = yield* service.startWorkbenchBranch(PARENT_THREAD, {
            id: "dec-1",
            commandId: "decision-start-test",
            expectedRevision: 1,
            childThreadId: CHILD_THREAD,
          });
          expect(recovered.state).toBe("ready");
          expect(gateway.countDecisionStarts()).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(secondLayer));
      }),
  );

  it.live(
    "primary: explicit parent resume after genuine service closure restores reads without Send or branch creation",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-parent-explicit-resume-"),
          "orchestration.sqlite",
        );
        const gateway = new BranchFakeGateway();
        const firstAdapter = yield* acquireHarnessAdapter(gateway);
        const parentSession = yield* startParentAndRecord(firstAdapter);
        const firstLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, firstAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: firstAdapter.provider,
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "running",
            resumeCursor: parentSession.resumeCursor,
          });
        }).pipe(Effect.scoped, Effect.provide(firstLayer));
        expect(gateway.binding).toBeUndefined();
        const secondAdapter = yield* acquireHarnessAdapter(gateway);
        const secondLayer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, secondAdapter]]),
          projection: { parent: true, target: true, targetSession: false },
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const bindsBeforeRead = gateway.requestsFor("workbench.bind").length;
          // This double permits retained decision reads without a live bind.
          // Pin the no-recovery property, not its unlike-native view label.
          yield* service.getWorkbenchDecisions(PARENT_THREAD);
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(bindsBeforeRead);
          expect(gateway.binding).toBeUndefined();
          const resumed = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(resumed.state).toBe("available");
          expect(gateway.binding).toEqual({ clientId: CLIENT_ID, threadId: PARENT_THREAD });
          const boundCount = gateway.requestsFor("workbench.bind").length;
          const after = yield* service.getWorkbenchDecisions(PARENT_THREAD);
          expect(after.status).not.toBe("unavailable");
          const again = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(again.state).toBe("available");
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(boundCount);
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
          expect(gateway.countDecisionStarts()).toBe(0);
        }).pipe(Effect.scoped, Effect.provide(secondLayer));
      }),
  );
});
