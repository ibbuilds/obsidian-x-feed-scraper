import {createHash} from "node:crypto";
import {fetchPublicText} from "../connectors/public-http.ts";
import {normalizeUrl} from "../core/url.ts";
import type {JsonRecord,Observation,SourceAdapter} from "../sdk/contracts.ts";

type JSONObject=Record<string,unknown>;
function obj(value:unknown):JSONObject|null {
  return value&&typeof value==="object"&&!Array.isArray(value)?
    value as JSONObject:null;
}
function typeIs(value:unknown,wanted:string):boolean {
  const list=Array.isArray(value)?value:[value];
  return list.some(item=>typeof item==="string"&&
    (item===wanted||item===("https://schema.org/"+wanted)||
      item===("http://schema.org/"+wanted)));
}
function text(value:unknown,max=300):string|undefined {
  if(typeof value!=="string")return undefined;
  const trimmed=value.trim();
  return trimmed?trimmed.slice(0,max):undefined;
}
function number(value:unknown):number|undefined {
  if(typeof value==="number")return Number.isFinite(value)&&value>=0?value:undefined;
  if(typeof value!=="string"||!/^(0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value))return undefined;
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>=0?parsed:undefined;
}
function offerOf(product:JSONObject):JSONObject|undefined{
  const raw=product.offers;
  const values=(Array.isArray(raw)?raw:[raw]).filter(Boolean);
  // Never quietly select an arbitrary merchant/variant if multiple offers exist.
  if(values.length!==1)return undefined;
  let offer=obj(values[0]);
  if(offer&&typeIs(offer["@type"],"AggregateOffer")){
    const candidates=Array.isArray(offer.offers)?offer.offers:[offer.offers];
    if(candidates.length!==1)return undefined;
    offer=obj(candidates[0]);
  }
  if(offer&&(typeIs(offer["@type"],"Offer")||offer["@type"]===undefined)){
    return offer;
  }
  return undefined;
}
function jsonLdObjects(html:string):JSONObject[]{
  if(html.length>1_000_000)throw new Error("Product page exceeds maximum HTML size");
  const documents:JSONObject[]=[];
  let visited=0;
  function walk(value:unknown,depth:number):void{
    if(depth>9||visited++>500)throw new Error("Product structured data is too deeply nested");
    if(Array.isArray(value)){
      for(const item of value)walk(item,depth+1);
      return;
    }
    const node=obj(value);
    if(!node)return;
    if(typeIs(node["@type"],"Product"))documents.push(node);
    if(node["@graph"]!==undefined)walk(node["@graph"],depth+1);
    if(node.mainEntity!==undefined)walk(node.mainEntity,depth+1);
  }
  const scripts=html.matchAll(/<script\b([^>]{0,1500})>([\s\S]*?)<\/script\s*>/gi);
  let count=0;
  for(const script of scripts){
    if(++count>150)throw new Error("Too many page scripts");
    if(!/(?:^|\s)type\s*=\s*(['"])application\/ld\+json\1/i.test(script[1]))continue;
    if(script[2].length>250_000)throw new Error("Product JSON-LD exceeds size limit");
    let parsed:unknown;
    try{parsed=JSON.parse(script[2]);}catch{continue;}
    walk(parsed,0);
  }
  return documents;
}
/**
 * Extract one unambiguous Schema.org Product + Offer from a public HTML page.
 * The page's own claimed price is evidence, NOT an independently verified quote.
 */
export function parseProductPage(html:string,requestedUrl:string):Observation{
  const url=normalizeUrl(requestedUrl);
  const candidates=jsonLdObjects(html);
  if(!candidates.length)throw new Error("No Schema.org Product data found");
  const offers=candidates.map(product=>({product,offer:offerOf(product)}))
    .filter(item=>item.offer!==undefined);
  if(offers.length!==1)throw new Error("Page has no single unambiguous product offer");
  const {product,offer:offerMaybe}=offers[0];
  const offer=offerMaybe!;
  const priceSpec=obj(offer.priceSpecification);
  const price=number(offer.price??priceSpec?.price);
  const currency=text(offer.priceCurrency??priceSpec?.priceCurrency,4);
  const title=text(product.name,300);
  if(!title||price===undefined||!currency||!/^[A-Z]{3}$/.test(currency)){
    throw new Error("Product requires title, numeric price and ISO currency");
  }
  const sku=text(product.sku,150);
  const availability=text(offer.availability,150);
  const description=text(product.description,1000);
  const brand=obj(product.brand);
  const attributes:JsonRecord={
    price,currency,
    sku:sku||null,
    availability:availability?availability.split("/").pop()||availability:null,
    brand:text(brand?.name,150)||null,
    provenance:"Public page Schema.org Product/Offer JSON-LD"
  };
  return {
    id:createHash("sha256").update(url).digest("hex"),
    type:"product",title,text:description||title,url,
    attributes
  };
}
export const publicProductSource:SourceAdapter={
  id:"public-product",
  async collect({source,cursor,limit}){
    const urls=source.config.urls;
    if(!Array.isArray(urls)||urls.length<1||urls.length>100||
      urls.some(x=>typeof x!=="string")){
      throw new Error("Public product source requires 1–100 authorized URLs");
    }
    const offset=cursor===undefined?0:Number(cursor);
    if(!Number.isSafeInteger(offset)||offset<0||offset>urls.length)throw new Error("Invalid product cursor");
    const observations:Observation[]=[];
    // Fetch at most five product pages per collector call.
    const end=Math.min(urls.length,offset+Math.min(limit,5));
    for(let i=offset;i<end;i++){
      const item=urls[i] as string;
      const url=normalizeUrl(item);
      if(new URL(url).protocol!=="https:")throw new Error("Public product monitoring requires HTTPS");
      const result=await fetchPublicText(url,{
        accept:"text/html",types:["text/html"],maxBytes:1_000_000
      });
      observations.push(parseProductPage(result.body,result.url));
    }
    const hasMore=end<urls.length;
    // Revisit complete collections on future scheduled runs.
    return {observations,hasMore,nextCursor:hasMore?String(end):undefined};
  }
};
