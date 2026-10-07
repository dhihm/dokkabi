import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { readBranchCheckpoint, branchCheckpointReceiptSchemas as schemas } from "./branch-checkpoint.ts";
import type { BlobStore } from "./blob-store.ts";
import type { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";

type CheckpointEventName = keyof typeof schemas;
export interface BranchCheckpointReference { seq: number; name: CheckpointEventName; payloadDigest: string }
function refuse(): never { throw new Error("branch-checkpoint replay: invalid receipt binding"); }
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Replay observes recorded checkpoint outcomes; it never acquires an image,
 * finishes an unresolved intent, restores files or opens a child session. */
export function projectBranchCheckpointReferences(events: readonly EventRecord[]): BranchCheckpointReference[] {
 const bySeq=new Map(events.map(row=>[row.seq,row]));
 const checkpoints=new Map<string,{ source: { seq:number;hash:string }; terminal:boolean; blob?:string; image?:string }>();
 const restoring=new Map<string,{ source: { seq:number;hash:string }; digest:string }>();
 const resources=new Map<string,{ id:string;session:string;digest:string;resource:unknown }>();
 const references:BranchCheckpointReference[]=[];
 for(const row of events){
  if(!Object.hasOwn(schemas,row.name)) continue;
  const name=row.name as CheckpointEventName;
  const parsed=schemas[name].safeParse(row.payload);
  if(row.kind!=="observe" || !parsed.success) refuse();
  const value=parsed.data;
  const key=canonicalJson([value.session,value.id]);
  if("source" in value){
   const original=bySeq.get(value.source.seq);
   if(!original || original.hash!==value.source.hash || original.seq>=row.seq) refuse();
   const opened=events.filter(x=>x.seq<=original.seq && x.name==="session/open").at(-1);
   const recordedSession=opened?.payload.session_id ?? opened?.payload.id;
   if(recordedSession!==undefined && recordedSession!==value.session) refuse();
  }
  if(name==="branch/checkpoint_intent" && "source" in value){
   if(checkpoints.has(key)) refuse();
   checkpoints.set(key,{source:value.source,terminal:false});
  } else if(name==="branch/checkpoint_ready" && "blob" in value && "source" in value && "image" in value){
   const cp=checkpoints.get(key);
   if(!cp || cp.terminal || !same(cp.source,value.source)) refuse();
   cp.terminal=true;cp.blob=String(value.blob);cp.image=String(value.image);
  } else if(name==="branch/checkpoint_failed" && "source" in value){
   const cp=checkpoints.get(key);
   if(!cp || cp.terminal || !same(cp.source,value.source)) refuse();
   cp.terminal=true;
  } else if(name==="branch/restore_intent" && "source" in value && "digest" in value){
   const cp=checkpoints.get(key);
   if(!cp?.blob || cp.blob!==value.digest || !same(cp.source,value.source) || restoring.has(key)) refuse();
   restoring.set(key,{source:value.source,digest:value.digest});
  } else if((name==="branch/restore_ready" || name==="branch/restore_failed") && "source" in value && "digest" in value){
   const pending=restoring.get(key),cp=checkpoints.get(key);
   if(!pending || !same(pending.source,value.source) || pending.digest!==value.digest) refuse();
   restoring.delete(key);
   if(name==="branch/restore_ready" && "image" in value && "resource" in value){
    if(cp?.image!==value.image || resources.has(schemas["branch/restore_ready"].parse(value).resource.owner)) refuse();
    const restored=schemas["branch/restore_ready"].parse(value);
    resources.set(restored.resource.owner,{id:value.id,session:value.session,digest:value.digest,resource:restored.resource});
   }
  } else if(name==="branch/restore_closed" && "resource" in value){
   const owned=resources.get(value.resource.owner);
   if(!owned || !same(owned,{id:value.id,session:value.session,digest:value.digest,resource:value.resource})) refuse();
   resources.delete(value.resource.owner);
  } else refuse();
  references.push({seq:row.seq,name,payloadDigest:createHash("sha256").update(canonicalJson(value)).digest("hex")});
 }
 return references;
}

/** Verify retained checkpoint bodies without the mutable parent filesystem. */
export function validateRecordedBranchCheckpoints(log: Pick<EventLog, "path" | "events">, suppliedStore?: BlobStore): void {
 projectBranchCheckpointReferences(log.events);
 for(const row of log.events){
  if(row.name!=="branch/checkpoint_ready") continue;
  readBranchCheckpoint(log,String(row.payload.session),String(row.payload.id),String(row.payload.blob),suppliedStore);
 }
}
