import type {JsonRecord,JsonValue,ChangeRule} from "../sdk/contracts.ts";

export type ChangeKind="created"|"added"|"removed"|"updated";
export interface EntitySnapshot {
  type:string;
  title:string;
  url:string|null;
  attributes:JsonRecord;
}
export interface FieldChange {
  path:string;
  kind:ChangeKind;
  before:JsonValue|undefined;
  after:JsonValue|undefined;
}
export interface ChangeEvent extends FieldChange {
  id:number;
  projectId:string;
  entityKey:string;
  connectionId:string;
  observationId:string;
  observedAt:string;
}
export interface WatchAlert {
  id:number;
  projectId:string;
  entityKey:string;
  changeId:number;
  ruleId:string;
  explanation:string;
  detectedAt:string;
  path:string;
  before:JsonValue|undefined;
  after:JsonValue|undefined;
}

function plainObject(value:unknown):value is Record<string,JsonValue>{
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
}
function escapePointer(value:string):string {
  return value.replace(/~/g,"~0").replace(/\//g,"~1");
}
function sortedJson(value:JsonValue|undefined):string {
  if(value===undefined)return "undefined";
  if(Array.isArray(value))return "["+value.map(sortedJson).join(",")+"]";
  if(plainObject(value)){
    return "{"+Object.keys(value).sort().map(key=>
      JSON.stringify(key)+":"+sortedJson(value[key])
    ).join(",")+"}";
  }
  return JSON.stringify(value);
}
export function sameJson(a:JsonValue|undefined,b:JsonValue|undefined):boolean{
  return sortedJson(a)===sortedJson(b);
}
export function readPointer(value:EntitySnapshot,path:string):JsonValue|undefined{
  if(path==="$")return value as unknown as JsonValue;
  if(!path.startsWith("/"))return undefined;
  let current:unknown=value;
  for(const token of path.slice(1).split("/")){
    const key=token.replace(/~1/g,"/").replace(/~0/g,"~");
    if(!current||typeof current!=="object"||!Object.prototype.hasOwnProperty.call(current,key)){
      return undefined;
    }
    current=(current as Record<string,unknown>)[key];
  }
  return current as JsonValue|undefined;
}
export function snapshot(value:{type:string;title:string;url?:string;attributes?:JsonRecord}):EntitySnapshot{
  return {type:value.type,title:value.title,url:value.url||null,attributes:value.attributes||{}};
}
/** Canonical deep comparison; array changes are atomic, never position-based guesses. */
export function diffSnapshots(before:EntitySnapshot|undefined,after:EntitySnapshot):FieldChange[]{
  if(!before)return [{path:"$",kind:"created",before:undefined,after:after as unknown as JsonValue}];
  const result:FieldChange[]=[];
  const walk=(prior:JsonValue|undefined,next:JsonValue|undefined,path:string,depth:number):void=>{
    if(sameJson(prior,next))return;
    if(result.length>=100)throw new Error("Entity diff exceeds 100 changed fields");
    if(depth<8&&plainObject(prior)&&plainObject(next)){
      const keys=new Set([...Object.keys(prior),...Object.keys(next)]);
      for(const key of [...keys].sort()){
        walk(prior[key],next[key],path+"/"+escapePointer(key),depth+1);
      }
      return;
    }
    result.push({path,kind:prior===undefined?"added":next===undefined?"removed":"updated",
      before:prior,after:next});
  };
  walk(before as unknown as JsonValue,after as unknown as JsonValue,"",0);
  return result;
}
export function assertWatchRule(raw:unknown):ChangeRule{
  if(!plainObject(raw))throw new Error("Invalid watch rule object");
  const id=raw.id,path=raw.path,operator=raw.operator;
  if(typeof id!=="string"||!/^[a-z][a-z0-9_-]{1,63}$/.test(id)){
    throw new Error("Invalid watch rule id");
  }
  if(typeof path!=="string"||path.length>300||
    (path!=="$"&&!/^\/(?:[^\u0000-\u001f]+)$/.test(path))||
    path.split("/").some(part=>["__proto__","prototype","constructor"].includes(part))){
    throw new Error("Invalid watch JSON pointer");
  }
  if(!["created","changed","equals","decrease-percent","increase-percent"].includes(String(operator))){
    throw new Error("Invalid watch comparison");
  }
  const check=operator as ChangeRule["operator"];
  if(check==="created"&&path!=="$")throw new Error("Created-event rules must use path $");
  if(check!=="created"&&path==="$")throw new Error("A field watch rule needs a JSON pointer");
  let threshold:number|undefined;
  if(check==="decrease-percent"||check==="increase-percent"){
    if(typeof raw.threshold!=="number"||!Number.isFinite(raw.threshold)||
      raw.threshold<=0||raw.threshold>100)throw new Error("Percent rule threshold must be 0–100");
    threshold=raw.threshold;
  }
  if(check==="equals"&&raw.value===undefined)throw new Error("Equals watch needs a value");
  if(raw.requireUnchanged!==undefined&&
    (!Array.isArray(raw.requireUnchanged)||raw.requireUnchanged.length>10||
      raw.requireUnchanged.some(x=>typeof x!=="string"||!x.startsWith("/")))){
    throw new Error("Invalid watch guard pointers");
  }
  return {
    id,path,operator:check,
    ...(threshold!==undefined?{threshold}:{}),
    ...(raw.value!==undefined?{value:raw.value}:{}),
    ...(raw.requireUnchanged!==undefined?{requireUnchanged:raw.requireUnchanged as string[]}:{})
  };
}
export function matchingRules(
  change:FieldChange,before:EntitySnapshot|undefined,after:EntitySnapshot,
  rules:readonly ChangeRule[]
):Array<{rule:ChangeRule;explanation:string}>{
  const matches:Array<{rule:ChangeRule;explanation:string}>=[];
  for(const rule of rules){
    if(change.path!==rule.path)continue;
    if(rule.requireUnchanged?.some(path=>!before||
      !sameJson(readPointer(before,path),readPointer(after,path))))continue;
    if(rule.operator==="created"){
      if(change.kind==="created")matches.push({rule,explanation:"New entity discovered"});
    }else if(rule.operator==="changed"){
      if(change.kind!=="created")matches.push({rule,explanation:"Tracked field changed"});
    }else if(rule.operator==="equals"){
      if(change.kind!=="removed"&&sameJson(change.after,rule.value)){
        matches.push({rule,explanation:"Tracked field reached the configured value"});
      }
    }else if(typeof change.before==="number"&&typeof change.after==="number"&&
      Number.isFinite(change.before)&&Number.isFinite(change.after)&&change.before>0){
      const percent=(change.after-change.before)/change.before*100;
      if(rule.operator==="decrease-percent"&&percent<=-(rule.threshold||0)){
        matches.push({rule,explanation:"Tracked value decreased "+Math.abs(percent).toFixed(2)+"%"});
      }else if(rule.operator==="increase-percent"&&percent>=(rule.threshold||0)){
        matches.push({rule,explanation:"Tracked value increased "+percent.toFixed(2)+"%"});
      }
    }
  }
  return matches;
}
