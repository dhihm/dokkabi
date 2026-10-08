import {expect,test,spyOn} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {DokkabiDesktopServer} from "../src/dash/desktop-server.ts";
test("pairing uses bounded credentials outside request URLs and rejects hostile origins",async()=>{
 const root=mkdtempSync("/tmp/pairing-security-");const server=new DokkabiDesktopServer({port:0,host:"127.0.0.1",gatewayLogPath:join(root,"audit"),socketPath:join(root,"sock"),sessionsRoot:join(root,"sessions")});
 try{await server.start();const base=`http://127.0.0.1:${server.port}`;
 expect(server.pairingToken).toMatch(/^dk_[A-Za-z0-9_-]{43}$/);
 const old=await fetch(base+"/api/pairing?token="+server.pairingToken);expect(old.status).toBe(403);await old.text();
 const bad=await fetch(base+"/api/pairing",{headers:{authorization:"Bearer "+server.pairingToken,origin:"https://evil.example"}});expect(bad.status).toBe(403);await bad.text();
 const spoofed=await fetch(base+"/api/pairing",{headers:{host:"evil.example",origin:"http://evil.example",authorization:"Bearer "+server.pairingToken}});expect(spoofed.status).toBe(403);await spoofed.text();
 const good=await fetch(base+"/api/pairing",{headers:{authorization:"Bearer "+server.pairingToken,origin:base}});expect(good.status).toBe(200);const info=await good.json() as {mobileUrl:string};const url=new URL(info.mobileUrl);expect(url.search).toBe("");expect(url.hash).toContain("token=");
 }finally{await server.stop();rmSync(root,{recursive:true,force:true});}
});

test("authenticated WebSocket closes when its credential expires",async()=>{
 const root=mkdtempSync("/tmp/pairing-expiry-");const server=new DokkabiDesktopServer({port:0,host:"127.0.0.1",gatewayLogPath:join(root,"audit"),socketPath:join(root,"sock"),sessionsRoot:join(root,"sessions"),pairingTokenTtlMs:500});
 let ws:WebSocket|undefined;
 try{await server.start();ws=new WebSocket(`ws://127.0.0.1:${server.port}/ws`,["dokkabi.rpc","dokkabi.auth."+server.pairingToken]);
 const closed=new Promise<number>((resolve,reject)=>{ws!.onclose=e=>resolve(e.code);ws!.onerror=()=>reject(Error("socket failed"));});
 await new Promise<void>(resolve=>{ws!.onopen=()=>resolve();});expect(ws.protocol).toBe("dokkabi.rpc");
 expect(await closed).toBe(1008);
 const denied=await fetch(`http://127.0.0.1:${server.port}/api/pairing`,{headers:{authorization:"Bearer "+server.pairingToken}});expect(denied.status).toBe(403);await denied.text();
 }finally{ws?.close();await server.stop();rmSync(root,{recursive:true,force:true});}
},3000);

test("plaintext privileged gateway refuses non-loopback binding",async()=>{
 for(const host of ["0.0.0.0","::","192.0.2.1","100.64.1.1"]){
  const server=new DokkabiDesktopServer({host});
  await expect(server.start()).rejects.toThrow("requires loopback");
 }
});

test("operator HTTPS origin produces fragment links without relaxing origin validation",()=>{
 const server=new DokkabiDesktopServer({publicOrigin:"https://gateway.example"});
 expect(server.getTailscaleInfo().mobileUrl).toStartWith("https://gateway.example/mobile#token=");
 expect(()=>new DokkabiDesktopServer({publicOrigin:"http://gateway.example"})).toThrow("HTTPS");
 expect(()=>new DokkabiDesktopServer({pairingTokenTtlMs:0})).toThrow("lifetime");
});

// An installed app credential belongs to its private live owner, not a mobile pairing window.
test("owned desktop credential survives eight hours and is revoked with its owner", async () => {
 const root=mkdtempSync("/tmp/owned-credential-"); const owner=new AbortController();
 const token="owned-"+"a".repeat(43);
 const server=new DokkabiDesktopServer({port:0, host:"127.0.0.1", gatewayLogPath:join(root,"audit"), socketPath:join(root,"sock"), sessionsRoot:join(root,"sessions"), pairingToken:token, credentialOwner:owner.signal});
 let clock:ReturnType<typeof spyOn>|undefined; let ws:WebSocket|undefined;
 try {
  await server.start(); const base=`http://127.0.0.1:${server.port}`;
  const now=Date.now(); clock=spyOn(Date,"now").mockReturnValue(now+9*60*60*1000);
  ws=new WebSocket(base.replace("http:","ws:")+"/ws",["dokkabi.rpc","dokkabi.auth."+token]);
  await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve(); ws!.onerror=()=>reject(Error("owner credential expired"));});
  expect(ws.protocol).toBe("dokkabi.rpc");
  const closed=new Promise<number>(resolve=>{ws!.onclose=e=>resolve(e.code);});
  const denied=await fetch(base+"/api/pairing",{headers:{authorization:"Bearer "+token}}); expect(denied.status).toBe(403); await denied.text();
  expect(JSON.stringify(server.getTailscaleInfo())).not.toContain(token);
  owner.abort(); expect(await closed).toBe(1008);
  const revoked=await fetch(base+"/api/pairing",{headers:{authorization:"Bearer "+token}});expect(revoked.status).toBe(403);await revoked.text();
 } finally {clock?.mockRestore(); ws?.close(); await server.stop(); rmSync(root,{recursive:true,force:true});}
},3000);

test("owner credentials cannot opt into public pairing or a second TTL",()=>{
 const owner=new AbortController();const config={credentialOwner:owner.signal,pairingToken:"a".repeat(43)};
 expect(()=>new DokkabiDesktopServer({...config,publicOrigin:"https://gateway.example"})).toThrow("owner credential");
 expect(()=>new DokkabiDesktopServer({...config,pairingTokenTtlMs:500})).toThrow("owner credential");
 expect(()=>new DokkabiDesktopServer({credentialOwner:owner.signal})).toThrow("owner credential");
});
