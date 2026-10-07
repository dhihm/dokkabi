import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { canonicalJson } from "./canonical.ts";
import { GENESIS_HASH, assertEventName, isEventKind, type EventRecord } from "./schema.ts";

export interface ReplayLimits { maxBytes?: number; maxLineBytes?: number; maxEvents?: number; retainRaw?: boolean }
/** Bounded acquisition from one descriptor. A pathname replacement cannot
 * redirect an in-progress read; a final digest check catches later changes. */
function scan(path: string, maxBytes: number, consume?: (chunk: Buffer) => void): string {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const stat=fstatSync(fd);
  if(!stat.isFile() || stat.size>maxBytes) throw new Error("replay input byte limit exceeded or not a regular file");
  const hash=createHash("sha256"), buffer=Buffer.alloc(64*1024);let total=0;
  for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;total+=n;
   if(total>maxBytes)throw new Error("replay input byte limit exceeded");
   const chunk=buffer.subarray(0,n);hash.update(chunk);consume?.(chunk);
  }
  const after=fstatSync(fd);
  if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error("replay input changed during acquisition");
  return hash.digest("hex");
 }finally{closeSync(fd);}
}
export function readReplaySnapshot(path:string, limits:ReplayLimits={}) {
 const maxBytes=limits.maxBytes??128*1024*1024,maxLineBytes=limits.maxLineBytes??4*1024*1024,maxEvents=limits.maxEvents??200000;
 for(const n of [maxBytes,maxLineBytes,maxEvents])if(!Number.isSafeInteger(n)||n<1)throw new Error("invalid replay budget");
 const events:EventRecord[]=[];let pending=Buffer.alloc(0),previous=GENESIS_HASH;
 const raw:Buffer[]=[];
 const digest=scan(path,maxBytes,chunk=>{
  if(limits.retainRaw)raw.push(Buffer.from(chunk));
  let start=0;
  while(start<chunk.length){const end=chunk.indexOf(10,start);const stop=end<0?chunk.length:end;
   const part=chunk.subarray(start,stop);
   if(pending.length+part.length>maxLineBytes)throw new Error("replay row limit exceeded");
   pending=Buffer.concat([pending,part]);
   if(end<0)break;
   if(events.length>=maxEvents)throw new Error("replay event limit exceeded");
   const line=new TextDecoder("utf-8",{fatal:true}).decode(pending);pending=Buffer.alloc(0);
   if(!line.trim())throw new Error("replay input has an empty row");
   const event=JSON.parse(line) as EventRecord;
   if(!event||event.seq!==events.length+1||!isEventKind(event.kind)||typeof event.ts!=="string"||!event.payload||typeof event.payload!=="object"||Array.isArray(event.payload))throw new Error("invalid replay event envelope");
   assertEventName(event.name);
   const {hash,...unsigned}=event;
   if(event.prev_hash!==previous||createHash("sha256").update(canonicalJson(unsigned)).digest("hex")!==hash)throw new Error("invalid replay event chain");
   events.push(event);previous=hash;start=end+1;
  }
 });
 if(pending.length)throw new Error("replay input has an incomplete final line");
 return {path,events,raw:limits.retainRaw?Buffer.concat(raw).toString("utf8"):"",assertUnchanged(){
  if(scan(path,maxBytes)!==digest)throw new Error("replay input changed during acquisition");
 }};
}
