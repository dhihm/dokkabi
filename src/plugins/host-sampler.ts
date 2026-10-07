import type { EventLog } from "../host/event-log.ts";
import { appendHostSample, collectHostSample } from "../host/sample.ts";
import type { HostContext, PluginModule } from "../loader/types.ts";

export interface HostSampler {
  sample(): void;
  start(intervalMs?: number): void;
  stop(): void;
}

export function createHostSampler(input: { log: EventLog; workspaceRoot: string }): HostSampler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let prevCpu = process.cpuUsage();
  let prevHr = process.hrtime.bigint();

  const sample = () => {
    const next = collectHostSample({
      log: input.log,
      workspaceRoot: input.workspaceRoot,
      prevCpu,
      prevHr,
    });
    prevCpu = next.cpu;
    prevHr = next.hr;
    appendHostSample(input.log, next.sample);
  };

  return {
    sample,
    start(intervalMs = 1000) {
      if (timer) {
        return;
      }
      prevCpu = process.cpuUsage();
      prevHr = process.hrtime.bigint();
      sample();
      timer = setInterval(sample, intervalMs);
      // The sampler must never keep a CLI process alive on its own.
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
  id: "host-sampler",
  claims: [
    { key: "host", role: "definition" },
    { key: "host", role: "provider" },
  ],
  register(ctx: HostContext) {
    const sampler = createHostSampler({ log: ctx.log, workspaceRoot: ctx.workspaceRoot });
    ctx.define("host", { sample: "observe.host" });
    ctx.provide("host", sampler);
    if (!ctx.log.isReadOnly) sampler.start(5000);
    ctx.effect(() => () => sampler.stop());
  },
};
