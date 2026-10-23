import {createHash} from "node:crypto";
import {XMLParser} from "fast-xml-parser";
import type {Post} from "../core/types.ts";
import {normalizeUrl,isXUrl} from "../core/url.ts";
import {fetchPublicText} from "./public-http.ts";

export function parseFeed(xml:string, feedUrl:string):Post[] {
  if(xml.length>1_000_000) throw new Error("Feed too large");
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD and custom XML entities are not allowed");
  const parser=new XMLParser({
    ignoreAttributes:false,attributeNamePrefix:"@_",textNodeName:"#text",
    removeNSPrefix:true,processEntities:false,parseTagValue:false,parseAttributeValue:false
  });
  const document=parser.parse(xml) as Record<string,unknown>;
  function node(x:unknown):Record<string,unknown>{
    return x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
  }
  function value(x:unknown):string{
    if(typeof x==="string")return x.replace(/&amp;/gi,"&").replace(/&lt;/gi,"<")
      .replace(/&gt;/gi,">").replace(/&quot;/gi,"\"").replace(/&apos;/gi,"\'");
    if(typeof x==="number")return String(x);
    if(Array.isArray(x))return x.map(value).find(Boolean)||"";
    const o=node(x);
    return value(o["#text"]??o["@_href"]??o.href??"");
  }
  const channel=node(node(document.rss).channel);
  const atom=node(document.feed);
  const list=channel.item??atom.entry;
  const entries=Array.isArray(list)?list:list?[list]:[];
  if(!entries.length&&!channel.title&&!atom.title) throw new Error("Not a supported RSS or Atom feed");
  const posts:Post[]=[];
  const seen=new Set<string>();
  for(const raw of entries.slice(0,50)){
    const item=node(raw);
    const link=value(item.link)||value(item.guid);
    let url:string;
    try {
      url=normalizeUrl(new URL(link,feedUrl).href);
      if(isXUrl(url)) continue;
    }catch{continue;}
    const title=value(item.title).slice(0,300);
    const html=value(item.description??item.summary??item.content??item.encoded);
    const summary=html.replace(/<[^>]*>/g," ").replace(/&(?:nbsp|amp);/gi," ")
      .replace(/\s+/g," ").slice(0,3000);
    const guid=value(item.guid??item.id)||url;
    const id=createHash("sha256").update(feedUrl+"\0"+guid).digest("hex");
    if(seen.has(id))continue;
    seen.add(id);
    const date=value(item.pubDate??item.published??item.updated);
    const parsedDate=date?Date.parse(date):NaN;
    const host=new URL(url).hostname;
    posts.push({
      id,url,author:value(item.author??item.creator)||host,
      username:host,text:(title+" "+summary+" "+url).slice(0,5000),
      publishedAt:Number.isFinite(parsedDate)?new Date(parsedDate).toISOString():undefined,
      urls:[url]
    });
  }
  return posts;
}
export async function fetchRSS(feedUrl:string):Promise<Post[]> {
  const normalized=normalizeUrl(feedUrl);
  if(isXUrl(normalized)) throw new Error("X does not expose an authorized RSS feed here");
  const data=await fetchPublicText(normalized,{
    accept:"application/rss+xml, application/atom+xml, application/xml, text/xml",
    types:["application/rss+xml","application/atom+xml","application/xml","text/xml"],maxBytes:1_000_000
  });
  return parseFeed(data.body,normalized);
}
