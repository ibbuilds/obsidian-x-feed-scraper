import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {loadProject} from "../packages/core/project-config.ts";
import {runProject} from "../packages/core/engine.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

test("a bounded work budget persists a cursor and continues to completion across runs",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"discovery-work-budget-")),db=join(dir,"library.sqlite");
 try{
  const project=loadProject(resolve("examples/frontend/project.json"));
  const registry=createDefaultRegistry();
  for(let page=1;page<=4;page++){
   const run=await runProject(db,project,registry,{pageSize:1,maxPages:1});
   assert.equal(run.observations,1);
   assert.equal(run.runs.length,1);
   assert.equal(run.runs[0].status,page===4?"success":"partial");
   assert.equal(run.success,page===4);
   const store=new KnowledgeStore(db);
   assert.equal(store.cursor(project.id,"shared-observations"),String(page));
   assert.equal(store.runs(project.id)[0].status,page===4?"success":"partial");
   store.close();
  }
  const store=new KnowledgeStore(db);
  assert.ok(store.listEntities(project.id).length>=4);
  assert.equal(store.listObservations(project.id).length,4);
  store.close();
  const replay=await runProject(db,project,registry,{pageSize:1,maxPages:1});
  assert.equal(replay.success,true);
  assert.equal(replay.observations,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
