import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offlineTestEnvironment } from "../scripts/test-environment.ts";

// Direct `bun test` also uses this boundary. A failed assertion may print a
// whole environment object; remove host credentials before test modules load.
const inherited = offlineTestEnvironment(process.env);
for (const name of Object.keys(process.env)) {
  if (!(name in inherited)) delete process.env[name];
}

// Suite-wide fence: config.json, sessions, and runs.jsonl written by any test
// that forgets its own DOKKABI_HOME override land in a throwaway home instead
// of the operator's real ~/.dokkabi. Tests that set their own override still
// win; this only replaces the dangerous default.
process.env.TMPDIR = realpathSync(tmpdir());
process.env.DOKKABI_HOME = mkdtempSync(join(tmpdir(), "dokkabi-test-home-"));

// Retry backoffs are real provider seconds. A test that drives one sat through
// a 5s rung inside a 30s timeout: fine alone, a timeout under the contention of
// a full run, and a flake either way. The ladder's values are asserted directly
// on sameRouteRetry, which reports them without sleeping, so the suite does not
// need to live through them.
process.env.DOKKABI_RETRY_BACKOFF_SCALE = "0";

const platformReceipt = process.env.DOKKABI_PLATFORM_PRELOAD_RECEIPT;
if (platformReceipt !== undefined && process.env.DOKKABI_PLATFORM_PRELOAD_PID === String(process.pid)) {
  delete process.env.DOKKABI_PLATFORM_PRELOAD_RECEIPT;
  delete process.env.DOKKABI_PLATFORM_PRELOAD_PID;
  writeFileSync(platformReceipt, JSON.stringify({ home: process.env.DOKKABI_HOME, tmp: tmpdir(), bun: Bun.version }) + "\n", { flag: "wx" });
}
