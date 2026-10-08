import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DokkabiDesktopServer } from "../src/dash/desktop-server.ts";
import { acquireSessionLease } from "../src/host/session-lease.ts";
import { workspaceSessionId } from "../src/host/paths.ts";

const TEST_DIR = realpathSync(mkdtempSync("/tmp/dokkabi-desktop-server-chat-"));
const HOME = join(TEST_DIR, "home");
const SESSIONS_DIR = join(HOME, "sessions");
const WORKSPACE = join(TEST_DIR, "workspace");
const SOCKET_PATH = join(TEST_DIR, "test.sock");
const GATEWAY_LOG = join(TEST_DIR, "gateway.jsonl");

async function rpc(server: DokkabiDesktopServer, id: number | string, method: string, params: unknown = {}) {
  return server.handleJsonRpcMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

function sessionLogPathFor(id: string): string {
  return join(SESSIONS_DIR, id, "events.jsonl");
}

describe("desktop embedded chat kernel", () => {
  let server: DokkabiDesktopServer;
  let previousHome: string | undefined;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(join(WORKSPACE, "note.txt"), "scratch workspace for the desktop chat kernel\n");
    // The kernel boots the real session runtime, which resolves the operator's
    // configured route and credentials from DOKKABI_HOME. Without a test home
    // it borrows the developer's: on a machine with a connected route the turn
    // becomes a live provider call, the kernel stays busy past the poll window,
    // and the run's verdict depends on whoever ran it. Point it at the test
    // home so the turn fails fast on an unconfigured route, which is what
    // these assertions are about.
    previousHome = process.env.DOKKABI_HOME;
    process.env.DOKKABI_HOME = HOME;
  });

  afterEach(async () => {
    await server?.closeChat();
    await server?.stop();
    if (previousHome === undefined) delete process.env.DOKKABI_HOME;
    else process.env.DOKKABI_HOME = previousHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function boot(): DokkabiDesktopServer {
    server = new DokkabiDesktopServer({
      port: 0,
      socketPath: SOCKET_PATH,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      workspaceCwd: WORKSPACE,
    });
    return server;
  }

  test("scn-chat-turn-runs chat.open owns the workspace session and refuses a competing owner", async () => {
    await boot().start();
    const expectedId = workspaceSessionId(WORKSPACE);
    const opened = await rpc(server, 1, "chat.open", {});
    expect(opened?.error).toBeUndefined();
    expect((opened?.result as { sessionId: string }).sessionId).toBe(expectedId);
    expect(existsSync(sessionLogPathFor(expectedId))).toBe(true);

    // A competing interactive owner on the same session is refused while the
    // desktop holds the lease — in both directions.
    let conflict: unknown;
    try {
      acquireSessionLease(join(SESSIONS_DIR, expectedId));
    } catch (error) {
      conflict = error;
    }
    expect((conflict as Error)?.message).toContain("session in use");

    const closed = await rpc(server, 2, "chat.close", {});
    expect(closed?.error).toBeUndefined();
    // With the lease released, another owner may take it.
    const lease = acquireSessionLease(join(SESSIONS_DIR, expectedId));
    expect(lease).toBeDefined();
    lease.release();

    const gateway = readFileSync(GATEWAY_LOG, "utf8");
    expect(gateway).toContain("desktop/chat_opened");
    expect(gateway).toContain("desktop/chat_closed");
  });

  test("scn-chat-turn-runs chat.send lands the note in the session EventLog", async () => {
    await boot().start();
    const opened = await rpc(server, 3, "chat.open", {});
    const sessionId = (opened?.result as { sessionId: string }).sessionId;
    const sent = await rpc(server, 4, "chat.send", { text: "desktop kernel hello" });
    expect(sent?.error).toBeUndefined();

    // The turn's user surface event must be reconstructible from the log —
    // whatever the provider did afterwards (an unready route fails fast).
    const path = sessionLogPathFor(sessionId);
    let saw = false;
    for (let i = 0; i < 100 && !saw; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        saw = text.includes("desktop kernel hello") && text.includes("user/message");
      }
    }
    expect(saw).toBe(true);

    // The kernel reaches idle again after the failed turn.
    let idle = false;
    for (let i = 0; i < 100 && !idle; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const state = await rpc(server, 5, "chat.state", {});
      idle = (state?.result as { busy: boolean }).busy === false;
    }
    expect(idle).toBe(true);
    // Its own budget, stated: the two poll loops above allow 15s each, so the
    // 5s default was a deadline this test could never honour under load — it
    // reported a timeout where an assertion failure was the real answer.
  }, 40_000);

  test("scn-chat-turn-runs a named foreign session is refused honestly", async () => {
    await boot().start();
    const reply = await rpc(server, 6, "chat.open", { sessionId: "some-other-session" });
    expect(reply?.error?.message).toContain(workspaceSessionId(WORKSPACE));
  });
});

describe("desktop chat route readiness and observer model selection", () => {
  let server: DokkabiDesktopServer;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    await server?.closeChat();
    await server?.stop();
    delete process.env.DOKKABI_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function boot(): DokkabiDesktopServer {
    server = new DokkabiDesktopServer({
      port: 0,
      socketPath: SOCKET_PATH,
      sessionsRoot: SESSIONS_DIR,
      gatewayLogPath: GATEWAY_LOG,
      workspaceCwd: WORKSPACE,
    });
    return server;
  }

  test("scn-rail-shows-state chat.state carries the kernel route readiness", async () => {
    await boot().start();
    await rpc(server, 10, "chat.open", {});
    const state = await rpc(server, 11, "chat.state", {});
    const result = state?.result as { owned: boolean; route?: string; ready?: boolean; reason?: string };
    expect(result.owned).toBe(true);
    expect(typeof result.route).toBe("string");
    expect(typeof result.ready).toBe("boolean");
    if (result.ready === false) {
      expect(result.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("scn-rail-shows-state model.select persists the saved pair without a kernel", async () => {
    await boot().start();
    // The saved pair is operator config: keep the write inside the test home.
    const previousHome = process.env.DOKKABI_HOME;
    process.env.DOKKABI_HOME = HOME;
    try {
      const chosen = await rpc(server, 12, "model.select", { choice: "codex" });
      expect(chosen?.error).toBeUndefined();
      const message = (chosen?.result as { message?: string }).message ?? "";
      expect(message).toContain("route=codex");

      const unknown = await rpc(server, 13, "model.select", { choice: "not-a-route" });
      expect(unknown?.error?.message).toContain("unknown llm route");
    } finally {
      if (previousHome === undefined) delete process.env.DOKKABI_HOME;
      else process.env.DOKKABI_HOME = previousHome;
    }
  });
});
