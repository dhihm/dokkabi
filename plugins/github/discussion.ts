import {Type} from 'typebox';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {HostContext} from '../../src/loader/types.ts';
import type {EventLog} from '../../src/host/event-log.ts';
import {redactText} from '../../src/host/redact.ts';
type Stream='comments'|'reviews'|'inline_comments'|'threads';
interface Request {owner:string;repo:string;number:number;stream:Stream}
type Runner=(argv:string[])=>Promise<string>;
const runner:Runner=async argv=>{
 const r=Bun.spawnSync(argv,{cwd:'/',stdout:'pipe',stderr:'pipe',timeout:45_000,maxBuffer:32*1024*1024});
 if(r.exitCode!==0)throw new Error(redactText(r.stderr.toString()).slice(0,300));
 return r.stdout.toString();
};
/** Each stream owns its completeness; PR-list completeness is unrelated. */
export async function githubDiscussionRead(log:EventLog,p:Request,run:Runner=runner){
 try{
  if(![p.owner,p.repo].every(v=>/^[A-Za-z0-9_.-]+$/.test(v)&&v!=='.'&&v!=='..')||!Number.isSafeInteger(p.number)||p.number<=0)throw new Error('Invalid repository or PR number');
  const target=`${p.owner}/${p.repo}`;
  let argv:string[];
  if(p.stream==='threads'){
   const query='query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated path line comments(first:1){nodes{databaseId url}}} pageInfo{hasNextPage endCursor}}}}}';
   argv=['gh','api','graphql','--paginate','--slurp','-f',`query=${query}`,'-f',`owner=${p.owner}`,'-f',`repo=${p.repo}`,'-F',`number=${p.number}`];
  }else{
   const paths={comments:`issues/${p.number}/comments`,reviews:`pulls/${p.number}/reviews`,inline_comments:`pulls/${p.number}/comments`};
   const path=paths[p.stream];if(!path)throw new Error('Unsupported discussion stream');
   argv=['gh','api',`repos/${target}/${path}?per_page=100`,'--paginate','--slurp'];
  }
  log.append({kind:'effect',name:'github_discussion/read',payload:{repo:target,number:p.number,stream:p.stream}});
  const pages=JSON.parse(redactText(await run(argv)));
  let complete=Array.isArray(pages)&&pages.length>0;
  if(p.stream==='threads'){
   complete=complete&&pages.every((page:any)=>!page.errors?.length&&Array.isArray(page.data?.repository?.pullRequest?.reviewThreads?.nodes))&&pages.at(-1)?.data?.repository?.pullRequest?.reviewThreads?.pageInfo?.hasNextPage===false;
  }else complete=complete&&pages.every((page:unknown)=>Array.isArray(page));
  const report={repo:target,number:p.number,stream:p.stream,complete,observed_at:new Date().toISOString(),pages};
  log.append({kind:'observe',name:'github_discussion/result',payload:{repo:target,number:p.number,stream:p.stream,complete}});
  return {error:!complete,text:JSON.stringify(report)};
 }catch(e){const reason=redactText(e instanceof Error?e.message:'Discussion read failed');log.append({kind:'observe',name:'github_discussion/refused',payload:{reason}});return {error:true,text:JSON.stringify({complete:false,error:reason})};}
}
const Parameters=Type.Object({owner:Type.String(),repo:Type.String(),number:Type.Integer({minimum:1}),stream:Type.Union(['comments','reviews','inline_comments','threads'].map(v=>Type.Literal(v)))},{additionalProperties:false});
export function createGithubDiscussionTool(ctx:HostContext):AgentTool<typeof Parameters>{return {name:'github_discussion',label:'GitHub PR discussion',parameters:Parameters,description:'Read authenticated PR discussion. Fetch four independent streams: comments (general PR comments), reviews (submitted review bodies/states), inline_comments (all inline comments/replies), threads (resolved/outdated state and root comment databaseId). All API pages are retained with authors, timestamps, URLs and bodies. complete applies ONLY to this stream. Match inline in_reply_to_id or root id to threads root databaseId for resolution. Use probe_log with the actual advertised source ref if output is truncated; do not refetch or use github offset, which is only for pulls. No previous-read watermark exists unless supplied by the operator: report latest activity with dates, not invented newness. Threads comments(first:1) identifies each root; full reply bodies come from inline_comments.',async execute(_id,p){const r=await githubDiscussionRead(ctx.log,p);return {content:[{type:'text',text:r.text}],details:{error:r.error}};}};}
