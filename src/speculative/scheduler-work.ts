import type { SpeculationCandidate } from "./candidates.ts";
import { createSchedulerStateChannel, type SchedulerStateChannel } from "./scheduler-cleanup.ts";
import { createDeferredPrediction } from "./scheduler-deferred.ts";
import { CandidateReadyStore } from "./scheduler-ready.ts";
import {
  attemptId,
  copyCounts,
  emptyCounts,
  increment,
  inspectPrepared,
  normalizeBudget,
  rejected,
  type QueueItem,
} from "./scheduler-internals.ts";
import type {
  CandidateSchedulerBudget,
  CandidateSchedulerSnapshot,
  CandidateSource,
  OwnedCandidate,
  PreparedCandidate,
  ScheduledCandidate,
  SchedulerDropReason,
  SchedulerReceipt,
  SchedulerStateEvent,
} from "./scheduler-types.ts";

export class CandidateWorkQueue<Ready> {
  private readonly queue: QueueItem[] = [];
  private readonly active = new Set<QueueItem>();
  private readonly dedupe = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly scheduled = emptyCounts();
  private readonly dropped = emptyCounts();
  private readonly readyBySource = emptyCounts();
  private readonly taken = emptyCounts();
  private readonly deferred = createDeferredPrediction({
    dropped: () => increment(this.dropped, "prediction"),
    settled: () => this.notifyIdle(),
  });
  private readonly state: SchedulerStateChannel;
  private readonly ready: CandidateReadyStore<Ready>;
  private readonly nonce: string;
  private readonly execute: (candidate: ScheduledCandidate, signal: AbortSignal) => Promise<PreparedCandidate<Ready> | undefined>;
  private budget: CandidateSchedulerBudget;
  private queuedBytes = 0;
  private outstanding = 0;
  private generation = 0;
  private attempt = 0;
  private pumpPending = false;
  private disposed = false;

  constructor(input: {
    readonly nonce: string;
    readonly budget: CandidateSchedulerBudget;
    readonly execute: (candidate: ScheduledCandidate, signal: AbortSignal) => Promise<PreparedCandidate<Ready> | undefined>;
    readonly onState?: (event: SchedulerStateEvent) => boolean | void;
  }) {
    this.nonce = input.nonce;
    this.budget = input.budget;
    this.execute = input.execute;
    this.state = createSchedulerStateChannel(input.onState);
    this.ready = new CandidateReadyStore({
      state: this.state,
      dedupe: this.dedupe,
      dropped: this.dropped,
      readied: this.readyBySource,
      taken: this.taken,
      retire: (item, reason) => this.close(item, reason),
    });
  }

  get maxCallBytes(): number { return this.budget.maxCallBytes; }
  get isDisposed(): boolean { return this.disposed; }

  reject(source: CandidateSource, reason: SchedulerDropReason, key?: string): SchedulerReceipt {
    increment(this.dropped, source);
    return rejected(reason, key);
  }

  admit(candidate: SpeculationCandidate, source: CandidateSource): SchedulerReceipt {
    if (this.disposed) return this.reject(source, "disposed", candidate.keyDigest);
    if (this.dedupe.has(candidate.keyDigest)) return this.reject(source, "duplicate", candidate.keyDigest);
    if (
      this.queue.length >= this.budget.maxQueue
      || this.queuedBytes + candidate.byteLength > this.budget.maxQueueBytes
    ) return this.reject(source, "queue_full", candidate.keyDigest);
    this.attempt += 1;
    const id = attemptId(this.nonce, this.attempt, candidate.keyDigest, source);
    const item: QueueItem = {
      candidate: Object.freeze({ ...candidate, id }),
      controller: new AbortController(),
      source,
      generation: this.generation,
      closed: false,
      timer: undefined,
    };
    if (!this.state.publish(item, "scheduled")) {
      item.controller.abort();
      return this.reject(source, "publication_failed", candidate.keyDigest);
    }
    this.queue.push(item);
    this.queuedBytes += candidate.byteLength;
    this.dedupe.add(candidate.keyDigest);
    increment(this.scheduled, source);
    this.schedulePump();
    return Object.freeze({
      accepted: true,
      id,
      keyDigest: candidate.keyDigest,
      tool: candidate.tool,
      tier: candidate.tier,
      source,
      predictionSource: candidate.provenance.kind === "prediction"
        ? candidate.provenance.source
        : undefined,
      signal: item.controller.signal,
    });
  }

  defer(run: (limit: number) => void): boolean {
    if (this.disposed || this.queue.length >= this.budget.maxQueue) {
      increment(this.dropped, "prediction");
      return false;
    }
    const generation = this.generation;
    return this.deferred.schedule(
      run,
      this.budget.maxQueue,
      () => !this.disposed && generation === this.generation,
    );
  }

  take(candidateId: string): OwnedCandidate<Ready> | undefined {
    return this.ready.take(candidateId);
  }

  reload(next: Partial<CandidateSchedulerBudget>): void {
    this.budget = normalizeBudget(next, this.budget);
    while (this.queue.length > this.budget.maxQueue || this.queuedBytes > this.budget.maxQueueBytes) {
      const item = this.queue.pop();
      if (!item) break;
      this.queuedBytes -= item.candidate.byteLength;
      this.close(item, "queue_full");
    }
    while (this.ready.size > this.budget.maxReady) this.ready.disposeFirst("ready_full");
    this.schedulePump();
    this.notifyIdle();
  }

  async idle(): Promise<void> {
    if (!this.logicallyIdle()) await new Promise<void>((resolve) => this.waiters.add(resolve));
    await this.state.drain();
  }

  snapshot(): CandidateSchedulerSnapshot {
    return Object.freeze({
      scheduled: copyCounts(this.scheduled),
      dropped: copyCounts(this.dropped),
      readyBySource: copyCounts(this.readyBySource),
      taken: copyCounts(this.taken),
      queued: this.queue.length,
      active: this.active.size,
      outstanding: this.outstanding,
      ready: this.ready.size,
      queuedBytes: this.queuedBytes,
      pendingPrediction: this.deferred.active,
      cleanupFailures: this.state.failures(),
      pendingCleanup: this.state.pending(),
      disposed: this.disposed,
    });
  }

  invalidate(permanent: boolean): void {
    if (this.disposed) return;
    this.generation += 1;
    this.deferred.cancel();
    for (const item of this.queue.splice(0)) {
      this.queuedBytes -= item.candidate.byteLength;
      this.close(item, "disposed", "disposed");
    }
    for (const item of [...this.active]) {
      this.active.delete(item);
      this.close(item, "disposed", "disposed");
    }
    while (this.ready.size > 0) this.ready.disposeFirst("disposed");
    if (permanent) this.disposed = true;
    this.notifyIdle();
  }

  private start(item: QueueItem): void {
    this.active.add(item);
    this.outstanding += 1;
    item.timer = setTimeout(() => {
      if (item.closed) return;
      this.active.delete(item);
      this.close(item, "deadline");
      this.schedulePump();
      this.notifyIdle();
    }, this.budget.deadlineMs);
    void Promise.resolve()
      .then(() => this.execute(item.candidate, item.controller.signal))
      .then((value) => this.settle(item, value, false), () => this.settle(item, undefined, true));
  }

  private settle(item: QueueItem, value: unknown, failed: boolean): void {
    this.outstanding -= 1;
    this.active.delete(item);
    const inspection = inspectPrepared<Ready>(value);
    if (item.closed) {
      this.state.cleanup(item, inspection.kind === "ready" ? inspection.prepared.dispose : inspection.dispose);
    } else if (failed || inspection.kind === "rejected") {
      this.close(item, "failed");
      this.state.cleanup(item, inspection.kind === "ready" ? inspection.prepared.dispose : inspection.dispose);
    } else if (this.disposed || item.generation !== this.generation || item.controller.signal.aborted) {
      this.close(item, "disposed", "disposed");
      this.state.cleanup(item, inspection.prepared.dispose);
    } else this.ready.admit(item, inspection.prepared, this.budget.maxReady);
    this.schedulePump();
    this.notifyIdle();
  }

  private close(item: QueueItem, reason: SchedulerDropReason, phase: "dropped" | "disposed" = "dropped"): void {
    if (item.closed) return;
    item.closed = true;
    if (item.timer) clearTimeout(item.timer);
    item.controller.abort();
    this.dedupe.delete(item.candidate.keyDigest);
    increment(this.dropped, item.source);
    this.state.publish(item, phase, reason);
  }

  private schedulePump(): void {
    if (this.pumpPending || this.queue.length === 0 || this.disposed) return;
    this.pumpPending = true;
    setImmediate(() => this.pump());
  }

  private pump(): void {
    this.pumpPending = false;
    while (
      this.queue.length > 0
      && this.active.size < this.budget.maxConcurrency
      && this.outstanding < this.budget.maxOutstanding
    ) {
      const item = this.queue.shift();
      if (!item) break;
      this.queuedBytes -= item.candidate.byteLength;
      if (this.disposed || item.generation !== this.generation || item.controller.signal.aborted) {
        this.close(item, "disposed", "disposed");
      } else if (this.ready.size >= this.budget.maxReady) this.close(item, "ready_full");
      else this.start(item);
    }
    this.notifyIdle();
  }

  private logicallyIdle(): boolean {
    return !this.deferred.active
      && this.active.size === 0
      && (this.queue.length === 0 || this.outstanding >= this.budget.maxOutstanding);
  }

  private notifyIdle(): void {
    if (!this.logicallyIdle()) return;
    for (const resolve of [...this.waiters]) resolve();
    this.waiters.clear();
  }
}
