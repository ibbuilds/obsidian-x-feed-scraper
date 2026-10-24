import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {registry,registerExtension} from "../packages/core/registry.ts";
import {loadProject,parseProject,validateEntity} from "../packages/core/project-config.ts";
import {runProject,reprocessProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {Store} from "../packages/storage/store.ts";
import {ingest} from "../packages/core/pipeline.ts";
import {readFixture} from "../packages/connectors/fixtures.ts";
import {loadProfile} from "../packages/core/profile.ts";

function demo(name:"frontend"|"security"){
 const manifest=resolve("examples",name,"project.json");
 const project=loadProject(manifest);
 project.sources[0].config.path=resolve("examples/shared/observations.json");
 return project;
}
test("different projects use same observations and reusable engine, including entities without links",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-general-")),db=join(root,"knowledge.sqlite");
 try{
  const registry=createDefaultRegistry(),frontend=demo("frontend"),security=demo("security");
  const first=await runProject(db,frontend,registry,{pageSize:2});
  const second=await runProject(db,security,registry,{pageSize:2});
  assert.equal(first.success,true,JSON.stringify(first.runs));
  assert.equal(second.success,true,JSON.stringify(second.runs));
  assert.equal(first.observations,4);
  assert.equal(second.observations,4);
  const store=new KnowledgeStore(db);
  assert.equal(store.listProjects().length,2);
  const repo=store.getEntity(frontend.id,"https://github.com/example/motion-kit")!;
  assert.ok(repo);
  assert.equal(repo.type,"web-resource");
  assert.equal(repo.observationCount,2,"Two posts must cite the same entity");
  const advisory=store.getEntity(security.id,"security-advisory:security-note")!;
  assert.equal(advisory.type,"security-advisory");
  assert.equal(advisory.attributes.severity,"high");
  assert.ok(advisory.score>=50);
  const science=store.getEntity(security.id,"research-note:science-note")!;
  assert.equal(science.url,undefined,"Non-web research entities must be accepted");
  assert.equal(store.getEntity(security.id,"https://github.com/example/motion-kit"),undefined);
  const approved=store.reviewEntity(frontend.id,repo.key,"approved","Verified source");
  assert.equal(approved.review,"approved");
  store.close();
  const again=await runProject(db,frontend,registry);
  assert.equal(again.success,true);
  assert.equal(again.observations,0,"JSON cursor prevents replaying already ingested observations");
  const reopened=new KnowledgeStore(db);
  assert.equal(reopened.getEntity(frontend.id,repo.key)?.review,"approved");
  assert.equal(reopened.listEntities(frontend.id).filter(x=>x.key===repo.key).length,1);
  reopened.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("resumable paging does not advance cursors when processor fails",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-checkpoint-")),db=join(root,"knowledge.sqlite");
 try{
  let broken=true;
  const ext=registry();
  registerExtension(ext,{apiVersion:1,adapters:[{id:"paged",
    async collect({cursor}){
      if(!cursor)return {observations:[{id:"1",type:"ticket",title:"First"}],nextCursor:"1",hasMore:true};
      return {observations:[{id:broken?"":"2",type:"ticket",title:"Second"}],
        nextCursor:"done",hasMore:false};
    }
  }],processors:[{id:"extract",
    run(_context,obs){return [{key:"ticket:"+obs.id,type:"ticket",title:obs.title||obs.id}];}
  }],evaluators:[{id:"neutral",
    assess(){return {category:"work",score:50,confidence:0.5,reasons:["Observed ticket"]};}
  }]});
  const project=parseProject({id:"resumable",name:"Resumable Project",sources:[{
    id:"tickets",adapter:"paged",config:{}
  }],pipeline:["extract"],evaluator:"neutral",policy:{includeKeywords:[],
    excludeKeywords:[],minimumScore:0}});
  const failed=await runProject(db,project,ext,{pageSize:1});
  assert.equal(failed.success,false);
  const check=new KnowledgeStore(db);
  assert.equal(check.cursor("resumable","tickets"),"1");
  assert.equal(check.listEntities("resumable").length,1);
  assert.equal(check.runs("resumable")[0].status,"failed");
  check.close();
  broken=false;
  const recovered=await runProject(db,project,ext,{pageSize:1});
  assert.equal(recovered.success,true);
  assert.equal(recovered.observations,1);
  const final=new KnowledgeStore(db);
  assert.equal(final.listEntities("resumable").length,2);
  assert.equal(final.cursor("resumable","tickets"),"done");
  final.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("offline reprocessing changes score but never loses human review or refetches sources",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-reprocess-")),db=join(root,"knowledge.sqlite");
 try{
  const registry=createDefaultRegistry(),project=demo("frontend");
  await runProject(db,project,registry);
  const before=new KnowledgeStore(db);
  const key="https://github.com/example/motion-kit";
  assert.ok(before.getEntity(project.id,key)!.score>0);
  before.reviewEntity(project.id,key,"approved","Human review must persist");
  before.close();
  project.policy.includeKeywords=["quantum-accelerator-unlikely"];
  const reassessed=await reprocessProject(db,project,registry);
  assert.ok(reassessed.reassessed>=3);
  const after=new KnowledgeStore(db);
  assert.equal(after.getEntity(project.id,key)!.score,0);
  assert.equal(after.getEntity(project.id,key)!.review,"approved");
  after.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("generic Obsidian sink protects existing References and user-modified notes",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-export-")),db=join(root,"knowledge.sqlite");
 const vault=join(root,"vault");mkdirSync(vault);
 const references="# Existing\n- [Untouched](https://example.org/old)\n";
 writeFileSync(join(vault,"References.md"),references);
 try{
  const registry=createDefaultRegistry(),project=demo("frontend");
  await runProject(db,project,registry);
  const store=new KnowledgeStore(db);
  const records=store.listEntities(project.id).filter(x=>x.score>=project.policy.minimumScore);
  store.close();
  const adapter=registry.outputs.get("obsidian")!;
  const opts={project,records,config:{folder:"Discovery Engine"},databasePath:db,vaultPath:vault};
  const first=await adapter.export(opts) as {created:number};
  assert.ok(first.created>=2);
  const dir=join(vault,"Discovery Engine",project.id);
  const note=readdirSync(dir).find(name=>name.endsWith(".md"))!;
  const path=join(dir,note),original=readFileSync(path,"utf8");
  writeFileSync(path,original+"\nMy annotation\n");
  const after=await adapter.export(opts) as {conflicts:number;conflictPaths:string[]};
  assert.ok(after.conflicts>=1);
  assert.ok(after.conflictPaths.some(p=>p.endsWith(note)));
  assert.equal(readFileSync(path,"utf8"),original+"\nMy annotation\n");
  assert.equal(readFileSync(join(vault,"References.md"),"utf8"),references);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("v0.4 database migration preserves posts, source relationships and reviews; it is idempotent",()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-legacy-")),db=join(root,"existing.db");
 try{
  const fixture=readFixture("./tests/fixtures/posts.json");
  ingest(db,fixture,loadProfile("./profiles/design.json"));
  const old=new Store(db);
  const source=old.listSources().find(s=>s.url.startsWith("https://github.com/"))!;
  old.review(source.id,"approved","Important previous review");
  const oldStats=old.stats();old.close();
  const newStore=new KnowledgeStore(db);
  const migrated=newStore.getEntity("legacy-x-feed",source.url)!;
  assert.ok(migrated);
  assert.equal(migrated.review,"approved");
  assert.ok(migrated.observationCount>=1);
  assert.equal(newStore.listObservations("legacy-x-feed").length,4);
  newStore.close();
  const again=new KnowledgeStore(db);
  assert.equal(again.listEntities("legacy-x-feed").length,3);
  assert.equal(again.db.prepare("SELECT COUNT(*) n FROM kb_reviews").get()?.n,1);
  assert.equal(again.stats().posts,oldStats.posts);
  again.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("independent CJS extension supplies a new adapter, extractor and evaluator",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-extension-")),db=join(root,"library.db");
 try{
  const registry=createDefaultRegistry([resolve("examples/extensions/tickets.cjs")]);
  const project=loadProject(resolve("examples/tickets/project.json"));
  const result=await runProject(db,project,registry,{pageSize:1});
  assert.equal(result.success,true,JSON.stringify(result.runs));
  const store=new KnowledgeStore(db);
  assert.equal(store.getEntity(project.id,"ticket:T-1")!.score,100);
  assert.equal(store.getEntity(project.id,"ticket:T-2")!.score,40);
  store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("strict schemas and malformed projects fail before ingesting any data",()=>{
 assert.throws(()=>parseProject({id:"__invalid__",name:"X",sources:[]}),/source|id/i);
 assert.throws(()=>validateEntity({key:"e",type:"ticket",title:"Bad",attributes:{severity:12}},
   {ticket:{fields:{severity:"string"},required:["severity"]}}),/Invalid attribute/);
 assert.throws(()=>parseProject({id:"usable",name:"test",sources:[
   {id:"dup",adapter:"rss",config:{}},{id:"dup",adapter:"rss",config:{}}
 ]}),/Duplicate connection/);
});
test("project CLI runs without Obsidian and persists a queryable library",()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-cli-")),db=join(root,"knowledge.db");
 try{
  const first=spawnSync(process.execPath,["--experimental-strip-types","apps/collector/cli.ts",
    "project","sync","--project","examples/frontend/project.json","--db",db,"--page-size","2"],
    {encoding:"utf8",timeout:25000});
  assert.equal(first.status,0,first.stderr);
  const result=JSON.parse(first.stdout) as {success:boolean;observations:number};
  assert.equal(result.success,true);
  assert.equal(result.observations,4);
  const second=spawnSync(process.execPath,["--experimental-strip-types","apps/collector/cli.ts",
    "project","entities","--id","frontend-discovery","--db",db],{encoding:"utf8",timeout:25000});
  assert.equal(second.status,0,second.stderr);
  assert.ok((JSON.parse(second.stdout) as unknown[]).length>=4);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("changing a connector source behind an existing checkpoint is forbidden",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-source-identity-")),db=join(root,"db.sqlite");
 try{
  const registry=createDefaultRegistry(),project=demo("frontend");
  const first=await runProject(db,project,registry);
  assert.equal(first.success,true);
  const changed=demo("frontend");
  changed.sources[0].config.path=resolve("examples/security/project.json");
  await assert.rejects(runProject(db,changed,registry),
    /changed source configuration/);
  const existing=new KnowledgeStore(db);
  assert.equal(existing.listEntities(project.id).length>=1,true);
  existing.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("opt-in public metadata processor does not retrieve unsafe local network URLs",async()=>{
 const registry=createDefaultRegistry(),project=demo("frontend");
 const source=project.sources[0];
 const processor=registry.processors.get("public-metadata")!;
 const signal=new AbortController().signal;
 const result=await processor.run({project,source,signal},
   {id:"unsafe",type:"community-post",text:"Local destination"},
   [{key:"http://127.0.0.1/admin",type:"web-resource",title:"Internal service",
     url:"http://127.0.0.1/admin"}]);
 assert.equal(result.length,1);
 assert.equal(result[0].url,"http://127.0.0.1/admin");
 assert.ok(result[0].evidence?.some(entry=>entry.signal==="metadata-unavailable"));
});

test("type collisions abort the page without corrupting previously committed entities",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-collision-")),db=join(root,"db.sqlite");
 try{
  const ext=registry();
  registerExtension(ext,{apiVersion:1,adapters:[{
    id:"identity",
    async collect({cursor}){
      if(!cursor)return {observations:[{id:"first",type:"record",title:"Original"}],
        nextCursor:"first",hasMore:true};
      return {observations:[{id:"second",type:"record",title:"Conflicting"}],
        nextCursor:"done",hasMore:false};
    }
  }],processors:[{id:"same-key",
    run(_ctx,observation){
      return [{key:"shared-key",type:observation.id==="first"?"record":"ticket",
        title:observation.title||""}];
    }
  }],evaluators:[{id:"fixed",
    assess(){return {category:"test",score:40,confidence:0.5,reasons:["Validated"]};}
  }]});
  const project=parseProject({id:"collision-proof",name:"Collision Proof",sources:[
    {id:"primary",adapter:"identity",config:{}}
  ],pipeline:["same-key"],evaluator:"fixed"});
  const result=await runProject(db,project,ext);
  assert.equal(result.success,false);
  assert.match(result.runs[0].error||"",/identity reused/);
  const store=new KnowledgeStore(db);
  assert.equal(store.getEntity(project.id,"shared-key")?.type,"record");
  assert.equal(store.getEntity(project.id,"shared-key")?.title,"Original");
  assert.equal(store.cursor(project.id,"primary"),"first");
  store.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("evaluation provenance records the evaluator, changed scores and avoids duplicate history",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-assessment-history-"));
 const db=join(root,"knowledge.db");
 try{
  const project=demo("frontend"),extension=createDefaultRegistry();
  const first=await runProject(db,project,extension);
  assert.equal(first.success,true);
  const store=new KnowledgeStore(db),key="https://github.com/example/motion-kit";
  const initial=store.db.prepare(
    "SELECT evaluator_id,score FROM kb_assessments WHERE project_id=? AND entity_key=?"
  ).get(project.id,key) as {evaluator_id:string;score:number};
  assert.equal(initial.evaluator_id,"keyword","The evaluator is not the source adapter");
  const originalHistory=store.db.prepare(
    "SELECT COUNT(*) n FROM kb_assessment_history WHERE project_id=? AND entity_key=?"
  ).get(project.id,key) as {n:number};
  assert.ok(originalHistory.n>=1);
  store.close();
  project.policy.includeKeywords=["no-term-will-match-any-source"];
  const change=await reprocessProject(db,project,extension);
  assert.ok(change.reassessed>0);
  const reopened=new KnowledgeStore(db);
  const updated=reopened.getEntity(project.id,key)!;
  assert.ok(updated.score<initial.score);
  const entries=reopened.db.prepare(
    "SELECT evaluator_id,score FROM kb_assessment_history WHERE project_id=? AND entity_key=? ORDER BY id"
  ).all(project.id,key) as Array<{evaluator_id:string;score:number}>;
  assert.ok(entries.length>originalHistory.n);
  assert.equal(entries.at(-1)?.evaluator_id,"keyword");
  assert.equal(entries.at(-1)?.score,updated.score);
  reopened.close();
  const repeated=await reprocessProject(db,project,extension);
  assert.ok(repeated.reassessed>0);
  const same=new KnowledgeStore(db);
  const row=same.db.prepare(
    "SELECT COUNT(*) n FROM kb_assessment_history WHERE project_id=? AND entity_key=?"
  ).get(project.id,key) as {n:number};
  assert.equal(row.n,entries.length,"Idempotent rescoring must not flood the history");
  same.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("rejecting an entity retires only unedited generated output; user annotations survive",async()=>{
 const root=mkdtempSync(join(tmpdir(),"discovery-retire-"));
 const db=join(root,"db.sqlite"),vault=join(root,"vault");
 mkdirSync(vault);
 try{
  const project=demo("frontend"),registered=createDefaultRegistry();
  await runProject(db,project,registered);
  const store=new KnowledgeStore(db);
  const records=store.listEntities(project.id).filter(x=>x.score>=project.policy.minimumScore);
  const selected=records.find(x=>x.key==="https://github.com/example/motion-kit")!;
  assert.ok(selected);
  store.close();
  const adapter=registered.outputs.get("obsidian")!;
  const input={project,records,config:{folder:"Discovery Engine"},databasePath:db,vaultPath:vault};
  await adapter.export(input);
  const dir=join(vault,"Discovery Engine",project.id);
  const filename=createHash("sha256").update(selected.key).digest("hex").slice(0,24)+".md";
  const generated=join(dir,filename);
  assert.equal(existsSync(generated),true);
  const changed=new KnowledgeStore(db);
  changed.reviewEntity(project.id,selected.key,"rejected","Not useful for this library");
  const allowed=changed.listEntities(project.id).filter(x=>
    x.review!=="rejected"&&x.score>=project.policy.minimumScore);
  changed.close();
  const result=await adapter.export({...input,records:allowed}) as {removed:number};
  assert.ok(result.removed>=1);
  assert.equal(existsSync(generated),false);
  const userFile=join(dir,"personal.md");
  writeFileSync(userFile,"# My personal research\n");
  await adapter.export({...input,records:allowed});
  assert.equal(readFileSync(userFile,"utf8"),"# My personal research\n");
  // Reintroduce the entity, annotate the generated version, then reject again.
  const reopened=new KnowledgeStore(db);
  reopened.reviewEntity(project.id,selected.key,"pending","Reconsideration");
  const all=reopened.listEntities(project.id).filter(x=>
    x.review!=="rejected"&&x.score>=project.policy.minimumScore);
  reopened.close();
  await adapter.export({...input,records:all});
  const edited=readFileSync(generated,"utf8")+"Owner annotations\n";
  writeFileSync(generated,edited);
  const final=await adapter.export({...input,records:allowed}) as {conflicts:number};
  assert.ok(final.conflicts>=1);
  assert.equal(readFileSync(generated,"utf8"),edited);
 }finally{rmSync(root,{recursive:true,force:true});}
});
