import { join, resolve } from "node:path";
import { bootSession } from "../../src/boot.ts";
import { resolveLlmSelection } from "../../src/host/config.ts";
import { resolveThinkingLevel } from "../../src/host/thinking.ts";
import { acquireSessionRunLock } from "../../src/host/session-lock.ts";
import { assertContainedSessionDir } from "../../src/commands/distill.ts";

const [session, workspace, instruction] = process.argv.slice(2);
if (!session || !workspace || !instruction) throw new Error("dream worker requires session, workspace and instruction");
const lock = acquireSessionRunLock(assertContainedSessionDir(session));
if (!lock.acquired) throw new Error("dream worker session is already active");
try {
  const selection = resolveLlmSelection();
  const boot = await bootSession({ sessionId: session, workspaceRoot: resolve(workspace), manifestPath: join(import.meta.dir, "manifest.json"), repoRoot: resolve(import.meta.dir, "../.."), permissionMode: "bypass", permissionSource: "cli" });
  try {
    if (!boot.ctx.llm || !boot.ctx.loop) throw new Error("dream worker model is unavailable");
    boot.ctx.llm.select(selection.route, selection.model);
    // Existing closed docs profile: no shell, network, external writes or installs.
    await boot.ctx.loop.prompt(instruction, { modelId: selection.model, thinkingLevel: resolveThinkingLevel(), toolScope: { todo: "dream-lesson", profile: "docs" }, maxToolCalls: 30, timeoutMs: 10 * 60000, sessionBudget: { maxRequests: 12 }, onAssistant: text => process.stdout.write(text) });
  } finally { await boot.runtime.dispose(); }
} finally { lock.release(); }
