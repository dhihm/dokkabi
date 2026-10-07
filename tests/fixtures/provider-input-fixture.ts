import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { EventLog } from "../../src/host/event-log.ts";
import { createLlmFacade } from "../../src/plugins/llm-routes.ts";
import { HostContextImpl } from "../../src/loader/context.ts";
import { admitProviderInput, appendProviderMessage, replaceProviderMessages } from "../../src/host/provider-input.ts";

export function completionResponse(text = "OK"): Response {
  const data = { id: "fixture-response", object: "chat.completion.chunk", created: 0,
    model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] };
  return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

let retainedFixtureOrdinal = 0;

export function providerFixture(reply: (body: unknown, ordinal: number) => Response = () => completionResponse()) {
  const root = mkdtempSync(join(tmpdir(), "dokkabi-provider-input-"));
  const received: unknown[] = [];
  const receivedBytes: Buffer[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const bytes = Buffer.from(await request.arrayBuffer()); receivedBytes.push(bytes);
    const body: unknown = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"));
    received.push(body);
    return reply(body, received.length);
  } });
  const previous = { DOKKABI_VLLM_BASE_URL: process.env.DOKKABI_VLLM_BASE_URL, VLLM_API_KEY: process.env.VLLM_API_KEY };
  process.env.DOKKABI_VLLM_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.VLLM_API_KEY = "local-fixture-credential";
  writeFileSync(join(root, "auth.json"), "{}\n");
  const log = EventLog.create(join(root, "events.jsonl"));
  const llm = createLlmFacade(log, join(root, "auth.json")); llm.select("vllm", "fixture");
  const ctx = new HostContextImpl({ log, sessionId: "provider-fixture", workspaceRoot: root, systemPrompt: "Answer the operator." });
  ctx.llm = llm; ctx.sealIfNeeded("tools_changed", true);
  return {
    root, log, llm, ctx, received, receivedBytes, server,
    resumedContext() {
      const fresh = new HostContextImpl({ log, sessionId: "provider-fixture", workspaceRoot: root, systemPrompt: ctx.systemPrompt });
      fresh.llm = llm;
      return fresh;
    },
    async admission(text = "a logged question", overrides: SimpleStreamOptions = {}) {
      replaceProviderMessages(log, [], "start");
      log.append({ kind: "surface", name: "user/message", payload: { text } });
      const message = { role: "user", content: [{ type: "text", text }], timestamp: 0 };
      appendProviderMessage(log, message);
      const model = await llm.active().resolveModel("fixture") as Model<Api>;
      const context = { systemPrompt: ctx.systemPrompt, messages: [message], tools: [] };
      const options = { maxTokens: 16, maxRetries: 0, timeoutMs: 3000, ...overrides };
      admitProviderInput(log, { route: "vllm", role: "test", model, context, options });
      return { model, context, options };
    },
    close() {
      server.stop(true);
      const out = process.env.DOKKABI_TASK13_QA_OUT;
      if (out) {
        const destination = join(out, "fixtures", String(++retainedFixtureOrdinal).padStart(3, "0"));
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(root, "received.json"), JSON.stringify({ bodies: received,
          bytes_base64: receivedBytes.map(bytes => bytes.toString("base64")) }) + "\n");
        cpSync(root, destination, { recursive: true });
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function drain(stream: unknown): Promise<string[]> {
  const errors: string[] = [];
  for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
    if (event.type === "error") errors.push(String((event.error as { errorMessage?: unknown }).errorMessage));
  }
  return errors;
}
