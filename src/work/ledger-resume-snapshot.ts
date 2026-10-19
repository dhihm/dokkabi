import type { EventRecord } from "../host/schema.ts";

interface Reference { seq: number; hash: string; name: string }
const reference = (row: EventRecord): Reference => ({ seq: row.seq, hash: row.hash, name: row.name });

/** Host observations only. Domain interpretation stays in dated model rows. */
export function ledgerResumeSnapshot(events: readonly EventRecord[], state: {
  openTodos: readonly string[];
  workspaceImage?: string;
}) {
  const latest = (names: readonly string[]) => {
    for (let index = events.length - 1; index >= 0; index--) {
      const row = events[index]!;
      if (names.includes(row.name)) return reference(row);
    }
    return null;
  };
  const tail = (names: readonly string[], limit: number) => events
    .filter(event => names.includes(event.name)).slice(-limit).map(reference);
  return {
    schema: "ledger-resume-snapshot-v1",
    authority: "host log observations; not domain qualification or a live process inventory",
    as_of: events.length ? reference(events[events.length - 1]!) : null,
    session_open: latest(["session/open"]),
    plan: latest(["work/ledger", "work/ledger_case"]),
    open_todos: [...state.openTodos],
    ...(state.workspaceImage === undefined ? {} : { workspace_image: state.workspaceImage }),
    request_admissions: events.filter(event => event.name === "provider/request").length,
    budget_observations: tail(["work/ledger_session", "work/recovery_budget", "work/recovery_budget_narrow"], 16),
    latest_response: latest(["provider/response"]),
    evidence_refs: tail(["tool/result", "verify/receipt", "work/execution"], 12),
    model_annotation_refs: tail(["work/note", "work/finish"], 8),
  };
}
