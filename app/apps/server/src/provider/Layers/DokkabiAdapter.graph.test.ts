/**
 * R4 recorded-graph adapter tests (docs/internals/dokkabi-graphs-r4.md):
 * the authenticated thread routes through its persisted provider instance
 * and the gateway's own binding; foreign instance/thread/source identities
 * fail closed; a replaced generation fails closed even when the response
 * claims resnapshot; unavailable or unsupported capabilities never become
 * empty success or trigger writer recovery; unsupported is reserved for the
 * documented missing method; a graph poll never advances the transcript
 * resume cursors. The closed graph payload is held to its own contract:
 * graphType, unique node ids, complete endpoints, coverage arithmetic and
 * source references bounded by the returned head with exact hashes where
 * the response itself is authoritative.
 *
 * @module provider/Layers/DokkabiAdapter.graph.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeDokkabiAdapter, type DokkabiAdapterError } from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-graph-1");
const FOREIGN_THREAD = ThreadId.make("thread-graph-other");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-test";

process.env.DOKKABI_TEST_TOKEN = "non-secret-test-fixture";

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

interface Bundle {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly gateway: FakeGateway;
}

const setup = (
  gateway: FakeGateway = new FakeGateway(),
): Effect.Effect<Bundle, DokkabiAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4174",
        tokenEnv: "DOKKABI_TEST_TOKEN",
        workspacePath: gateway.workspacePath,
        instanceId: INSTANCE_ID,
      },
      {
        clientId: CLIENT_ID,
        pollIntervalMs: 40,
        cancelSettlementWaitMs: 200,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore));
    return { adapter, gateway };
  });

/** A persisted resume state as ProviderSessionDirectory would hand it over. */
const persistedState = (
  input: {
    readonly sessionCursor?: { seq: number; hash: string; generation: string };
    readonly gatewayCursor?: { seq: number; hash: string; generation: string };
    readonly threadId?: string;
  } = {},
): Record<string, unknown> => ({
  binding: { clientId: CLIENT_ID, threadId: input.threadId ?? THREAD },
  sessionId: "live-fake01",
  ...(input.sessionCursor !== undefined
    ? {
        sessionCursor: {
          sessionId: "live-fake01",
          ...input.sessionCursor,
        },
      }
    : {}),
  ...(input.gatewayCursor !== undefined ? { gatewayCursor: input.gatewayCursor } : {}),
});

/** A recorded work graph with real content: goal, todos, cases, edges, waves. */
const recordedGraph = (graphType: "work" | "context", head: number): Record<string, unknown> => ({
  graphType,
  resnapshot: true,
  graph: {
    state: "available",
    mode: graphType === "work" ? null : "on",
    revision: graphType === "work" ? null : 4,
    digest: hex64(`${graphType}-graph`),
    nodes:
      graphType === "work"
        ? [
            {
              id: "goal:goal-1",
              kind: "goal",
              label: "Build the recorded graph",
              status: null,
              provenance: "canonical",
              sources: [{ seq: 3, hash: hex64("goal-row") }],
              details: [{ name: "statement", value: "Build the recorded graph" }],
              bodyDigest: null,
            },
            {
              id: "todo:todo-1",
              kind: "todo",
              label: "Protect the recorded evidence",
              status: "ready",
              provenance: "canonical",
              sources: [{ seq: 4, hash: hex64("todo-row") }],
              details: [{ name: "statement", value: "recorded state only" }],
              bodyDigest: null,
            },
            {
              id: "case:case-1",
              kind: "case",
              label: "bun test evidence-guard.test.ts",
              // A planned case without an earned verdict is PENDING.
              status: "pending",
              provenance: "canonical",
              sources: [{ seq: 5, hash: hex64("case-row") }],
              details: [{ name: "command", value: "bun test evidence-guard.test.ts" }],
              bodyDigest: null,
            },
          ]
        : [
            {
              id: "row:40",
              kind: "source_reference",
              label: "row 40 · ledger/check",
              status: null,
              provenance: "source_reference",
              sources: [{ seq: 40, hash: hex64("assessment-row") }],
              details: [{ name: "row", value: "ledger/check" }],
              bodyDigest: null,
            },
            {
              id: "lesson-1#r1",
              kind: "lesson",
              label: "the command fails under the recorded condition",
              status: "corroborated",
              provenance: "canonical",
              sources: [
                { seq: 10, hash: hex64("lesson-row") },
                { seq: 40, hash: hex64("assessment-row") },
              ],
              details: [
                { name: "retry_conditions", value: "['Verify the dependency version']" },
                { name: "invalidation_conditions", value: "['A later success contests it']" },
              ],
              bodyDigest: hex64("lesson-body"),
            },
            {
              id: "cf-1",
              kind: "context_frame",
              label: "cf-1",
              status: "prepared",
              provenance: "canonical",
              sources: [{ seq: Math.min(head, 150), hash: hex64("frame-row") }],
              details: [{ name: "selected", value: "['lesson-1#r1']" }],
              bodyDigest: hex64("frame-body"),
            },
          ],
    edges:
      graphType === "work"
        ? [
            {
              id: "contains:goal:goal-1->todo:todo-1",
              from: "goal:goal-1",
              to: "todo:todo-1",
              kind: "contains",
              artifact: null,
              sources: [{ seq: 4, hash: hex64("todo-row") }],
            },
          ]
        : [
            {
              id: "cited_by:row:40->lesson-1#r1",
              from: "row:40",
              to: "lesson-1#r1",
              kind: "cited_by",
              artifact: null,
              sources: [{ seq: 11, hash: hex64("cited-row") }],
            },
          ],
    waves: graphType === "work" ? [["todo:todo-1"]] : [],
    unscheduled: [],
    coverage: {
      status: graphType === "work" ? "complete" : "partial",
      totalNodes: graphType === "work" ? 3 : 3,
      totalEdges: 1,
      omittedNodes: 0,
      omittedEdges: 0,
    },
    errors: graphType === "work" ? [] : ["canonical endpoint row:40 is explicit"],
  },
});

/** A gateway manually bound to our client (no adapter session needed). */
const manuallyBound = (gateway: FakeGateway): FakeGateway => {
  gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
  return gateway;
};

const errorText = (cause: Cause.Cause<unknown>): string => String(Cause.squash(cause));

const validPersisted = (gateway: FakeGateway): Record<string, unknown> =>
  persistedState({
    sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
  });

describe("DokkabiAdapter.readWorkbenchGraph", () => {
  it.live("projects an available recorded graph through the thread's own binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setGraph("work", recordedGraph("work", 200));
      const result = yield* adapter.readWorkbenchGraph!(THREAD, "work", undefined);
      expect(result.status).toBe("available");
      expect(result.graph?.graphType).toBe("work");
      // A planned case without an earned verdict travels as PENDING.
      const caseNode = result.graph?.graph.nodes.find((node) => node.id === "case:case-1");
      expect(caseNode?.status).toBe("pending");
      expect(result.graph?.graph.coverage.status).toBe("complete");
      // The request went out under the thread's binding and the closed type.
      const requests = gateway.requestsFor("workbench.graph");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        version: 1,
        graphType: "work",
        binding: { clientId: CLIENT_ID, threadId: THREAD },
      });
      // Context answers keep their own mode/revision.
      gateway.setGraph("context", recordedGraph("context", 200));
      const context = yield* adapter.readWorkbenchGraph!(THREAD, "context", undefined);
      expect(context.status).toBe("available");
      expect(context.graph?.graph.mode).toBe("on");
      expect(context.graph?.graph.revision).toBe(4);
      expect(context.graph?.graph.coverage.status).toBe("partial");
    }),
  );

  it.live("never advances transcript cursors or issues writer calls from a poll", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      const before = (yield* adapter.listSessions())[0]!;
      gateway.setGraph("work", recordedGraph("work", 200));
      yield* adapter.readWorkbenchGraph!(THREAD, "work", before.resumeCursor);
      yield* adapter.readWorkbenchGraph!(THREAD, "context", before.resumeCursor);
      const after = (yield* adapter.listSessions())[0]!;
      expect(after.resumeCursor).toEqual(before.resumeCursor);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.bind")).toHaveLength(1);
      expect(gateway.requestsFor("workbench.cancel")).toHaveLength(0);
    }),
  );

  it.live("an unbound thread reports unavailable, not an error or empty success", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const result = yield* adapter.readWorkbenchGraph!(THREAD, "work", undefined);
      expect(result).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("No live workbench session"),
      });
    }),
  );

  it.live("a detached gateway binding reports unavailable", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      // The gateway restarted: its binding is gone while ours persists.
      gateway.binding = undefined;
      const result = yield* adapter.readWorkbenchGraph!(THREAD, "work", undefined);
      expect(result).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("not currently bound"),
      });
    }),
  );

  it.live("a pre-R4 gateway without the method reports unsupported", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.supportGraph = false;
      const { adapter } = yield* setup(gateway);
      const result = yield* adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway));
      expect(result).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("does not implement workbench.graph"),
      });
    }),
  );

  it.live("a malformed gateway reply stays a hard error, never unsupported", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const malformed = recordedGraph("work", 200);
      (malformed.graph as Record<string, unknown>).unexpectedField = true;
      gateway.setGraph("work", malformed);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).not.toMatch(
        /unsupported/i,
      );
    }),
  );

  it.live("a graph answering a foreign graphType fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setGraph("work", recordedGraph("context", 200));
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /answered a 'context' graph for a 'work' request/,
      );
    }),
  );

  it.live("duplicate node ids fail closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedGraph("work", 200);
      const graph = broken.graph as Record<string, any>;
      graph.nodes = [...graph.nodes, { ...graph.nodes[0] }];
      gateway.setGraph("work", broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /duplicate node id/,
      );
    }),
  );

  it.live("duplicate edge ids fail closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedGraph("work", 200);
      const graph = broken.graph as Record<string, any>;
      graph.edges = [...graph.edges, { ...graph.edges[0], to: "case:case-1" }];
      gateway.setGraph("work", broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /duplicate edge id/,
      );
    }),
  );

  it.live("an arbitrary relation kind fails closed at decode, never renders", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const forged = recordedGraph("work", 200);
      const graph = forged.graph as Record<string, any>;
      graph.edges[0].kind = "causes";
      gateway.setGraph("work", forged);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      // A closed-vocabulary decode failure is a hard error — never
      // unsupported, never an edge rendered under an invented relation.
      const text = errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit));
      expect(text).not.toMatch(/unsupported/i);
      expect(text).toMatch(/workbench\.graph|did not match/i);
    }),
  );

  it.live("an edge with a dangling endpoint fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedGraph("work", 200);
      const graph = broken.graph as Record<string, any>;
      graph.edges = [...graph.edges, { ...graph.edges[0], id: "e2", to: "todo:not-recorded" }];
      gateway.setGraph("work", broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /endpoint that is not a node/,
      );
    }),
  );

  it.live("coverage arithmetic that hides truncation fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedGraph("work", 200);
      (broken.graph as Record<string, any>).coverage.totalNodes = 9;
      gateway.setGraph("work", broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /node coverage does not add up/,
      );
    }),
  );

  it.live("an unavailable graph that carries nodes or partial omission fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const oversized = recordedGraph("work", 200);
      const graph = oversized.graph as Record<string, any>;
      graph.state = "unavailable";
      gateway.setGraph("work", oversized);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /unavailable graph must not carry nodes/,
      );
    }),
  );

  it.live("a missing graph that carries nodes fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const missing = recordedGraph("work", 200);
      (missing.graph as Record<string, any>).state = "missing";
      gateway.setGraph("work", missing);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /missing or invalid graph must not carry nodes/,
      );
    }),
  );

  it.live("a source reference outside the returned head fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const forged = recordedGraph("work", 200);
      const graph = forged.graph as Record<string, any>;
      graph.nodes[0].sources = [{ seq: 9_999, hash: hex64("far-away") }];
      gateway.setGraph("work", forged);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /outside the returned session head/,
      );
    }),
  );

  it.live("a head-seq reference with a forged hash fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const forged = recordedGraph("work", 200);
      const graph = forged.graph as Record<string, any>;
      graph.nodes[0].sources = [{ seq: 200, hash: "f".repeat(64) }];
      gateway.setGraph("work", forged);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "work", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /outside the returned session head or inconsistent/,
      );
    }),
  );

  it.live("two citations of one seq with different hashes fail closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const inconsistent = recordedGraph("context", 200);
      const graph = inconsistent.graph as Record<string, any>;
      graph.nodes[0].sources = [
        { seq: 40, hash: hex64("assessment-row") },
        { seq: 40, hash: hex64("another-row-at-40") },
      ];
      gateway.setGraph("context", inconsistent);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(THREAD, "context", validPersisted(gateway)),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /inconsistent with another citation/,
      );
    }),
  );

  it.live("a persisted resume state from a foreign thread fails closed", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const exit = yield* Effect.exit(
        adapter.readWorkbenchGraph!(
          THREAD,
          "work",
          persistedState({ threadId: String(FOREIGN_THREAD) }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /belongs to thread/,
      );
    }),
  );

  it.live("a graph naming a foreign session identity fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      // The gateway now fronts a different session than the bound one.
      gateway.sessionId = "live-other99";
      gateway.setGraph("work", recordedGraph("work", 10));
      const exit = yield* Effect.exit(adapter.readWorkbenchGraph!(THREAD, "work", undefined));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /names session/,
      );
    }),
  );

  it.live("a replaced session generation fails closed even when resnapshot is claimed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setGraph("work", recordedGraph("work", 200));
      const persisted = validPersisted(gateway);
      gateway.flipGeneration("replaced-chain");
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchGraph!(THREAD, "work", persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/replaced/);
    }),
  );

  it.live("a session head that rewound fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setGraph("work", recordedGraph("work", 200));
      const persisted = persistedState({
        sessionCursor: {
          seq: 205,
          hash: hex64("session-old-205"),
          generation: gateway.sessionGeneration,
        },
      });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchGraph!(THREAD, "work", persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/rewound/);
    }),
  );

  it.live("a same-seq head with a different hash fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setGraph("work", recordedGraph("work", 200));
      const persisted = persistedState({
        sessionCursor: {
          seq: 200,
          hash: hex64("a-different-row-at-200"),
          generation: gateway.sessionGeneration,
        },
      });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchGraph!(THREAD, "work", persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/diverged/);
    }),
  );

  it.live("a replaced gateway ledger generation fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setGraph("work", recordedGraph("work", 200));
      const persisted = persistedState({
        sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
        gatewayCursor: { seq: 1, hash: hex64("g1"), generation: hex64("old-ledger") },
      });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchGraph!(THREAD, "work", persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /ledger was replaced/,
      );
    }),
  );
});
