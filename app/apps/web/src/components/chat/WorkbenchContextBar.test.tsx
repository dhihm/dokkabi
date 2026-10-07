import { ThreadId } from "@t3tools/contracts";
import type {
  ProviderWorkbenchOverview,
  ProviderWorkbenchOverviewResult,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The real DialogPopup renders through a portal, which static markup never
// includes. The mock below mirrors the REAL components' data-slot contract
// (ui/dialog.tsx) as pass-through divs — the same pattern ContextWindowMeter
// uses for popovers — so these tests verify the bar composes the canonical
// header/panel/footer; padding and scrolling stay the real primitives'.
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
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2 data-slot="dialog-title">{children}</h2>
  ),
}));

import {
  caseCoverageOf,
  formatCompact,
  resolveWorkbenchOverviewBar,
  sameWorkbenchOverviewScope,
  sourceRefLabel,
  todoActivityOf,
  usageTotalOf,
  type RetainedWorkbenchOverview,
} from "./WorkbenchContextBar.logic";
import { WorkbenchContextBarView, WorkbenchOverviewSourceDetails } from "./WorkbenchContextBar";
import {
  WORKBENCH_OVERVIEW_REFRESH_INTERVAL_MS,
  workbenchOverviewScopeKey,
} from "~/state/workbenchOverview";

/**
 * R3 WorkbenchContextBar scenarios (docs/internals/dokkabi-overview-r3.md):
 * a live error with retained data stays visibly stale; a different
 * thread/instance/environment never shows its predecessor's data; missing
 * counts read Unknown — never 0/0 or 100%; unsupported capability results
 * hide the bar; the summary refreshes on a bounded real interval; source
 * disclosure is reachable and carries the recorded refs and both heads.
 */

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};

const THREAD = ThreadId.make("thread-bar-1");
const OTHER_THREAD = ThreadId.make("thread-bar-2");

const overview = (
  overrides: {
    work?: Partial<ProviderWorkbenchOverview["work"]>;
    context?: Partial<ProviderWorkbenchOverview["context"]>;
  } = {},
): ProviderWorkbenchOverview => ({
  version: 1,
  sessionCursor: { sessionId: "s1", seq: 12, hash: hex64("head"), generation: hex64("gen") },
  gatewayCursor: { seq: 4, hash: hex64("ghead"), generation: hex64("ggen") },
  resnapshot: false,
  work: {
    state: "available",
    goal: {
      id: "goal-1",
      statement: "Ship the recorded overview",
      source: { seq: 3, hash: hex64("goal") },
    },
    planDigest: hex64("plan"),
    todos: [
      { id: "t1", title: "One", class: "host", state: "ready", priority: 1 },
      { id: "t2", title: "Two", class: "host", state: "blocked", priority: 2 },
      { id: "t3", title: "Three", class: "impl", state: "green", priority: 3 },
    ],
    cases: { total: 4, green: 1, red: 0, pending: 3 },
    errors: [],
    ...overrides.work,
  },
  context: {
    state: "available",
    mode: "on",
    revision: 7,
    digest: hex64("graph"),
    frame: { id: "cf-2", stage: "dispatched", source: { seq: 9, hash: hex64("frame") } },
    lessonCount: 2,
    errors: [],
    ...overrides.context,
  },
  usage: {
    records: 2,
    input: { total: 1_500, missing: 0, latestSource: { seq: 8, hash: hex64("u8") } },
    output: { total: 320, missing: 0, latestSource: { seq: 8, hash: hex64("u8") } },
    reasoning: { total: null, missing: 2, latestSource: null },
    cacheRead: { total: 9_000, missing: 0, latestSource: { seq: 8, hash: hex64("u8") } },
    cacheWrite: { total: null, missing: 2, latestSource: null },
  },
});

const available = (data: ProviderWorkbenchOverview): ProviderWorkbenchOverviewResult => ({
  status: "available",
  overview: data,
});

const SCOPE = JSON.stringify(["env", THREAD, "dokkabi"]);

const view = (
  query: {
    data: ProviderWorkbenchOverviewResult | null;
    error: string | null;
    isPending: boolean;
  },
  retained: RetainedWorkbenchOverview | null = null,
  scopeKey: string = SCOPE,
) =>
  renderToStaticMarkup(
    <WorkbenchContextBarView
      threadId={THREAD}
      state={resolveWorkbenchOverviewBar({ scopeKey, query, retained })}
    />,
  );

describe("WorkbenchContextBar view logic", () => {
  it("a fresh success (no live error) replaces the retained view and is not stale", () => {
    const fresh = overview();
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: { data: available(fresh), error: null, isPending: false },
      retained: { scopeKey: SCOPE, overview: overview() },
    });
    expect(state).toEqual({ kind: "view", overview: fresh, staleError: null });
  });

  it("a live error with the retained success still in data stays visibly stale", () => {
    const retained = overview();
    // The query lifecycle keeps the previous success through a Failure: data
    // and error arrive together, and the error outranks the cached value.
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: { data: available(retained), error: "connection lost", isPending: false },
      retained: { scopeKey: SCOPE, overview: retained },
    });
    expect(state.kind).toBe("view");
    if (state.kind === "view") {
      expect(state.staleError).toBe("connection lost");
      expect(state.overview).toBe(retained);
    }
  });

  it("an in-flight refresh after a failure keeps the stale view (stale is not cleared)", () => {
    const retained = overview();
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: { data: null, error: "still failing", isPending: true },
      retained: { scopeKey: SCOPE, overview: retained },
    });
    expect(state).toEqual({ kind: "view", overview: retained, staleError: "still failing" });
  });

  it("a different thread never observes its predecessor's retained view", () => {
    const state = resolveWorkbenchOverviewBar({
      scopeKey: JSON.stringify(["env", OTHER_THREAD, "dokkabi"]),
      query: { data: null, error: "connection lost", isPending: false },
      retained: { scopeKey: SCOPE, overview: overview() },
    });
    // No stale predecessor data: the failure surfaces for THIS thread.
    expect(state.kind).toBe("unavailable");
  });

  it("a different provider instance never observes the other instance's retained view", () => {
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: { data: null, error: "connection lost", isPending: false },
      retained: { scopeKey: JSON.stringify(["env", THREAD, "codex"]), overview: overview() },
    });
    expect(state.kind).toBe("unavailable");
  });

  it("scope keys separate environments, instances, threads and the unknown-instance case", () => {
    expect(
      workbenchOverviewScopeKey({
        environmentId: "e" as never,
        threadId: THREAD,
        providerInstanceId: undefined,
      }),
    ).toBe(JSON.stringify(["e", THREAD, null]));
    expect(
      workbenchOverviewScopeKey({
        environmentId: "e" as never,
        threadId: THREAD,
        providerInstanceId: "dokkabi" as never,
      }),
    ).toBe(JSON.stringify(["e", THREAD, "dokkabi"]));
    // The same thread/instance moving to another environment is a new scope.
    expect(
      workbenchOverviewScopeKey({
        environmentId: "e" as never,
        threadId: THREAD,
        providerInstanceId: "dokkabi" as never,
      }),
    ).not.toBe(
      workbenchOverviewScopeKey({
        environmentId: "f" as never,
        threadId: THREAD,
        providerInstanceId: "dokkabi" as never,
      }),
    );
    expect(
      sameWorkbenchOverviewScope(
        { environmentId: "e" as never, threadId: THREAD, providerInstanceId: "dokkabi" as never },
        { environmentId: "e" as never, threadId: THREAD, providerInstanceId: "codex" as never },
      ),
    ).toBe(false);
    expect(
      sameWorkbenchOverviewScope(
        { environmentId: "e" as never, threadId: THREAD, providerInstanceId: "dokkabi" as never },
        {
          environmentId: "e" as never,
          threadId: OTHER_THREAD,
          providerInstanceId: "dokkabi" as never,
        },
      ),
    ).toBe(false);
  });

  it("the summary refreshes on a bounded real interval", () => {
    expect(WORKBENCH_OVERVIEW_REFRESH_INTERVAL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(WORKBENCH_OVERVIEW_REFRESH_INTERVAL_MS)).toBe(true);
  });

  it("an unsupported capability result hides the bar entirely", () => {
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: {
        data: { status: "unsupported", reason: "no capability" },
        error: null,
        isPending: false,
      },
      retained: { scopeKey: SCOPE, overview: overview() },
    });
    expect(state.kind).toBe("hidden");
  });

  it("an unavailable source is visible with its reason, never empty success", () => {
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: {
        data: { status: "unavailable", reason: "gateway not bound" },
        error: null,
        isPending: false,
      },
      retained: null,
    });
    expect(state).toEqual({ kind: "unavailable", reason: "gateway not bound" });
  });

  it("missing case counts stay unknown and never read as 0/0 verified", () => {
    const missing = caseCoverageOf(
      overview({
        work: { state: "missing", goal: null, planDigest: null, todos: [], cases: null },
      }),
    );
    expect(missing).toEqual({ kind: "unknown" });
    const invalid = caseCoverageOf(overview({ work: { state: "invalid", cases: null } }));
    expect(invalid).toEqual({ kind: "invalid" });
    expect(caseCoverageOf(overview())).toEqual({ kind: "counts", green: 1, total: 4 });
  });

  it("unmeasured usage reads Unknown, measured usage formats compactly", () => {
    const data = overview();
    expect(usageTotalOf(data, "reasoning")).toBe("Unknown");
    expect(usageTotalOf(data, "input")).toBe("1.5k");
    expect(usageTotalOf(data, "output")).toBe("320");
    expect(formatCompact(2_400_000)).toBe("2.4M");
  });

  it("todo activity reports recorded states only — ready is not running", () => {
    expect(todoActivityOf(overview())).toEqual({ ready: 1, red: 0, blocked: 1 });
    const red = overview({
      work: {
        todos: [
          { id: "r", title: "R", class: "host", state: "red", priority: 1 },
          { id: "b", title: "B", class: "host", state: "blocked", priority: 2 },
        ],
      },
    });
    expect(todoActivityOf(red)).toEqual({ ready: 0, red: 1, blocked: 1 });
    expect(todoActivityOf(overview())).not.toHaveProperty("running");
  });

  it("source refs render as seq plus a stable hash head", () => {
    expect(sourceRefLabel({ seq: 12, hash: hex64("head") })).toMatch(/^seq 12 · [0-9a-f]{12}…$/u);
  });
});

describe("WorkbenchContextBar rendering", () => {
  it("renders the recorded goal, coverage, TODO states, frame and usage", () => {
    const markup = view({ data: available(overview()), error: null, isPending: false });
    expect(markup).toContain("Ship the recorded overview");
    expect(markup).toContain("Cases 1/4 GREEN");
    expect(markup).toContain("1 ready · 0 red · 1 blocked");
    expect(markup).toContain("Frame dispatched");
    // The bar's usage is the MAIN session only — labeled as such (R8).
    expect(markup).toContain("Main usage In 1.5k · Out 320");
    expect(markup).toContain('data-stale="false"');
  });

  it("offers the recorded graph panel actions when a host provides them (R4)", () => {
    const state = resolveWorkbenchOverviewBar({
      scopeKey: SCOPE,
      query: { data: available(overview()), error: null, isPending: false },
      retained: null,
    });
    const withActions = renderToStaticMarkup(
      <WorkbenchContextBarView
        threadId={THREAD}
        state={state}
        onOpenGraph={(graphType) => void graphType}
      />,
    );
    expect(withActions).toContain('data-workbench-open-work-graph="true"');
    expect(withActions).toContain('data-workbench-open-context-graph="true"');
    expect(withActions).toContain("Work graph");
    expect(withActions).toContain("Context graph");
    // Without a host callback (no right-panel host), the actions stay absent.
    const withoutActions = view({ data: available(overview()), error: null, isPending: false });
    expect(withoutActions).not.toContain('data-workbench-open-work-graph="true"');
    expect(withoutActions).not.toContain('data-workbench-open-context-graph="true"');
  });

  it("missing work data reads Unknown and never claims a verified 0/0 project", () => {
    const empty = overview({
      work: { state: "missing", goal: null, planDigest: null, todos: [], cases: null },
    });
    const markup = view({ data: available(empty), error: null, isPending: false });
    expect(markup).toContain("No recorded plan");
    expect(markup).toContain("Cases Unknown");
    expect(markup).not.toContain("Cases 0/0");
  });

  it("labels retained data stale on a refresh failure", () => {
    const retained = overview();
    const markup = view(
      { data: available(retained), error: "connection lost", isPending: false },
      { scopeKey: SCOPE, overview: retained },
    );
    expect(markup).toContain('data-stale="true"');
    expect(markup).toContain('data-stale-banner="true"');
    expect(markup).toContain("Cases 1/4 GREEN");
  });

  it("keeps the source disclosure reachable for keyboard and pointer use", () => {
    const markup = view({ data: available(overview()), error: null, isPending: false });
    expect(markup).toContain('data-workbench-overview-details-trigger="true"');
    expect(markup).toContain("aria-expanded=");
    expect(markup).toContain("Sources");
  });

  it("composes the source dialog from the canonical header, scrollable panel and footer", () => {
    const markup = view({ data: available(overview()), error: null, isPending: false });
    // Padded title block (DialogHeader), scrollable body (DialogPanel with
    // the standard ScrollArea) and an always-visible footer that keeps the
    // close action reachable on short viewports — text never sits flush
    // against the popup's rounded boundary.
    expect(markup).toContain('data-slot="dialog-header"');
    expect(markup).toContain('data-slot="dialog-panel"');
    expect(markup).toContain('data-slot="dialog-footer"');
    const footerStart = markup.indexOf('data-slot="dialog-footer"');
    expect(footerStart).toBeGreaterThan(-1);
    const closeInFooter = markup
      .slice(footerStart)
      .includes('data-workbench-overview-details-close="true"');
    expect(closeInFooter).toBe(true);
    // The source body itself lives inside the scrollable panel, not loose
    // inside the popup.
    const panelStart = markup.indexOf('data-slot="dialog-panel"');
    const panelEnd = markup.indexOf('data-slot="dialog-footer"');
    expect(markup.slice(panelStart, panelEnd)).toContain("data-workbench-overview-sources");
  });

  it("renders recorded source refs, TODO rows and usage accounting in the disclosure", () => {
    const markup = renderToStaticMarkup(<WorkbenchOverviewSourceDetails overview={overview()} />);
    expect(markup).toMatch(/seq 3 · [0-9a-f]{12}…/u);
    expect(markup).toContain("Plan digest:");
    expect(markup).toContain("cf-2 — dispatched");
    expect(markup).toContain("2 missing records");
    expect(markup).toContain("Across 2 recorded usage rows");
    expect(markup).toContain('data-todo-state="ready"');
    expect(markup).toContain('data-todo-state="blocked"');
    expect(markup).toContain("1 ready · 0 red · 1 blocked");
  });

  it("renders both source head identities with seq, generation and hash", () => {
    const markup = renderToStaticMarkup(<WorkbenchOverviewSourceDetails overview={overview()} />);
    expect(markup).toContain("data-session-head");
    expect(markup).toContain("session s1 · seq 12");
    expect(markup).toContain("data-gateway-head");
    expect(markup).toContain("gateway · seq 4");
  });

  it("renders an invalid plan honestly, with its recorded errors", () => {
    const invalid = overview({
      work: {
        state: "invalid",
        cases: null,
        todos: [],
        errors: ["the goal awaits its sealed plan"],
      },
    });
    const markup = view({ data: available(invalid), error: null, isPending: false });
    expect(markup).toContain("Cases Unknown — recorded plan invalid");
    const details = renderToStaticMarkup(<WorkbenchOverviewSourceDetails overview={invalid} />);
    expect(details).toContain("the goal awaits its sealed plan");
  });

  it("renders explicit invalid context errors; missing context never means disabled", () => {
    const invalidContext = overview({
      context: {
        state: "invalid",
        mode: null,
        revision: null,
        digest: null,
        frame: null,
        lessonCount: null,
        errors: ["the recorded context rows cannot be folded"],
      },
    });
    const details = renderToStaticMarkup(
      <WorkbenchOverviewSourceDetails overview={invalidContext} />,
    );
    expect(details).toContain("the recorded context rows cannot be folded");
    const missingContext = overview({
      context: {
        state: "missing",
        mode: null,
        revision: null,
        digest: null,
        frame: null,
        lessonCount: null,
      },
    });
    const missingDetails = renderToStaticMarkup(
      <WorkbenchOverviewSourceDetails overview={missingContext} />,
    );
    expect(missingDetails).toContain("mode unknown");
    expect(missingDetails).toContain("No context frame recorded.");
    expect(missingDetails).not.toContain("disabled");
  });

  it("renders unavailable and hidden states from the capability result alone", () => {
    const unavailableMarkup = view({
      data: { status: "unavailable", reason: "gateway not bound" },
      error: null,
      isPending: false,
    });
    expect(unavailableMarkup).toContain("Harness overview unavailable");
    expect(unavailableMarkup).toContain("gateway not bound");
    const hiddenMarkup = view({
      data: { status: "unsupported", reason: "none" },
      error: null,
      isPending: false,
    });
    expect(hiddenMarkup).toBe("");
  });
});
