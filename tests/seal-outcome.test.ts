import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/host/event-log.ts";
import { currentWorkPhase, sealedWorkGraph } from "../src/work/phase.ts";

/**
 * The ledger has to agree with the exit. It did not: "graph sealed" was written
 * before the refusals were read, so a run that ended with seven of them and
 * exit code 2 left a log saying it had sealed, and no record a dashboard could
 * find. An hour went into believing the log over the exit.
 */

const roots: string[] = [];
let previousPhase: string | undefined;

beforeEach(() => {
  previousPhase = process.env.DOKKABI_WORK_PHASE;
  delete process.env.DOKKABI_WORK_PHASE;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousPhase === undefined) delete process.env.DOKKABI_WORK_PHASE;
  else process.env.DOKKABI_WORK_PHASE = previousPhase;
});

function freshLog(): { log: EventLog; read: () => { name: string; payload: Record<string, unknown> }[] } {
  const root = mkdtempSync(join(tmpdir(), "dokkabi-seal-"));
  roots.push(root);
  const path = join(root, "events.jsonl");
  const log = EventLog.create(path);
  const read = () => {
    const text = require("node:fs").readFileSync(path, "utf8").trim();
    return text ? text.split("\n").map((line: string) => JSON.parse(line)) : [];
  };
  return { log, read };
}

describe("recording how decompose ended", () => {
  test("a clean graph seals, enters implement, and says so once", () => {
    const { log, read } = freshLog();
    expect(sealedWorkGraph(log, [])).toBe(true);
    const events = read();
    expect(events.map((e) => e.name)).toContain("work/phase");
    const phase = events.find((e) => e.name === "work/phase");
    expect(phase?.payload.phase).toBe("implement");
    expect(phase?.payload.reason).toBe("graph sealed");
    expect(currentWorkPhase()).toBe("implement");
  });

  test("refusals never write a seal, and never move the phase", () => {
    // The v28 ending, verbatim in shape: seven refusals and exit 2.
    const { log, read } = freshLog();
    const errors = [
      "case c-p7c did not reach its asserted RED: runner exited without assertion or declared exception evidence",
      "case c-p7b did not reach its asserted RED: runner exited without assertion or declared exception evidence",
      "case c-p7a did not reach its asserted RED: runner exited without assertion or declared exception evidence",
      "case c-p6 did not reach its asserted RED: runner exited without assertion or declared exception evidence",
      "case c-spec-gate did not reach its asserted RED: runner exited without assertion or declared exception evidence",
      "case c-commit-push did not reach its asserted RED: runner exited without assertion or declared exception evidence",
      "case c-issue did not reach its asserted RED: assertion observed 4, which red_means does not describe",
    ];
    expect(sealedWorkGraph(log, errors)).toBe(false);

    const events = read();
    expect(events.some((e) => e.name === "work/phase")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("graph sealed");
    // A refusal is not a transition: the run is still in decompose.
    expect(currentWorkPhase()).toBeUndefined();
  });

  test("a refusal leaves the record the dashboard already reads", () => {
    // dash/project.ts keys on work/plan_refused and its errors array; the old
    // path emitted neither that nor plan_sealed, so the ending was invisible.
    const { log, read } = freshLog();
    expect(sealedWorkGraph(log, ["case c-issue did not reach its asserted RED"])).toBe(false);
    const refused = read().find((e) => e.name === "work/plan_refused");
    expect(refused).toBeDefined();
    expect(refused?.payload.stage).toBe("work_plan");
    expect(refused?.payload.errors).toEqual(["case c-issue did not reach its asserted RED"]);
  });

  test("sealing writes no refusal and refusing writes no seal", () => {
    const sealed = freshLog();
    sealedWorkGraph(sealed.log, []);
    expect(sealed.read().some((e) => e.name === "work/plan_refused")).toBe(false);

    delete process.env.DOKKABI_WORK_PHASE;
    const refused = freshLog();
    sealedWorkGraph(refused.log, ["one refusal"]);
    expect(refused.read().some((e) => e.name === "work/phase")).toBe(false);
  });
});
