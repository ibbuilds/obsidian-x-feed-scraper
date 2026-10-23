import {createServer} from "node:http";
import {timingSafeEqual} from "node:crypto";
import type {IncomingMessage, ServerResponse} from "node:http";
import {readFixture} from "../../packages/connectors/fixtures.ts";
import {ingest,referencesFromFile} from "../../packages/core/pipeline.ts";
import {exportToVault} from "../../packages/core/obsidian.ts";
import {Store} from "../../packages/storage/store.ts";
import type {Profile} from "../../packages/core/types.ts";
import {join} from "node:path";
import {existsSync} from "node:fs";

export interface ServerOptions {
  db: string;
  profile: Profile;
  fixture?: string;
  vault?: string;
  references?: string;
  token: string;
  port: number;
  intervalMinutes: number;
}
function json(res:ServerResponse,status:number,body:unknown):void {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "x-content-type-options":"nosniff"});
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string,unknown>> {
  let content="";
  for await(const chunk of req) {
    content+=chunk.toString();
    if (content.length>8192) throw new Error("Request body too large");
  }
  if (!content) return {};
  const obj:unknown=JSON.parse(content);
  if (!obj || typeof obj!=="object" || Array.isArray(obj)) throw new Error("Invalid request");
  return obj as Record<string,unknown>;
}
export function startServer(config:ServerOptions):ReturnType<typeof createServer> {
  if (config.token.length<24) throw new Error("Set XFS_API_TOKEN to a random token of at least 24 characters");
  if (!Number.isInteger(config.port)||config.port<1024||config.port>65535) throw new Error("Invalid local port");
  let paused=false;
  let busy=false;
  const refs=()=>referencesFromFile(config.references || (config.vault && existsSync(join(config.vault,"References.md")) ? join(config.vault,"References.md") : undefined));
  const sync=()=>{
    if (paused) throw new Error("Collector paused");
    if (!config.fixture) throw new Error("No authorized connector configured; pass --fixture for demo input");
    if (busy) throw new Error("Synchronization already in progress");
    busy=true;
    try {
      const result=ingest(config.db,readFixture(config.fixture),config.profile,"fixture",refs());
      return {result,export:config.vault ? exportToVault(config.db,config.vault) : null};
    } finally {busy=false;}
  };
  const server=createServer(async(req,res)=>{
    try {
      if (req.headers.origin) {json(res,403,{error:"Cross-origin requests are not allowed"});return;}
      const auth=Buffer.from(req.headers.authorization || "");
      const expected=Buffer.from("Bearer "+config.token);
      if (auth.length!==expected.length || !timingSafeEqual(auth,expected)) {
        json(res,401,{error:"Unauthorized"});return;
      }
      const url=new URL(req.url || "/", "http://127.0.0.1");
      const store=new Store(config.db);
      try {
        if (req.method==="GET" && url.pathname==="/status") {
          json(res,200,{...store.stats(),active:busy,paused,connectedSource:config.fixture?"fixture":"none"});
        } else if (req.method==="GET" && url.pathname==="/sources") {
          const status=url.searchParams.get("status")||undefined;
          const search=url.searchParams.get("q")||undefined;
          json(res,200,store.listSources(status,search,100));
        } else if (req.method==="GET" && url.pathname==="/posts") {
          json(res,200,store.listPosts(100));
        } else if (req.method==="GET" && url.pathname==="/history") {
          json(res,200,store.history());
        } else if (req.method==="POST" && url.pathname==="/sync") {
          store.close();
          json(res,200,sync());
          return;
        } else if (req.method==="POST" && url.pathname==="/pause") {
          paused=true;json(res,200,{paused});
        } else if (req.method==="POST" && url.pathname==="/resume") {
          paused=false;json(res,200,{paused});
        } else if (req.method==="POST" && url.pathname==="/review") {
          const value=await body(req);
          const id=Number(value.id);
          const decision=value.decision;
          if (!Number.isSafeInteger(id)||id<1 || !["approved","rejected","needs_review","excellent"].includes(String(decision)) ||
              typeof value.reason!=="string") {json(res,400,{error:"Invalid review"});return;}
          const source=store.review(id,decision as "approved"|"rejected"|"needs_review"|"excellent",value.reason);
          json(res,200,{source,export:config.vault?exportToVault(config.db,config.vault):null});
        } else {json(res,404,{error:"Not found"});}
      } finally {
        // The sync route closes its store before entering the collector.
        try {store.close();} catch {}
      }
    } catch(e) {
      json(res,400,{error:e instanceof Error?e.message:"Request failed"});
    }
  });
  // Always listen on loopback, never 0.0.0.0.
  server.listen(config.port,"127.0.0.1");
  if (config.intervalMinutes>0) {
    const timer=setInterval(()=>{if (!paused && !busy && config.fixture) {try{sync();}catch{ /* inspect /history */ }}},
      Math.max(1,config.intervalMinutes)*60_000);
    timer.unref();
    server.on("close",()=>clearInterval(timer));
  }
  return server;
}
