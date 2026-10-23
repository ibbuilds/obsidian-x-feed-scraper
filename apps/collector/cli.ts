#!/usr/bin/env node
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {readFixture} from "../../packages/connectors/fixtures.ts";
import {fetchRSS} from "../../packages/connectors/rss.ts";
import {loadProfile} from "../../packages/core/profile.ts";
import {ingest,enrich,referencesFromFile} from "../../packages/core/pipeline.ts";
import {exportToVault} from "../../packages/core/obsidian.ts";
import {Store} from "../../packages/storage/store.ts";
import {startServer} from "./server.ts";

const args=process.argv.slice(2);
function option(name:string):string|undefined {
  const inline=args.find(arg=>arg.startsWith("--"+name+"="));
  if(inline)return inline.slice(name.length+3);
  const i=args.indexOf("--"+name);
  return i>=0?args[i+1]:undefined;
}
function required(name:string):string {
  const v=option(name);if(!v||v.startsWith("--"))throw new Error("Missing --"+name);
  return v;
}
function show(value:unknown):void {console.log(JSON.stringify(value,null,2));}
const HELP=[
  "Obsidian X Feed Scraper — local discovery engine (Node 22.16+)",
  "  sync --feed https://example.org/feed.xml [--vault /vault]",
  "  sync --fixture tests/fixtures/posts.json     [demo only]",
  "  serve --feed https://example.org/feed.xml --interval 60 --port 0",
  "  sources [--status needs_review] [--search motion] | posts | status | history",
  "  enrich --limit 10 | export --vault /vault | recommendations | report",
  "  review --id 1 --decision approved --reason 'Useful source'",
  "  Options: --db FILE --profile JSON --threshold 75 --confidence 0.65 --prefer-free true",
  "Personalized X For You feed is NOT accessible via the existing connectors."
].join("\n");
async function main():Promise<void>{
  const command=args[0]||"help";
  if(["help","--help","-h"].includes(command)){console.log(HELP);return;}
  const db=resolve(option("db")||process.env.XFS_DB||"./data/x-feed.db");
  const vault=option("vault")||process.env.XFS_VAULT;
  const refsPath=option("references")||
    (vault&&existsSync(join(vault,"References.md"))?join(vault,"References.md"):undefined);
  const profile=loadProfile(resolve(option("profile")||process.env.XFS_PROFILE||"./profiles/design.json"));
  if(option("threshold")!==undefined){
    profile.scoreThreshold=Number(option("threshold"));
    if(!Number.isInteger(profile.scoreThreshold)||profile.scoreThreshold<0||profile.scoreThreshold>100)throw new Error("Invalid threshold");
  }
  if(option("confidence")!==undefined){
    profile.confidenceThreshold=Number(option("confidence"));
    if(!Number.isFinite(profile.confidenceThreshold)||profile.confidenceThreshold<0||profile.confidenceThreshold>1)throw new Error("Invalid confidence");
  }
  if(option("prefer-free")!==undefined){
    if(!["true","false"].includes(option("prefer-free")!))throw new Error("prefer-free must be true or false");
    profile.preferFree=option("prefer-free")==="true";
  }
  const fixture=option("fixture"),feed=option("feed");
  if(fixture&&feed)throw new Error("Specify either --feed or --fixture, not both");
  const refs=()=>referencesFromFile(refsPath);
  if(command==="sync"){
    if(!fixture&&!feed)throw new Error("Set --feed or --fixture");
    const posts=feed?await fetchRSS(feed):readFixture(resolve(fixture!));
    const connector=feed?"rss:"+createHash("sha256").update(feed).digest("hex").slice(0,16):"fixture";
    const result=ingest(db,posts,profile,connector,refs());
    show({result,export:vault?exportToVault(db,vault):null});
  }else if(command==="enrich"){
    show(await enrich(db,profile,refs(),Number(option("limit")||10)));
    if(vault)show({export:exportToVault(db,vault)});
  }else if(command==="export"){
    if(!vault)throw new Error("--vault is required");
    show(exportToVault(db,vault));
  }else if(command==="serve"){
    const port=Number(option("port")??47321),intervalMinutes=Number(option("interval")??0);
    const server=startServer({db,profile,feed,fixture,vault,references:refsPath,
      token:process.env.XFS_API_TOKEN||"",port,intervalMinutes});
    server.on("listening",()=>{
      const address=server.address();
      const actual=address&&typeof address!=="string"?address.port:port;
      console.log("XFS_READY_PORT="+actual);
    });
    server.on("error",e=>{console.error("Collector service failed: "+e.message);process.exitCode=1;});
    if(option("managed")==="true"){
      process.stdin.on("end",()=>server.close(()=>process.exit(0)));
      process.stdin.resume();
    }
    process.on("SIGINT",()=>server.close(()=>process.exit(0)));
    process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
  }else{
    const store=new Store(db);
    try{
      if(command==="status")show(store.stats());
      else if(command==="sources")show(store.listSources(option("status"),option("search"),Number(option("limit")||100)));
      else if(command==="posts")show(store.listPosts());
      else if(command==="history")show(store.history());
      else if(command==="recommendations")show(store.recommendations());
      else if(command==="report")show({stats:store.stats(),candidates:store.listSources(undefined,undefined,25),
        recommendations:store.recommendations(10)});
      else if(command==="review"){
        const decision=required("decision");
        if(!["approved","rejected","needs_review","excellent"].includes(decision))throw new Error("Invalid review");
        show(store.review(Number(required("id")),decision as "approved"|"rejected"|"needs_review"|"excellent",required("reason")));
      }else throw new Error("Unknown command: "+command+"\n"+HELP);
    }finally{store.close();}
    if(command==="review"&&vault)show({export:exportToVault(db,vault)});
  }
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
