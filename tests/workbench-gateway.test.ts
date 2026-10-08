import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventLog } from "../src/host/event-log.ts";
import { workspaceSessionId } from "../src/host/paths.ts";
import { DokkabiDesktopServer } from "../src/dash/desktop-server.ts";
import {
  cancelFingerprint,
  submitFingerprint,
  WorkbenchGateway,
  type WorkbenchKernelHandle,
} from "../src/dash/workbench.ts";
import { projectTranscript, transcriptCardsAfter } from "../src/dash/transcript.ts";
import { createChatFrontend } from "../src/chat/frontend.ts";
import { OperatorAbortError } from "../src/chat/turn-failure.ts";
import type { PermissionMode } from "../src/host/permissions.ts";
import { openDesktopChatKernel } from "../src/chat/desktop-kernel.ts";
import { acquireSessionLease } from "../src/host/session-lease.ts";
import { defaultManifestPath } from "../src/boot.ts";

/**
 * R2 workbench gateway scenarios (docs/desktop-harness-r2.md).
 *
 * Groups:
 *  - `WorkbenchGateway` with a deterministic fake kernel: command
 *    dedup/conflict, unresolved-blocking, cancellation intents, restart
 *    uncertainty, cursor validation, binding ownership, serialization.
 *  - The actual chat frontend seam: fail-closed submit ordering (no inbox
 *    staging), acceptance observed while pending and kept after failure or
 *    abort, settlement-write failure not pumping follow-on turns.
 *  - The real server through handleJsonRpcMessage with the real embedded
 *    kernel booted on an isolated DOKKABI_HOME whose unconfigured route
 *    fails fast: the full wire path, correlated lifecycle rows in the
 *    session log, and honest failure settlement.
 */

const TEST_DIR = realpathSync(mkdtempSync("/tmp/dokkabi-workbench-"));
const HOME = join(TEST_DIR, "home");
const SESSIONS_DIR = join(HOME, "sessions");
const WORKSPACE = join(TEST_DIR, "workspace");
const GATEWAY_LOG = join(TEST_DIR, "gateway.jsonl");
const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));

const BINDING = { clientId: "client-alpha", threadId: "thread-one" };

interface FakeKernelEvents {
  submitted: Array<{ text: string; commandId?: string }>;
  abortActiveCalls: number;
  legacyAbortCalls: number;
  poppedInbox: number;
  disposed: number;
}

/**
 * A deterministic kernel double. `abort` and `popQueuedNote` exist only as
 * spies: the gateway must never reach for the legacy abort (it pops a staged
 * inbox note); workbench cancellation is active-only.
 */
function fakeKernel(sessionId: string, events: FakeKernelEvents): WorkbenchKernelHandle {
  let busy = false;
  return {
    sessionId,
    submitNote(text: string, commandId?: string) {
      events.submitted.push({ text, commandId });
      busy = true;
      return "prompt" as const;
    },
    abortActive() {
      events.abortActiveCalls += 1;
      busy = false;
      return true;
    },
    ...( {
      abort() {
        events.legacyAbortCalls += 1;
        return { aborted: busy };
      },
      popQueuedNote() {
        events.poppedInbox += 1;
        return undefined;
      },
      setBusy(next: boolean) {
        busy = next;
      },
    } as Record<string, unknown>),
    busy: () => busy,
    async routeStatus() {
      return { route: "fake-route", ready: false, reason: "unconfigured test route" };
    },
  } as WorkbenchKernelHandle;
}

function bootGateway(kernel: WorkbenchKernelHandle): WorkbenchGateway {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(WORKSPACE, { recursive: true });
  return new WorkbenchGateway({
    workspaceCwd: WORKSPACE,
    sessionsRoot: SESSIONS_DIR,
    gatewayLogPath: GATEWAY_LOG,
    openKernel: async () => kernel,
    getKernel: () => kernel,
  });
}

function rpc(gateway: WorkbenchGateway, method: string, params: unknown): Promise<unknown> {
  return gateway.handle(method, params);
}

async function bind(gateway: WorkbenchGateway, binding = BINDING): Promise<void> {
  await rpc(gateway, "workbench.bind", { version: 1, ...binding, workspacePath: realpathSync(WORKSPACE) });
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(WORKSPACE, { recursive: true });
});

afterEach(() => {
  if (existsSync(GATEWAY_LOG)) {
    try { chmodSync(GATEWAY_LOG, 0o644); } catch { /* best effort */ }
  }
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("workbench gateway command semantics (deterministic kernel)", () => {
  test("scn-r2-01 bind accepts the real workspace and refuses foreign paths and threads", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(workspaceSessionId(WORKSPACE), events));

    const foreign = await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: join(TEST_DIR, "elsewhere"),
    }).catch((error: Error) => error);
    expect((foreign as Error).message).toContain("workspace");

    const bound = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { sessionId: string; reconnect: boolean };
    expect(bound.sessionId).toBe(workspaceSessionId(WORKSPACE));
    expect(bound.reconnect).toBe(false);

    const secondThread = await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: BINDING.clientId,
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    }).catch((error: Error) => error);
    expect((secondThread as Error).message).toContain("thread");

    const reconnect = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { reconnect: boolean };
    expect(reconnect.reconnect).toBe(true);
  });

  test("scn-r2-01 strict params: unknown keys, bad version and invalid ids fail before effects", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(workspaceSessionId(WORKSPACE), events));
    await bind(gateway);

    const extra = await rpc(gateway, "workbench.handshake", { version: 1, token: "nope" }).catch((e: Error) => e);
    expect((extra as Error).message).toMatch(/unknown field/i);

    const badVersion = await rpc(gateway, "workbench.handshake", { version: 2 }).catch((e: Error) => e);
    expect((badVersion as Error).message).toContain("version");

    const badId = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "../escape",
      text: "x",
    }).catch((e: Error) => e);
    expect((badId as Error).message).toMatch(/command id/i);
    expect(events.submitted.length).toBe(0);
  });

  test("scn-r2-02 repeated identical submit invokes the kernel once; different payload conflicts", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const kernel = fakeKernel(workspaceSessionId(WORKSPACE), events);
    const gateway = bootGateway(kernel);
    await bind(gateway);

    const first = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-1",
      text: "hello kernel",
    })) as { commandId: string; state: string; noteDelivery: string };
    expect(first.commandId).toBe("cmd-1");
    // The receipt proves frontend handoff, not model delivery.
    expect(first.state).toBe("handed_off");
    expect(first.noteDelivery).toBe("prompt");
    expect(events.submitted.length).toBe(1);

    // The fake kernel stays busy: settlement has not happened, so the same
    // command id must return the recorded state, not a second invocation.
    const repeat = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-1",
      text: "hello kernel",
    })) as { duplicate: boolean; state: string };
    expect(repeat.duplicate).toBe(true);
    expect(repeat.state).toBe("handed_off");
    expect(events.submitted.length).toBe(1);

    const conflict = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-1",
      text: "different payload",
    }).catch((e: Error) => e);
    expect((conflict as Error).message).toMatch(/different payload/);
    expect(events.submitted.length).toBe(1);
  });

  test("scn-r2-02 a second command while one is unresolved is refused, not queued", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(workspaceSessionId(WORKSPACE), events));
    await bind(gateway);

    const [, second] = await Promise.all([
      rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-a", text: "first" }),
      rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-b", text: "second" }).catch(
        (e: Error) => e,
      ),
    ]);
    expect((second as Error).message).toMatch(/unresolved|busy|active/);
    expect(events.submitted.length).toBe(1);
  });

  test("scn-r2-02 cancel is active-only, deduplicates retries and never pops the staged inbox", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const kernel = fakeKernel(workspaceSessionId(WORKSPACE), events);
    const gateway = bootGateway(kernel);
    await bind(gateway);

    const foreign = await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-x",
      targetCommandId: "cmd-not-active",
    }).catch((e: Error) => e);
    expect((foreign as Error).message).toMatch(/active|stale|foreign/i);

    await rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-1", text: "cancel me" });

    const cancel = (await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-1",
      targetCommandId: "cmd-1",
    })) as { state: string };
    expect(cancel.state).toBe("requested");
    expect(events.abortActiveCalls).toBe(1);

    const retry = (await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-1",
      targetCommandId: "cmd-1",
    })) as { state: string };
    expect(retry.state).toBe("already_requested");
    expect(events.abortActiveCalls).toBe(1);

    // The same cancellation id with a DIFFERENT target conflicts.
    const differentTarget = await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-1",
      targetCommandId: "cmd-2",
    }).catch((e: Error) => e);
    expect((differentTarget as Error).message).toMatch(/different target or binding/);
    expect(events.abortActiveCalls).toBe(1);

    // The turn is gone: cancellation is active-only, and the legacy abort
    // (which pops a staged inbox note) was never used.
    const stale = await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-2",
      targetCommandId: "cmd-1",
    }).catch((e: Error) => e);
    expect((stale as Error).message).toMatch(/active|stale|foreign/i);
    expect(events.abortActiveCalls).toBe(1);
    expect(events.legacyAbortCalls).toBe(0);
    expect(events.poppedInbox).toBe(0);
  });

  test("scn-r2-02 a cancelled-then-restarted command stays unknown and blocks new sends until reconciliation", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);

    // Crash window on a CANCELLATION: intent recorded, receipt absent, and
    // (fake kernel gone) no settlement in the session log.
    const ledger = EventLog.create(GATEWAY_LOG);
    const fingerprint = cancelFingerprint({
      commandId: "cnl-crash",
      targetCommandId: "cmd-t",
      clientId: BINDING.clientId,
      threadId: BINDING.threadId,
    });
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/cancel_intent",
      payload: {
        command_id: "cnl-crash",
        fingerprint,
        operation: "cancel",
        target_command_id: "cmd-t",
        client_id: BINDING.clientId,
        thread_id: BINDING.threadId,
      },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const retried = (await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-crash",
      targetCommandId: "cmd-t",
    })) as { state: string };
    expect(retried.state).toBe("unknown");
    expect(events.abortActiveCalls).toBe(0);
  });

  test("scn-r2-02 cancel append rejection results in zero abort calls", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(workspaceSessionId(WORKSPACE), events));
    await bind(gateway);
    await rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-1", text: "abort path" });

    // fsync-level failure simulation: the durable intent append cannot land.
    chmodSync(GATEWAY_LOG, 0o444);
    const refused = await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-f",
      targetCommandId: "cmd-1",
    }).catch((e: Error) => e);
    expect((refused as Error).message).toMatch(/append|permission|denied|write/i);
    expect(events.abortActiveCalls).toBe(0);
    chmodSync(GATEWAY_LOG, 0o644);
  });

  test("scn-r2-02 restart separates intent from handoff: unknown is never blindly retried", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const text = "hello kernel";

    // A crash between the durable intent and any provable handoff: the
    // ledger holds the intent row (with the TRUE canonical fingerprint) and
    // nothing else.
    const ledger = EventLog.create(GATEWAY_LOG);
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/submit_intent",
      payload: {
        command_id: "cmd-crash",
        fingerprint: submitFingerprint("cmd-crash", text),
        client_id: BINDING.clientId,
        thread_id: BINDING.threadId,
        session_id: sessionId,
      },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const status = (await rpc(gateway, "workbench.commandStatus", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-crash",
    })) as { state: string };
    expect(status.state).toBe("unknown");

    // Same id + same payload: the recorded state returns; the kernel is not
    // invoked again.
    const resubmit = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-crash",
      text,
    })) as { duplicate: boolean; state: string };
    expect(resubmit.duplicate).toBe(true);
    expect(resubmit.state).toBe("unknown");
    expect(events.submitted.length).toBe(0);

    // Same id + DIFFERENT payload: always a conflict, unknown or not.
    const conflict = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-crash",
      text: "a different payload",
    }).catch((e: Error) => e);
    expect((conflict as Error).message).toMatch(/different payload/);
    expect(events.submitted.length).toBe(0);

    // The unknown intent also blocks a brand-new send until reconciliation.
    const blocked = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-next",
      text: "after crash",
    }).catch((e: Error) => e);
    expect((blocked as Error).message).toMatch(/unresolved|reconcile/i);

    // Reconciliation through correlated kernel records: the session log
    // later shows the crashed turn actually settled as a failure.
    const sessionDir = join(SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const sessionLog = EventLog.create(join(sessionDir, "events.jsonl"));
    sessionLog.append({ kind: "observe", name: "chat/turn_started", payload: { command_id: "cmd-crash", text_bytes: 12 } });
    sessionLog.append({
      kind: "observe",
      name: "chat/turn_settled",
      payload: { command_id: "cmd-crash", outcome: "failure" },
    });
    const after = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-next",
      text: "after crash",
    })) as { state: string };
    expect(after.state).toBe("handed_off");
    expect(events.submitted.length).toBe(1);
  });

  test("scn-r2-02 a handed-off-but-unsettled command keeps its receipt and blocks sends across restart", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const firstEvents: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const first = bootGateway(fakeKernel(sessionId, firstEvents));
    await bind(first);
    await rpc(first, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-d", text: "delivered" });

    // Restart: same ledger, fresh process state. The handoff receipt
    // survives; a fresh idle kernel never erases the uncertainty.
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const status = (await rpc(gateway, "workbench.commandStatus", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-d",
    })) as { state: string };
    expect(status.state).toBe("handed_off");

    const resubmit = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-d",
      text: "delivered",
    })) as { duplicate: boolean; state: string };
    expect(resubmit.duplicate).toBe(true);
    expect(resubmit.state).toBe("handed_off");
    expect(events.submitted.length).toBe(0);

    // A new command stays blocked while cmd-d is unresolved.
    const blocked = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-new",
      text: "next turn",
    }).catch((e: Error) => e);
    expect((blocked as Error).message).toMatch(/unresolved|reconcile/i);
    expect(events.submitted.length).toBe(0);
  });

  test("scn-r2-02 a settled command of another binding cannot be replayed by a new binding", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);
    await rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-f", text: "foreign" });
    // External settlement (e.g. a second gateway process recorded it).
    const external = new EventLog(GATEWAY_LOG);
    external.appendDurable({
      kind: "observe",
      name: "workbench/submit_settled",
      payload: { command_id: "cmd-f", outcome: "success" },
    });
    await rpc(gateway, "workbench.detach", { version: 1, binding: BINDING });

    const otherBinding = { clientId: "client-beta", threadId: "thread-two" };
    const rebound = await rpc(gateway, "workbench.bind", {
      version: 1,
      ...otherBinding,
      workspacePath: realpathSync(WORKSPACE),
    });
    expect((rebound as { ok: boolean }).ok).toBe(true);

    const replay = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: otherBinding,
      commandId: "cmd-f",
      text: "foreign",
    }).catch((e: Error) => e);
    expect((replay as Error).message).toContain("another binding");
  });

  test("scn-r2-03 read recovers a late tool/result on an earlier card and validates cursors", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    const start = sessionLog.append({ kind: "observe", name: "tool/start", payload: { id: "tool-a", name: "read" } });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const first = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      cards: Array<{ kind: string; resultText?: string }>;
      sessionCursor: { seq: number; hash: string; generation: string; sessionId: string };
      gatewayCursor: { seq: number; hash: string; generation: string };
      resnapshot: boolean;
    };
    expect(first.resnapshot).toBe(true);
    expect(first.cards.some((card) => card.kind === "tool")).toBe(true);

    // The recorded result lands AFTER the snapshot was taken, on a card whose
    // seq is the old tool/start: the legacy append feed cannot recover it.
    sessionLog.append({ kind: "surface", name: "tool/result", payload: { id: "tool-a", text: "recorded result" } });

    const recovered = (await rpc(gateway, "workbench.read", {
      version: 1,
      binding: BINDING,
      sessionCursor: first.sessionCursor,
      gatewayCursor: first.gatewayCursor,
    })) as {
      cards: Array<{ kind: string; resultText?: string; seq: number }>;
      sessionCursor: { seq: number };
      resnapshot: boolean;
    };
    expect(recovered.resnapshot).toBe(false);
    const card = recovered.cards.find((c) => c.kind === "tool");
    expect(card?.resultText).toBe("recorded result");
    expect(card?.seq).toBe(start.seq);
    expect(recovered.sessionCursor.seq).toBeGreaterThan(first.sessionCursor.seq);

    // A hash mismatch at the cursor's seq forces an explicit resnapshot.
    const mismatched = (await rpc(gateway, "workbench.read", {
      version: 1,
      binding: BINDING,
      sessionCursor: { ...first.sessionCursor, seq: recovered.sessionCursor.seq, hash: "f".repeat(64) },
      gatewayCursor: first.gatewayCursor,
    })) as { resnapshot: boolean };
    expect(mismatched.resnapshot).toBe(true);

    // A replaced log cannot be spliced onto the prior view: new chain, new
    // generation, resnapshot.
    rmSync(sessionLogPath);
    const replaced = EventLog.create(sessionLogPath);
    replaced.append({ kind: "observe", name: "session/open", payload: {} });
    const afterReplace = (await rpc(gateway, "workbench.read", {
      version: 1,
      binding: BINDING,
      sessionCursor: first.sessionCursor,
      gatewayCursor: first.gatewayCursor,
    })) as { resnapshot: boolean; sessionCursor: { generation: string } };
    expect(afterReplace.resnapshot).toBe(true);
    expect(afterReplace.sessionCursor.generation).not.toBe(first.sessionCursor.generation);

    // A cursor naming a foreign session is refused, not silently resnapshotted.
    const foreignSession = await rpc(gateway, "workbench.read", {
      version: 1,
      binding: BINDING,
      sessionCursor: { ...first.sessionCursor, sessionId: "live-other" },
      gatewayCursor: first.gatewayCursor,
    }).catch((e: Error) => e);
    expect((foreignSession as Error).message).toContain("session");
  });

  test("scn-r2-03 a tool card completes only at its recorded tool/end, never by timing", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    // The shapes the real tool executor records: surface result text plus an
    // observe end whose duration measurement is "missing" for general tools.
    const start = sessionLog.append({ kind: "observe", name: "tool/start", payload: { id: "tool-a", name: "read" } });
    sessionLog.append({ kind: "surface", name: "tool/result", payload: { id: "tool-a", text: "recorded result", error: false } });
    const end = sessionLog.append({
      kind: "observe",
      name: "tool/end",
      payload: { name: "read", id: "tool-a", error: false, exit_code: 0, duration_ms: "missing" },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const read = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      cards: Array<{ kind: string; resultText?: string; durationMs?: number | "missing"; completionSeq?: number; completionHash?: string }>;
    };
    const card = read.cards.find((c) => c.kind === "tool");
    expect(card?.resultText).toBe("recorded result");
    // Duration stays an independent measurement: "missing" is allowed and is
    // NOT completion evidence.
    expect(card?.durationMs).toBe("missing");
    // Completion comes only from the correlated end record, as a pair.
    expect(card?.completionSeq).toBe(end.seq);
    expect(card?.completionHash).toBe(end.hash);
    expect(card?.completionSeq).toBeGreaterThan(start.seq);
    expect(card?.completionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("scn-r2-03 a tool without a recorded end stays uncompleted even with result text", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    sessionLog.append({ kind: "observe", name: "tool/start", payload: { id: "tool-b", name: "bash" } });
    sessionLog.append({ kind: "surface", name: "tool/result", payload: { id: "tool-b", text: "partial output", error: false } });
    // No tool/end: the invocation is still running as far as the source knows.

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const read = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      cards: Array<{ kind: string; resultText?: string; completionSeq?: number; completionHash?: string }>;
    };
    const card = read.cards.find((c) => c.kind === "tool");
    expect(card?.resultText).toBe("partial output");
    // Result text or idleness never stand in for the missing end record.
    expect(card?.completionSeq).toBeUndefined();
    expect(card?.completionHash).toBeUndefined();
  });

  test("scn-r2-03 id reuse never attaches a later invocation's end to the earlier card", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    const firstStart = sessionLog.append({ kind: "observe", name: "tool/start", payload: { id: "tool-c", name: "read" } });
    // The first invocation never ended; the id is reused by a second one.
    const secondStart = sessionLog.append({ kind: "observe", name: "tool/start", payload: { id: "tool-c", name: "read" } });
    sessionLog.append({ kind: "surface", name: "tool/result", payload: { id: "tool-c", text: "second run output", error: false } });
    const end = sessionLog.append({
      kind: "observe",
      name: "tool/end",
      payload: { name: "read", id: "tool-c", error: false, exit_code: 0, duration_ms: "missing" },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const read = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      cards: Array<{ kind: string; seq: number; completionSeq?: number }>;
    };
    const cards = read.cards.filter((c) => c.kind === "tool");
    expect(cards.length).toBe(2);
    const earlier = cards.find((c) => c.seq === firstStart.seq);
    const later = cards.find((c) => c.seq === secondStart.seq);
    // The end belongs to the most recent unmatched invocation of that id.
    expect(later?.completionSeq).toBe(end.seq);
    expect(earlier?.completionSeq).toBeUndefined();
  });

  test("scn-r2-03 a late end on an old card upserts the same item in a full resnapshot", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    const start = sessionLog.append({ kind: "observe", name: "tool/start", payload: { id: "tool-d", name: "grep" } });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const first = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      cards: Array<{ kind: string; seq: number; completionSeq?: number }>;
      sessionCursor: { seq: number; hash: string; generation: string; sessionId: string };
      gatewayCursor: { seq: number; hash: string; generation: string };
      resnapshot: boolean;
    };
    expect(first.cards.filter((c) => c.kind === "tool").length).toBe(1);
    expect(first.cards.find((c) => c.kind === "tool")?.completionSeq).toBeUndefined();

    // The result and the end land after the snapshot was taken, on the old
    // card — exactly the case the legacy append feed could not recover.
    sessionLog.append({ kind: "surface", name: "tool/result", payload: { id: "tool-d", text: "late result", error: false } });
    const end = sessionLog.append({
      kind: "observe",
      name: "tool/end",
      payload: { name: "grep", id: "tool-d", error: false, exit_code: 0, duration_ms: "missing" },
    });

    for (const [label, params] of [
      ["full", { version: 1, binding: BINDING }],
      ["cursor-splice", { version: 1, binding: BINDING, sessionCursor: first.sessionCursor, gatewayCursor: first.gatewayCursor }],
    ] as const) {
      const read = (await rpc(gateway, "workbench.read", params)) as {
        cards: Array<{ kind: string; seq: number; resultText?: string; completionSeq?: number; completionHash?: string }>;
        resnapshot: boolean;
      };
      // One item, upserted with its completion — never duplicated, never lost.
      const tools = read.cards.filter((c) => c.kind === "tool");
      expect(tools.length).toBe(1);
      expect(tools[0]?.seq).toBe(start.seq);
      expect(tools[0]?.resultText).toBe("late result");
      expect(tools[0]?.completionSeq).toBe(end.seq);
      expect(tools[0]?.completionHash).toBe(end.hash);
      if (label === "cursor-splice") {
        expect(read.resnapshot).toBe(false);
      }
    }
  });

  test("scn-r2-03 message linkage comes from the recorded acceptance source, not the next user/message", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    // Command A fails BEFORE acceptance: no user/message, no turn_accepted.
    sessionLog.append({ kind: "observe", name: "chat/turn_started", payload: { command_id: "cmd-a", text_bytes: 3 } });
    sessionLog.append({
      kind: "observe",
      name: "chat/turn_settled",
      payload: { command_id: "cmd-a", outcome: "failure" },
    });
    // Command B is accepted with its actual durable user/message.
    sessionLog.append({ kind: "observe", name: "chat/turn_started", payload: { command_id: "cmd-b", text_bytes: 3 } });
    const message = sessionLog.append({
      kind: "surface",
      name: "user/message",
      payload: { text: "actual folded text for b" },
    });
    sessionLog.append({
      kind: "observe",
      name: "chat/turn_accepted",
      payload: { command_id: "cmd-b", message_seq: message.seq, message_hash: message.hash },
    });
    // Both commands carry ledger intents for this binding.
    const ledger = EventLog.create(GATEWAY_LOG);
    for (const commandId of ["cmd-a", "cmd-b"]) {
      ledger.appendDurable({
        kind: "observe",
        name: "workbench/submit_intent",
        payload: {
          command_id: commandId,
          fingerprint: submitFingerprint(commandId, `payload ${commandId}`),
          client_id: BINDING.clientId,
          thread_id: BINDING.threadId,
          session_id: sessionId,
        },
      });
    }

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const read = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      commands: Array<{
        commandId: string;
        state: string;
        outcome?: string;
        messageSeq?: number;
        sources?: Record<string, number | string>;
      }>;
    };
    const a = read.commands.find((c) => c.commandId === "cmd-a");
    const b = read.commands.find((c) => c.commandId === "cmd-b");
    // A failed before acceptance: settled failure, and it never captures the
    // later user/message that belongs to B.
    expect(a?.state).toBe("settled");
    expect(a?.outcome).toBe("failure");
    expect(a?.messageSeq).toBeUndefined();
    expect((a?.sources as Record<string, unknown>)?.turnStart).toBeTypeOf("number");
    // B's linkage comes from its own recorded acceptance source.
    expect(b?.state).toBe("accepted");
    expect(b?.messageSeq).toBe(message.seq);

    // After B settles, its start/acceptance/message refs are RETAINED so a
    // recovery snapshot can still attribute historical cards to the command.
    sessionLog.append({
      kind: "observe",
      name: "chat/turn_settled",
      payload: { command_id: "cmd-b", outcome: "success" },
    });
    const afterSettle = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      commands: Array<{
        commandId: string;
        state: string;
        outcome?: string;
        messageSeq?: number;
        sources?: Record<string, number | string>;
      }>;
    };
    const settledB = afterSettle.commands.find((c) => c.commandId === "cmd-b");
    expect(settledB?.state).toBe("settled");
    expect(settledB?.outcome).toBe("success");
    expect(settledB?.messageSeq).toBe(message.seq);
    expect(settledB?.sources?.turnStart).toBeTypeOf("number");
    expect(settledB?.sources?.acceptance).toBeTypeOf("number");
    expect(settledB?.sources?.settlement).toBeTypeOf("number");

    // A forged message_seq that does not verify against the chain is
    // ignored: no invented linkage.
    sessionLog.append({
      kind: "observe",
      name: "chat/turn_accepted",
      payload: { command_id: "cmd-a", message_seq: message.seq, message_hash: "0".repeat(64) },
    });
    const reread = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      commands: Array<{ commandId: string; messageSeq?: number }>;
    };
    expect(reread.commands.find((c) => c.commandId === "cmd-a")?.messageSeq).toBeUndefined();
  });

  test("scn-r2-06 lifecycle source refs pair recorded times with their seqs", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    mkdirSync(dirname(sessionLogPath), { recursive: true });
    const sessionLog = EventLog.create(sessionLogPath);
    // Recorded times are the lifecycle rows' OWN ts — never the read's clock.
    const startedAt = "2026-03-01T10:00:00.000Z";
    const settledAt = "2026-03-01T10:02:30.000Z";
    const started = sessionLog.append({
      kind: "observe",
      name: "chat/turn_started",
      payload: { command_id: "cmd-time", text_bytes: 3 },
      ts: startedAt,
    });
    const settled = sessionLog.append({
      kind: "observe",
      name: "chat/turn_settled",
      payload: { command_id: "cmd-time", outcome: "operator_abort" },
      ts: settledAt,
    });
    expect(started.ts).toBe(startedAt);
    expect(settled.ts).toBe(settledAt);
    const ledger = EventLog.create(GATEWAY_LOG);
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/submit_intent",
      payload: {
        command_id: "cmd-time",
        fingerprint: submitFingerprint("cmd-time", "payload cmd-time"),
        client_id: BINDING.clientId,
        thread_id: BINDING.threadId,
        session_id: sessionId,
      },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await bind(gateway);

    const read = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      commands: Array<{
        commandId: string;
        state: string;
        outcome?: string;
        sources?: Record<string, number | string>;
      }>;
    };
    const command = read.commands.find((c) => c.commandId === "cmd-time");
    // The recorded time travels WITH its existing seq reference, so a
    // downstream projection can time the recorded turn start and settlement
    // from the verified source rows instead of its own wall clock.
    expect(command?.sources?.turnStart).toBe(started.seq);
    expect(command?.sources?.turnStartAt).toBe(startedAt);
    expect(command?.sources?.settlement).toBe(settled.seq);
    expect(command?.sources?.settlementAt).toBe(settledAt);
  });

  test("scn-r2-01 detach releases the transport binding only; ownership survives an active command", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const kernel = fakeKernel(workspaceSessionId(WORKSPACE), events);
    const gateway = bootGateway(kernel);
    await bind(gateway);
    await rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-1", text: "still running" });

    const detached = (await rpc(gateway, "workbench.detach", { version: 1, binding: BINDING })) as {
      detached: boolean;
    };
    expect(detached.detached).toBe(true);
    expect(events.disposed).toBe(0);

    // A different thread cannot take over while cmd-1 is unresolved.
    const takeover = await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: "client-beta",
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((takeover as Error).message).toMatch(/owned by thread/);

    // The original owner reconnects to the still-open kernel and the still-
    // active command.
    const rebound = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { reconnect: boolean };
    expect(rebound.reconnect).toBe(true);
    expect(events.disposed).toBe(0);

    const state = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      state: { activeCommandId: string | null };
    };
    expect(state.state.activeCommandId).toBe("cmd-1");
  });

  test("scn-r2-01 bind append rejection means zero kernel opens", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    // The ledger file must exist before it is frozen, or the append would
    // simply create it.
    EventLog.create(GATEWAY_LOG).append({ kind: "observe", name: "desktop/started", payload: {} });
    let opens = 0;
    const gateway = new WorkbenchGateway({
      workspaceCwd: WORKSPACE,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      openKernel: async () => {
        opens += 1;
        return fakeKernel(workspaceSessionId(WORKSPACE), events);
      },
      getKernel: () => undefined,
    });
    chmodSync(GATEWAY_LOG, 0o444);
    try {
      const refused = await rpc(gateway, "workbench.bind", {
        version: 1,
        ...BINDING,
        workspacePath: realpathSync(WORKSPACE),
      }).catch((e: Error) => e);
      expect((refused as Error).message).toMatch(/append|permission|denied|write/i);
      // Refusal is zero-effect: the kernel (and the interactive lease behind
      // it) was never opened.
      expect(opens).toBe(0);
    } finally {
      chmodSync(GATEWAY_LOG, 0o644);
    }
    // After the append path recovers the same bind proceeds normally.
    const bound = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { ok: boolean };
    expect(bound.ok).toBe(true);
    expect(opens).toBe(1);
  });

  test("scn-r2-01 a failed boot records intent and failure, never a completed binding", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const kernel = fakeKernel(workspaceSessionId(WORKSPACE), events);
    let attempts = 0;
    const gateway = new WorkbenchGateway({
      workspaceCwd: WORKSPACE,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      openKernel: async () => {
        attempts += 1;
        // A CLI chat holds the interactive lease on the first attempt.
        if (attempts === 1) {
          throw new Error("session in use: another dokkabi process (pid 4242) holds this session");
        }
        return kernel;
      },
      getKernel: () => (attempts > 1 ? kernel : undefined),
    });
    const first = await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((first as Error).message).toContain("session in use");
    // The attempt is durable and honest: a bind intent before the boot, a
    // redacted failure after it — and ZERO completed binding rows, because a
    // boot that failed never earned the `workbench/bound` name.
    const rows = new EventLog(GATEWAY_LOG, { readOnly: true }).events;
    expect(rows.some((row) => row.name === "workbench/bind_intent")).toBe(true);
    expect(rows.some((row) => row.name === "workbench/bind_failed")).toBe(true);
    expect(rows.filter((row) => row.name === "workbench/bound").length).toBe(0);
    // The failed intent still reserves the binding: no foreign takeover
    // before the owner reconciles.
    const takeover = await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: "client-beta",
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((takeover as Error).message).toMatch(/binding claim|owns this binding/);
    // The same owner retries as a reconnect rather than a fresh claim.
    const retry = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { ok: boolean; sessionId: string; reconnect: boolean };
    expect(retry.ok).toBe(true);
    expect(retry.sessionId).toBe(kernel.sessionId);
    expect(retry.reconnect).toBe(true);
    expect(attempts).toBe(2);
  });

  test("scn-r2-01 outstanding binding claims are rebuilt from the verified ledger at restart", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    // A previous process completed a binding and crashed before any detach:
    // the claim lives in the durable ledger, not in volatile memory.
    const ledger = EventLog.create(GATEWAY_LOG);
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/bind_intent",
      payload: { client_id: BINDING.clientId, thread_id: BINDING.threadId, session_id: sessionId, reconnect: false },
    });
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/bound",
      payload: { client_id: BINDING.clientId, thread_id: BINDING.threadId, session_id: sessionId, reconnect: false },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));

    // The rebuilt claim owns the workspace with no live kernel and no
    // in-process state, so the legacy fence and foreign threads both see it.
    await expect(gateway.ownsWorkspaceSession()).resolves.toBe(true);
    const takeover = await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: "client-beta",
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((takeover as Error).message).toMatch(/binding claim|owns this binding/);

    // The same owner reconnects — without a fresh start — and only a detach
    // releases the claim for the next thread.
    const reconnect = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { ok: boolean; reconnect: boolean };
    expect(reconnect.ok).toBe(true);
    expect(reconnect.reconnect).toBe(true);
    await rpc(gateway, "workbench.detach", { version: 1, binding: BINDING });
    const rebound = (await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: "client-beta",
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    })) as { ok: boolean };
    expect(rebound.ok).toBe(true);
  });

  test("scn-r2-01 a pending bind intent after a crash reserves the binding until its owner returns", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    // Crash window between the durable intent and the boot: no bound row, no
    // kernel — the intent alone is the conservative reservation.
    const ledger = EventLog.create(GATEWAY_LOG);
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/bind_intent",
      payload: { client_id: "client-gone", thread_id: "thread-gone", session_id: sessionId, reconnect: false },
    });

    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(sessionId, events));
    await expect(gateway.ownsWorkspaceSession()).resolves.toBe(true);
    const takeover = await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((takeover as Error).message).toMatch(/binding claim|owns this binding/);

    // The recorded owner — and only it — returns and reconnects.
    const owner = { clientId: "client-gone", threadId: "thread-gone" };
    const reconnect = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...owner,
      workspacePath: realpathSync(WORKSPACE),
    })) as { ok: boolean; reconnect: boolean };
    expect(reconnect.ok).toBe(true);
    expect(reconnect.reconnect).toBe(true);
  });

  test("scn-r2-01 a successful boot whose completion append fails leaves an uncertain reserved claim", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const kernel = fakeKernel(workspaceSessionId(WORKSPACE), events);
    let opens = 0;
    const gateway = new WorkbenchGateway({
      workspaceCwd: WORKSPACE,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      openKernel: async () => {
        opens += 1;
        // The boot itself succeeds; the ledger becomes unwritable right after
        // it, so the completion row cannot land.
        if (opens === 1) chmodSync(GATEWAY_LOG, 0o444);
        return kernel;
      },
      getKernel: () => kernel,
    });
    try {
      const first = await rpc(gateway, "workbench.bind", {
        version: 1,
        ...BINDING,
        workspacePath: realpathSync(WORKSPACE),
      }).catch((e: Error) => e);
      // The boot happened, so the effect is uncertain — the RPC must NOT
      // report success and no completed binding row may exist.
      expect((first as Error).message).toMatch(/append|permission|denied|write/i);
      expect(opens).toBe(1);
      const rows = new EventLog(GATEWAY_LOG, { readOnly: true }).events;
      expect(rows.some((row) => row.name === "workbench/bind_intent")).toBe(true);
      expect(rows.filter((row) => row.name === "workbench/bound").length).toBe(0);
      // While the ledger is frozen even the takeover attempt fails closed at
      // its own refusal append — zero effects either way.
      const frozenTakeover = await rpc(gateway, "workbench.bind", {
        version: 1,
        clientId: "client-beta",
        threadId: "thread-two",
        workspacePath: realpathSync(WORKSPACE),
      }).catch((e: Error) => e);
      expect((frozenTakeover as Error).message).toMatch(/binding claim|owns this binding|append|permission|denied|write/i);
      expect(opens).toBe(1);
    } finally {
      chmodSync(GATEWAY_LOG, 0o644);
    }
    // The uncertain claim still reserves the binding against foreign threads
    // once the ledger is writable again.
    const takeover = await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: "client-beta",
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((takeover as Error).message).toMatch(/binding claim|owns this binding/);
    expect(opens).toBe(1);
    // Once the ledger recovers, the same owner's retry completes the binding.
    const retry = (await rpc(gateway, "workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    })) as { ok: boolean; reconnect: boolean };
    expect(retry.ok).toBe(true);
    expect(retry.reconnect).toBe(true);
    expect(new EventLog(GATEWAY_LOG, { readOnly: true }).events.filter((row) => row.name === "workbench/bound").length).toBe(1);
  });

  test("scn-r2-01 detach append rejection retains the association", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(workspaceSessionId(WORKSPACE), events));
    await bind(gateway);
    chmodSync(GATEWAY_LOG, 0o444);
    const refused = await rpc(gateway, "workbench.detach", { version: 1, binding: BINDING }).catch((e: Error) => e);
    chmodSync(GATEWAY_LOG, 0o644);
    expect((refused as Error).message).toMatch(/append|permission|denied|write/i);
    // The association survived the rejected detach: the bound owner still
    // reads through its binding...
    const read = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      resnapshot: boolean;
    };
    expect(read.resnapshot).toBe(true);
    // ...and a foreign thread is still refused the binding.
    const takeover = await rpc(gateway, "workbench.bind", {
      version: 1,
      clientId: "client-beta",
      threadId: "thread-two",
      workspacePath: realpathSync(WORKSPACE),
    }).catch((e: Error) => e);
    expect((takeover as Error).message).toContain("owns this binding");
  });

  test("scn-r2-02 cancellation requested keeps the command active until recorded settlement", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    const gateway = bootGateway(fakeKernel(workspaceSessionId(WORKSPACE), events));
    await bind(gateway);
    await rpc(gateway, "workbench.submit", { version: 1, binding: BINDING, commandId: "cmd-1", text: "long turn" });

    const cancel = (await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-1",
      targetCommandId: "cmd-1",
    })) as { state: string };
    expect(cancel.state).toBe("requested");

    // Requested is NOT settlement: the command remains the active one and the
    // unresolved ledger entry still fences new submits.
    const before = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      state: { activeCommandId: string | null };
    };
    expect(before.state.activeCommandId).toBe("cmd-1");
    const blocked = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-2",
      text: "too soon",
    }).catch((e: Error) => e);
    expect((blocked as Error).message).toMatch(/unresolved|active/i);

    // A second cancellation id for the same target never aborts twice; only
    // a recorded settlement may clear the active command.
    const again = await rpc(gateway, "workbench.cancel", {
      version: 1,
      binding: BINDING,
      commandId: "cnl-2",
      targetCommandId: "cmd-1",
    }).catch((e: Error) => e);
    expect((again as Error).message).toMatch(/already requested|active|stale|foreign/i);
    expect(events.abortActiveCalls).toBe(1);

    // The durable settlement row is what releases both the active pointer
    // and the submit fence.
    const external = new EventLog(GATEWAY_LOG);
    external.appendDurable({
      kind: "observe",
      name: "workbench/submit_settled",
      payload: { command_id: "cmd-1", outcome: "operator_abort" },
    });
    const after = (await rpc(gateway, "workbench.read", { version: 1, binding: BINDING })) as {
      state: { activeCommandId: string | null };
    };
    expect(after.state.activeCommandId).toBeNull();
    const next = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-2",
      text: "after settlement",
    })) as { state: string };
    expect(next.state).toBe("handed_off");
  });

  test("scn-r2-02 a submitNote throw with a possible effect is unknown, never rejected", async () => {
    const events: FakeKernelEvents = { submitted: [], abortActiveCalls: 0, legacyAbortCalls: 0, poppedInbox: 0, disposed: 0 };
    let calls = 0;
    const kernel = {
      sessionId: workspaceSessionId(WORKSPACE),
      submitNote(text: string, commandId?: string) {
        calls += 1;
        if (calls === 1) {
          // The frontend seam throwing mid-delivery: the note may have staged
          // or the turn may have opened — the effect is uncertain.
          throw new Error("inbox write failed mid-delivery");
        }
        events.submitted.push({ text, commandId });
        return "prompt" as const;
      },
      abortActive() {
        events.abortActiveCalls += 1;
        return true;
      },
      busy: () => false,
      async routeStatus() {
        return { route: "fake-route", ready: false, reason: "unconfigured test route" };
      },
    } as unknown as WorkbenchKernelHandle;
    const gateway = bootGateway(kernel);
    await bind(gateway);

    const failed = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-x",
      text: "uncertain",
    }).catch((e: Error) => e);
    expect((failed as Error).message).toContain("inbox write failed mid-delivery");

    // Uncertain effect: unknown, not "rejected" — a refusal without proof
    // would silently release the command.
    const status = (await rpc(gateway, "workbench.commandStatus", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-x",
    })) as { state: string };
    expect(status.state).toBe("unknown");

    // The unknown command fences a new submit until reconciliation.
    const blocked = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-y",
      text: "next",
    }).catch((e: Error) => e);
    expect((blocked as Error).message).toMatch(/unresolved|reconcile/i);

    // Correlated reconciliation: a durable settlement row resolves it.
    const external = new EventLog(GATEWAY_LOG);
    external.appendDurable({
      kind: "observe",
      name: "workbench/submit_settled",
      payload: { command_id: "cmd-x", outcome: "failure" },
    });
    const next = (await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-y",
      text: "next",
    })) as { state: string };
    expect(next.state).toBe("handed_off");
  });

  test("scn-r2-01 handshake reports the kernel's live permission mode, following runtime changes", async () => {
    let mode: PermissionMode = "ask";
    const kernel = {
      sessionId: workspaceSessionId(WORKSPACE),
      submitNote: () => "prompt" as const,
      abortActive: () => true,
      busy: () => false,
      async routeStatus() {
        return { route: "fake-route", ready: false, reason: "unconfigured test route" };
      },
      permissionMode: () => mode,
    } as unknown as WorkbenchKernelHandle;
    const gateway = bootGateway(kernel);
    const first = (await rpc(gateway, "workbench.handshake", { version: 1 })) as {
      kernelOpen: boolean;
      routeSource: string;
      permissionMode: string;
    };
    expect(first.kernelOpen).toBe(true);
    expect(first.routeSource).toBe("kernel");
    expect(first.permissionMode).toBe("ask");
    // A runtime mode change through the controller is reflected on the next
    // handshake — the field reads the live getter, not a boot-time snapshot.
    mode = "bypass";
    const second = (await rpc(gateway, "workbench.handshake", { version: 1 })) as {
      permissionMode: string;
    };
    expect(second.permissionMode).toBe("bypass");
  });

  test("scn-r2-01 unopened handshake reports the resolved operator permission mode", async () => {
    const gateway = new WorkbenchGateway({
      workspaceCwd: WORKSPACE,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      openKernel: async () => {
        throw new Error("the kernel must not open for an unopened handshake");
      },
      getKernel: () => undefined,
    });
    const previousHome = process.env.DOKKABI_HOME;
    const previousMode = process.env.DOKKABI_PERMISSION_MODE;
    process.env.DOKKABI_HOME = HOME;
    try {
      process.env.DOKKABI_PERMISSION_MODE = "bypass";
      const bypass = (await rpc(gateway, "workbench.handshake", { version: 1 })) as {
        kernelOpen: boolean;
        routeSource: string;
        permissionMode: string;
      };
      expect(bypass.kernelOpen).toBe(false);
      expect(bypass.routeSource).toBe("configured");
      expect(bypass.permissionMode).toBe("bypass");

      delete process.env.DOKKABI_PERMISSION_MODE;
      const resolved = (await rpc(gateway, "workbench.handshake", { version: 1 })) as {
        permissionMode: string;
      };
      // The isolated test home has no config.json: the standing default.
      expect(resolved.permissionMode).toBe("auto");
    } finally {
      if (previousHome === undefined) delete process.env.DOKKABI_HOME;
      else process.env.DOKKABI_HOME = previousHome;
      if (previousMode === undefined) delete process.env.DOKKABI_PERMISSION_MODE;
      else process.env.DOKKABI_PERMISSION_MODE = previousMode;
    }
  });

  test("guard: the legacy append projection still filters by card seq (contract unchanged)", () => {
    const root = mkdtempSync("/tmp/dokkabi-workbench-legacy-");
    try {
      const log = EventLog.create(join(root, "events.jsonl"));
      const start = log.append({ kind: "observe", name: "tool/start", payload: { id: "t", name: "read" } });
      log.append({ kind: "surface", name: "tool/result", payload: { id: "t", text: "late" } });
      const cards = projectTranscript(log.events);
      // The legacy append feed keeps its seq filter: R2 recovery uses full
      // validated snapshots instead of changing this contract.
      expect(transcriptCardsAfter(cards, start.seq).some((c) => c.kind === "tool" && c.resultText === "late")).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workbench through the actual chat frontend seam", () => {
  interface FrontendHarness {
    kernel: WorkbenchKernelHandle;
    sessionDir: string;
    resolveTurn(): void;
  }

  function frontendHarness(): FrontendHarness {
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionDir = join(SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    let settleTurn: ((error?: unknown) => void) | undefined;
    const kernel = {
      sessionId,
      submitNote(text: string, commandId?: string) {
        return frontend.submitNote(text, commandId === undefined ? undefined : { commandId });
      },
      abortActive() {
        return frontend.abortTurn();
      },
      busy: () => frontend.busy(),
      async routeStatus() {
        return { route: "frontend-seam", ready: false, reason: "test double route" };
      },
    } as WorkbenchKernelHandle;
    const frontend = createChatFrontend({
      sessionDir,
      startTurn: (_text, onAccepted) =>
        new Promise<void>((resolve, reject) => {
          settleTurn = (error?: unknown) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          };
          // The real loop acknowledges after the durable user/message and
          // before route readiness; model that boundary here.
          queueMicrotask(() => onAccepted());
        }),
      onError: () => {},
    });
    return {
      kernel,
      sessionDir,
      resolveTurn: () => settleTurn?.(),
    };
  }

  test("scn-r2-02 a refused workbench submit never stages an inbox note (rejected-no-inbox)", async () => {
    const harness = frontendHarness();
    const gateway = new WorkbenchGateway({
      workspaceCwd: WORKSPACE,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      openKernel: async () => harness.kernel,
      getKernel: () => harness.kernel,
    });
    await bind(gateway);

    const first = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-1",
      text: "first turn",
    });
    expect((first as { state: string }).state).toBe("handed_off");

    const second = await rpc(gateway, "workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-2",
      text: "must not queue",
    }).catch((e: Error) => e);
    expect((second as Error).message).toMatch(/unresolved|busy|active/);
    // Fail-closed: the refused submit left NO staged note in the operator
    // inbox behind the real frontend seam.
    expect(existsSync(join(harness.sessionDir, "operator-inbox.jsonl"))).toBe(false);

    harness.resolveTurn();
  });

  test("scn-r2-02 acceptance is observed while the turn is pending and survives failure", async () => {
    const acceptedAt: string[] = [];
    const settled: Array<{ commandId?: string; outcome: string }> = [];
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionDir = join(SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    let release: (() => void) | undefined;
    let acceptNow: (() => void) | undefined;
    const frontend = createChatFrontend({
      sessionDir,
      startTurn: (_text, onAccepted) =>
        new Promise<void>((resolve, reject) => {
          acceptNow = onAccepted;
          release = () => reject(new Error("route unavailable"));
        }),
      onError: () => {},
      onTurnStart: ({ commandId }) => {
        if (commandId) acceptedAt.push(`start:${commandId}`);
      },
      onTurnAccepted: ({ commandId }) => {
        if (commandId) acceptedAt.push(`accepted:${commandId}`);
      },
      onTurnSettled: ({ commandId, outcome }) => {
        settled.push({ commandId, outcome });
      },
    });

    expect(frontend.submitNote("will fail after acceptance", { commandId: "cmd-f" })).toBe("prompt");
    expect(frontend.busy()).toBe(true);

    // The starter acknowledges (durable user/message, before route
    // readiness) while the turn is STILL pending.
    acceptNow!();
    expect(acceptedAt).toContain("accepted:cmd-f");
    expect(frontend.busy()).toBe(true);

    // The route then fails: acceptance remains observable; settlement is a
    // failure, and the recorded acceptance is not revoked.
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acceptedAt.filter((entry) => entry === "accepted:cmd-f").length).toBe(1);
    expect(settled).toEqual([{ commandId: "cmd-f", outcome: "failure" }]);
    expect(frontend.busy()).toBe(false);
  });

  test("scn-r2-02 acceptance precedes an operator abort and settles as operator_abort", async () => {
    const seen: string[] = [];
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionDir = join(SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    let accept: (() => void) | undefined;
    let abort: ((error: unknown) => void) | undefined;
    const frontend = createChatFrontend({
      sessionDir,
      startTurn: (_text, onAccepted) =>
        new Promise<void>((_resolve, reject) => {
          accept = onAccepted;
          abort = reject;
        }),
      onError: () => {},
      onTurnAccepted: ({ commandId }) => {
        if (commandId) seen.push(`accepted:${commandId}`);
      },
      onTurnSettled: ({ commandId, outcome }) => {
        if (commandId) seen.push(`settled:${commandId}:${outcome}`);
      },
    });
    expect(frontend.submitNote("abort me", { commandId: "cmd-ab" })).toBe("prompt");
    accept!();
    abort!(new OperatorAbortError());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["accepted:cmd-ab", "settled:cmd-ab:operator_abort"]);
  });

  test("scn-r2-02 a settlement-write failure stays visibly uncertain and pumps no follow-on turn", async () => {
    const started: string[] = [];
    const errors: unknown[] = [];
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionDir = join(SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    let resolveFirst: (() => void) | undefined;
    const frontend = createChatFrontend({
      sessionDir,
      startTurn: (_text, _onAccepted) =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
      onError: (error) => {
        errors.push(error);
      },
      onTurnStart: ({ commandId }) => {
        if (commandId) started.push(commandId);
      },
      onTurnSettled: () => {
        throw new Error("settlement append failed");
      },
    });
    expect(frontend.submitNote("first", { commandId: "cmd-s" })).toBe("prompt");
    // A second note stages in the legacy inbox while the first turn runs; a
    // healthy settlement would pump it as the next turn.
    expect(frontend.submitNote("queued note")).toBe("inbox");
    resolveFirst!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The settlement write failed: the error is visible, the queued note was
    // NOT pumped as a follow-on turn, and no second turn started.
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("settlement append failed");
    expect(started).toEqual(["cmd-s"]);
    expect(frontend.busy()).toBe(false);
  });

  test("scn-r2-02 a turn-start observer throw refuses the turn before any model request", async () => {
    const settled: string[] = [];
    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionDir = join(SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    let starterCalls = 0;
    const frontend = createChatFrontend({
      sessionDir,
      startTurn: () => {
        starterCalls += 1;
        return Promise.resolve();
      },
      onError: () => {},
      onTurnStart: () => {
        throw new Error("turn start append failed");
      },
      onTurnSettled: ({ commandId, outcome }) => {
        settled.push(`${commandId}:${outcome}`);
      },
    });
    expect(frontend.submitNote("never starts", { commandId: "cmd-n" })).toBe("prompt");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The observer throw was not swallowed into an unrecorded model request:
    // the starter never ran and the failure settled visibly.
    expect(starterCalls).toBe(0);
    expect(settled).toEqual(["cmd-n:failure"]);
    expect(frontend.busy()).toBe(false);
  });
});

describe("workbench wire through the real gateway and kernel", () => {
  let server: DokkabiDesktopServer;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.DOKKABI_HOME;
    // Isolated home: the kernel resolves an unconfigured route and the turn
    // fails fast instead of calling a live model. The failure settlement —
    // AFTER a durable user/message and its acceptance — is the recorded
    // behavior under test.
    process.env.DOKKABI_HOME = HOME;
  });

  afterEach(async () => {
    await server?.closeChat();
    server?.stop();
    if (previousHome === undefined) delete process.env.DOKKABI_HOME;
    else process.env.DOKKABI_HOME = previousHome;
  });

  async function rpc(method: string, params: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
    const response = await server.handleJsonRpcMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    return (response ?? {}) as { result?: unknown; error?: { message: string } };
  }

  function boot(): DokkabiDesktopServer {
    server = new DokkabiDesktopServer({
      port: 0,
      socketPath: join(TEST_DIR, "test.sock"),
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      workspaceCwd: WORKSPACE,
    });
    return server;
  }

  test("scn-r2-01 handshake reports the configured workspace session without a model call", async () => {
    boot();
    const handshake = await rpc("workbench.handshake", { version: 1 });
    expect(handshake.error).toBeUndefined();
    const result = handshake.result as {
      version: number;
      sessionId: string;
      workspacePath: string;
      capabilities: Record<string, unknown>;
      route: string;
      model?: string;
      ready: boolean;
      reason?: string;
      routeSource: string;
      kernelOpen: boolean;
    };
    expect(result.version).toBe(1);
    expect(result.sessionId).toBe(workspaceSessionId(WORKSPACE));
    expect(result.workspacePath).toBe(realpathSync(WORKSPACE));
    expect(result.capabilities.submit).toBe(true);
    // Before any bind the kernel is not open: the handshake reports the
    // operator's CONFIGURED route/model selection without probing, honestly
    // marked as such — never an "unconfigured" placeholder.
    expect(result.kernelOpen).toBe(false);
    expect(result.routeSource).toBe("configured");
    expect(typeof result.route).toBe("string");
    expect(result.route.length).toBeGreaterThan(0);
    expect(result.route).not.toBe("unconfigured");
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("not probed");

    const invalid = await rpc("workbench.handshake", { version: 3 });
    expect(invalid.error?.message).toContain("version");
  });

  test("scn-r2-01 handshake carries the resolved permission mode before and after the kernel opens", async () => {
    boot();
    const previousMode = process.env.DOKKABI_PERMISSION_MODE;
    process.env.DOKKABI_PERMISSION_MODE = "bypass";
    try {
      const configured = await rpc("workbench.handshake", { version: 1 });
      expect(configured.error).toBeUndefined();
      const before = configured.result as { routeSource: string; permissionMode: string };
      expect(before.routeSource).toBe("configured");
      expect(before.permissionMode).toBe("bypass");

      await rpc("workbench.bind", { version: 1, ...BINDING, workspacePath: realpathSync(WORKSPACE) });
      const live = await rpc("workbench.handshake", { version: 1 });
      expect(live.error).toBeUndefined();
      const after = live.result as {
        routeSource: string;
        kernelOpen: boolean;
        permissionMode: string;
        route: string;
        ready: boolean;
        reason?: string;
      };
      // The kernel booted with the operator's resolved policy, so the live
      // handshake reports the controller's actual mode — not the auto default
      // and not a stale configured snapshot.
      expect(after.routeSource).toBe("kernel");
      expect(after.kernelOpen).toBe(true);
      expect(after.permissionMode).toBe("bypass");
      expect(typeof after.route).toBe("string");
      expect(after.route.length).toBeGreaterThan(0);
      expect(typeof after.ready).toBe("boolean");
      if (after.ready === false) {
        expect(after.reason?.length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      if (previousMode === undefined) delete process.env.DOKKABI_PERMISSION_MODE;
      else process.env.DOKKABI_PERMISSION_MODE = previousMode;
    }
  }, 40_000);

  test("scn-r2-01 legacy chat mutations and note submit refuse with a recorded rejection while workbench owns", async () => {
    boot();
    const bound = await rpc("workbench.bind", { version: 1, ...BINDING, workspacePath: realpathSync(WORKSPACE) });
    expect(bound.error).toBeUndefined();
    const sessionId = workspaceSessionId(WORKSPACE);

    const fenced: Array<[string, Record<string, unknown>]> = [
      ["chat.open", {}],
      ["chat.send", { text: "legacy behind the fence" }],
      ["chat.abort", {}],
      ["chat.model", { choice: "codex" }],
      ["chat.effort", { level: "high" }],
      ["chat.close", {}],
      ["note.submit", { sessionId, text: "legacy note" }],
    ];
    for (const [method, params] of fenced) {
      const reply = await rpc(method, params);
      expect(reply.error?.message).toMatch(/workbench/i);
    }

    // Zero effects: the kernel is still open, the owner still reads through
    // its own surface, and no legacy note or inbox mutation landed.
    const state = await rpc("chat.state", {});
    expect((state.result as { owned: boolean }).owned).toBe(true);
    const read = await rpc("workbench.read", { version: 1, binding: BINDING });
    expect(read.error).toBeUndefined();
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    if (existsSync(sessionLogPath)) {
      expect(readFileSync(sessionLogPath, "utf8")).not.toContain("legacy behind the fence");
    }
    expect(existsSync(join(SESSIONS_DIR, sessionId, "operator-inbox.jsonl"))).toBe(false);

    // The refusals are recorded in the shared gateway audit log.
    const gateway = readFileSync(GATEWAY_LOG, "utf8");
    expect(gateway).toContain("desktop/chat_refused");
    expect(gateway).toContain("workbench_owns_workspace");
  }, 40_000);

  test("scn-r2-02 an unresolved workbench command fences legacy mutation with no transport binding", async () => {
    const sessionId = workspaceSessionId(WORKSPACE);
    // A crash window that predates this server process: the durable intent
    // alone owns the workspace until it is reconciled.
    const ledger = EventLog.create(GATEWAY_LOG);
    ledger.appendDurable({
      kind: "observe",
      name: "workbench/submit_intent",
      payload: {
        command_id: "cmd-u",
        fingerprint: submitFingerprint("cmd-u", "pending reconciliation"),
        client_id: "client-gone",
        thread_id: "thread-gone",
        session_id: sessionId,
      },
    });
    boot();
    const refused = await rpc("chat.open", {});
    expect(refused.error?.message).toMatch(/workbench/i);

    // Reconciliation releases the fence: the durable settlement row arrives
    // and the legacy surface works again — no blanket removal.
    const external = new EventLog(GATEWAY_LOG);
    external.appendDurable({
      kind: "observe",
      name: "workbench/submit_settled",
      payload: { command_id: "cmd-u", outcome: "failure" },
    });
    const opened = await rpc("chat.open", {});
    expect(opened.error).toBeUndefined();
  }, 40_000);

  test("scn-r2-01 concurrent legacy open and workbench bind boot the shared kernel exactly once", async () => {
    boot();
    const [opened, bound] = await Promise.all([
      rpc("chat.open", { resume: true }),
      rpc("workbench.bind", { version: 1, ...BINDING, workspacePath: realpathSync(WORKSPACE) }),
    ]);
    // The bind always ends up with its kernel; the legacy open either shared
    // the one boot or was honestly refused by the ownership fence — never a
    // lease race or a second boot.
    expect(bound.error).toBeUndefined();
    if (opened.error) {
      expect(opened.error.message).toMatch(/workbench/i);
      expect(opened.error.message).not.toMatch(/session in use|lease/i);
    } else {
      expect((opened.result as { sessionId: string }).sessionId).toBe(workspaceSessionId(WORKSPACE));
    }
    // Exactly one kernel boot: one permission/mode row in the session log.
    const sessionLogPath = join(SESSIONS_DIR, workspaceSessionId(WORKSPACE), "events.jsonl");
    expect(existsSync(sessionLogPath)).toBe(true);
    expect(readFileSync(sessionLogPath, "utf8").split("permission/mode").length - 1).toBe(1);
    const state = await rpc("chat.state", {});
    expect((state.result as { owned: boolean }).owned).toBe(true);
    const read = await rpc("workbench.read", { version: 1, binding: BINDING });
    expect(read.error).toBeUndefined();
  }, 40_000);

  test("scn-r2-01 a legacy mutation's ownership decision and effect are atomic against a concurrent bind", async () => {
    boot();
    const [opened, bound] = await Promise.all([
      rpc("chat.open", { resume: true }),
      rpc("workbench.bind", { version: 1, ...BINDING, workspacePath: realpathSync(WORKSPACE) }),
    ]);
    // The legacy open was first in line and decided against an unowned
    // workspace, so it completes honestly; the bind then takes over.
    expect(opened.error).toBeUndefined();
    expect(bound.error).toBeUndefined();

    // The atomicity fence: a legacy mutation's durable effect row may never
    // land AFTER the workbench ownership rows of a mutation queued behind it.
    // Before the shared seam, the bind's ownership row landed mid-boot, ahead
    // of desktop/chat_opened — the decision and the effect were separable.
    const rows = new EventLog(GATEWAY_LOG, { readOnly: true }).events;
    const chatOpened = rows.findIndex((row) => row.name === "desktop/chat_opened");
    const workbenchClaim = rows.findIndex(
      (row) => row.name === "workbench/bind_intent" || row.name === "workbench/bound",
    );
    expect(chatOpened).toBeGreaterThanOrEqual(0);
    expect(workbenchClaim).toBeGreaterThanOrEqual(0);
    expect(chatOpened).toBeLessThan(workbenchClaim);
  }, 40_000);

  test("scn-r2-02 a failed desktop boot releases its lease and never steals a live CLI lease", async () => {
    const sessionId = "qa-boot-failure";
    // A boot that fails after acquiring the lease must not poison the
    // session for the next attempt in the same process.
    await expect(
      openDesktopChatKernel({
        sessionId,
        home: HOME,
        workspaceRoot: WORKSPACE,
        repoRoot: REPO_ROOT,
        manifestPath: join(TEST_DIR, "does-not-exist.yml"),
        resume: true,
      }),
    ).rejects.toThrow();
    const recovered = acquireSessionLease(join(SESSIONS_DIR, sessionId));
    recovered.release();

    // A live CLI lease is protection, not an obstacle to steal.
    const cli = acquireSessionLease(join(SESSIONS_DIR, sessionId));
    await expect(
      openDesktopChatKernel({
        sessionId,
        home: HOME,
        workspaceRoot: WORKSPACE,
        repoRoot: REPO_ROOT,
        manifestPath: defaultManifestPath(REPO_ROOT),
        resume: true,
      }),
    ).rejects.toThrow(/session in use/);
    cli.release();

    // After the failure is cleaned up and no live owner remains, the same
    // session boots.
    const kernel = await openDesktopChatKernel({
      sessionId,
      home: HOME,
      workspaceRoot: WORKSPACE,
      repoRoot: REPO_ROOT,
      manifestPath: defaultManifestPath(REPO_ROOT),
      resume: true,
    });
    expect(kernel.sessionId).toBe(sessionId);
    await kernel.dispose();
  }, 40_000);

  test("scn-r2-02 a submit reaches the kernel, records correlated lifecycle and settles honestly", async () => {
    boot();
    const bound = await rpc("workbench.bind", {
      version: 1,
      ...BINDING,
      workspacePath: realpathSync(WORKSPACE),
    });
    expect(bound.error).toBeUndefined();

    const read = await rpc("workbench.read", { version: 1, binding: BINDING });
    expect(read.error).toBeUndefined();

    const submit = await rpc("workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-live-1",
      text: "workbench integration hello",
    });
    expect(submit.error).toBeUndefined();
    expect((submit.result as { state: string }).state).toBe("handed_off");

    const sessionId = workspaceSessionId(WORKSPACE);
    const sessionLogPath = join(SESSIONS_DIR, sessionId, "events.jsonl");
    let settled: { state: string; outcome?: string } | undefined;
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const status = await rpc("workbench.commandStatus", {
        version: 1,
        binding: BINDING,
        commandId: "cmd-live-1",
      });
      if (status.error) break;
      const state = (status.result as { state: string }).state;
      if (state === "settled") settled = status.result as { state: string; outcome?: string };
    }
    expect(settled?.state).toBe("settled");
    // The unconfigured route fails the turn; that failure IS the outcome.
    expect(settled?.outcome).toBe("failure");

    const text = readFileSync(sessionLogPath, "utf8");
    expect(text).toContain("chat/turn_started");
    expect(text).toContain("cmd-live-1");
    // Acceptance carries the actual durable user/message source.
    expect(text).toContain("chat/turn_accepted");
    expect(text).toContain("message_seq");
    expect(text).toContain("chat/turn_settled");
    expect(text).toContain("workbench integration hello");
    // Exactly one model-facing user row for one command.
    expect(text.split("workbench integration hello").length - 1).toBe(1);

    // Idempotent retry: same id, same payload, no second model input.
    const duplicate = await rpc("workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-live-1",
      text: "workbench integration hello",
    });
    expect((duplicate.result as { duplicate: boolean; state: string }).duplicate).toBe(true);
    expect((duplicate.result as { state: string }).state).toBe("settled");
    expect(readFileSync(sessionLogPath, "utf8").split("workbench integration hello").length - 1).toBe(1);

    const conflict = await rpc("workbench.submit", {
      version: 1,
      binding: BINDING,
      commandId: "cmd-live-1",
      text: "other payload",
    });
    expect(conflict.error?.message).toMatch(/different payload/);

    // The legacy chat surface is untouched by the R2 additions.
    const state = await rpc("chat.state", {});
    expect((state.result as { owned: boolean }).owned).toBe(true);

    // Detach releases the transport binding, not the kernel.
    const detached = await rpc("workbench.detach", { version: 1, binding: BINDING });
    expect((detached.result as { detached: boolean }).detached).toBe(true);
    const afterDetach = await rpc("chat.state", {});
    expect((afterDetach.result as { owned: boolean }).owned).toBe(true);
  }, 40_000);
});
