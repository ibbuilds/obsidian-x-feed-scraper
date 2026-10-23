#!/usr/bin/env node
import {resolve,join} from "node:path";
import {existsSync} from "node:fs";
import {readFixture} from "../../packages/connectors/fixtures.ts";
import {loadProfile} from "../../packages/core/profile.ts";
import {ingest,enrich,referencesFromFile} from "../../packages/core/pipeline.ts";
import {exportToVault} from "../../packages/core/obsidian.ts";
import {Store} from "../../packages/storage/store.ts";
import {startServer} from "./server.ts";

function option(name:string):string|undefined {
  const args=process.argv.slice(2);
  const inline=args.find(arg=>arg.startsWith("--"+name+"="));
  if (inline) return inline.slice(name.length+3);
  const index=args.indexOf("--"+name);
  return index>=0 ? args[index+1] : undefined;
}
function required(name:string):string {
  const value=option(name);
  if (!value || value.startsWith("--")) throw new Error("Missing --"+name);
  return value;
}
function show(value:unknown):void {console.log(JSON.stringify(value,null,2));}
const HELP=[
  "X Feed Scraper (local-first, Node 22.16+)",
  "  sync --fixture tests/fixtures/posts.json [--vault /path/to/vault]",
  "  status | sources [--status needs_review] [--search motion] | posts | history",
  "  review --id 1 --decision approved --reason 'Useful original resource'",
  "  enrich --limit 20           Explicit opt-in network metadata fetch",
  "  export --vault /path/to/vault",
  "  serve --fixture tests/fixtures/posts.json --port 47321 --interval 0",
  "Options: --db ./data/x-feed.db --profile ./profiles/design.json --references /path/References.md",
  "Live X 'For you' access is NOT implemented or implied by fixture mode."
].join("\n");
async function main():Promise<void> {
  const command=process.argv[2] || "help";
  if (command==="help"||command==="--help") {console.log(HELP);return;}
  const db=resolve(option("db") || process.env.XFS_DB || "./data/x-feed.db");
  const vault=option("vault") || process.env.XFS_VAULT;
  const refsPath=option("references") || (vault && existsSync(join(vault,"References.md")) ? join(vault,"References.md") : undefined);
  const profile=loadProfile(resolve(option("profile") || process.env.XFS_PROFILE || "./profiles/design.json"));
  if (command==="sync") {
    const file=required("fixture");
    const result=ingest(db,readFixture(resolve(file)),profile,"fixture",referencesFromFile(refsPath));
    show({result,export:vault?exportToVault(db,vault):null});
  } else if (command==="enrich") {
    show(await enrich(db,profile,referencesFromFile(refsPath),Number(option("limit")||20)));
    if (vault) show({export:exportToVault(db,vault)});
  } else if (command==="export") {
    if (!vault) throw new Error("--vault is required");
    show(exportToVault(db,vault));
  } else if (command==="serve") {
    const port=Number(option("port")||47321);
    const intervalMinutes=Number(option("interval")||0);
    const token=process.env.XFS_API_TOKEN || "";
    const server=startServer({db,profile,fixture:option("fixture"),vault,references:refsPath,token,port,intervalMinutes});
    console.log("Collector listening at http://127.0.0.1:"+port+"; authentication required");
    process.on("SIGINT",()=>server.close(()=>process.exit(0)));
    process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
  } else {
    const store=new Store(db);
    try {
      if (command==="status") show(store.stats());
      else if (command==="sources") show(store.listSources(option("status"),option("search"),Number(option("limit")||100)));
      else if (command==="posts") show(store.listPosts());
      else if (command==="history") show(store.history());
      else if (command==="review") {
        const decision=required("decision");
        if (!["approved","rejected","needs_review","excellent"].includes(decision)) throw new Error("Invalid decision");
        show(store.review(Number(required("id")),decision as "approved"|"rejected"|"needs_review"|"excellent",required("reason")));
      } else throw new Error("Unknown command: "+command+"\n"+HELP);
    } finally {store.close();}
    if (command==="review"&&vault) show({export:exportToVault(db,vault)});
  }
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
