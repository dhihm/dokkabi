import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RecordCompanionSnapshot, recordCompanionScopeKey } from "./recordCompanion.ts";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const scope = {
  environmentId: EnvironmentId.make("env-fixture"),
  threadId: ThreadId.make("thread-fixture"),
  providerInstanceId: ProviderInstanceId.make("instance-fixture"),
};
const cursor = { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) };
const packet = () => ({
  companionId: "11111111-1111-4111-8111-111111111111",
  scope,
  scopeKey: recordCompanionScopeKey(scope),
  descriptorRevision: 1,
  viewRevision: 1,
  presentationRevision: 1,
  view: { tab: "record", pin: null, after: null, selectedSeq: null },
  result: {
    status: "view",
    staleError: null,
    record: {
      version: 1,
      state: "available",
      sessionCursor: { ...cursor, sessionId: "owned-fixture" },
      gatewayCursor: cursor,
      asOf: { ...cursor, sessionId: "owned-fixture" },
      records: [],
      next: null,
      total: 0,
      hasMore: false,
      decisions: { status: "unsupported", reason: "Controlled missing capability." },
    },
  },
  sourceLabel: "Controlled record fixture",
  theme: { dark: false },
  tokens: {
    color: { background: null, surface: null, text: null, muted: null, border: null, accent: null },
    radius: { panel: null, control: null },
    spacing: { base: null },
    font: { family: null, familyMono: null, sizePrompt: null, sizeCode: null, lineHeight: null },
    transition: { durationMs: 160 },
  },
});
const decode = Schema.decodeUnknownSync(RecordCompanionSnapshot, { onExcessProperty: "error" });
describe("R6 independent closed source and presentation snapshot contract", () => {
  it("accepts a closed exact record and existing safe presentation tokens", () => {
    expect(() => decode(packet())).not.toThrow();
  });
  it("refuses an arbitrary object masquerading as a record projection", () => {
    const p = packet();
    (p.result as unknown as { record: unknown }).record = {
      bootstrapToken: "fixture-must-not-cross",
      endpoint: "http://127.0.0.1/fixture",
    };
    expect(() => decode(p)).toThrow();
  });
  it("refuses executable CSS values instead of accepting opaque token data", () => {
    const p = packet();
    (p.tokens.color as unknown as { background: string }).background =
      "url(http://127.0.0.1/fixture)";
    expect(() => decode(p)).toThrow();
  });
  it("refuses extra source metadata even when the retained record shape is valid", () => {
    const p = packet();
    Object.assign(p.result.record, { bootstrapToken: "fixture-must-not-cross" });
    expect(() => decode(p)).toThrow();
  });
  it("refuses unrelated main bridge data on the snapshot root", () => {
    expect(() => decode({ ...packet(), mainBridge: { bearerToken: "fixture" } })).toThrow();
  });
});
