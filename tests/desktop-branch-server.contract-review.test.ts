import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DokkabiDesktopServer } from "../src/dash/desktop-server.ts";
import { EventLog } from "../src/host/event-log.ts";
import { pendingNoteState } from "../src/work/inbox.ts";

async function serverFixture(run:(f:any)=>Promise<void>) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"dokkabi-r8-server-review-"))),home=join(root,"home"),workspace=join(root,"workspace");mkdirSync(home);mkdirSync(workspace);writeFileSync(join(home,"auth.json"),"{}\n");writeFileSync(join(workspace,"source.txt"),"original parent\n");
 const keys=["DOKKABI_HOME","DOKKABI_BRANCH_CHECKPOINTS","DOKKABI_CONTEXT_GRAPH"],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));process.env.DOKKABI_HOME=home;process.env.DOKKABI_BRANCH_CHECKPOINTS="1";process.env.DOKKABI_CONTEXT_GRAPH="on";
 const server=new DokkabiDesktopServer({workspaceCwd:workspace,sessionsRoot:join(home,"sessions"),gatewayLogPath:join(home,"gateway.jsonl"),socketPath:join(root,"desktop.sock"),pairingToken:"isolated-review"});let counter=0;
 const rpc=async(method:string,params:unknown)=>{const r=await server.handleJsonRpcMessage(JSON.stringify({jsonrpc:"2.0",id:++counter,method,params}));if(r?.error)throw Error(r.error.message);return r?.result as any;};const binding={clientId:"real-server-client",threadId:"real-server-parent"};
 try {
  const bound=await rpc("workbench.bind",{version:1,...binding,workspacePath:workspace});const logPath=join(home,"sessions",bound.sessionId,"events.jsonl");const log=new EventLog(logPath);const cp=await rpc("workbench.checkpoint",{version:1,binding,operation:"create",id:"real-server-source",expectedSource:{seq:log.lastSeq,hash:log.lastHash}});
  const definition={id:"real-server-decision",commandId:"real-server-open",kind:"branch",checkpointId:cp.id,checkpointDigest:cp.digest,question:"Choose a child",options:[{id:"careful",label:"Careful implementation"},{id:"fast",label:"Fast implementation"}],recommendation:"careful",rationale:"Compare source conditions"};
  await rpc("workbench.decision",{version:1,binding,operation:"open",definition});await rpc("workbench.decision",{version:1,binding,operation:"select",id:definition.id,commandId:"real-server-choice",expectedRevision:0,option:"careful"});const start=await rpc("workbench.decision",{version:1,binding,operation:"start",id:definition.id,commandId:"real-server-start",expectedRevision:1,childThreadId:"real-server-child"});expect(start.state).toBe("ready");
  await run({root,home,workspace,server,rpc,binding,logPath,parentSession:bound.sessionId,child:start.child});
 } finally {await server.stop();for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}rmSync(root,{recursive:true,force:true});}
}

test("R8-05 real server fences legacy inbox and delete for a workbench-owned child",async()=>serverFixture(async f=>{
 const childPath=join(f.home,"sessions",f.child.sessionId,"events.jsonl"),before=readFileSync(childPath);
 const note=await f.rpc("note.submit",{sessionId:f.child.sessionId,text:"This must not be staged"});expect(note.ok).toBe(false);expect(pendingNoteState(join(f.home,"sessions",f.child.sessionId))).toEqual({queued:0,inFlight:0});
 const deletion=await f.rpc("session.delete",{sessionId:f.child.sessionId});expect(deletion.ok).toBe(false);expect(readFileSync(childPath)).toEqual(before);
}),60000);

test("R8-05 real server keeps child and parent read/cancel identities separate",async()=>serverFixture(async f=>{
 const envelope=(method:string,params:unknown)=>({version:1,binding:f.binding,childId:f.child.id,method,params});
 const before=readFileSync(f.logPath);const child=await f.rpc("workbench.branchSession",envelope("workbench.read",{version:1,binding:f.child.binding}));const parent=await f.rpc("workbench.read",{version:1,binding:f.binding});expect(child.sessionCursor.sessionId).toBe(f.child.sessionId);expect(parent.sessionCursor.sessionId).toBe(f.parentSession);
 await expect(f.rpc("workbench.branchSession",envelope("workbench.cancel",{version:1,binding:f.binding,commandId:"bad-child-stop",targetCommandId:"parent-command"}))).rejects.toThrow();expect(readFileSync(f.logPath)).toEqual(before);
}),60000);


test("R8-05 a cold server protects recorded children before opening any parent or child kernel",async()=>serverFixture(async f=>{
 await f.server.stop();
 const cold=new DokkabiDesktopServer({workspaceCwd:f.workspace,sessionsRoot:join(f.home,"sessions"),gatewayLogPath:join(f.home,"gateway.jsonl"),socketPath:join(f.root,"cold.sock"),pairingToken:"isolated-review"});
 const rpc=async(method:string,params:unknown)=>{const r=await cold.handleJsonRpcMessage(JSON.stringify({jsonrpc:"2.0",id:1,method,params}));if(r?.error)throw Error(r.error.message);return r?.result as any;};
 const childPath=join(f.home,"sessions",f.child.sessionId,"events.jsonl"),parentBefore=readFileSync(f.logPath),childBefore=readFileSync(childPath);
 try {
  const note=await rpc("note.submit",{sessionId:f.child.sessionId,text:"Cold owner must refuse this staged input"});expect(note.ok).toBe(false);expect(pendingNoteState(join(f.home,"sessions",f.child.sessionId))).toEqual({queued:0,inFlight:0});
  const deletion=await rpc("session.delete",{sessionId:f.child.sessionId});expect(deletion.ok).toBe(false);expect(readFileSync(childPath)).toEqual(childBefore);expect(readFileSync(f.logPath)).toEqual(parentBefore);
 } finally {await cold.stop();}
}),60000);


test("R8-05 server stop returns an awaited chat-disposal barrier",async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"dokkabi-r8-stop-review-")));let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const server=new DokkabiDesktopServer({workspaceCwd:root,sessionsRoot:join(root,"sessions"),gatewayLogPath:join(root,"gateway.jsonl"),socketPath:join(root,"desktop.sock"),pairingToken:"isolated-review"});
 let finished=false;server.closeChat=async()=>{await gate;finished=true;};
 try{const pending=server.stop();const thenable=pending!==undefined && typeof (pending as any).then==="function";release();await pending;expect(thenable).toBe(true);expect(finished).toBe(true);}finally{release();rmSync(root,{recursive:true,force:true});}
});


test("R8-05 cold deletion preserves the parent authority governing prepared children",async()=>serverFixture(async f=>{
 await f.rpc("workbench.detach",{version:1,binding:f.binding});await f.server.stop();const before=readFileSync(f.logPath);
 const cold=new DokkabiDesktopServer({workspaceCwd:f.workspace,sessionsRoot:join(f.home,"sessions"),gatewayLogPath:join(f.home,"gateway.jsonl"),socketPath:join(f.root,"cold.sock"),pairingToken:"isolated-review"});
 try{const response:any=await cold.handleJsonRpcMessage(JSON.stringify({jsonrpc:"2.0",id:1,method:"session.delete",params:{sessionId:f.parentSession}}));expect(response?.result?.ok).toBe(false);expect(readFileSync(f.logPath)).toEqual(before);}finally{await cold.stop();}
}),60000);
