import type { EventRecord } from "../host/schema.ts";
import { wrapText } from "./screen.ts";

/** Child facts and outside-supervisor observations remain separate projections.
 * Missing process telemetry in a child log is never replaced by its verdict. */
export function projectResearchDashboard(events: readonly EventRecord[]) {
  const binding = events.find(row => row.name === "research/bind");
  const starts = events.filter(row => row.name === "research/process_start");
  const exit = [...events].reverse().find(row => row.name === "research/process_exit");
  const deviation = [...events].reverse().find(row => row.name === "research/deviation");
  const artifact = [...events].reverse().find(row => row.name === "research/artifact_result" || row.name === "research/artifact_start");
  if (!binding && !starts.length && !deviation && !artifact) return undefined;
  const policy = binding?.payload.policy as { attempt_id?: string } | undefined;
  const identity = starts.at(-1)?.payload.attempt as { id?: string } | undefined;
  return { attempt: identity?.id ?? policy?.attempt_id ?? "missing", invocations: starts.length,
    state: deviation ? "paused" : exit?.payload.status ? String(exit.payload.status) : starts.length ? "running_or_unobserved_exit" : "bound",
    exit: exit?.payload.exit_code ?? "missing", signal: String(exit?.payload.signal ?? "missing"),
    timeout: exit?.payload.timed_out === true, deviation: String(deviation?.payload.reason ?? "none"),
    artifact: artifact ? { operation: String(artifact.payload.operation), status: artifact.name === "research/artifact_start" ? "incomplete" : String(artifact.payload.status),
      result: artifact.payload.result as { status?: string; checkpoint_sha256?: string; original_replay_available?: boolean;
        counts?: { fixtures: number; eligible_attacks: number; caught: number; benign: number; na: number; mismatches: number } } | undefined } : undefined };
}
export type ResearchDashboard = ReturnType<typeof projectResearchDashboard>;
export function researchDashboardLines(view: ResearchDashboard, cols: number): string[] {
  if (!view) return [];
  return [`research=${view.state} attempt=${view.attempt} invocations=${view.invocations}`,
    `process_exit=${view.exit} signal=${view.signal} timeout=${view.timeout} deviation=${view.deviation}`,
    ...(view.artifact ? [`artifact=${view.artifact.operation} status=${view.artifact.status} result=${view.artifact.result?.status ?? "unavailable"}`,
      ...(view.artifact.result?.counts ? [`replay_fixtures=${view.artifact.result.counts.fixtures} eligible=${view.artifact.result.counts.eligible_attacks} caught=${view.artifact.result.counts.caught} benign=${view.artifact.result.counts.benign} NA=${view.artifact.result.counts.na} mismatches=${view.artifact.result.counts.mismatches}`]
        : [`original_reference=${view.artifact.result?.checkpoint_sha256 ?? "unavailable"} public_original_replay=${view.artifact.result?.original_replay_available ?? "unavailable"}`])] : [])]
    .flatMap(line => wrapText(line, Math.max(1, cols - 2)));
}
