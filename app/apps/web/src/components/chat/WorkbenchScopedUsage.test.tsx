import { ThreadId } from "@t3tools/contracts";
import type {
  ProviderWorkbenchOverviewResult,
  ProviderWorkbenchUsageReport,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The dialog body resolves its data through the environment query hook;
// static rendering only needs the hook's view shape. Mocking it also lets
// these tests PROVE the closed dialog never subscribes (no fetch happens
// until the dialog opens) and that the refresh control is wired to the
// query's own refresh.
const usageQuerySpy = vi.hoisted(() =>
  vi.fn((): Record<string, unknown> => ({
    data: null,
    dataUpdatedAt: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: () => undefined,
  })),
);
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: usageQuerySpy,
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));

// The real DialogPopup renders through a portal, which static markup never
// includes; the mock mirrors the REAL components' data-slot contract.
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children, ...rest }: { children: ReactNode }) => (
    <div {...rest} data-slot="dialog-popup">
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div data-slot="dialog-header">{children}</div>
  ),
  DialogPanel: ({ children }: { children: ReactNode }) => (
    <div data-slot="dialog-panel">{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div data-slot="dialog-footer">{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2 data-slot="dialog-title">{children}</h2>,
}));

import {
  childScopeStateLabel,
  resolveWorkbenchScopedUsage,
  scopedUsageMetricLabel,
  scopedUsageStateLabel,
  usageCountsGapLabel,
} from "./WorkbenchContextBar.logic";
import {
  WorkbenchScopedUsageDialog,
  WorkbenchScopedUsageDialogBody,
  WorkbenchScopedUsageReportView,
} from "./WorkbenchContextBar";
import {
  WORKBENCH_SCOPED_USAGE_QUERY_OPTIONS,
  workbenchScopedUsageScopeKey,
} from "~/state/workbenchOverview";

/**
 * R8 scoped run usage dialog scenarios: the on-demand read is a separate
 * keyed query with NO refresh interval (it fetches only when the dialog
 * opens and on an explicit Refresh), the view shows the MAIN scope labeled
 * as Main usage plus every referenced child with its own recorded status
 * and totals (Unknown where nothing was measured, request/usage gaps kept
 * explicit, reasoning included in output, cache counted separately), and
 * the original-source proof disclosure carries child prefix hashes and
 * parent provenance — never credentials or host paths. There is no
 * monetary estimate anywhere.
 */

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};

const THREAD = ThreadId.make("thread-scoped-usage-ui");

const report = (): ProviderWorkbenchUsageReport => ({
  state: "partial",
  main: {
    sessionId: "live-parent01",
    head: { seq: 210, hash: hex64("main-head") },
    settled: false,
    counts: { requests: 3, sends: 3, completedUsage: 2 },
    usage: {
      records: 2,
      input: { total: 1_500, missing: 0, latestSource: { seq: 8, hash: hex64("u8") } },
      output: { total: 320, missing: 0, latestSource: { seq: 8, hash: hex64("u8") } },
      reasoning: { total: null, missing: 2, latestSource: null },
      cacheRead: { total: 9_000, missing: 0, latestSource: { seq: 8, hash: hex64("u8") } },
      cacheWrite: { total: null, missing: 2, latestSource: null },
    },
  },
  scopes: [
    {
      id: "live-parent01-accept-0001",
      roles: ["spec", "verifier"],
      state: "verified",
      provenance: [
        {
          producer: "work/step:accept",
          field: "verifier_session",
          ref: { seq: 30, hash: hex64("parent-30") },
          pinnedHash: hex64("child-pin-1"),
        },
      ],
      pinnedHead: { seq: 12, hash: hex64("child-pin-1") },
      head: { seq: 14, hash: hex64("child-head") },
      counts: { requests: 2, sends: 2, completedUsage: 1 },
      usage: {
        records: 1,
        input: { total: 4_100, missing: 0, latestSource: { seq: 9, hash: hex64("c9") } },
        output: { total: 80, missing: 0, latestSource: { seq: 9, hash: hex64("c9") } },
        reasoning: { total: 30, missing: 0, latestSource: { seq: 9, hash: hex64("c9") } },
        cacheRead: { total: null, missing: 1, latestSource: null },
        cacheWrite: { total: null, missing: 1, latestSource: null },
      },
      detail: null,
    },
    {
      id: "live-parent01-accept-0002",
      roles: ["verifier"],
      state: "unpinned",
      provenance: [
        {
          producer: "work/accept",
          field: "verifier_session",
          ref: { seq: 41, hash: hex64("parent-41") },
          pinnedHash: null,
        },
      ],
      pinnedHead: null,
      head: { seq: 3, hash: hex64("unpinned-head") },
      counts: null,
      usage: null,
      detail: "referenced without a pinned closed prefix",
    },
  ],
  aggregate: {
    scopesCounted: 2,
    counts: { requests: 5, sends: 5, completedUsage: 3 },
    input: { total: 5_600, missing: 0 },
    output: { total: 400, missing: 0 },
    reasoning: { total: 30, missing: 2 },
    cacheRead: { total: 9_000, missing: 1 },
    cacheWrite: { total: null, missing: 3 },
  },
  semantics: {
    totals: "recorded_usage_not_billing",
    reasoning: "included_in_output_total",
    cacheRead: "separate_from_input_total",
    cacheWrite: "separate_from_input_total",
  },
  details: ["child session live-parent01-accept-0002 is referenced but unpinned"],
  errors: [],
});

const query = (
  overrides: Partial<{
    data: ProviderWorkbenchOverviewResult | null;
    error: string | null;
    isPending: boolean;
  }>,
) => ({
  data: null as ProviderWorkbenchOverviewResult | null,
  error: null as string | null,
  isPending: false,
  ...overrides,
});

describe("scoped usage dialog logic", () => {
  it("resolves the typed scoped result states", () => {
    const view = resolveWorkbenchScopedUsage({
      query: query({
        data: {
          status: "available",
          overview: {} as never,
          scopedUsage: { status: "available", report: report() },
        },
      }),
    });
    expect(view.kind).toBe("view");

    const unsupported = resolveWorkbenchScopedUsage({
      query: query({
        data: {
          status: "available",
          overview: {} as never,
          scopedUsage: { status: "unsupported", reason: "older gateway" },
        },
      }),
    });
    expect(unsupported).toEqual({ kind: "unsupported", reason: "older gateway" });

    const unavailable = resolveWorkbenchScopedUsage({
      query: query({ data: { status: "unavailable", reason: "gateway not bound" } }),
    });
    expect(unavailable).toEqual({ kind: "unavailable", reason: "gateway not bound" });

    const pending = resolveWorkbenchScopedUsage({ query: query({ isPending: true }) });
    expect(pending).toEqual({ kind: "pending" });

    const failure = resolveWorkbenchScopedUsage({
      query: query({ error: "connection lost" }),
    });
    expect(failure).toEqual({ kind: "error", reason: "connection lost" });
  });

  it("labels report and child states without overclaiming", () => {
    expect(scopedUsageStateLabel("complete")).toBe("Complete");
    expect(scopedUsageStateLabel("partial")).toContain("Partial");
    expect(scopedUsageStateLabel("invalid")).toContain("Invalid");
    expect(childScopeStateLabel("verified")).toContain("Verified");
    expect(childScopeStateLabel("unpinned")).toContain("without a pinned prefix");
    expect(childScopeStateLabel("missing")).toContain("Missing");
    expect(childScopeStateLabel("invalid")).toContain("Invalid");
  });

  it("keeps request-versus-usage gaps explicit and unmeasured totals Unknown", () => {
    expect(usageCountsGapLabel({ requests: 2, sends: 2, completedUsage: 2 })).toBe(
      "2 requests · 2 completed usage rows",
    );
    expect(usageCountsGapLabel({ requests: 3, sends: 3, completedUsage: 1 })).toContain("unknown");
    expect(scopedUsageMetricLabel({ total: null })).toBe("Unknown");
    expect(scopedUsageMetricLabel({ total: 5_600 })).toBe("5.6k");
  });

  it("keys the scoped query by scope AND the flag, separating stale views", () => {
    const scope = {
      environmentId: "e" as never,
      threadId: THREAD,
      providerInstanceId: "dokkabi" as never,
    };
    const key = workbenchScopedUsageScopeKey(scope);
    // The flag is part of the key: a main-only view can never be observed
    // under the scoped key and vice versa.
    expect(key).toContain("includeChildUsage");
    expect(key).not.toBe(
      JSON.stringify(["e", THREAD, "dokkabi"]),
    );
    expect(key).not.toBe(
      workbenchScopedUsageScopeKey({ ...scope, threadId: ThreadId.make("other") }),
    );
    expect(key).not.toBe(
      workbenchScopedUsageScopeKey({ ...scope, environmentId: "f" as never }),
    );
  });

  it("runs no periodic refresh — reads happen only on open and explicit Refresh", () => {
    expect(
      (WORKBENCH_SCOPED_USAGE_QUERY_OPTIONS as Record<string, unknown>).refreshIntervalMs,
    ).toBeUndefined();
    expect(WORKBENCH_SCOPED_USAGE_QUERY_OPTIONS.staleTimeMs).toBe(0);
  });
});

describe("scoped usage dialog rendering", () => {
  it("renders the Total run usage trigger inside the dialog component", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchScopedUsageDialog
        environmentId={"e" as never}
        threadId={THREAD}
        providerInstanceId={"dokkabi" as never}
      />,
    );
    expect(markup).toContain('data-workbench-open-scoped-usage="true"');
    expect(markup).toContain("Total run usage");
  });

  it("never subscribes to the scoped query while the dialog is closed", () => {
    usageQuerySpy.mockClear();
    renderToStaticMarkup(
      <WorkbenchScopedUsageDialog
        environmentId={"e" as never}
        threadId={THREAD}
        providerInstanceId={"dokkabi" as never}
      />,
    );
    expect(usageQuerySpy).toHaveBeenCalledTimes(0);
  });

  it("subscribes once when the dialog body mounts and offers an explicit Refresh", () => {
    usageQuerySpy.mockClear();
    usageQuerySpy.mockImplementationOnce(() => ({
      data: {
        status: "available",
        overview: {} as never,
        scopedUsage: { status: "available", report: report() },
      } as ProviderWorkbenchOverviewResult,
      dataUpdatedAt: 1,
      error: null,
      isPending: false,
      isSuccess: true,
      refresh: () => undefined,
    }));
    const markup = renderToStaticMarkup(
      <WorkbenchScopedUsageDialogBody
        environmentId={"e" as never}
        threadId={THREAD}
        providerInstanceId={"dokkabi" as never}
      />,
    );
    expect(usageQuerySpy).toHaveBeenCalledTimes(1);
    expect(markup).toContain('data-workbench-scoped-usage-refresh="true"');
    expect(markup).toContain("Refresh");
  });

  it("renders main plus every referenced child with recorded totals and gaps", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchScopedUsageReportView state={{ kind: "view", report: report(), staleError: null }} />,
    );
    // The main scope is labeled MAIN ONLY usage.
    expect(markup).toContain("Main usage");
    expect(markup).toContain("live-parent01-accept-0001");
    expect(markup).toContain("live-parent01-accept-0002");
    // Recorded totals, missing fields Unknown, gaps explicit.
    expect(markup).toContain("5.6k");
    expect(markup).toContain("Unknown");
    expect(markup).toContain("unknown");
    // Tokens are recorded usage, never billing; no monetary estimate.
    expect(markup).toContain("not billing");
    expect(markup).not.toMatch(/\$|price|billing estimate/u);
    // Reasoning included in output; cache counted separately.
    expect(markup).toContain("Included in the output total");
    expect(markup).toContain("Counted separately");
    // An unsettled main turn stays visible.
    expect(markup).toContain("running");
  });

  it("carries child prefix hashes and parent provenance in the proof disclosure", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchScopedUsageReportView state={{ kind: "view", report: report(), staleError: null }} />,
    );
    expect(markup).toContain("Original source proof");
    expect(markup).toContain(hex64("child-pin-1").slice(0, 12));
    expect(markup).toContain("work/step:accept");
    expect(markup).toContain("verifier_session");
    // No host paths or credentials travel into the view.
    expect(markup).not.toMatch(/\/tmp\/|\/Users\/|password|secret|credential|api[_-]?key/iu);
  });

  it("renders unsupported, unavailable, error and pending states with reasons", () => {
    const unsupported = renderToStaticMarkup(
      <WorkbenchScopedUsageReportView state={{ kind: "unsupported", reason: "older gateway" }} />,
    );
    expect(unsupported).toContain("older gateway");
    const unavailable = renderToStaticMarkup(
      <WorkbenchScopedUsageReportView state={{ kind: "unavailable", reason: "not bound" }} />,
    );
    expect(unavailable).toContain("not bound");
    const failure = renderToStaticMarkup(
      <WorkbenchScopedUsageReportView state={{ kind: "error", reason: "connection lost" }} />,
    );
    expect(failure).toContain("connection lost");
    const pending = renderToStaticMarkup(
      <WorkbenchScopedUsageReportView state={{ kind: "pending" }} />,
    );
    expect(pending).toContain("reading");
  });
});
