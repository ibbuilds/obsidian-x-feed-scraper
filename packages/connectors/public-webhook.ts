import {lookup} from "node:dns/promises";
import {request} from "node:https";
import type {ClientRequest} from "node:http";
import {isIP} from "node:net";
import {isLocalOrUnsafeAddress,normalizeUrl,safeHostname} from "../core/url.ts";

const MAX_PAYLOAD_BYTES=131_072,MAX_RESPONSE_BYTES=16_384;
const SECRET_QUERY_KEY=/(?:^|[_-])(?:token|accesskey|apikey|api[_-]?key|key|secret|password|passwd|pwd|session|sessionid|auth|authorization|jwt|signature|sig|cookie)(?:$|[_-])/i;
type FailureCode="configuration"|"destination"|"dns"|"redirect"|"response"|"network"|"timeout"|"aborted"|"payload";
/** Safe to persist: never includes endpoint URLs, response bodies or credentials. */
export class WebhookDeliveryError extends Error {
  readonly code:FailureCode;
  constructor(code:FailureCode,status?:number){
    super("Webhook delivery "+code+(status===undefined?"":" (HTTP "+status+")"));
    this.name="WebhookDeliveryError";this.code=code;
  }
}

/** Validate without changing meaningful webhook paths or query order. */
export function validateWebhookEndpoint(input:unknown):string{
  try{
    if(typeof input!=="string"||input.length>3000)throw new Error();
    normalizeUrl(input); // Reject credentials, credential-like query keys and non-web schemes.
    const parsed=new URL(input.trim());
    if(parsed.protocol!=="https:"||parsed.hash)throw new Error();
    // Unlike resource normalization, delivery preserves query bytes. Check even
    // tracking-prefixed keys that normalizeUrl would otherwise discard.
    if([...parsed.searchParams.keys()].some(key=>SECRET_QUERY_KEY.test(key)))throw new Error();
    const checked=new URL(parsed);
    checked.hostname=checked.hostname.replace(/\.$/,"");
    const host=safeHostname(checked.toString());
    if(["x.com","twitter.com","t.co"].some(domain=>host===domain||host.endsWith("."+domain))){
      throw new Error();
    }
    return parsed.toString();
  }catch{throw new WebhookDeliveryError("destination");}
}

/** One bounded HTTPS POST. DNS is pinned; redirects are always rejected. */
export async function postPublicWebhook(endpoint:string,payload:string,options:{
  idempotencyKey:string;bearerToken?:string;timeoutMs?:number;signal?:AbortSignal
}):Promise<{status:number}>{
  const url=validateWebhookEndpoint(endpoint);
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(options.idempotencyKey)||
    options.bearerToken!==undefined&&(!options.bearerToken||options.bearerToken.length>4096||
      /[\u0000-\u0020\u007f]/.test(options.bearerToken))){
    throw new WebhookDeliveryError("configuration");
  }
  if(Buffer.byteLength(payload,"utf8")>MAX_PAYLOAD_BYTES)throw new WebhookDeliveryError("payload");
  const timeout=options.timeoutMs??8000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>30_000)throw new WebhookDeliveryError("configuration");
  if(options.signal?.aborted)throw new WebhookDeliveryError("aborted");
  const parsed=new URL(url),checked=new URL(url);
  checked.hostname=checked.hostname.replace(/\.$/,"");
  const host=safeHostname(checked.toString());
  return await new Promise((resolve,reject)=>{
    let settled=false,req:ClientRequest|undefined;
    const finish=(error?:WebhookDeliveryError,status?:number)=>{
      if(settled)return;
      settled=true;clearTimeout(deadline);options.signal?.removeEventListener("abort",abort);
      if(error){req?.destroy();reject(error);}else resolve({status:status!});
    };
    const abort=()=>finish(new WebhookDeliveryError("aborted"));
    const deadline=setTimeout(()=>finish(new WebhookDeliveryError("timeout")),timeout);
    options.signal?.addEventListener("abort",abort,{once:true});
    void (async()=>{
      let addresses:Array<{address:string;family:number}>;
      try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});}
      catch{finish(new WebhookDeliveryError("dns"));return;}
      if(settled)return;
      if(!addresses.length||addresses.some(item=>isLocalOrUnsafeAddress(item.address))){
        finish(new WebhookDeliveryError("destination"));return;
      }
      const pinned=addresses[0];
      req=request(parsed,{
        method:"POST",timeout,family:pinned.family,
        headers:{
          "content-type":"application/json","content-length":Buffer.byteLength(payload,"utf8"),
          accept:"application/json","accept-encoding":"identity",
          "user-agent":"DiscoveryEngine/0.9 (explicit opt-in alert delivery)",
          "idempotency-key":options.idempotencyKey,
          ...(options.bearerToken?{authorization:"Bearer "+options.bearerToken}:{})
        },
        lookup:(_hostname,_opts,callback)=>callback(null,pinned.address,pinned.family)
      },res=>{
        if(settled){res.destroy();return;}
        const status=res.statusCode||0;
        if(status>=300&&status<400){finish(new WebhookDeliveryError("redirect",status));return;}
        if(status<200||status>=300){finish(new WebhookDeliveryError("response",status));return;}
        let size=0;
        if(Number(res.headers["content-length"]||0)>MAX_RESPONSE_BYTES){
          finish(new WebhookDeliveryError("response"));return;
        }
        res.on("data",(part:Buffer)=>{
          size+=part.length;
          if(size>MAX_RESPONSE_BYTES)finish(new WebhookDeliveryError("response"));
        });
        res.on("end",()=>finish(undefined,status));
        res.on("aborted",()=>finish(new WebhookDeliveryError("response")));
        res.on("error",()=>finish(new WebhookDeliveryError("response")));
      });
      req.on("error",()=>finish(new WebhookDeliveryError("network")));
      req.on("timeout",()=>finish(new WebhookDeliveryError("timeout")));
      req.end(payload);
    })().catch(()=>finish(new WebhookDeliveryError("network")));
  });
}
