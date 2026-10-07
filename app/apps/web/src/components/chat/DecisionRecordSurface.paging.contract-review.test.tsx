// @vitest-environment jsdom
import * as NodeCrypto from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const captured = vi.hoisted(() => ({ scopes: [] as any[], page: null as any }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { status: "available", record: captured.page },
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/state/workbenchRecord", async () => {
  const original = await vi.importActual<any>("~/state/workbenchRecord");
  return {
    ...original,
    workbenchRecordAtomFor: (scope: any) => {
      captured.scopes.push(scope);
      return null;
    },
  };
});
import { DecisionRecordSurface } from "./DecisionRecordSurface";
let root: Root | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  captured.scopes.length = 0;
  vi.unstubAllGlobals();
});

function retainedFixture() {
  const rows: any[] = [];
  let prev_hash = "0".repeat(64);
  for (let seq = 1; seq <= 51; seq++) {
    const unsigned = {
      kind: "observe" as const,
      name: "test/source",
      payload: { seq },
      prev_hash,
      seq,
      ts: "2026-10-02T00:00:00.000Z",
    };
    const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    rows.push({ ...unsigned, hash });
    prev_hash = hash;
  }
  const asOf = {
    sessionId: "owned-session",
    seq: 51,
    hash: rows[50].hash,
    generation: rows[0].hash,
  };
  captured.page = {
    version: 1,
    state: "available",
    sessionCursor: asOf,
    gatewayCursor: { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) },
    asOf,
    records: rows.slice(0, 50),
    next: { seq: 50, hash: rows[49].hash, generation: asOf.generation },
    total: 51,
    hasMore: true,
    decisions: { status: "unsupported", reason: "checkpoint authority absent" },
  };
  return asOf;
}

async function mountReader() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <DecisionRecordSurface
        environmentId={EnvironmentId.make("reader-env")}
        threadId={ThreadId.make("reader-thread")}
        visible
      />,
    ),
  );
  await act(async () =>
    (container.querySelector("[data-record-tab-trigger]") as HTMLButtonElement).click(),
  );
  return container;
}

it("Next holds the displayed asOf prefix even when source updates between page requests", async () => {
  const asOf = retainedFixture();
  const container = await mountReader();
  await act(async () =>
    (container.querySelector("[data-record-next-page]") as HTMLButtonElement).click(),
  );
  expect(captured.scopes.at(-1).after).toEqual(captured.page.next);
  expect(captured.scopes.at(-1).asOf).toEqual(asOf);
});

it("Pin preserves the selected exact source instead of silently switching inspection to the first record", async () => {
  retainedFixture();
  const container = await mountReader();
  await act(async () =>
    (container.querySelector('[data-record-seq="4"]') as HTMLButtonElement).click(),
  );
  expect(
    container.querySelector("[data-record-row-json]")?.getAttribute("data-record-row-json"),
  ).toBe("4");
  await act(async () =>
    (container.querySelector("[data-record-pin-toggle]") as HTMLButtonElement).click(),
  );
  expect(
    container.querySelector("[data-record-row-json]")?.getAttribute("data-record-row-json"),
  ).toBe("4");
});
