import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalOpenRefusalPresentation,
  shouldForwardTerminalInput,
  terminalCloseConfirmsRunningProcess,
  terminalOpenRefusalKey,
} from "./terminalOpenRefusal";

const OWNERSHIP_REFUSAL =
  "Terminal cwd '/workspace/sample-ws' belongs to a harness-owned workspace: this workspace's lifecycle is owned by a configured harness; the app terminal cannot mutate it";

describe("terminal open refusal (public #33)", () => {
  it("keys refusals by environment, thread, and terminal id", () => {
    expect(
      terminalOpenRefusalKey({
        environmentId: "env-1",
        threadId: "thread-1",
        terminalId: "term-1",
      }),
    ).toBe("env-1:thread-1:term-1");
  });

  it("shows the open refusal instead of forwarding keystrokes to a missing session", () => {
    expect(
      shouldForwardTerminalInput({
        openRefusalMessage: OWNERSHIP_REFUSAL,
      }),
    ).toBe(false);

    expect(
      resolveTerminalOpenRefusalPresentation({
        openRefusalMessage: OWNERSHIP_REFUSAL,
        attachError: "Unknown terminal thread: thread-1, terminal: term-1",
      }),
    ).toEqual({
      displayMessage: OWNERSHIP_REFUSAL,
      forwardInput: false,
    });
  });

  it("does not claim a running process when the terminal never opened", () => {
    expect(
      terminalCloseConfirmsRunningProcess({
        openRefusalMessage: OWNERSHIP_REFUSAL,
        hasRunningSubprocess: false,
      }),
    ).toBe(false);
    expect(
      terminalCloseConfirmsRunningProcess({
        openRefusalMessage: null,
        hasRunningSubprocess: true,
      }),
    ).toBe(true);
  });
});
