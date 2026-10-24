import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {startServer} from "../apps/collector/server.ts";
import {loadProfile} from "../packages/core/profile.ts";
import {loadProject} from "../packages/core/project-config.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

test("API reevaluation refreshes local outputs without activating an enabled external output",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-offline-exports-"));
  const db=join(root,"library.db"),manifest=join(root,"project.json");
  const endpointVariable="DISCOVERY_OFFLINE_TEST_UNCONFIGURED_RECEIVER";
  const previousEndpoint=process.env[endpointVariable];
  delete process.env[endpointVariable];
  writeFileSync(join(root,"snapshot.json"),JSON.stringify([
    {id:"one",type:"record",title:"Offline evidence",attributes:{status:"open"}}
  ]));
  writeFileSync(manifest,JSON.stringify({id:"offline-output",name:"Offline output",
    sources:[{id:"fixture",adapter:"json-snapshot",config:{path:"./snapshot.json"}}],
    pipeline:["observation-entity"],watch:{rules:[{id:"new-item",operator:"created",path:"$"}]},
    outputs:[{id:"local-json",adapter:"json",config:{}},
      {id:"external-alerts",adapter:"webhook",config:{enabled:true,
        endpointEnv:endpointVariable,includeExisting:true}}]
  }));
  let server:ReturnType<typeof startServer>|undefined;
  try{
    const project=loadProject(manifest);
    assert.equal((await runProject(db,project,createDefaultRegistry())).success,true);
    const token="offline-output-integration-test-token";
    server=startServer({db,profile:loadProfile("profiles/design.json"),projectPath:manifest,
      token,port:0,intervalMinutes:0});
    await once(server,"listening");
    const address=server.address();
    assert.ok(address&&typeof address!=="string");
    const base="http://127.0.0.1:"+address.port,headers={authorization:"Bearer "+token};
    const response=await fetch(base+"/project/reprocess",{method:"POST",headers});
    assert.equal(response.status,200);
    const result=await response.json() as {result:{reassessed:number};
      exports:Array<{output:string;result:{entities?:number;skipped?:boolean}}>};
    assert.equal(result.result.reassessed,1);
    assert.equal(result.exports.find(item=>item.output==="local-json")?.result.entities,1);
    assert.equal(result.exports.find(item=>item.output==="external-alerts")?.result.skipped,true);
    const status=await fetch(base+"/project/deliveries",{headers});
    assert.equal(status.status,200);
    assert.deepEqual(await status.json(),[]);
    const store=new KnowledgeStore(db);
    try{
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='kb_webhook_outputs'").get()?.n,0);
      assert.equal(store.listAlerts(project.id).length,1);
    }finally{store.close();}
  }finally{
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    if(previousEndpoint===undefined)delete process.env[endpointVariable];
    else process.env[endpointVariable]=previousEndpoint;
    rmSync(root,{recursive:true,force:true});
  }
});
