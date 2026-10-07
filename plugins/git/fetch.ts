import type { EventLog } from "../../src/host/event-log.ts";
import { parseGithubRemote } from "../../src/host/github-write.ts";
import { githubAuthorization } from "../../src/host/github-repo-push.ts";
import { sealedGitConfigFile, spawnSealedHostGit } from "../../src/host/git-authority.ts";
interface Dependencies {
 origin(): string;
 authentication(): { status:number; authorization?:string };
 run(args:readonly string[],header?:string):number;
}
/** Object-only read from the workspace origin; never updates a ref or checkout. */
export function fetchGithubRevision(workspace:string,revision:string,log:EventLog,deps?:Dependencies):{text:string;error:boolean} {
 let reason="host_refused";
 try {
  reason="invalid_revision";
  if(!/^[a-f0-9]{40}$/.test(revision))throw Error("fetch_revision requires a full commit SHA");
  const origin=deps?.origin()??sealedGitConfigFile(workspace,["--get","remote.origin.url"]).stdout.toString().trim();
  reason="invalid_origin";
  const repository=parseGithubRemote(origin);
  if(!repository)throw Error("fetch_revision requires the workspace GitHub origin");
  reason="authentication_unavailable";
  const auth=deps?.authentication()??githubAuthorization(workspace);
  if(auth.status!==0||!auth.authorization)throw Error("GitHub authentication unavailable for revision fetch");
  const run=deps?.run??((args,header)=>spawnSealedHostGit(workspace,args,{timeoutMs:60_000,...(header?{httpsAuthHeader:header}:{})}).exitCode);
  log.append({kind:"effect",name:"git/fetch",payload:{repository,revision}});
  reason="fetch_failed";
  const code=run(["-c","protocol.https.allow=always","-c","http.followRedirects=false","fetch","--no-tags","--no-write-fetch-head","--no-recurse-submodules",`https://github.com/${repository}.git`,revision],auth.authorization);
  if(code!==0)throw Error("Exact revision fetch failed");
  reason="commit_unavailable";
  if(run(["cat-file","-e",`${revision}^{commit}`])!==0)throw Error("Fetched revision is not an available commit");
  log.append({kind:"observe",name:"git/fetch_result",payload:{repository,revision,status:"completed"}});
  return {text:JSON.stringify({repository,revision,status:"available",refs_changed:false}),error:false};
 }catch{
  // Host errors may contain transport credentials or private coordinates.
  log.append({kind:"observe",name:"git/fetch_result",payload:{status:"refused",reason}});
  return {text:`Exact GitHub revision fetch failed (${reason}). No checkout or refs changed.`,error:true};
 }
}
