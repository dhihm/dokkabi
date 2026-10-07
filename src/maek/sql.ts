export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS mem_decisions (
    decision_id VARCHAR PRIMARY KEY,
    session_id VARCHAR,
    turn_id INTEGER,
    symbol_id VARCHAR,
    decision_type VARCHAR,
    rationale TEXT,
    constraints JSON
  )`,
  `CREATE TABLE IF NOT EXISTS mem_tool_faults (
    fault_id VARCHAR PRIMARY KEY,
    command VARCHAR,
    command_digest VARCHAR,
    exit_code INTEGER,
    fault_excerpt TEXT,
    blob_digest VARCHAR
  )`,
  "ALTER TABLE mem_tool_faults ADD COLUMN IF NOT EXISTS command_digest VARCHAR",
  `CREATE TABLE IF NOT EXISTS mem_evidence_snapshots (
    snapshot_id VARCHAR PRIMARY KEY,
    session_id VARCHAR,
    prefix_hash VARCHAR,
    blob_digest VARCHAR
  )`,
  `CREATE TABLE IF NOT EXISTS mem_fault_resolutions (
    resolution_id VARCHAR PRIMARY KEY,
    fault_id VARCHAR,
    session_id VARCHAR,
    outcome VARCHAR,
    reference VARCHAR
  )`,
] as const;
