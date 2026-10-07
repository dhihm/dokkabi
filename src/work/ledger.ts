import { recordedEvidence } from "../host/evidence.ts";
import type { EventRecord } from "../host/schema.ts";
import type { WorkPlan } from "./schema.ts";
import { currentCaseEvidence, scopeWorkEvents } from "./scope.ts";

type LoggedEvent = { seq?: number; name: string; payload: Record<string, unknown> };

export interface CaseRow {
  id: string;
  status: string;
  command?: string;
  first_run?: boolean;
}

export interface WorkLedger {
  cases: CaseRow[];
  green: string[];
  red: string[];
  bornGreen: string[];
  changed: string[];
  reads: string[];
  shas: string[];
  issues: string[];
}

/**
 * Everything the acceptance turn should judge against, taken from the log
 * rather than rediscovered by the model. Cases green prove the cases; the
 * ledger is what makes that distinction visible at judgment time.
 */
export function buildWorkLedger(events: readonly LoggedEvent[], plan?: WorkPlan): WorkLedger {
  const sequencedEvents = plan
    ? events.map((event, index) => typeof event.seq === "number" ? event : { ...event, seq: index + 1 })
    : events;
  const scopedEvents = plan
    ? scopeWorkEvents(plan, sequencedEvents as readonly EventRecord[])
    : sequencedEvents;
  const last = new Map<string, CaseRow>();
  if (plan) {
    for (const item of plan.cases) {
      const scenario = plan.scenarios.find((candidate) => candidate.id === item.scenario);
      const evidence = currentCaseEvidence(
        item,
        scenario,
        scopedEvents as readonly EventRecord[],
      );
      const event = evidence.at(-1);
      last.set(item.id, {
        id: item.id,
        status: typeof event?.payload.status === "string" ? event.payload.status : "unknown",
        command: item.command,
        ...(event?.payload.first_run === true ? { first_run: true } : {}),
      });
    }
  } else {
    for (const event of scopedEvents) {
      if (event.name !== "work/case" || typeof event.payload.id !== "string") {
        continue;
      }
      const id = event.payload.id;
      last.set(id, {
        id,
        status: String(event.payload.status ?? "unknown"),
        ...(typeof event.payload.command === "string" ? { command: event.payload.command } : {}),
        ...(event.payload.first_run === true ? { first_run: true } : {}),
      });
    }
  }
  const cases = [...last.values()].sort((a, b) => a.id.localeCompare(b.id));
  const green = cases.filter((row) => row.status === "green").map((row) => row.id);
  const red = cases.filter((row) => row.status === "red").map((row) => row.id);
  const bornGreen = cases
    .filter((row) => row.status === "green" && row.first_run === true)
    .map((row) => row.id);

  const changed: string[] = [];
  for (const event of scopedEvents) {
    if (event.name !== "tool/start") {
      continue;
    }
    const name = event.payload.name;
    if (name !== "write" && name !== "edit") {
      continue;
    }
    const hint = event.payload.arg_hint;
    if (typeof hint === "string" && hint.length > 0) {
      changed.push(hint);
    }
  }

  const evidence = recordedEvidence(scopedEvents);
  // Prefer plan case ids when the plan is known, so born-green detection
  // matches the implement prompt's own list. Guards are their own semantic:
  // a guard passing from the start is the invariant holding, not weak
  // evidence, so they never appear as born-green.
  if (plan) {
    const scenarioIds = new Set(plan.scenarios.map((scenario) => scenario.id));
    const guardIds = new Set(plan.cases.filter((item) => item.guard).map((item) => item.id));
    const planCaseIds = new Set(
      plan.cases.filter((item) => scenarioIds.has(item.scenario)).map((item) => item.id),
    );
    return {
      cases,
      green: green.filter((id) => planCaseIds.has(id) || planCaseIds.size === 0),
      red: red.filter((id) => planCaseIds.has(id) || planCaseIds.size === 0),
      bornGreen: bornGreen.filter((id) => (planCaseIds.has(id) || planCaseIds.size === 0) && !guardIds.has(id)),
      changed: [...new Set(changed)].sort(),
      reads: evidence.paths.slice(0, 40),
      shas: evidence.shas,
      issues: evidence.issues,
    };
  }
  return {
    cases,
    green,
    red,
    bornGreen,
    changed: [...new Set(changed)].sort(),
    reads: evidence.paths.slice(0, 40),
    shas: evidence.shas,
    issues: evidence.issues,
  };
}

/** Render the ledger as a section the acceptance prompt can carry. */
export function formatWorkLedger(ledger: WorkLedger): string {
  const lines: string[] = ["Evidence ledger (from this session's EventLog — do not rediscover):"];
  if (ledger.cases.length > 0) {
    lines.push("Case observations (authoritative execution observations from the EventLog):");
    for (const row of ledger.cases.slice(0, 30)) {
      lines.push(`- ${row.id} ${row.status.toUpperCase()}: ${row.command ?? "command not recorded"}`);
    }
  }
  if (ledger.green.length > 0) {
    lines.push(`Cases green: ${ledger.green.join(", ")}`);
  } else {
    lines.push("Cases green: none recorded");
  }
  if (ledger.red.length > 0) {
    lines.push(`Cases still red: ${ledger.red.join(", ")}`);
  }
  if (ledger.bornGreen.length > 0) {
    lines.push(
      `Born-green (passed on first run — weak evidence the case never failed): ${ledger.bornGreen.join(", ")}`,
    );
  }
  if (ledger.changed.length > 0) {
    lines.push("Files written or edited this session:");
    for (const path of ledger.changed.slice(0, 30)) {
      lines.push(`- ${path}`);
    }
  } else {
    lines.push("Files written or edited this session: none");
  }
  if (ledger.reads.length > 0) {
    lines.push("Paths read this session (workspace, repo, or remote):");
    for (const path of ledger.reads.slice(0, 20)) {
      lines.push(`- ${path}`);
    }
  }
  if (ledger.shas.length > 0) {
    lines.push(`Pinned commits read: ${ledger.shas.map((sha) => sha.slice(0, 12)).join(", ")}`);
  }
  if (ledger.issues.length > 0) {
    lines.push(`Issues fetched: ${ledger.issues.map((n) => `#${n}`).join(", ")}`);
  }
  lines.push(
    "Cases green prove the cases, not the order. Judge the deliverable against the order using this ledger.",
  );
  return lines.join("\n");
}
