import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { attemptSchema, experimentId, sha256Schema, exitValueSchema, oracleValueSchema, type Artifact, type CollectionIssue,
  type CollectionState, type EventRef, type ExternalEnvelope, type ScheduledRun } from "./schema.ts";

export type RetainedSource = { artifact: Artifact; path: string; body?: ExternalEnvelope; events?: EventRecord[];
  replay?: { structural: string; semantic: string; digest: string | null; unsupported: string[] } };
export type IssueSink = (code: string, location: string, context?: Partial<Omit<CollectionIssue, "code" | "location">>) => void;
export type AttemptRow = { source_index: number; id: string | null; scheduled_key: string | null; ordinal: number | null;
  state: CollectionState; raw_terminal: unknown; acceptance: unknown; graph: unknown; process_exit: unknown;
  oracle: "correct" | "wrong" | "unknown"; source: unknown };
export type SessionRow = { attempt_source_index: number; source_index: number; attempt_id: string; scheduled_key: string;
  id: string; role: string; parent: string | null; log: string; replay: RetainedSource["replay"] | null };

/** Reconcile attempts without flattening their sessions into the sample table.
 * A primary observation is ordinal one, fixed before any outcome is read. */
export function reconcileAttempts(rawAttempts: readonly unknown[], scheduled: readonly ScheduledRun[],
  sources: ReadonlyMap<string, RetainedSource>, issue: IssueSink) {
  const rows: AttemptRow[] = [], sessions: SessionRow[] = [];
  const scheduledMap = new Map(scheduled.map(row => [row.key, row]));
  const ids = new Map<string, number[]>(), ordinals = new Map<string, number[]>(), sessionIds = new Map<string, number[]>(), logs = new Map<string, number[]>(), logSources = new Map<string, number[]>();
  for (const [index, raw] of rawAttempts.entries()) {
    const parsed = attemptSchema.safeParse(raw);
    if (!parsed.success) {
      const partial = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const id = experimentId.safeParse(partial.id), key = sha256Schema.safeParse(partial.scheduled_key);
      const context = { attempt_id: id.success ? id.data : null, scheduled_key: key.success ? key.data : null };
      issue("invalid_attempt", `attempts[${index}]`, context);
      rows.push({ source_index: index, id: context.attempt_id, scheduled_key: context.scheduled_key, ordinal: null, state: "corrupt", raw_terminal: null, acceptance: null, graph: null, process_exit: null, oracle: "unknown", source: raw });
      continue;
    }
    const attempt = parsed.data, location = `attempts[${index}]`, context = { scheduled_key: attempt.scheduled_key, attempt_id: attempt.id };
    let broken = false;
    const refuse = (code: string, part = "", artifact_id?: string) => { broken = true; issue(code, location + part, { ...context, artifact_id: artifact_id ?? null }); };
    const track = (map: Map<string, number[]>, key: string) => map.set(key, [...(map.get(key) ?? []), index]);
    track(ids, attempt.id); track(ordinals, `${attempt.scheduled_key}:${attempt.ordinal}`);
    const scheduledRow = scheduledMap.get(attempt.scheduled_key);
    if (!scheduledRow) refuse("unscheduled_attempt");
    const artifact = (id: string | null, kind: Artifact["kind"]) => {
      const source = id === null ? undefined : sources.get(id);
      if (!source || source.artifact.kind !== kind) { refuse("artifact_unavailable", `.${kind}`, id ?? undefined); return undefined; }
      return source;
    };
    artifact(attempt.bindings.scope, "scope"); artifact(attempt.bindings.patch, "patch");
    if (scheduledRow && attempt.bindings.scope !== scheduledRow.scope) refuse("source_subject_mismatch", ".scope");
    const roots = attempt.sessions.filter(row => row.role === "parent");
    if (attempt.sessions.length && (roots.length !== 1 || roots[0]?.parent !== null)) refuse("invalid_session_root");
    if (scheduledRow?.system === "dokkabi" && !attempt.sessions.length) refuse("missing_session");
    if (scheduledRow?.system === "external" && attempt.sessions.length) refuse("unexpected_session");
    const parentLog = roots.length === 1 ? roots[0]!.log : undefined;
    const sessionMap = new Map(attempt.sessions.map(row => [row.id, row]));
    for (const [sessionIndex, session] of attempt.sessions.entries()) {
      track(sessionIds, session.id); track(logs, session.log);
      const source = artifact(session.log, "dokkabi_log");
      if (source) track(logSources, source.artifact.sha256);
      if (source?.events?.length === 0) refuse("empty_native_log", `.sessions[${sessionIndex}]`);
      if (source?.events?.some(event => event.name === "session/open" && event.payload.session_id !== undefined && event.payload.session_id !== session.id)) {
        refuse("session_identity_mismatch", `.sessions[${sessionIndex}]`);
      }
      sessions.push({ attempt_source_index: index, source_index: sessionIndex, attempt_id: attempt.id, scheduled_key: attempt.scheduled_key,
        ...session, replay: source?.replay ?? null });
      if (session.role !== "parent") {
        const visited = new Set([session.id]); let parent = session.parent;
        while (parent !== null) {
          const node = sessionMap.get(parent);
          if (!node || visited.has(parent)) { refuse("invalid_session_parent", `.sessions[${sessionIndex}]`); break; }
          visited.add(parent); parent = node.parent;
        }
        if (session.parent === null || !roots[0] || !visited.has(roots[0].id)) refuse("invalid_session_parent", `.sessions[${sessionIndex}]`);
      }
      // Native delivery references must join the declared child, not an
      // unrelated log that happens to contain a successful terminal event.
      for (const event of source?.events ?? []) {
        const links: { id: unknown; role?: string; hash?: unknown; digest?: unknown }[] = [];
        if (event.name === "work/accept" || event.name === "work/step") {
          for (const [field, role] of [["spec", "spec"], ["verifier", "verifier"]] as const) {
            if (event.payload[`${field}_session`] !== undefined) links.push({ id: event.payload[`${field}_session`], role,
              hash: event.payload[`${field}_log_hash`], digest: event.payload[`${field}_digest`] });
          }
        }
        if (event.name.startsWith("swarm/") && event.payload.child_session !== undefined) links.push({ id: event.payload.child_session,
          hash: event.name === "swarm/child_close" ? event.payload.final_hash : undefined,
          digest: event.name === "swarm/child_close" ? event.payload.replay_digest : undefined });
        for (const link of links) {
          const child = typeof link.id === "string" ? sessionMap.get(link.id) : undefined;
          const childSource = child && sources.get(child.log);
          if (!child || child.parent !== session.id || (link.role && child.role !== link.role) || !childSource?.events
            || (link.hash !== undefined && link.hash !== childSource.events.at(-1)?.hash)
            || (link.digest !== undefined && link.digest !== childSource.replay?.digest)) refuse("child_source_mismatch", `.sessions[${sessionIndex}]`);
        }
      }
    }
    const event = (ref: EventRef | null, field: "terminal" | "acceptance" | "graph") => {
      if (!ref) return undefined;
      const source = artifact(ref.artifact, "dokkabi_log"), row = source?.events?.find(item => item.seq === ref.seq && item.hash === ref.hash);
      const names = field === "terminal" ? ["work/run_result"] : field === "acceptance" ? ["work/accept"] : ["graph/snapshot", "graph/apply"];
      if (ref.artifact !== parentLog || !row || !names.includes(row.name)) { refuse("event_source_mismatch", `.${field}`); return undefined; }
      if (field === "terminal" && source?.events?.filter(item => item.name === "work/run_result").at(-1)?.hash !== row.hash) refuse("stale_terminal", ".terminal");
      return row;
    };
    const terminal = event(attempt.bindings.terminal, "terminal"), acceptance = event(attempt.bindings.acceptance, "acceptance"), graph = event(attempt.bindings.graph, "graph");
    if (acceptance && terminal && acceptance.seq >= terminal.seq) refuse("event_order_mismatch", ".acceptance");
    if (graph && terminal && graph.seq >= terminal.seq) refuse("event_order_mismatch", ".graph");
    if (terminal?.payload.accepted === true && !acceptance) refuse("missing_acceptance");
    if (terminal?.payload.acceptance_ref !== undefined && acceptance
      && canonicalJson(terminal.payload.acceptance_ref) !== canonicalJson({ seq: acceptance.seq, hash: acceptance.hash, name: acceptance.name })) refuse("event_source_mismatch", ".acceptance_ref");
    if (terminal?.payload.condition !== undefined && terminal.payload.condition !== scheduledRow?.condition) refuse("condition_mismatch");
    const external = (id: string | null, kind: Artifact["kind"], expected: Record<string, string>) => {
      const source = artifact(id, kind), body = source?.body;
      if (!body || !scheduledRow) return undefined;
      let valid = true;
      if (body.scheduled_key !== attempt.scheduled_key || body.attempt_id !== attempt.id) { valid = false; refuse("source_subject_mismatch", `.${kind}`, id ?? undefined); }
      for (const [relation, target] of Object.entries(expected)) {
        const matches = body.references.filter(ref => ref.relation === relation);
        if (matches.length !== 1 || matches[0]?.artifact !== target) { valid = false; refuse("source_subject_mismatch", `.${kind}.${relation}`, id ?? undefined); }
      }
      return valid ? body : undefined;
    };
    const expected = { scope: attempt.bindings.scope, patch: attempt.bindings.patch };
    const fullExpected = { ...expected, oracle: scheduledRow?.oracle ?? "", rubric: scheduledRow?.rubric ?? "" };
    const exitBody = attempt.bindings.process_exit === null ? undefined : external(attempt.bindings.process_exit, "process_exit", expected);
    const exit = exitBody ? exitValueSchema.parse(exitBody.value) : undefined;
    const oracleBody = attempt.bindings.oracle === null ? undefined : external(attempt.bindings.oracle, "oracle_result", fullExpected);
    let oracleValid = true;
    if (oracleBody && scheduledRow) {
      const definition = sources.get(scheduledRow.oracle);
      if (!definition || canonicalJson(oracleBody.source) !== canonicalJson(definition.artifact.source)) { oracleValid = false; refuse("oracle_version_mismatch"); }
    }
    const oracle = oracleBody && oracleValid ? oracleValueSchema.parse(oracleBody.value).verdict : "unknown";
    for (const [field, kind] of [["labels", "label"], ["harness", "harness_result"], ["journal", "journal"]] as const) {
      if (new Set(attempt.bindings[field]).size !== attempt.bindings[field].length) refuse("duplicate_external_reference", `.${field}`);
      for (const id of attempt.bindings[field]) external(id, kind, fullExpected);
    }
    const crashed = exit !== undefined && (exit.exit_code !== 0 || exit.signal !== null || exit.timed_out === true || Boolean(exit.supervisor_error));
    const missing = !exit || !oracleBody || (attempt.sessions.length ? !terminal || !graph : !attempt.bindings.harness.length);
    if (missing) issue("missing_attempt_evidence", location, context);
    if (crashed) issue("process_crash", location, context);
    rows.push({ source_index: index, id: attempt.id, scheduled_key: attempt.scheduled_key, ordinal: attempt.ordinal,
      state: broken ? "corrupt" : crashed ? "crash" : missing ? "missing" : "complete",
      raw_terminal: terminal?.payload ?? null, acceptance: acceptance?.payload ?? null, graph: graph?.payload ?? null,
      process_exit: exit ?? null, oracle, source: attempt });
  }
  for (const [map, code] of [[ids, "duplicate_attempt"], [ordinals, "duplicate_attempt_ordinal"], [sessionIds, "duplicate_session"], [logs, "duplicate_session_log"], [logSources, "duplicate_session_source"]] as const) {
    for (const indices of map.values()) if (indices.length > 1) for (const index of indices) {
      const row = rows[index]!; row.state = "duplicate";
      issue(code, `attempts[${index}]`, { scheduled_key: row.scheduled_key, attempt_id: row.id });
    }
  }
  const bySchedule = new Map<string, number[]>();
  for (const row of rows) if (row.scheduled_key) {
    if (!bySchedule.has(row.scheduled_key)) bySchedule.set(row.scheduled_key, []);
    bySchedule.get(row.scheduled_key)!.push(row.ordinal ?? 0);
  }
  for (const [key, values] of bySchedule) {
    const ordered = values.sort((a, b) => a - b);
    if (ordered.some((ordinal, index) => ordinal !== index + 1)) issue("attempt_ordinal_gap", "attempts", { scheduled_key: key });
  }
  return { attempts: rows, sessions };
}
