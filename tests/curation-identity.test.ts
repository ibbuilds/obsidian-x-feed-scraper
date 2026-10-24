import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {parseProject,validateEntity} from "../packages/core/project-config.ts";
import {buildProject} from "../packages/core/project-builder.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import type {Observation,ProjectDefinition,ProjectSource} from "../packages/sdk/contracts.ts";

function source(id:string,namespace?:string):ProjectSource{
  return {id,adapter:"curation-records",config:namespace===undefined?{}:{entityNamespace:namespace}};
}
function project(sources=[source("board-a")],pipeline=["observation-entity"]){
  return parseProject({id:"curation-check",name:"Curation check",sources,pipeline});
}
function record(title="Company A role"):Observation{
  return {id:"123",type:"job-listing",title,attributes:{status:"open"}};
}
function recordsRegistry(records:Record<string,Observation[]>){
  const registry=createDefaultRegistry();
  registry.sources.set("curation-records",{id:"curation-records",async collect({source}){
    return {observations:records[source.id]||[],hasMore:false,nextCursor:"done"};
  }});
  return registry;
}
function read<T>(db:string,fn:(store:KnowledgeStore)=>T):T{
  const store=new KnowledgeStore(db);
  try{return fn(store);}finally{store.close();}
}

test("keyword policies trim terms and deduplicate case-insensitively without losing the first label",()=>{
  const definition=parseProject({...project(),policy:{
    includeKeywords:[" React ","react","REACT"," UI ","ui"],
    excludeKeywords:[" SPAM ","spam"],minimumScore:50
  }});
  assert.deepEqual(definition.policy.includeKeywords,["React","UI"]);
  assert.deepEqual(definition.policy.excludeKeywords,["SPAM"]);
  for(const field of ["includeKeywords","excludeKeywords"]){
    for(const value of [[""],["   "],["React",""]]){
      assert.throws(()=>parseProject({...project(),policy:{[field]:value}}),/terms must not be empty/);
    }
  }
  assert.deepEqual(project().policy.includeKeywords,[],"An explicitly empty list still means no positive filter");
});

test("SDK keyword evaluation cannot inflate scores with duplicates or accept blank policy terms",async()=>{
  const definition=project(),registry=createDefaultRegistry();
  const evaluator=registry.evaluators.get("keyword")!;
  const context={project:definition,source:definition.sources[0],signal:new AbortController().signal};
  const observation={id:"item",type:"record",title:"React components"};
  const entity={key:"resource",type:"web-resource",title:"React components"};
  definition.policy.includeKeywords=[" React ","react","REACT","React"];
  const relevant=await evaluator.assess(context,observation,entity);
  assert.equal(relevant.score,25,"One distinct matched term contributes once, below the 50-point inclusion threshold");
  assert.equal(relevant.category,"React");
  assert.deepEqual(relevant.reasons,["Matched project keywords: React"]);
  const unrelated=await evaluator.assess(context,{...observation,title:"Garden tools"},
    {...entity,title:"Garden tools"});
  assert.equal(unrelated.score,0);
  definition.policy.excludeKeywords=[" COMPONENTS ","components"];
  assert.equal((await evaluator.assess(context,observation,entity)).category,"excluded");
  for(const field of ["includeKeywords","excludeKeywords"] as const){
    definition.policy.includeKeywords=["React"];
    definition.policy.excludeKeywords=[];
    definition.policy[field]=[" "];
    await assert.rejects(async()=>evaluator.assess(context,observation,entity),/terms must not be empty/);
  }
  definition.policy.includeKeywords=[];
  definition.policy.excludeKeywords=[];
  assert.equal((await evaluator.assess(context,observation,entity)).score,50);
});

test("new guided observation projects opt into a stable namespace and validate keyword input",()=>{
  const setup={id:"guided-curation",name:"Guided curation",sourceType:"json-file" as const,
    sourcePath:resolve("examples/shared/observations.json"),mode:"observation-entity" as const};
  const definition=buildProject({...setup,includeKeywords:" React, react, UI ",excludeKeywords:" SPAM, spam "});
  assert.equal(definition.sources[0].config.entityNamespace,"primary-source");
  assert.deepEqual(definition.policy.includeKeywords,["React","UI"]);
  assert.deepEqual(definition.policy.excludeKeywords,["SPAM"]);
  assert.deepEqual(buildProject({...setup,includeKeywords:"   "}).policy.includeKeywords,[]);
  assert.throws(()=>buildProject({...setup,includeKeywords:", ,"}),/terms must not be empty/);
  assert.throws(()=>buildProject({...setup,excludeKeywords:"spam,,other"}),/terms must not be empty/);
  assert.equal(buildProject({...setup,mode:"linked-resources"}).sources[0].config.entityNamespace,undefined);
  assert.equal(project().sources[0].config.entityNamespace,undefined,"Existing manifests stay legacy unless explicitly migrated");
});

test("namespace validation and key framing keep arbitrary local ID delimiters unambiguous",async()=>{
  const registry=createDefaultRegistry(),processor=registry.processors.get("observation-entity")!;
  for(const value of [null,42,""," ","BoardA","board:a","a".repeat(65)]){
    assert.throws(()=>parseProject({...project(),sources:[{
      ...source("board-a"),config:{entityNamespace:value}
    }]}),/entity namespace/);
    const definition=project();
    definition.sources[0].config.entityNamespace=value as string;
    await assert.rejects(async()=>processor.run({project:definition,source:definition.sources[0],
      signal:new AbortController().signal},record(),[]),/entity namespace/);
  }
  const keys:string[]=[];
  for(const namespace of [undefined,"board-a","board-b"]){
    const definition=project([source("primary",namespace)]);
    const [entity]=await processor.run({project:definition,source:definition.sources[0],
      signal:new AbortController().signal},{...record(),id:"123:extra/@value"},[]);
    validateEntity(entity);
    keys.push(entity.key);
  }
  assert.deepEqual(keys,["job-listing:123:extra/@value",
    "@board-a:job-listing:123:extra/@value","@board-b:job-listing:123:extra/@value"]);
  assert.equal(new Set(keys).size,3);
});

test("provider namespaces separate overlapping local IDs and their human reviews",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-namespaced-providers-")),db=join(root,"library.db");
  const definition=project([source("board-a","provider-a"),source("board-b","provider-b")]);
  const records={"board-a":[record("Company A role")],"board-b":[record("Company B role")]};
  const registry=recordsRegistry(records);
  try{
    const first=await runProject(db,definition,registry);
    assert.equal(first.success,true,JSON.stringify(first.runs));
    assert.equal(first.newEntities,2);
    read(db,store=>{
      assert.deepEqual(store.listEntities(definition.id).map(entity=>entity.key).sort(),
        ["@provider-a:job-listing:123","@provider-b:job-listing:123"]);
      store.reviewEntity(definition.id,"@provider-a:job-listing:123","approved","Reviewed Company A");
    });
    records["board-b"]=[record("Company B updated role")];
    assert.equal((await runProject(db,definition,registry)).success,true);
    read(db,store=>{
      const a=store.getEntity(definition.id,"@provider-a:job-listing:123")!;
      const b=store.getEntity(definition.id,"@provider-b:job-listing:123")!;
      assert.equal(a.title,"Company A role");
      assert.equal(a.review,"approved");
      assert.equal(b.title,"Company B updated role");
      assert.equal(b.review,"pending");
      assert.equal(a.observationCount,1);
      assert.equal(b.observationCount,1);
    });
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("existing unnamespaced projects preserve their keys, reviews and version histories",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-legacy-identity-")),db=join(root,"library.db");
  const definition=project(),records={"board-a":[record()]},registry=recordsRegistry(records);
  try{
    assert.equal((await runProject(db,definition,registry)).success,true);
    const reviews=read(db,store=>{
      store.reviewEntity(definition.id,"job-listing:123","rejected","Human decision before update");
      return store.entityEvidence(definition.id,"job-listing:123")!.reviews;
    });
    records["board-a"]=[record("Updated title")];
    assert.equal((await runProject(db,definition,registry)).success,true);
    read(db,store=>{
      assert.deepEqual(store.listEntities(definition.id).map(entity=>entity.key),["job-listing:123"]);
      assert.equal(store.getEntity(definition.id,"job-listing:123")!.review,"rejected");
      assert.deepEqual(store.entityEvidence(definition.id,"job-listing:123")!.reviews,reviews);
      assert.equal(store.listVersions(definition.id,"job-listing:123").length,2);
    });
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("matching explicit namespaces intentionally deduplicate one entity across connections",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-shared-namespace-")),db=join(root,"library.db");
  const definition=project([source("board-a","shared-board"),source("mirror","shared-board")]);
  const registry=recordsRegistry({"board-a":[record()],mirror:[record()]});
  try{
    assert.equal((await runProject(db,definition,registry)).success,true);
    read(db,store=>{
      const entities=store.listEntities(definition.id);
      assert.equal(entities.length,1);
      assert.equal(entities[0].key,"@shared-board:job-listing:123");
      assert.equal(entities[0].observationCount,2);
      assert.equal(store.listVersions(definition.id,entities[0].key).length,1);
    });
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("adding, changing or removing a namespace behind an existing source checkpoint is rejected",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-stable-namespace-"));
  try{
    const changes:Array<[string|undefined,string|undefined]>=[
      [undefined,"board-a"],["board-a","board-b"],["board-a",undefined]
    ];
    for(const [index,[before,after]] of changes.entries()){
      const db=join(root,index+".db"),definition=project([source("board-a",before)]);
      const registry=recordsRegistry({"board-a":[record()]});
      assert.equal((await runProject(db,definition,registry)).success,true);
      const original=read(db,store=>({entities:store.listEntities(definition.id),
        cursor:store.cursor(definition.id,"board-a")}));
      const changed=project([source("board-a",after)]);
      await assert.rejects(runProject(db,changed,registry),/changed source configuration/);
      read(db,store=>{
        assert.deepEqual(store.listEntities(definition.id),original.entities);
        assert.equal(store.cursor(definition.id,"board-a"),original.cursor);
      });
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("legacy local ID collisions fail the new source page without changing retained entity or review",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-legacy-collision-")),db=join(root,"library.db");
  const definition=project(),registry=recordsRegistry({
    "board-a":[record("Original role")],"board-b":[record("Unrelated role")]
  });
  try{
    assert.equal((await runProject(db,definition,registry)).success,true);
    const reviews=read(db,store=>{
      store.reviewEntity(definition.id,"job-listing:123","approved","Original source reviewed");
      return store.entityEvidence(definition.id,"job-listing:123")!.reviews;
    });
    const expanded:ProjectDefinition={...definition,sources:[...definition.sources,source("board-b")]};
    const result=await runProject(db,expanded,registry);
    assert.equal(result.success,false);
    assert.equal(result.runs[1].status,"failed");
    assert.match(result.runs[1].error||"",/entityNamespace/);
    read(db,store=>{
      const entity=store.getEntity(definition.id,"job-listing:123")!;
      assert.equal(entity.title,"Original role");
      assert.equal(entity.review,"approved");
      assert.equal(entity.observationCount,1);
      assert.deepEqual(store.entityEvidence(definition.id,entity.key)!.reviews,reviews);
      assert.equal(store.listVersions(definition.id,entity.key).length,1);
      assert.equal(store.listEntities(definition.id).length,1);
      assert.equal(store.cursor(definition.id,"board-b"),undefined);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_observations WHERE connection_id=?")
        .get("board-b")?.n,0);
    });
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("custom processors retain intentional cross-source identities that resemble legacy keys",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-custom-identity-")),db=join(root,"library.db");
  const definition=project([source("board-a"),source("mirror")],["shared-key"]);
  const registry=recordsRegistry({"board-a":[record()],mirror:[record()]});
  registry.processors.set("shared-key",{id:"shared-key",run(){
    return [{key:"job-listing:123",type:"job-listing",title:"One intentionally shared role"}];
  }});
  try{
    const result=await runProject(db,definition,registry);
    assert.equal(result.success,true,JSON.stringify(result.runs));
    assert.equal(read(db,store=>store.listEntities(definition.id)[0].observationCount),2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
