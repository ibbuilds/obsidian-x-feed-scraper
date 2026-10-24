import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runProject,reprocessProject} from "../packages/core/engine.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

test("offline reevaluation batches remain atomic when an evaluator fails mid-run",async()=>{
 const root=mkdtempSync(join(tmpdir(),"source-scraper-offline-batches-"));
 const db=join(root,"history.sqlite"),source=join(root,"rows.json");
 const n=250,observations=Array.from({length:n},(_,i)=>({
   id:"row-"+String(i).padStart(4,"0"),type:"catalog-record",
   title:"Scientific record "+i,attributes:{ordinal:i}
 }));
 writeFileSync(source,JSON.stringify(observations));
 const project=parseProject({id:"offline-batch",name:"Offline reassessment benchmark",
  sources:[{id:"source",adapter:"json-snapshot",config:{path:source,entityNamespace:"source"}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:["scientific"],excludeKeywords:[],minimumScore:0},outputs:[]});
 try{
  const initial=await runProject(db,project,createDefaultRegistry(),{pageSize:100});
  assert.equal(initial.success,true);
  const key="@source:catalog-record:row-0000";
  const before=new KnowledgeStore(db);
  before.reviewEntity(project.id,key,"approved","User decision survives failed reevaluation");
  const historyBefore=(before.db.prepare("SELECT COUNT(*) n FROM kb_assessment_history")
    .get() as {n:number}).n;
  const versionsBefore=(before.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions")
    .get() as {n:number}).n;
  before.close();

  const plugin=createDefaultRegistry();
  let invoked=0;
  plugin.evaluators.set("keyword",{
    id:"keyword",
    assess(){
      invoked++;
      if(invoked===145)throw new Error("Synthetic evaluator failed mid-batch");
      return {category:"updated",score:0,confidence:0.5,reasons:["Reassessed offline"]};
    }
  });
  await assert.rejects(reprocessProject(db,project,plugin),/Synthetic evaluator failed/);
  const mid=new KnowledgeStore(db);
  try{
    const scores=mid.db.prepare("SELECT score,COUNT(*) n FROM kb_assessments "+
      "WHERE project_id=? GROUP BY score ORDER BY score").all(project.id) as Array<{score:number;n:number}>;
    assert.equal(scores.find(s=>s.score===0)?.n,100,
      "Only the fully evaluated first 100 entities may be committed");
    assert.equal(scores.reduce((n,row)=>n+row.n,0),250);
    assert.equal((mid.db.prepare("SELECT COUNT(*) n FROM kb_assessment_history")
      .get() as {n:number}).n,historyBefore+100);
    assert.equal((mid.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions")
      .get() as {n:number}).n,versionsBefore,
      "Offline re-evaluation must never modify original observation revisions");
    assert.equal(mid.getEntity(project.id,key)?.review,"approved");
  }finally{mid.close();}

  invoked=0;
  plugin.evaluators.set("keyword",{
    id:"keyword",
    assess(){return {category:"updated",score:0,confidence:0.5,reasons:["Reassessed offline"]};}
  });
  const resumed=await reprocessProject(db,project,plugin);
  assert.equal(resumed.entities,250);
  assert.equal(resumed.reassessed,250);
  const end=new KnowledgeStore(db);
  try{
    const counts=end.db.prepare("SELECT COUNT(*) n FROM kb_assessments "+
      "WHERE project_id=? AND score=0").get(project.id) as {n:number};
    assert.equal(counts.n,250);
    assert.equal(end.getEntity(project.id,key)?.review,"approved");
    assert.equal((end.db.prepare("SELECT COUNT(*) n FROM kb_assessment_history")
      .get() as {n:number}).n,historyBefore+250,
      "Reapplying unchanged scores must not duplicate assessment histories");
  }finally{end.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
