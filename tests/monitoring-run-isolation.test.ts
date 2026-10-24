import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseProject} from "../packages/core/project-config.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

function project(id:string,file:string,adapter="json-snapshot"){
  return parseProject({id,name:id,
    sources:[{id:"shared-source",adapter,config:{path:file}}],
    pipeline:["observation-entity"],
    watch:{rules:[
      {id:"new-item",operator:"created",path:"$"},
      {id:"price-drop",operator:"decrease-percent",path:"/attributes/price",
        threshold:10,requireUnchanged:["/attributes/currency"]}
    ]}
  });
}
function writePrices(file:string,price:number){
  writeFileSync(file,JSON.stringify([
    {id:"watched",type:"product",title:"Watched product",attributes:{price,currency:"USD"}},
    {id:"other",type:"product",title:"Other product",attributes:{price:50,currency:"USD"}}
  ]));
}
function state(db:string,projectId:string){
  const store=new KnowledgeStore(db);
  try{
    return {entity:store.getEntity(projectId,"product:watched"),
      reviews:store.entityEvidence(projectId,"product:watched")?.reviews,
      changes:store.listChanges(projectId),alerts:store.listAlerts(projectId),
      versions:store.listVersions(projectId,"product:watched"),
      observationVersions:store.db.prepare(
        "SELECT COUNT(*) n FROM kb_observation_versions WHERE project_id=?"
      ).get(projectId)?.n};
  }finally{store.close();}
}

test("reusing a caller signal refreshes each snapshot run without duplicating history or losing reviews",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-run-refresh-"));
  const file=join(root,"snapshot.json"),db=join(root,"library.db");
  const definition=project("refresh-check",file),registry=createDefaultRegistry();
  const signal=new AbortController().signal;
  try{
    writePrices(file,100);
    const first=await runProject(db,definition,registry,{signal,pageSize:1});
    assert.equal(first.success,true,JSON.stringify(first.runs));
    assert.equal(first.newEntities,2);
    const store=new KnowledgeStore(db);
    let reviews;
    try{
      store.reviewEntity(definition.id,"product:watched","approved","Human approval survives refresh");
      reviews=store.entityEvidence(definition.id,"product:watched")!.reviews;
    }finally{store.close();}

    writePrices(file,80);
    const updated=await runProject(db,definition,registry,{signal,pageSize:1});
    assert.equal(updated.success,true,JSON.stringify(updated.runs));
    const after=state(db,definition.id);
    assert.equal(after.entity?.attributes.price,80);
    assert.equal(after.entity?.review,"approved");
    assert.deepEqual(after.reviews,reviews);
    assert.equal(after.versions.length,2);
    assert.equal(after.observationVersions,3);
    assert.equal(after.alerts.filter(alert=>alert.ruleId==="price-drop").length,1);
    assert.equal(after.alerts.find(alert=>alert.ruleId==="price-drop")?.before,100);
    assert.equal(after.alerts.find(alert=>alert.ruleId==="price-drop")?.after,80);

    const repeated=await runProject(db,definition,registry,{signal,pageSize:1});
    assert.equal(repeated.success,true,JSON.stringify(repeated.runs));
    assert.deepEqual(state(db,definition.id),after,
      "An unchanged snapshot must preserve versions, changes, alerts and human reviews");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("projects sharing a caller signal and connection ID collect only their own snapshots",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-run-projects-"));
  const db=join(root,"library.db"),registry=createDefaultRegistry();
  const signal=new AbortController().signal;
  try{
    for(const id of ["alpha","bravo"]){
      const file=join(root,id+".json");
      writeFileSync(file,JSON.stringify([
        {id:id+"-item",type:"record",title:id,attributes:{origin:id}}
      ]));
      const result=await runProject(db,project(id,file),registry,{signal});
      assert.equal(result.success,true,JSON.stringify(result.runs));
    }
    const store=new KnowledgeStore(db);
    try{
      for(const id of ["alpha","bravo"]){
        const records=store.listEntities(id);
        assert.deepEqual(records.map(record=>record.key),["record:"+id+"-item"]);
        assert.equal(records[0].attributes.origin,id);
        assert.equal(store.listVersions(id,records[0].key).length,1);
      }
    }finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("a pre-aborted caller signal prevents source collection",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-run-preabort-"));
  const db=join(root,"library.db"),registry=createDefaultRegistry();
  const controller=new AbortController();
  let calls=0;
  registry.sources.set("abort-check",{id:"abort-check",async collect(){
    calls++;
    return {observations:[],hasMore:false};
  }});
  try{
    controller.abort(new Error("Stop before collection"));
    const result=await runProject(db,project("preabort",root,"abort-check"),registry,
      {signal:controller.signal});
    assert.equal(result.success,false);
    assert.match(result.runs[0].error||"",/Processing aborted/);
    assert.equal(calls,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("caller cancellation reaches an active source with its original reason",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-run-cancel-"));
  const db=join(root,"library.db"),registry=createDefaultRegistry();
  const controller=new AbortController(),reason=new Error("Stop active collection");
  let receivedReason:unknown;
  registry.sources.set("abort-check",{id:"abort-check",async collect({signal}){
    await Promise.resolve();
    receivedReason=signal.reason;
    signal.throwIfAborted();
    return {observations:[],hasMore:false};
  }});
  try{
    const pending=runProject(db,project("cancel-check",root,"abort-check"),registry,
      {signal:controller.signal});
    controller.abort(reason);
    const result=await pending;
    assert.equal(receivedReason,reason);
    assert.equal(result.success,false);
    assert.match(result.runs[0].error||"",/Stop active collection/);
    const store=new KnowledgeStore(db);
    try{
      assert.equal(store.cursor("cancel-check","shared-source"),undefined);
      assert.deepEqual(store.listEntities("cancel-check"),[]);
    }finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("a page returned after cancellation cannot commit observations, history, alerts or its cursor",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-run-late-page-"));
  const db=join(root,"library.db"),registry=createDefaultRegistry();
  const controller=new AbortController();
  registry.sources.set("late-page",{id:"late-page",async collect(){
    await Promise.resolve();
    // A source may finish an in-flight request even when it cannot abort it.
    return {observations:[{id:"late",type:"record",title:"Late arrival"}],
      hasMore:false,nextCursor:"finished"};
  }});
  try{
    const pending=runProject(db,project("late-check",root,"late-page"),registry,
      {signal:controller.signal});
    controller.abort(new Error("Stop pending page"));
    const result=await pending;
    assert.equal(result.success,false);
    assert.match(result.runs[0].error||"",/Processing aborted/);
    assert.equal(result.observations,0);
    const store=new KnowledgeStore(db);
    try{
      assert.equal(store.cursor("late-check","shared-source"),undefined);
      assert.deepEqual(store.listObservations("late-check"),[]);
      assert.deepEqual(store.listEntities("late-check"),[]);
      assert.deepEqual(store.listChanges("late-check"),[]);
      assert.deepEqual(store.listAlerts("late-check"),[]);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions").get()?.n,0);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_entity_versions").get()?.n,0);
    }finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
