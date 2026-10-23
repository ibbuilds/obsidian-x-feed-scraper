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
    if(name && names.includes(name) && content) return decode(content).slice(0,500);
  }
  return undefined;
}
export async function fetchPublicMetadata(raw:string):Promise<{url:string;metadata:Metadata}>{
  const result=await fetchPublicText(raw,{
    accept:"text/html",types:["text/html"],maxBytes:120_000
  });
  const title=meta(result.body,["og:title","twitter:title"])||
    decode(result.body.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]||"");
  const description=meta(result.body,["description","og:description","twitter:description"]);
  return {url:result.url,metadata:{
    title:title||undefined,description,contentType:result.contentType,access:"unknown"
  }};
}
