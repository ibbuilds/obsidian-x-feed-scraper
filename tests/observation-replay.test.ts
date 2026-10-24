import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {parseProject} from "../packages/core/project-config.ts";
import {registry,registerExtension} from "../packages/core/registry.ts";
import {runProject,reprocessProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import type {Observation,EntityDraft,JsonRecord} from "../packages/sdk/contracts.ts";

type Captured={observation:Observation;draft:EntityDraft};
function setup(){
  const root=mkdtempSync(join(tmpdir(),"discovery-replay-")),db=join(root,"library.db");
  const state={rows:[] as Observation[],calls:0,factor:1,captured:[] as Captured[]};
  const extensions=registry();
  registerExtension(extensions,{apiVersion:1,adapters:[{
    id:"recorded-source",async collect(){
      state.calls++;
      return {observations:state.rows,hasMore:false,nextCursor:"latest"};
    }
  }],processors:[{
    id:"original-draft",run(_context,observation){
      const attributes=observation.attributes||{};
      return [{key:String(attributes.entityKey||"entity:"+observation.id),type:"record",
        title:observation.title||observation.id,url:observation.urls?.[0]||observation.url,
        attributes:attributes.draft as JsonRecord|undefined,
        evidence:[{signal:"source-claim",detail:String(attributes.claim||observation.id),
          confidence:Number(attributes.confidence??0.5)}]}];
    }
  }],evaluators:[{
    id:"input-sensitive",assess(_context,observation,draft){
      state.captured.push(JSON.parse(JSON.stringify({observation,draft})) as Captured);
      return {category:observation.id,score:Number(observation.attributes?.score??50)*state.factor,
        confidence:Number(observation.attributes?.confidence??0.5),
        reasons:[String(observation.attributes?.claim||observation.id)]};
    }
  }]});
  const project=parseProject({id:"replay-project",name:"Replay project",
    sources:[{id:"primary",adapter:"recorded-source",config:{}}],
    pipeline:["original-draft"],evaluator:"input-sensitive",
    watch:{rules:[{id:"created",operator:"created",path:"$"},
      {id:"claim-changed",operator:"changed",path:"/attributes/value"}]}
  });
  return {root,db,state,extensions,project};
}
function read<T>(db:string,fn:(store:KnowledgeStore)=>T):T{
  const store=new KnowledgeStore(db);
  try{return fn(store);}finally{store.close();}
}
function sourceHistory(store:KnowledgeStore){
  return Object.fromEntries([
    "kb_observation_versions","kb_entity_versions","kb_entity_changes",
    "kb_watch_alerts","kb_reviews","kb_checkpoints","kb_mentions"
  ].map(table=>[table,store.db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()]));
}
function byObservation(captured:Captured[]){
  return Object.fromEntries(captured.map(input=>[input.observation.id,input]));
}

test("offline replay preserves each observation and original draft across reopen without changing source history or reviews",async()=>{
  const ctx=setup();
  try{
    ctx.state.rows=[
      {id:"alpha",type:"post",title:"First claim",text:"",
        urls:["https://example.org/alpha","https://example.org/context"],
        occurredAt:"2026-09-01T10:00:00Z",attributes:{entityKey:"shared",claim:"First evidence",
          draft:{value:"alpha",onlyFirst:true},score:80,confidence:0.4}},
      {id:"bravo",type:"post",title:"Second claim",media:[],
        urls:["https://example.org/bravo"],occurredAt:"2026-09-02T10:00:00Z",
        attributes:{entityKey:"shared",claim:"Second evidence",draft:{value:null},score:40,confidence:0.9}},
      {id:"rejected",type:"post",title:"Other record",attributes:{claim:"Rejected evidence",score:10}}
    ];
    const run=await runProject(ctx.db,ctx.project,ctx.extensions);
    assert.equal(run.success,true,JSON.stringify(run.runs));
    const original=byObservation(ctx.state.captured);
    read(ctx.db,store=>{
      store.reviewEntity(ctx.project.id,"shared","approved","Retain human approval");
      store.reviewEntity(ctx.project.id,"entity:rejected","rejected","Retain human rejection");
    });
    const before=read(ctx.db,sourceHistory),calls=ctx.state.calls;
    ctx.state.captured=[];
    const result=await reprocessProject(ctx.db,ctx.project,ctx.extensions);
    assert.deepEqual(result,{entities:2,reassessed:2});
    assert.deepEqual(byObservation(ctx.state.captured),original,
      "Each evaluator input must retain its own draft, evidence, URLs and timestamp");
    assert.equal(ctx.state.calls,calls,"Offline replay must not call source adapters");
    assert.deepEqual(read(ctx.db,sourceHistory),before);
    read(ctx.db,store=>{
      assert.equal(store.getEntity(ctx.project.id,"shared")?.review,"approved");
      assert.equal(store.getEntity(ctx.project.id,"entity:rejected")?.review,"rejected");
    });
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("updated observations replace timestamps and URLs and replay explicit null separately from absent fields",async()=>{
  const ctx=setup();
  try{
    const revisions:Observation[]=[
      {id:"mutable",type:"post",title:"Initial",text:"Initial text",
        occurredAt:"2026-09-01T10:00:00Z",urls:["https://example.org/old"],media:["https://example.org/old.png"],
        attributes:{claim:"old",draft:{value:"old",retained:"original"}}},
      {id:"mutable",type:"post",title:"Updated",text:"",occurredAt:"2026-09-03T12:00:00Z",
        urls:["https://example.org/new"],media:[],attributes:{claim:"new",draft:{value:null}}},
      {id:"mutable",type:"post",title:"",attributes:{claim:"absent",draft:{}}}
    ];
    for(const row of revisions){
      ctx.state.rows=[row];ctx.state.captured=[];
      const run=await runProject(ctx.db,ctx.project,ctx.extensions);
      assert.equal(run.success,true,JSON.stringify(run.runs));
      const original=ctx.state.captured[0],calls=ctx.state.calls;
      read(ctx.db,store=>{
        assert.equal(store.listObservations(ctx.project.id)[0].occurred_at,row.occurredAt??null);
      });
      const before=read(ctx.db,sourceHistory);
      ctx.state.captured=[];
      await reprocessProject(ctx.db,ctx.project,ctx.extensions);
      assert.equal(ctx.state.calls,calls);
      assert.deepEqual(ctx.state.captured,[original]);
      assert.deepEqual(read(ctx.db,sourceHistory),before);
    }
    read(ctx.db,store=>{
      const entity=store.getEntity(ctx.project.id,"entity:mutable")!;
      assert.equal(entity.attributes.value,null,"Explicit null remains a recorded change");
      assert.equal(entity.attributes.retained,"original","Absent draft fields keep partial-update semantics");
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions").get()?.n,3);
      assert.equal(store.listAlerts(ctx.project.id).filter(alert=>alert.ruleId==="claim-changed").length,1);
    });
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("current assessment can decline and all aggregate fields come from the same current mention",async()=>{
  const ctx=setup();
  const rows=(aScore:number,aConfidence:number,bScore:number,bConfidence:number):Observation[]=>[
    {id:"alpha",type:"post",title:"Shared entity",attributes:{entityKey:"shared",score:aScore,
      confidence:aConfidence,claim:"alpha current claim"}},
    {id:"bravo",type:"post",title:"Shared entity",attributes:{entityKey:"shared",score:bScore,
      confidence:bConfidence,claim:"bravo current claim"}}
  ];
  try{
    ctx.state.rows=rows(90,0.2,60,0.8);
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    read(ctx.db,store=>{
      const entity=store.getEntity(ctx.project.id,"shared")!;
      assert.equal(entity.score,90);assert.equal(entity.confidence,0.2);
      assert.equal(entity.category,"alpha");assert.deepEqual(entity.reasons,["alpha current claim"]);
      store.reviewEntity(ctx.project.id,"shared","approved","Approved independently of machine scores");
    });
    ctx.state.rows=rows(10,0.9,60,0.8);
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    read(ctx.db,store=>{
      const entity=store.getEntity(ctx.project.id,"shared")!;
      assert.equal(entity.score,60);assert.equal(entity.confidence,0.8);
      assert.equal(entity.category,"bravo");assert.deepEqual(entity.reasons,["bravo current claim"]);
      assert.equal(entity.review,"approved");
    });
    ctx.state.rows=rows(10,0.9,5,0.4);
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const history=read(ctx.db,store=>store.entityEvidence(ctx.project.id,"shared")!.assessments);
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    assert.deepEqual(read(ctx.db,store=>store.entityEvidence(ctx.project.id,"shared")!.assessments),history,
      "Repeating the same current evidence must not append duplicate assessments");
    const before=read(ctx.db,sourceHistory),calls=ctx.state.calls;
    ctx.state.factor=0.5;
    await reprocessProject(ctx.db,ctx.project,ctx.extensions);
    assert.equal(ctx.state.calls,calls);
    assert.deepEqual(read(ctx.db,sourceHistory),before);
    read(ctx.db,store=>{
      const entity=store.getEntity(ctx.project.id,"shared")!;
      assert.equal(entity.score,5);assert.equal(entity.confidence,0.9);
      assert.equal(entity.category,"alpha");assert.deepEqual(entity.reasons,["alpha current claim"]);
      assert.equal(entity.review,"approved");
    });
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("legacy replay migration restores only known immutable snapshots and does not invent historical assessments",async()=>{
  const ctx=setup();
  try{
    ctx.state.rows=[
      {id:"versioned",type:"post",title:"Current",text:"",urls:["https://example.org/current"],
        occurredAt:"2026-09-05T15:00:00Z",attributes:{claim:"Versioned evidence",score:85}},
      {id:"old",type:"post",title:"Known old record",text:"Known old text",
        occurredAt:"2026-08-01T00:00:00Z",attributes:{claim:"Old evidence",score:35}}
    ];
    const latest=ctx.state.rows[0];
    ctx.state.rows[0]={...latest,title:"Earlier",urls:["https://example.org/earlier"],
      occurredAt:"2026-09-01T00:00:00Z"};
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    ctx.state.rows[0]=latest;
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    read(ctx.db,store=>{
      store.reviewEntity(ctx.project.id,"entity:versioned","approved","Preserve old approval");
      store.reviewEntity(ctx.project.id,"entity:old","rejected","Preserve old rejection");
    });
    // Construct the previous schema in this isolated fixture. Its aggregate
    // scores exist, but original drafts and per-mention assessments did not.
    const old=new DatabaseSync(ctx.db);
    old.exec("DROP TABLE IF EXISTS kb_mention_assessments");
    // Simulated pre-v0.9 schema cannot retain an index on a column it lacks.
    old.exec("DROP INDEX IF EXISTS kb_missing_observation_json");
    for(const [table,column] of [["kb_observations","observation_json"],["kb_mentions","draft_json"],
      ["kb_mentions","observation_json"],["kb_mentions","active"]]){
      const columns=old.prepare("PRAGMA table_info("+table+")").all() as Array<{name:string}>;
      if(columns.some(entry=>entry.name===column))old.exec("ALTER TABLE "+table+" DROP COLUMN "+column);
    }
    old.prepare("UPDATE kb_observations SET occurred_at='2026-09-01T00:00:00Z' WHERE item_id='versioned'").run();
    old.prepare("DELETE FROM kb_observation_versions WHERE item_id='old'").run();
    const before=Object.fromEntries([
      "kb_observation_versions","kb_entity_versions","kb_entity_changes","kb_watch_alerts",
      "kb_reviews","kb_checkpoints","kb_assessments","kb_assessment_history"
    ].map(table=>[table,old.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()]));
    old.close();

    for(let reopen=0;reopen<2;reopen++)read(ctx.db,store=>{
      const known=store.db.prepare(
        "SELECT observation_json,occurred_at FROM kb_observations WHERE item_id='versioned'"
      ).get() as {observation_json:string;occurred_at:string};
      assert.equal(known.occurred_at,"2026-09-05T15:00:00Z");
      assert.deepEqual(JSON.parse(known.observation_json).urls,["https://example.org/current"]);
      assert.equal(store.db.prepare("SELECT observation_json FROM kb_observations WHERE item_id='old'").get()?.observation_json,null);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_mention_assessments").get()?.n,0);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_mentions WHERE draft_json IS NOT NULL").get()?.n,0);
      for(const [table,rows] of Object.entries(before)){
        assert.deepEqual(store.db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all(),rows);
      }
    });
    const calls=ctx.state.calls;
    ctx.state.captured=[];
    await reprocessProject(ctx.db,ctx.project,ctx.extensions);
    assert.equal(ctx.state.calls,calls);
    const replayed=byObservation(ctx.state.captured);
    assert.deepEqual(replayed.versioned.observation.urls,["https://example.org/current"]);
    assert.equal(replayed.versioned.observation.occurredAt,"2026-09-05T15:00:00Z");
    assert.equal(replayed.old.observation.urls,undefined,"Unknown old URLs must not be invented");
    assert.equal(replayed.old.observation.occurredAt,"2026-08-01T00:00:00Z");
    assert.equal(replayed.old.draft.evidence?.[0].detail,"Old evidence");
    read(ctx.db,store=>{
      assert.equal(store.getEntity(ctx.project.id,"entity:versioned")?.review,"approved");
      assert.equal(store.getEntity(ctx.project.id,"entity:old")?.review,"rejected");
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_mention_assessments").get()?.n,2);
      for(const table of ["kb_observation_versions","kb_entity_versions","kb_entity_changes",
        "kb_watch_alerts","kb_reviews","kb_checkpoints"]){
        assert.deepEqual(store.db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all(),before[table]);
      }
    });
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("an updated observation retires obsolete support without deleting entities or inferring closure from snapshot absence",async()=>{
  const ctx=setup();
  try{
    ctx.state.rows=[{id:"mutable",type:"post",title:"Original A",text:"Evidence for A",
      urls:["https://example.org/a"],occurredAt:"2026-09-01T00:00:00Z",
      attributes:{entityKey:"entity-a",score:90,confidence:0.9,claim:"Evidence A",draft:{status:"open"}}}];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const original=ctx.state.captured[0];
    read(ctx.db,store=>store.reviewEntity(ctx.project.id,"entity-a","approved","Keep historical record"));
    ctx.state.rows=[{id:"mutable",type:"post",title:"Replacement B",text:"Evidence for B",
      urls:["https://example.org/b"],occurredAt:"2026-09-05T00:00:00Z",
      attributes:{entityKey:"entity-b",score:10,confidence:0.3,claim:"Evidence B",draft:{status:"open"}}}];
    ctx.state.captured=[];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const replacement=ctx.state.captured[0];
    read(ctx.db,store=>{
      const a=store.getEntity(ctx.project.id,"entity-a")!;
      assert.equal(a.score,0);assert.equal(a.confidence,0);
      assert.match(a.reasons.join(" "),/active source mention/i);
      assert.equal(a.review,"approved");assert.equal(a.attributes.status,"open");
      const mention=store.db.prepare("SELECT observation_json,draft_json,active FROM kb_mentions WHERE entity_key='entity-a'")
        .get() as {observation_json:string;draft_json:string;active:number};
      assert.equal(mention.active,0);
      assert.deepEqual(JSON.parse(mention.observation_json),original.observation);
      assert.deepEqual(JSON.parse(mention.draft_json),original.draft);
      const evidence=store.entityEvidence(ctx.project.id,"entity-a")!.mentions[0];
      assert.equal(evidence.title,"Original A");
      assert.equal(evidence.occurredAt,"2026-09-01T00:00:00Z");
      assert.equal(evidence.active,false);
    });
    ctx.state.captured=[];
    const before=read(ctx.db,sourceHistory),calls=ctx.state.calls;
    assert.deepEqual(await reprocessProject(ctx.db,ctx.project,ctx.extensions),{entities:2,reassessed:1});
    assert.deepEqual(ctx.state.captured,[replacement],"Retired support must not be paired with the new observation");
    assert.equal(ctx.state.calls,calls);
    assert.deepEqual(read(ctx.db,sourceHistory),before);
    ctx.state.rows=[];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    read(ctx.db,store=>{
      assert.equal(store.getEntity(ctx.project.id,"entity-b")?.score,10);
      assert.equal(store.getEntity(ctx.project.id,"entity-b")?.attributes.status,"open");
      assert.equal(store.db.prepare("SELECT active FROM kb_mentions WHERE entity_key='entity-b'").get()?.active,1);
    });
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("extension mutations cannot rewrite canonical observations or the evaluator inputs retained for replay",async()=>{
  const ctx=setup();
  try{
    const originalProcessor=ctx.extensions.processors.get("original-draft")!;
    ctx.extensions.processors.set("original-draft",{id:"original-draft",async run(context,observation,previous){
      const result=await originalProcessor.run(context,observation,previous);
      observation.text="Changed by processor";
      return result;
    }});
    ctx.extensions.evaluators.set("input-sensitive",{id:"input-sensitive",assess(_context,observation,draft){
      ctx.state.captured.push(JSON.parse(JSON.stringify({observation,draft})) as Captured);
      const score=observation.text==="Original source"&&draft.title==="Original draft"?80:20;
      observation.text="Changed by evaluator";
      draft.title="Changed by evaluator";
      draft.evidence!.push({signal:"invented",detail:"Must not persist"});
      return {category:"record",score,confidence:0.5,reasons:["Based on original input"]};
    }});
    ctx.state.rows=[{id:"mutable",type:"post",title:"Original draft",text:"Original source"}];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const original=ctx.state.captured[0],before=read(ctx.db,sourceHistory),calls=ctx.state.calls;
    read(ctx.db,store=>{
      const entity=store.getEntity(ctx.project.id,"entity:mutable")!;
      assert.equal(entity.score,80);assert.equal(entity.title,"Original draft");
      const observation=store.db.prepare("SELECT observation_json FROM kb_observations").get()?.observation_json;
      assert.equal(JSON.parse(String(observation)).text,"Original source");
      assert.equal(store.entityEvidence(ctx.project.id,entity.key)!.mentions[0].evidence instanceof Array,true);
      assert.deepEqual(store.entityEvidence(ctx.project.id,entity.key)!.mentions[0].evidence,original.draft.evidence);
    });
    ctx.state.captured=[];
    await reprocessProject(ctx.db,ctx.project,ctx.extensions);
    assert.deepEqual(ctx.state.captured,[original]);
    assert.equal(ctx.state.calls,calls);
    assert.deepEqual(read(ctx.db,sourceHistory),before);
    assert.equal(read(ctx.db,store=>store.getEntity(ctx.project.id,"entity:mutable")?.score),80);
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("cancelling a replacement observation leaves active support and its assessment untouched",async()=>{
  const ctx=setup();
  try{
    ctx.state.rows=[{id:"mutable",type:"post",title:"Original",attributes:{entityKey:"entity-a",score:80}}];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const before=read(ctx.db,store=>({source:sourceHistory(store),
      assessments:store.db.prepare("SELECT * FROM kb_mention_assessments ORDER BY rowid").all(),
      entity:store.getEntity(ctx.project.id,"entity-a")}));
    ctx.state.rows=[{id:"mutable",type:"post",title:"Replacement",attributes:{entityKey:"entity-b",score:10}}];
    const controller=new AbortController();
    const pending=runProject(ctx.db,ctx.project,ctx.extensions,{signal:controller.signal});
    controller.abort(new Error("Cancel replacement"));
    assert.equal((await pending).success,false);
    assert.deepEqual(read(ctx.db,store=>({source:sourceHistory(store),
      assessments:store.db.prepare("SELECT * FROM kb_mention_assessments ORDER BY rowid").all(),
      entity:store.getEntity(ctx.project.id,"entity-a")})),before);
    assert.equal(read(ctx.db,store=>store.getEntity(ctx.project.id,"entity-b")),undefined);
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("unchanged conflicting mentions cannot manufacture repeated entity versions or revert a changed claim",async()=>{
  const ctx=setup();
  const audit=()=>read(ctx.db,store=>({versions:store.listVersions(ctx.project.id,"shared"),
    changes:store.listChanges(ctx.project.id),alerts:store.listAlerts(ctx.project.id)}));
  try{
    const alpha:Observation={id:"alpha",type:"post",title:"Shared",
      attributes:{entityKey:"shared",claim:"Alpha evidence",draft:{value:"alpha",order:1}}};
    const bravo:Observation={id:"bravo",type:"post",title:"Shared",
      attributes:{entityKey:"shared",claim:"Bravo evidence",draft:{value:"bravo",order:1}}};
    ctx.state.rows=[alpha,bravo];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const initial=audit();
    // Different iteration and object-key order cannot turn unchanged claims
    // into a new observed entity state.
    bravo.attributes!.draft={order:1,value:"bravo"};
    ctx.state.rows=[bravo,alpha];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    assert.deepEqual(audit(),initial);
    alpha.attributes!.draft={value:"changed",order:1};
    ctx.state.rows=[alpha,bravo];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    assert.equal(read(ctx.db,store=>store.getEntity(ctx.project.id,"shared")?.attributes.value),"changed",
      "The unchanged later mention must not revert a newly observed change");
    const updated=audit();
    assert.equal(updated.versions.length,initial.versions.length+1);
    assert.equal(updated.changes.length,initial.changes.length+1);
    assert.equal(updated.alerts.length,initial.alerts.length+1);
    bravo.attributes!.claim="Updated provenance only";
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    assert.deepEqual(audit(),updated,"Evidence-only refreshes do not overwrite structural entity state");
    assert.equal(read(ctx.db,store=>store.entityEvidence(ctx.project.id,"shared")!.mentions
      .find(mention=>mention.itemId==="bravo")!.evidence as Array<{detail:string}>)[0].detail,"Updated provenance only");
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});

test("a previously retired mention can establish its claim again when it is actually observed",async()=>{
  const ctx=setup();
  try{
    const alpha:Observation={id:"alpha",type:"post",title:"Shared",
      attributes:{entityKey:"shared",draft:{value:"alpha"}}};
    const bravo:Observation={id:"bravo",type:"post",title:"Shared",
      attributes:{entityKey:"shared",draft:{value:"bravo"}}};
    ctx.state.rows=[alpha,bravo];
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    alpha.attributes!.entityKey="elsewhere";
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    const before=read(ctx.db,store=>store.listVersions(ctx.project.id,"shared").length);
    alpha.attributes!.entityKey="shared";
    assert.equal((await runProject(ctx.db,ctx.project,ctx.extensions)).success,true);
    read(ctx.db,store=>{
      assert.equal(store.getEntity(ctx.project.id,"shared")?.attributes.value,"alpha");
      assert.equal(store.listVersions(ctx.project.id,"shared").length,before+1);
      assert.equal(store.db.prepare("SELECT active FROM kb_mentions WHERE entity_key='shared' AND item_id='alpha'").get()?.active,1);
    });
  }finally{rmSync(ctx.root,{recursive:true,force:true});}
});
