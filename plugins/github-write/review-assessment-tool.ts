import type { AgentTool } from "@earendil-works/pi-agent-core";
import {createHash} from "node:crypto";
import {isTrackedWorkspacePath} from "../../src/plugins/workspace-tools.ts";
import {portableTargetIo} from "../../src/host/workspace-target-io.ts";
import {LinkSafeWorkspaceExecutionEnv} from "../../src/host/workspace-execution-env.ts";
import {containsSecret} from "../../src/host/redact.ts";
import { Type } from "typebox";
import type { HostContext } from "../../src/loader/types.ts";
import {BlobStore} from "../../src/host/blob-store.ts";
import {currentReviewBegin} from "../github/review-state.ts";
import { ReviewWorkflow } from "./review-workflow.ts";
import { ReviewAssessment, ReviewRecoveryError } from "./review-assessment.ts";

const Text = Type.String({ minLength: 8, maxLength: 4000 });
const Refs = Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 100 });
const Case = Type.Object({
  id: Type.String(), file: Type.String(), plan_change_reason: Type.Optional(Text),
  role: Type.Union([Type.Literal("production"), Type.Literal("test"), Type.Literal("documentation")]),
  trigger: Text, production_path: Text, source_anchor: Type.String({ minLength: 8, maxLength: 4000, description: "Literal quote copied from source text, not a file/symbol description." }), oracle: Text, oracle_basis: Type.Optional(Type.String({ minLength: 8, maxLength: 4000, description: "Required for production: identify the actual requirement/caller/test/invariant grounding this oracle. Do not invent a contract from a parameter name or assume base behavior is intended." })),
  static_reasoning: Type.Optional(Text), revision_delta_reasoning: Type.Optional(Text), mapping_refs: Type.Optional(Refs),
  scope: Type.Union(["static", "unit", "integration", "system", "gpu"].map(v => Type.Literal(v))),
  evidence_kind: Type.Union(["static", "local", "author"].map(v => Type.Literal(v))),
  change_refs: Type.Optional(Refs), source_refs: Type.Optional(Refs), evidence_refs: Refs, probe_ids: Type.Optional(Type.Array(Type.String())),
  result: Type.Union(["resolved", "risk", "gap"].map(v => Type.Literal(v)), { description: "resolved = safety oracle satisfied/no defect; risk = confirmed code defect; gap = still unverified. A failed assertion confirming a defect is risk, never resolved." }),
  limits: Text, runtime: Type.Optional(Text),
  validated_revision: Type.Optional(Type.String()), closing_action: Type.Optional(Type.String({ minLength: 8, maxLength: 4000, description: "Mandatory for gap/risk: minimal developer action that closes this specific case." })),
}, { additionalProperties: false });
const Parameters = Type.Object({
  op: Type.Union(["begin", "source", "change", "compare", "case", "conclude", "status", "task", "audit", "finish"].map(v => Type.Literal(v))),
  owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()),
  number: Type.Optional(Type.Integer({ minimum: 1 })),
  head: Type.Optional(Type.String({pattern:"^[0-9a-f]{40}$",description:"Full observed SHA. Omit both head/base to bind the current authenticated PR metadata; never copy abbreviated SHAs or branch names."})), base: Type.Optional(Type.String({pattern:"^[0-9a-f]{40}$",description:"Full authenticated PR base SHA, or omit with head for host binding."})),
  revision: Type.Optional(Type.String()), file: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
  region: Type.Optional(Type.Union([Type.Literal("changes"),Type.Literal("full")],{description:"source region=changes retains all changed hunks plus context, avoiding unrelated large prefixes; full preserves whole-file view. Keep region fixed across next_offset windows."})),
  case_id: Type.Optional(Type.String()),
  result: Type.Optional(Type.Union(["resolved", "risk", "gap"].map(v => Type.Literal(v)))),
  evidence_refs: Type.Optional(Refs), probe_ids: Type.Optional(Type.Array(Type.String())),
  closing_action: Type.Optional(Text), limits: Type.Optional(Text),
  evidence_kind: Type.Optional(Type.Union(["static","local","author"].map(v=>Type.Literal(v)))),
  static_reasoning: Type.Optional(Text), validated_revision: Type.Optional(Type.String()), runtime: Type.Optional(Text),
  revision_delta_reasoning: Type.Optional(Text), mapping_refs: Type.Optional(Refs),
  case: Type.Optional(Case),
  task: Type.Optional(Type.Object({publish_general:Type.Boolean(),publish_review:Type.Boolean(),operator_quote:Text,report_path:Type.String({description:"Private JSON report under work/, preferably the exact operator-requested output path. finish writes it from verified records."})},{additionalProperties:false})),
  audit: Type.Optional(Type.Object({verdict:Type.Union(["APPROVE","REQUEST_CHANGES","COMMENT"].map(v=>Type.Literal(v))),reasoning:Text,dependencies:Type.Array(Type.Object({case_id:Type.String(),kind:Type.Union(["external_run","deployment_asset","author_measurement"].map(v=>Type.Literal(v))),evidence_ref:Type.Integer({minimum:1}),source_anchor:Text,closing_action:Text},{additionalProperties:false}),{maxItems:100})},{additionalProperties:false})),
}, { additionalProperties: false });

function observedSnapshot(ctx:HostContext,owner:string,repo:string,number:number){
 const user=ctx.log.events.filter(e=>e.name==="user/message").at(-1);
 const rows=ctx.log.events.filter(e=>e.seq>(user?.seq??0)&&e.name==="tool/result"&&e.payload.tool==="github"&&e.payload.error!==true);
 for(const row of rows.reverse()){
  const call=ctx.log.events.find(e=>e.name==="tool/call"&&e.payload.id===row.payload.id),args=call?.payload.args as any;
  if(args?.op!=="pull"||args.owner!==owner||args.repo!==repo||args.number!==number)continue;
  const source=ctx.log.events.filter(e=>e.seq<row.seq&&e.name==="tool/source"&&e.payload.tool==="github"&&e.payload.id===row.payload.id).at(-1);
  try{
   const raw=source?BlobStore.forSession(ctx.log.path).get(String(source.payload.blob)):String(row.payload.raw??row.payload.text??"");
   const pr=JSON.parse(raw.replace(/\n\n\[slow: [^\n]*\]\s*$/,"")).pulls?.[0];
   if(!/^[0-9a-f]{40}$/.test(pr?.headRefOid??"")||!/^[0-9a-f]{40}$/.test(pr?.baseRefOid??""))return undefined;
   return {head:pr.headRefOid as string,base:pr.baseRefOid as string,metadata_ref:row.seq};
  }catch{return undefined;}
 }
}

export function reviewReportMatches(workspace:string,path:string,digest:string):boolean {
  try{const file=portableTargetIo(workspace).inspect(path);return file.state==="file"&&createHash("sha256").update(file.bytes).digest("hex")===digest;}catch{return false;}
}
/** Keep actionable recovery metadata ahead of retained, possibly large contracts. */
export function visibleReviewRecovery(value:Record<string,unknown>):Record<string,unknown>{
 const {original,available_results,checks,...action}=value;
 return {...action,...(checks!==undefined?{checks}:{}),...(available_results!==undefined?{available_results}:{}),...(original!==undefined?{original}:{})};
}

export function createReviewAssessmentTool(ctx: HostContext, workflow = new ReviewWorkflow(ctx.log, new ReviewAssessment(ctx.log, ctx.workspaceRoot),(path,digest)=>reviewReportMatches(ctx.workspaceRoot,path,digest))): AgentTool<typeof Parameters> {
  const ledger = new ReviewAssessment(ctx.log, ctx.workspaceRoot);
  return {
    name: "review_assessment", label: "review assessment",
    description: "Workflow: begin, then task(publication booleans, literal operator_quote and report_path under work/), inspect/plan/validate, audit(verdict, self-critical reasoning, dependencies), authorized delivery, finish (host refreshes live PR/CI and writes the verified JSON report at task.report_path; do not replace it with a stale model draft). COMMENT dependencies need authenticated exact source quotes; unreviewed files/host setup/static or unit work cannot become external holds. Higher-level external obligations need actual authenticated dependency evidence. Repeated audits with identical facts/contracts preserve their original checkpoint. status(case_id) retrieves one original contract; default status is compact. Existing hypothesis changes require explicit plan_change_reason; use conclude to preserve the contract. Operations: begin needs owner/repo/number; omit head/base to bind current authenticated metadata automatically (explicit mismatches refuse); change needs file/offset and exposes BEFORE/AFTER diff with change_ref; source needs file/offset and exposes source_ref; compare needs file/revision/offset (author revision mapping, not PR base/head); case needs case object (source_anchor must be an exact observed quote; omit mechanical change_refs/source_refs to let the host bind complete current-file diff and matching observed source; explicit invalid refs are still refused); conclude needs case_id/result/evidence_refs; optional evidence_kind/static_reasoning/validated_revision/runtime/mapping_refs/revision_delta_reasoning attach proof without changing the original scope or oracle; optional probe_ids/limits/closing_action, preserving the planned trigger/path/oracle/scope; status(file optional) exposes retained read progress and exact refs before gaps; do not reread a complete file just because it is unassessed. Build a durable exact-head review: begin snapshots changed files from sealed Git; source reads exact revision source with source_ref and next_offset; case requires a complete observed before/after diff and records a concrete failure trigger, production path, oracle, actual scope/limits and observed evidence refs; status lists gaps and tool-result refs. All changed files need resolved cases before APPROVE. Author GPU/CI evidence is accepted from github results with a validated_revision whose assessed production paths match the head. Unit/helper probes cannot claim system/GPU coverage. Does not post or approve.",
    parameters: Parameters,
    async execute(_id, p) {
      try {
        let result: unknown;
        switch (p.op) {
          case "task": result=workflow.task(p.task); break;
          case "audit": result=workflow.audit(p.audit); break;
          case "finish": {
            await workflow.refreshLive(); result=workflow.finish();
            const report=workflow.report(),body=JSON.stringify(report.value,null,2)+"\n",digest=createHash("sha256").update(body).digest("hex");
            if(containsSecret(body))throw Error("Private review report contains secret material");
            if(isTrackedWorkspacePath(ctx.workspaceRoot,report.path,ctx.log))throw Error("Private review report cannot overwrite a tracked source file");
            const blob=BlobStore.forSession(ctx.log.path).put(body);
            ctx.log.append({kind:"effect",name:"review/report_write",payload:{path:report.path,digest,blob,finish_ref:report.value.finish_ref}});
            // This is a host-generated outcome, not a model file mutation. The
            // dedicated writer retains link/inode containment and tracked-source
            // checks without fabricating a model read receipt for canonical bytes.
            const outcome=await new LinkSafeWorkspaceExecutionEnv(ctx.workspaceRoot,"write").writeFile(report.path,body);
            if(!outcome.ok)throw Error(`Private review report write refused: ${outcome.error.message}`);
            if(!reviewReportMatches(ctx.workspaceRoot,report.path,digest))throw Error("Private review report bytes could not be verified");
            ctx.log.append({kind:"observe",name:"review/report_result",payload:{begin_seq:currentReviewBegin(ctx.log.events)?.seq,finish_ref:report.value.finish_ref,path:report.path,digest,blob,status:"completed"}});
            result={...(result as object),report_path:report.path,report_digest:digest};
            break;
          }
          case "begin":
            if (!p.owner || !p.repo || !p.number) throw new Error("begin requires owner, repo and number");
            {
              const observed=observedSnapshot(ctx,p.owner,p.repo,p.number);
              if(observed&&((p.head!==undefined&&p.head!==observed.head)||(p.base!==undefined&&p.base!==observed.base)))throw new ReviewRecoveryError("Explicit revisions differ from this PR's current authenticated metadata. Omit both head/base to bind the observed pair; do not reconstruct hashes.",{code:"snapshot_mismatch",next_op:"begin",next_args:{owner:p.owner,repo:p.repo,number:p.number},observed});
              const head=p.head??observed?.head,base=p.base??observed?.base;
              if(!head||!base)throw new ReviewRecoveryError("Read current authenticated github op=pull for this PR, then begin with owner/repo/number; the host binds exact retained revisions.",{code:"snapshot_metadata_missing",next_tool:"github",next_args:{op:"pull",owner:p.owner,repo:p.repo,number:p.number}});
              result=ledger.begin(`${p.owner}/${p.repo}`,p.number,head,base);
              if(observed)ctx.log.append({kind:"observe",name:"review/snapshot_binding",payload:{begin_seq:currentReviewBegin(ctx.log.events)?.seq,target:`${p.owner}/${p.repo}`,number:p.number,...observed,derived:p.head===undefined||p.base===undefined}});
            }
            break;
          case "source":
            if (!p.file) throw new Error("source requires file");
            result = ledger.source(p.file, p.offset ?? 0, p.revision, p.region); break;
          case "change":
            if (!p.file) throw new Error("change requires file and optional offset");
            result = ledger.change(p.file, p.offset ?? 0); break;
          case "compare":
            if (!p.file || !p.revision) throw new Error("compare requires file and validated revision");
            result = ledger.compare(p.file, p.revision, p.offset ?? 0); break;
          case "case": {
            const status = ledger.record(p.case);
            result = { recorded: p.case?.id, approval_gaps: status.approval_gaps }; break;
          }
          case "conclude": {
            if (!p.case_id || !p.result || !p.evidence_refs) throw new Error("conclude requires case_id, result and evidence_refs; use probe_ids for batches");
            const status = ledger.conclude(p.case_id, { result: p.result, evidence_refs: p.evidence_refs, ...(p.probe_ids ? { probe_ids: p.probe_ids } : {}), ...(p.closing_action ? { closing_action: p.closing_action } : {}), ...(p.limits ? { limits: p.limits } : {}), ...(p.evidence_kind?{evidence_kind:p.evidence_kind}:{}), ...(p.static_reasoning?{static_reasoning:p.static_reasoning}:{}), ...(p.validated_revision?{validated_revision:p.validated_revision}:{}), ...(p.runtime?{runtime:p.runtime}:{}), ...(p.revision_delta_reasoning?{revision_delta_reasoning:p.revision_delta_reasoning}:{}), ...(p.mapping_refs?{mapping_refs:p.mapping_refs}:{}) });
            result = { recorded: p.case_id, approval_gaps: status.approval_gaps }; break;
          }
          case "status": {
            const status = ledger.status();
            ledger.check(status.snapshot.target, status.snapshot.number, status.snapshot.head);
            result = { navigation: ledger.progress(p.file), next_action: workflow.pending(), approval_gaps: status.approval_gaps, snapshot: status.snapshot,
              cases: p.case_id ? status.cases.filter(c=>c.id===p.case_id) : status.cases.map(c=>({id:c.id,file:c.file,result:c.result,scope:c.scope,evidence_kind:c.evidence_kind,evidence_refs:c.evidence_refs,closing_action:c.closing_action})), evidence: status.evidence }; break;
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { error: false } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Review assessment failed";
        const recovery=error instanceof ReviewRecoveryError?visibleReviewRecovery(error.recovery):undefined;
        ctx.log.append({ kind: "observe", name: "review/refused", payload: { op: p.op, reason: message, ...(recovery?{recovery}:{}) } });
        return { content: [{ type: "text", text: JSON.stringify({error:"review_refused",message,...(recovery?{recovery}:{})}) }], details: { error: true } };
      }
    },
  };
}
