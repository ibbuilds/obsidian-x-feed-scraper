import {lookup} from "node:dns/promises";
import {request as http} from "node:http";
import {request as https} from "node:https";
import type {IncomingMessage} from "node:http";
import {isIP} from "node:net";
import {isLocalOrUnsafeAddress, normalizeUrl, safeHostname} from "../core/url.ts";
import type {Metadata} from "../core/types.ts";

function decode(text: string): string {
  return text.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").trim();
}
function meta(html: string, names: string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]{1,2000}>/gi) || []) {
    const name = tag.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (name && names.includes(name) && content) return decode(content).slice(0,500);
  }
  return undefined;
}
async function readPublicHtml(raw: string, redirects: number): Promise<{url:string;html:string;type:string}> {
  if (redirects > 3) throw new Error("Too many redirects");
  const normalized = normalizeUrl(raw);
  const url = new URL(normalized);
  const hostname = safeHostname(normalized);
  const addresses = isIP(hostname)
    ? [{address:hostname, family:isIP(hostname)}]
    : await lookup(hostname,{all:true});
  if (!addresses.length || addresses.some(a => isLocalOrUnsafeAddress(a.address))) throw new Error("Unsafe DNS resolution");
  const pinned = addresses[0];
  return await new Promise((resolve,reject) => {
    let done = false;
    const fail = (err: Error) => {if (!done) {done=true;reject(err);}};
    const req = (url.protocol === "https:" ? https : http)(url,{
      method:"GET",
      headers:{"accept":"text/html","user-agent":"XFeedScraper/0.1 (+local research; no automated X access)"},
      lookup: (_host, _opts, cb) => cb(null,pinned.address,pinned.family),
      timeout:6000
    },(res:IncomingMessage) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        readPublicHtml(new URL(res.headers.location,url).toString(),redirects+1).then(resolve,reject);
        return;
      }
      const type = String(res.headers["content-type"] || "").toLowerCase();
      if (code < 200 || code >= 300 || !type.includes("text/html")) {
        res.resume();fail(new Error("Unavailable HTML metadata"));return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data",(part:string)=>{
        data += part;
        if (data.length > 100000) {req.destroy();fail(new Error("HTML limit exceeded"));}
      });
      res.on("end",()=>{if (!done) {done=true;resolve({url:normalized,html:data,type});}});
      res.on("error",fail);
    });
    req.on("timeout",()=>req.destroy(new Error("Metadata timeout")));
    req.on("error",fail);
    req.end();
  });
}
export async function fetchPublicMetadata(raw:string): Promise<{url:string;metadata:Metadata}> {
  const result = await readPublicHtml(raw,0);
  const title = meta(result.html,["og:title","twitter:title"]) ||
    decode(result.html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] || "");
  const description = meta(result.html,["description","og:description","twitter:description"]);
  // Public HTML does not prove cost, rights, usability or design quality.
  return {url:result.url,metadata:{title:title || undefined,description,contentType:result.type,access:"unknown"}};
}
