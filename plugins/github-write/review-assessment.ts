import { currentReviewBegin } from "../github/review-state.ts";
import type { EventRecord } from "../../src/host/schema.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventLog } from "../../src/host/event-log.ts";
import { BlobStore } from "../../src/host/blob-store.ts";
import { spawnSealedHostGit } from "../../src/host/git-authority.ts";
import { z } from "zod";

const text = z.string().trim().min(8).max(4000);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const reviewCaseSchema = z.object({
  plan_change_reason: text.optional(),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  file: z.string().min(1).max(1024),
  role: z.enum(["production", "test", "documentation"]),
  trigger: text,
  production_path: text,
  source_anchor: text,
  static_reasoning: text.optional(),
  revision_delta_reasoning: text.optional(),
  mapping_refs: z.array(z.number().int().positive()).max(100).optional(),
  oracle: text,
  oracle_basis: text.optional(),
  scope: z.enum(["static", "unit", "integration", "system", "gpu"]),
  evidence_kind: z.enum(["static", "local", "author"]),
  change_refs: z.array(z.number().int().positive()).min(1).max(100).optional().default([]),
  source_refs: z.array(z.number().int().positive()).min(1).max(100).optional().default([]),
  probe_ids: z.array(z.string().min(1)).max(100).optional(),
  evidence_refs: z.array(z.number().int().positive()).max(100),
  result: z.enum(["resolved", "risk", "gap"]),
  limits: text,
  runtime: text.optional(),
  validated_revision: sha.optional(),
  closing_action: text.optional(),
}).strict();
export type ReviewCase = z.infer<typeof reviewCaseSchema>;
interface Snapshot { target: string; number: number; head: string; base: string; files: string[]; }
type GitReader = (args: readonly string[]) => string;

/** Compare tracked bytes using a host-owned index populated from the reviewed tree.
 * Never consult the session index, which may hide edits with assume-unchanged. */
export function reviewWorkspaceMatches(workspace: string, head: string): boolean {
  const current = spawnSealedHostGit(workspace, ["rev-parse", "HEAD"]);
  if (current.exitCode !== 0 || current.stdout.toString().trim() !== head) return false;
  const dir = mkdtempSync(join(tmpdir(), "dokkabi-review-index-"));
  try {
    const extraEnv = { GIT_INDEX_FILE: join(dir, "index") };
    const initialized = spawnSealedHostGit(workspace, ["read-tree", head], { extraEnv });
    if (initialized.exitCode !== 0) return false;
    const refreshed = spawnSealedHostGit(workspace, ["update-index", "--really-refresh"], { extraEnv });
    if (refreshed.exitCode !== 0) return false;
    const diff = spawnSealedHostGit(workspace, ["diff-files", "--name-only", "-z", "--"], { extraEnv });
    return diff.exitCode === 0 && diff.stdout.length === 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export class ReviewRecoveryError extends Error {
  constructor(message: string, readonly recovery: Record<string, unknown>) { super(message); }
}

/** Durable plugin-owned assessment, not a semantic proof of correctness. */
export class ReviewAssessment {
  private git: GitReader;
  private workspaceMatches: (head: string) => boolean;
  constructor(private log: EventLog, workspace: string, git?: GitReader) {
    this.workspaceMatches = git
      ? head => git(["rev-parse", "HEAD"]).trim() === head && !git(["diff", "--no-ext-diff", "--no-textconv", head, "--"]).length
      : head => reviewWorkspaceMatches(workspace, head);
    this.git = git ?? ((args) => {
      const r = spawnSealedHostGit(workspace, args, { timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error("Review Git snapshot unavailable; fetch the exact head/base objects first");
      return r.stdout.toString();
    });
  }
  private snapshot() {
    const event = currentReviewBegin(this.log.events);
    if (!event) throw new Error("Call review_assessment op=begin with the exact PR head/base first");
    return { event, value: event.payload as unknown as Snapshot };
  }
  begin(target: string, number: number, head: string, base: string) {
    sha.parse(head); sha.parse(base);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target) || !Number.isSafeInteger(number) || number < 1) throw new Error("Invalid review target");
    const active=currentReviewBegin(this.log.events),user=this.log.events.filter(e=>e.name==="user/message").at(-1);
    const task=active&&this.log.events.filter(e=>e.name==="review/task"&&e.payload.begin_seq===active.seq&&e.payload.user_seq===user?.seq).at(-1);
    const finished=active&&this.log.events.some(e=>e.name==="review/finished"&&e.payload.begin_seq===active.seq&&e.seq>(task?.seq??Infinity));
    if(task&&!finished&&(active!.payload.target!==target||active!.payload.number!==number))throw new ReviewRecoveryError("Cannot replace an unfinished review target in the same operator turn. Complete its assessment and requested publication first; related PR evidence does not change the assigned target.",{code:"unfinished_review_target",next_op:"status",target:active!.payload.target,number:active!.payload.number,begin_seq:active!.seq});
    for (const ref of [head, base]) this.git(["cat-file", "-e", `${ref}^{commit}`]);
    const mergeBase = this.git(["merge-base", base, head]).trim(); sha.parse(mergeBase);
    const files = this.git(["diff", "--name-only", "-z", mergeBase, head, "--"]).split("\0").filter(Boolean);
    if (files.length === 0 || files.length > 2000) throw new Error("Review requires a nonempty bounded changed-file snapshot");
    const prior = currentReviewBegin(this.log.events);
    if (prior && prior.payload.target === target && prior.payload.number === number && prior.payload.head === head && prior.payload.base === base && prior.payload.merge_base === mergeBase && JSON.stringify(prior.payload.files) === JSON.stringify(files)) {
      this.log.append({ kind: "observe", name: "review/reused", payload: { begin_seq: prior.seq, target, number, head, base } });
      return this.status();
    }
    const previous=this.log.events.find(e=>e.name==="review/begin"&&e.payload.target===target&&e.payload.number===number&&e.payload.head===head&&e.payload.base===base&&e.payload.merge_base===mergeBase&&JSON.stringify(e.payload.files)===JSON.stringify(files));
    if(previous){this.log.append({kind:"observe",name:"review/selection",payload:{begin_seq:previous.seq,target,number,head,base}});return this.status();}
    this.log.append({ kind: "observe", name: "review/begin", payload: { target, number, head, base, merge_base: mergeBase, files } });
    return this.status();
  }
  source(file: string, offset: number, requestedRevision?: string, region: "full" | "changes" = "full") {
    const { value: s, event: begin } = this.snapshot();
    if (!s.files.includes(file)) throw new Error("Source must name a changed file from the review snapshot");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid source offset");
    // Deleted files are inspected at the merge base; surviving files at the head.
    if (requestedRevision && ![s.head, String(begin.payload.merge_base)].includes(requestedRevision)) throw new Error("source revision must be this review head or merge base");
    const view = requestedRevision && requestedRevision !== s.head ? "baseline" : "candidate";
    const cached=[...this.log.events].reverse().find(e=>e.name==="review/source"&&e.payload.begin_seq===begin.seq&&e.payload.file===file&&e.payload.view===view&&(e.payload.region??"full")===region);
    let revision = requestedRevision ?? s.head, body: string;
    let fullLength:number, lineRanges:number[][]|undefined;
    if(cached){
      revision=String(cached.payload.revision);body=BlobStore.forSession(this.log.path).get(String(cached.payload.blob));
      fullLength=Number(cached.payload.full_length??body.length);lineRanges=cached.payload.line_ranges as number[][]|undefined;
      this.log.append({kind:"observe",name:"review/read_reuse",payload:{begin_seq:begin.seq,op:"source",file,source_ref:cached.seq}});
    }else{
      try { body = this.git(["show", `${revision}:${file}`]); }
      catch { revision = String(begin.payload.merge_base); body = this.git(["show", `${revision}:${file}`]); }
      fullLength=body.length;
    }
    if (!cached && region === "changes") {
      const diff = this.git(["diff", "--no-ext-diff", "--no-textconv", "--unified=8", String(begin.payload.merge_base), s.head, "--", file]);
      const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const baseline = revision !== s.head;
      lineRanges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m => {
        const start=Number(m[baseline?1:3]), count=Number(m[baseline?2:4]??1);
        return [Math.max(0,start-1),Math.min(lines.length,start-1+Math.max(1,count))];
      }).filter(([start,end])=>end!>start!);
      if (!lineRanges.length) throw new Error("No textual changed-source hunks; use region=full for this file");
      body = lineRanges.map(([start,end])=>`[source lines ${start!+1}-${end}]\n${lines.slice(start,end).join("")}`).join("\n");
    }
    if (offset > body.length) throw new Error("Source offset exceeds source length");
    const end = Math.min(body.length, offset + 4000);
    const blob = BlobStore.forSession(this.log.path).put(body);
    const row = this.log.append({ kind: "observe", name: "review/source", payload: { begin_seq: begin.seq, file, revision, view, region, ...(lineRanges ? {line_ranges:lineRanges,full_length:fullLength} : {}), blob, offset, end, total: body.length } });
    return { source_ref: row.seq, file, revision, region, next_offset: end < body.length ? end : null, total: body.length, text: body.slice(offset, end) };
  }
  change(file: string, offset: number) {
    const { value: s, event: begin } = this.snapshot();
    if (!s.files.includes(file) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid changed-file diff request");
    const cached=[...this.log.events].reverse().find(e=>e.name==="review/change"&&e.payload.begin_seq===begin.seq&&e.payload.file===file);
    const body = cached?BlobStore.forSession(this.log.path).get(String(cached.payload.blob)):this.git(["diff", "--no-ext-diff", "--no-textconv", "--unified=20", String(begin.payload.merge_base), s.head, "--", file]);
    if(cached)this.log.append({kind:"observe",name:"review/read_reuse",payload:{begin_seq:begin.seq,op:"change",file,source_ref:cached.seq}});
    if (offset > body.length) throw new Error("Change offset exceeds diff length");
    const end = Math.min(body.length, offset + 4000);
    const blob = BlobStore.forSession(this.log.path).put(body);
    const row = this.log.append({ kind: "observe", name: "review/change", payload: { begin_seq: begin.seq, file, blob, offset, end, total: body.length } });
    return { change_ref: row.seq, file, next_offset: end < body.length ? end : null, diff: body.slice(offset, end) };
  }
  compare(file: string, revision: string, offset: number) {
    sha.parse(revision);
    const { value: s, event: begin } = this.snapshot();
    if (!s.files.includes(file) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid comparison file/offset");
    const cached=[...this.log.events].reverse().find(e=>e.name==="review/comparison"&&e.payload.begin_seq===begin.seq&&e.payload.file===file&&e.payload.revision===revision);
    if(!cached)this.git(["cat-file", "-e", `${revision}^{commit}`]);
    const delta = cached?BlobStore.forSession(this.log.path).get(String(cached.payload.blob)):this.git(["diff", "--no-ext-diff", "--no-textconv", revision, s.head, "--", file]);
    if(cached)this.log.append({kind:"observe",name:"review/read_reuse",payload:{begin_seq:begin.seq,op:"compare",file,source_ref:cached.seq,revision}});
    if (offset > delta.length) throw new Error("Comparison offset exceeds delta length");
    const end = Math.min(delta.length, offset + 4000);
    const blob = BlobStore.forSession(this.log.path).put(delta);
    const row = this.log.append({ kind: "observe", name: "review/comparison", payload: { begin_seq: begin.seq, file, revision, head: s.head, blob, offset, end, total: delta.length } });
    return { mapping_ref: row.seq, file, revision, head: s.head, identical: !delta.length, next_offset: end < delta.length ? end : null, delta: delta.slice(offset, end) };
  }
  private probeBody(row: EventRecord) {
    const source = this.log.events.filter(e => e.seq < row.seq && e.name === "tool/source" && e.payload.id === row.payload.id && e.payload.tool === row.payload.tool).at(-1);
    if (source && typeof source.payload.blob === "string") {
      return BlobStore.forSession(this.log.path).get(source.payload.blob);
    }
    const body = typeof row.payload.blob === "string" ? BlobStore.forSession(this.log.path).get(row.payload.blob) : String(row.payload.raw ?? row.payload.text);
    // Older logs may only retain presentation text. Remove only the known
    // host timing annotation; arbitrary trailing data must still fail JSON.
    return body.replace(/\n\n\[slow: [^\n]*\]\s*$/, "");
  }
  private probeSummary(ref: number) {
    const row = this.log.events.find(e => e.seq === ref)!;
    try {
      const body = this.probeBody(row);
      return Object.entries(JSON.parse(body) as Record<string, { state?: string; exit_code?: number; error?: boolean }>).map(([id, result]) => ({ id, state: result.state, exit_code: result.exit_code, error: result.error === true }));
    } catch { return [{ error: true, reason: "Probe result could not be decoded" }]; }
  }
  private evidenceResult(ref: number, probeIds?: string[]) {
    const row = this.log.events.find(e => e.seq === ref);
    if (!row || row.name !== "tool/result") throw new ReviewRecoveryError("Evidence must reference an observed tool/result; source and mapping receipts are not execution proof. Choose a relevant actual result; do not resend the invalid ID.",{code:"invalid_evidence_reference",invalid_ref:ref,observed_kind:row?.name??"missing"});
    if (row.payload.tool !== "bash_probe") return { tool: row.payload.tool, error: row.payload.error === true, exit_code: row.payload.exit_code };
    const text = this.probeBody(row);
    const batch = JSON.parse(text) as Record<string, { exit_code?: number; error?: boolean; state?: string }>;
    const ids = probeIds?.length ? probeIds : Object.keys(batch);
    if (!ids.length || (!probeIds?.length && ids.length !== 1)) throw new ReviewRecoveryError("Batched local evidence requires explicit probe_ids for the asserted checks",{code:"invalid_probe_selection",evidence_ref:ref,requested_probe_ids:probeIds??[],available_probes:this.probeSummary(ref),next_op:"conclude"});
    const results = ids.map(id => batch[id]);
    if (results.some(r => !r || typeof r.exit_code !== "number" || r.state !== "completed")) throw new ReviewRecoveryError("Probe evidence must name completed checks with observed exit codes; choose the actual observed IDs for this result, never resend an invalid selection",{code:"invalid_probe_selection",evidence_ref:ref,requested_probe_ids:ids,available_probes:this.probeSummary(ref),next_op:"conclude"});
    return { tool: "bash_probe", error: row.payload.error === true || results.some(r => r?.error === true), exit_code: results.every(r => r?.exit_code === 0) ? 0 : 1 };
  }
  private plannedCase(item: ReviewCase, beginSeq: number) {
    const keys = ["file", "trigger", "production_path", "oracle", "oracle_basis", "scope"] as const;
    let planned: EventRecord | undefined;
    for (const row of this.log.events.filter(e => e.name === "review/case" && e.payload.begin_seq === beginSeq && (e.payload.case as ReviewCase)?.id === item.id)) {
      const previous = row.payload.case as ReviewCase;
      if (keys.some(key => previous[key] !== item[key])) { planned = undefined; continue; }
      if (!planned && previous.result === "gap") planned = row;
    }
    return planned;
  }
  /** Recovery facts are refreshed from observations, never invented proof. */
  recoveryState(recovery: Record<string, any>): Record<string, any> {
    const status = this.status();
    const original = status.cases.find(c => c.id === recovery.case_id);
    if (!original) return { ...recovery, next_op: "case", original: recovery.original, required_fields: ["case"], registered: false };
    const begin = this.snapshot().event;
    const planned = this.plannedCase(original, begin.seq);
    const available_results = (status.evidence as any[]).filter(e => !planned || e.ref > planned.seq);
    const freshLocal = available_results.some(e => !e.error && (e.tool === "bash" ? e.exit_code === 0 : e.tool === "bash_probe" && e.probes?.some((p:any) => p.state === "completed" && p.exit_code === 0 && !p.error)));
    return { ...recovery, original, registered: true, planned_at: planned?.seq, available_results,
      next_op: recovery.code === "stale_evidence" && !freshLocal ? "execute_check_then_conclude" : "conclude" };
  }
  record(input: unknown) {
    const item = reviewCaseSchema.parse(input);
    const { value: s, event: begin } = this.snapshot();
    if (!s.files.includes(item.file)) throw new Error("Case file is outside the changed-file snapshot");
    if (!item.change_refs.length) {
      const windows=this.log.events.filter(e=>e.name==="review/change"&&e.payload.begin_seq===begin.seq&&e.payload.file===item.file);
      const groups=new Map<string,typeof windows>();
      for(const w of windows){const key=String(w.payload.blob);groups.set(key,[...(groups.get(key)??[]),w]);}
      const complete=[...groups.values()].find(rows=>{
        let end=0;for(const w of [...rows].sort((a,b)=>Number(a.payload.offset)-Number(b.payload.offset))){if(Number(w.payload.offset)>end)break;end=Math.max(end,Number(w.payload.end));}
        return end>=Number(rows[0]?.payload.total);
      });
      if(!complete)throw new Error("Read the complete before/after diff before assessing this file");
      item.change_refs=[...new Set(complete.map(e=>e.seq))];
      if(item.change_refs.length>100)throw new Error("Changed-source evidence exceeds the bounded reference limit");
    }
    if (!item.source_refs.length) {
      const source=[...this.log.events].reverse().find(e=>e.name==="review/source"&&e.payload.begin_seq===begin.seq&&e.payload.file===item.file&&e.payload.view!=="baseline"&&BlobStore.forSession(this.log.path).get(String(e.payload.blob)).slice(Number(e.payload.offset),Number(e.payload.end)).includes(item.source_anchor));
      if(!source)throw new Error("source_anchor must quote an observed current-review source window exactly");
      item.source_refs=[source.seq];
    }
    const changes = item.change_refs.map(ref => this.log.events.find(e => e.seq === ref));
    if (changes.some(e => !e || e.name !== "review/change" || e.payload.begin_seq !== begin.seq || e.payload.file !== item.file)) throw new ReviewRecoveryError("Explicit change_refs do not belong to this file/snapshot. Omit mechanical refs to bind actual complete observed source/diff; do not guess IDs.", {code:"invalid_mechanical_refs",file:item.file,omit_fields:["change_refs","source_refs"],next_op:"case"});
    let covered = 0;
    for (const w of changes.sort((a,b) => Number(a!.payload.offset) - Number(b!.payload.offset))) {
      if (Number(w!.payload.offset) > covered) break;
      covered = Math.max(covered, Number(w!.payload.end));
    }
    if (covered < Number(changes[0]!.payload.total)) throw new Error("Read the complete before/after diff before assessing this file");
    for (const ref of item.source_refs) {
      const e = this.log.events.find(e => e.seq === ref);
      if (!e || e.name !== "review/source" || e.payload.begin_seq !== begin.seq || e.payload.file !== item.file) throw new ReviewRecoveryError("Explicit source_refs do not belong to this file/snapshot. Omit mechanical refs and retain an exact observed source_anchor.",{code:"invalid_mechanical_refs",file:item.file,omit_fields:["change_refs","source_refs"],next_op:"case"});
    }
    const sourceText = item.source_refs.map(ref => {
      const row = this.log.events.find(e => e.seq === ref)!;
      return BlobStore.forSession(this.log.path).get(String(row.payload.blob)).slice(Number(row.payload.offset), Number(row.payload.end));
    }).join("\n");
    if (!sourceText.includes(item.source_anchor)) throw new Error("source_anchor must quote the observed source window exactly");
    if (item.result !== "resolved" && !item.closing_action) throw new Error("Unresolved cases require a concrete closing_action");
    if (item.result !== "gap" && ["integration", "system", "gpu"].includes(item.scope) && !item.runtime) throw new Error("Higher-level evidence requires the actual runtime and deployment exercised; helper probes are unit scope");
    if (item.result === "resolved" && item.evidence_kind === "static" && item.scope !== "static") {
      throw new ReviewRecoveryError("Static reasoning cannot claim runtime validation. Attach the actual observed proof kind in evidence_kind; changing limits prose cannot repair this field.", {
        code: "evidence_kind_scope_mismatch", case_id: item.id, original: item,
        next_op: this.status().cases.some(c => c.id === item.id) ? "conclude" : "case",
        required_field: "evidence_kind", allowed_values: ["local", "author"],
      });
    }
    if (item.result === "resolved" && item.evidence_kind === "local") {
      const planned = this.plannedCase(item, begin.seq);
      if(!planned)throw new ReviewRecoveryError("Record this failure hypothesis as gap before executing local evidence; keep trigger/path/oracle/scope fixed", {code:"case_not_planned",case_id:item.id,original:item,next_op:"case",required_field:"result",required_value:"gap"});
      if(item.evidence_refs.some(ref=>ref<=planned.seq)) {
        const stale_refs=item.evidence_refs.filter(ref=>ref<=planned.seq);
        const checks=stale_refs.map(ref=>{
          const result=this.log.events.find(e=>e.seq===ref),call=this.log.events.find(e=>e.name==="tool/call"&&e.payload.id===result?.payload.id);
          return {ref,tool:result?.payload.tool,args:call?.payload.args};
        });
        throw new ReviewRecoveryError(`Local evidence must follow the recorded failure hypothesis at event ${planned.seq}. Preserve this contract and run its relevant check once; retrying stale evidence cannot succeed.`, {code:"stale_evidence",case_id:item.id,planned_at:planned.seq,stale_refs,checks,original:item,next_op:"execute_check_then_conclude"});
      }
    }
    for (const ref of item.evidence_refs) {
      let observed;
      try { observed = this.evidenceResult(ref, item.probe_ids); }
      catch (error) {
        if (error instanceof ReviewRecoveryError) throw new ReviewRecoveryError(error.message, {
          ...error.recovery, ...(error.recovery.code==="invalid_evidence_reference"?{
            evidence_kind:item.evidence_kind,
            available_results:this.log.events.filter(e=>e.name==="tool/result"&&e.payload.error!==true&&(item.evidence_kind==="author"?["github","github_discussion","github_ci"]:["bash","bash_probe"]).includes(String(e.payload.tool))).slice(-5).map(e=>{const call=this.log.events.find(c=>c.name==="tool/call"&&c.payload.id===e.payload.id);return {ref:e.seq,tool:e.payload.tool,args:call?.payload.args,...(e.payload.tool==="bash_probe"?{probes:this.probeSummary(e.seq)}:{})};}),
          }:{}), case_id: item.id, original: item,
          next_op: this.status().cases.some(c => c.id === item.id) ? "conclude" : "case",
        });
        throw error;
      }
      if (item.result === "resolved" && (observed.error || (typeof observed.exit_code === "number" && observed.exit_code !== 0))) throw new Error("Resolved cases require successful evidence");
    }
    const inferredRole = /(?:^|\/)(?:tests?|fixtures?)(?:\/|_)|(?:^|\/)(?:test_[^/]+|[^/]+[.]test[.][^/]+)$/.test(item.file) ? "test"
      : /[.](?:md|rst)$/.test(item.file) ? "documentation" : "production";
    if (item.role === "production" && !item.oracle_basis) throw new Error("Production hypotheses require oracle_basis grounded in requirements, callers, tests or a justified invariant; baseline behavior alone is not a specification");
    if (item.role !== inferredRole) throw new Error(`Changed-file role must be ${inferredRole}; configuration and scripts remain production review scope`);
    const previous = this.status().cases.find(c => c.id === item.id);
    const contractKeys = ["file", "trigger", "production_path", "oracle", "oracle_basis", "scope"] as const;
    if (previous && contractKeys.some(key => previous[key] !== item[key]) && !item.plan_change_reason) {
      throw new ReviewRecoveryError(`Existing hypothesis ${item.id} is preserved. Use op=conclude to attach evidence and keep trigger/path/oracle/scope fixed; intentional contract changes require plan_change_reason and a new planned execution.`, {code:"hypothesis_changed",case_id:item.id,original:previous,next_op:"conclude"});
    }
    if (item.result === "resolved") {
      if (item.evidence_kind === "static") {
        if (!item.static_reasoning || item.static_reasoning.length < 32) throw new ReviewRecoveryError("Static resolution requires specific source reasoning about the failure trigger and oracle", {code:"static_proof_missing",case_id:item.id,original:item,next_op:previous?"conclude":"case",required_field:"static_reasoning"});
        if (item.scope !== "static") throw new Error("Static reasoning cannot claim runtime validation");
      } else {
        if (!item.evidence_refs.length) throw new Error("Resolved runtime cases require observed evidence_refs");
        if (item.evidence_kind === "local") {
          const matched = this.workspaceMatches(s.head);
          this.log.append({ kind: "observe", name: "review/workspace", payload: { begin_seq: begin.seq, head: s.head, evidence_refs: item.evidence_refs, matched } });
          if (!matched) throw new Error("Local evidence workspace differs from reviewed head; restore the exact checkout before validation");
        }
        for (const ref of item.evidence_refs) {
          const e = this.log.events.find(e => e.seq === ref);
          if (!e || e.name !== "tool/result") throw new Error("Evidence must reference an observed tool/result; use status.evidence[].ref, not a CI/source/mapping reference");
          const observed = this.evidenceResult(ref, item.probe_ids);
          if (observed.error || (typeof observed.exit_code === "number" && observed.exit_code !== 0)) throw new Error("Resolved cases require successful evidence; preserve failed checks as risks/gaps");
          if (item.evidence_kind === "local" && (!["bash", "bash_probe"].includes(String(observed.tool)) || observed.exit_code !== 0)) throw new Error("Local evidence requires a successful bash result with observed exit_code; use a single assertion command");
          if (item.evidence_kind === "author" && !["github", "github_discussion", "github_ci"].includes(String(e.payload.tool))) throw new Error("External evidence requires an authenticated GitHub result, not a model-written artifact");
        }
        if (item.evidence_kind === "author") {
          if (!item.validated_revision) throw new ReviewRecoveryError("Author evidence requires validated_revision. Attach the observed reviewed-source revision using recovery.next_op; an upstream asset SHA is not a revision of this workspace file. For an originally static contract, specific static reasoning may use authenticated asset data without claiming runtime execution.",{code:"author_revision_missing",case_id:item.id,original:item,next_op:previous?"conclude":"case",required_field:"validated_revision"});
          const reports = item.evidence_refs.map(ref => {
            const e = this.log.events.find(e => e.seq === ref)!;
            const body=this.probeBody(e);
            if(e.payload.tool==="github_ci") {
              try {
                const envelope=JSON.parse(body);
                const source=this.log.events.find(row=>row.seq===envelope.source_ref&&row.name==="github_ci/result");
                if(source&&typeof source.payload.source_blob==="string") return BlobStore.forSession(this.log.path).get(source.payload.source_blob);
              } catch { /* Legacy direct authenticated report remains usable. */ }
            }
            return body;
          }).join("\n");
          const recordedRefs = reports.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
          if (!recordedRefs.some(ref => item.validated_revision!.startsWith(ref))) throw new Error("validated_revision must match a revision in the authenticated author evidence");
          this.git(["cat-file", "-e", `${item.validated_revision}^{commit}`]);
          // The host checks the changed production tree, not a model's claim of equivalence.
          const paths = [item.file];
          const delta = this.git(["diff", "--no-ext-diff", "--no-textconv", item.validated_revision, s.head, "--", ...paths]);
          const blob = BlobStore.forSession(this.log.path).put(delta);
          this.log.append({ kind: "observe", name: "review/mapping", payload: { begin_seq: begin.seq, case_id: item.id, validated_revision: item.validated_revision, head: s.head, paths, blob, identical: !delta.length, ...(item.revision_delta_reasoning ? { reasoning: item.revision_delta_reasoning } : {}) } });
          if (delta.length) {
            const windows = (item.mapping_refs ?? []).map(ref => this.log.events.find(e => e.seq === ref));
            if (windows.some(e => !e || e.name !== "review/comparison" || e.payload.begin_seq !== begin.seq || e.payload.file !== item.file || e.payload.revision !== item.validated_revision)) throw new Error("Revision mapping refs must name observed comparisons for this case");
            let covered = 0;
            for (const w of windows.sort((a,b) => Number(a!.payload.offset) - Number(b!.payload.offset))) {
              if (Number(w!.payload.offset) > covered) break;
              covered = Math.max(covered, Number(w!.payload.end));
            }
            if (covered < delta.length) throw new Error("Read the complete revision delta with review_assessment compare before accepting author evidence");
          }
          if (delta.length && (!item.revision_delta_reasoning || item.revision_delta_reasoning.length < 32)) throw new Error("Author revision has a delta; inspect it and explain why the specific oracle remains valid in revision_delta_reasoning, or supply current-head evidence");
        }
      }
    }
    this.log.append({ kind: "observe", name: "review/case", payload: { begin_seq: begin.seq, case: item } });
    return this.status();
  }
  conclude(id: string, update: { result: ReviewCase["result"]; evidence_refs: number[]; probe_ids?: string[]; closing_action?: string; limits?: string; evidence_kind?: ReviewCase["evidence_kind"]; static_reasoning?: string; validated_revision?: string; runtime?: string; revision_delta_reasoning?: string; mapping_refs?: number[] }) {
    const original = this.status().cases.find(c => c.id === id);
    if (!original) throw new ReviewRecoveryError("Plan this case before concluding it; no case was recorded by a refused call", {code:"case_not_planned",case_id:id,next_op:"case",registered:false,available_cases:this.status().cases.map(c=>({id:c.id,file:c.file}))});
    return this.record({ ...original, ...update });
  }
  status(): { snapshot: Snapshot; cases: ReviewCase[]; evidence: unknown[]; approval_gaps: string[]; unassessed_files: string[]; source_gaps: string[] } {
    const { value: snapshot, event: begin } = this.snapshot();
    const cases = new Map<string, ReviewCase>();
    for (const e of this.log.events) if (e.name === "review/case" && e.payload.begin_seq === begin.seq) {
      const c = reviewCaseSchema.parse(e.payload.case); cases.set(c.id, c);
    }
    const items = [...cases.values()];
    const unassessed_files = snapshot.files.filter(f => !items.some(c => c.file === f));
    const source_gaps: string[] = [];
    const gaps = unassessed_files.map(f => `Unassessed changed file: ${f}`);
    for (const c of items) {
      if (c.role === "production" && !c.oracle_basis) gaps.push(`${c.file}: missing requirement/caller/test/invariant oracle_basis`);
      if (c.result !== "resolved") gaps.push(`${c.file}: ${c.result}: ${c.closing_action}`);
      // Source windows must cover the changed file without omitted characters.
      const windows = this.log.events.filter(e => e.name === "review/source" && e.payload.begin_seq === begin.seq && e.payload.file === c.file && e.payload.view !== "baseline");
      const groups = new Map<string,typeof windows>();
      for (const w of windows) { const key=String(w.payload.blob);groups.set(key,[...(groups.get(key)??[]),w]); }
      const complete = [...groups.values()].some(group => {
        let end=0;
        for(const w of group.sort((a,b)=>Number(a.payload.offset)-Number(b.payload.offset))){if(Number(w.payload.offset)>end)break;end=Math.max(end,Number(w.payload.end));}
        return end>=Number(group[0]?.payload.total);
      });
      if (!complete) { source_gaps.push(c.file); gaps.push(`${c.file}: source windows incomplete; continue the same region with next_offset or read all changed-context windows with region=changes`); }
    }
    const evidence = this.log.events.filter(e => e.name === "tool/result" && ["bash", "bash_probe", "github", "github_ci", "github_discussion"].includes(String(e.payload.tool))).slice(-60).map(e => {
      const source=this.log.events.filter(r=>r.name==="tool/source"&&r.payload.id===e.payload.id&&r.payload.tool===e.payload.tool&&r.seq<e.seq).at(-1);
      const call=this.log.events.find(c=>c.name==="tool/call"&&c.payload.id===e.payload.id&&c.seq<e.seq);
      return {ref:e.seq,tool:e.payload.tool,error:e.payload.error,exit_code:e.payload.exit_code,args:call?.payload.args,call:this.log.events.find(c=>c.name==="tool/start"&&c.payload.id===e.payload.id)?.payload.arg_hint,source_blob:source?.payload.blob??e.payload.blob,summary_is_partial:String(e.payload.text).length>500,summary:String(e.payload.text).slice(0,500),...(e.payload.tool==="bash_probe"?{probes:this.probeSummary(e.seq)}:{})};
    });
    return { snapshot, cases: items, evidence, approval_gaps: gaps, unassessed_files, source_gaps };
  }
  progress(requestedFile?: string) {
    const {event:begin}=this.snapshot();const status=this.status();
    const file=requestedFile??status.unassessed_files[0]??status.source_gaps[0]??status.cases.find(c=>c.result!=="resolved")?.file;
    if(file&&!status.snapshot.files.includes(file))throw Error("Progress file is outside the changed-file snapshot");
    const covered=(name:string)=>{
      const rows=this.log.events.filter(e=>e.name===name&&e.payload.begin_seq===begin.seq&&e.payload.file===file&&e.payload.view!=="baseline");
      const groups=new Map<string,typeof rows>();
      for(const row of rows){const key=String(row.payload.blob);groups.set(key,[...(groups.get(key)??[]),row]);}
      const views=[...groups.values()].map(windows=>{
        let end=0;for(const row of [...windows].sort((a,b)=>Number(a.payload.offset)-Number(b.payload.offset))){if(Number(row.payload.offset)>end)break;end=Math.max(end,Number(row.payload.end));}
        const total=Number(windows[0]!.payload.total);
        return {complete:end>=total,region:windows[0]!.payload.region,next_offset:end>=total?null:end,refs:windows.map(w=>w.seq),blob:windows[0]!.payload.blob};
      });
      return views.find(v=>v.complete)??views[0];
    };
    const source=covered("review/source"),change=covered("review/change");
    const assessed=status.cases.some(c=>c.file===file);
    const next_op=!file?"audit":!change?.complete?"change":!source?.complete?"source":!assessed?"case":"conclude";
    return {file,assessed,next_op,source,change,next_action:"Reuse recorded refs and retained blob evidence. Unassessed means the model's case reasoning is missing, not that inspected source needs another Git read. Register the grounded case or close its actual gap; use returned continuation only for incomplete windows."};
  }
  check(target: string, number: number, head: string, base?: string): string | undefined {
    let reason: string | undefined;
    try {
      const status = this.status();
      if (status.snapshot.target.toLowerCase() !== target.toLowerCase() || status.snapshot.number !== number || status.snapshot.head !== head || (base !== undefined && status.snapshot.base !== base)) reason = "Review assessment target/head/base changed; begin and assess the current head";
      else if (status.approval_gaps.length) reason = status.approval_gaps.join("\n");
    } catch (error) { reason = error instanceof Error ? error.message : "Invalid review assessment"; }
    this.log.append({ kind: "observe", name: "review/check", payload: { target, number, head, status: reason ? "incomplete" : "ready", ...(reason ? { reason } : {}) } });
    return reason;
  }
  checkFindings(target: string, number: number, head?: string, base?: string): string | undefined {
    let reason: string | undefined;
    try {
      const status = this.status();
      if (status.snapshot.target.toLowerCase() !== target.toLowerCase() || status.snapshot.number !== number
        || (head !== undefined && status.snapshot.head !== head) || (base !== undefined && status.snapshot.base !== base)) {
        reason = "Review assessment target/head/base changed; investigate the current scope";
      } else if (!status.cases.some(c => c.change_refs.length && c.source_refs.length)) {
        reason = "Inspect actual changed source and record a grounded case before publishing; metadata or unperformed work is not missing developer evidence";
      }
    } catch (error) { reason = error instanceof Error ? error.message : "Invalid review assessment"; }
    this.log.append({ kind:"observe", name:"review/publication_check", payload:{target,number,...(head?{head}:{}),status:reason?"incomplete":"grounded",...(reason?{reason}:{})} });
    return reason;
  }
}
