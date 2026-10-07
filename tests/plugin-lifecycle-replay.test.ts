import { expect, test } from "bun:test";
import { EventLog } from "../src/host/event-log.ts";
import { replayContract, replayDigest } from "../src/host/replay.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("plugin lifecycle active-set digests are replay-bound", () => {
  const root = mkdtempSync(join(tmpdir(), "dokkabi-plugin-replay-"));
  try {
    const log = EventLog.create(join(root, "events.jsonl"));
    log.append({ kind: "observe", name: "session/open", payload: { plugin_manifest_digest: "manifest" } });
    log.append({ kind: "observe", name: "plugin/load", payload: { id: "one", digest: "d1", active_plugin_set_digest: "set-a" } });
    log.append({ kind: "observe", name: "plugin/unload", payload: { id: "one", digest: "d1", active_plugin_set_digest: "set-b" } });
    const contract = replayContract(log.events);
    expect(contract.activePluginSetDigests).toEqual(["set-a", "set-b"]);

    const other = EventLog.create(join(root, "other.jsonl"));
    other.append({ kind: "observe", name: "session/open", payload: { plugin_manifest_digest: "manifest" } });
    other.append({ kind: "observe", name: "plugin/load", payload: { id: "one", digest: "d1", active_plugin_set_digest: "set-a" } });
    other.append({ kind: "observe", name: "plugin/unload", payload: { id: "one", digest: "d1", active_plugin_set_digest: "set-z" } });
    expect(replayDigest(replayContract(other.events))).not.toBe(replayDigest(contract));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
