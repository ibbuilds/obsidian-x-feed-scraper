import {createServer} from "node:http";
import {timingSafeEqual,createHash} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
import {readFixture} from "../../packages/connectors/fixtures.ts";
import {fetchRSS} from "../../packages/connectors/rss.ts";
import {normalizeUrl} from "../../packages/core/url.ts";
import {ingest,enrich,referencesFromFile} from "../../packages/core/pipeline.ts";
import {exportToVault} from "../../packages/core/obsidian.ts";
import {Store} from "../../packages/storage/store.ts";
import type {Profile,Post} from "../../packages/core/types.ts";
import {join} from "node:path";
import {existsSync} from "node:fs";

export interface ServerOptions {
  db:string;profile:Profile;fixture?:string;feed?:string;vault?:string;references?:string;
  token:string;port:number;intervalMinutes:number;
}
function json(res:ServerResponse,code:number,value:unknown):void {
  res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "x-content-type-options":"nosniff"});
  res.end(JSON.stringify(value));
}
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req) {
    const piece=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    bytes+=piece.length;
    if(bytes>250_000) throw new Error("Request body exceeds 250 KB");
    chunks.push(piece);
  }
  const content=Buffer.concat(chunks).toString("utf8");
  if(!content) return {};
  const parsed:unknown=JSON.parse(content);
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("Invalid JSON object");
  return parsed as Record<string,unknown>;
}
function validatePosts(raw:unknown):Post[]{
  if(!Array.isArray(raw)||raw.length===0||raw.length>100) throw new Error("Import 1–100 posts");
  return raw.map((x:unknown)=>{
    if(!x||typeof x!=="object"||Array.isArray(x))throw new Error("Invalid post");
    const p=x as Record<string,unknown>;
    for(const key of ["id","url","author","username","text"]){
      if(typeof p[key]!=="string"||!(p[key] as string).trim()||(p[key] as string).length>12000){
        throw new Error("Invalid post field: "+key);
      }
    }
    normalizeUrl(p.url as string);
    const urls=Array.isArray(p.urls)?p.urls:[];
    if(urls.length>30||urls.some(y=>typeof y!=="string"||y.length>3000)) throw new Error("Invalid URLs");
    return {
      id:p.id as string,url:p.url as string,author:p.author as string,
      username:p.username as string,text:p.text as string,urls:urls as string[],
      publishedAt:typeof p.publishedAt==="string"?p.publishedAt:undefined
    };
  });
}
export function startServer(config:ServerOptions):ReturnType<typeof createServer>{
  if(config.token.length<24)throw new Error("Set XFS_API_TOKEN to a private random token (24+ characters)");
  if(!Number.isInteger(config.port)||config.port<0||config.port>65535||
    (config.port!==0&&config.port<1024))throw new Error("Invalid port");
  if(config.feed&&config.fixture)throw new Error("Select exactly one input connector");
  if(!Number.isFinite(config.intervalMinutes)||config.intervalMinutes<0)throw new Error("Invalid interval");
  if(config.feed&&config.intervalMinutes>0&&config.intervalMinutes<15){
    throw new Error("RSS schedules must be at least 15 minutes");
  }
  const initial=new Store(config.db);
  let paused=initial.paused();initial.close();
  let busy=false;
  const references=()=>referencesFromFile(config.references||
    (config.vault&&existsSync(join(config.vault,"References.md"))?join(config.vault,"References.md"):undefined));
  const source=()=>config.feed?"rss":config.fixture?"fixture":"none";
  const collect=async ()=>{
    if(paused)throw new Error("Collector is paused");
    if(busy)throw new Error("Synchronization already running");
    if(!config.fixture&&!config.feed)throw new Error("No input configured. Set an RSS URL or import observations manually.");
    busy=true;
    const connector=config.feed?"rss:"+createHash("sha256").update(config.feed).digest("hex").slice(0,16):"fixture";
    let inputAcquired=false;
    try{
      const observations=config.feed?await fetchRSS(config.feed):readFixture(config.fixture!);
      inputAcquired=true;
      const result=ingest(config.db,observations,config.profile,connector,references());
      return {result,export:config.vault?exportToVault(config.db,config.vault):null};
    }catch(error){
      if(!inputAcquired){
        const store=new Store(config.db);
        try{
          const id=store.begin(connector);
          store.error(id,"connector","Connector failed before producing observations");
          store.finish(id,"failed",0,0,0,"Connector failed before producing observations");
        }finally{store.close();}
      }
      throw error;
    }finally{busy=false;}
  };
  const server=createServer(async(req,res)=>{
    try{
      if(req.headers.origin){json(res,403,{error:"Cross-origin requests are forbidden"});return;}
      const incoming=Buffer.from(req.headers.authorization||"");
      const expected=Buffer.from("Bearer "+config.token);
      if(incoming.length!==expected.length||!timingSafeEqual(incoming,expected)){
        json(res,401,{error:"Unauthorized"});return;
      }
      const url=new URL(req.url||"/","http://127.0.0.1");
      if(url.pathname.includes("..")){json(res,404,{error:"Not found"});return;}
      if(req.method==="POST"&&url.pathname==="/sync"){
        json(res,200,await collect());return;
      }
      if(req.method==="POST"&&url.pathname==="/import"){
        if(busy)throw new Error("Collector is busy");
        const input=await body(req);
        const posts=validatePosts(input.posts);
        busy=true;
        try{
          const result=ingest(config.db,posts,config.profile,"manual",references());
          json(res,200,{result,export:config.vault?exportToVault(config.db,config.vault):null});
        }finally{busy=false;}
        return;
      }
      if(req.method==="POST"&&url.pathname==="/enrich"){
        if(busy)throw new Error("Collector is busy");
        const input=await body(req);
        const limit=Number(input.limit??10);
        if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error("Enrichment limit must be 1–20");
        busy=true;
        try{
          const result=await enrich(config.db,config.profile,references(),limit);
          json(res,200,{result,export:config.vault?exportToVault(config.db,config.vault):null});
        }finally{busy=false;}
        return;
      }
      if(req.method==="POST"&&url.pathname==="/export"){
        json(res,200,{export:config.vault?exportToVault(config.db,config.vault):null});return;
      }
      const store=new Store(config.db);
      try{
        if(req.method==="GET"&&url.pathname==="/diagnostics"){
          const row=store.db.prepare("PRAGMA quick_check").get() as Record<string,unknown>|undefined;
          const integrity=String(row?.quick_check||"unknown");
          const referencePath=config.references||(config.vault?join(config.vault,"References.md"):undefined);
          json(res,200,{
            nodeVersion:process.versions.node,
            sqliteIntegrity:integrity,
            vaultPresent:Boolean(config.vault&&existsSync(config.vault)),
            referencesPresent:Boolean(referencePath&&existsSync(referencePath)),
            collectorInput:source(),
            personalizedXFeedAvailable:false,
            readyForManualImport:integrity==="ok",
            readyForScheduledDiscovery:integrity==="ok"&&Boolean(config.feed),
            nextStep:config.feed?"Verify the authorized source in /history":"Configure a permitted RSS URL or import observations manually"
          });
        }else if(req.method==="GET"&&url.pathname==="/source"){
          const id=Number(url.searchParams.get("id"));
          if(!Number.isSafeInteger(id)||id<1)json(res,400,{error:"Invalid source ID"});
          else{
            const source=store.getSource(id);
            json(res,source?200:404,source||{error:"Source not found"});
          }
        }else if(req.method==="GET"&&url.pathname==="/status"){
          json(res,200,{...store.stats(),active:busy,paused,connectedSource:source(),
            personalizedXFeed:"not_available",feedUrl:config.feed||null});
        }else if(req.method==="GET"&&url.pathname==="/sources"){
          json(res,200,store.listSources(url.searchParams.get("status")||undefined,
            url.searchParams.get("q")||undefined,Number(url.searchParams.get("limit")||100),
            Number(url.searchParams.get("offset")||0)));
        }else if(req.method==="GET"&&url.pathname==="/visuals"){
          json(res,200,store.listVisualPosts(200));
        }else if(req.method==="GET"&&url.pathname==="/posts"){
          json(res,200,store.listPosts(100));
        }else if(req.method==="GET"&&url.pathname==="/recommendations"){
          json(res,200,store.recommendations());
        }else if(req.method==="GET"&&url.pathname==="/history"){
          json(res,200,store.history());
        }else if(req.method==="POST"&&url.pathname==="/pause"){
          paused=true;store.setPaused(true);json(res,200,{paused});
        }else if(req.method==="POST"&&url.pathname==="/resume"){
          paused=false;store.setPaused(false);json(res,200,{paused});
        }else if(req.method==="POST"&&url.pathname==="/review"){
          const input=await body(req);
          const id=Number(input.id),decision=String(input.decision);
          if(!Number.isSafeInteger(id)||id<1||!["approved","rejected","needs_review","excellent"].includes(decision)||
            (input.access!==undefined&&!["unknown","free","open_source","freemium","paid"].includes(String(input.access)))||
            typeof input.reason!=="string"||!input.reason.trim()||input.reason.length>1000){
            json(res,400,{error:"A valid decision and reason are required"});return;
          }
          const source=store.review(id,decision as "approved"|"rejected"|"needs_review"|"excellent",input.reason,
            input.access as "unknown"|"free"|"open_source"|"freemium"|"paid"|undefined);
          json(res,200,{source,export:config.vault?exportToVault(config.db,config.vault):null});
        }else json(res,404,{error:"Not found"});
      }finally{store.close();}
    }catch(e){
      json(res,400,{error:e instanceof Error?e.message:"Request failed"});
    }
  });
  server.listen(config.port,"127.0.0.1");
  if(config.intervalMinutes>0){
    const timer=setInterval(()=>{
      if(paused||busy||(!config.feed&&!config.fixture))return;
      void collect().catch(()=>{/* Failure already recorded by the connector or pipeline. */});
    },Math.max(15,config.intervalMinutes)*60_000);
    timer.unref();server.on("close",()=>clearInterval(timer));
  }
  return server;
}
