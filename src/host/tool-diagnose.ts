import type { EventLog } from "./event-log.ts";

export type DiagnosisKind =
  | "intended_red"
  | "test_failure"
  | "exit_nonzero"
  | "blocked"
  | "missing_result"
  | "ok";

export interface Diagnosis {
  kind: DiagnosisKind;
  detail: string;
}

export interface DiagnosisInput {
  name: string;
  command: string;
  exit_text: string;
  result_text: string;
  /** Work-plan case ids currently recorded red whose command covers this call. */
  red_case_ids: string[];
  log?: EventLog;
}

const MAX_DETAIL = 160;

/**
 * Why a tool call errored, derived from what the log already holds: the
 * tool/result surface text, the command, and the work-plan case states.
 * The dashboard shows this instead of a bare err=1.
 */
export function toolDiagnosis(input: DiagnosisInput): Diagnosis {
  const text = input.result_text.trim();
  if (!text) {
    return { kind: "missing_result", detail: "no recorded result text" };
  }
  if (text.includes("refusing to read secret file") || text.includes("outside the workspace")) {
    return { kind: "blocked", detail: firstLine(text) };
  }
  const exitCode = lastExitCode(text);
  if (input.command.startsWith("bun test") || text.includes("bun test v")) {
    if (input.red_case_ids.length > 0) {
      return {
        kind: "intended_red",
        detail: `RED case ${input.red_case_ids.join(",")} failed as expected (exit ${exitCode ?? "?"})`,
      };
    }
    const failure = firstFailureLine(text);
    return {
      kind: "test_failure",
      detail: failure ? `${failure} (exit ${exitCode ?? "?"})` : firstLine(text),
    };
  }
  return {
    kind: "exit_nonzero",
    detail: `${firstLine(text)} (exit ${exitCode ?? "?"})`,
  };
}

/** Red case ids from work/case events whose command covers the given command. */
export function redCaseIdsFor(log: EventLog, command: string): string[] {
  const red = new Map<string, string>();
  for (const event of log.events) {
    if (event.name === "work/case" && typeof event.payload.id === "string") {
      const cmd = typeof event.payload.command === "string" ? event.payload.command : "";
      red.set(event.payload.id, cmd);
    }
  }
  const out: string[] = [];
  for (const [id, cmd] of red) {
    if (cmd && (cmd === command || command.startsWith(cmd))) {
      out.push(id);
    }
  }
  return out;
}

function lastExitCode(text: string): string | undefined {
  const matches = [...text.matchAll(/exited with code (\d+)/g)];
  return matches.at(-1)?.[1];
}

function firstLine(text: string): string {
  return clip(text.split("\n").find((line) => line.trim().length > 0) ?? "");
}

function firstFailureLine(text: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith("(fail)") || line.startsWith("error:"));
  if (index >= 0) {
    return clip(lines.slice(index, index + 2).join(" ").trim());
  }
  return "";
}

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}
