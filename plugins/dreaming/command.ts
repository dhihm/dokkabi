import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dreamRoot, dreamSession, learnedPlugins, approveCandidate, setSettings, settings, tick } from "./service.ts";

function launchAgent(repoRoot: string, enabled: boolean) {
  if (process.platform !== "darwin") throw new Error("automatic dream scheduling currently requires macOS launchd; dream tick is portable for an external scheduler");
  const label = "dev.dokkabi.dreaming";
  const domain = `gui/${process.getuid!()}`;
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
  if (!enabled) { if (existsSync(path)) unlinkSync(path); return; }
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(dreamRoot(), { recursive: true });
  const argv = [process.execPath, join(repoRoot, "src/cli.ts"), "dream", "tick"];
  const text = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argv.map(a => `<string>${xml(a)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>DOKKABI_HOME</key><string>${xml(join(dreamRoot(), ".."))}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(join(dreamRoot(), "scheduler.log"))}</string><key>StandardErrorPath</key><string>${xml(join(dreamRoot(), "scheduler-error.log"))}</string></dict></plist>`;
  writeFileSync(path, text, { mode: 0o600 });
  const result = Bun.spawnSync(["launchctl", "bootstrap", domain, path], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`launchd registration failed: ${result.stderr.toString().slice(0, 300)}`);
}
export async function runDreamCommand(args: string[], repoRoot: string): Promise<number> {
  const [op = "status", ...rest] = args;
  if (op === "enable") {
    const apply = rest.length === 0 ? "candidate" : rest.length === 1 && rest[0] === "--candidate-only" ? "candidate" : undefined;
    if (!apply) throw new Error("usage: dream enable [--candidate-only]");
    setSettings(true, apply);
    try { launchAgent(repoRoot, true); } catch (error) { setSettings(false, apply); throw error; }
    console.log(JSON.stringify({ ...settings(), scheduler: "launchd", idle_hours: 12, historical_sessions: "excluded" }));
  } else if (op === "disable" && !rest.length) {
    setSettings(false, settings().apply); launchAgent(repoRoot, false); console.log("Dream scheduler disabled; learned plugins remain individually revocable.");
  } else if (op === "status" && !rest.length) {
    console.log(JSON.stringify({ ...settings(), idle_hours: 12, plugins: learnedPlugins(), candidates: existsSync(join(dreamRoot(), "candidates")) ? readdirSync(join(dreamRoot(), "candidates")) : [] }));
  } else if (op === "tick" && !rest.length) {
    console.log(JSON.stringify(await tick()));
  } else if (op === "run" && rest.length === 2 && rest[0] === "--session") {
    console.log(JSON.stringify(await dreamSession(rest[1]!, { force: true })));
  } else if (op === "approve" && rest.length === 1) {
    console.log(JSON.stringify(approveCandidate(rest[0]!)));
  } else if (op === "inspect" && rest.length === 1 && /^[a-z0-9-]+$/.test(rest[0]!)) {
    console.log(readFileSync(join(dreamRoot(), "candidates", `${rest[0]}.json`), "utf8"));
  } else if (op === "remove" && rest.length === 1 && /^dreaming\.[a-z0-9-]+$/.test(rest[0]!)) {
    const id = rest[0]!.slice("dreaming.".length);
    const path = join(dreamRoot(), "plugins", `${id}.json`);
    if (!existsSync(path)) throw new Error("learned plugin is not installed");
    // Exact revocation; existing live session prefixes remain immutable.
    const value = JSON.parse(readFileSync(path, "utf8"));
    const { EventLog } = await import("../../src/host/event-log.ts");
    const { assertContainedSessionDir } = await import("../../src/commands/distill.ts");
    const { acquireSessionRunLock } = await import("../../src/host/session-lock.ts");
    const { acquireSessionLease } = await import("../../src/host/session-lease.ts");
    const dir = assertContainedSessionDir(value.source_session);
    const lease = acquireSessionLease(dir);
    const lock = acquireSessionRunLock(dir); if (!lock.acquired) { lease.release(); throw new Error("source session is active; retry revocation after its turn"); }
    try {
      const log = new EventLog(join(dir, "events.jsonl"));
      log.append({ kind: "effect", name: "dream/revoke", payload: { id: rest[0]! } });
      unlinkSync(path);
      log.append({ kind: "observe", name: "dream/revoked", payload: { id: rest[0]! } });
    } finally { try { lock.release(); } finally { lease.release(); } }
    console.log(`Removed ${rest[0]}; next sessions will not load it.`);
  } else throw new Error("usage: dokkabi dream status|enable [--candidate-only]|disable|tick|run --session ID|inspect ID|approve ID|remove ID");
  return 0;
}
