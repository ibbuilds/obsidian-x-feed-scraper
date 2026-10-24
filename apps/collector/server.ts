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
import {loadProject} from "../../packages/core/project-config.ts";
import {createObsidianRegistry} from "../../packages/integrations/obsidian-registry.ts";
import {runProject,reprocessProject} from "../../packages/core/engine.ts";
import {exportProject} from "../../packages/core/export-project.ts";
import {KnowledgeStore} from "../../packages/storage/knowledge.ts";
import {getWebhookDeliveryStatus} from "../../packages/outputs/webhook.ts";

export interface ServerOptions {
  db:string;profile:Profile;fixture?:string;feed?:string;vault?:string;references?:string;
  token:string;port:number;intervalMinutes:number;autoEnrich?:boolean;
  projectPath?:string;extensionPath?:string;
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
    const validLinks=(key:"urls"|"quotedUrls"|"images"):string[]=>{
      if(p[key]===undefined)return [];
      const links=p[key];
      if(!Array.isArray(links)||links.length>30||
        links.some(value=>typeof value!=="string"||value.length>3000)){
        throw new Error("Invalid "+key);
      }
      return links as string[];
    };
    if(p.quotedText!==undefined&&(typeof p.quotedText!=="string"||p.quotedText.length>12000)){
      throw new Error("Invalid quoted text");
    }
    const publishedAt=typeof p.publishedAt==="string"&&Number.isFinite(Date.parse(p.publishedAt))?
      new Date(p.publishedAt).toISOString():undefined;
    return {
      id:p.id as string,url:p.url as string,author:p.author as string,
      username:p.username as string,text:p.text as string,
      urls:validLinks("urls"),quotedUrls:validLinks("quotedUrls"),
      images:validLinks("images"),
      quotedText:typeof p.quotedText==="string"?p.quotedText:undefined,
      publishedAt
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
  const configuredProject=config.projectPath?loadProject(config.projectPath):undefined;
  const projectRegistry=configuredProject?
    createObsidianRegistry(config.extensionPath?[config.extensionPath]:[]):undefined;
  if(configuredProject&&config.intervalMinutes>0&&config.intervalMinutes<15){
    throw new Error("Scheduled project collection must be at least 15 minutes");
  }
  const initial=new Store(config.db);
  let paused=initial.paused();initial.close();
  let busy=false;
  const scheduler:{lastAttempt:string|null;lastSuccess:string|null;lastFailure:string|null}={
    lastAttempt:null,lastSuccess:null,lastFailure:null
  };
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
      const analysis=config.autoEnrich?await enrich(config.db,config.profile,references(),10,false):null;
      return {result,analysis,export:config.vault?exportToVault(config.db,config.vault):null};
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
  const requireProject=()=>{
    if(!configuredProject||!projectRegistry){
      throw new Error("Configure an explicit project manifest to use the generic engine");
    }
    return {project:configuredProject,registry:projectRegistry};
  };
  const collectProject=async()=>{
    const {project,registry}=requireProject();
    if(paused)throw new Error("Collector is paused");
    if(busy)throw new Error("Collector is busy");
    busy=true;
    try{
      const result=await runProject(config.db,project,registry);
      const exports=project.outputs.length?
        await exportProject(config.db,project,registry,config.vault):null;
      return {result,exports};
    }finally{busy=false;}
  };
  const reassessProject=async()=>{
    const {project,registry}=requireProject();
    if(busy)throw new Error("Collector is busy");
    busy=true;
    try{
      const result=await reprocessProject(config.db,project,registry);
      const exports=project.outputs.length?
        await exportProject(config.db,project,registry,config.vault,{localOnly:true}):null;
      return {result,exports};
    }finally{busy=false;}
  };
  const exportConfiguredProject=async()=>{
    const {project,registry}=requireProject();
    if(busy)throw new Error("Collector is busy");
    busy=true;
    try{return {exports:await exportProject(config.db,project,registry,config.vault)};}
    finally{busy=false;}
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
          const analysis=config.autoEnrich?await enrich(config.db,config.profile,references(),10,false):null;
          json(res,200,{result,analysis,export:config.vault?exportToVault(config.db,config.vault):null});
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
      if(req.method==="POST"&&url.pathname==="/project/sync"){
        json(res,200,await collectProject());return;
      }
      if(req.method==="POST"&&url.pathname==="/project/reprocess"){
        json(res,200,await reassessProject());return;
      }
      if(req.method==="POST"&&url.pathname==="/project/export"){
        json(res,200,await exportConfiguredProject());return;
      }
      if(req.method==="POST"&&url.pathname==="/project/review"){
        if(busy)throw new Error("Collector is busy");
        const input=await body(req);
        const projectId=String(input.projectId||""),key=String(input.key||""),
          decision=String(input.decision||""),reason=input.reason;
        if(!/^[a-z][a-z0-9_-]{1,63}$/.test(projectId)||!key||key.length>1000||
          !["approved","rejected","pending"].includes(decision)||
          typeof reason!=="string"||!reason.trim()||reason.length>1000){
          json(res,400,{error:"Valid project, entity, decision and reason required"});return;
        }
        busy=true;
        try{
          const knowledge=new KnowledgeStore(config.db);
          let reviewed:unknown;
          try{
            reviewed=knowledge.reviewEntity(projectId,key,
              decision as "approved"|"rejected"|"pending",reason);
          }finally{knowledge.close();}
          json(res,200,{entity:reviewed});
        }finally{busy=false;}
        return;
      }
      if(req.method==="GET"&&url.pathname.startsWith("/project/")||req.method==="GET"&&url.pathname==="/projects"){
        const knowledge=new KnowledgeStore(config.db);
        try{
          const projectId=url.searchParams.get("project")||configuredProject?.id||"legacy-x-feed";
          if(!/^[a-z][a-z0-9_-]{1,63}$/.test(projectId)){
            json(res,400,{error:"Invalid project id"});return;
          }
          if(url.pathname==="/projects"){
            json(res,200,knowledge.listProjects());
          }else if(url.pathname==="/project/entity"){
            const key=url.searchParams.get("key")||"";
            if(!key||key.length>1000){
              json(res,400,{error:"Valid entity key required"});
            }else{
              const evidence=knowledge.entityEvidence(projectId,key);
              json(res,evidence?200:404,evidence||{error:"Entity not found"});
            }
          }else if(url.pathname==="/project/entities"){
            json(res,200,knowledge.listEntities(projectId,{
              q:url.searchParams.get("q")||undefined,
              type:url.searchParams.get("type")||undefined,
              limit:Number(url.searchParams.get("limit")||50),
              offset:Number(url.searchParams.get("offset")||0)
            }));
          }else if(url.pathname==="/project/changes"){
            json(res,200,knowledge.listChanges(projectId,{
              limit:Number(url.searchParams.get("limit")||50),
              offset:Number(url.searchParams.get("offset")||0),
              entityKey:url.searchParams.get("key")||undefined
            }));
          }else if(url.pathname==="/project/alerts"){
            json(res,200,knowledge.listAlerts(projectId,
              Number(url.searchParams.get("limit")||50)));
          }else if(url.pathname==="/project/deliveries"){
            json(res,200,getWebhookDeliveryStatus(config.db,projectId,
              url.searchParams.get("output")||undefined));
          }else if(url.pathname==="/project/versions"){
            const key=url.searchParams.get("key")||"";
            if(!key||key.length>1000){
              json(res,400,{error:"Valid entity key required"});
            }else{
              const data=knowledge.listVersions(projectId,key,
                Number(url.searchParams.get("limit")||50));
              json(res,knowledge.getEntity(projectId,key)?200:404,
                data.length||knowledge.getEntity(projectId,key)?data:{error:"Entity not found"});
            }
          }else if(url.pathname==="/project/runs"){
            json(res,200,knowledge.runs(projectId,20));
          }else if(url.pathname==="/project/observations"){
            json(res,200,knowledge.listObservations(projectId,50));
          }else json(res,404,{error:"Not found"});
        }finally{knowledge.close();}
        return;
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
            collectorInput:configuredProject?"project:"+configuredProject.id:source(),
            personalizedXFeedAvailable:false,
            activeProjectId:configuredProject?.id||null,
            readyForManualImport:integrity==="ok",
            readyForScheduledDiscovery:integrity==="ok"&&Boolean(config.feed||configuredProject),
            nextStep:configuredProject?"Inspect /project/runs for connection results":
              config.feed?"Verify the authorized source in /history":
              "Configure a research project, permitted RSS feed, or import observations manually"
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
            personalizedXFeed:"not_available",feedUrl:config.feed||null,
            activeProjectId:configuredProject?.id||null,autoEnrich:Boolean(config.autoEnrich),
            scheduler:{...scheduler,enabled:config.intervalMinutes>0&&Boolean(configuredProject||config.feed||config.fixture),
              intervalMinutes:config.intervalMinutes}});
        }else if(req.method==="GET"&&url.pathname==="/sources"){
          json(res,200,store.listSources(url.searchParams.get("status")||undefined,
            url.searchParams.get("q")||undefined,Number(url.searchParams.get("limit")||100),
            Number(url.searchParams.get("offset")||0)));
        }else if(req.method==="GET"&&url.pathname==="/errors"){
          json(res,200,store.recentErrors(20));
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
  if(config.intervalMinutes>0&&(configuredProject||config.feed||config.fixture)){
    const runScheduled=()=>{
      if(paused||busy||!server.listening)return;
      scheduler.lastAttempt=new Date().toISOString();
      const job=configuredProject?collectProject():collect();
      void job.then(value=>{
        const generic=(value as {result?:{success?:boolean;errors?:number}}).result;
        if(generic?.success===false||(generic?.errors||0)>0){
          const projectRuns=(value as {result?:{runs?:Array<{status:string}>}}).result?.runs||[];
          scheduler.lastFailure=projectRuns.length&&projectRuns.every(run=>
            run.status==="success"||run.status==="partial")?
            "Work budget reached; remaining pages will resume next cycle":
            "Some observations or connections failed; inspect project runs";
        }else{
          scheduler.lastFailure=null;
          scheduler.lastSuccess=new Date().toISOString();
        }
      }).catch(()=>{
        // Errors were recorded in per-connection runs; never echo feed URLs or secrets.
        scheduler.lastFailure="Collection failed; inspect project runs or recent errors";
      });
    };
    const timer=setInterval(runScheduled,config.intervalMinutes*60_000);
    timer.unref();
    // First successful launch should start collecting, not wait a full interval.
    // This is only enabled for an explicitly configured scheduled source.
    server.once("listening",()=>{setImmediate(runScheduled);});
    server.once("close",()=>clearInterval(timer));
  }
  return server;
}
