import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runProject} from "../packages/core/engine.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

function fixture(){
  const root=mkdtempSync(join(tmpdir(),"source-scraper-noop-"));
  const file=join(root,"source.json"),db=join(root,"library.sqlite");
  const rows=[{id:"1",type:"sample-record",title:"Useful motion tool",attributes:{version:1}}];
  const project=parseProject({
    id:"repeat-project",name:"Fast path correctness",
    sources:[{id:"local",adapter:"json-snapshot",config:{path:file,entityNamespace:"local"}}],
    pipeline:["observation-entity"],evaluator:"keyword",
    policy:{includeKeywords:["motion"],excludeKeywords:[],minimumScore:0},
    watch:{rules:[{id:"version",path:"/attributes/version",operator:"changed"}]},
    outputs:[]
  });
  const save=()=>writeFileSync(file,JSON.stringify(rows));
  save();
  const registry=createDefaultRegistry();
  return {root,file,db,rows,project,registry,save,
    run:()=>runProject(db,project,registry,{pageSize:1}),
    close:()=>rmSync(root,{recursive:true,force:true})};
}
function metrics(db:string){
  const store=new KnowledgeStore(db);
  try{
    const get=(table:string)=>Number((store.db.prepare("SELECT COUNT(*) n FROM "+table).get() as {n:number}).n);
    return {observationVersions:get("kb_observation_versions"),entityVersions:get("kb_entity_versions"),
      changes:get("kb_entity_changes"),alerts:get("kb_watch_alerts"),
      assessments:get("kb_assessment_history"),mentions:get("kb_mentions")};
  }finally{store.close();}
}
test("unchanged source claim preserves immutable histories, scores, evidence and human review",async()=>{
  const f=fixture(),key="@local:sample-record:1";
  try{
    assert.equal((await f.run()).success,true);
    const store=new KnowledgeStore(f.db);
    const first=store.getEntity(f.project.id,key)!;
    assert.ok(first.score>0);
    store.reviewEntity(f.project.id,key,"approved","Reviewed the source");
    // A known sentinel ensures an unchanged observation does not rewrite the
    // stored assessment just to make an otherwise redundant SQL update.
    store.db.prepare("UPDATE kb_mention_assessments SET updated_at=? "+
      "WHERE project_id=? AND entity_key=?").run("2001-01-01T00:00:00.000Z",f.project.id,key);
    store.close();
    const before=metrics(f.db);
    const again=await f.run();
    assert.equal(again.success,true);
    assert.equal(again.observations,1);
    assert.equal(again.duplicates,2,"One repeated observation and its existing entity");
    assert.deepEqual(metrics(f.db),before);
    const after=new KnowledgeStore(f.db);
    try{
      assert.equal(after.getEntity(f.project.id,key)!.review,"approved");
      assert.deepEqual(after.getEntity(f.project.id,key)!.reasons,first.reasons);
      const mention=after.db.prepare("SELECT updated_at FROM kb_mention_assessments "+
        "WHERE project_id=? AND entity_key=?").get(f.project.id,key) as {updated_at:string};
      assert.equal(mention.updated_at,"2001-01-01T00:00:00.000Z");
      assert.equal(after.entityEvidence(f.project.id,key)?.mentions.length,1);
    }finally{after.close();}
    // A changed evaluator policy must change the score even if the raw
    // observation and the extracted entity were exactly the same.
    f.project.policy.includeKeywords=["not-in-this-record"];
    assert.equal((await f.run()).success,true);
    const reassessed=new KnowledgeStore(f.db);
    try{
      assert.equal(reassessed.getEntity(f.project.id,key)?.score,0);
      assert.equal(reassessed.getEntity(f.project.id,key)?.review,"approved");
    }finally{reassessed.close();}
    assert.ok(metrics(f.db).assessments>before.assessments);
    f.rows[0].attributes.version=2;f.save();
    assert.equal((await f.run()).success,true);
    const last=metrics(f.db);
    assert.equal(last.observationVersions,before.observationVersions+1);
    assert.equal(last.alerts,before.alerts+1);
    assert.equal(last.changes,before.changes+1);
  }finally{f.close();}
});

test("missing or mismatched immutable revision disables fast path and repairs history",async()=>{
  const f=fixture();
  try{
    assert.equal((await f.run()).success,true);
    const db=new KnowledgeStore(f.db);
    db.db.prepare("DELETE FROM kb_observation_versions "+
      "WHERE project_id=? AND connection_id=? AND item_id=?")
      .run(f.project.id,"local","1");
    db.close();
    assert.equal(metrics(f.db).observationVersions,0);
    assert.equal((await f.run()).success,true);
    assert.equal(metrics(f.db).observationVersions,1,
      "A copied current observation without an immutable revision must be backfilled");
  }finally{f.close();}
});
