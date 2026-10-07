// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const doubles = vi.hoisted(() => ({
  run: vi.fn(),
  overview: { status: "unavailable", reason: "detached recorded source" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => doubles.run }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: doubles.overview, error: null }),
}));
vi.mock("~/state/workbenchOverview", () => ({ workbenchOverviewAtomFor: () => ({}) }));
vi.mock("~/state/workbenchResume", () => ({ workbenchResumeAction: {} }));
import { WorkbenchResumeControl } from "./WorkbenchResumeControl";
let root: Root | null = null;
let container: HTMLDivElement;
const props = {
  environmentId: "review-environment" as EnvironmentId,
  threadId: "review-parent" as ThreadId,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  doubles.run.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render(instance: string) {
  await act(async () =>
    root!.render(
      <WorkbenchResumeControl {...props} providerInstanceId={instance as ProviderInstanceId} />,
    ),
  );
}
function button() {
  return container.querySelector("[data-workbench-resume-reconnect]") as HTMLButtonElement;
}
describe("primary: explicit reconnect component lifetime", () => {
  it("mount/poll does not reconnect; only a click dispatches the thread selector", async () => {
    let finish!: (value: unknown) => void;
    doubles.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render("instance-a");
    expect(doubles.run).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(doubles.run).toHaveBeenCalledTimes(1);
    expect(doubles.run).toHaveBeenCalledWith({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    expect(button().disabled).toBe(true);
    await act(async () =>
      finish({ _tag: "Success", value: { state: "unknown", reason: "bounded refusal" } }),
    );
    expect(button().disabled).toBe(false);
    expect(container.textContent).toContain("bounded refusal");
  });
  it("a same-thread provider change releases busy and ignores the old provider reply", async () => {
    let finish!: (value: unknown) => void;
    doubles.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render("instance-a");
    await act(async () => button().click());
    expect(button().disabled).toBe(true);
    await render("instance-b");
    expect(button().disabled).toBe(false);
    await act(async () =>
      finish({ _tag: "Success", value: { state: "unknown", reason: "OLD_PROVIDER_REPLY" } }),
    );
    expect(container.textContent).not.toContain("OLD_PROVIDER_REPLY");
    expect(doubles.run).toHaveBeenCalledTimes(1);
  });
});
