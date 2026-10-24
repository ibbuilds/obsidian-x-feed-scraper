import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {LocalBridge} from "../apps/obsidian-plugin/bridge.ts";

test("packaged collector serves autonomous generic projects through the authenticated API",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-project-server-")),vault=join(root,"vault");
 const db=join(root,"knowledge.db");
 mkdirSync(vault);
 const library="# Existing resources\n- [Old](https://example.org/old)\n";
 writeFileSync(join(vault,"References.md"),library);
 const bridge=new LocalBridge();
 try{
  await bridge.start({executable:process.execPath,
    collectorPath:resolve("apps/obsidian-plugin/collector.cjs"),
    profilePath:resolve("apps/obsidian-plugin/design.json"),
    databasePath:db,vaultPath:vault,
    projectPath:resolve("examples/frontend/project.json"),
    scheduleMinutes:0,threshold:75,confidence:0.65,preferFree:true
  });
  const rootUrl="http://127.0.0.1:"+bridge.port;
  const auth={authorization:"Bearer "+bridge.token};
  assert.equal((await fetch(rootUrl+"/projects")).status,401);
  const before=await fetch(rootUrl+"/status",{headers:auth});
  assert.equal((await before.json() as {activeProjectId:string}).activeProjectId,"frontend-discovery");
  const run=await fetch(rootUrl+"/project/sync",{method:"POST",headers:auth});
  assert.equal(run.status,200,await run.text().catch(()=>""));
  // /sync returns a structured run result and creates Obsidian notes on configured output.
  const recordsResponse=await fetch(rootUrl+"/project/entities?project=frontend-discovery",{headers:auth});
  assert.equal(recordsResponse.status,200);
  const records=await recordsResponse.json() as Array<{key:string;review:string}>;
  assert.ok(records.length>=4);
  const selected=records.find(x=>x.key==="https://github.com/example/motion-kit")!;
  assert.ok(selected);
  const review=await fetch(rootUrl+"/project/review",{
    method:"POST",headers:{...auth,"content-type":"application/json"},
    body:JSON.stringify({projectId:"frontend-discovery",key:selected.key,
      decision:"approved",reason:"Manually verified project"})
  });
  assert.equal(review.status,200,await review.text().catch(()=>""));
  const evidenceResponse=await fetch(rootUrl+
    "/project/entity?project=frontend-discovery&key="+encodeURIComponent(selected.key),
    {headers:auth});
  assert.equal(evidenceResponse.status,200);
  const evidence=await evidenceResponse.json() as {
    entity:{key:string};mentions:Array<{itemId:string;evidence:unknown[]}>;
    reviews:Array<{decision:string;reason:string}>;assessments:Array<{score:number;evaluatorId:string}>;
  };
  assert.equal(evidence.entity.key,selected.key);
  assert.equal(evidence.mentions.length,2);
  assert.ok(evidence.mentions.every(m=>m.evidence.length>0));
  assert.equal(evidence.reviews[0]?.decision,"approved");
  assert.ok(evidence.assessments.length>0);
  assert.equal(evidence.assessments[0]?.evaluatorId,"keyword");
  const missingProof=await fetch(rootUrl+
    "/project/entity?project=frontend-discovery&key=does-not-exist",{headers:auth});
  assert.equal(missingProof.status,404);
  const invalidProof=await fetch(rootUrl+
    "/project/entity?project=frontend-discovery",{headers:auth});
  assert.equal(invalidProof.status,400);
  const confirmed=await (await fetch(rootUrl+"/project/entities?project=frontend-discovery",{headers:auth}))
    .json() as Array<{key:string;review:string}>;
  assert.equal(confirmed.find(x=>x.key===selected.key)?.review,"approved");
  const recalc=await fetch(rootUrl+"/project/reprocess",{method:"POST",headers:auth});
  assert.equal(recalc.status,200);
  const projects=await (await fetch(rootUrl+"/projects",{headers:auth})).json() as Array<{id:string}>;
  assert.ok(projects.some(p=>p.id==="frontend-discovery"));
  const folder=join(vault,"Discovery Engine","frontend-discovery");
  assert.equal(existsSync(folder),true);
  assert.ok(readdirSync(folder).some(name=>name.endsWith(".md")));
  assert.equal(readFileSync(join(vault,"References.md"),"utf8"),library);
 }finally{await bridge.stop();rmSync(root,{recursive:true,force:true});}
});
