import { createHash } from "node:crypto";
import type { EventLog } from "../../src/host/event-log.ts";
import { BlobStore } from "../../src/host/blob-store.ts";
import type { RequestContextContribution } from "../../src/loader/types.ts";

export interface SourceAudit {
  latest_release_required: boolean;
  repository_source_required: boolean;
  report_path: string;
  claims: Array<{ claim: string; source_sequences: number[] }>;
  incomplete: string[];
}
export function sourceReads(log: EventLog, includeProbes = false) {
  const user = log.events.filter(e => e.name === "user/message").at(-1);
  return log.events.filter(e => e.seq > (user?.seq ?? 0) && e.name === "tool/call" && (includeProbes ? ["web_fetch", "github", "bash_probe"] : ["web_fetch", "github"]).includes(String(e.payload.name))).flatMap(call => {
    const result = log.events.find(e => e.name === "tool/result" && e.seq > call.seq && e.payload.id === call.payload.id);
    if (!result || result.payload.error === true) return [];
    const source = log.events.filter(e => e.name === "tool/source" && e.payload.id === call.payload.id && e.seq < result.seq).at(-1);
    const text = typeof source?.payload.blob === "string" ? BlobStore.forSession(log.path).get(source.payload.blob) : String(result.payload.raw ?? result.payload.text ?? "");
    return [{ seq: result.seq, call, text }];
  });
}
export function verifySourceAudit(log: EventLog, audit: SourceAudit, record = true) {
  const reads = sourceReads(log);
  const evidence = sourceReads(log, true);
  const missing: string[] = [];
  const user = log.events.filter(e => e.name === "user/message").at(-1);
  let tag: string | undefined;
  const latest = reads.find(r => r.call.payload.name === "github" && (r.call.payload.args as any)?.op === "release" && !(r.call.payload.args as any)?.ref);
  if (latest) {
    try { const data = JSON.parse(latest.text.replace(/\n\n\[slow:[^\n]*\]\s*$/, "")); if (!data.draft && !data.prerelease && typeof data.tag_name === "string") tag = data.tag_name; } catch { /* Invalid/clipped metadata proves no release. */ }
  }
  if (audit.latest_release_required && !tag) missing.push("Read official latest release metadata with github op=release; document banners do not establish the latest patch.");
  const code = reads.filter(r => r.call.payload.name === "github" && (r.call.payload.args as any)?.op === "blob" && r.text.trim() && !r.text.startsWith("[redacted"));
  if (audit.repository_source_required && !code.some(r => !audit.latest_release_required || ((r.call.payload.args as any)?.ref === tag && (r.call.payload.args as any)?.owner === (latest?.call.payload.args as any)?.owner && (r.call.payload.args as any)?.repo === (latest?.call.payload.args as any)?.repo))) missing.push("Read the requested repository source; when latest release is required, pin ref to its returned tag.");
  const badRefs = audit.claims.some(c => !c.source_sequences.length || c.source_sequences.some(seq => !evidence.some(r => r.seq === seq)));
  if (badRefs) missing.push("Each claim must cite an actual successful source/probe tool/result sequence from this turn; incomplete gaps cannot excuse invalid references.");
  if (!audit.report_path || !audit.claims.length) missing.push("Identify the report artifact and grounded source claims.");
  const failedCalls = log.events.filter(e => e.name === "tool/call" && e.seq > (user?.seq ?? 0) && e.payload.name === "github" && log.events.some(r => r.name === "tool/result" && r.payload.id === e.payload.id && r.payload.error === true));
  const releaseUnavailable = !audit.latest_release_required || Boolean(tag) || failedCalls.some(e => (e.payload.args as any)?.op === "release" && !(e.payload.args as any)?.ref);
  const sourceUnavailable = !audit.repository_source_required || code.some(r => !audit.latest_release_required || (r.call.payload.args as any)?.ref === tag) || failedCalls.some(e => (e.payload.args as any)?.op === "blob" && (!audit.latest_release_required || (e.payload.args as any)?.ref === tag));
  if (!missing.length && audit.incomplete.length) return { error: true, missing: ["All declared required sources are grounded. Remove unrelated optional repository failures and local runtime scope notes from incomplete; keep execution boundaries in the report."], available_sources: evidence.map(r => ({ seq: r.seq, tool: r.call.payload.name, args: r.call.payload.args })), next_action: "Correct the audit against these actual available source/probe refs; do not repeat successful probes." };
  if (badRefs || (missing.length && (!audit.incomplete.length || !releaseUnavailable || !sourceUnavailable))) return { error: true, missing, available_sources: evidence.map(r => ({ seq: r.seq, tool: r.call.payload.name, args: r.call.payload.args })), next_action: "Complete the missing available reads and correct the report, then audit again. Only external unavailable evidence justifies incomplete delivery." };
  if (record) log.append({ kind: "observe", name: "research/audit", payload: { user_seq: user?.seq ?? 0, source_through: Math.max(0, ...reads.map(r => r.seq)), status: missing.length ? "incomplete" : "ready", audit, missing } });
  return { error: false, status: missing.length ? "incomplete" : "ready", missing };
}
export function sourceCompletion(log: EventLog): RequestContextContribution {
  return { mode: "on", continueOnCompletion: true, prepare(input) {
    if (input.boundary !== "completion") return { action: "none" };
    const reads = sourceReads(log);
    const user = log.events.filter(e => e.name === "user/message").at(-1);
    const activatedAudit = log.events.some(e => e.seq > (user?.seq ?? 0) && e.name === "tool/call" && e.payload.name === "research_audit" && !(e.payload.args as {op?: string})?.op);
    if (!reads.some(r => r.call.payload.name === "web_fetch") && !activatedAudit) return { action: "none" };
    const audit = log.events.filter(e => e.name === "research/audit" && e.payload.user_seq === (user?.seq ?? 0)).at(-1);
    if (audit && Number(audit.payload.source_through) >= Math.max(...reads.map(r => r.seq))) return { action: "none" };
    const frameId = `cf-${(log.events.at(-1)?.seq ?? 0) + 1}`;
    const text = `[dokkabi context frame ${frameId}]\nSource research completion checkpoint: compare the original operator request with the actual visited sources and report. Use research_audit to record your reasoning before finalizing. report_path must name the full substantive report body, not a summary JSON or metadata proxy. You decide latest_release_required and repository_source_required from the original request, not convenience or available evidence. If latest/versioned source research was requested, read official release metadata and the exact tag source. Do not label document banners as latest-patch evidence, or cite unvisited links as inspected sources. Follow actual article links rather than rereading aliases. Recover omitted sections from retained source before relying on them. Correct missing available work without another operator message. Explicitly distinguish actual local probes, documentation and engineering inference; reuse passing checks. Incomplete is reserved for externally unavailable evidence and must name the concrete gap in the final report. No new mutation authority is granted. Available successful source tool/result sequences: ${JSON.stringify(reads.map(r => ({ seq: r.seq, tool: r.call.payload.name, args: r.call.payload.args })))}`;
    return { action: "record", frameId, present: true, text, payload: { schema: "source-research-completion-v1", frame_id: frameId, blob: createHash("sha256").update(text).digest("hex"), blob_bytes: Buffer.byteLength(text), user_seq: user?.seq ?? 0 } };
  } };
}
