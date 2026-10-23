import type {Metadata} from "../core/types.ts";
import {fetchPublicText} from "./public-http.ts";

function decode(text:string):string {
  return text.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/gi,"<").replace(/&gt;/gi,">").trim();
}
function meta(html:string,names:string[]):string|undefined {
  for(const tag of html.match(/<meta\b[^>]{1,2000}>/gi)||[]){
    const name=tag.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content=tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if(name&&names.includes(name)&&content)return decode(content).slice(0,500);
  }
  return undefined;
}
const SPDX_OPEN=new Set([
  "MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC","MPL-2.0","GPL-2.0",
  "GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","Unlicense","CC0-1.0",
  "EPL-2.0","OFL-1.1","Zlib","Artistic-2.0"
]);
export function githubRepoPath(url:string):{owner:string;repo:string}|null{
  const parsed=new URL(url);
  if(parsed.hostname.toLowerCase()!=="github.com")return null;
  const segments=parsed.pathname.split("/").filter(Boolean);
  if(segments.length<2||!segments.slice(0,2).every(s=>/^[A-Za-z0-9_.-]{1,100}$/.test(s))){
    return null;
  }
  return {owner:segments[0],repo:segments[1].replace(/\.git$/,"")};
}
export function parseGithubMetadata(input:unknown):Metadata{
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid GitHub response");
  const data=input as Record<string,unknown>;
  if(data.private===true)throw new Error("GitHub resource is not public");
  const license=data.license&&typeof data.license==="object"?
    (data.license as Record<string,unknown>).spdx_id:undefined;
  const code=typeof license==="string"&&license!=="NOASSERTION"?license:undefined;
  const isOpenSource=Boolean(code&&SPDX_OPEN.has(code));
  return {
    title:typeof data.full_name==="string"?data.full_name.slice(0,300):undefined,
    description:typeof data.description==="string"?data.description.slice(0,500):undefined,
    contentType:"application/json",
    license:code,
    access:isOpenSource?"open_source":"unknown"
  };
}
export async function fetchPublicMetadata(raw:string):Promise<{url:string;metadata:Metadata}>{
  const repo=githubRepoPath(raw);
  if(repo){
    try{
      const endpoint="https://api.github.com/repos/"+encodeURIComponent(repo.owner)+"/"+
        encodeURIComponent(repo.repo);
      const response=await fetchPublicText(endpoint,{
        accept:"application/vnd.github+json, application/json",
        types:["application/json","application/vnd.github+json"],maxBytes:200_000
      });
      return {url:raw,metadata:parseGithubMetadata(JSON.parse(response.body))};
    }catch{
      // GitHub's unauthenticated API may rate limit; fall back to public HTML.
    }
  }
  const result=await fetchPublicText(raw,{accept:"text/html",types:["text/html"],maxBytes:120_000});
  const title=meta(result.body,["og:title","twitter:title"])||
    decode(result.body.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]||"");
  const description=meta(result.body,["description","og:description","twitter:description"]);
  return {url:result.url,metadata:{
    title:title||undefined,description,contentType:result.contentType,access:"unknown"
  }};
}
