import type { SchedulerStateChannel } from "./scheduler-cleanup.ts";
import { increment, type MutableCounts, type QueueItem, type ReadyEntry } from "./scheduler-internals.ts";
import type {
  OwnedCandidate,
  PreparedCandidate,
  SchedulerDropReason,
} from "./scheduler-types.ts";

export class CandidateReadyStore<Ready> {
  private readonly entries = new Map<string, ReadyEntry<Ready>>();
  private readonly state: SchedulerStateChannel;
  private readonly dedupe: Set<string>;
  private readonly dropped: MutableCounts;
  private readonly readied: MutableCounts;
  private readonly taken: MutableCounts;
  private readonly retire: (item: QueueItem, reason: SchedulerDropReason) => void;

  constructor(input: {
    readonly state: SchedulerStateChannel;
    readonly dedupe: Set<string>;
    readonly dropped: MutableCounts;
    readonly readied: MutableCounts;
    readonly taken: MutableCounts;
    readonly retire: (item: QueueItem, reason: SchedulerDropReason) => void;
  }) {
    this.state = input.state;
    this.dedupe = input.dedupe;
    this.dropped = input.dropped;
    this.readied = input.readied;
    this.taken = input.taken;
    this.retire = input.retire;
  }

  get size(): number { return this.entries.size; }

  admit(item: QueueItem, prepared: PreparedCandidate<Ready>, limit: number): void {
    if (this.entries.size >= limit) {
      this.retire(item, "ready_full");
      this.state.cleanup(item, prepared.dispose);
    } else if (!this.state.publish(item, "ready")) {
      this.retire(item, "publication_failed");
      this.state.cleanup(item, prepared.dispose);
    } else {
      item.closed = true;
      if (item.timer) clearTimeout(item.timer);
      this.entries.set(item.candidate.id, { item, prepared });
      increment(this.readied, item.source);
    }
  }

  take(candidateId: string): OwnedCandidate<Ready> | undefined {
    const entry = this.entries.get(candidateId);
    if (!entry) return undefined;
    this.entries.delete(candidateId);
    this.dedupe.delete(entry.item.candidate.keyDigest);
    if (!this.state.publish(entry.item, "taken")) {
      increment(this.dropped, entry.item.source);
      this.state.cleanup(entry.item, entry.prepared.dispose);
      return undefined;
    }
    increment(this.taken, entry.item.source);
    return Object.freeze({ ...entry.prepared, candidate: entry.item.candidate });
  }

  disposeFirst(reason: SchedulerDropReason): void {
    const first = this.entries.entries().next().value;
    if (!first) return;
    this.entries.delete(first[0]);
    this.dedupe.delete(first[1].item.candidate.keyDigest);
    increment(this.dropped, first[1].item.source);
    this.state.publish(first[1].item, "disposed", reason);
    this.state.cleanup(first[1].item, first[1].prepared.dispose);
  }

}
