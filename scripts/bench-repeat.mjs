/**
 * Deterministic offline replay benchmark. Runs a full snapshot, an identical
 * snapshot, then one changed record; validates SQLite identity and history.
 */
import {performance} from "node:perf_hooks";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";

const count=Number(process.argv[2]||1800);
if(!Number.isSafeInteger(count)||count<100||count>10000)throw Error("Invalid replay size");
const root=mkdtempSync(join(tmpdir(),"source-scraper-replay-profile-"));
const file=join(root,"records.json"),db=join(root,"library.sqlite");
const data=Array.from({length:count},(_,i)=>({
  id:"observation-"+String(i).padStart(6,"0"),type:"catalog-record",
  title:"Record "+i,text:"Source item number "+i,
  attributes:{version:1,group:i%9,description:"evidence"}
}));
const project=parseProject({id:"profiling-replay",name:"Offline snapshot replay benchmark",
  sources:[{id:"local",adapter:"json-snapshot",config:{path:file,entityNamespace:"catalog"}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:["Record"],excludeKeywords:[],minimumScore:0},
  watch:{rules:[{id:"changed-version",path:"/attributes/version",operator:"changed"}]},
  outputs:[]});
const registry=createDefaultRegistry(),result={records:count,phases:{},dbCounts:[],node:process.version};
const time=async(label)=>{const start=performance.now();const r=await runProject(db,project,registry,{pageSize:250});result.phases[label]=Math.round((performance.now()-start)*100)/100;if(!r.success||r.observations!==count)throw Error(label+": failed "+JSON.stringify(r));return r;};
const counts=()=>{
 const s=new KnowledgeStore(db);
 try {
   return {
     observations:Number(s.db.prepare("SELECT COUNT(*) n FROM kb_observations").get().n),
     entities:Number(s.db.prepare("SELECT COUNT(*) n FROM kb_entities").get().n),
     revisions:Number(s.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions").get().n),
     versions:Number(s.db.prepare("SELECT COUNT(*) n FROM kb_entity_versions").get().n),
     changes:Number(s.db.prepare("SELECT COUNT(*) n FROM kb_entity_changes").get().n),
     alerts:Number(s.db.prepare("SELECT COUNT(*) n FROM kb_watch_alerts").get().n)
   };
 }finally{s.close();}
};
try{
 writeFileSync(file,JSON.stringify(data));
 await time("initialMs");result.dbCounts.push(counts());
 const second=await time("unchangedMs");result.dbCounts.push(counts());
 if(second.newEntities!==0)throw Error("Replay generated new entities");
 if(JSON.stringify(result.dbCounts[0])!==JSON.stringify(result.dbCounts[1]))throw Error("Unchanged replay changed history");
 data[0].attributes.version=2;
 writeFileSync(file,JSON.stringify(data));
 await time("changedMs");result.dbCounts.push(counts());
 if(result.dbCounts[2].observations!==count||
  result.dbCounts[2].revisions!==result.dbCounts[1].revisions+1||
  result.dbCounts[2].changes!==result.dbCounts[1].changes+1||
  result.dbCounts[2].alerts!==result.dbCounts[1].alerts+1){
  throw Error("Changed snapshot did not retain exactly one observation/alert revision: "+JSON.stringify(result.dbCounts));
 }
 process.stdout.write(JSON.stringify(result)+"\n");
}finally{rmSync(root,{recursive:true,force:true});}
