import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fetchRSS} from "../connectors/rss.ts";
import type {Extension,Observation,SourceAdapter} from "../sdk/contracts.ts";
import {validateObservation} from "../core/project-config.ts";
import {mcpStdioSource} from "./mcp-stdio.ts";
import {jsonSnapshotSource,publicJsonSource} from "./snapshots.ts";
import {publicProductSource} from "./product-jsonld.ts";
import {normalizeUrl} from "../core/url.ts";

function path(config:Record<string,unknown>):string{
  if(typeof config.path!=="string"||!config.path.trim())throw new Error("This adapter requires a local path");
  return resolve(config.path);
}
// Freeze a file's observed array for each collection run. Reading and parsing
// 10k records once per page was O(records * pages); a fresh run gets a new signal.
const jsonFileCache=new WeakMap<AbortSignal,Map<string,unknown[]>>();
const jsonFile:SourceAdapter={
  id:"json-file",
  async collect({source,cursor,limit,signal}){
    let bySource=jsonFileCache.get(signal);
    if(!bySource){bySource=new Map();jsonFileCache.set(signal,bySource);}
    let value=bySource.get(source.id);
    if(!value){
      const loaded:unknown=JSON.parse(readFileSync(path(source.config),"utf8"));
      if(!Array.isArray(loaded)||loaded.length>10000){
        throw new Error("JSON source must be an array of at most 10,000 observations");
      }
      value=loaded;
      bySource.set(source.id,value);
    }
    const offset=cursor===undefined?0:Number(cursor);
    if(!Number.isSafeInteger(offset)||offset<0||offset>value.length)throw new Error("Invalid JSON cursor");
    const items=(value as unknown[]).slice(offset,offset+limit).map(validateObservation);
    const next=offset+items.length;
    return {observations:items,nextCursor:String(next),hasMore:next<value.length};
  }
};
const rssCache=new Map<string,{date:number;items:Observation[]}>();
const rss:SourceAdapter={
  id:"rss",
  async collect({source,cursor,limit}){
    const feed=source.config.url;
    if(typeof feed!=="string")throw new Error("RSS URL is required");
    const url=normalizeUrl(feed);
    const offset=cursor===undefined?0:Number(cursor);
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error("Invalid RSS page cursor");
    let cached=rssCache.get(url);
    if(!cached||Date.now()-cached.date>60000){
      const posts=await fetchRSS(url);
      const items:Observation[]=posts.map(post=>({
        id:post.id,type:"feed-entry",title:post.text.slice(0,200),text:post.text,
        url:post.url,urls:post.urls,occurredAt:post.publishedAt,
        attributes:{author:post.author,username:post.username}
      }));
      cached={date:Date.now(),items};
      rssCache.set(url,cached);
      if(rssCache.size>20)rssCache.delete(rssCache.keys().next().value!);
    }
    const observations=cached.items.slice(offset,offset+limit);
    const next=offset+observations.length;
    const hasMore=next<cached.items.length;
    // Complete feeds intentionally reset cursor, so fresh items are checked next run.
    return {observations,nextCursor:hasMore?String(next):undefined,hasMore};
  }
};
export const builtinSources:Extension={apiVersion:1,
  adapters:[jsonFile,jsonSnapshotSource,rss,publicJsonSource,publicProductSource,mcpStdioSource]};
