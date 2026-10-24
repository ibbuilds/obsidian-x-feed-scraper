import {performance} from "node:perf_hooks";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";

const count=Number(process.argv[2]||1200),reviews=Number(process.argv[3]||12000);
if(!Number.isSafeInteger(count)||count<1||count>10000||!Number.isSafeInteger(reviews)||reviews<0||reviews>100000)throw Error("Invalid benchmark bounds");
const root=mkdtempSync(join(tmpdir(),"source-scraper-bench-"));
const db=join(root,"perf.sqlite"),file=join(root,"observations.json");
const out={count,reviews,phases:{},plan:[],node:process.version};
const time=(key,fn)=>{const start=performance.now();const value=fn();out.phases[key]=Math.round((performance.now()-start)*100)/100;return value;};
const timeAsync=async(key,fn)=>{const start=performance.now();const value=await fn();out.phases[key]=Math.round((performance.now()-start)*100)/100;return value;};
try{
 const data=Array.from({length:count},(_,i)=>({id:"id-"+String(i).padStart(6,"0"),type:"catalog-item",title:"Curated record "+i,text:"Structured knowledge record",attributes:{priority:i%5,description:"synthetic ".repeat(6)}}));
 writeFileSync(file,JSON.stringify(data));
 const project=parseProject({id:"profiling-catalog",name:"Offline profiling",sources:[{id:"fixture",adapter:"json-snapshot",config:{path:file,entityNamespace:"fixture"}}],pipeline:["observation-entity"],evaluator:"keyword",policy:{includeKeywords:["record"],excludeKeywords:[],minimumScore:0},outputs:[]});
 const collected=await timeAsync("collectMs",()=>runProject(db,project,createDefaultRegistry(),{pageSize:250}));
 if(!collected.success||collected.observations!==count)throw Error("Incomplete collection");
 const store=time("openMs",()=>new KnowledgeStore(db));
 try{
  time("seedReviewsMs",()=>{store.db.exec("BEGIN IMMEDIATE");try{
   const insert=store.db.prepare("INSERT INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at) VALUES(?,?,?,?,?)");
   for(let i=0;i<reviews;i++)insert.run(project.id,"@fixture:catalog-item:id-"+String(i%count).padStart(6,"0"),"approved","Synthetic review","2026-01-01T00:00:00.000Z");
   store.db.exec("COMMIT");
  }catch(e){store.db.exec("ROLLBACK");throw e;}});
  time("listEntitiesMs",()=>{let size=0;for(let o=0;o<count;o+=500)size+=store.listEntities(project.id,{limit:500,offset:o}).length;if(size!==count)throw Error("Lost entities");});
  time("getEvidenceMs",()=>{for(let i=0;i<Math.min(300,count);i++){const key="@fixture:catalog-item:id-"+String(i).padStart(6,"0");if(!store.entityEvidence(project.id,key))throw Error("Missing evidence");}});
  out.plan=store.db.prepare("EXPLAIN QUERY PLAN SELECT decision FROM kb_reviews WHERE project_id=? AND entity_key=? ORDER BY id DESC LIMIT 1").all(project.id,"@fixture:catalog-item:id-000000").map(row=>String(row.detail));
 }finally{store.close();}
 time("reopenMs",()=>{const s=new KnowledgeStore(db);try{if(!s.listEntities(project.id,{limit:10}).length)throw Error("Reopen lost records");}finally{s.close();}});
 out.rssMiB=Math.round(process.memoryUsage().rss/1048576*10)/10;
 process.stdout.write(JSON.stringify(out)+"\n");
}finally{rmSync(root,{recursive:true,force:true});}
