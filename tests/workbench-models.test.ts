import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkbenchGateway, type WorkbenchKernelHandle } from "../src/dash/workbench.ts";
import { DokkabiDesktopServer } from "../src/dash/desktop-server.ts";
import { EventLog } from "../src/host/event-log.ts";
import { workspaceSessionId } from "../src/host/paths.ts";
import { gatewayModel, BUILTIN_ROUTE_SPECS } from "../src/plugins/llm-route-catalog.ts";
import { createHostedModels } from "../src/plugins/hosted-models.ts";
import { Type } from "typebox";
import { createLlmFacade } from "../src/plugins/llm-routes.ts";
import { readFileSync, writeFileSync } from "node:fs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const owner = { clientId: "models-client", threadId: "models-thread" };
function fixture(pinned = false, connected = true) {
  const root = realpathSync(mkdtempSync("/tmp/dokkabi-model-selection-")); roots.push(root);
  const sessionsRoot = join(root, "sessions"); mkdirSync(sessionsRoot);
  const sessionId = workspaceSessionId(root); mkdirSync(join(sessionsRoot, sessionId));
  EventLog.create(join(sessionsRoot, sessionId, "events.jsonl"));
  let current = { route: "glm", model: "glm-5.3" }; let busy = false; let calls = 0; let opens = 0;
  const kernel: WorkbenchKernelHandle = {
    sessionId, busy: () => busy, abortActive: () => false, submitNote: () => "ignored",
    routeStatus: async () => ({ ...current, ready: true }),
    setModel: async (choice) => { calls++; const [route, ...model] = choice.split("/"); current = { route: route!, model: model.join("/") }; return "selected"; },
  };
  let opened = false;
  const gateway = new WorkbenchGateway({ workspaceCwd: root, sessionsRoot,
    gatewayLogPath: join(root, "gateway.jsonl"),
    openKernel: async () => { opens++; opened = true; return kernel; }, getKernel: () => opened ? kernel : undefined,
    listModels: async () => [{ route: "claude", provider: "anthropic", model: "claude-fixture", name: "Claude fixture", connected }],
    ...(pinned ? { modelIdentity: { ...current, provider: "zai" } } : {}),
  });
  const bind = () => gateway.handle("workbench.bind", { version: 1, ...owner, workspacePath: root });
  const select = (patch = {}) => gateway.handle("workbench.model", { version: 1, binding: owner, route: "claude", model: "claude-fixture", expectedRoute: "glm", expectedModel: "glm-5.3", ...patch });
  return { gateway, bind, select, current: () => current, calls: () => calls, opens: () => opens,
    setBusy: (value: boolean) => { busy = value; }, kernel, root };
}
test("Flash uses the official Z.ai model code and canonical Google API route exists", () => {
  expect(gatewayModel("glm", "glm-5.3-flash")).toMatchObject({ id: "glm-5.3-flash", provider: "zai", input: ["text", "image"], reasoning: true });
  expect(BUILTIN_ROUTE_SPECS.find(s => s.name === "google")?.providerId).toBe("google");
});
test("Flash uses the real Pi encoder with enabled thinking and streamed tools", async () => {
  const model = gatewayModel("glm", "glm-5.3-flash")!;
  let body: Record<string, unknown> | undefined;
  const result = await createHostedModels({ env: {} }).streamSimple(model, {
    systemPrompt: "Synthetic encoding test", messages: [{ role: "user", content: "fixture", timestamp: 0 }],
    tools: [{ name: "fixture_tool", description: "Fixture tool", parameters: Type.Object({}) }],
  }, { apiKey: "non-secret-encoding-fixture", reasoning: "high", maxTokens: 64,
    fetch: Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }, { preconnect: () => {} }),
  }).result();
  expect(result.stopReason).not.toBe("error");
  expect(body).toMatchObject({ model: "glm-5.3-flash", thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", tool_stream: true });
});
test("authenticated catalog discovery does not boot a kernel", async () => {
  const f = fixture(); const result = await f.gateway.handle("workbench.handshake", { version: 1 }) as { models: unknown[]; capabilities: { modelChange: boolean } };
  expect(result.models).toContainEqual({ route: "claude", provider: "anthropic", model: "claude-fixture", name: "Claude fixture", connected: true });
  expect(result.capabilities.modelChange).toBe(true); expect(f.opens()).toBe(0); expect(f.calls()).toBe(0);
});
test("idle bound selection uses the kernel and persists intent/outcome", async () => {
  const f = fixture(); await f.bind(); expect(await f.select()).toMatchObject({ state: "applied", route: "claude", model: "claude-fixture" });
  expect(f.calls()).toBe(1); expect(f.current().route).toBe("claude");
  const log = new EventLog(join(f.root, "gateway.jsonl"), { readOnly: true });
  expect(log.events.map(e => e.name)).toEqual(expect.arrayContaining(["workbench/model_intent", "workbench/model_applied"]));
});
test("foreign binding, busy state, stale pair and pinned child never select", async () => {
  const f = fixture(); await f.bind();
  await expect(f.select({ binding: { ...owner, threadId: "foreign" } })).rejects.toThrow("binding");
  f.setBusy(true); expect(await f.select()).toMatchObject({ state: "busy" }); f.setBusy(false);
  await expect(f.select({ expectedModel: "stale" })).rejects.toThrow("changed"); expect(f.calls()).toBe(0);
  const child = fixture(true); await child.bind(); expect(await child.select()).toMatchObject({ state: "unsupported" }); expect(child.calls()).toBe(0);
});
test("unknown or unauthenticated target refuses before kernel mutation", async () => {
  const f = fixture(); await f.bind(); await expect(f.select({ model: "invented" })).rejects.toThrow("catalog"); expect(f.calls()).toBe(0);
  const missing = fixture(false, false); await missing.bind(); await expect(missing.select()).rejects.toThrow("Sign in"); expect(missing.calls()).toBe(0);
});
test("carry confirmation retains the old model and is visible", async () => {
  const f = fixture(); await f.bind(); f.kernel.setModel = async () => ({ kind: "handoff_confirmation", choice: "claude/claude-fixture", route: "claude", model: "claude-fixture", afterMessages: 20, afterTokens: 100, contextWindow: 120, percent: 83 });
  expect(await f.select()).toMatchObject({ state: "confirmation_required" }); expect(f.current().route).toBe("glm");
});

test("thinking-only credential probe records enabled effort before the actual local HTTP send", async () => {
  const root = realpathSync(mkdtempSync("/tmp/dokkabi-model-probe-")); roots.push(root);
  const auth = join(root, "auth.json");
  writeFileSync(auth, JSON.stringify({ zai: { type: "api_key", key: "non-secret-probe-fixture" } }));
  const log = EventLog.create(join(root, "probe.jsonl"));
  let body: Record<string, unknown> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    body = await request.json() as Record<string, unknown>;
    return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const route = createLlmFacade(log, auth).routes.get("glm")!;
    const model = { ...gatewayModel("glm", "glm-5.3-flash")!, baseUrl: `http://127.0.0.1:${server.port}/v1` };
    const stream = route.streamCredentialProbe!(model, 5_000) as AsyncIterable<unknown>;
    for await (const _event of stream) { /* Drain the local fixture response. */ }
    expect(body).toMatchObject({ thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "low" });
    expect(log.events.some(event => event.name === "provider/send")).toBe(true);
    expect(readFileSync(log.path, "utf8")).not.toContain("non-secret-probe-fixture");
  } finally { server.stop(true); }
});

test("actual authenticated desktop WebSocket routes model selection to the ownership gate", async () => {
  const f = fixture();
  const server = new DokkabiDesktopServer({ port: 0, workspaceCwd: f.root,
    socketPath: join(f.root, "desktop.sock"), sessionsRoot: join(f.root, "sessions"),
    gatewayLogPath: join(f.root, "server-gateway.jsonl") });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["dokkabi.rpc", `dokkabi.auth.${encodeURIComponent(server.pairingToken)}`]);
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Fixture transport refused")); });
    const response = new Promise<{ error?: { message: string } }>((resolve, reject) => {
      ws.onmessage = event => { const row = JSON.parse(String(event.data)); if (row.id === 1) resolve(row); };
      ws.onerror = () => reject(new Error("Fixture request transport failed"));
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workbench.model", params: {
      version: 1, binding: owner, route: "glm", model: "glm-5.3-flash", expectedRoute: "glm", expectedModel: "glm-5.3",
    } }));
    const result = await response;
    expect(result.error?.message).toMatch(/binding/i);
    expect(result.error?.message).not.toMatch(/Method not found/i);
  } finally { ws.close(); await server.stop(); }
});
