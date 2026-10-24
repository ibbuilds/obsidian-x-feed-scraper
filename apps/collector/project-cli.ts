import {resolve} from "node:path";
import {createDefaultRegistry} from "../../packages/core/extensions.ts";
import {loadProject} from "../../packages/core/project-config.ts";
import {runProject,reprocessProject} from "../../packages/core/engine.ts";
import {exportProject} from "../../packages/core/export-project.ts";
import {KnowledgeStore} from "../../packages/storage/knowledge.ts";
import type {ProjectDefinition} from "../../packages/sdk/contracts.ts";

function opt(args:string[],name:string):string|undefined{
  const i=args.indexOf("--"+name);
  return i<0?undefined:args[i+1];
}
function required(args:string[],name:string):string{
  const raw=opt(args,name);
  if(!raw||raw.startsWith("--"))throw new Error("Missing --"+name);
  return raw;
}
function number(args:string[],name:string,defaultValue:number):number{
  const value=opt(args,name);
  if(value===undefined)return defaultValue;
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0)throw new Error("Invalid --"+name);
  return n;
}
export async function projectCommand(args:string[]):Promise<void>{
  const action=args[1]||"help";
  const HELP=[
    "Project engine (independent of X and Obsidian)",
    "  project sync --project examples/frontend/project.json [--db ./data/library.db]",
    "  project list --db ./data/library.db",
    "  project entities --id frontend-discovery --db ./data/library.db [--limit 100 --offset 0]",
    "  project review --id frontend-discovery --key <entity-key> --decision approved --reason useful",
    "  project reprocess --project FILE --db FILE (no network requests)",
    "  project export --project FILE --db FILE [--vault /your/vault]",
    "  project reset-cursor --id PROJECT --connection CONNECTION --db FILE",
    "  Options: --extension /trusted/local/plugin.cjs --page-size 100 --max-pages 100"
  ].join("\n");
  if(action==="help"||action==="--help"){console.log(HELP);return;}
  const db=resolve(opt(args,"db")||process.env.XFS_DB||"./data/x-feed.db");
  const path=opt(args,"project");
  const project=path?loadProject(resolve(path)):undefined;
  const extensions=opt(args,"extension")?[resolve(opt(args,"extension")!)]:[];
  const registry=createDefaultRegistry(extensions);
  const output=(value:unknown)=>console.log(JSON.stringify(value,null,2));
  if(action==="sync"){
    if(!project)throw new Error("--project is required");
    const result=await runProject(db,project,registry,{
      pageSize:number(args,"page-size",100),maxPages:number(args,"max-pages",100)
    });
    output(result);
    if(!result.success)process.exitCode=1;
  }else if(action==="reprocess"){
    if(!project)throw new Error("--project is required");
    output(await reprocessProject(db,project,registry));
  }else if(action==="list"){
    const store=new KnowledgeStore(db);
    try{output(store.listProjects());}finally{store.close();}
  }else if(action==="entities"){
    const store=new KnowledgeStore(db);
    try{output(store.listEntities(required(args,"id"),{
      limit:number(args,"limit",100),offset:number(args,"offset",0),
      type:opt(args,"type"),q:opt(args,"search")
    }));}finally{store.close();}
  }else if(action==="review"){
    const store=new KnowledgeStore(db);
    try{
      const decision=required(args,"decision");
      if(!["approved","rejected","pending"].includes(decision))throw new Error("Invalid decision");
      output(store.reviewEntity(required(args,"id"),required(args,"key"),
        decision as "approved"|"rejected"|"pending",required(args,"reason")));
    }finally{store.close();}
  }else if(action==="reset-cursor"){
    const store=new KnowledgeStore(db);
    try{store.resetCursor(required(args,"id"),required(args,"connection"));output({reset:true});}
    finally{store.close();}
  }else if(action==="export"){
    if(!project)throw new Error("--project is required");
    output(await exportProject(db,project,registry,opt(args,"vault")));
  }else throw new Error("Unknown project command\n"+HELP);
}
