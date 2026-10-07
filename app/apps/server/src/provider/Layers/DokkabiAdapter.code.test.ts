// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";

import {
  ProviderInstanceId,
  ThreadId,
  type WorkbenchCode,
  type ProviderWorkbenchCodeActionInput,
} from "@t3tools/contracts";

import { makeDokkabiAdapter, type DokkabiAdapterError } from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { canonicalRecordJson } from "../dokkabi/RecordChain.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-code-1");
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

/** A persisted resume state supplied by the server directory, not a renderer. */
const persistedState = (
  input: {
    readonly sessionCursor?: { seq: number; hash: string; generation: string };
    readonly gatewayCursor?: { seq: number; hash: string; generation: string };
    readonly threadId?: string;
  } = {},
): Record<string, unknown> => ({
  binding: { clientId: CLIENT_ID, threadId: input.threadId ?? THREAD },
  sessionId: "live-fake01",
  sessionCursor: {
    sessionId: "live-fake01",
    ...(input.sessionCursor ?? {
      seq: 1,
      hash: hex64("prefix"),
      generation: hex64("generation-1"),
    }),
  },
  gatewayCursor: input.gatewayCursor ?? {
    seq: 1,
    hash: hex64("gateway-1"),
    generation: hex64("gateway-generation"),
  },
});

it.live("provides an optional read-only code capability without binding or model recovery", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    expect(Reflect.get(adapter, "readWorkbenchCode")).toBeTypeOf("function");
    expect(gateway.requests).toHaveLength(0);
  }),
);

const response = (body = false): WorkbenchCode => {
  const graph = { nodes: [], edges: [], diagnostics: [] };
  const graphDigest = hex64(canonicalRecordJson(graph));
  const text = canonicalRecordJson({
    schema: "code-evolution-v1",
    sessionId: "live-fake01",
    graph,
    graphDigest,
  });
  const reference = {
    sessionId: "live-fake01",
    version: { seq: 3, hash: hex64("publication") },
    digest: hex64(text),
  };
  return {
    version: 1,
    sessionCursor: {
      sessionId: "live-fake01",
      seq: 3,
      hash: reference.version.hash,
      generation: hex64("generation-1"),
    },
    gatewayCursor: { seq: 1, hash: hex64("gateway-1"), generation: hex64("gateway-generation") },
    changed: true,
    resnapshot: true,
    versions: [{ reference, bytes: Buffer.byteLength(text), graphDigest }],
    body: body ? { reference, text } : null,
  };
};
const selection = (read: WorkbenchCode) => ({
  ...read.versions[0]!.reference.version,
  digest: read.versions[0]!.reference.digest,
});
const bindFixture = (gateway: FakeGateway, data = response()) => {
  gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
  gateway.codeResponse = data as unknown as Record<string, unknown>;
};

it.live(
  "reads exact selected retained text with only a read request and unchanged resume state",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      const data = response(true);
      bindFixture(gateway, data);
      const resume = persistedState(),
        before = canonicalRecordJson(resume);
      const result = yield* adapter.readWorkbenchCode!(
        THREAD,
        { selection: selection(data) },
        resume,
      );
      expect(result).toEqual({ status: "available", code: data });
      expect(gateway.requests.map((r) => r.method)).toEqual(["workbench.code"]);
      expect(canonicalRecordJson(resume)).toBe(before);
    }),
);

it.live("unsupported and detached sources do not invoke bind or recovery", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    const noOwner = yield* adapter.readWorkbenchCode!(THREAD, {});
    expect(noOwner.status).toBe("unavailable");
    expect(gateway.requests).toHaveLength(0);
    const older = yield* adapter.readWorkbenchCode!(THREAD, {}, persistedState());
    expect(older.status).toBe("unsupported");
    gateway.codeResponse = response() as unknown as Record<string, unknown>;
    const detached = yield* adapter.readWorkbenchCode!(THREAD, {}, persistedState());
    expect(detached.status).toBe("unavailable");
    expect(gateway.requests.every((r) => r.method === "workbench.code")).toBe(true);
  }),
);

it.live("refuses foreign persisted owner before sending any request", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    for (const resume of [
      persistedState({ threadId: "foreign" }),
      { ...persistedState(), binding: { clientId: "foreign", threadId: THREAD } },
    ]) {
      expect(
        Exit.isFailure(yield* Effect.exit(adapter.readWorkbenchCode!(THREAD, {}, resume))),
      ).toBe(true);
    }
    expect(gateway.requests).toHaveLength(0);
  }),
);

it.live(
  "rejects changed sources, foreign/spliced metadata, oversized bodies and digest corruption",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      const mutations: ((value: WorkbenchCode) => WorkbenchCode)[] = [
        (v) => ({ ...v, sessionCursor: { ...v.sessionCursor, sessionId: "foreign" } }),
        (v) => ({ ...v, versions: [...v.versions, ...v.versions] }),
        (v) => ({ ...v, changed: false }),
        (v) => ({ ...v, body: { ...v.body!, text: v.body!.text + " " } }),
        (v) => ({ ...v, versions: [{ ...v.versions[0]!, bytes: 8 * 1024 * 1024 + 1 }] }),
        (v) => ({
          ...v,
          body: { ...v.body!, reference: { ...v.body!.reference, digest: "0".repeat(64) } },
        }),
      ];
      for (const mutate of mutations) {
        const original = response(true);
        bindFixture(gateway, mutate(original));
        const exit = yield* Effect.exit(
          adapter.readWorkbenchCode!(THREAD, { selection: selection(original) }, persistedState()),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      bindFixture(gateway);
      const changed = yield* Effect.exit(
        adapter.readWorkbenchCode!(
          THREAD,
          {},
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("past"), generation: hex64("old") },
          }),
        ),
      );
      expect(Exit.isFailure(changed)).toBe(true);
      const fences = gateway.requestsFor("workbench.code").at(-1)!;
      expect(fences.sessionCursor).toMatchObject({ generation: hex64("old") });
    }),
);

it.live(
  "index acknowledgements mark non-code advancement unchanged and cursor gaps resnapshot",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      const first = response();
      bindFixture(gateway, {
        ...first,
        changed: false,
        resnapshot: false,
        sessionCursor: { ...first.sessionCursor, seq: 5, hash: hex64("non-code") },
      });
      const quiet = yield* adapter.readWorkbenchCode!(
        THREAD,
        { after: first.sessionCursor },
        persistedState(),
      );
      expect(quiet.status === "available" && quiet.code.changed).toBe(false);
      bindFixture(gateway, { ...first, changed: true, resnapshot: true });
      const recovered = yield* adapter.readWorkbenchCode!(
        THREAD,
        { after: { ...first.sessionCursor, seq: 99 } },
        persistedState(),
      );
      expect(recovered.status === "available" && recovered.code.resnapshot).toBe(true);
    }),
);

it.live("legacy resume without verified source anchors cannot silently accept a replacement", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    bindFixture(gateway);
    const legacy = {
      binding: { clientId: CLIENT_ID, threadId: THREAD },
      sessionId: gateway.sessionId,
    };
    const result = yield* adapter.readWorkbenchCode!(THREAD, {}, legacy);
    expect(result.status).toBe("unavailable");
    expect(gateway.requests).toHaveLength(0);
  }),
);

it.live(
  "partial and genesis source anchors stay unavailable without probing or writer recovery",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      bindFixture(gateway);
      for (const absent of ["sessionCursor", "gatewayCursor"] as const) {
        const resume = persistedState();
        delete resume[absent];
        expect((yield* adapter.readWorkbenchCode!(THREAD, {}, resume)).status).toBe("unavailable");
      }
      const genesis = persistedState({
        sessionCursor: { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) },
      });
      expect((yield* adapter.readWorkbenchCode!(THREAD, {}, genesis)).status).toBe("unavailable");
      expect(gateway.requests).toHaveLength(0);
    }),
);

const recoveryInput = (
  commandId = "resume-code-1",
): Omit<ProviderWorkbenchCodeActionInput, "threadId"> => ({
  operation: "resume",
  commandId,
  expectedRevision: 1,
  newWindow: false,
});
const recoveredObserver = {
  state: "active",
  policyDigest: hex64("policy"),
  paths: 1,
  checks: 2,
  reason: null,
  revision: 202,
  window: 1,
  lifetimeChecks: 10,
  retainedVersions: 2,
  retainedBytes: 50,
};
const recoveryReply = (commandId: string) => ({
  version: 1,
  state: "applied",
  receipt: { commandId, seq: 201, hash: hex64("recovery-receipt") },
  observer: recoveredObserver,
});
const recoveryFixture = (gateway: FakeGateway, mode: { reply: unknown; capability?: boolean }) => {
  gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
  const dispatch = gateway.dispatch.bind(gateway);
  gateway.dispatch = (method, params, socket, id) => {
    if (method === "workbench.handshake") {
      gateway.requests.push({ method, params });
      socket.reply(id, {
        result: {
          version: 1,
          workspacePath: gateway.workspacePath,
          sessionId: gateway.sessionId,
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
            ...(mode.capability === false ? {} : { codeAction: true }),
          },
          route: gateway.route,
          model: gateway.model,
          ready: false,
          routeSource: "configured",
          kernelOpen: false,
          permissionMode: "bypass",
          bound: gateway.binding,
        },
      });
      return;
    }
    if (method === "workbench.codeAction") {
      gateway.requests.push({ method, params });
      if (mode.reply === "drop") socket.drop();
      else socket.reply(id, { result: mode.reply });
      return;
    }
    dispatch(method, params, socket, id);
  };
};

it.live(
  "Code recovery validates an owned source, applies one command and preserves replay cursors",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      const mode = { reply: recoveryReply("resume-code-1") };
      recoveryFixture(gateway, mode);
      const resume = persistedState(),
        before = canonicalRecordJson(resume);
      const result = yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(), resume);
      expect(result).toEqual(mode.reply);
      expect(canonicalRecordJson(resume)).toBe(before);
      expect(gateway.requests.map((r) => r.method)).toEqual([
        "workbench.handshake",
        "workbench.read",
        "workbench.codeAction",
      ]);
      expect(gateway.requestsFor("workbench.codeAction")[0]).toEqual({
        version: 1,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
        ...recoveryInput(),
      });
    }),
);

it.live(
  "Code recovery rejects foreign owners, replaced sources and injected caller authority before mutation",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      recoveryFixture(gateway, { reply: recoveryReply("resume-code-1") });
      for (const resume of [
        persistedState({ threadId: "foreign" }),
        { ...persistedState(), binding: { clientId: "foreign", threadId: THREAD } },
        persistedState({
          sessionCursor: { seq: 1, hash: hex64("prefix"), generation: hex64("replaced") },
        }),
        { ...persistedState(), sessionId: "foreign" },
        { ...persistedState(), sourceMismatch: true },
      ]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(adapter.workbenchCodeAction!(THREAD, recoveryInput(), resume)),
          ),
        ).toBe(true);
      }
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            adapter.workbenchCodeAction!(
              THREAD,
              { ...recoveryInput(), root: "/outside" } as never,
              persistedState(),
            ),
          ),
        ),
      ).toBe(true);
      expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(0);
    }),
);

it.live(
  "Code recovery refuses detached and unsupported bindings without boot, bind or capture",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      const mode = { reply: recoveryReply("resume-code-1"), capability: false };
      recoveryFixture(gateway, mode);
      expect(
        (yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(), persistedState())).state,
      ).toBe("unsupported");
      mode.capability = true;
      gateway.binding = undefined;
      expect(
        (yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(), persistedState())).state,
      ).toBe("unavailable");
      expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.code")).toHaveLength(0);
    }),
);

it.live("Code recovery passes recorded conflict and busy refusals without retrying", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    const mode: { reply: unknown } = { reply: null };
    recoveryFixture(gateway, mode);
    for (const state of ["busy", "conflict", "unavailable", "unsupported"] as const) {
      mode.reply = { version: 1, state, reason: "recorded refusal" };
      expect(
        yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(state), persistedState()),
      ).toEqual(mode.reply);
    }
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(4);
  }),
);

it.live("lost Code recovery retains exact command and owner for explicit retry only", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    const mode: { reply: unknown } = { reply: "drop" };
    recoveryFixture(gateway, mode);
    expect(
      (yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(), persistedState())).state,
    ).toBe("unknown");
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(1);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.workbenchCodeAction!(
            THREAD,
            { ...recoveryInput(), newWindow: true },
            persistedState(),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.workbenchCodeAction!(
            THREAD,
            recoveryInput(),
            persistedState({
              sessionCursor: { seq: 1, hash: hex64("prefix"), generation: hex64("other-owner") },
            }),
          ),
        ),
      ),
    ).toBe(true);
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(1);
    mode.reply = recoveryReply("resume-code-1");
    expect(
      (yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(), persistedState())).state,
    ).toBe("applied");
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(2);
  }),
);

it.live(
  "malformed or mismatched applied Code receipts remain unknown and forbid payload replacement",
  () =>
    Effect.gen(function* () {
      const { adapter, gateway } = yield* setup();
      const mode: { reply: unknown } = { reply: null };
      recoveryFixture(gateway, mode);
      for (const reply of [
        recoveryReply("foreign-command"),
        { ...recoveryReply("resume-code-1"), observer: { ...recoveredObserver, revision: 1 } },
        {
          ...recoveryReply("resume-code-1"),
          receipt: { commandId: "resume-code-1", seq: 201, hash: "broken" },
        },
      ]) {
        mode.reply = reply;
        expect(
          (yield* adapter.workbenchCodeAction!(THREAD, recoveryInput(), persistedState())).state,
        ).toBe("unknown");
      }
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            adapter.workbenchCodeAction!(
              THREAD,
              { ...recoveryInput(), expectedRevision: 2 },
              persistedState(),
            ),
          ),
        ),
      ).toBe(true);
      expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(3);
    }),
);

it.live("negative explicit retries cannot resolve an earlier unknown Code recovery", () =>
  Effect.gen(function* () {
    const { adapter, gateway } = yield* setup();
    const mode: { reply: unknown } = { reply: "drop" };
    recoveryFixture(gateway, mode);
    const input = recoveryInput("uncertain-control");
    expect((yield* adapter.workbenchCodeAction!(THREAD, input, persistedState())).state).toBe(
      "unknown",
    );
    for (const state of ["busy", "conflict", "unsupported", "unavailable"] as const) {
      mode.reply = {
        version: 1,
        state,
        reason: "No current effect; original receipt remains unknown.",
      };
      const result = yield* adapter.workbenchCodeAction!(THREAD, input, persistedState());
      expect(result.state).toBe("unknown");
      if (result.state !== "applied") {
        expect(result.reason).toContain(state);
        expect(result.reason).toContain("original receipt remains unknown");
        expect(result.reason.length).toBeLessThanOrEqual(1024);
      }
    }
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(5);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.workbenchCodeAction!(THREAD, { ...input, newWindow: true }, persistedState()),
        ),
      ),
    ).toBe(true);
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(5);
    mode.reply = recoveryReply(input.commandId);
    expect((yield* adapter.workbenchCodeAction!(THREAD, input, persistedState())).state).toBe(
      "applied",
    );
    expect(gateway.requestsFor("workbench.codeAction")).toHaveLength(6);
  }),
);
