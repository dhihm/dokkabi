import { expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { workbenchParamsSchemas, STRICT_DECODE_OPTIONS } from "./WorkbenchProtocol.ts";
test("registers the explicit revision-bound code resume action", () => {
  const schema = (workbenchParamsSchemas as Record<string, Schema.Codec<any, any>>)[
    "workbench.codeAction"
  ];
  expect(schema).toBeDefined();
  expect(
    Schema.decodeUnknownSync(
      schema!,
      STRICT_DECODE_OPTIONS,
    )({
      version: 1,
      binding: { clientId: "client", threadId: "thread" },
      operation: "resume",
      commandId: "resume-1",
      expectedRevision: 7,
      newWindow: false,
    }),
  ).toMatchObject({ expectedRevision: 7, newWindow: false });
});
test("refuses unknown authority, malformed resume inputs and fabricated applied receipts", async () => {
  const { CodeActionParams, CodeActionResponse } = await import("./WorkbenchProtocol.ts");
  const params = {
    version: 1,
    binding: { clientId: "client", threadId: "thread" },
    operation: "resume",
    commandId: "resume-1",
    expectedRevision: 7,
    newWindow: false,
  };
  const decode = Schema.decodeUnknownSync(CodeActionParams, STRICT_DECODE_OPTIONS);
  expect(decode({ ...params, newWindow: undefined }).newWindow).toBeUndefined();
  for (const extra of [
    { sessionId: "unowned" },
    { root: "/source" },
    { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { commandId: "id.with.dot" },
    { newWindow: "true" },
    { operation: "capture" },
  ])
    expect(() => decode({ ...params, ...extra })).toThrow();
  const response = Schema.decodeUnknownSync(CodeActionResponse, STRICT_DECODE_OPTIONS);
  for (const state of ["unsupported", "unavailable", "busy", "conflict", "unknown"])
    expect(response({ version: 1, state, reason: "bounded refusal" }).state).toBe(state);
  expect(() =>
    response({
      version: 1,
      state: "applied",
      observer: { state: "off", paths: 0, checks: 0, policyDigest: null, reason: null },
      receipt: { commandId: "resume-1", seq: 8, hash: "a".repeat(64) },
    }),
  ).toThrow();
});
