import { describe, expect, it } from "vite-plus/test";

import {
  resumeControlVisible,
  resumeOutcomeMessage,
  type WorkbenchOverviewStatus,
} from "./WorkbenchResumeControl.logic";

describe("resumeControlVisible (R8 reconnect control visibility)", () => {
  it("is visible ONLY for a detached persisted harness conversation", () => {
    expect(resumeControlVisible({ overviewStatus: "unavailable" })).toBe(true);
  });

  it.each(["available", "unsupported", null, undefined] as const satisfies ReadonlyArray<
    WorkbenchOverviewStatus | null | undefined
  >)(
    "stays hidden while bound, unsupported or while metadata is incomplete (%s)",
    (overviewStatus) => {
      expect(resumeControlVisible({ overviewStatus })).toBe(false);
    },
  );
});

describe("resumeOutcomeMessage (R8 honest operator outcomes)", () => {
  it("reports a reconnected source only — never model work", () => {
    expect(resumeOutcomeMessage({ state: "available" })).toContain("reconnected");
    expect(resumeOutcomeMessage({ state: "available" })).toContain("nothing was sent");
  });

  it("carries the bounded reason for unsupported and unknown outcomes", () => {
    expect(
      resumeOutcomeMessage({
        state: "unsupported",
        reason: "Provider 'codex' does not own a harness-recorded workspace.",
      }),
    ).toContain("harness-recorded workspace");
    expect(
      resumeOutcomeMessage({ state: "unknown", reason: "The recorded source was replaced." }),
    ).toContain("replaced");
  });

  it("falls back to honest text when the server reason is absent", () => {
    expect(resumeOutcomeMessage({ state: "unsupported" })).toContain("cannot be reconnected");
    expect(resumeOutcomeMessage({ state: "unknown" })).toContain("refused");
  });
});
