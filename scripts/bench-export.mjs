/** Offline benchmark for complete entity JSON exports with provenance and reviews. */
import {performance} from "node:perf_hooks";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";

const count=Number(process.argv[2]||1400),reviewsEach=Number(process.argv[3]||12);
if(!Number.isSafeInteger(count)||count<100||count>5000||
  !Number.isSafeInteger(reviewsEach)||reviewsEach<0||reviewsEach>50)throw Error("Invalid benchmark bounds");
const root=mkdtempSync(join(tmpdir(),"source-scraper-export-bench-"));
const input=join(root,"observations.json"),config=join(root,"project.json"),db=join(root,"library.sqlite");
const binary=resolve("dist/source-scraper.mjs");
const observations=Array.from({length:count},(_,i)=>({
  id:"id-"+String(i).padStart(6,"0"),type:"record",
  title:"Export record "+i,attributes:{ordinal:i}
}));
const project=parseProject({id:"export-profile",name:"Synthetic JSON export profiling",
  sources:[{id:"source",adapter:"json-snapshot",config:{path:input,entityNamespace:"source"}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]});
const times={};
function exportFile(name,compact){
  const filename=join(root,name+".json");
  const args=[binary,"export","--config",config,"--out",filename,"--limit","100000"];
  if(compact)args.push("--compact","true");
  const start=performance.now();
  const result=spawnSync(process.execPath,args,{encoding:"utf8",timeout:60000,maxBuffer:300000});
  times[name+"Ms"]=Math.round((performance.now()-start)*100)/100;
  if(result.error)throw result.error;
  if(result.status!==0)throw Error("Export failed: "+result.stderr.slice(0,1000));
  const receipt=JSON.parse(result.stdout);
  const exported=JSON.parse(readFileSync(filename,"utf8"));
  if(exported.count!==count||receipt.count!==count||exported.records.length!==count)throw Error("Incomplete export");
  if(!compact && (exported.records[0]?.provenance?.reviews?.length!==Math.min(30,reviewsEach)||
    exported.records[count-1]?.provenance?.assessmentHistory?.length<1))throw Error("Lost evidence in full export");
  return {bytes:Buffer.byteLength(readFileSync(filename,"utf8")),
    reviewCount:exported.records[0]?.provenance?.reviews?.length??0};
}
try{
  writeFileSync(input,JSON.stringify(observations));
  writeFileSync(config,JSON.stringify({...project,sources:[{
    id:"source",adapter:"json-snapshot",config:{path:input,entityNamespace:"source"}
  }]}));
  const ingested=await runProject(db,project,createDefaultRegistry(),{pageSize:250});
  if(!ingested.success||ingested.observations!==count)throw Error("Ingest failed");
  const store=new KnowledgeStore(db);
  try{
    store.db.exec("BEGIN IMMEDIATE");
    try{
      const add=store.db.prepare("INSERT INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at) VALUES(?,?,?,?,?)");
      for(let i=0;i<count;i++)for(let j=0;j<reviewsEach;j++){
        add.run(project.id,"@source:record:id-"+String(i).padStart(6,"0"),
          j%2?"approved":"pending","Synthetic review","2026-01-01T00:00:00.000Z");
      }
      store.db.exec("COMMIT");
    }catch(e){store.db.exec("ROLLBACK");throw e;}
  }finally{store.close();}
  const full=exportFile("full",false),compact=exportFile("compact",true);
  process.stdout.write(JSON.stringify({records:count,reviewsEach,times,full,compact})+"\n");
}finally{rmSync(root,{recursive:true,force:true});}
