import { type ReactElement, type ReactNode, cloneElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";

import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { deriveTimelineEntries } from "../../session-logic";
import { SystemTimelineRow } from "./MessagesTimeline";
import type { ChatMessage } from "../../types";

/**
 * Generic role "system" message visibility: the host's own MAIN conversation
 * notices stay in the main conversation flow — their own row in order with
 * user/model messages, rendered with a visually distinct Host label, normal
 * accessible text, and no assistant attribution.
 *
 * @module components/chat/MessagesTimeline.system-message.test
 */

vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip",
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: "popup",
}));
// The diff worker pool boots a real web worker at import time, which no node
// test environment can host; the system row never touches diffs anyway.
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

const time = (second: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, second)).toISOString();

function message(input: {
  id: string;
  role: ChatMessage["role"];
  text: string;
  turnId?: string | null;
  createdAtSecond: number;
}): ChatMessage {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: input.turnId === undefined || input.turnId === null ? null : TurnId.make(input.turnId),
    createdAt: time(input.createdAtSecond),
    updatedAt: time(input.createdAtSecond),
    streaming: false,
  };
}

it("keeps a system message in the main conversation flow between user and model rows", () => {
  const turnId = "turn-host-1";
  const messages = [
    message({ id: "u1", role: "user", text: "run the bounded wave", createdAtSecond: 0 }),
    message({
      id: "s1",
      role: "system",
      text: "Host work result — status: blocked, outcome: incomplete",
      turnId,
      createdAtSecond: 5,
    }),
    message({
      id: "a1",
      role: "assistant",
      text: "Model narrative after the verdict.",
      turnId,
      createdAtSecond: 7,
    }),
    message({ id: "u2", role: "user", text: "continue", createdAtSecond: 10 }),
  ];
  const timelineEntries = deriveTimelineEntries(messages, [], []);
  const rows = deriveMessagesTimelineRows({
    timelineEntries,
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });

  const rowKindsById = rows.map((row) =>
    row.kind === "message" ? [row.message.id as string, row.message.role] : null,
  );
  // The host verdict keeps its own place in the MAIN conversation — it is
  // never dropped, folded into a work row, or merged into the model's row.
  expect(rowKindsById).toEqual([
    ["u1", "user"],
    ["s1", "system"],
    ["a1", "assistant"],
    ["u2", "user"],
  ]);
  const systemRow = rows[1];
  expect(systemRow && systemRow.kind === "message" && systemRow.showAssistantMeta).toBe(false);
  expect(
    systemRow && systemRow.kind === "message" && systemRow.showAssistantCopyButton,
  ).toBe(false);
});

it("renders a system message with a distinct Host label, accessible text and no assistant attribution", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const row = {
    kind: "message",
    id: "message-s1",
    createdAt: time(5),
    message: message({
      id: "s1",
      role: "system",
      text: "Host work result — status: done, outcome: completed, acceptance: accepted",
      turnId: "turn-host-1",
      createdAtSecond: 5,
    }),
    durationStart: time(5),
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  } as const;

  await act(() => {
    renderer = create(<SystemTimelineRow row={row} />);
  });

  const renderOutput = JSON.stringify(renderer.toJSON());

  // A visually distinct Host label announces the author, including to screen
  // readers (heading text, never aria-hidden).
  const headings = renderer.root.findAll((node) => node.type === "h3");
  expect(headings).toHaveLength(1);
  expect(headings[0]?.props.className).toContain("sr-only");
  expect(headings[0]?.children?.join("")).toBe("Host");
  expect(renderOutput).toContain("Host");

  // The verdict text itself renders as normal accessible, selectable text —
  // not hidden from assistive technology and not truncated away.
  const textNodes = renderer.root
    .findAll((node) => typeof node === "object" && node.children !== undefined)
    .flatMap((node) => (node.children ?? []).filter((child) => typeof child === "string"));
  expect(textNodes.join(" ")).toContain("status: done, outcome: completed, acceptance: accepted");
  expect(renderOutput).not.toContain("aria-hidden=\"true\">Host work result");

  // No assistant attribution: no copy affordance and no model attribution
  // metadata ride along with the host's own message.
  expect(renderer.root.findAllByProps({ "aria-label": "Copy" })).toEqual([]);
  expect(renderOutput).not.toContain("gpt-");
  expect(renderOutput).not.toContain("assistant-meta");
});
