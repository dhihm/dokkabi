// @effect-diagnostics globalTimers:off
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkbenchTransport, type WorkbenchSocket } from "./WorkbenchTransport.ts";
import type { WorkbenchMethod } from "./WorkbenchProtocol.ts";

class BarrierSocket implements WorkbenchSocket {
  readonly frames: Array<{ id: number; method: string }> = [];
  readonly listeners = new Map<string, Array<(event: never) => void>>();
  readonly waiters = new Map<number, () => void>();
  closed = 0;
  send(data: string): void {
    this.frames.push(JSON.parse(data) as { id: number; method: string });
    this.waiters.get(this.frames.length)?.();
    this.waiters.delete(this.frames.length);
  }
  close(): void {
    this.closed += 1;
  }
  addEventListener(event: string, listener: (event: never) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
  reply(id: number, result: unknown): void {
    this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
  sent(count: number): Promise<void> {
    if (this.frames.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(count, resolve));
  }
}
const setup = () => {
  const socket = new BarrierSocket();
  const transport = new WorkbenchTransport({
    url: new URL("ws://127.0.0.1:4174"),
    tokenEnv: "TEST_TOKEN",
    env: { TEST_TOKEN: "fixture" },
    socketFactory: () => {
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  return { socket, transport };
};
const binding = { clientId: "fairness-client", threadId: "fairness-thread" };

describe("explicit background transcript read interruption", () => {
  it.each([
    ["workbench.read", { version: 1, binding }],
    [
      "workbench.branchSession",
      {
        version: 1,
        binding,
        childId: "child-1",
        method: "workbench.read",
        params: { version: 1, binding },
      },
    ],
    ["workbench.record.index", { version: 1, binding, limit: 10 }],
    [
      "workbench.record.body",
      {
        version: 1,
        binding,
        row: { seq: 1, hash: "a".repeat(64), generation: "a".repeat(64) },
        asOf: { sessionId: "s1", seq: 1, hash: "a".repeat(64), generation: "a".repeat(64) },
        offset: 0,
      },
    ],
    [
      "workbench.graph.explore",
      { version: 1, binding, graphType: "work", query: { mode: "page" } },
    ],
    [
      "workbench.branchSession",
      {
        version: 1,
        binding,
        childId: "child-1",
        method: "workbench.graph.explore",
        params: { version: 1, binding, graphType: "context", query: { mode: "page" } },
      },
    ],
  ] as const)(
    "advances the queue after %s is aborted and ignores its late reply",
    async (method, params) => {
      const { socket, transport } = setup();
      try {
        const controller = new AbortController();
        const read = transport.request(method, params, controller.signal);
        const outcome = read.catch((error: unknown) => error);
        await socket.sent(1);
        const readId = socket.frames[0]!.id;
        const cancel = transport.request("workbench.cancel", {
          version: 1,
          binding,
          commandId: "stop-1",
          targetCommandId: "active-1",
        });
        controller.abort();
        await expect(outcome).resolves.toMatchObject({
          detail: expect.stringContaining("read wait interrupted"),
        });
        await socket.sent(2);
        expect(socket.closed).toBe(0);
        socket.reply(readId, { obsolete: true });
        socket.reply(socket.frames[1]!.id, { current: true });
        await expect(cancel).resolves.toMatchObject({ result: { current: true } });
      } finally {
        transport.close();
      }
    },
  );

  it("never sends an aborted queued read or interrupts a queued write", async () => {
    const { socket, transport } = setup();
    try {
      const first = transport.request("workbench.handshake", { version: 1 });
      await socket.sent(1);
      const controller = new AbortController();
      const read = transport
        .request("workbench.read", { version: 1, binding }, controller.signal)
        .catch((error: unknown) => error);
      const writeController = new AbortController();
      const write = transport.request(
        "workbench.cancel",
        { version: 1, binding, commandId: "stop-2", targetCommandId: "active-2" },
        writeController.signal,
      );
      controller.abort();
      writeController.abort();
      socket.reply(socket.frames[0]!.id, { ready: true });
      await first;
      await expect(read).resolves.toMatchObject({
        detail: expect.stringContaining("read wait interrupted"),
      });
      await socket.sent(2);
      expect(socket.frames.map((frame) => frame.method)).toEqual([
        "workbench.handshake",
        "workbench.cancel",
      ]);
      socket.reply(socket.frames[1]!.id, { recorded: true });
      await expect(write).resolves.toMatchObject({ result: { recorded: true } });
    } finally {
      transport.close();
    }
  });

  it("preserves uncertain write outcomes on genuine connection loss", async () => {
    const { socket, transport } = setup();
    try {
      const controller = new AbortController();
      const write = transport.request(
        "workbench.cancel" satisfies WorkbenchMethod,
        { version: 1, binding, commandId: "stop-3", targetCommandId: "active-3" },
        controller.signal,
      );
      const outcome = write.catch((error: unknown) => error);
      await socket.sent(1);
      controller.abort();
      socket.emit("close", { code: 1006 });
      await expect(outcome).resolves.toMatchObject({
        detail: expect.stringContaining("reconcile with workbench.commandStatus"),
      });
      expect(socket.frames).toHaveLength(1);
    } finally {
      transport.close();
    }
  });
});

/** The three pure bounded explorer reads, direct and inside a child envelope. */
const explorerParams = {
  "workbench.record.index": { version: 1, binding, limit: 10 },
  "workbench.record.body": {
    version: 1,
    binding,
    row: { seq: 1, hash: "a".repeat(64), generation: "a".repeat(64) },
    asOf: { sessionId: "s1", seq: 1, hash: "a".repeat(64), generation: "a".repeat(64) },
    offset: 0,
  },
  "workbench.graph.explore": {
    version: 1,
    binding,
    graphType: "work",
    query: { mode: "neighbors", nodeId: "goal:root", limit: 2 },
  },
} as const;
const explorerReads: ReadonlyArray<readonly [string, WorkbenchMethod, unknown]> = Object.entries(
  explorerParams,
).flatMap(([method, params]) => [
  [method, method as WorkbenchMethod, params] as const,
  [
    `routed ${method}`,
    "workbench.branchSession" as WorkbenchMethod,
    { version: 1, binding, childId: "child-1", method, params },
  ] as const,
]);

/** An AbortSignal that reports how many abort listeners are still attached. */
const countedSignal = () => {
  const controller = new AbortController();
  let attached = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((type: string, listener: never, options?: never) => {
    if (type === "abort") attached += 1;
    add(type, listener, options);
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener = ((type: string, listener: never, options?: never) => {
    if (type === "abort") attached -= 1;
    remove(type, listener, options);
  }) as typeof controller.signal.removeEventListener;
  return { controller, attached: () => attached };
};

const pendingCount = (transport: WorkbenchTransport): number =>
  (transport as unknown as { pending: Map<number, unknown> }).pending.size;

describe("disposable bounded explorer read cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(explorerReads)(
    "a queued aborted %s is never sent and the queued write keeps its order",
    async (_label, method, params) => {
      const { socket, transport } = setup();
      try {
        const first = transport.request("workbench.submit", {
          version: 1,
          binding,
          commandId: "held-submit",
          text: "task",
        });
        await socket.sent(1);
        const { controller, attached } = countedSignal();
        const read = transport.request(method, params, controller.signal).catch((error) => error);
        const write = transport.request("workbench.cancel", {
          version: 1,
          binding,
          commandId: "stop-q",
          targetCommandId: "active-q",
        });
        const detach = transport.request("workbench.detach", { version: 1, binding });
        controller.abort();
        await expect(read).resolves.toMatchObject({
          detail: expect.stringContaining("read wait interrupted"),
        });
        expect(attached()).toBe(0);
        expect(socket.frames.map((frame) => frame.method)).toEqual(["workbench.submit"]);
        socket.reply(socket.frames[0]!.id, { ready: true });
        await first;
        await socket.sent(2);
        expect(socket.frames.map((frame) => frame.method)).toEqual([
          "workbench.submit",
          "workbench.cancel",
        ]);
        socket.reply(socket.frames[1]!.id, { recorded: true });
        await expect(write).resolves.toMatchObject({ result: { recorded: true } });
        await socket.sent(3);
        expect(socket.frames.map((frame) => frame.method)).toEqual([
          "workbench.submit",
          "workbench.cancel",
          "workbench.detach",
        ]);
        socket.reply(socket.frames[2]!.id, { detached: true });
        await expect(detach).resolves.toMatchObject({ result: { detached: true } });
      } finally {
        transport.close();
      }
    },
    2_000,
  );

  it.each(explorerReads)(
    "an active aborted %s releases its timer, listener and slot and ignores the late reply",
    async (_label, method, params) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { socket, transport } = setup();
      try {
        const { controller, attached } = countedSignal();
        const read = transport.request(method, params, controller.signal).catch((error) => error);
        await vi.waitFor(() => expect(socket.frames).toHaveLength(1));
        const readId = socket.frames[0]!.id;
        expect(pendingCount(transport)).toBe(1);
        expect(attached()).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
        controller.abort();
        await expect(read).resolves.toMatchObject({
          detail: expect.stringContaining("read wait interrupted"),
        });
        expect(pendingCount(transport)).toBe(0);
        expect(attached()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        // The slot is free: the next disposable read is sent immediately.
        const next = transport.request(method, params);
        await vi.waitFor(() => expect(socket.frames).toHaveLength(2));
        socket.reply(readId, { obsolete: true });
        socket.reply(socket.frames[1]!.id, { current: true });
        await expect(next).resolves.toMatchObject({ result: { current: true } });
        expect(socket.closed).toBe(0);
        expect(socket.frames.map((frame) => frame.method)).toEqual([method, method]);
      } finally {
        transport.close();
      }
    },
    2_000,
  );

  it("an interrupted caller of a write never cancels or resends it", async () => {
    const { socket, transport } = setup();
    try {
      const controller = new AbortController();
      const write = transport.request(
        "workbench.cancel",
        { version: 1, binding, commandId: "stop-w", targetCommandId: "active-w" },
        controller.signal,
      );
      await socket.sent(1);
      controller.abort();
      const read = transport.request(
        "workbench.record.index",
        explorerParams["workbench.record.index"],
      );
      socket.reply(socket.frames[0]!.id, { recorded: true });
      await expect(write).resolves.toMatchObject({ result: { recorded: true } });
      await socket.sent(2);
      socket.reply(socket.frames[1]!.id, { indexed: true });
      await expect(read).resolves.toMatchObject({ result: { indexed: true } });
      expect(socket.frames.map((frame) => frame.method)).toEqual([
        "workbench.cancel",
        "workbench.record.index",
      ]);
    } finally {
      transport.close();
    }
  });
});
