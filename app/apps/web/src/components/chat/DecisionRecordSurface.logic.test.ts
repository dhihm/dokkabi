import type {
  ProviderWorkbenchRecord,
  ProviderWorkbenchRecordResult,
  WorkbenchRecordCursor,
  WorkbenchRecordRow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decisionsFact,
  pinOf,
  recordHeadContinuityError,
  recordPageIntegrityError,
  recordRowJson,
  recordRowLabel,
  resolveDecisionRecordPanel,
  sameWorkbenchRecordScope,
  type RetainedWorkbenchRecordPage,
} from "./DecisionRecordSurface.logic";
import { WORKBENCH_RECORD_PAGE_LIMIT, workbenchRecordScopeKey } from "~/state/workbenchRecord";

/**
 * R5 Decision/Record surface scenarios (docs/internals/dokkabi-records-r5.md):
 * panel source resolution keeps same-scope retention and quarantines broken
 * replacements; a different thread/instance/page never shows its
 * predecessor's rows; page integrity refuses non-contiguous, premature or
 * lying pages; a pin survives appends because a pinned prefix below the
 * head is not a replacement; decisions stay the capability fact.
 */

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};
const genesis = "0".repeat(64);

const row = (seq: number, prev: string): WorkbenchRecordRow => ({
  seq,
  ts: `2026-10-02T00:00:${String(seq).padStart(2, "0")}.000Z`,
  kind: "observe",
  name: "test/source",
  prev_hash: prev,
  hash: hex64(`row-${seq}`),
  payload: { text: `retained row ${seq}` },
});

const rows = (count: number): WorkbenchRecordRow[] =>
  Array.from({ length: count }, (_, index) =>
    row(index + 1, index === 0 ? genesis : hex64(`row-${index}`)),
  );

const page = (
  overrides: Partial<Extract<ProviderWorkbenchRecord, { state: "available" }>> = {},
): ProviderWorkbenchRecord => ({
  version: 1,
  state: "available",
  sessionCursor: { sessionId: "s1", seq: 3, hash: hex64("head-3"), generation: hex64("gen") },
  gatewayCursor: { seq: 4, hash: hex64("ghead-4"), generation: hex64("ggen") },
  asOf: { sessionId: "s1", seq: 3, hash: hex64("head-3"), generation: hex64("gen") },
  records: rows(3),
  next: null,
  total: 3,
  hasMore: false,
  decisions: { status: "unsupported", reason: "no decision execution surface" },
  ...overrides,
});

const result = (record: ProviderWorkbenchRecord): ProviderWorkbenchRecordResult => ({
  status: "available",
  record,
});

const view = (data: ProviderWorkbenchRecordResult | null, error: string | null = null) => ({
  data,
  error,
  isPending: data === null && error === null,
});

const retained = (record: ProviderWorkbenchRecord): RetainedWorkbenchRecordPage => ({
  scopeKey: "scope-key",
  page: record,
});

describe("resolveDecisionRecordPanel", () => {
  it("renders a fresh available page and retains it for the scope", () => {
    const state = resolveDecisionRecordPanel({
      scopeKey: "scope-key",
      query: view(result(page())),
      retained: null,
    });
    expect(state.kind).toBe("view");
    if (state.kind === "view") {
      expect(state.page.records).toHaveLength(3);
      expect(state.staleError).toBeNull();
    }
  });

  it("keeps same-scope data visibly stale across a live error", () => {
    const state = resolveDecisionRecordPanel({
      scopeKey: "scope-key",
      query: view(null, "transport lost"),
      retained: retained(page()),
    });
    expect(state).toMatchObject({ kind: "view", staleError: "transport lost" });
  });

  it("discards retention from another scope before deciding anything", () => {
    const state = resolveDecisionRecordPanel({
      scopeKey: "another-scope",
      query: view(null, "transport lost"),
      retained: retained(page()),
    });
    expect(state).toMatchObject({ kind: "unavailable" });
  });

  it("renders the retained page without polling while hidden", () => {
    const state = resolveDecisionRecordPanel({
      scopeKey: "scope-key",
      query: view(null, null),
      retained: retained(page()),
      subscribed: false,
    });
    expect(state).toMatchObject({ kind: "view", staleError: null });
  });

  it("quarantines a replacement that rewinds the session head", () => {
    const replacement = page({
      sessionCursor: { sessionId: "s1", seq: 2, hash: hex64("head-2"), generation: hex64("gen") },
      asOf: { sessionId: "s1", seq: 2, hash: hex64("head-2"), generation: hex64("gen") },
      records: rows(2),
      total: 2,
    });
    const state = resolveDecisionRecordPanel({
      scopeKey: "scope-key",
      query: view(result(replacement)),
      retained: retained(page()),
    });
    expect(state.kind).toBe("view");
    if (state.kind === "view") {
      expect(state.page.records).toHaveLength(3);
      expect(state.staleError).toContain("rewound");
    }
  });

  it("quarantines a forged non-contiguous page instead of rendering it", () => {
    const forged = page({
      records: [row(1, genesis), row(3, hex64("row-1"))],
      hasMore: true,
      next: { seq: 3, hash: hex64("row-3"), generation: hex64("gen") },
    });
    const state = resolveDecisionRecordPanel({
      scopeKey: "scope-key",
      query: view(result(forged)),
      retained: retained(page()),
    });
    expect(state.kind === "view" && state.staleError !== null).toBe(true);
  });

  it("maps unsupported and unavailable results to explicit states", () => {
    expect(
      resolveDecisionRecordPanel({
        scopeKey: "scope-key",
        query: view({ status: "unsupported", reason: "older gateway" }),
        retained: null,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "older gateway" });
    expect(
      resolveDecisionRecordPanel({
        scopeKey: "scope-key",
        query: view({ status: "unavailable", reason: "detached" }),
        retained: null,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "detached" });
    // An available envelope without a payload is never trusted.
    expect(
      resolveDecisionRecordPanel({
        scopeKey: "scope-key",
        query: view({ status: "available" }),
        retained: null,
      }).kind,
    ).toBe("unavailable");
  });

  it("keys retention by the composite page scope", () => {
    const base = {
      environmentId: "env" as never,
      threadId: "t1" as never,
      limit: WORKBENCH_RECORD_PAGE_LIMIT,
    };
    expect(
      sameWorkbenchRecordScope(base, {
        ...base,
        after: { seq: 2, hash: hex64("r2"), generation: hex64("gen") },
      }),
    ).toBe(false);
    expect(
      sameWorkbenchRecordScope(base, {
        ...base,
        asOf: { sessionId: "s1", seq: 3, hash: hex64("h"), generation: hex64("gen") },
      }),
    ).toBe(false);
    expect(sameWorkbenchRecordScope(base, { ...base, providerInstanceId: "inst" as never })).toBe(
      false,
    );
    expect(workbenchRecordScopeKey(base)).not.toBe(
      workbenchRecordScopeKey({ ...base, threadId: "t2" as never }),
    );
  });

  it("same ordinal with a different exact cursor identity is a different view", () => {
    const after = { seq: 50, hash: "a".repeat(64), generation: "b".repeat(64) };
    const asOf = {
      sessionId: "source-parent",
      seq: 100,
      hash: "c".repeat(64),
      generation: "b".repeat(64),
    };
    const base = {
      environmentId: "env" as never,
      threadId: "t1" as never,
      limit: WORKBENCH_RECORD_PAGE_LIMIT,
      after,
      asOf,
    };
    // Equivalent cursors keep the same identity...
    expect(workbenchRecordScopeKey({ ...base, after: { ...after }, asOf: { ...asOf } })).toBe(
      workbenchRecordScopeKey(base),
    );
    // ...while a same-ordinal alias of any exact field never does.
    expect(
      workbenchRecordScopeKey({ ...base, after: { ...after, hash: "d".repeat(64) } }),
    ).not.toBe(workbenchRecordScopeKey(base));
    expect(
      workbenchRecordScopeKey({ ...base, after: { ...after, generation: "d".repeat(64) } }),
    ).not.toBe(workbenchRecordScopeKey(base));
    expect(
      workbenchRecordScopeKey({ ...base, asOf: { ...asOf, sessionId: "source-child" } }),
    ).not.toBe(workbenchRecordScopeKey(base));
    expect(workbenchRecordScopeKey({ ...base, asOf: { ...asOf, hash: "d".repeat(64) } })).not.toBe(
      workbenchRecordScopeKey(base),
    );
    expect(
      workbenchRecordScopeKey({ ...base, asOf: { ...asOf, generation: "d".repeat(64) } }),
    ).not.toBe(workbenchRecordScopeKey(base));
  });
});

describe("recordPageIntegrityError", () => {
  it("accepts an exact complete page", () => {
    expect(recordPageIntegrityError({ page: page() })).toBeNull();
  });

  it("accepts an exact pinned continuation after a cursor", () => {
    const continuation = page({
      records: [row(2, hex64("row-1")), row(3, hex64("row-2"))],
    });
    const after: WorkbenchRecordCursor = { seq: 1, hash: hex64("row-1"), generation: hex64("gen") };
    expect(recordPageIntegrityError({ page: continuation, after })).toBeNull();
  });

  it("refuses a premature complete page while rows remain in the prefix", () => {
    const premature = page({
      records: rows(2),
    });
    expect(recordPageIntegrityError({ page: premature })).toContain(
      "must end at the pinned prefix",
    );
  });

  it("refuses empty success from a nonempty window", () => {
    const empty = page({ records: [] });
    expect(recordPageIntegrityError({ page: empty })).toContain("must end at the pinned prefix");
  });

  it("refuses non-contiguous rows and broken prev_hash chaining", () => {
    expect(
      recordPageIntegrityError({
        page: page({ records: [row(1, genesis), row(3, hex64("row-1"))] }),
      }),
    ).toContain("not contiguous");
    expect(
      recordPageIntegrityError({
        page: page({ records: [row(1, genesis), row(2, hex64("wrong-prev"))] }),
      }),
    ).toContain("does not chain");
  });

  it("refuses a page that does not begin exactly after the requested cursor", () => {
    const continuation = page({ records: [row(3, hex64("row-2"))] });
    const after: WorkbenchRecordCursor = { seq: 1, hash: hex64("row-1"), generation: hex64("gen") };
    expect(recordPageIntegrityError({ page: continuation, after })).toContain(
      "does not begin exactly after",
    );
  });

  it("refuses lying next/hasMore boundaries and totals", () => {
    expect(
      recordPageIntegrityError({
        page: page({ records: rows(2), hasMore: true, next: null }),
      }),
    ).toContain("next cursor must be the last included row");
    expect(
      recordPageIntegrityError({
        page: page({ records: [], hasMore: true, next: null }),
      }),
    ).toContain("claims more rows remain");
    expect(
      recordPageIntegrityError({
        page: page({ next: { seq: 3, hash: hex64("row-3"), generation: hex64("gen") } }),
      }),
    ).toContain("must not carry a next cursor");
    expect(recordPageIntegrityError({ page: page({ total: 5 }) })).toContain(
      "pinned prefix's own seq",
    );
  });

  it("accepts only the honest unavailable body", () => {
    const unavailable: ProviderWorkbenchRecord = {
      version: 1,
      state: "unavailable",
      reason: "a row exceeds the byte bound",
      sessionCursor: { sessionId: "s1", seq: 3, hash: hex64("head-3"), generation: hex64("gen") },
      gatewayCursor: { seq: 4, hash: hex64("ghead-4"), generation: hex64("ggen") },
      asOf: { sessionId: "s1", seq: 3, hash: hex64("head-3"), generation: hex64("gen") },
      records: [],
      next: null,
      total: 3,
      hasMore: false,
      decisions: { status: "unsupported", reason: "no decision execution surface" },
    };
    expect(recordPageIntegrityError({ page: unavailable })).toBeNull();
    expect(
      recordPageIntegrityError({
        page: { ...unavailable, records: rows(1), hasMore: true },
      }),
    ).toContain("must not carry rows");
  });
});

describe("record head continuity with pins", () => {
  it("a pinned prefix below a grown head is NOT a replacement", () => {
    const previous = page();
    const grown = page({
      sessionCursor: { sessionId: "s1", seq: 7, hash: hex64("head-7"), generation: hex64("gen") },
      asOf: { sessionId: "s1", seq: 3, hash: hex64("head-3"), generation: hex64("gen") },
    });
    expect(recordHeadContinuityError(previous, grown)).toBeNull();
  });

  it("a replaced generation or session is a replacement", () => {
    expect(
      recordHeadContinuityError(
        page(),
        page({
          sessionCursor: {
            sessionId: "s1",
            seq: 3,
            hash: hex64("head-3"),
            generation: hex64("other"),
          },
          asOf: { sessionId: "s1", seq: 3, hash: hex64("head-3"), generation: hex64("other") },
        }),
      ),
    ).toContain("generation");
    expect(
      recordHeadContinuityError(
        page(),
        page({
          sessionCursor: {
            sessionId: "s2",
            seq: 3,
            hash: hex64("head-3"),
            generation: hex64("gen"),
          },
          asOf: { sessionId: "s2", seq: 3, hash: hex64("head-3"), generation: hex64("gen") },
        }),
      ),
    ).toContain("session");
  });
});

describe("decisions and row display", () => {
  it("keeps decisions a capability fact with fixed vocabulary", () => {
    const fact = decisionsFact(page().decisions);
    expect(fact.status).toBe("unsupported");
    expect(fact.reason).toContain("no decision execution surface");
  });

  it("labels rows exactly and renders their JSON as inert text", () => {
    const first = row(1, genesis);
    expect(recordRowLabel(first)).toBe(`1 · observe · test/source`);
    const json = recordRowJson(first);
    expect(json).toContain(`"seq": 1`);
    expect(json).toContain(`"payload"`);
    expect(typeof json).toBe("string");
  });

  it("captures the pin from the displayed page's own asOf", () => {
    expect(pinOf(page()).seq).toBe(3);
  });
});
