import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";
import {fetchPublicText} from "../connectors/public-http.ts";
import {validateObservation} from "../core/project-config.ts";
import {normalizeUrl} from "../core/url.ts";
import {parseMcpMapping,mapMcpToolResult,mcpField} from "./mcp-mapping.ts";
import type {Observation,SourceAdapter,SourceContext} from "../sdk/contracts.ts";

const snapshots=new WeakMap<AbortSignal,Map<string,Observation[]>>();
function cached(signal:AbortSignal,key:string,load:()=>Promise<Observation[]>):Promise<Observation[]>{
  let current=snapshots.get(signal);
  if(!current){current=new Map();snapshots.set(signal,current);}
  const existing=current.get(key);
  if(existing)return Promise.resolve(existing);
  return load().then(items=>{current!.set(key,items);return items;});
}
function readOffset(cursor:string|undefined):number{
  if(cursor===undefined)return 0;
  if(!/^(0|[1-9][0-9]{0,9})$/.test(cursor))throw new Error("Invalid source snapshot cursor");
  const offset=Number(cursor);
  if(!Number.isSafeInteger(offset))throw new Error("Invalid source offset");
  return offset;
}
function page(items:Observation[],cursor:string|undefined,limit:number){
  const offset=readOffset(cursor);
  if(offset>items.length)throw new Error("Snapshot cursor exceeds collection length");
  const observations=items.slice(offset,offset+limit);
  const hasMore=offset+observations.length<items.length;
  // A complete snapshot has no carry-over cursor: every new scheduled
  // collection re-reads known entity identities and detects their changes.
  return {observations,hasMore,nextCursor:hasMore?String(offset+observations.length):undefined};
}
/** Rereads a configured local JSON array on every run, unlike append-only json-file. */
export const jsonSnapshotSource:SourceAdapter={
  id:"json-snapshot",
  async collect({source,cursor,limit,signal}){
    const path=source.config.path;
    if(typeof path!=="string"||!isAbsolute(path)){
      throw new Error("Snapshot source requires an absolute local JSON path");
    }
    const observations=await cached(signal,source.id,async()=>{
      const raw:unknown=JSON.parse(readFileSync(path,"utf8"));
      if(!Array.isArray(raw)||raw.length>10000)throw new Error(
        "JSON snapshot must contain at most 10,000 observations");
      return raw.map(validateObservation);
    });
    return page(observations,cursor,limit);
  }
};
/**
 * Public read-only JSON APIs. Uses the same DNS-pinned HTTP client as RSS, and
 * explicit user-provided mapping; no credentials, JS eval or arbitrary scripts.
 */
export const publicJsonSource:SourceAdapter={
  id:"public-json",
  async collect({source,cursor,limit,signal}:SourceContext){
    const url=source.config.url;
    if(typeof url!=="string")throw new Error("Public JSON adapter requires an HTTPS URL");
    const normalized=normalizeUrl(url);
    if(new URL(normalized).protocol!=="https:"){
      throw new Error("Public JSON adapters require HTTPS");
    }
    const rawMapping=source.config.mapping;
    if(!rawMapping||typeof rawMapping!=="object"||Array.isArray(rawMapping)){
      throw new Error("Public JSON adapter requires a field mapping");
    }
    const mapping=parseMcpMapping({
      ...rawMapping,
      hasMorePath:"ignoredHasMore",
      nextCursorPath:"ignoredCursor"
    });
    if(!mapping)throw new Error("Public JSON mapping missing");
    const observations=await cached(signal,source.id,async()=>{
      const response=await fetchPublicText(normalized,{
        accept:"application/json",
        types:["application/json","application/ld+json","application/problem+json"],
        maxBytes:1_000_000
      });
      let doc:unknown;
      try{doc=JSON.parse(response.body);}catch{throw new Error("Public JSON API returned invalid JSON");}
      const rows=mcpField(doc,mapping.itemsPath);
      if(!Array.isArray(rows)||rows.length>10000)throw new Error(
        "Public JSON mapping must select an array (max 10,000)");
      const mapped:Observation[]=[];
      for(let offset=0;offset<rows.length;offset+=500){
        // Delegate field validation to the same shared mapping contract as MCP.
        const batch=mapMcpToolResult({records:rows.slice(offset,offset+500)},
          {...mapping,itemsPath:"records"});
        mapped.push(...batch.observations.map(validateObservation));
      }
      return mapped;
    });
    return page(observations,cursor,limit);
  }
};
