/**
 * Hand-written golden wire fixtures for the Dokkabi workbench protocol v1.
 *
 * These pin the exact request/response encoding agreed with the harness
 * gateway. They are deliberately hand-authored so a drift in EITHER
 * direction shows up against `dokkabi-real-gateway.fixture.json` (a capture
 * of a real gateway session) — the two must stay decodable by the same
 * closed schemas.
 *
 * @module provider/dokkabi/WorkbenchProtocol.testFixtures
 */

export const goldenHandshakeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "workbench.handshake",
  params: { version: 1 },
} as const;

export const goldenHandshakeResponse = {
  version: 1,
  workspacePath: "/Users/operator/work/dokkabi-lab",
  sessionId: "live-0123456789",
  capabilities: {
    submit: true,
    cancel: true,
    read: true,
    detach: true,
    attachments: false,
    continuation: false,
    compaction: false,
    rollback: false,
    approvals: false,
    userInput: false,
    modelChange: false,
  },
  route: "glm",
  model: "glm-5.3",
  ready: false,
  reason: "model readiness not probed — the gateway kernel opens at workbench.bind",
  routeSource: "configured",
  kernelOpen: false,
  permissionMode: "bypass",
} as const;

export const goldenBindRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "workbench.bind",
  params: {
    version: 1,
    clientId: "dokkabi-app-main",
    threadId: "thread_7f3a",
    workspacePath: "/Users/operator/work/dokkabi-lab",
  },
} as const;

export const goldenBindResponse = {
  ok: true,
  sessionId: "live-0123456789",
  workspacePath: "/Users/operator/work/dokkabi-lab",
  reconnect: false,
} as const;

export const goldenSessionCursor = {
  sessionId: "live-0123456789",
  seq: 12,
  hash: "a".repeat(64),
  generation: "b".repeat(64),
} as const;

export const goldenGatewayCursor = {
  seq: 5,
  hash: "c".repeat(64),
  generation: "d".repeat(64),
} as const;

export const goldenReadRequest = {
  jsonrpc: "2.0",
  id: 3,
  method: "workbench.read",
  params: {
    version: 1,
    binding: { clientId: "dokkabi-app-main", threadId: "thread_7f3a" },
    sessionCursor: goldenSessionCursor,
    gatewayCursor: goldenGatewayCursor,
  },
} as const;

export const goldenReadResponse = {
  cards: [
    {
      kind: "system",
      seq: 1,
      ts: "2026-10-01T00:00:00.000Z",
      event: "session/open",
      text: "session opened",
    },
    {
      kind: "note",
      seq: 2,
      ts: "2026-10-01T00:00:01.000Z",
      text: "actual recorded folded text",
    },
    {
      kind: "assistant",
      seq: 3,
      ts: "2026-10-01T00:00:02.000Z",
      text: "recorded assistant reply",
    },
    {
      kind: "tool",
      seq: 4,
      ts: "2026-10-01T00:00:03.000Z",
      id: "tool-a",
      tool: "read",
      argHint: "src/main.ts",
      resultText: "recorded result",
      // Actual correlated tool/end source record — the ONLY completion
      // evidence. durationMs stays a measurement.
      completionSeq: 5,
      completionHash: "e".repeat(64),
      durationMs: 42,
      error: false,
    },
    {
      kind: "tool",
      seq: 6,
      ts: "2026-10-01T00:00:04.000Z",
      id: "tool-b",
      tool: "bash",
      // No completion refs: tool/end has not been recorded — the item stays
      // running however long it has been open.
      durationMs: "missing",
      error: false,
    },
    {
      kind: "approval",
      seq: 7,
      ts: "2026-10-01T00:00:05.000Z",
      requestId: "req-1",
      approvalKind: "permission",
      state: "resolved",
    },
  ],
  state: { busy: false, activeCommandId: null },
  commands: [
    {
      commandId: "cmd-1",
      state: "settled",
      outcome: "success",
      // Source ranges are retained in EVERY derived state (the clarified
      // contract), so a full recovery snapshot can still attribute
      // historical cards to their real command.
      sources: {
        turnStart: 3,
        acceptance: 5,
        settlement: 9,
        settlementSource: "session/chat_turn_settled",
      },
      messageSeq: 2,
      messageHash: "a".repeat(64),
    },
    {
      commandId: "cmd-2",
      state: "accepted",
      detail: "durable model-facing user/message recorded — not provider delivery",
      sources: { acceptance: 8 },
      messageSeq: 2,
      messageHash: "a".repeat(64),
    },
    {
      commandId: "cmd-3",
      state: "handed_off",
      detail: "frontend handoff only — no durable model-facing record yet",
      sources: { handoff: "gateway/submit_receipt" },
    },
    {
      commandId: "cmd-4",
      state: "unknown",
      detail: "intent recorded without provable handoff — reconcile before any retry",
      sources: { intent: "gateway/submit_intent" },
    },
    {
      commandId: "cmd-5",
      state: "rejected",
      detail: "busy",
      sources: { handoff: "gateway/submit_refused" },
    },
  ],
  sessionCursor: goldenSessionCursor,
  gatewayCursor: goldenGatewayCursor,
  resnapshot: false,
} as const;

export const goldenSubmitRequest = {
  jsonrpc: "2.0",
  id: 4,
  method: "workbench.submit",
  params: {
    version: 1,
    binding: { clientId: "dokkabi-app-main", threadId: "thread_7f3a" },
    commandId: "cmd-6",
    text: "operator message text",
  },
} as const;

export const goldenSubmitResponse = {
  commandId: "cmd-6",
  state: "handed_off",
  noteDelivery: "prompt",
  sessionId: "live-0123456789",
} as const;

export const goldenSubmitDuplicateResponse = {
  commandId: "cmd-6",
  duplicate: true,
  state: "settled",
  outcome: "failure",
  sources: { settlementSource: "session/chat_turn_settled" },
} as const;

export const goldenCommandStatusResponse = {
  commandId: "cmd-6",
  state: "settled",
  outcome: "operator_abort",
} as const;

export const goldenCancelRequest = {
  jsonrpc: "2.0",
  id: 5,
  method: "workbench.cancel",
  params: {
    version: 1,
    binding: { clientId: "dokkabi-app-main", threadId: "thread_7f3a" },
    commandId: "cancel-cmd-6",
    targetCommandId: "cmd-6",
  },
} as const;

export const goldenCancelResponse = {
  commandId: "cancel-cmd-6",
  targetCommandId: "cmd-6",
  state: "requested",
} as const;

export const goldenDetachResponse = { detached: true } as const;

export const goldenErrorResponse = {
  jsonrpc: "2.0",
  id: 6,
  error: {
    code: -32603,
    message: "workspace mismatch — the gateway owns /Users/operator/work/dokkabi-lab",
  },
} as const;
