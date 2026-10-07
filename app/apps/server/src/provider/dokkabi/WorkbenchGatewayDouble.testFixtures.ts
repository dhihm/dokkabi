// @effect-diagnostics globalTimers:off
/**
 * In-process gateway double implementing the SUBSET of the canonical
 * workbench.* semantics the adapter tests exercise: strict binding
 * ownership, durable submit dedup (same id + different payload ALWAYS
 * conflicts), cursor-mismatch resnapshot, active-only cancellation with
 * settlement records, tool-card completion refs, and a controllable
 * delayed-read seam for fetch/apply race regressions.
 *
 * Test fixture only — never imported by production code.
 *
 * @module provider/dokkabi/WorkbenchGatewayDouble.testFixtures
 */
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";

import type { WorkbenchSocket } from "./WorkbenchTransport.ts";
import type { WorkbenchCard, WorkbenchCommandState } from "./WorkbenchProtocol.ts";

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

/** An empty recorded overview: ordinary chat with no plan, no graph rows and
 * no usage — everything explicit, nothing faked. */
export const emptyOverview = (): Record<string, unknown> => ({
  work: { state: "missing", goal: null, planDigest: null, todos: [], cases: null, errors: [] },
  context: {
    state: "missing",
    mode: null,
    revision: null,
    digest: null,
    frame: null,
    lessonCount: null,
    errors: [],
  },
  usage: {
    records: 0,
    input: { total: null, missing: 0, latestSource: null },
    output: { total: null, missing: 0, latestSource: null },
    reasoning: { total: null, missing: 0, latestSource: null },
    cacheRead: { total: null, missing: 0, latestSource: null },
    cacheWrite: { total: null, missing: 0, latestSource: null },
  },
});

/** An empty recorded graph: ordinary chat with no plan, no graph rows —
 * everything explicit, nothing faked. */
export const emptyGraph = (graphType: "work" | "context"): Record<string, unknown> => ({
  resnapshot: true,
  graph: {
    state: "missing",
    mode: null,
    revision: null,
    digest: null,
    nodes: [],
    edges: [],
    waves: [],
    unscheduled: [],
    coverage: {
      status: "complete",
      totalNodes: 0,
      totalEdges: 0,
      omittedNodes: 0,
      omittedEdges: 0,
    },
    errors: [],
    ...(graphType === "work" ? {} : { mode: null }),
  },
});

/** Base recorded timestamp for deterministic fixtures. */
export const GATEWAY_DOUBLE_TS = "2026-01-01T00:00:00.000Z";

/**
 * Distinct deterministic recorded time per source seq — mirrors the real
 * gateway's lifecycle refs pairing each recorded row's seq with its own ts
 * (docs "Recorded replay identity and time"). One second per seq keeps the
 * values readable and strictly increasing in event order.
 */
export const gatewayDoubleTsForSeq = (seq: number): string =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(GATEWAY_DOUBLE_TS), { seconds: seq }));

export class FakeSocket {
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  closed = 0;
  readonly gateway: FakeGateway;

  constructor(gateway: FakeGateway) {
    this.gateway = gateway;
  }

  addEventListener(event: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { id: number; method: string; params: unknown };
    this.gateway.dispatch(frame.method, frame.params, this, frame.id);
  }

  close(): void {
    this.closed += 1;
  }

  emit(event: string, detail?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(detail);
    }
  }

  reply(id: number, body: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, ...body }) });
  }

  drop(): void {
    this.emit("close", { code: 1006 });
  }
}

export interface FakeCommand {
  commandId: string;
  fingerprint?: string;
  state: WorkbenchCommandState;
  outcome?: "success" | "failure" | "operator_abort";
  detail?: string;
  sources: Record<string, number | string>;
  messageSeq?: number;
  messageHash?: string;
}

export type FakeSubmitMode = "handed_off" | "staged" | "rejected" | "drop" | "drop-unknown";

export class FakeGateway {
  workspacePath = "/tmp/dokkabi-fake-workspace";
  sessionId = "live-fake01";
  permissionMode: "ask" | "auto" | "bypass" = "bypass";
  route = "glm";
  model: string | undefined = "glm-5.3";
  ready = false;
  reason = "model readiness not probed — the gateway kernel opens at workbench.bind";
  routeSource: "configured" | "kernel" = "configured";
  kernelOpen = false;
  modelCatalog?: Array<{
    route: string;
    provider: string;
    model: string;
    name: string;
    connected: boolean;
  }>;
  modelSelectionState: "applied" | "busy" | "confirmation_required" = "applied";
  modelSelectionFault?: "drop" | "wrong-receipt" | "unchanged-identity";
  binding: { clientId: string; threadId: string } | undefined;
  readonly cards: WorkbenchCard[] = [];
  readonly commands = new Map<string, FakeCommand>();
  activeCommandId: string | undefined;
  busy = false;
  submitMode: FakeSubmitMode = "handed_off";
  cancelMode: "requested" | "unknown" = "requested";
  autoSettleOnCancel = true;
  /** When set, lifecycle sources carry their seqs WITHOUT the paired
   * recorded times — a gateway that violates the seq/time pairing contract,
   * which the adapter must refuse rather than invent times for. */
  omitLifecycleSourceTimes = false;
  /** Generation identity of the session log; flipping it simulates a
   * replaced log, which must force a visible resnapshot. */
  sessionGeneration = hex64("generation-1");
  /** When set, the NEXT workbench.read replies AFTER this delay with the
   * snapshot captured at arm time — a fetch/apply race regression seam. */
  delayNextReadMs: number | undefined;
  pendingDelayedReads = 0;
  private seqCounter = 200;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly sockets: FakeSocket[] = [];

  readonly createSocket = (): WorkbenchSocket => {
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket as unknown as WorkbenchSocket;
  };

  private nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** Same-generation truncation: drop records beyond seq and rewind the
   * head — the client's prior cursor becomes invalid while the generation
   * identity still matches (a truncated/rolled-back source). */
  readonly truncateToSeq = (seq: number): void => {
    this.seqCounter = seq;
    for (let index = this.cards.length - 1; index >= 0; index -= 1) {
      if (this.cards[index]!.seq > seq) {
        this.cards.splice(index, 1);
      }
    }
  };

  /** Flip the session-log generation identity (simulates a replaced log). */
  readonly flipGeneration = (seed: string): string => {
    this.sessionGeneration = hex64(seed);
    return this.sessionGeneration;
  };

  // --- R3 recorded overview state (workbench.overview) ---

  /** Summary payload the next overview returns; tests shape this directly. */
  overview: Record<string, unknown> = emptyOverview();

  /** When set, overrides the computed resnapshot flag — a gateway that claims
   * continuity the cursors do not support, which the adapter must refuse. */
  forceOverviewResnapshot: boolean | undefined;

  /** False simulates a pre-R3 gateway without the additive overview method. */
  supportOverview = true;

  readonly setOverview = (overview: Record<string, unknown>): void => {
    this.overview = overview;
  };

  private readonly overviewResult = (): Record<string, unknown> => ({
    version: 1,
    sessionCursor: {
      sessionId: this.sessionId,
      seq: this.seqCounter,
      hash: hex64(`session-${this.sessionGeneration}-${this.seqCounter}`),
      generation: this.sessionGeneration,
    },
    gatewayCursor: {
      seq: 1,
      hash: hex64("gateway-1"),
      generation: hex64("gateway-generation"),
    },
    ...this.overview,
  });

  // --- R8 scoped run usage state (workbench.usage) ---

  /** The `usage` report payload the next usage read returns, when set. */
  usage: Record<string, unknown> | undefined;

  /** When set, overrides the usage envelope's cursors — a gateway answering
   * the probe from a foreign/replaced/rewound source head. */
  readonly usageEnvelope: {
    sessionCursor?: Record<string, unknown>;
    gatewayCursor?: Record<string, unknown>;
  } = {};

  /** False simulates a pre-R8 gateway without the additive usage method. */
  supportUsage = true;

  readonly setUsage = (usage: Record<string, unknown>): void => {
    this.usage = usage;
  };

  /** The double's current verified session head, for building reports. */
  readonly sessionHeadRef = (): { seq: number; hash: string } => ({
    seq: this.seqCounter,
    hash: hex64(`session-${this.sessionGeneration}-${this.seqCounter}`),
  });

  /** The double's current gateway ledger head, for building reports. */
  readonly gatewayHeadRef = (): { seq: number; hash: string; generation: string } => ({
    seq: 1,
    hash: hex64("gateway-1"),
    generation: hex64("gateway-generation"),
  });

  /** The honest empty report: one main scope, nothing measured, no children. */
  readonly defaultUsageReport = (): Record<string, unknown> => ({
    state: "complete",
    main: {
      sessionId: this.sessionId,
      head: this.sessionHeadRef(),
      settled: true,
      counts: { requests: 0, sends: 0, completedUsage: 0 },
      usage: {
        records: 0,
        input: { total: null, missing: 0, latestSource: null },
        output: { total: null, missing: 0, latestSource: null },
        reasoning: { total: null, missing: 0, latestSource: null },
        cacheRead: { total: null, missing: 0, latestSource: null },
        cacheWrite: { total: null, missing: 0, latestSource: null },
      },
    },
    scopes: [],
    aggregate: {
      scopesCounted: 1,
      counts: { requests: 0, sends: 0, completedUsage: 0 },
      input: { total: null, missing: 0 },
      output: { total: null, missing: 0 },
      reasoning: { total: null, missing: 0 },
      cacheRead: { total: null, missing: 0 },
      cacheWrite: { total: null, missing: 0 },
    },
    semantics: {
      totals: "recorded_usage_not_billing",
      reasoning: "included_in_output_total",
      cacheRead: "separate_from_input_total",
      cacheWrite: "separate_from_input_total",
    },
    details: [],
    errors: [],
  });

  readonly usageResult = (): Record<string, unknown> => ({
    version: 1,
    sessionCursor: this.usageEnvelope.sessionCursor ?? {
      sessionId: this.sessionId,
      ...this.sessionHeadRef(),
      generation: this.sessionGeneration,
    },
    gatewayCursor: this.usageEnvelope.gatewayCursor ?? this.gatewayHeadRef(),
    resnapshot: false,
    usage: this.usage ?? this.defaultUsageReport(),
  });

  // --- R4 recorded graph state (workbench.graph) ---

  /** Graph payloads the next graph reads return, keyed by graph type. */
  readonly graphs: Record<string, Record<string, unknown>> = {
    work: emptyGraph("work"),
    context: emptyGraph("context"),
  };

  /** False simulates a pre-R4 gateway without the additive graph method. */
  supportGraph = true;
  codeResponse: Record<string, unknown> | undefined;

  readonly setGraph = (graphType: "work" | "context", graph: Record<string, unknown>): void => {
    this.graphs[graphType] = graph;
  };

  // --- R5 exact retained record state (workbench.record) ---

  /** When set, the next record read returns EXACTLY this payload — tests
   * shape whole pages (including forged ones) directly. */
  recordResult: Record<string, unknown> | undefined;

  /** False simulates a pre-R5 gateway without the additive record method. */
  supportRecord = true;

  // --- Bounded explorer (workbench.record.index/body, workbench.graph.explore) ---

  /** Per-method responders; an absent responder answers method-not-found. A
   * responder that throws answers a gateway error with its message. */
  readonly explorer: {
    index?: ((params: Record<string, unknown>) => unknown) | undefined;
    body?: ((params: Record<string, unknown>) => unknown) | undefined;
    graph?: ((params: Record<string, unknown>) => unknown) | undefined;
  } = {};
  /** False simulates an older gateway without the explorer methods. */
  supportExplorer = true;

  // --- R8-06j2 explicit session work mode state (workbench.workMode) ---

  /** The kernel standing default handed to the chat turn router. */
  workModeStanding: "chat" | "work" = "chat";
  /** This session's control-file override; undefined means no control file. */
  workModeOverride: "chat" | "work" | undefined;
  /** False simulates a pre-R8-06j2 gateway without the additive method (and
   * without the advertised handshake capability). */
  supportWorkMode = true;
  /** Host busy gate: unresolved work refuses the mutation. */
  workModeRefuseBusy = false;
  /** Apply the effect, then lose the socket before the response arrives. */
  dropNextWorkModeSet = false;
  /** Record the durable intent, then crash: no file effect, no receipt. */
  crashNextWorkModeSet = false;
  /** The durable intent append fails: zero file effects, honest unknown. */
  failNextWorkModeIntent = false;
  /** Applied control-file writes (intent → effect), for no-write assertions. */
  workModeWrites = 0;
  /** Recorded mode commands: id → fingerprint/owner/payload/receipt. */
  readonly workModeCommands = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly owner: { clientId: string; threadId: string };
      readonly mode: "default" | "chat" | "work";
      readonly expectedRevision: string;
      readonly settled: boolean;
      readonly selection: Record<string, unknown>;
    }
  >();

  /** Opaque revision over the control file's exact state and the standing
   * default — deterministic per (standing, override) like the host's digest. */
  readonly workModeRevision = (): string =>
    hex64(`workmode:${this.workModeStanding}:${this.workModeOverride ?? "absent"}`);

  /** The exact selection snapshot a read or applied receipt carries. */
  readonly workModeSelection = (): Record<string, unknown> => ({
    mode: this.workModeOverride ?? "default",
    effective: this.workModeOverride ?? this.workModeStanding,
    source: this.workModeOverride === undefined ? "default" : "session",
    revision: this.workModeRevision(),
  });

  readonly setRecordResult = (result: Record<string, unknown>): void => {
    this.recordResult = result;
  };

  /** The default record body: an honest unavailable page (no rows claimed,
   * both heads reported, the live head pinned as asOf). */
  private readonly defaultRecordResult = (): Record<string, unknown> => ({
    version: 1,
    state: "unavailable",
    reason: "no retained rows are served by this double",
    sessionCursor: {
      sessionId: this.sessionId,
      seq: this.seqCounter,
      hash: hex64(`session-${this.sessionGeneration}-${this.seqCounter}`),
      generation: this.sessionGeneration,
    },
    gatewayCursor: {
      seq: 1,
      hash: hex64("gateway-1"),
      generation: hex64("gateway-generation"),
    },
    asOf: {
      sessionId: this.sessionId,
      seq: this.seqCounter,
      hash: hex64(`session-${this.sessionGeneration}-${this.seqCounter}`),
      generation: this.sessionGeneration,
    },
    records: [],
    next: null,
    total: this.seqCounter,
    hasMore: false,
    decisions: { status: "unsupported", reason: "no decision authority in this double" },
  });

  private readonly graphResult = (graphType: string): Record<string, unknown> => ({
    version: 1,
    graphType,
    sessionCursor: {
      sessionId: this.sessionId,
      seq: this.seqCounter,
      hash: hex64(`session-${this.sessionGeneration}-${this.seqCounter}`),
      generation: this.sessionGeneration,
    },
    gatewayCursor: {
      seq: 1,
      hash: hex64("gateway-1"),
      generation: hex64("gateway-generation"),
    },
    ...this.graphs[graphType]!,
  });

  requestsFor(method: string): ReadonlyArray<Record<string, unknown>> {
    return this.requests
      .filter((request) => request.method === method)
      .map((request) => request.params as Record<string, unknown>);
  }

  // --- test-side builders simulating recorded kernel output ---

  /** Lifecycle source refs pairing the row's seq with its recorded time —
   * exactly the pairing the real gateway contract guarantees. */
  private readonly lifecycleSourceRefs = (
    seqKey: string,
    seq: number,
  ): Record<string, number | string> =>
    this.omitLifecycleSourceTimes
      ? { [seqKey]: seq }
      : { [seqKey]: seq, [`${seqKey}At`]: gatewayDoubleTsForSeq(seq) };

  addAssistantCard(text: string): number {
    const seq = this.nextSeq();
    this.cards.push({ kind: "assistant", seq, ts: gatewayDoubleTsForSeq(seq), text });
    return seq;
  }

  addSystemCard(event: string, text: string): void {
    const seq = this.nextSeq();
    this.cards.push({ kind: "system", seq, ts: gatewayDoubleTsForSeq(seq), event, text });
  }

  addToolCard(input: {
    id: string;
    tool: string;
    resultText?: string;
    completion?: { seq: number; hash: string };
    error?: boolean;
  }): number {
    const seq = this.nextSeq();
    this.cards.push({
      kind: "tool",
      seq,
      ts: gatewayDoubleTsForSeq(seq),
      id: input.id,
      tool: input.tool,
      ...(input.resultText !== undefined ? { resultText: input.resultText } : {}),
      ...(input.completion !== undefined
        ? { completionSeq: input.completion.seq, completionHash: input.completion.hash }
        : {}),
      durationMs: "missing",
      error: input.error ?? false,
    });
    return seq;
  }

  /** Late tool/end for an already-recorded card — the gateway enriches the
   * card with the correlated end refs (exactly what the real gateway does). */
  completeToolCard(seq: number, error = false): void {
    const card = this.cards.find((entry) => entry.seq === seq);
    if (card === undefined || card.kind !== "tool") {
      throw new Error(`no tool card ${seq}`);
    }
    const endSeq = this.nextSeq();
    const index = this.cards.indexOf(card);
    this.cards[index] = {
      ...card,
      completionSeq: endSeq,
      completionHash: hex64(`end-${seq}-${endSeq}`),
      error,
    };
  }

  settle(commandId: string, outcome: "success" | "failure" | "operator_abort"): void {
    const command = this.commands.get(commandId);
    if (command === undefined) throw new Error(`unknown command ${commandId}`);
    const settlement = this.nextSeq();
    command.state = "settled";
    command.outcome = outcome;
    command.sources = {
      ...command.sources,
      ...this.lifecycleSourceRefs("settlement", settlement),
    };
    this.activeCommandId = undefined;
  }

  // --- gateway dispatch ---

  private readonly identity = () => ({
    version: 1,
    workspacePath: this.workspacePath,
    sessionId: this.sessionId,
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
      modelChange: this.modelCatalog !== undefined,
      ...(this.supportWorkMode ? { workMode: true } : {}),
    },
    route: this.route,
    ...(this.modelCatalog !== undefined ? { models: this.modelCatalog } : {}),
    ...(this.model !== undefined ? { model: this.model } : {}),
    ready: this.ready,
    reason: this.reason,
    routeSource: this.routeSource,
    kernelOpen: this.kernelOpen,
    permissionMode: this.permissionMode,
    ...(this.binding !== undefined ? { bound: this.binding } : {}),
  });

  private readonly handedOffReceipt = (
    commandId: string,
    fingerprint: string,
    text: string,
  ): Record<string, unknown> => {
    const turnStart = this.nextSeq();
    const messageSeq = this.nextSeq();
    this.cards.push({ kind: "note", seq: messageSeq, ts: gatewayDoubleTsForSeq(messageSeq), text });
    this.commands.set(commandId, {
      commandId,
      fingerprint,
      state: "handed_off",
      sources: this.lifecycleSourceRefs("turnStart", turnStart),
      messageSeq,
      messageHash: hex64(`message-${messageSeq}`),
    });
    this.activeCommandId = commandId;
    return { commandId, state: "handed_off", noteDelivery: "prompt", sessionId: this.sessionId };
  };

  private readonly readResult = () => ({
    cards: [...this.cards],
    state: { busy: this.busy, activeCommandId: this.activeCommandId ?? null },
    commands: [...this.commands.values()].map((command) => ({
      commandId: command.commandId,
      state: command.state,
      ...(command.outcome !== undefined ? { outcome: command.outcome } : {}),
      ...(command.detail !== undefined ? { detail: command.detail } : {}),
      sources: command.sources,
      ...(command.messageSeq !== undefined
        ? { messageSeq: command.messageSeq, messageHash: command.messageHash }
        : {}),
    })),
    sessionCursor: {
      sessionId: this.sessionId,
      seq: this.seqCounter,
      hash: hex64(`session-${this.sessionGeneration}-${this.seqCounter}`),
      generation: this.sessionGeneration,
    },
    gatewayCursor: {
      seq: 1,
      hash: hex64("gateway-1"),
      generation: hex64("gateway-generation"),
    },
    resnapshot: false,
  });

  dispatch(method: string, params: unknown, socket: FakeSocket, requestId: number): void {
    this.requests.push({ method, params });
    const record = params as Record<string, unknown>;
    switch (method) {
      case "workbench.handshake":
        socket.reply(requestId, { result: this.identity() });
        return;
      case "workbench.model": {
        if (this.modelSelectionState !== "applied") {
          socket.reply(requestId, {
            result: {
              version: 1,
              state: this.modelSelectionState,
              reason: "Selection is not applied.",
            },
          });
          return;
        }
        if (
          record.expectedRoute !== this.route ||
          record.expectedModel !== this.model ||
          !this.binding
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "Selection identity changed or unbound" },
          });
          return;
        }
        if (this.modelSelectionFault !== "unchanged-identity") {
          this.route = String(record.route);
          this.model = String(record.model);
        }
        if (this.modelSelectionFault === "drop") {
          socket.drop();
          return;
        }
        socket.reply(requestId, {
          result: {
            version: 1,
            state: "applied",
            route: this.modelSelectionFault === "wrong-receipt" ? "glm" : String(record.route),
            model: String(record.model),
          },
        });
        return;
      }
      case "workbench.bind": {
        if (record.workspacePath !== this.workspacePath) {
          socket.reply(requestId, {
            error: {
              code: -32603,
              message: `workspace mismatch — the gateway owns ${this.workspacePath}`,
            },
          });
          return;
        }
        if (
          this.binding !== undefined &&
          (this.binding.clientId !== record.clientId || this.binding.threadId !== record.threadId)
        ) {
          socket.reply(requestId, {
            error: {
              code: -32603,
              message: "binding mismatch — this gateway is bound to another client/thread",
            },
          });
          return;
        }
        this.binding = { clientId: String(record.clientId), threadId: String(record.threadId) };
        socket.reply(requestId, {
          result: {
            ok: true,
            sessionId: this.sessionId,
            workspacePath: this.workspacePath,
            reconnect: false,
          },
        });
        return;
      }
      case "workbench.read": {
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        const cursor = record.sessionCursor as { seq?: number; generation?: string } | undefined;
        const resnapshot =
          cursor === undefined ||
          cursor.generation !== this.sessionGeneration ||
          (cursor.seq ?? 0) > this.seqCounter;
        if (this.delayNextReadMs !== undefined) {
          // Race seam: the reply (built from CURRENT state at fire time)
          // arrives late, after the client may have applied newer reads.
          const delayMs = this.delayNextReadMs;
          this.delayNextReadMs = undefined;
          this.pendingDelayedReads += 1;
          const result = { ...this.readResult(), resnapshot };
          setTimeout(() => {
            this.pendingDelayedReads -= 1;
            socket.reply(requestId, { result });
          }, delayMs);
          return;
        }
        socket.reply(requestId, { result: { ...this.readResult(), resnapshot } });
        return;
      }
      case "workbench.submit": {
        const commandId = String(record.commandId);
        const text = String(record.text);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(commandId)) {
          socket.reply(requestId, {
            error: { code: -32603, message: `invalid command id ${JSON.stringify(commandId)}` },
          });
          return;
        }
        const fingerprint = hex64(`submit:${commandId}:${text}`);
        const existing = this.commands.get(commandId);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            socket.reply(requestId, {
              error: {
                code: -32603,
                message: `command ${commandId} already exists with a different payload`,
              },
            });
            return;
          }
          socket.reply(requestId, {
            result: {
              commandId,
              duplicate: true,
              state: existing.state,
              ...(existing.outcome !== undefined ? { outcome: existing.outcome } : {}),
              sources: existing.sources,
            },
          });
          return;
        }
        if (this.activeCommandId !== undefined || this.busy) {
          socket.reply(requestId, {
            error: { code: -32603, message: "submit refused: the kernel is busy" },
          });
          return;
        }
        if (this.submitMode === "drop" || this.submitMode === "drop-unknown") {
          if (this.submitMode === "drop") {
            // Effect happened; only the response was lost.
            this.handedOffReceipt(commandId, fingerprint, text);
          }
          socket.drop();
          return;
        }
        if (this.submitMode === "rejected") {
          this.commands.set(commandId, {
            commandId,
            fingerprint,
            state: "rejected",
            detail: "attachments are not supported",
            sources: { handoff: "gateway/submit_refused" },
          });
          socket.reply(requestId, {
            error: { code: -32603, message: "submit refused: attachments are not supported" },
          });
          return;
        }
        if (this.submitMode === "staged") {
          this.commands.set(commandId, {
            commandId,
            fingerprint,
            state: "staged",
            detail: "note staged in the harness operator inbox",
            sources: { staging: "gateway/submit_staged" },
          });
          socket.reply(requestId, {
            result: {
              commandId,
              state: "staged",
              detail: "note staged in the harness operator inbox",
            },
          });
          return;
        }
        socket.reply(requestId, { result: this.handedOffReceipt(commandId, fingerprint, text) });
        return;
      }
      case "workbench.commandStatus": {
        const commandId = String(record.commandId);
        const command = this.commands.get(commandId);
        if (command === undefined) {
          socket.reply(requestId, {
            result: { commandId, state: "unknown", detail: "command not recorded" },
          });
          return;
        }
        socket.reply(requestId, {
          result: {
            commandId,
            state: command.state,
            ...(command.outcome !== undefined ? { outcome: command.outcome } : {}),
            sources: command.sources,
          },
        });
        return;
      }
      case "workbench.cancel": {
        const target = String(record.targetCommandId);
        if (this.activeCommandId !== target) {
          socket.reply(requestId, {
            error: { code: -32603, message: `stale or foreign cancel target ${target}` },
          });
          return;
        }
        if (this.cancelMode === "unknown") {
          socket.reply(requestId, {
            result: {
              commandId: String(record.commandId),
              targetCommandId: target,
              state: "unknown",
              detail: "cancellation intent recorded without a provable effect",
            },
          });
          return;
        }
        if (this.autoSettleOnCancel) {
          this.settle(target, "operator_abort");
        }
        socket.reply(requestId, {
          result: {
            commandId: String(record.commandId),
            targetCommandId: target,
            state: "requested",
          },
        });
        return;
      }
      case "workbench.detach":
        this.binding = undefined;
        socket.reply(requestId, { result: { detached: true } });
        return;
      case "workbench.workMode": {
        if (!this.supportWorkMode) {
          // A pre-R8-06j2 gateway: the additive method simply does not exist.
          socket.reply(requestId, {
            error: { code: -32601, message: "Method not found: workbench.workMode" },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        const operation = String(record.operation);
        if (operation === "read") {
          socket.reply(requestId, {
            result: {
              version: 1,
              state: "available",
              selection: this.workModeSelection(),
              busy: this.workModeRefuseBusy || this.busy || this.activeCommandId !== undefined,
            },
          });
          return;
        }
        if (operation === "status") {
          const commandId = String(record.commandId);
          const known = this.workModeCommands.get(commandId);
          if (known === undefined) {
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "unknown",
                reason: "command not recorded",
                commandId,
              },
            });
            return;
          }
          if (!known.settled) {
            // A durable intent exists but its outcome is unknown — restart or
            // crash window; it is never reapplied to guess an answer.
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "unknown",
                reason: "the recorded mode intent never settled",
                commandId,
              },
            });
            return;
          }
          socket.reply(requestId, {
            result: {
              version: 1,
              state: "applied",
              commandId,
              selection: known.selection,
              duplicate: true,
            },
          });
          return;
        }
        if (operation === "set") {
          const commandId = String(record.commandId);
          const mode = record.mode as "default" | "chat" | "work";
          const expectedRevision = String(record.expectedRevision);
          const fingerprint = hex64(`workmode:${commandId}:${mode}:${expectedRevision}`);
          const existing = this.workModeCommands.get(commandId);
          if (existing !== undefined) {
            if (
              existing.fingerprint !== fingerprint ||
              existing.owner.clientId !== binding.clientId ||
              existing.owner.threadId !== binding.threadId
            ) {
              socket.reply(requestId, {
                result: {
                  version: 1,
                  state: "conflict",
                  reason: `command ${commandId} already exists with a different payload or owner`,
                  commandId,
                },
              });
              return;
            }
            if (!existing.settled) {
              socket.reply(requestId, {
                result: {
                  version: 1,
                  state: "unknown",
                  reason: "the recorded mode intent never settled",
                  commandId,
                },
              });
              return;
            }
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "applied",
                commandId,
                selection: existing.selection,
                duplicate: true,
              },
            });
            return;
          }
          if (this.workModeRefuseBusy || this.busy || this.activeCommandId !== undefined) {
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "busy",
                reason:
                  "the session has unresolved submitted work; work mode applies to settled sessions",
                commandId,
              },
            });
            return;
          }
          if (expectedRevision !== this.workModeRevision()) {
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "conflict",
                reason: "the recorded work mode revision moved; reread and retry explicitly",
                commandId,
              },
            });
            return;
          }
          if (this.failNextWorkModeIntent) {
            this.failNextWorkModeIntent = false;
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "unknown",
                reason: "the durable mode intent could not be recorded; nothing was applied",
                commandId,
              },
            });
            return;
          }
          // The durable intent precedes every file effect.
          this.workModeCommands.set(commandId, {
            fingerprint,
            owner: { clientId: binding.clientId, threadId: binding.threadId },
            mode,
            expectedRevision,
            settled: false,
            selection: this.workModeSelection(),
          });
          if (this.crashNextWorkModeSet) {
            this.crashNextWorkModeSet = false;
            socket.drop();
            return;
          }
          // Atomic write/remove of the scoped control path, then the receipt
          // with the exact post-effect selection.
          this.workModeOverride = mode === "default" ? undefined : mode;
          this.workModeWrites += 1;
          const selection = this.workModeSelection();
          this.workModeCommands.set(commandId, {
            fingerprint,
            owner: { clientId: binding.clientId, threadId: binding.threadId },
            mode,
            expectedRevision,
            settled: true,
            selection,
          });
          if (this.dropNextWorkModeSet) {
            this.dropNextWorkModeSet = false;
            socket.drop();
            return;
          }
          socket.reply(requestId, {
            result: { version: 1, state: "applied", commandId, selection, duplicate: false },
          });
          return;
        }
        socket.reply(requestId, {
          error: { code: -32603, message: `unknown work mode operation ${operation}` },
        });
        return;
      }
      case "workbench.overview": {
        if (!this.supportOverview) {
          // A pre-R3 gateway: the additive method simply does not exist.
          socket.reply(requestId, {
            error: { code: -32601, message: "Method not found: workbench.overview" },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        const cursor = record.sessionCursor as { seq?: number; generation?: string } | undefined;
        const resnapshot =
          this.forceOverviewResnapshot ??
          (cursor === undefined ||
            cursor.generation !== this.sessionGeneration ||
            (cursor.seq ?? 0) > this.seqCounter);
        socket.reply(requestId, {
          result: { ...this.overviewResult(), resnapshot },
        });
        return;
      }
      case "workbench.code": {
        if (!this.codeResponse) {
          socket.reply(requestId, {
            error: { code: -32601, message: "Method not found: workbench.code" },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          !this.binding ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        socket.reply(requestId, { result: this.codeResponse });
        return;
      }
      case "workbench.graph": {
        if (!this.supportGraph) {
          // A pre-R4 gateway: the additive method simply does not exist.
          socket.reply(requestId, {
            error: { code: -32601, message: "Method not found: workbench.graph" },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        const graphType = String(record.graphType);
        socket.reply(requestId, { result: this.graphResult(graphType) });
        return;
      }
      case "workbench.record": {
        if (!this.supportRecord) {
          // A pre-R5 gateway: the additive method simply does not exist.
          socket.reply(requestId, {
            error: { code: -32601, message: "Method not found: workbench.record" },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        socket.reply(requestId, { result: this.recordResult ?? this.defaultRecordResult() });
        return;
      }
      case "workbench.usage": {
        if (!this.supportUsage) {
          // A pre-R8 gateway: the additive method simply does not exist.
          socket.reply(requestId, {
            error: { code: -32601, message: "Method not found: workbench.usage" },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        socket.reply(requestId, { result: this.usageResult() });
        return;
      }
      case "workbench.record.index":
      case "workbench.record.body":
      case "workbench.graph.explore": {
        const responder =
          method === "workbench.record.index"
            ? this.explorer.index
            : method === "workbench.record.body"
              ? this.explorer.body
              : this.explorer.graph;
        if (!this.supportExplorer || responder === undefined) {
          // An older gateway: the additive explorer method does not exist.
          socket.reply(requestId, {
            error: { code: -32601, message: `Method not found: ${method}` },
          });
          return;
        }
        const binding = record.binding as { clientId: string; threadId: string };
        if (
          this.binding === undefined ||
          this.binding.clientId !== binding.clientId ||
          this.binding.threadId !== binding.threadId
        ) {
          socket.reply(requestId, {
            error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
          });
          return;
        }
        try {
          socket.reply(requestId, { result: responder(record) });
        } catch (error) {
          socket.reply(requestId, {
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      default:
        socket.reply(requestId, {
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  }
}
