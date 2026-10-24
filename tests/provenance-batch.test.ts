import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runProject} from "../packages/core/engine.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

test("batched export provenance equals individual evidence, including history caps and inactive claims",async()=>{
  const root=mkdtempSync(join(tmpdir(),"source-scraper-provenance-batch-"));
  const path=join(root,"observations.json"),db=join(root,"library.sqlite");
  const shared="https://example.org/shared";
  const records=Array.from({length:70},(_,i)=>({
    id:"obs-"+String(i).padStart(3,"0"),
    type:"source-record",title:"Source mention "+i,
    url:"https://example.org/post/"+i,
    urls:[shared,...(i<9?["https://example.org/unique/"+i]:[])],
    attributes:{source:"synthetic"}
  }));
  const write=()=>writeFileSync(path,JSON.stringify(records));
  const project=parseProject({
    id:"batch-provenance",name:"Batch provenance equivalence",
    sources:[{id:"snapshot",adapter:"json-snapshot",config:{path}}],
    pipeline:["linked-resources"],evaluator:"keyword",
    policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]
  });
  try{
    write();
    assert.equal((await runProject(db,project,createDefaultRegistry(),{pageSize:100})).success,true);
    const store=new KnowledgeStore(db);
    const reason="Synthetic approval";
    try{
      for(let i=0;i<37;i++)store.reviewEntity(project.id,shared,i%3===0?"approved":"pending",reason);
      // Historical assessment entries are not current machine recommendations.
      const add=store.db.prepare(
        "INSERT INTO kb_assessment_history(project_id,entity_key,category,score,confidence,reasons_json,evaluator_id,recorded_at) "+
        "VALUES(?,?,?,?,?,?,?,?)"
      );
      for(let i=0;i<40;i++)add.run(project.id,shared,"history",i%100,0.5,
        JSON.stringify(["Historical evidence "+i]),"test-evaluator","2026-10-24T00:00:00Z");
    }finally{store.close();}
    // Explicit update moves one old claim into inactive provenance.
    records[0].urls=["https://example.org/new-resource"];write();
    assert.equal((await runProject(db,project,createDefaultRegistry(),{pageSize:100})).success,true);
    const reopened=new KnowledgeStore(db);
    try{
      const entities=reopened.listEntities(project.id,{limit:500});
      const keys=entities.map(entity=>entity.key);
      assert.ok(keys.includes(shared));
      assert.equal(keys.length,11);
      const batch=reopened.entityProvenanceBatch(project.id,keys);
      assert.equal(batch.size,keys.length);
      const sorted=(xs:readonly Record<string,unknown>[])=>xs.map(x=>JSON.stringify(x)).sort();
      for(const entity of entities){
        const individual=reopened.entityEvidence(project.id,entity.key);
        const grouped=batch.get(entity.key);
        assert.ok(individual);assert.ok(grouped);
        assert.deepEqual(sorted(grouped.mentions),sorted(individual.mentions),"mentions mismatch for "+entity.key);
        assert.deepEqual(grouped.reviews,individual.reviews,"reviews mismatch for "+entity.key);
        assert.deepEqual(grouped.assessments,individual.assessments,"history mismatch for "+entity.key);
      }
      const details=batch.get(shared)!;
      assert.equal(details.mentions.length,50,"Historical mentions must remain capped at 50");
      assert.equal(details.reviews.length,30,"Reviews must remain capped at 30");
      assert.equal(details.assessments.length,30,"Assessment history must remain capped at 30");
      assert.equal(reopened.getEntity(project.id,shared)?.observationCount,70,
        "Historical claims are retained in the observation count");
      assert.equal(reopened.entityProvenanceBatch("unrelated-project",[shared]).get(shared)?.mentions.length,0,
        "Project identity must isolate provenance");
      assert.deepEqual(reopened.entityProvenanceBatch(project.id,[]).size,0);
      assert.throws(()=>reopened.entityProvenanceBatch(project.id,Array(501).fill(shared)),/limit/);
      const crafted="'); DROP TABLE kb_reviews;--";
      assert.equal(reopened.entityProvenanceBatch(project.id,[crafted]).get(crafted)?.mentions.length,0,
        "Entity identity must be parameterized, not interpolated into SQL");
    }finally{reopened.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
