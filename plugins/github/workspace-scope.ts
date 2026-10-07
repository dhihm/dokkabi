import {createHash} from "node:crypto";
import type {EventRecord} from "../../src/host/schema.ts";
import type {EventLog} from "../../src/host/event-log.ts";
import type {RequestContextDecision,RequestContextContribution} from "../../src/loader/types.ts";
import {sealedGitConfigFile} from "../../src/host/git-authority.ts";
import {parseGithubRemote} from "../../src/host/github-write.ts";
import {currentReviewBegin} from "./review-state.ts";
/** Informational host facts, never task or permission inference. */
export function workspaceScopeDecision(events:readonly EventRecord[],repository?:string):RequestContextDecision {
 if(!repository)return {action:"none"};
 const userSeq=events.filter(e=>e.name==="user/message").at(-1)?.seq??0;
 if(events.some(e=>{
  if(e.name!=="context/frame")return false;
  const p=e.payload.schema==="host-context-frame-v1"?e.payload.contribution as Record<string,unknown>:e.payload;
  return p?.schema==="github-workspace-scope-v1"&&p.user_seq===userSeq&&p.repository===repository;
 }))return {action:"none"};
 const prior=currentReviewBegin(events);
 const matched=prior?.payload.target===repository?{number:prior.payload.number,head:prior.payload.head,base:prior.payload.base}:null;
 const frameId=`cf-${(events.at(-1)?.seq??0)+1}`;
 const text=`[dokkabi context frame ${frameId}]\nHost-confirmed workspace GitHub origin: ${repository}. Use it as the repository default; the operator's explicit repository takes precedence. Do not guess an owner from a model/provider name. ${matched?`Prior recorded review: ${repository} PR #${matched.number}, head ${matched.head}, base ${matched.base}. This is historical evidence, not a current-head claim; verify live metadata before continuing or publishing.`:"No matching prior review snapshot is recorded."} Publication decisions still follow the operator's persistent authorization and requested scope.`;
 return {action:"record",frameId,present:true,text,payload:{schema:"github-workspace-scope-v1",frame_id:frameId,user_seq:userSeq,repository,prior_review:matched,blob:createHash("sha256").update(text).digest("hex"),blob_bytes:Buffer.byteLength(text)}};
}
export function workspaceScopeContribution(workspace:string,log:EventLog):RequestContextContribution {
 return {mode:"on",prepare(){
  try {const result=sealedGitConfigFile(workspace,["--get","remote.origin.url"]);return workspaceScopeDecision(log.events,result.exitCode===0?parseGithubRemote(result.stdout.toString().trim()):undefined);}
  catch {return {action:"none"};}
 }};
}
