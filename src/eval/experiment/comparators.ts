import type { EventRecord } from "../../host/schema.ts";

/** Reported counts are evidence, not inferred billing or task correctness. */
export type ReportedMetric = { reported: number | null; coverage: "reported" | "partial" | "unknown" };
export type ComparatorObservation = {
  harness: { status: "completed" | "failed" | "unknown"; resolved: null };
  claim: { verdict: "unclassified"; text: string | null; source: string | null };
  models: string[];
  usage: Record<"input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reasoning_tokens" | "cost_usd", ReportedMetric>;
  usage_basis: "native_model_aggregate" | "native_message_lower_bound" | "dokkabi_usage_events";
  cost_basis: "native_client_estimate" | "unavailable";
  issues: string[];
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function metric(values: unknown[], partial = false): ReportedMetric {
  const found = values.map(count).filter((value): value is number => value !== null);
  return { reported: found.length ? found.reduce((sum, value) => sum + value, 0) : null,
    coverage: !found.length ? "unknown" : partial || found.length !== values.length ? "partial" : "reported" };
}
function observation(basis: ComparatorObservation["usage_basis"]): ComparatorObservation {
  return { harness: { status: "unknown", resolved: null }, claim: { verdict: "unclassified", text: null, source: null }, models: [],
    usage: { input_tokens: metric([]), output_tokens: metric([]), cache_read_tokens: metric([]), cache_write_tokens: metric([]),
      reasoning_tokens: metric([]), cost_usd: metric([]) }, usage_basis: basis, cost_basis: "unavailable", issues: [] };
}
function checkModels(out: ComparatorObservation, expectedModel: string) {
  out.models = [...new Set(out.models)].sort();
  if (!out.models.length) out.issues.push("observed_model_missing");
  if (out.models.some(model => model !== expectedModel)) out.issues.push("observed_model_mismatch");
  out.issues = [...new Set(out.issues)].sort();
  return out;
}

/** CLI JSONL stays native. Aggregate modelUsage is never added to message
 * usage or result.usage. Incomplete streams retain only observed lower bounds. */
export function normalizeClaudeStream(stream: string, expectedModel: string): ComparatorObservation {
  const out = observation("native_message_lower_bound"), rows: ObjectValue[] = [];
  for (const line of stream.split("\n").filter(line => line.trim())) {
    try {
      const row = object(JSON.parse(line));
      if (typeof row.type !== "string") throw new Error("missing type");
      rows.push(row);
    } catch { out.issues.push("native_stream_malformed"); }
  }
  const inits = rows.filter(row => row.type === "system" && row.subtype === "init");
  if (inits.length !== 1) out.issues.push("native_init_missing_or_duplicate");
  for (const row of inits) if (typeof row.model === "string") out.models.push(row.model);
  const messages = new Map<string, ObjectValue>();
  for (const row of rows.filter(row => row.type === "assistant")) {
    const message = object(row.message);
    if (typeof message.model === "string") out.models.push(message.model);
    if (typeof message.id !== "string") { out.issues.push("native_message_identity_missing"); continue; }
    const previous = messages.get(message.id);
    if (previous && previous.model !== message.model) out.issues.push("native_message_identity_conflict");
    // Native streams may repeat a message for separate content blocks. The
    // cumulative counters for that message are not additional model calls.
    const usage = object(message.usage), earlier = object(previous?.usage);
    for (const [key, value] of Object.entries(earlier)) if (count(value) !== null && (count(usage[key]) ?? -1) < Number(value)) usage[key] = value;
    messages.set(message.id, { ...message, usage });
  }
  const terminals = rows.filter(row => row.type === "result");
  if (!terminals.length) out.issues.push("native_terminal_missing");
  if (terminals.length > 1) out.issues.push("native_terminal_duplicate");
  const terminal = terminals.length === 1 ? terminals[0] : undefined;
  if (terminal && rows.at(-1) !== terminal) out.issues.push("native_records_after_terminal");
  const terminalValid = terminal && !out.issues.some(issue => ["native_stream_malformed", "native_records_after_terminal",
    "native_init_missing_or_duplicate", "native_message_identity_conflict"].includes(issue));
  if (terminal && typeof terminal.result === "string") out.claim = { verdict: "unclassified", text: terminal.result, source: "native_result.result" };
  if (!out.claim.text) {
    const last = [...rows].reverse().find(row => row.type === "assistant" && !row.parent_tool_use_id);
    const content = object(last?.message).content;
    if (Array.isArray(content)) {
      const text = content.map(object).filter(row => row.type === "text" && typeof row.text === "string").map(row => row.text).join("\n");
      if (text) out.claim = { verdict: "unclassified", text, source: "native_assistant.text" };
    }
  }
  if (terminalValid) {
    if (terminal.is_error === false && terminal.subtype === "success") out.harness.status = "completed";
    else if (terminal.is_error === true) out.harness.status = "failed";
    else out.issues.push("native_terminal_status_invalid");
  }
  const aggregate = object(terminal?.modelUsage), models = Object.keys(aggregate);
  out.models.push(...models);
  if (terminalValid && models.length) {
    const usage = Object.values(aggregate).map(object);
    out.usage_basis = "native_model_aggregate";
    for (const [name, key] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"],
      ["cache_read_tokens", "cacheReadInputTokens"], ["cache_write_tokens", "cacheCreationInputTokens"]] as const) out.usage[name] = metric(usage.map(row => row[key]));
    out.usage.cost_usd = metric([terminal.total_cost_usd]);
    if (out.usage.cost_usd.reported !== null) out.cost_basis = "native_client_estimate";
    if ([out.usage.input_tokens, out.usage.output_tokens, out.usage.cache_read_tokens, out.usage.cache_write_tokens].some(row => row.coverage !== "reported")) out.issues.push("native_usage_incomplete");
  } else {
    const usage = [...messages.values()].map(row => object(row.usage));
    for (const [name, key] of [["input_tokens", "input_tokens"], ["output_tokens", "output_tokens"],
      ["cache_read_tokens", "cache_read_input_tokens"], ["cache_write_tokens", "cache_creation_input_tokens"]] as const) out.usage[name] = metric(usage.map(row => row[key]), true);
    out.issues.push("native_aggregate_usage_unavailable");
  }
  return checkModels(out, expectedModel);
}

export type DokkabiSessionObservation = { id: string; events: readonly EventRecord[] | null };
/** Acceptance sessions have host references in their parent's trace, not a
 * session/parent event. Never infer provenance from a filename suffix. */
export function joinDokkabiSessions(parent: string, sessions: readonly DokkabiSessionObservation[]) {
  type Link = { parent: string | null; role: "parent" | "spec" | "verifier" | "child" };
  const candidates = new Map<string, Link[]>();
  for (const session of sessions) for (const row of session.events ?? []) {
    const links: [unknown, Link["role"]][] = [];
    if (row.name === "work/step" || row.name === "work/accept") links.push([row.payload.spec_session, "spec"], [row.payload.verifier_session, "verifier"]);
    if (row.name.startsWith("swarm/") || row.name.startsWith("work/") || row.name.startsWith("speculation/")) links.push([row.payload.child_session, "child"]);
    for (const [id, role] of links) if (typeof id === "string") candidates.set(id, [...(candidates.get(id) ?? []), { parent: session.id, role }]);
  }
  return new Map(sessions.map(session => {
    const links = candidates.get(session.id) ?? [], first = links[0];
    const link: Link = session.id === parent ? { parent: null, role: "parent" }
      : first && links.every(link => link.parent === first.parent && link.role === first.role) ? first : { parent: null, role: "child" };
    return [session.id, link];
  }));
}
/** Enumerate every log in the isolated state home, including children and
 * failed calls. This projection does not create external Dokkabi events. */
export function normalizeDokkabiSessions(sessions: readonly DokkabiSessionObservation[], expectedModel: string, parent: string): ComparatorObservation {
  const out = observation("dokkabi_usage_events");
  const unique = new Map<string, DokkabiSessionObservation>();
  for (const session of sessions) {
    if (unique.has(session.id)) out.issues.push("dokkabi_session_duplicate");
    else unique.set(session.id, session);
    if (!session.events) out.issues.push("dokkabi_session_unreadable");
  }
  const parentEvents = unique.get(parent)?.events;
  if (!parentEvents) out.issues.push("dokkabi_parent_missing");
  const terminal = parentEvents?.filter(row => row.name === "work/run_result").at(-1);
  if (terminal) {
    if (terminal.payload.outcome === "completed" && terminal.payload.exit_code === 0) out.harness.status = "completed";
    else if (terminal.payload.outcome === "incomplete" || terminal.payload.accepted === false) out.harness.status = "failed";
    else out.issues.push("dokkabi_terminal_status_invalid");
  }
  else out.issues.push("dokkabi_terminal_missing");
  const reply = parentEvents?.filter(row => (row.name === "assistant/message" || row.name === "work/operator_report") && typeof row.payload.text === "string").at(-1);
  if (reply) out.claim = { verdict: "unclassified", text: String(reply.payload.text), source: `${parent}:${reply.seq}:${reply.hash}` };
  const events = [...unique.values()].flatMap(row => row.events ?? []);
  const usage = events.filter(row => row.name === "model/usage").map(row => row.observe?.model_usage);
  for (const row of usage) if (row?.model && row.model !== "missing") out.models.push(row.model);
  if (events.some(row => row.name === "research/deviation")) out.issues.push("dokkabi_research_deviation");
  for (const row of events) {
    const fields = row.name.startsWith("swarm/") || row.name.startsWith("work/") || row.name.startsWith("speculation/")
      ? ["child_session", "spec_session", "verifier_session", "reviewer_session"] : [];
    for (const field of fields) {
      const id = row.payload[field];
      if (typeof id === "string" && id !== "missing" && !unique.get(id)?.events) out.issues.push("dokkabi_child_missing");
    }
  }
  const partial = !terminal || out.issues.some(issue => ["dokkabi_session_unreadable", "dokkabi_session_duplicate", "dokkabi_child_missing"].includes(issue));
  for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const) out.usage[key] = metric(usage.map(row => row?.[key]), partial);
  if (!usage.length || usage.some(row => !row || count(row.input_tokens) === null || count(row.output_tokens) === null)) out.issues.push("dokkabi_usage_incomplete");
  return checkModels(out, expectedModel);
}

export type ComparisonArmIdentity = { model: string; route_identity: string; snapshot: "verified" | "unresolved";
  wall_ms: number; token_cap: number | null; cost_cap_usd: number | null; aggregate_cap_verified: boolean };
/** An equal display alias, turn count or subscription is not a matched total
 * budget. These are claim blockers, independent of process launch permission. */
export function validateComparisonPair(left: ComparisonArmIdentity, right: ComparisonArmIdentity): string[] {
  const issues: string[] = [];
  if ([left, right].some(arm => /^(auto|default|opus|sonnet|haiku)$/iu.test(arm.model) || /latest/iu.test(arm.model))) issues.push("model_alias_unresolved");
  if (left.model !== right.model || left.route_identity !== right.route_identity) issues.push("model_or_route_mismatch");
  if ([left, right].some(arm => arm.snapshot !== "verified")) issues.push("model_snapshot_unresolved");
  if ([left, right].some(arm => !arm.aggregate_cap_verified || (arm.token_cap === null && arm.cost_cap_usd === null))) issues.push("aggregate_budget_unverified");
  if (left.wall_ms !== right.wall_ms || left.token_cap !== right.token_cap || left.cost_cap_usd !== right.cost_cap_usd) issues.push("resource_ceiling_mismatch");
  return issues;
}
