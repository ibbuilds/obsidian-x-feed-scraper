import {test} from "node:test";
import assert from "node:assert/strict";
import {sameJson,diffSnapshots,matchingRules,readPointer} from "../packages/core/change-tracking.ts";
import type {JsonValue} from "../packages/sdk/contracts.ts";

/** Pre-optimization reference, kept only in tests to detect semantic changes. */
function canonical(v:JsonValue|undefined):string{
  if(v===undefined)return "undefined";
  if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";
  if(v!==null&&typeof v==="object")return "{"+Object.keys(v).sort()
    .map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";
  return JSON.stringify(v);
}
function reference(a:JsonValue|undefined,b:JsonValue|undefined):boolean{
  return canonical(a)===canonical(b);
}
let seed=0x8badf00d;
function next():number{
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  return seed/0x100000000;
}
function item(depth=0):JsonValue{
  if(depth>=4){
    const i=Math.floor(next()*5);
    return [null,false,true,Math.round((next()-0.5)*2000)/100,"str \\u2028 \\u0022"][i];
  }
  const kind=Math.floor(next()*7);
  if(kind<=3)return item(4);
  if(kind===4)return Array.from({length:Math.floor(next()*6)},()=>item(depth+1));
  const entries:Array<[string,JsonValue]>=[];
  for(let i=0,n=Math.floor(next()*6);i<n;i++){
    entries.push(["field~"+i+"/"+Math.floor(next()*4),item(depth+1)]);
  }
  const output:Record<string,JsonValue>=Object.create(null) as Record<string,JsonValue>;
  for(const [key,value] of entries)output[key]=value;
  return output;
}
test("linear JSON equality matches canonical serialization for 1000 deterministic values",()=>{
  for(let i=0;i<1000;i++){
    const left=item();
    const right=i%3===0?structuredClone(left):item();
    assert.equal(sameJson(left,right),reference(left,right),"Semantic mismatch for "+i);
    assert.equal(sameJson(right,left),reference(right,left),"Asymmetric comparison for "+i);
  }
});
test("object order, missing values, arrays and JSON pointer escaping retain semantics",()=>{
  const a={outer:{z:0,a:-0,k:[{x:1,y:null},"one",true]},flag:false};
  const b={flag:false,outer:{k:[{y:null,x:1},"one",true],a:0,z:-0}};
  assert.equal(sameJson(a,b),true);
  assert.equal(sameJson(a,structuredClone(b)),true);
  assert.equal(sameJson([1,2],[2,1]),false);
  assert.equal(sameJson({x:null},{}),false);
  assert.equal(sameJson(undefined,null),false);
  assert.equal(sameJson("null",null),false);
  assert.equal(sameJson({x:1},{x:1,y:undefined} as unknown as JsonValue),false);
  const before={type:"item",title:"Same",url:null,attributes:{"a/b~c":{count:1,list:[1,2]}}};
  const after={type:"item",title:"Same",url:null,attributes:{"a/b~c":{list:[1,3],count:1}}};
  const changes=diffSnapshots(before,after);
  assert.deepEqual(changes.map(x=>({path:x.path,kind:x.kind})),[
    {path:"/attributes/a~1b~0c/list",kind:"updated"}
  ]);
  assert.deepEqual(readPointer(after,"/attributes/a~1b~0c/list"),[1,3]);
  const guards=matchingRules(changes[0],before,after,[{
    id:"updated-array",path:"/attributes/a~1b~0c/list",operator:"changed",
    requireUnchanged:["/type","/title"]
  }]);
  assert.equal(guards.length,1);
});
test("normalizations never auto-approve unrelated changed fields",()=>{
  const a={type:"price",title:"Offer",url:null,attributes:{price:100,currency:"USD"}};
  const b={type:"price",title:"Offer",url:null,attributes:{currency:"EUR",price:90}};
  const changes=diffSnapshots(a,b);
  assert.deepEqual(changes.map(x=>x.path),["/attributes/currency","/attributes/price"]);
  const matches=changes.flatMap(change=>matchingRules(change,a,b,[{
    id:"price-drop",path:"/attributes/price",operator:"decrease-percent",threshold:5,
    requireUnchanged:["/attributes/currency"]
  }]));
  assert.equal(matches.length,0,"Currency change must still block price-drop alert");
});
