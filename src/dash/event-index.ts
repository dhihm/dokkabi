import type { EventRecord } from "../host/schema.ts";

/**
 * The log, bucketed by event name, folded once.
 *
 * `projectDash` is 74 helpers and each one walks the whole log looking for its
 * own two or three event names. On a live session — 93MB, 115,000 events —
 * that is about sixty full scans and 145ms per projection, against a 100ms
 * paint interval, so the board started a rebuild it could never finish and the
 * spinner, the stream and the keyboard all queued behind the same work.
 *
 * Every one of those helpers has the same shape: walk in order, skip the names
 * it does not want. Walking the union of that helper's own buckets, in
 * sequence order, visits exactly the same records in exactly the same order —
 * the equivalence is structural, not a heuristic, which is what makes this
 * safe to do to a board whose numbers an operator acts on.
 *
 * The fold is incremental for the same reason the reader is: a log only grows,
 * so events already bucketed are never looked at again.
 */
export class EventIndex {
  private readonly buckets = new Map<string, EventRecord[]>();
  /** How many records of the source array are already bucketed. */
  private folded = 0;
  /** Merged name-sets for the current fold; see `ofAny`. */
  private readonly merged = new Map<string, readonly EventRecord[]>();
  private mergedAt = -1;

  /**
   * Bucket whatever is new. Passing a shorter array than last time — a
   * different session, a truncated log — starts over rather than guessing.
   */
  fold(events: readonly EventRecord[]): this {
    if (events.length < this.folded) {
      this.buckets.clear();
      this.merged.clear();
      this.mergedAt = -1;
      this.folded = 0;
    }
    for (let i = this.folded; i < events.length; i += 1) {
      const event = events[i]!;
      const bucket = this.buckets.get(event.name);
      if (bucket) bucket.push(event);
      else this.buckets.set(event.name, [event]);
    }
    this.folded = events.length;
    return this;
  }

  /** How many records have been folded. */
  get size(): number {
    return this.folded;
  }

  /** One name's records, in order. Never copied — callers must not mutate. */
  of(name: string): readonly EventRecord[] {
    return this.buckets.get(name) ?? EMPTY;
  }

  /**
   * Several names, merged back into sequence order.
   *
   * Buckets are each in order and the log's seq only climbs, so a k-way merge
   * on seq reproduces the original order exactly. Two names is the common
   * case and the merge is over the matching records, not the log.
   */
  ofAny(...names: readonly string[]): readonly EventRecord[] {
    // Memoised, because the callers are the paint path and they ask with the
    // same name sets every frame. Merging allocates a record per match, and a
    // set that includes a busy name -- `agent/step`, say -- is tens of
    // thousands of them: without this the merge cost more than the scan it
    // replaced.
    //
    // Keyed by the fold as well as the names: the log grows, and a merge built
    // before the newest records is a stale answer, not just an old one.
    const key = `${this.folded}\u0000${names.join("\u0000")}`;
    const cached = this.merged.get(key);
    if (cached) return cached;
    const built = this.mergeOf(names);
    // One generation at a time: the previous fold's merges can never be asked
    // for again, and keeping them would grow without bound over a long run.
    if (this.mergedAt !== this.folded) {
      this.merged.clear();
      this.mergedAt = this.folded;
    }
    this.merged.set(key, built);
    return built;
  }

  private mergeOf(names: readonly string[]): readonly EventRecord[] {
    const lists = names.map((name) => this.buckets.get(name)).filter((list): list is EventRecord[] => list !== undefined);
    if (lists.length === 0) return EMPTY;
    if (lists.length === 1) return lists[0]!;
    const at = new Array<number>(lists.length).fill(0);
    const total = lists.reduce((sum, list) => sum + list.length, 0);
    const out: EventRecord[] = new Array(total);
    for (let n = 0; n < total; n += 1) {
      let pick = -1;
      for (let k = 0; k < lists.length; k += 1) {
        const cursor = at[k]!;
        if (cursor >= lists[k]!.length) continue;
        if (pick === -1 || lists[k]![cursor]!.seq < lists[pick]![at[pick]!]!.seq) pick = k;
      }
      out[n] = lists[pick]![at[pick]!]!;
      at[pick] = at[pick]! + 1;
    }
    return out;
  }

  /**
   * Every name under a prefix, merged into sequence order.
   *
   * For the helpers that test `name.startsWith("compaction/")` rather than
   * naming each one: the bucket keys are a few dozen strings, so finding them
   * is nothing next to a scan of the log.
   */
  ofPrefix(prefix: string, ...also: readonly string[]): readonly EventRecord[] {
    const names = [...this.buckets.keys()].filter((name) => name.startsWith(prefix));
    for (const name of also) if (!names.includes(name)) names.push(name);
    return this.ofAny(...names);
  }

  /**
   * Every name the log actually carries.
   *
   * For callers that want to know WHICH kinds occurred rather than read them:
   * a few dozen strings instead of a pass over every record.
   */
  names(): readonly string[] {
    return [...this.buckets.keys()];
  }

  /** The last record of a name, which is what most "last X" helpers want. */
  last(name: string): EventRecord | undefined {
    return this.buckets.get(name)?.at(-1);
  }
}

const EMPTY: readonly EventRecord[] = Object.freeze([]);

/**
 * An index for one array, built fresh.
 *
 * A caller that keeps its own index across polls — the board does — pays the
 * fold only for what arrived. This is for callers that do not.
 */
export function indexOf(events: readonly EventRecord[]): EventIndex {
  return new EventIndex().fold(events);
}
