import { expect, test } from "bun:test";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createToolContributionRegistry } from "../src/plugins/plugin-runtime.ts";
import { createGitTool } from "../plugins/git/tool.ts";
import { createHostedModels } from "../src/plugins/hosted-models.ts";
import { gatewayModel } from "../src/plugins/llm-route-catalog.ts";

const bash = { name: "bash", execute: async () => { throw Error("Schema tests must not execute shell commands"); } } as unknown as AgentTool;
function admitted(tool: AgentTool) {
  const registry = createToolContributionRegistry();
  registry.register("fixture", tool);
  return registry.list()[0]!;
}
function valid(tool: AgentTool, arguments_: unknown) {
  try { return { ok: true, value: validateToolArguments(tool, { type: "toolCall", id: "fixture", name: tool.name, arguments: arguments_ as never }) }; }
  catch { return { ok: false }; }
}

test("Given a contributed operation union, registration exposes object properties before provider encoding", () => {
  const original = createGitTool(bash), tool = admitted(original);
  const wire = JSON.parse(JSON.stringify(tool.parameters));
  expect(wire.type).toBe("object");
  expect(wire.properties.op).toBeDefined();
  expect(wire.properties.revision).toEqual({ type: "string", pattern: "^[a-f0-9]{40}$" });
  expect(wire.required).toEqual(["op"]);
  expect(wire.anyOf).toEqual(JSON.parse(JSON.stringify(original.parameters)).anyOf);
  expect(tool.execute as unknown).toBe(original.execute);
  expect(JSON.parse(JSON.stringify(original.parameters))).not.toHaveProperty("type");
});

test("Given branch-specific contracts, registration preserves acceptance, coercion and refusal for every Git operation", () => {
  const original = createGitTool(bash), tool = admitted(original);
  const serialized = { ...tool, parameters: JSON.parse(JSON.stringify(tool.parameters)) };
  const cases = [
    {}, null, [], { op: "status" }, { op: "status", revision: "a".repeat(40) },
    { op: "diff", staged: true }, { op: "diff", staged: "true" },
    { op: "log", limit: 10 }, { op: "log", limit: "10" }, { op: "log", limit: 101 },
    { op: "branch_create", name: "feature/example" }, { op: "branch_switch", name: "main" },
    { op: "branch_create" }, { op: "branch_switch" },
    { op: "stage", paths: ["a.ts"] }, { op: "stage", paths: [] },
    { op: "commit", paths: ["a.ts"], message: "Fix behavior" }, { op: "commit", paths: ["a.ts"] },
    { op: "push" }, { op: "fetch_revision", revision: "a".repeat(40) },
    { op: "fetch_revision" }, { op: "fetch_revision", revision: "abc" },
    { op: "fetch_revision", revision: "a".repeat(40), remote: "other" }, { op: "unknown" },
  ];
  for (const args of cases) {
    expect(valid(tool, args)).toEqual(valid(original, args));
    expect(valid(serialized, args)).toEqual(valid(original, args));
  }
  expect(valid(tool, { op: "fetch_revision", revision: "a".repeat(40) }).ok).toBe(true);
  expect(valid(tool, { op: "status", revision: "a".repeat(40) }).ok).toBe(false);
});

test("Given valid provider arguments, validation and contributed dispatch preserve the exact fetch revision", async () => {
  let fetched: string | undefined;
  const tool = admitted(createGitTool(bash, undefined, revision => {
    fetched = revision; return { text: "Synthetic object fetch receipt", error: false };
  }));
  const args = validateToolArguments(tool, { type: "toolCall", name: "git", id: "fixture", arguments: { op: "fetch_revision", revision: "a".repeat(40) } });
  const result = await tool.execute("fixture", args);
  expect(fetched).toBe("a".repeat(40));
  expect(result.details.error).toBe(false);
});

test("Given an unrelated plugin union, the same registration projects all fields without guessing tool names", () => {
  const original = { name: "example", parameters: Type.Union([
    Type.Object({ kind: Type.Literal("read"), path: Type.String() }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("write"), path: Type.String(), body: Type.String() }, { additionalProperties: false }),
  ]), execute: async () => ({ content: [] }) } as unknown as AgentTool;
  const tool = admitted(original), wire = JSON.parse(JSON.stringify(tool.parameters));
  expect(wire.type).toBe("object");
  expect(Object.keys(wire.properties).sort()).toEqual(["body", "kind", "path"]);
  expect(wire.required).toEqual(["kind", "path"]);
  expect(valid(tool, { kind: "read", path: "a", body: "forbidden" }).ok).toBe(false);
  expect(valid(tool, { kind: "write", path: "a" }).ok).toBe(false);
});

test("Given an existing object tool, registration preserves its identity and reversible disposal", () => {
  const original = { name: "example", parameters: Type.Object({ path: Type.String() }), execute: async () => ({ content: [] }) } as unknown as AgentTool;
  const registry = createToolContributionRegistry(), dispose = registry.register("fixture", original);
  expect(registry.list()[0]).toBe(original);
  dispose(); expect(registry.list()).toEqual([]);
});

test("Given open object branches, projection does not add a closed-object restriction", () => {
  const original = { name: "open", parameters: Type.Union([
    Type.Object({ kind: Type.Literal("read") }),
    Type.Object({ kind: Type.Literal("write"), body: Type.String() }),
  ]), execute: async () => ({ content: [] }) } as unknown as AgentTool;
  const tool = admitted(original);
  expect(tool.parameters).not.toHaveProperty("additionalProperties");
  const args = { kind: "read", extra: 1 };
  expect(valid(tool, args)).toEqual(valid(original, args));
  expect(valid(tool, args).ok).toBe(true);
});

test("Given mixed scalar/object branches, registration leaves the contract unchanged", () => {
  const original = { name: "mixed", parameters: Type.Union([Type.String(), Type.Object({ value: Type.String() })]), execute: async () => ({ content: [] }) } as unknown as AgentTool;
  expect(admitted(original)).toBe(original);
});

for (const [route, id] of [["glm", "glm-5.3-flash"], ["claude", "claude-opus-5-5"]]) {
  test(`Given a registered Git union, the actual ${route} encoder exposes op and revision fields`, async () => {
    let payload: any;
    const stream = createHostedModels({ env: {} }).streamSimple(gatewayModel(route!, id!)!, {
      messages: [{ role: "user", content: "Synthetic encoding fixture", timestamp: 0 }],
      tools: [admitted(createGitTool(bash))],
    }, {
      apiKey: "non-secret-tool-schema-fixture", maxRetries: 0, maxTokens: 64,
      onPayload(body) { payload = body; },
      fetch: Object.assign(async () => new Response(JSON.stringify({ error: { message: "Fixture capture, no inference" } }), { status: 400, headers: { "content-type": "application/json" } }), { preconnect() {} }),
    });
    await stream.result();
    const schema = route === "claude" ? payload.tools[0].input_schema : payload.tools[0].function.parameters;
    expect(schema.type).toBe("object");
    expect(schema.properties.op).toBeDefined();
    expect(schema.properties.revision.pattern).toBe("^[a-f0-9]{40}$");
    expect(schema.required).toEqual(["op"]);
  });
}
