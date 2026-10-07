import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "./event-log.ts";
import type { HostSample } from "./schema.ts";

export function collectHostSample(input: {
  log: EventLog;
  workspaceRoot: string;
  prevCpu?: ReturnType<typeof process.cpuUsage>;
  prevHr?: bigint;
}): { sample: HostSample; cpu: ReturnType<typeof process.cpuUsage>; hr: bigint } {
  const hr = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  let cpu_pct: HostSample["cpu_pct"] = 0;
  if (input.prevCpu && input.prevHr && hr > input.prevHr) {
    const deltaUs = cpu.user - input.prevCpu.user + (cpu.system - input.prevCpu.system);
    const elapsedUs = Number(hr - input.prevHr) / 1000;
    cpu_pct = elapsedUs > 0 ? Math.round((deltaUs / elapsedUs) * 1000) / 10 : 0;
  }

  const rss_bytes = process.memoryUsage().rss;
  let log_bytes: HostSample["log_bytes"] = 0;
  try {
    log_bytes = existsSync(input.log.path) ? statSync(input.log.path).size : 0;
  } catch {
    log_bytes = "missing";
  }

  const created: string[] = [];
  const written: string[] = [];
  for (const event of input.log.events) {
    if (event.kind !== "effect") {
      continue;
    }
    const path = typeof event.payload.path === "string" ? event.payload.path : undefined;
    if (!path) {
      continue;
    }
    if (event.name === "fs/create") {
      created.push(path);
    }
    if (event.name === "fs/write" || event.name === "fs/create") {
      written.push(path);
    }
  }

  return {
    sample: {
      cpu_pct,
      rss_bytes,
      workspace_bytes: workspaceBytes(input.workspaceRoot),
      log_bytes,
      files_created: unique(created),
      files_written: unique(written),
      pids: [
        {
          pid: process.pid,
          cmd: displayCmd(process.argv[1] ?? process.title),
          cpu_pct,
          rss_bytes,
        },
      ],
    },
    cpu,
    hr,
  };
}

/** Recorded commands stay host-free: cwd-relative when inside the repo. */
function displayCmd(cmd: string): string {
  const cwd = process.cwd();
  if (cwd && cmd.startsWith(cwd)) {
    return `.${cmd.slice(cwd.length)}`;
  }
  return cmd;
}

export function appendHostSample(log: EventLog, sample: HostSample): void {
  // Ephemeral: the board's sparklines only ever read the recent tail, so this
  // rides the rotatable telemetry stream, not the hash-chained content log.
  log.appendTelemetry({
    kind: "observe",
    name: "host/sample",
    payload: {},
    observe: { host: sample },
  });
}

function workspaceBytes(root: string): HostSample["workspace_bytes"] {
  if (!existsSync(root)) {
    return 0;
  }
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < 4000) {
    const dir = stack.pop();
    if (!dir) {
      break;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name === ".dokkabi") {
        continue;
      }
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      seen += 1;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        total += st.size;
      }
      if (seen >= 4000) {
        break;
      }
    }
  }
  return total;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return String(pid);
  }
}
