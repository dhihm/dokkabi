import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { createHostedModels } from "../src/plugins/hosted-models.ts";
import { routeModelCatalog } from "../src/plugins/model-catalog.ts";
import { gatewayModel } from "../src/plugins/llm-route-catalog.ts";
import { createLlmFacade, listCodexModels } from "../src/plugins/llm-routes.ts";
import { EventLog } from "../src/host/event-log.ts";
import { PiAuthStore } from "../src/plugins/pi-auth-store.ts";
import { listWorkbenchModels } from "../src/dash/workbench-models.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const choices = [
  ["claude", "claude-opus-5-5", "anthropic-messages"],
  ["claude", "claude-sonnet-5-5", "anthropic-messages"],
  ["codex", "gpt-6-astra", "openai-codex-responses"],
  ["codex", "gpt-6.1-sol", "openai-codex-responses"],
] as const;

test("desktop discovery carries all four exact identities without credential values", async () => {
  const root = mkdtempSync(join(tmpdir(), "dokkabi-current-discovery-")); roots.push(root);
  const authFile = join(root, "auth.json");
  writeFileSync(authFile, "{}", { mode: 0o600 });
  const previous = process.env.DOKKABI_PI_AUTH;
  process.env.DOKKABI_PI_AUTH = authFile;
  try {
    const entries = await listWorkbenchModels();
    for (const [route, model] of choices) {
      const entry = entries.find(item => item.route === route && item.model === model);
      expect(entry).toBeDefined();
      expect(Object.keys(entry!).sort()).toEqual(["connected", "model", "name", "provider", "route"]);
    }
  } finally {
    if (previous === undefined) delete process.env.DOKKABI_PI_AUTH;
    else process.env.DOKKABI_PI_AUTH = previous;
  }
});

for (const [route, id, api] of choices) {
  test(`${id} is discoverable and resolves through its provider route`, async () => {
    const catalog = routeModelCatalog(createHostedModels({ env: {} }), route);
    expect(catalog.models.some(model => model.id === id)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "dokkabi-current-models-")); roots.push(root);
    const facade = createLlmFacade(EventLog.create(join(root, "events.jsonl")), join(root, "auth.json"));
    expect(await facade.routes.get(route)!.resolveModel(id)).toMatchObject({ id, api });
    if (route === "codex") expect(listCodexModels().some(model => model.id === id)).toBe(true);
  });

  for (const reasoning of ["low", "xhigh", "max"] satisfies ThinkingLevel[]) {
    test(`${id} encodes ${reasoning} and tools with the actual Pi provider`, async () => {
      const model = gatewayModel(route, id)!;
      expect(model).toBeDefined();
      let body: Record<string, any> | undefined;
      const credential = api === "openai-codex-responses"
        ? ["fixture", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url"), "fixture"].join(".")
        : "non-secret-encoding-fixture";
      const root = mkdtempSync(join(tmpdir(), "dokkabi-encoder-auth-")); roots.push(root);
      const authFile = join(root, "auth.json");
      writeFileSync(authFile, JSON.stringify(api === "openai-codex-responses"
        ? { "openai-codex": { type: "oauth", access: credential, refresh: "non-secret-refresh-fixture", expires: Date.now() + 86_400_000 } }
        : {}), { mode: 0o600 });
      const stream = createHostedModels({ env: {}, credentials: new PiAuthStore(authFile) }).streamSimple(model, {
        systemPrompt: "Synthetic encoder qualification", messages: [{ role: "user", content: "fixture", timestamp: 0 }],
        tools: [{ name: "fixture_tool", description: "Fixture tool", parameters: Type.Object({ value: Type.String() }) }],
      }, { apiKey: credential, reasoning, ...(api === "anthropic-messages" ? { temperature: 0.3 } : {}), transport: "sse", maxRetries: 0, maxTokens: 64,
        fetch: Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
          const bytes = await new Response(init?.body).arrayBuffer();
          const decoded = new Headers(init?.headers).get("content-encoding") === "zstd"
            ? zstdDecompressSync(Buffer.from(bytes)) : Buffer.from(bytes);
          body = JSON.parse(decoded.toString("utf8"));
          // A deliberate local refusal captures the real encoder, not live model acceptance.
          return new Response(JSON.stringify({ error: { message: "Synthetic request captured", type: "invalid_request_error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
        }, { preconnect: () => {} }),
      });
      const result = await stream.result();
      if (!body) throw new Error(result.errorMessage ?? "Synthetic encoder did not send");
      expect(body?.model).toBe(id);
      expect(body?.tools).toHaveLength(1);
      if (api === "anthropic-messages") {
        expect(body).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: reasoning } });
        expect(body?.thinking).not.toHaveProperty("budget_tokens");
        expect(body?.tools[0].input_schema.properties.value.type).toBe("string");
        expect(body).not.toHaveProperty("temperature");
      } else {
        expect(body).toMatchObject({ reasoning: { effort: reasoning }, tool_choice: "auto" });
        expect(body?.tools[0].type).toBe("function");
        expect(body?.tools[0].parameters.properties.value.type).toBe("string");
      }
    });
  }
}
