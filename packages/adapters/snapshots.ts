import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {isAbsolute} from "node:path";
import {fetchPublicText} from "../connectors/public-http.ts";
import {validateObservation} from "../core/project-config.ts";
import {normalizeUrl} from "../core/url.ts";
import {parseMcpMapping,mapMcpToolResult,mcpField} from "./mcp-mapping.ts";
import type {Observation,SourceAdapter,SourceContext} from "../sdk/contracts.ts";

interface LoadedSnapshot {items:Observation[];revision:string}
const snapshots=new WeakMap<AbortSignal,Map<string,LoadedSnapshot>>();
function cached(signal:AbortSignal,key:string,load:()=>Promise<Observation[]>):Promise<LoadedSnapshot>{
  let current=snapshots.get(signal);
  if(!current){current=new Map();snapshots.set(signal,current);}
  const existing=current.get(key);
  if(existing)return Promise.resolve(existing);
  return load().then(items=>{
    // A cursor's revision belongs to the entire run, not to each page.
    // Hash once to avoid O(total items * number of pages) CPU work.
    const snapshot={items,revision:createHash("sha256")
      .update(JSON.stringify(items)).digest("hex").slice(0,16)};
    current!.set(key,snapshot);
    return snapshot;
  });
}
function page(snapshot:LoadedSnapshot,cursor:string|undefined,limit:number){
  const {items,revision}=snapshot;
  let offset=0;
  if(cursor!==undefined){
    const match=/^([0-9a-f]{16}):(0|[1-9][0-9]{0,9})$/.exec(cursor);
    if(!match)throw new Error("Invalid source snapshot cursor");
    // A snapshot that changes while a large collection is being paged
    // restarts safely from item 0, rather than skipping changed earlier rows.
    if(match[1]===revision)offset=Number(match[2]);
  }
  if(offset>items.length)offset=0;
  const observations=items.slice(offset,offset+limit);
  const hasMore=offset+observations.length<items.length;
  return {observations,hasMore,
    nextCursor:hasMore?revision+":"+String(offset+observations.length):undefined};
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
