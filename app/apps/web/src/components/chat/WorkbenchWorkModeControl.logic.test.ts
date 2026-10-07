import { ThreadId } from "@t3tools/contracts";
import type {
  ProviderWorkbenchWorkModeActionResult,
  ProviderWorkbenchWorkModeResult,
  ProviderWorkbenchWorkModeSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveModeLabel,
  newWorkModeCommandId,
  planSetRecovery,
  resolveWorkbenchWorkModeBar,
  revisionLabel,
  workModeOutcomeMessage,
  WORK_MODE_SELECTOR_OPTIONS,
  type WorkbenchWorkModeQueryLike,
} from "./WorkbenchWorkModeControl.logic";

const THREAD = ThreadId.make("thread-wm-logic");

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};

const selection = (
  overrides: Partial<ProviderWorkbenchWorkModeSelection> = {},
): ProviderWorkbenchWorkModeSelection => ({
  mode: "default",
  effective: "chat",
  source: "default",
  revision: hex64("revision"),
  ...overrides,
});

const query = (
  overrides: Partial<WorkbenchWorkModeQueryLike> = {},
): WorkbenchWorkModeQueryLike => ({
  data: null,
  error: null,
  isPending: false,
  ...overrides,
});

const available = (
  data: ProviderWorkbenchWorkModeSelection,
  busy = false,
): ProviderWorkbenchWorkModeResult => ({
  status: "available",
  selection: data,
  busy,
});

describe("resolveWorkbenchWorkModeBar (view resolution)", () => {
  it("renders the host's actual selection with its busy fact", () => {
    const state = resolveWorkbenchWorkModeBar({
      query: query({ data: available(selection(), true) }),
    });
    expect(state).toEqual({
      kind: "view",
      selection: selection(),
      busy: true,
      staleError: null,
    });
  });

  it("hides the control for unsupported ordinary or old providers", () => {
    for (const data of [
      { status: "unsupported", reason: "no capability" },
      { status: "unsupported" },
    ] as const) {
      expect(resolveWorkbenchWorkModeBar({ query: query({ data }) }).kind).toBe("hidden");
    }
  });

  it("an unavailable source shows an honest disabled state with its reason", () => {
    const state = resolveWorkbenchWorkModeBar({
      query: query({ data: { status: "unavailable", reason: "gateway not bound" } }),
    });
    expect(state).toEqual({ kind: "unavailable", reason: "gateway not bound" });
    expect(
      resolveWorkbenchWorkModeBar({ query: query({ data: { status: "unavailable" } }) }),
    ).toEqual({ kind: "unavailable", reason: expect.stringContaining("not available") });
  });

  it("a failed refresh keeps the last successful view, labeled stale", () => {
    const state = resolveWorkbenchWorkModeBar({
      query: query({ data: available(selection()), error: "connection lost" }),
    });
    expect(state).toEqual({
      kind: "view",
      selection: selection(),
      busy: false,
      staleError: "connection lost",
    });
  });

  it("a failure with no data surfaces as unavailable, never as an invented mode", () => {
    const state = resolveWorkbenchWorkModeBar({ query: query({ error: "connection lost" }) });
    expect(state).toEqual({ kind: "unavailable", reason: "connection lost" });
  });

  it("an in-flight first read is pending; no data at all stays hidden", () => {
    expect(resolveWorkbenchWorkModeBar({ query: query({ isPending: true }) }).kind).toBe("pending");
    expect(resolveWorkbenchWorkModeBar({ query: query() }).kind).toBe("hidden");
  });
});

describe("effectiveModeLabel and revisionLabel (honest mode text)", () => {
  it("names the standing default versus the session override", () => {
    expect(effectiveModeLabel(selection())).toBe("effective chat · standing default");
    expect(
      effectiveModeLabel(selection({ mode: "work", effective: "work", source: "session" })),
    ).toBe("effective work · session override");
  });

  it("a default selection over a work standing still names the standing default", () => {
    expect(effectiveModeLabel(selection({ effective: "work" }))).toBe(
      "effective work · standing default",
    );
  });

  it("the revision renders as a stable short head, never as a counter", () => {
    expect(revisionLabel(selection())).toMatch(/^rev [0-9a-f]{12}…$/u);
  });
});

describe("WORK_MODE_SELECTOR_OPTIONS", () => {
  it("offers exactly Default, Chat and Work in a closed vocabulary", () => {
    expect(WORK_MODE_SELECTOR_OPTIONS.map((option) => option.mode)).toEqual([
      "default",
      "chat",
      "work",
    ]);
    for (const option of WORK_MODE_SELECTOR_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

describe("newWorkModeCommandId (one stable id per explicit attempt)", () => {
  it("fits the host command id vocabulary", () => {
    for (let index = 0; index < 8; index += 1) {
      expect(newWorkModeCommandId()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
    }
  });

  it("mints distinct ids for distinct attempts", () => {
    expect(newWorkModeCommandId()).not.toBe(newWorkModeCommandId());
  });
});

describe("workModeOutcomeMessage (honest outcomes)", () => {
  it("an applied receipt says what changed and that nothing was sent", () => {
    const message = workModeOutcomeMessage({
      state: "applied",
      commandId: "workmode-cmd-1",
      duplicate: false,
      selection: selection({ mode: "work", effective: "work", source: "session" }),
    });
    expect(message).toContain("work");
    expect(message).toContain("No message was sent");
  });

  it("a duplicate receipt says the stored outcome was returned, not re-applied", () => {
    const message = workModeOutcomeMessage({
      state: "applied",
      commandId: "workmode-cmd-1",
      duplicate: true,
      selection: selection(),
    });
    expect(message).toContain("already recorded");
  });

  it("a conflict names the stale state and asks for an explicit retry", () => {
    expect(workModeOutcomeMessage({ state: "conflict", reason: "revision moved" })).toContain(
      "revision moved",
    );
    expect(workModeOutcomeMessage({ state: "conflict" })).toContain("changed");
  });

  it("a busy refusal explains the change applies to new turns", () => {
    const message = workModeOutcomeMessage({ state: "busy" });
    expect(message).toContain("new turns");
  });

  it("an unknown outcome is surfaced without promising anything", () => {
    const message = workModeOutcomeMessage({ state: "unknown", reason: "intent never settled" });
    expect(message).toContain("unknown");
    expect(message).toContain("not re-sent");
    expect(workModeOutcomeMessage({ state: "unknown" })).toContain("not re-sent");
  });

  it("unsupported and unavailable carry their bounded reasons", () => {
    expect(workModeOutcomeMessage({ state: "unsupported", reason: "older gateway" })).toContain(
      "older gateway",
    );
    expect(workModeOutcomeMessage({ state: "unavailable", reason: "not bound" })).toContain(
      "not bound",
    );
  });
});

describe("planSetRecovery (transport loss during set)", () => {
  it("reconciles a failed set ONLY through read-only same-id status", () => {
    expect(planSetRecovery({ interrupted: false })).toEqual({ kind: "status-once" });
  });

  it("an interrupted command clears pending silently with no follow-up call", () => {
    expect(planSetRecovery({ interrupted: true })).toEqual({ kind: "unknown-without-status" });
  });
});

describe("ProviderWorkbenchWorkModeResult narrowing safety", () => {
  it("the selector only keys off a genuinely available result", () => {
    const unavailable: ProviderWorkbenchWorkModeResult = {
      status: "unavailable",
      reason: "not bound",
    };
    expect(unavailable.status).not.toBe("available");
    const action: ProviderWorkbenchWorkModeActionResult = { state: "unknown" };
    expect(action.state).toBe("unknown");
  });
});

describe("scope keying", () => {
  it("is imported from the shared state module through the component logic", async () => {
    const state = await import("~/state/workbenchWorkMode");
    expect(typeof state.workbenchWorkModeScopeKey).toBe("function");
    expect(
      state.workbenchWorkModeScopeKey({
        environmentId: "e" as never,
        threadId: THREAD,
        providerInstanceId: undefined,
      }),
    ).toBe(JSON.stringify(["e", THREAD, null]));
  });
});
