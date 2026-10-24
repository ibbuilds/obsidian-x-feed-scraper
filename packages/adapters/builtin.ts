import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fetchRSS} from "../connectors/rss.ts";
import type {Extension,Observation,SourceAdapter} from "../sdk/contracts.ts";
import {validateObservation} from "../core/project-config.ts";

function path(config:Record<string,unknown>):string{
  if(typeof config.path!=="string"||!config.path.trim())throw new Error("This adapter requires a local path");
  return resolve(config.path);
}
const jsonFile:SourceAdapter={
  id:"json-file",
  async collect({source,cursor,limit}){
    const value:unknown=JSON.parse(readFileSync(path(source.config),"utf8"));
    if(!Array.isArray(value)||value.length>10000)throw new Error("JSON source must be an array of at most 10,000 observations");
    const offset=cursor===undefined?0:Number(cursor);
    if(!Number.isSafeInteger(offset)||offset<0||offset>value.length)throw new Error("Invalid JSON cursor");
    const items=(value as unknown[]).slice(offset,offset+limit).map(validateObservation);
    const next=offset+items.length;
    return {observations:items,nextCursor:String(next),hasMore:next<value.length};
  }
};
const rss:SourceAdapter={
  id:"rss",
  async collect({source}){
    const feed=source.config.url;
    if(typeof feed!=="string")throw new Error("RSS URL is required");
    const posts=await fetchRSS(feed);
    const observations:Observation[]=posts.map(post=>({
      id:post.id,type:"feed-entry",title:post.text.slice(0,200),text:post.text,
      url:post.url,urls:post.urls,occurredAt:post.publishedAt,
      attributes:{author:post.author,username:post.username}
    }));
    return {observations,hasMore:false};
  }
};
export const builtinSources:Extension={apiVersion:1,adapters:[jsonFile,rss]};
