import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadProfile} from "../packages/core/profile.ts";
import {startServer} from "../apps/collector/server.ts";
import {Store} from "../packages/storage/store.ts";

test("loopback server refuses missing credentials and cross-origin requests",async()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-server-"));
  const port=48000+Math.floor(Math.random()*1000);
  const secret="test-token-0123456789-abcdef";
  const server=startServer({db:join(root,"store.db"),profile:loadProfile("./profiles/design.json"),port,intervalMinutes:0,token:secret});
  try {
    await new Promise<void>(resolve=>server.listening?resolve():server.on("listening",resolve));
    const url="http://127.0.0.1:"+port+"/status";
    const forbidden=await fetch(url);
    assert.equal(forbidden.status,401);
    const cross=await fetch(url,{headers:{authorization:"Bearer "+secret,origin:"https://evil.example"}});
    assert.equal(cross.status,403);
    const ok=await fetch(url,{headers:{authorization:"Bearer "+secret}});
    assert.equal(ok.status,200);
    const value=await ok.json() as Record<string,unknown>;
    assert.equal(value.connectedSource,"none");
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(root,{recursive:true,force:true});
  }
});

test("manual API rejects signed secret URLs without storing imported posts",async()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-secret-"));
 const db=join(root,"store.db");
 const secret="test-token-0123456789-abcdef";
 const server=startServer({db,profile:loadProfile("./profiles/design.json"),port:0,intervalMinutes:0,token:secret});
 try{
  await new Promise<void>(resolve=>server.listening?resolve():server.on("listening",resolve));
  const a=server.address();
  if(!a||typeof a==="string")throw Error("Missing bound port");
  const request=await fetch("http://127.0.0.1:"+a.port+"/import",{
    method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},
    body:JSON.stringify({posts:[{id:"a",author:"Tester",username:"tester",
      text:"Source https://example.org/public?api_key=secret",
      url:"https://x.com/tester/status/123?session=secret"}]})
  });
  assert.equal(request.status,400);
  const store=new Store(db);
  assert.equal(Number(store.stats().posts),0);
  store.close();
 }finally{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(root,{recursive:true,force:true});
 }
});
test("error history redacts tokens and resource URLs",()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-error-"));
 try{
  const store=new Store(join(root,"errors.db"));
  const run=store.begin("synthetic");
  store.error(run,"post","Bearer aaaa-SECRET https://example.org/path?token=sensitive api_key=SECRET");
  const history=store.recentErrors();
  assert.equal(history.length,1);
  const text=String(history[0].message);
  assert.doesNotMatch(text,/sensitive|SECRET|Bearer aaaa/);
  assert.match(text,/redacted/i);
  store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
