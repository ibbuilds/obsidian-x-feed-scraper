import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {startServer} from "../apps/collector/server.ts";
import {loadProfile} from "../packages/core/profile.ts";
import {Store} from "../packages/storage/store.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

async function fixture(paused:boolean){
 const root=mkdtempSync(join(tmpdir(),"discovery-scheduler-"));
 const db=join(root,"data.sqlite"),input=join(root,"input.json"),manifest=join(root,"project.json");
 writeFileSync(input,JSON.stringify([{id:"one",type:"lab-record",
   title:"Scientific sample",text:"Microscopy observation",attributes:{specimen:"A"}}]));
 writeFileSync(manifest,JSON.stringify({id:"scheduled-lab",name:"Scheduled Lab",
  sources:[{id:"local-data",adapter:"json-file",config:{path:"./input.json"}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:["microscopy"],excludeKeywords:[],minimumScore:0},
  outputs:[{id:"json",adapter:"json",config:{}}]
 }));
 if(paused){const s=new Store(db);s.setPaused(true);s.close();}
 const server=startServer({db,profile:loadProfile("./profiles/design.json"),projectPath:manifest,
   token:"schedule-test-token-is-32-chars-long",port:0,intervalMinutes:15});
 await once(server,"listening");
 const address=server.address();
 if(!address||typeof address==="string")throw new Error("Server has no loopback port");
 return {root,db,server,
  url:"http://127.0.0.1:"+address.port,
  headers:{authorization:"Bearer schedule-test-token-is-32-chars-long"}};
}
test("configured scheduled research runs on startup without a manual Sync click",async()=>{
 const env=await fixture(false);
 try{
  let status:{scheduler:{lastAttempt:string|null;lastSuccess:string|null;enabled:boolean}}|undefined;
  for(let i=0;i<40;i++){
   const response=await fetch(env.url+"/status",{headers:env.headers});
   assert.equal(response.status,200);
   status=await response.json() as typeof status;
   if(status?.scheduler.lastSuccess)break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(status?.scheduler.enabled,true);
  assert.ok(status?.scheduler.lastAttempt);
  assert.ok(status?.scheduler.lastSuccess,"Startup collection did not complete");
  const store=new KnowledgeStore(env.db);
  assert.equal(store.listEntities("scheduled-lab").length,1);
  assert.equal(store.runs("scheduled-lab")[0].status,"success");
  store.close();
 }finally{
  await new Promise<void>(resolve=>env.server.close(()=>resolve()));
  rmSync(env.root,{recursive:true,force:true});
 }
});
test("persisted pause prevents automatic startup collection",async()=>{
 const env=await fixture(true);
 try{
  await new Promise(resolve=>setTimeout(resolve,200));
  const response=await fetch(env.url+"/status",{headers:env.headers});
  const status=await response.json() as {scheduler:{lastAttempt:string|null},paused:boolean};
  assert.equal(status.paused,true);
  assert.equal(status.scheduler.lastAttempt,null);
  const store=new KnowledgeStore(env.db);
  assert.equal(store.listEntities("scheduled-lab").length,0);
  store.close();
 }finally{
  await new Promise<void>(resolve=>env.server.close(()=>resolve()));
  rmSync(env.root,{recursive:true,force:true});
 }
});
