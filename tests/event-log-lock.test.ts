import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/host/event-log.ts";

const dirs: string[] = [];

function logFile(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dokkabi-${label}-`));
  dirs.push(dir);
  return join(dir, "events.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a writer catches up from the verified suffix without reloading its prefix", () => {
  const path = logFile("suffix-catchup");
  const first = EventLog.create(path);
  first.append({ kind: "observe", name: "session/open", payload: {} });
  const reloads = first.reloadCount;

  const second = new EventLog(path);
  second.append({ kind: "observe", name: "agent/status", payload: { status: "running" } });
  const appended = first.append({ kind: "observe", name: "agent/status", payload: { status: "idle" } });

  expect(appended.seq).toBe(3);
  expect(first.reloadCount).toBe(reloads);
  expect(new EventLog(path).lastSeq).toBe(3);
});

test("a writer recovers an append lock whose dead owner is recorded", () => {
  const path = logFile("dead-lock-owner");
  const log = EventLog.create(path);
  const lockPath = `${path}.lock`;
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ version: 1, pid: 2_147_483_647, process_start: "missing", nonce: "dead", acquired_at: 0 })}\n`,
    { mode: 0o600 },
  );

  const event = log.append({ kind: "observe", name: "session/open", payload: {} });
  expect(event.seq).toBe(1);
});

test("a writer recovers an abandoned legacy empty append lock", () => {
  const path = logFile("legacy-lock");
  const log = EventLog.create(path);
  const lockPath = `${path}.lock`;
  mkdirSync(lockPath, { mode: 0o700 });
  utimesSync(lockPath, new Date(0), new Date(0));

  const event = log.append({ kind: "observe", name: "session/open", payload: {} });
  expect(event.seq).toBe(1);
});
