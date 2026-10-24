/** Offline reassessment profile on unchanged observations with changed scoring policy. */
import {performance} from "node:perf_hooks";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runProject,reprocessProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";

const count=Number(process.argv[2]||2400);
if(!Number.isSafeInteger(count)||count<100||count>10000)throw Error("Invalid record count");
const root=mkdtempSync(join(tmpdir(),"source-scraper-reprocess-profile-"));
const file=join(root,"observations.json"),db=join(root,"reprocess.sqlite");
const data=Array.from({length:count},(_,i)=>({id:"row-"+String(i).padStart(6,"0"),
  type:"research-record",title:"Research subject "+i,text:"Topic-specific material",
  attributes:{number:i}}));
const project=parseProject({id:"offline-profile",name:"Offline reprocessing profile",
  sources:[{id:"fixture",adapter:"json-snapshot",config:{path:file,entityNamespace:"fixture"}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:["topic"],excludeKeywords:[],minimumScore:0},outputs:[]});
const registry=createDefaultRegistry(),phases={};
const timed=async(name,action)=>{
  const begin=performance.now();
  const outcome=await action();
  phases[name]=Math.round((performance.now()-begin)*100)/100;
  return outcome;
};
try{
  writeFileSync(file,JSON.stringify(data));
  const created=await runProject(db,project,registry,{pageSize:250});
  if(!created.success||created.observations!==count)throw Error("Initial ingestion failed");
  const ownerKey="@fixture:research-record:row-000000";
  const before=new KnowledgeStore(db);
  before.reviewEntity(project.id,ownerKey,"approved","Synthetic human decision");
  before.close();
  project.policy.includeKeywords=["not-present-in-source"];
  const first=await timed("reprocessMs",()=>reprocessProject(db,project,registry));
  if(first.reassessed!==count)throw Error("First offline replay incomplete");
  const again=await timed("repeatMs",()=>reprocessProject(db,project,registry));
  if(again.reassessed!==count)throw Error("Repeated offline replay incomplete");
  const s=new KnowledgeStore(db);
  let history:number,review:string|undefined,scoreCount:number,original:number;
  try{
    history=Number(s.db.prepare("SELECT COUNT(*) n FROM kb_assessment_history").get().n);
    scoreCount=Number(s.db.prepare("SELECT COUNT(*) n FROM kb_assessments WHERE project_id=? AND score=0")
      .get(project.id).n);
    original=Number(s.db.prepare("SELECT COUNT(*) n FROM kb_observation_versions").get().n);
    review=s.getEntity(project.id,ownerKey)?.review;
  }finally{s.close();}
  if(history!==count*2||scoreCount!==count||original!==count||review!=="approved"){
    throw Error("Offline replay damaged stable history/approvals "+JSON.stringify({history,scoreCount,original,review}));
  }
  process.stdout.write(JSON.stringify({count,phases,history,scoreCount,original,review})+"\n");
}finally{rmSync(root,{recursive:true,force:true});}
