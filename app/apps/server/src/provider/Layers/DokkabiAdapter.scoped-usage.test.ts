/**
 * R8 scoped-usage adapter tests: the on-demand includeChildUsage probe behind
 * the recorded overview. When the flag is true the read issues exactly ONE
 * read-only workbench.usage probe under the same binding and cursors,
 * validates the returned report's source heads against the overview it
 * already anchored (full-head equality or authentic monotonic progression,
 * never a rewind or a foreign session/generation), holds the closed report
 * to its own arithmetic (per-scope metric coupling, owned verified child
 * ids, aggregate totals that match the per-scope records), and reports the
 * documented missing method as a typed unsupported scoped result — never a
 * fabricated zero and never a silent downgrade of a malformed reply.
 *
 * @module provider/Layers/DokkabiAdapter.scoped-usage.test
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
import {
  FakeGateway,
  FakeSocket,
  emptyOverview,
} from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-scoped-usage-1");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-scoped-usage-test";

process.env.DOKKABI_SCOPED_USAGE_TEST_TOKEN = "non-secret-test-fixture";

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
        tokenEnv: "DOKKABI_SCOPED_USAGE_TEST_TOKEN",
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

const errorText = (cause: Cause.Cause<unknown>): string => String(Cause.squash(cause));

/** A full harness-shaped usage report over the gateway's own heads. */
const usageReport = (gateway: FakeGateway, overrides: Record<string, unknown> = {}) => {
  const head = gateway.sessionHeadRef();
  const childId = `${gateway.sessionId}-accept-0001`;
  return {
    state: "partial",
    main: {
      sessionId: gateway.sessionId,
      head,
      settled: true,
      counts: { requests: 2, sends: 2, completedUsage: 2 },
      usage: {
        records: 2,
        input: { total: 700, missing: 0, latestSource: { seq: 5, hash: hex64("main-u5") } },
        output: { total: 90, missing: 0, latestSource: { seq: 5, hash: hex64("main-u5") } },
        reasoning: { total: null, missing: 2, latestSource: null },
        cacheRead: { total: 4_000, missing: 0, latestSource: { seq: 5, hash: hex64("main-u5") } },
        cacheWrite: { total: null, missing: 2, latestSource: null },
      },
    },
    scopes: [
      {
        id: childId,
        roles: ["spec", "verifier"],
        state: "verified",
        provenance: [
          {
            producer: "workbench-test:accept",
            field: "verifier_session",
            ref: { seq: 30, hash: hex64("parent-30") },
            pinnedHash: hex64("child-pin-1"),
          },
        ],
        pinnedHead: { seq: 12, hash: hex64("child-pin-1") },
        head: { seq: 14, hash: hex64("child-head-14") },
        counts: { requests: 1, sends: 1, completedUsage: 1 },
        usage: {
          records: 1,
          input: { total: 300, missing: 0, latestSource: { seq: 9, hash: hex64("child-u9") } },
          output: { total: 40, missing: 0, latestSource: { seq: 9, hash: hex64("child-u9") } },
          reasoning: { total: 10, missing: 0, latestSource: { seq: 9, hash: hex64("child-u9") } },
          cacheRead: { total: null, missing: 1, latestSource: null },
          cacheWrite: { total: null, missing: 1, latestSource: null },
        },
        detail: null,
      },
    ],
    aggregate: {
      scopesCounted: 2,
      counts: { requests: 3, sends: 3, completedUsage: 3 },
      input: { total: 1_000, missing: 0 },
      output: { total: 130, missing: 0 },
      reasoning: { total: 10, missing: 2 },
      cacheRead: { total: 4_000, missing: 1 },
      cacheWrite: { total: null, missing: 3 },
    },
    semantics: {
      totals: "recorded_usage_not_billing",
      reasoning: "included_in_output_total",
      cacheRead: "separate_from_input_total",
      cacheWrite: "separate_from_input_total",
    },
    details: ["child prefix has an uncounted tail"],
    errors: [],
    ...overrides,
  } as Record<string, unknown>;
};

describe("DokkabiAdapter.readWorkbenchOverview scoped usage", () => {
  it.live("forwards includeChildUsage as one read-only probe under the same binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      const before = (yield* adapter.listSessions())[0]!;
      const result = yield* adapter.readWorkbenchOverview!(THREAD, before.resumeCursor, {
        includeChildUsage: true,
      });
      expect(result.status).toBe("available");
      const scoped = result.scopedUsage;
      expect(scoped?.status).toBe("available");
      if (scoped?.status !== "available") return;
      expect(scoped.report.main.usage.input.total).toBe(700);
      expect(scoped.report.scopes[0]?.state).toBe("verified");
      expect(scoped.report.aggregate.scopesCounted).toBe(2);
      // Exactly ONE probe, under the thread's binding and version only.
      const probes = gateway.requestsFor("workbench.usage");
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({
        version: 1,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
      });
      // The read stays read-only: no second bind, no submit, no cancel, and
      // the transcript cursors never advance from the probe.
      const after = (yield* adapter.listSessions())[0]!;
      expect(after.resumeCursor).toEqual(before.resumeCursor);
      expect(gateway.requestsFor("workbench.bind")).toHaveLength(1);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.cancel")).toHaveLength(0);
    }),
  );

  it.live("without the flag no probe is issued and scopedUsage stays absent", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined);
      expect(result.status).toBe("available");
      expect(result.scopedUsage).toBeUndefined();
      expect(gateway.requestsFor("workbench.usage")).toHaveLength(0);
    }),
  );

  it.live("a pre-usage gateway reports the typed unsupported scoped result", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.supportUsage = false;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined, {
        includeChildUsage: true,
      });
      // The overview itself stays available; only the scoped view is
      // unsupported, with the documented missing-method reason.
      expect(result.status).toBe("available");
      expect(result.overview?.work.state).toBe("missing");
      expect(result.scopedUsage).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("does not implement workbench.usage"),
      });
      expect(gateway.requestsFor("workbench.usage")).toHaveLength(1);
    }),
  );

  it.live("an unbound thread keeps the whole result unavailable with no scoped usage", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined, {
        includeChildUsage: true,
      });
      expect(result.status).toBe("unavailable");
      expect(result.scopedUsage).toBeUndefined();
    }),
  );

  it.live("a malformed usage report stays a hard error, never unsupported", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage({ ...usageReport(gateway), unexpectedField: true });
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      const text = errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit));
      expect(text).not.toMatch(/unsupported/i);
    }),
  );

  it.live("a usage response naming a foreign session fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      gateway.usageEnvelope.sessionCursor = {
        sessionId: "live-other99",
        ...gateway.sessionHeadRef(),
        generation: gateway.sessionGeneration,
      };
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/names session/u);
    }),
  );

  it.live("a usage response from a replaced generation fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      gateway.usageEnvelope.sessionCursor = {
        sessionId: gateway.sessionId,
        ...gateway.sessionHeadRef(),
        generation: hex64("replaced-usage-chain"),
      };
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/replaced/u);
    }),
  );

  it.live("a usage head rewound below the overview head fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      gateway.usageEnvelope.sessionCursor = {
        sessionId: gateway.sessionId,
        seq: 5,
        hash: hex64("session-old-5"),
        generation: gateway.sessionGeneration,
      };
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/rewound/u);
    }),
  );

  it.live("a same-seq usage head with a different hash fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      gateway.usageEnvelope.sessionCursor = {
        sessionId: gateway.sessionId,
        ...gateway.sessionHeadRef(),
        hash: hex64("not-the-usage-head-hash"),
        generation: gateway.sessionGeneration,
      };
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/diverged/u);
    }),
  );

  it.live("a verified child scope with a foreign id fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const report = usageReport(gateway);
      (report.scopes as Array<Record<string, unknown>>)[0]!.id = "evil/../outside";
      gateway.setUsage(report);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /owned acceptance descendant/u,
      );
    }),
  );

  it.live("aggregate totals that disagree with the per-scope records fail closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const report = usageReport(gateway);
      const aggregate = report.aggregate as Record<string, unknown>;
      aggregate.input = { total: 9_999, missing: 0 };
      gateway.setUsage(report);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /aggregate .* does not match/u,
      );
    }),
  );

  it.live("a metric claiming measurements beyond its records fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const report = usageReport(gateway);
      const main = report.main as Record<string, unknown>;
      (main.usage as Record<string, unknown>).reasoning = {
        total: 12,
        missing: 0,
        latestSource: null,
      };
      gateway.setUsage(report);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /total or latest source/u,
      );
    }),
  );

  it.live("overlapping pins on one child are counted once", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const report = usageReport(gateway);
      const scope = (report.scopes as Array<Record<string, unknown>>)[0]!;
      // A second closed producer pins an overlapping SMALLER prefix of the
      // same child: the host dedups to one scope, counted at the largest
      // pin — the aggregate must still hold exactly one child.
      (scope.provenance as Array<Record<string, unknown>>).push({
        producer: "acceptance/readiness:ready",
        field: "verifier_session",
        ref: { seq: 33, hash: hex64("parent-33") },
        pinnedHash: hex64("child-pin-smaller"),
      });
      gateway.setUsage(report);
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined, {
        includeChildUsage: true,
      });
      expect(result.status).toBe("available");
      const scoped = result.scopedUsage;
      expect(scoped?.status).toBe("available");
      if (scoped?.status !== "available") return;
      expect(scoped.report.scopes).toHaveLength(1);
      expect(scoped.report.aggregate.scopesCounted).toBe(2);
      expect(scoped.report.aggregate.counts.requests).toBe(3);
    }),
  );

  it.live("an unpinned evaluator-error child stays visible and uncounted", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const report = usageReport(gateway) as Record<string, unknown>;
      const childId = `${gateway.sessionId}-accept-0002`;
      report.scopes = [
        (report.scopes as Array<Record<string, unknown>>)[0],
        {
          id: childId,
          roles: ["verifier"],
          state: "unpinned",
          provenance: [
            {
              producer: "workbench-test:accept",
              field: "verifier_session",
              ref: { seq: 41, hash: hex64("parent-41") },
              pinnedHash: null,
            },
          ],
          pinnedHead: null,
          head: { seq: 3, hash: hex64("unpinned-head-3") },
          counts: null,
          usage: null,
          detail: "referenced without a pinned closed prefix",
        },
      ];
      // The unpinned child adds a partial detail but no counted scope.
      report.state = "partial";
      (report.details as string[]).push(
        `child session ${childId} is referenced but unpinned — no closed producer prefix certifies any usage`,
      );
      gateway.setUsage(report);
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined, {
        includeChildUsage: true,
      });
      expect(result.status).toBe("available");
      const scoped = result.scopedUsage;
      expect(scoped?.status).toBe("available");
      if (scoped?.status !== "available") return;
      expect(scoped.report.state).toBe("partial");
      expect(scoped.report.scopes).toHaveLength(2);
      expect(scoped.report.aggregate.scopesCounted).toBe(2);
    }),
  );

  it.live("a child route probes through the branchSession envelope", () =>
    Effect.gen(function* () {
      const CHILD_ID = "child-scoped-0001";
      const CHILD_SESSION = "live-child01";
      const PARENT_THREAD = "thread-scoped-usage-parent";
      // A faithful-enough branch double: the envelope authenticates the
      // PARENT owner, ordinary child methods unwrap to the double's own
      // handlers (bound to the child's own pair), and workbench.usage is
      // answered with the double's usage state under the child session.
      const gateway = new (class extends FakeGateway {
        override dispatch(
          method: string,
          params: unknown,
          socket: FakeSocket,
          requestId: number,
        ): void {
          if (method === "workbench.branchSession") {
            this.requests.push({ method, params });
            const record = params as Record<string, unknown>;
            const inner = record.params as Record<string, unknown>;
            if (String(record.method) === "workbench.usage") {
              socket.reply(requestId, { result: this.usageResult() });
              return;
            }
            if (String(record.method) === "workbench.overview") {
              super.dispatch("workbench.overview", inner, socket, requestId);
              return;
            }
            socket.reply(requestId, {
              error: { code: -32601, message: `Method not found: ${String(record.method)}` },
            });
            return;
          }
          super.dispatch(method, params, socket, requestId);
        }
      })();
      gateway.sessionId = CHILD_SESSION;
      gateway.binding = { clientId: CLIENT_ID, threadId: String(THREAD) };
      gateway.setOverview(emptyOverview());
      gateway.setUsage(usageReport(gateway));
      const { adapter } = yield* setup(gateway);
      const persisted = {
        binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
        sessionId: CHILD_SESSION,
        child: {
          id: CHILD_ID,
          sessionId: CHILD_SESSION,
          workspacePath: "/tmp/dokkabi-fake-child",
          parent: { clientId: CLIENT_ID, threadId: PARENT_THREAD },
          binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
        },
      };
      const result = yield* adapter.readWorkbenchOverview!(THREAD, persisted, {
        includeChildUsage: true,
      });
      expect(result.status).toBe("available");
      const scoped = result.scopedUsage;
      expect(scoped?.status).toBe("available");
      if (scoped?.status !== "available") return;
      expect(scoped.report.main.sessionId).toBe(CHILD_SESSION);
      // The probe travelled the authenticated child envelope, never a
      // direct child endpoint.
      const envelopes = gateway.requestsFor("workbench.branchSession");
      const usageEnvelopes = envelopes.filter(
        (envelope) => envelope.method === "workbench.usage",
      );
      expect(usageEnvelopes).toHaveLength(1);
      expect(usageEnvelopes[0]).toMatchObject({
        childId: CHILD_ID,
        binding: { clientId: CLIENT_ID, threadId: PARENT_THREAD },
      });
      expect(gateway.requestsFor("workbench.usage")).toHaveLength(0);
    }),
  );

  it.live("a branch envelope that forbids the usage method reports unsupported", () =>
    Effect.gen(function* () {
      const CHILD_ID = "child-scoped-0001";
      const CHILD_SESSION = "live-child01";
      const PARENT_THREAD = "thread-scoped-usage-parent";
      const gateway = new (class extends FakeGateway {
        override dispatch(
          method: string,
          params: unknown,
          socket: FakeSocket,
          requestId: number,
        ): void {
          if (method === "workbench.branchSession") {
            this.requests.push({ method, params });
            const record = params as Record<string, unknown>;
            const inner = record.params as Record<string, unknown>;
            if (String(record.method) === "workbench.usage") {
              // An older gateway whose branch whitelist never grew to carry
              // the additive usage read: an explicit documented refusal.
              socket.reply(requestId, {
                error: {
                  code: -32603,
                  message: `workbench.branchSession forbids method ${JSON.stringify("workbench.usage")}`,
                },
              });
              return;
            }
            if (String(record.method) === "workbench.overview") {
              super.dispatch("workbench.overview", inner, socket, requestId);
              return;
            }
            socket.reply(requestId, {
              error: { code: -32601, message: `Method not found: ${String(record.method)}` },
            });
            return;
          }
          super.dispatch(method, params, socket, requestId);
        }
      })();
      gateway.sessionId = CHILD_SESSION;
      gateway.binding = { clientId: CLIENT_ID, threadId: String(THREAD) };
      gateway.setOverview(emptyOverview());
      const { adapter } = yield* setup(gateway);
      const persisted = {
        binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
        sessionId: CHILD_SESSION,
        child: {
          id: CHILD_ID,
          sessionId: CHILD_SESSION,
          workspacePath: "/tmp/dokkabi-fake-child",
          parent: { clientId: CLIENT_ID, threadId: PARENT_THREAD },
          binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
        },
      };
      const result = yield* adapter.readWorkbenchOverview!(THREAD, persisted, {
        includeChildUsage: true,
      });
      expect(result.status).toBe("available");
      expect(result.scopedUsage).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("workbench.usage"),
      });
    }),
  );
});


type ReviewReport = {
  state: string; details: string[];
  main: { sessionId: string; head: { seq: number; hash: string }; settled: boolean; counts: { completedUsage: number } };
  scopes: Array<{ id: string; provenance: Array<{ pinnedHash: string }>; usage: { input: { latestSource: { seq: number; hash: string } } } }>;
  aggregate: { counts: { completedUsage: number } };
};
describe("scoped usage pinned-prefix primary review", () => {
  for (const [name, mutate] of [
    ["stale main head", (r: ReviewReport) => { r.main.head = { seq: 1, hash: hex64("old") }; }],
    ["unpinned child usage tail", (r: ReviewReport) => { r.scopes[0]!.usage.input.latestSource = { seq: 13, hash: hex64("tail") }; }],
    ["non-descendant name", (r: ReviewReport) => { r.scopes[0]!.id = r.main.sessionId + "-acceptevil"; }],
    ["missing parent provenance", (r: ReviewReport) => { r.scopes[0]!.provenance = []; }],
    ["unreferenced pin", (r: ReviewReport) => { r.scopes[0]!.provenance[0]!.pinnedHash = hex64("different pin"); }],
    ["uncoupled usage count", (r: ReviewReport) => { r.main.counts.completedUsage = 1; r.aggregate.counts.completedUsage = 2; }],
    ["false complete state", (r: ReviewReport) => { r.main.settled = false; r.state = "complete"; r.details = []; }],
  ] as const) {
    it.live(`refuses ${name} without accepting a counted report`, () => Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(emptyOverview());
      const report = usageReport(gateway);
      mutate(report as unknown as ReviewReport);
      gateway.setUsage(report);
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined, { includeChildUsage: true }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
    }));
  }
});
