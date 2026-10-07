// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
function Probe({
  lane,
  threadId,
  providerInstanceId,
  environmentId,
}: {
  lane: string;
  threadId: string;
  providerInstanceId?: string;
  environmentId: string;
}) {
  const [owner] = useState(`${threadId}:${providerInstanceId}`);
  const [environment] = useState(environmentId);
  return (
    <div data-lane={lane} data-initial-owner={owner} data-initial-environment={environment}>
      {threadId}:{providerInstanceId}
    </div>
  );
}
vi.mock("./WorkbenchContextBar", () => ({
  WorkbenchContextBar: (props: any) => <Probe lane="overview" {...props} />,
}));
vi.mock("./WorkbenchBranchesBar", () => ({
  WorkbenchBranchesBar: (props: any) => <Probe lane="branches" {...props} />,
}));
vi.mock("./WorkbenchResumeControl", () => ({
  WorkbenchResumeControl: (props: any) => <Probe lane="resume" {...props} />,
}));
vi.mock("./WorkbenchWorkModeControl", () => ({
  WorkbenchWorkModeControl: (props: any) => <Probe lane="work-mode" {...props} />,
}));
import { WorkbenchThreadControls } from "./WorkbenchThreadControls";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(thread: string, instance = "instance-a", environment = "environment-a") {
  await act(async () =>
    root.render(
      <WorkbenchThreadControls
        environmentId={environment as EnvironmentId}
        threadId={thread as ThreadId}
        providerInstanceId={instance as ProviderInstanceId}
        createBranchTarget={vi.fn()}
        onOpenChildThread={vi.fn()}
      />,
    ),
  );
}
it("parent to child switches leave exactly one current-owner control lane", async () => {
  await render("parent");
  await render("child");
  expect(container.querySelectorAll("[data-lane]")).toHaveLength(4);
  expect(container.textContent).not.toContain("parent");
  for (const lane of ["overview", "branches", "resume", "work-mode"]) {
    expect(container.querySelectorAll(`[data-lane="${lane}"]`)).toHaveLength(1);
    expect(
      container.querySelector(`[data-lane="${lane}"]`)?.getAttribute("data-initial-owner"),
    ).toBe("child:instance-a");
  }
});
it("same-thread provider and environment changes replace the old action lifetime", async () => {
  await render("thread", "instance-a");
  await render("thread", "instance-b");
  expect(
    Array.from(container.querySelectorAll("[data-lane]")).map((e) =>
      e.getAttribute("data-initial-owner"),
    ),
  ).toEqual(Array(4).fill("thread:instance-b"));
  await render("thread", "instance-b", "environment-b");
  expect(container.querySelectorAll("[data-lane]")).toHaveLength(4);
  expect(
    Array.from(container.querySelectorAll("[data-lane]")).map((e) =>
      e.getAttribute("data-initial-environment"),
    ),
  ).toEqual(Array(4).fill("environment-b"));
});
