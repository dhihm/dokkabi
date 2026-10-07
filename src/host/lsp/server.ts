import { FrameDecoder, FrameError, isRecord } from "./protocol.ts";

/**
 * #222 D3 / L1 — one owner per configured server, shared by every consumer.
 *
 * The owner starts the server lazily, inside the session's sandbox policy
 * (the caller's `spawn` is the fenced spawn in production), bounds startup,
 * restarts at most `restartBudget` times after a crash, and ends the whole
 * process group exactly once when ownership ends: the last lease released
 * (the passive diagnostics provider, #229's navigation), an abort, or a
 * dispose (plugin unload, task end). Every callback is bound to the
 * generation that produced it: a response or notification from an ended
 * generation is discarded and counted, a pending request of an ended
 * generation is rejected, and nothing reaches a consumer after dispose.
 * At most `perWorkspaceMax` servers run per workspace in this process,
 * session-owned duplicates included.
 */

export interface ServiceProcess {
  readonly pid: number;
  readonly stdin: { write(data: Uint8Array): unknown; flush?(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** End the whole execution once; resolves to how many processes survive. */
  end(): Promise<number>;
}

export type SpawnService = (argv: readonly string[]) => ServiceProcess;

export interface DocumentSync {
  /** Workspace-relative, as the host keys it. */
  readonly path: string;
  readonly abs: string;
  readonly version: number;
  readonly text: string;
  readonly languageId: string;
}

/** What a dialect hands the owner: diagnostics named by URI or path. */
export interface RawBatch {
  readonly uri?: string;
  readonly file?: string;
  readonly version?: number;
  readonly diagnostics: readonly unknown[];
}

export interface DialectIo {
  readonly root: string;
  send(message: unknown): void;
  batch(batch: RawBatch): void;
  /** Something the server sent that the dialect did not ask for. */
  discard(reason: string): void;
}

export interface Dialect {
  readonly encode: (message: unknown) => Uint8Array;
  handshake(): Promise<void>;
  sync(doc: DocumentSync): void;
  receive(message: Record<string, unknown>): void;
  request?(method: string, params: unknown): Promise<unknown>;
  /** #229: what the server declared at its handshake (LSP `capabilities`,
   * or the fixed set a tsserver speaks), data for a consumer's method
   * support check; undefined before the handshake. */
  capabilities?(): Readonly<Record<string, unknown>> | undefined;
  /** The generation ended: reject what is pending, forget the queue. */
  close(reason: string): void;
}

export type DialectFactory = (io: DialectIo) => Dialect;

export type OwnerState = "idle" | "starting" | "ready" | "unavailable" | "disposed";

export interface ServerEvent {
  readonly event: "starting" | "ready" | "exited" | "restarting" | "unavailable" | "ended" | "late_discarded";
  readonly generation?: string;
  readonly reason?: string;
  readonly survivors?: number;
  readonly startup_ms?: number;
  readonly exit_code?: number;
}

export interface ServerOwnerOptions {
  readonly profile: string;
  readonly argv: readonly string[];
  readonly root: string;
  readonly rootId: string;
  readonly dialect: DialectFactory;
  readonly spawn: SpawnService;
  readonly startupMs?: number;
  readonly restartBudget?: number;
  readonly perWorkspaceMax?: number;
  /** Test seam for LSP_UNANSWERED_BYTES_MAX. */
  readonly unansweredMax?: number;
  readonly now?: () => number;
  /** Server lifecycle facts, for the EventLog (`lsp/server`). */
  readonly record?: (event: ServerEvent) => void;
  readonly onBatch: (generation: string, batch: RawBatch) => void;
  /** A new generation exists (before its handshake): nothing earlier binds. */
  readonly onGeneration: (generation: string) => void;
  readonly onUnavailable: (reason: string) => void;
  readonly onDiscard?: (generation: string, reason: string) => void;
}

export const LSP_STARTUP_MS = 10_000;
export const LSP_RESTART_BUDGET = 1;
export const LSP_SERVERS_PER_WORKSPACE = 2;
/** Bytes written to a generation that has sent nothing back since: beyond
 * this the server is not reading and the generation ends (as a crash) —
 * the host never buffers without bound for a stalled helper. */
export const LSP_UNANSWERED_BYTES_MAX = 64 * 1024 * 1024;

/** Live servers per workspace root, in this process (D3). */
const LIVE = new Map<string, number>();
export function liveServerCount(rootId: string): number {
  return LIVE.get(rootId) ?? 0;
}

export interface Lease {
  readonly consumer: string;
  /** A request of the current generation; rejected when it ends (the
   * rejection is an Error whose `code`, when the server gave one, is the
   * server's own error code — data, never acted on). */
  request(method: string, params: unknown): Promise<unknown>;
  /** The current generation's declared capabilities (#229), if ready. */
  capabilities(): Readonly<Record<string, unknown>> | undefined;
  /** The current generation's id, if one is live. */
  readonly generation: string | undefined;
  /** Ownership of this consumer ends; the last one ends the process. */
  release(): Promise<void>;
}

interface Generation {
  readonly id: string;
  readonly process: ServiceProcess;
  readonly dialect: Dialect;
  readonly queue: Map<string, DocumentSync>;
  ready: boolean;
  ended: boolean;
  unanswered: number;
  endPromise?: Promise<number>;
}

export class ServerOwner {
  private stateValue: OwnerState = "idle";
  private current: Generation | undefined;
  private counter = 0;
  private restartsUsed = 0;
  private readonly leases = new Set<Lease>();
  private readonly startupMs: number;
  private readonly restartBudget: number;
  private readonly perWorkspaceMax: number;
  private readonly now: () => number;
  private unavailableReason: string | undefined;
  private disposing: Promise<void> | undefined;
  readonly stats = { starts: 0, restarts: 0, terminations: 0, lateDiscarded: 0, survivors: 0 };

  constructor(private readonly options: ServerOwnerOptions) {
    this.startupMs = options.startupMs ?? LSP_STARTUP_MS;
    this.restartBudget = options.restartBudget ?? LSP_RESTART_BUDGET;
    this.perWorkspaceMax = options.perWorkspaceMax ?? LSP_SERVERS_PER_WORKSPACE;
    this.now = options.now ?? Date.now;
  }

  get state(): OwnerState {
    return this.stateValue;
  }

  get generation(): string | undefined {
    return this.current && !this.current.ended ? this.current.id : undefined;
  }

  get reason(): string | undefined {
    return this.unavailableReason;
  }

  get pid(): number | undefined {
    return this.current && !this.current.ended ? this.current.process.pid : undefined;
  }

  /** The explicit ownership contract (LS-O4): each consumer holds a lease. */
  acquire(consumer: string): Lease {
    if (this.stateValue === "disposed") throw new Error("the language server owner is disposed");
    const owner = this;
    let released = false;
    const lease: Lease = {
      consumer,
      request(method, params) {
        if (released) return Promise.reject(new Error("lease_released"));
        return owner.request(method, params);
      },
      capabilities() {
        return released ? undefined : owner.capabilities();
      },
      get generation() {
        return released ? undefined : owner.generation;
      },
      async release() {
        if (released) return;
        released = true;
        owner.leases.delete(lease);
        if (owner.leases.size === 0) await owner.endCurrent("ownership_ended", "idle");
      },
    };
    this.leases.add(lease);
    if (this.stateValue === "idle") this.start();
    return lease;
  }

  /** Queue a document version for the current generation. Never waits. */
  sync(doc: DocumentSync): boolean {
    const generation = this.current;
    if (!generation || generation.ended || this.stateValue === "unavailable" || this.stateValue === "disposed") return false;
    if (!generation.ready) {
      generation.queue.delete(doc.path);
      generation.queue.set(doc.path, doc);
      return true;
    }
    try {
      generation.dialect.sync(doc);
    } catch {
      void this.crashed(generation, "write_failed");
      return false;
    }
    return true;
  }

  /** The live generation's declared capabilities (#229), once ready. */
  capabilities(): Readonly<Record<string, unknown>> | undefined {
    const generation = this.current;
    if (!generation || generation.ended || !generation.ready) return undefined;
    return generation.dialect.capabilities?.();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const generation = this.current;
    if (!generation || generation.ended || !generation.ready || !generation.dialect.request) {
      return Promise.reject(new Error(this.stateValue === "unavailable" ? `unavailable: ${this.unavailableReason}` : "not_ready"));
    }
    return generation.dialect.request(method, params);
  }

  /** An abort of the owning task: the process ends now, consumers stay
   * registered but see `unavailable`. */
  async abort(reason = "aborted"): Promise<void> {
    if (this.stateValue === "disposed") return;
    await this.endCurrent(reason, "unavailable");
    this.unavailableReason = reason;
    this.options.onUnavailable(reason);
  }

  /** Unload / task end: end once, drop every lease, accept nothing more. */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      const wasActive = this.current !== undefined && !this.current.ended;
      this.leases.clear();
      if (wasActive) await this.endCurrent("disposed", "disposed");
      this.stateValue = "disposed";
    })();
  }

  // ------------------------------------------------------------ internals

  private start(): void {
    if (this.stateValue === "disposed") return;
    const live = LIVE.get(this.options.rootId) ?? 0;
    if (live >= this.perWorkspaceMax) {
      this.fail("server_limit");
      return;
    }
    let process: ServiceProcess;
    const id = `${this.options.profile}:${(this.counter += 1)}`;
    this.stateValue = "starting";
    this.options.record?.({ event: "starting", generation: id });
    try {
      process = this.options.spawn(this.options.argv);
    } catch (error) {
      this.fail(`spawn_failed:${error instanceof Error ? error.name : "error"}`);
      return;
    }
    LIVE.set(this.options.rootId, live + 1);
    this.stats.starts += 1;
    const io: DialectIo = {
      root: this.options.root,
      send: (message) => {
        if (generation.ended) return;
        const bytes = generation.dialect.encode(message);
        generation.unanswered += bytes.length;
        if (generation.unanswered > (this.options.unansweredMax ?? LSP_UNANSWERED_BYTES_MAX)) {
          void this.crashed(generation, "unresponsive");
          throw new Error("unresponsive");
        }
        process.stdin.write(bytes);
        process.stdin.flush?.();
      },
      batch: (batch) => {
        if (generation.ended || this.current !== generation || this.stateValue === "disposed") {
          this.late(generation.id, "batch");
          return;
        }
        this.options.onBatch(generation.id, batch);
      },
      discard: (reason) => {
        if (!generation.ended) this.options.onDiscard?.(generation.id, reason);
      },
    };
    const generation: Generation = { id, process, dialect: undefined as unknown as Dialect, queue: new Map(), ready: false, ended: false, unanswered: 0 };
    (generation as { dialect: Dialect }).dialect = this.options.dialect(io);
    this.current = generation;
    this.options.onGeneration(id);
    void this.read(generation);
    void process.exited.then((code) => this.exited(generation, code));
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.startupMs); });
    void Promise.race([generation.dialect.handshake().then(() => "ok" as const, () => "failed" as const), timeout]).then(async (outcome) => {
      if (timer) clearTimeout(timer);
      if (generation.ended || this.current !== generation) return;
      if (outcome !== "ok") {
        await this.endGeneration(generation, outcome === "timeout" ? "startup_timeout" : "handshake_failed");
        this.fail(outcome === "timeout" ? "startup_timeout" : "handshake_failed");
        return;
      }
      generation.ready = true;
      this.stateValue = "ready";
      this.options.record?.({ event: "ready", generation: id, startup_ms: this.now() - startedAt });
      const queued = [...generation.queue.values()];
      generation.queue.clear();
      for (const doc of queued) this.sync(doc);
    });
  }

  private async read(generation: Generation): Promise<void> {
    const decoder = new FrameDecoder();
    const reader = generation.process.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (generation.ended || this.current !== generation || this.stateValue === "disposed") {
          // Bytes of an ended generation: counted, never parsed into state.
          this.late(generation.id, "bytes");
          continue;
        }
        generation.unanswered = 0;
        let messages: unknown[];
        try {
          messages = decoder.push(value);
        } catch (error) {
          await this.crashed(generation, error instanceof FrameError ? error.code : "frame_error");
          return;
        }
        for (const message of messages) {
          if (generation.ended || this.current !== generation) {
            this.late(generation.id, "message");
            continue;
          }
          if (!isRecord(message)) continue;
          try {
            generation.dialect.receive(message);
          } catch {
            this.options.onDiscard?.(generation.id, "dialect_error");
          }
        }
      }
    } catch {
      // The stream broke: the exit handler decides what that means.
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  private late(generation: string, what: string): void {
    this.stats.lateDiscarded += 1;
    this.options.record?.({ event: "late_discarded", generation, reason: what });
  }

  private async exited(generation: Generation, code: number): Promise<void> {
    if (generation.ended) return;
    this.options.record?.({ event: "exited", generation: generation.id, exit_code: code });
    await this.crashed(generation, "exited");
  }

  /** The generation ended without the owner ending it. */
  private async crashed(generation: Generation, reason: string): Promise<void> {
    if (generation.ended || this.current !== generation) return;
    await this.endGeneration(generation, reason);
    if (this.stateValue === "disposed" || this.leases.size === 0) return;
    if (this.restartsUsed < this.restartBudget) {
      this.restartsUsed += 1;
      this.stats.restarts += 1;
      this.options.record?.({ event: "restarting", generation: generation.id, reason });
      this.start();
      return;
    }
    this.fail(`crashed:${reason}`);
  }

  private fail(reason: string): void {
    if (this.stateValue === "disposed") return;
    this.stateValue = "unavailable";
    this.unavailableReason = reason;
    this.options.record?.({ event: "unavailable", reason });
    this.options.onUnavailable(reason);
  }

  private async endCurrent(reason: string, next: OwnerState): Promise<void> {
    const generation = this.current;
    if (generation && !generation.ended) await this.endGeneration(generation, reason);
    else if (generation?.endPromise) await generation.endPromise;
    if (this.stateValue !== "disposed") this.stateValue = next;
  }

  /** End one generation's process group exactly once. */
  private endGeneration(generation: Generation, reason: string): Promise<number> {
    if (generation.endPromise) return generation.endPromise;
    generation.ended = true;
    generation.dialect.close(reason);
    generation.queue.clear();
    generation.endPromise = (async () => {
      let survivors = 0;
      try {
        survivors = await generation.process.end();
      } finally {
        LIVE.set(this.options.rootId, Math.max(0, (LIVE.get(this.options.rootId) ?? 1) - 1));
        this.stats.terminations += 1;
        this.stats.survivors += survivors;
        this.options.record?.({ event: "ended", generation: generation.id, reason, survivors });
      }
      return survivors;
    })();
    return generation.endPromise;
  }
}
