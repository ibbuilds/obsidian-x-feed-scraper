/** Synthetic domain-agnostic relevance workload; no source/network/Obsidian. */
import {performance} from "node:perf_hooks";
import {builtinProcessing} from "../packages/processors/builtin.ts";
import {parseProject} from "../packages/core/project-config.ts";

const count=Number(process.argv[2]||65000);
if(!Number.isSafeInteger(count)||count<100||count>250000)throw Error("Invalid evaluator benchmark size");
const include=["motion","react",...Array.from({length:28},(_,i)=>"match-"+i)];
const exclude=Array.from({length:30},(_,i)=>"exclude-"+i);
const project=parseProject({
  id:"keyword-profile",name:"Keyword profiling",
  sources:[{id:"fixture",adapter:"json-file",config:{path:"/unused/fixture"}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:include,excludeKeywords:exclude,minimumScore:0},
  outputs:[]
});
const keyword=builtinProcessing.evaluators.find(item=>item.id==="keyword");
if(!keyword)throw Error("Missing keyword evaluator");
const signal=new AbortController().signal;
const context={project,source:project.sources[0],signal};
const observation={id:"known-1",type:"research-record",title:"Motion and react patterns",
  text:"A useful library with evidence and motion examples",
  attributes:{category:"design",topics:["frontend","animation"]}};
const entity={key:"record:known-1",type:"web-resource",title:"React UI motion components",
  url:"https://example.org/resource",attributes:{description:"Detailed documentation ".repeat(5)},
  evidence:[{signal:"observed-url",detail:"Resource listed by authorized source"}]};
const expected=keyword.assess(context,observation,entity);
if(!expected||expected.category!=="motion"||expected.score!==50)throw Error("Unexpected baseline assessment: "+JSON.stringify(expected));
const start=performance.now();
for(let i=0;i<count;i++){
  const actual=keyword.assess(context,observation,entity);
  if(actual.category!==expected.category||actual.score!==expected.score||
    actual.confidence!==expected.confidence||actual.reasons.join("|")!==expected.reasons.join("|")){
    throw Error("Assessment drift at iteration "+i);
  }
}
const ms=Math.round((performance.now()-start)*100)/100;
// In-place changes to a mutable policy on the same signal must be observed.
project.policy.includeKeywords[0]="never-seen-motion";
const changed=keyword.assess(context,observation,entity);
if(changed.score>=expected.score||changed.reasons.join("|")===expected.reasons.join("|")){
  throw Error("Evaluator did not notice policy mutation");
}
process.stdout.write(JSON.stringify({count,ms,score:expected.score,changedScore:changed.score})+"\n");
