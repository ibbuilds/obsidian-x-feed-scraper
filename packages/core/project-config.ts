import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import type {JsonRecord,JsonValue,ProjectDefinition,Observation,EntityDraft,Assessment} from "../sdk/contracts.ts";
import {normalizeUrl} from "./url.ts";
import {assertWatchRule} from "./change-tracking.ts";

const ID=/^[a-z][a-z0-9_-]{1,63}$/;
function object(v:unknown):Record<string,unknown>{
  if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("Expected JSON object");
  return v as Record<string,unknown>;
}
function string(v:unknown,name:string,max=500):string {
  if(typeof v!=="string"||!v.trim()||v.length>max)throw new Error("Invalid "+name);
  return v;
}
function id(v:unknown,name:string):string{
  const value=string(v,name,64);
  if(!ID.test(value))throw new Error("Invalid "+name+": use lowercase identifiers");
  return value;
}
function keys(v:unknown,name:string,max=60):string[]{
  if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=="string"||x.length>100)){
    throw new Error("Invalid "+name);
  }
  return v as string[];
}
function jsonValue(value:unknown,depth=0):JsonValue{
  if(depth>9)throw new Error("JSON attributes too deeply nested");
  if(value===null||typeof value==="string"||typeof value==="boolean")return value;
  if(typeof value==="number"&&Number.isFinite(value))return value;
  if(Array.isArray(value)){
    if(value.length>500)throw new Error("JSON array exceeds limit");
    return value.map(item=>jsonValue(item,depth+1));
  }
  if(value&&typeof value==="object"){
    const entries=Object.entries(value);
    if(entries.length>150)throw new Error("Too many JSON attributes");
    const safe:JsonRecord=Object.create(null) as JsonRecord;
    for(const [key,item] of entries){
      if(key.length>120||["__proto__","prototype","constructor"].includes(key)){
        throw new Error("Unsafe attribute name");
      }
      safe[key]=jsonValue(item,depth+1);
    }
    return safe;
  }
  throw new Error("Non-JSON data is not supported");
}
export function jsonRecord(value:unknown):JsonRecord{
  const record=object(value);
  const raw=JSON.stringify(record);
  if(!raw||raw.length>64000)throw new Error("JSON record too large");
  return jsonValue(record) as JsonRecord;
}
function optionalText(v:unknown,name:string,max=20000):string|undefined{
  if(v===undefined)return undefined;
  if(typeof v!=="string"||v.length>max)throw new Error("Invalid "+name);
  return v;
}
export function validateObservation(raw:unknown):Observation{
  const v=object(raw);
  const links=(field:"urls"|"media"):string[]|undefined=>{
    if(v[field]===undefined)return undefined;
    if(!Array.isArray(v[field])||(v[field] as unknown[]).length>100)throw new Error("Invalid "+field);
    return (v[field] as unknown[]).map(link=>normalizeUrl(string(link,field,3000)));
  };
  const url=optionalText(v.url,"observation URL",3000);
  const occurredAt=optionalText(v.occurredAt,"occurredAt",100);
  if(occurredAt&&(!Number.isFinite(Date.parse(occurredAt))))throw new Error("Invalid date");
  return {
    id:string(v.id,"observation id",300),
    type:id(v.type,"observation type"),
    title:optionalText(v.title,"title",2000),
    text:optionalText(v.text,"text",20000),
    url:url?normalizeUrl(url):undefined,
    urls:links("urls"),media:links("media"),
    occurredAt,
    attributes:v.attributes===undefined?{}:jsonRecord(v.attributes)
  };
}
export function validateEntity(raw:unknown,schema?:ProjectDefinition["entitySchemas"]):EntityDraft{
  const v=object(raw);
  const type=id(v.type,"entity type");
  const url=optionalText(v.url,"entity URL",3000);
  const attributes=v.attributes===undefined?{}:jsonRecord(v.attributes);
  const definition=schema?.[type];
  if(definition){
    for(const [field,expected] of Object.entries(definition.fields)){
      const value=attributes[field];
      if(value!==undefined&&typeof value!==expected)throw new Error("Invalid attribute "+type+"."+field);
    }
    for(const required of definition.required||[]){
      if(attributes[required]===undefined||attributes[required]===null)throw new Error("Missing attribute "+type+"."+required);
    }
  }
  const evidence:EntityDraft["evidence"]=[];
  if(v.evidence!==undefined){
    if(!Array.isArray(v.evidence)||v.evidence.length>40)throw new Error("Invalid evidence");
    for(const input of v.evidence){
      const e=object(input);
      const confidence=e.confidence===undefined?undefined:Number(e.confidence);
      if(confidence!==undefined&&(!Number.isFinite(confidence)||confidence<0||confidence>1)){
        throw new Error("Invalid evidence confidence");
      }
      evidence.push({signal:string(e.signal,"evidence signal",100),
        detail:string(e.detail,"evidence detail",1000),confidence});
    }
  }
  return {
    key:string(v.key,"entity key",1000),
    type,
    title:string(v.title,"entity title",2000),
    url:url?normalizeUrl(url):undefined,
    attributes,evidence
  };
}
export function validateAssessment(raw:unknown):Assessment{
  const v=object(raw);
  const score=Number(v.score),confidence=Number(v.confidence);
  if(!Number.isFinite(score)||score<0||score>100||!Number.isFinite(confidence)||confidence<0||confidence>1){
    throw new Error("Invalid assessment score or confidence");
  }
  return {category:string(v.category,"category",100),score:Math.round(score),
    confidence,reasons:keys(v.reasons,"assessment reasons",30)};
}
export function parseProject(raw:unknown):ProjectDefinition{
  const v=object(raw);
  const sources=v.sources,outputs=v.outputs??[],pipeline=v.pipeline??["extract-links"];
  const evaluator=v.evaluator??"keyword";
  if(!Array.isArray(sources)||sources.length===0||sources.length>30)throw new Error("Project needs 1–30 sources");
  if(!Array.isArray(outputs)||outputs.length>10)throw new Error("Invalid project outputs");
  const normalizedSources=sources.map((x:unknown)=>{
    const entry=object(x);
    return {id:id(entry.id,"connection id"),adapter:id(entry.adapter,"adapter id"),
      config:jsonRecord(entry.config??{})};
  });
  if(new Set(normalizedSources.map(x=>x.id)).size!==normalizedSources.length)throw new Error("Duplicate connection ids");
  const normalizedOutputs=outputs.map((x:unknown)=>{
    const entry=object(x);
    return {id:id(entry.id,"output id"),adapter:id(entry.adapter,"output adapter"),
      config:jsonRecord(entry.config??{})};
  });
  if(new Set(normalizedOutputs.map(x=>x.id)).size!==normalizedOutputs.length)throw new Error("Duplicate output ids");
  const rules=object(v.policy??{});
  const minimum=rules.minimumScore??0;
  if(typeof minimum!=="number"||!Number.isFinite(minimum)||minimum<0||minimum>100){
    throw new Error("Invalid minimum score");
  }
  if(!Array.isArray(pipeline)||pipeline.length===0||pipeline.length>25)throw new Error("Invalid processing pipeline");
  let schemas:ProjectDefinition["entitySchemas"];
  if(v.entitySchemas!==undefined){
    schemas={};
    for(const [type,definition] of Object.entries(object(v.entitySchemas))){
      id(type,"entity schema name");
      const fields=object(object(definition).fields);
      const normalized:Record<string,"string"|"number"|"boolean">={};
      for(const [field,val] of Object.entries(fields)){
        if(!/^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/.test(field)||
          !["string","number","boolean"].includes(String(val)))throw new Error("Invalid entity schema field");
        normalized[field]=val as "string"|"number"|"boolean";
      }
      const required=keys(object(definition).required??[],"required attributes");
      if(required.some(field=>!(field in normalized)))throw new Error("Unknown required field");
      schemas[type]={fields:normalized,required};
    }
  }
  let watch:ProjectDefinition["watch"];
  if(v.watch!==undefined){
    const config=object(v.watch);
    if(!Array.isArray(config.rules)||config.rules.length>40){
      throw new Error("Watch configuration must contain at most 40 rules");
    }
    const rules=config.rules.map(assertWatchRule);
    if(new Set(rules.map(r=>r.id)).size!==rules.length){
      throw new Error("Duplicate watch rule identifiers");
    }
    watch={rules};
  }
  return {id:id(v.id,"project id"),name:string(v.name,"project name",200),sources:normalizedSources,
    pipeline:pipeline.map(x=>id(x,"processor id")),evaluator:id(evaluator,"evaluator id"),
    outputs:normalizedOutputs,entitySchemas:schemas,watch,
    policy:{
      includeKeywords:keys(rules.includeKeywords??[],"include keywords"),
      excludeKeywords:keys(rules.excludeKeywords??[],"exclude keywords"),
      minimumScore:minimum
    }};
}
export function loadProject(file:string):ProjectDefinition{
  const path=resolve(file);
  const project=parseProject(JSON.parse(readFileSync(path,"utf8")) as unknown);
  // Paths to local inputs and explicitly trusted scripts are anchored to the
  // manifest so projects work from both the CLI and Obsidian's vault-based cwd.
  const local=(value:string)=>value.startsWith("./")||value.startsWith("../")||
    value.startsWith(".\\")||value.startsWith("..\\");
  for(const source of project.sources){
    if(["json-file","json-snapshot"].includes(source.adapter)&&typeof source.config.path==="string"){
      source.config.path=resolve(dirname(path),source.config.path);
    }
    if(source.adapter==="mcp-stdio"){
      if(typeof source.config.command==="string"&&local(source.config.command)){
        source.config.command=resolve(dirname(path),source.config.command);
      }
      if(typeof source.config.cwd==="string"&&local(source.config.cwd)){
        source.config.cwd=resolve(dirname(path),source.config.cwd);
      }
      if(Array.isArray(source.config.args)){
        source.config.args=source.config.args.map(value=>
          typeof value==="string"&&local(value)?
            resolve(dirname(path),value):value
        ) as string[];
      }
    }
  }
  return project;
}
