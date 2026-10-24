import {test} from "node:test";
import assert from "node:assert/strict";
import {builtinProcessing} from "../packages/processors/builtin.ts";
import {parseProject} from "../packages/core/project-config.ts";

const evaluator=builtinProcessing.evaluators!.find(x=>x.id==="keyword")!;
const observation={id:"sample",type:"source-item",title:"React motion resource",
  text:"Practical frontend motion and animation example"};
const entity={key:"resource:example",type:"web-resource",title:"React animation",
  url:"https://example.org/react-animation",
  attributes:{description:"Long practical reference for frontend developers ".repeat(3)},
  evidence:[{signal:"observed-url",detail:"Observed in authorized feed"}]};
function project(){
  return parseProject({id:"mutable-policy",name:"Mutable keyword policy test",
    sources:[{id:"source",adapter:"json-file",config:{path:"/unused"}}],
    pipeline:["observation-entity"],evaluator:"keyword",
    policy:{includeKeywords:["react","motion"],excludeKeywords:[],minimumScore:0},outputs:[]});
}
test("keyword cache is run-scoped and invalidates in-place policy edits immediately",async()=>{
  const p=project(),signal=new AbortController().signal;
  const context={project:p,source:p.sources[0],signal};
  const first=await evaluator.assess(context,observation,entity);
  assert.equal(first.category,"react");
  assert.ok(first.score>50);
  const repeated=await evaluator.assess(context,observation,entity);
  assert.deepEqual(repeated,first);
  p.policy.includeKeywords.splice(0,2,"unrelated-term");
  const changed=await evaluator.assess(context,observation,entity);
  assert.equal(changed.category,entity.type);
  assert.equal(changed.score,15,"Description boost is still present");
  assert.notDeepEqual(changed,first);
  p.policy.includeKeywords.push("motion");
  const restored=await evaluator.assess(context,observation,entity);
  assert.equal(restored.category,"motion");
  assert.equal(restored.score,40);
  p.policy.excludeKeywords.push("MoTiOn");
  const excluded=await evaluator.assess(context,observation,entity);
  assert.deepEqual(excluded,{category:"excluded",score:0,confidence:0.9,
    reasons:["Explicit exclusion term matched"]});
  p.policy.excludeKeywords.pop();
  const nextSignal=new AbortController().signal;
  assert.deepEqual(await evaluator.assess({...context,signal:nextSignal},observation,entity),restored);
  const secondProject=project();
  assert.deepEqual(await evaluator.assess({project:secondProject,source:secondProject.sources[0],
    signal},observation,entity),first,"Different project must not reuse mutable terms");
});
test("cached terms preserve validation when a policy becomes malformed",async()=>{
  const p=project(),ctx={project:p,source:p.sources[0],signal:new AbortController().signal};
  await evaluator.assess(ctx,observation,entity);
  p.policy.includeKeywords=["react",""];
  await assert.rejects(Promise.resolve().then(()=>evaluator.assess(ctx,observation,entity)),
    /terms must not be empty/);
  p.policy.includeKeywords=[" REACT ","react","motion"];
  const value=await evaluator.assess(ctx,observation,entity);
  assert.equal(value.category,"REACT");
  assert.equal(value.score,65,"Duplicate terms should count once; description boost stays");
  p.policy.excludeKeywords=["unsupported"," MoTiOn "];
  const excluded=await evaluator.assess(ctx,observation,entity);
  assert.equal(excluded.category,"excluded");
});
