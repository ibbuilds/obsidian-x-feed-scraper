/**
 * Offline, deterministic comparison of JSON-semantic equality.
 * Run on the old and optimized revisions on the same runner.
 */
import {performance} from "node:perf_hooks";
import {sameJson,diffSnapshots} from "../packages/core/change-tracking.ts";

const iterations=Number(process.argv[2]||16000);
if(!Number.isSafeInteger(iterations)||iterations<100||iterations>100000){
  throw new Error("Invalid benchmark iteration count");
}
const attributes={};
for(let i=0;i<48;i++){
  attributes["field-"+String(i).padStart(3,"0")]={
    label:"Nested collection item "+i,
    details:{active:i%2===0,weight:i*1.125,tags:["frontend","ui","design",String(i)]},
    matrix:[{x:i,y:i+1,z:i+2},{x:i+3,y:i+4,z:i+5}]
  };
}
const left={type:"resource",title:"A sample",url:null,attributes};
const reversed={};
for(const key of Object.keys(attributes).reverse()){
  const item=attributes[key];
  reversed[key]={matrix:item.matrix.map(entry=>({z:entry.z,y:entry.y,x:entry.x})),
    details:{tags:[...item.details.tags],weight:item.details.weight,active:item.details.active},
    label:item.label};
}
const right={attributes:reversed,url:null,title:"A sample",type:"resource"};
const modified=structuredClone(right);
modified.attributes["field-047"].details.tags[3]="different";
if(!sameJson(left,right)||sameJson(left,modified))throw new Error("JSON equality correctness regression");
const sample=diffSnapshots(left,right);
if(sample.length!==0)throw new Error("Identical snapshots must not create events");
const changes=diffSnapshots(left,modified);
if(changes.length!==1||changes[0].path!=="/attributes/field-047/details/tags"){
  throw new Error("Nested change paths or atomic arrays changed: "+JSON.stringify(changes));
}
const loops={equal:0,different:0,diff:0};
const measure=(label,fn)=>{
  const start=performance.now();
  for(let i=0;i<iterations;i++)fn();
  loops[label]=Math.round((performance.now()-start)*100)/100;
};
measure("equal",()=>{if(!sameJson(left,right))throw new Error("Equal became different");});
measure("different",()=>{if(sameJson(left,modified))throw new Error("Different became equal");});
measure("diff",()=>{
  const result=diffSnapshots(left,modified);
  if(result.length!==1)throw new Error("Invalid diff");
});
process.stdout.write(JSON.stringify({iterations,phases:loops,changePath:changes[0].path})+"\n");
