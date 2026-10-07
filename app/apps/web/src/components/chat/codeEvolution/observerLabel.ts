import type { WorkbenchCode } from "@t3tools/contracts";

export function codeObserverLabel(state: WorkbenchCode["observer"]): string {
  if (!state) return "Producer state unknown (legacy host)";
  const base =
    state.state === "off"
      ? "Automatic capture off"
      : state.state === "paused"
        ? `Automatic capture paused · ${state.reason ?? "source_refused"} · retained history stays readable`
        : `Automatic capture active · ${state.paths} selected paths · ${state.checks}/256 checks`;
  if (state.revision === undefined) return base;
  const watcher = state.watcher
    ? `idle capture ${state.watcher.runtime === "started" ? "running every 5s" : state.watcher.runtime}`
    : "idle capture availability unknown";
  const checks = state.state === "active" ? "" : ` · ${state.checks}/256 checks`;
  return `${base}${checks} · ${watcher} · revision ${state.revision} · window ${state.window ?? "unknown"} · ${state.lifetimeChecks ?? "unknown"} lifetime checks · ${state.retainedVersions ?? "unknown"}/32 retained versions · ${state.retainedBytes ?? "unknown"}/67108864 retained bytes`;
}
