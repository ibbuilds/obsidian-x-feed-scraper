import {resolve,dirname} from "node:path";
import {createDefaultRegistry} from "../../packages/core/extensions.ts";
import {loadProject} from "../../packages/core/project-config.ts";
import {runProject,reprocessProject} from "../../packages/core/engine.ts";
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
function normalizePaths(project:ProjectDefinition,path:string):ProjectDefinition{
  // Local JSON fixture paths are relative to the project manifest, not a shell's cwd.
  for(const source of project.sources){
    if(source.adapter==="json-file"&&typeof source.config.path==="string"){
      source.config.path=resolve(dirname(path),source.config.path);
    }
  }
  return project;
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
  const project=path?normalizePaths(loadProject(resolve(path)),resolve(path)):undefined;
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
    const store=new KnowledgeStore(db);
    const all=store.listEntities(project.id,{limit:500});
    // Stream pages rather than assume that every project fits in a single SQL query.
    for(let offset=500;;offset+=500){
      const page=store.listEntities(project.id,{limit:500,offset});
      if(!page.length)break;
      all.push(...page);
    }
    store.close();
    const records=all.filter(item=>item.review!=="rejected"&&item.score>=project.policy.minimumScore);
    if(!project.outputs.length){output({entities:records.length,records});return;}
    for(const selected of project.outputs){
      const extension=registry.outputs.get(selected.adapter);
      if(!extension)throw new Error("Output not registered: "+selected.adapter);
      const result=await extension.export({project,records,config:selected.config,databasePath:db,
        vaultPath:opt(args,"vault")});
      output({output:selected.id,result});
    }
  }else throw new Error("Unknown project command\n"+HELP);
}
