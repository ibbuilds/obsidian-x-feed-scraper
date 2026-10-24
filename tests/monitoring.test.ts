import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,copyFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {loadProject,parseProject} from "../packages/core/project-config.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject,reprocessProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {diffSnapshots,snapshot,matchingRules,sameJson} from "../packages/core/change-tracking.ts";
import {parseProductPage} from "../packages/adapters/product-jsonld.ts";

const registered=createDefaultRegistry();
function setup(type:"price-monitor"|"job-radar"){
 const root=mkdtempSync(join(tmpdir(),"knowledge-watch-"+type+"-"));
 const file=join(root,"snapshot.json"),db=join(root,"library.sqlite");
 copyFileSync(resolve("examples",type,"snapshot.json"),file);
 const project=loadProject(resolve("examples",type,"project.json"));
 project.sources[0].config.path=file;
 return {root,file,db,project};
}
test("price monitor detects real numeric decline, not unchanged refreshes",async()=>{
 const ctx=setup("price-monitor");
 try{
  const first=await runProject(ctx.db,ctx.project,registered,{pageSize:1});
  assert.equal(first.success,true,JSON.stringify(first.runs));
  assert.equal(first.newEntities,2);
  const db=new KnowledgeStore(ctx.db);
  assert.equal(db.listChanges(ctx.project.id).length,2);
  assert.deepEqual(db.listChanges(ctx.project.id).map(x=>x.kind),["created","created"]);
  assert.equal(db.listAlerts(ctx.project.id).length,2);
  assert.ok(db.listAlerts(ctx.project.id).every(x=>x.ruleId==="new-item"));
  db.close();

  const unchanged=await runProject(ctx.db,ctx.project,registered,{pageSize:1});
  assert.equal(unchanged.success,true,JSON.stringify(unchanged.runs));
  const same=new KnowledgeStore(ctx.db);
  assert.equal(same.listChanges(ctx.project.id).length,2);
  assert.equal(same.listAlerts(ctx.project.id).length,2);
  assert.equal(same.listVersions(ctx.project.id,"product:price-100").length,1);
  assert.equal(same.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions").get()?.n,2);
  same.close();

  copyFileSync(resolve("examples/price-monitor/snapshot-updated.json"),ctx.file);
  const changed=await runProject(ctx.db,ctx.project,registered,{pageSize:1});
  assert.equal(changed.success,true,JSON.stringify(changed.runs));
  assert.equal(changed.newEntities,0);
  const store=new KnowledgeStore(ctx.db);
  const price=store.getEntity(ctx.project.id,"product:price-100")!;
  assert.equal(price.attributes.price,99.99);
  assert.equal(price.attributes.currency,"USD");
  const changes=store.listChanges(ctx.project.id,{entityKey:"product:price-100"});
  assert.equal(changes.length,2);
  assert.equal(changes[0].path,"/attributes/price");
  assert.equal(changes[0].before,129.99);
  assert.equal(changes[0].after,99.99);
  assert.equal(store.listVersions(ctx.project.id,price.key).length,2);
  const alerts=store.listAlerts(ctx.project.id);
  const drop=alerts.find(x=>x.ruleId==="price-drop-10");
  assert.ok(drop);
  assert.equal(drop.path,"/attributes/price");
  assert.match(drop.explanation,/decreased 23\./);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) n FROM kb_observation_versions WHERE item_id='price-100'"
  ).get()?.n,2);
  store.close();

  // Changing currency invalidates a percentage comparison without suppressing
  // historical evidence of the new numeric price.
  const snapshotData=JSON.parse(readFileSync(ctx.file,"utf8")) as Array<{
    id:string;attributes:{price:number;currency:string}
  }>;
  snapshotData[0].attributes.currency="MXN";
  snapshotData[0].attributes.price=80;
  writeFileSync(ctx.file,JSON.stringify(snapshotData));
  await runProject(ctx.db,ctx.project,registered);
  const guard=new KnowledgeStore(ctx.db);
  assert.equal(guard.listChanges(ctx.project.id,{entityKey:price.key}).length,4);
  assert.equal(guard.listAlerts(ctx.project.id).filter(x=>x.ruleId==="price-drop-10").length,1,
    "Price drops in a different currency must not trigger a false comparable-price alert");
  guard.close();
 }finally{rmSync(ctx.root,{recursive:true,force:true});}
});
test("job radar tracks new opportunities, closures and location updates without assuming disappearance",async()=>{
 const ctx=setup("job-radar");
 try{
  await runProject(ctx.db,ctx.project,registered);
  const initial=new KnowledgeStore(ctx.db);
  assert.equal(initial.listAlerts(ctx.project.id).filter(a=>a.ruleId==="new-job").length,2);
  initial.close();
  copyFileSync(resolve("examples/job-radar/snapshot-updated.json"),ctx.file);
  const result=await runProject(ctx.db,ctx.project,registered);
  assert.equal(result.success,true);
  assert.equal(result.newEntities,1);
  const store=new KnowledgeStore(ctx.db);
  const events=store.listChanges(ctx.project.id);
  assert.equal(events.filter(x=>x.kind==="created").length,3);
  const alerts=store.listAlerts(ctx.project.id);
  assert.ok(alerts.some(x=>x.ruleId==="listing-closed"&&x.entityKey==="job-listing:job-100"));
  assert.ok(alerts.some(x=>x.ruleId==="location-changed"&&x.entityKey==="job-listing:job-101"));
  assert.ok(alerts.some(x=>x.ruleId==="new-job"&&x.entityKey==="job-listing:job-102"));
  const job=store.getEntity(ctx.project.id,"job-listing:job-100")!;
  assert.equal(job.attributes.status,"closed");
  const summary=store.entityEvidence(ctx.project.id,job.key)!;
  assert.equal(summary.entity.key,job.key);
  assert.equal(store.listVersions(ctx.project.id,job.key).length,2);
  store.close();

  // Missing from a later snapshot is not proof that a real job has closed.
  writeFileSync(ctx.file,JSON.stringify([{
    id:"job-102",type:"job-listing",title:"Data Engineer",
    url:"https://example.org/careers/102",
    attributes:{company:"Example Labs",location:"Remote",status:"open",currency:"USD"}
  }]));
  await runProject(ctx.db,ctx.project,registered);
  const after=new KnowledgeStore(ctx.db);
  assert.equal(after.listAlerts(ctx.project.id).length,alerts.length);
  assert.equal(after.getEntity(ctx.project.id,"job-listing:job-101")?.attributes.status,"open");
  after.close();
 }finally{rmSync(ctx.root,{recursive:true,force:true});}
});
test("watch guards and nested JSON diff do not emit spurious changes due to field order",()=>{
 const a=snapshot({type:"product",title:"Example",attributes:{
   price:100,currency:"USD",offers:{price:100,availability:"InStock"}
 }});
 const b=snapshot({type:"product",title:"Example",attributes:{
   offers:{availability:"InStock",price:100},currency:"USD",price:100
 }});
 assert.ok(sameJson(a as never,b as never));
 assert.equal(diffSnapshots(a,b).length,0);
 const c=snapshot({type:"product",title:"Example",attributes:{
   offers:{price:90,availability:"InStock"},currency:"USD",price:90
 }});
 const diff=diffSnapshots(a,c);
 assert.deepEqual(diff.map(x=>x.path),["/attributes/offers/price","/attributes/price"]);
 const rules=parseProject({
   id:"watch-validate",name:"Watch rules",sources:[{id:"fixture",adapter:"json-snapshot",config:{path:"/tmp/example.json"}}],
   watch:{rules:[{id:"drop",path:"/attributes/price",operator:"decrease-percent",
     threshold:10,requireUnchanged:["/attributes/currency"]}]}
 }).watch!.rules;
 assert.equal(matchingRules(diff[1],a,c,rules).length,1);
 assert.throws(()=>parseProject({
   id:"watch-invalid",name:"Invalid",sources:[{id:"fixture",adapter:"json-snapshot",config:{path:"/tmp/example.json"}}],
   watch:{rules:[{id:"invalid",path:"/attributes/price",operator:"decrease-percent",threshold:-20}]}
 }),/threshold/i);
});
test("public product JSON-LD returns real product claims only when price and currency are unambiguous",()=>{
 const page=(json:unknown)=>'<html><script type="application/ld+json">'+JSON.stringify(json)+
   '</script></html>';
 const normalized=parseProductPage(page({"@context":"https://schema.org","@type":"Product",
   name:"Example product",sku:"ITEM-42",
   offers:{"@type":"Offer",price:"129.90",priceCurrency:"USD",
     availability:"https://schema.org/InStock"}}),
   "https://example.org/products/42?utm_source=test");
 assert.equal(normalized.type,"product");
 assert.equal(normalized.attributes.price,129.9);
 assert.equal(normalized.attributes.currency,"USD");
 assert.equal(normalized.attributes.availability,"InStock");
 assert.equal(normalized.attributes.sku,"ITEM-42");
 assert.equal(normalized.url,"https://example.org/products/42");
 assert.throws(()=>parseProductPage(page({"@type":"Product",name:"Example",
   offers:[{"@type":"Offer",price:"10",priceCurrency:"USD"},
     {"@type":"Offer",price:"12",priceCurrency:"USD"}]}),
 "https://example.org/products/variant"),/unambiguous/);
 assert.throws(()=>parseProductPage(page({"@type":"Product",name:"Example",
   offers:{"@type":"Offer",price:"10"}}),"https://example.org/products/unknown"),
   /currency/);
 assert.throws(()=>parseProductPage("<html><h1>Price: $9</h1></html>",
   "https://example.org/products/plain"),/Schema.org Product/);
});
test("offline reprocessing does not manufacture new source snapshots or price changes",async()=>{
 const ctx=setup("price-monitor");
 try{
  await runProject(ctx.db,ctx.project,registered);
  const start=new KnowledgeStore(ctx.db);
  const n=start.listChanges(ctx.project.id).length;
  start.close();
  ctx.project.policy.includeKeywords=["new topic"];
  await reprocessProject(ctx.db,ctx.project,registered);
  const end=new KnowledgeStore(ctx.db);
  assert.equal(end.listChanges(ctx.project.id).length,n);
  assert.equal(end.listAlerts(ctx.project.id).length,2);
  end.close();
 }finally{rmSync(ctx.root,{recursive:true,force:true});}
});
