import { canonicalJson } from "../host/canonical.ts";
import type { MaekObservation } from "./types.ts";

export type SqlExec = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function clearDerivedRows(exec: SqlExec): Promise<void> {
  await exec("DELETE FROM mem_decisions");
  await exec("DELETE FROM mem_tool_faults");
  await exec("DELETE FROM mem_evidence_snapshots");
  await exec("DELETE FROM mem_fault_resolutions");
}

export async function insertObservation(exec: SqlExec, observation: MaekObservation): Promise<void> {
  switch (observation.kind) {
    case "decision":
      await exec("INSERT INTO mem_decisions (decision_id, session_id, turn_id, symbol_id, decision_type, rationale, constraints) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        observation.row.decision_id,
        observation.row.session_id,
        observation.row.turn_id,
        observation.row.symbol_id ?? null,
        observation.row.decision_type,
        observation.row.rationale,
        observation.row.constraints === undefined ? null : canonicalJson(observation.row.constraints),
      ]);
      return;
    case "fault":
      await exec("INSERT INTO mem_tool_faults (fault_id, command, command_digest, exit_code, fault_excerpt, blob_digest) VALUES (?, ?, ?, ?, ?, ?)", [
        observation.row.fault_id,
        observation.row.command,
        observation.row.command_digest ?? null,
        observation.row.exit_code === "missing" ? null : observation.row.exit_code,
        observation.row.fault_excerpt,
        observation.row.blob_digest,
      ]);
      return;
    case "snapshot":
      await exec("INSERT INTO mem_evidence_snapshots VALUES (?, ?, ?, ?)", [
        observation.row.snapshot_id,
        observation.row.session_id,
        observation.row.prefix_hash,
        observation.row.blob_digest,
      ]);
      return;
    case "fault_resolution":
      await exec("INSERT INTO mem_fault_resolutions VALUES (?, ?, ?, ?, ?)", [
        observation.row.resolution_id,
        observation.row.fault_id,
        observation.row.session_id,
        observation.row.outcome,
        observation.row.reference,
      ]);
  }
}
