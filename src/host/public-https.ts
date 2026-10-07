import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { checkServerIdentity } from "node:tls";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(address,prefix,"ipv4");
for (const [address,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]] as const) blocked.addSubnet(address,prefix,"ipv6");
const globalV6=new BlockList();globalV6.addSubnet("2000::",3,"ipv6");
export function isPublicAddress(address:string):boolean {
 const family=isIP(address);
 return family===4 ? !blocked.check(address,"ipv4") : family===6 && globalV6.check(address,"ipv6") && !blocked.check(address,"ipv6");
}
type Answer={address:string;family:number};
type Resolver=(hostname:string)=>Promise<Answer[]>;
const resolveAll:Resolver=hostname=>lookup(hostname,{all:true,verbatim:true});
export async function resolvePublicTarget(raw:string,resolver:Resolver=resolveAll){
 const url=new URL(raw),hostname=url.hostname.replace(/^\[|\]$/g,"");
 if(url.protocol!=="https:"||url.username||url.password)throw new Error("anonymous public HTTPS required");
 const answers=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await resolver(hostname);
 if(!answers.length||answers.length>64||answers.some(a=>!isPublicAddress(a.address)||isIP(a.address)!==a.family))throw new Error("HTTPS destination must resolve exclusively to public addresses");
 return {url,hostname,address:answers[0]!.address,family:answers[0]!.family,addresses:answers};
}
export function publicHttpsRequestOptions(target:Awaited<ReturnType<typeof resolvePublicTarget>>, signal:AbortSignal):RequestOptions {
 return {protocol:"https:",hostname:target.address,port:target.url.port||443,
  path:target.url.pathname+target.url.search,method:"GET",agent:false,
  servername:isIP(target.hostname)?undefined:target.hostname,rejectUnauthorized:true,
  checkServerIdentity:(_host,cert)=>checkServerIdentity(target.hostname,cert),
  signal,maxHeaderSize:16384,headers:{host:target.url.host,"accept-encoding":"identity"}};
}
const RETRYABLE_CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT", "EPIPE"]);
const MAX_CONNECTION_ADDRESSES = 8;
const CONNECTION_TIMEOUT_MS = 5000;
class PublicHttpsConnectionError extends Error {}

type PublicHttpsDependencies = { resolver?: Resolver; request?: typeof request };

function fetchPinnedTarget(target: Awaited<ReturnType<typeof resolvePublicTarget>>, options: { signal: AbortSignal; maxBytes: number }, transport: typeof request) {
 return new Promise<{status:number;body:string;location?:string;content_type?:string}>((resolve,reject)=>{
  let receivedResponse = false;
  const req=transport(publicHttpsRequestOptions(target,options.signal),res=>{
    receivedResponse = true;
    req.setTimeout(0);
    const encoding=res.headers["content-encoding"];
    if(encoding&&encoding!=="identity"){res.destroy();reject(new Error("unsupported public HTTPS content encoding"));return;}
    let bytes=0;const chunks:Buffer[]=[];
    res.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>options.maxBytes){res.destroy(new Error("web response byte limit exceeded"));return;}chunks.push(Buffer.from(chunk));});
    res.on("error",reject);res.on("aborted",()=>reject(new Error("HTTPS response aborted")));
    res.on("end",()=>resolve({status:res.statusCode??502,body:Buffer.concat(chunks).toString("utf8"),location:res.headers.location,content_type:res.headers["content-type"]}));
   });
  req.setTimeout(CONNECTION_TIMEOUT_MS,()=>req.destroy(Object.assign(new Error("public HTTPS connection deadline exceeded"),{code:"ETIMEDOUT"})));
  req.on("error",error=>{
    const retryable = !receivedResponse && !options.signal.aborted && RETRYABLE_CONNECTION_CODES.has((error as NodeJS.ErrnoException).code ?? "");
    reject(retryable ? new PublicHttpsConnectionError(error.message) : error);
  });
  req.end();
 });
}

/** Resolve and validate every answer once. Each bounded connection attempt
 * pins an approved IP while preserving Host, SNI and certificate identity.
 * Certificate, HTTP and body failures never fall through to another address. */
export async function fetchPublicHttps(raw:string,options:{signal:AbortSignal;maxBytes:number},dependencies:PublicHttpsDependencies={}){
 options.signal.throwIfAborted();
 let abort:()=>void=()=>{};
 const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(options.signal.reason??new Error("HTTPS aborted"));options.signal.addEventListener("abort",abort,{once:true});});
 let target:Awaited<ReturnType<typeof resolvePublicTarget>>;
 try{target=await Promise.race([resolvePublicTarget(raw,dependencies.resolver),interrupted]);}finally{options.signal.removeEventListener("abort",abort);}
 const seen=new Set<string>();
 let failure: unknown;
 for(const answer of target.addresses){
  if(seen.has(answer.address))continue;
  if(seen.size>=MAX_CONNECTION_ADDRESSES)break;
  seen.add(answer.address);
  options.signal.throwIfAborted();
  try{return await fetchPinnedTarget({...target,address:answer.address,family:answer.family},options,dependencies.request??request);}
  catch(error){if(!(error instanceof PublicHttpsConnectionError))throw error;failure=error;}
 }
 throw failure ?? new Error("public HTTPS connection unavailable");
}
