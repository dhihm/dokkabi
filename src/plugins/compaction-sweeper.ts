import type { HostContext, PluginModule } from "../loader/types.ts";

export interface CompactionSweeper {
  sweep(): { swept: boolean; reason?: string };
  start(intervalMs?: number): void;
  stop(): void;
}

/**
 * Background compaction, garbage-collector style: a timer sweeps the loop at
 * the soft threshold while the agent is idle, so the hard pre-model check
 * almost never has to fire. The loop owns the actual compaction and its
 * in-memory agent invalidation; this plugin only decides when to ask.
 */
export function createCompactionSweeper(ctx: HostContext): CompactionSweeper {
  let timer: ReturnType<typeof setInterval> | undefined;

  const sweep = () => {
    try {
      return ctx.loop?.sweep() ?? { swept: false, reason: "no_loop" };
    } catch {
      // A failed sweep must never take the host down; the hard check remains.
      return { swept: false, reason: "sweep_failed" };
    }
  };

  return {
    sweep,
    start(intervalMs = 15_000) {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        sweep();
      }, intervalMs);
      // The sweeper never keeps a CLI process alive on its own.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export const plugin: PluginModule = {
  id: "compaction-sweeper",
  claims: [
    { key: "compaction", role: "definition" },
    { key: "compaction", role: "provider" },
    { key: "loop", role: "consumer" },
  ],
  register(ctx: HostContext) {
    const sweeper = createCompactionSweeper(ctx);
    ctx.define("compaction", { sweep: "soft_threshold_idle" });
    ctx.provide("compaction", sweeper);
    if (!ctx.log.isReadOnly) sweeper.start(15_000);
    ctx.effect(() => () => sweeper.stop());
  },
};
