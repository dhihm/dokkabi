import type { QueueItem } from "./scheduler-internals.ts";
import type {
  SchedulerDropReason,
  SchedulerStateEvent,
} from "./scheduler-types.ts";

export interface SchedulerStateChannel {
  publish(
    item: QueueItem,
    phase: SchedulerStateEvent["phase"],
    reason?: SchedulerDropReason,
  ): boolean;
  cleanup(item: QueueItem, disposer: (() => void | Promise<void>) | undefined): void;
  drain(): Promise<void>;
  failures(): number;
  pending(): number;
}

export function createSchedulerStateChannel(
  sink: ((event: SchedulerStateEvent) => boolean | void) | undefined,
): SchedulerStateChannel {
  const tasks = new Set<Promise<void>>();
  let failureCount = 0;
  const publish = (
    item: QueueItem,
    phase: SchedulerStateEvent["phase"],
    reason?: SchedulerDropReason,
  ): boolean => {
    const event: SchedulerStateEvent = Object.freeze({
      phase,
      id: item.candidate.id,
      keyDigest: item.candidate.keyDigest,
      tool: item.candidate.tool,
      tier: item.candidate.tier,
      source: item.source,
      predictionSource: item.candidate.provenance.kind === "prediction"
        ? item.candidate.provenance.source
        : undefined,
      reason,
    });
    try {
      return sink?.(event) !== false;
    } catch (error) {
      if (error instanceof Error) return false;
      return false;
    }
  };
  return {
    publish,
    cleanup(item, disposer) {
      if (!disposer) return;
      const task = Promise.resolve().then(disposer).then(
        () => undefined,
        () => {
          failureCount += 1;
          publish(item, "cleanup_failed", "failed");
        },
      );
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
    async drain() {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
    failures: () => failureCount,
    pending: () => tasks.size,
  };
}
