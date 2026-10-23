import {lookup} from "node:dns/promises";
import {request as http} from "node:http";
import {request as https} from "node:https";
import {isIP} from "node:net";
import {isLocalOrUnsafeAddress, normalizeUrl, safeHostname, isXUrl} from "../core/url.ts";

/** DNS-pinned, redirect-revalidated public text retrieval. No sessions or X scraping. */
export async function fetchPublicText(input:string, options:{
  accept:string;types:readonly string[];maxBytes?:number;redirects?:number
}):Promise<{url:string;body:string;contentType:string}> {
  const maxBytes=Math.min(1_000_000,Math.max(1024,options.maxBytes??300_000));
  async function step(inputUrl:string,remaining:number):Promise<{url:string;body:string;contentType:string}> {
    if(remaining<0) throw new Error("Too many redirects");
    const canonical=normalizeUrl(inputUrl);
    if(isXUrl(canonical)||new URL(canonical).hostname==="t.co"){
      throw new Error("Automated retrieval from X is not supported");
    }
    const parsed=new URL(canonical);
    const host=safeHostname(canonical);
    const addresses=isIP(host) ? [{address:host,family:isIP(host)}] : await lookup(host,{all:true});
    if(!addresses.length || addresses.some(x=>isLocalOrUnsafeAddress(x.address))) {
      throw new Error("Unsafe or private DNS resolution");
    }
    const pinned=addresses[0];
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const fail=(error:Error)=>{if(!settled){settled=true;reject(error);}};
      const req=(parsed.protocol==="https:"?https:http)(parsed,{
        method:"GET",
        headers:{
          "accept":options.accept,
          "accept-encoding":"identity",
          "user-agent":"ObsidianXFeedScraper/0.2 (user-configured public sources)"
        },
        lookup:(_hostname,_opts,callback)=>callback(null,pinned.address,pinned.family),
        timeout:8000
      },res=>{
        const status=res.statusCode||0;
        if(status>=300 && status<400 && res.headers.location){
          res.resume();
          const next=new URL(res.headers.location,parsed).toString();
          step(next,remaining-1).then(value=>{if(!settled){settled=true;resolve(value);}},fail);
          return;
        }
        const type=String(res.headers["content-type"]||"").toLowerCase().split(";")[0].trim();
        if(status<200 || status>=300 || !options.types.some(allowed=>type===allowed || type.startsWith(allowed+"+"))){
          res.resume();fail(new Error("Unusable public text response: HTTP "+status));return;
        }
        let length=0;
        const parts:Buffer[]=[];
        res.on("data",(part:Buffer)=>{
          length+=part.length;
          if(length>maxBytes){req.destroy();fail(new Error("Response too large"));return;}
          parts.push(part);
        });
        res.on("end",()=>{if(!settled){settled=true;resolve({url:canonical,body:Buffer.concat(parts).toString("utf8"),contentType:type});}});
        res.on("error",fail);
      });
      req.on("error",fail);
      req.on("timeout",()=>req.destroy(new Error("Public request timed out")));
      req.end();
    });
  }
  return step(input,Math.min(4,Math.max(0,options.redirects??3)));
}
