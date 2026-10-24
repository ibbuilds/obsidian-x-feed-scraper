/**
 * Source Scraper: JSON-first, Obsidian-independent public CLI.
 * Commands emit a single JSON document (or opt-in NDJSON) on stdout.
 * No implicit vault writes, network notifications or external output adapters.
 */
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createDefaultRegistry} from "../../packages/core/extensions.ts";
import {loadProject} from "../../packages/core/project-config.ts";
import {runProject,reprocessProject} from "../../packages/core/engine.ts";
import {KnowledgeStore} from "../../packages/storage/knowledge.ts";
import {demoObservations} from "../../packages/core/demo.ts";
import type {KnowledgeEntity,ProjectDefinition} from "../../packages/sdk/contracts.ts";

declare const __SOURCE_SCRAPER_VERSION__:string;
const version=typeof __SOURCE_SCRAPER_VERSION__==="undefined"?"development":__SOURCE_SCRAPER_VERSION__;
export const DATA_VERSION=1;
type DataSet="entities"|"observations"|"changes"|"alerts";
type Flags=Map<string,string>;
const HELP=[
  "Source Scraper "+version+" — local-first JSON data collection",
  "  source-scraper init [--dir PATH]                   Create an offline JSON demo",
  "  source-scraper validate --config project.json      Validate the project (no network)",
  "  source-scraper run --config project.json [--db DB] Ingest configured sources",
  "  source-scraper projects --db DB                   List stored projects",
  "  source-scraper query --config project.json [--dataset entities|observations|changes|alerts]",
  "  source-scraper inspect --config project.json --key ENTITY_KEY",
  "  source-scraper review --config project.json --key KEY --decision approved --reason TEXT",
  "  source-scraper reprocess --config project.json     Reevaluate retained data offline",
  "  source-scraper export --config project.json [--dataset entities|observations|changes|alerts]",
  "      [--format json|ndjson] [--out FILE] [--limit N] [--offset N]",
  "  source-scraper adapters                         List installed SDK adapters",
  "  source-scraper version",
  "",
  "Defaults: a .source-scraper.sqlite database next to --config; exports go to stdout.",
  "Use --db FILE and --id PROJECT when querying without --config.",
  "Use --extension /absolute/path/trusted.cjs explicitly to load trusted code.",
  "No Obsidian installation, GUI, X session or network account is required."
].join("\n");
const COMMAND_FLAGS:Record<string,string[]>={
  init:["dir"],validate:["config","extension"],run:["config","db","extension","page-size","max-pages"],
  projects:["db","config"],query:["db","config","id","dataset","limit","offset","search","type","min-score"],
  inspect:["db","config","id","key"],review:["db","config","id","key","decision","reason"],
  reprocess:["db","config","extension"],export:["db","config","id","dataset","format","out","limit","offset","compact"],
  adapters:["extension"],version:[]
};
function argumentsToFlags(args:readonly string[],allowed:readonly string[]):Flags{
  const result=new Map<string,string>(), valid=new Set(allowed);
  for(let i=0;i<args.length;i++){
    const raw=args[i];
    if(!raw.startsWith("--"))throw new Error("Unexpected positional argument: "+raw);
    const eq=raw.indexOf("=");
    const name=raw.slice(2,eq===-1?undefined:eq),inline=eq===-1?undefined:raw.slice(eq+1);
    if(!valid.has(name))throw new Error("Unknown option --"+name);
    if(result.has(name))throw new Error("Duplicate option --"+name);
    const value=inline??args[++i];
    if(value===undefined||!value||value.startsWith("--"))throw new Error("Missing --"+name+" value");
    result.set(name,value);
  }
  return result;
}
function required(flags:Flags,name:string):string{
  const raw=flags.get(name);
  if(!raw)throw new Error("Missing --"+name);
  return raw;
}
function integer(flags:Flags,name:string,fallback:number,min:number,max:number):number{
  const raw=flags.get(name);
  if(raw===undefined)return fallback;
  if(!/^(0|[1-9][0-9]*)$/.test(raw))throw new Error("Invalid --"+name);
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error("Invalid --"+name);
  return value;
}
function output(value:unknown):void{process.stdout.write(JSON.stringify(value)+"\n");}
function projectContext(flags:Flags,needed:boolean):{id:string;db:string;project?:ProjectDefinition}{
  const file=flags.get("config"), project=file?loadProject(resolve(file)):undefined;
  if(needed&&!project)throw new Error("--config is required");
  const id=flags.get("id")||project?.id||"";
  if(!id&&!needed)throw new Error("--id or --config is required");
  if(project&&flags.get("id")&&flags.get("id")!==project.id){
    throw new Error("Project ID disagrees with --config");
  }
  const db=resolve(flags.get("db")||(file?join(dirname(resolve(file)),".source-scraper.sqlite"):
    "./.source-scraper.sqlite"));
  return {id,db,project};
}
function openExisting(db:string):KnowledgeStore{
  if(!existsSync(db))throw new Error("No database at the selected path. Run the project first.");
  return new KnowledgeStore(db);
}
function toDataset(value:string|undefined):DataSet{
  const name=value||"entities";
  if(!["entities","observations","changes","alerts"].includes(name)){
    throw new Error("Invalid --dataset; choose entities, observations, changes or alerts");
  }
  return name as DataSet;
}
function observe(store:KnowledgeStore,id:string,limit:number,offset:number):Array<Record<string,unknown>>{
  const rows=store.db.prepare("SELECT connection_id,item_id,observation_json,type,title,text,url,"+
    "attributes_json,media_json,occurred_at,first_seen,last_seen FROM kb_observations "+
    "WHERE project_id=? ORDER BY connection_id,item_id LIMIT ? OFFSET ?")
    .all(id,limit,offset) as Array<Record<string,unknown>>;
  return rows.map(row=>({
    connectionId:String(row.connection_id),itemId:String(row.item_id),
    firstSeen:String(row.first_seen),lastSeen:String(row.last_seen),
    // Migration cannot reconstruct optional fields never recorded originally.
    // Null means the complete snapshot is genuinely unavailable.
    observation:typeof row.observation_json==="string"?JSON.parse(row.observation_json):null,
    ...(row.observation_json===null?{legacyKnownFields:{
      type:row.type,title:row.title,text:row.text,url:row.url,
      attributes:JSON.parse(String(row.attributes_json)),
      media:JSON.parse(String(row.media_json)),occurredAt:row.occurred_at
    }}:{})
  }));
}
function readPage(store:KnowledgeStore,projectId:string,dataset:DataSet,
  limit:number,offset:number,flags:Flags):unknown[]{
  if(dataset==="observations")return observe(store,projectId,limit,offset);
  if(dataset==="changes")return store.listChanges(projectId,{limit,offset});
  if(dataset==="alerts"){
    // Stable numeric IDs; limit/offset works for alert exports as well.
    const rows=store.db.prepare("SELECT a.id,a.change_id,a.entity_key,a.rule_id,a.explanation,a.detected_at,"+
      "c.path,c.before_json,c.after_json FROM kb_watch_alerts a "+
      "JOIN kb_entity_changes c ON c.id=a.change_id WHERE a.project_id=? "+
      "ORDER BY a.id DESC LIMIT ? OFFSET ?").all(projectId,limit,offset) as Array<Record<string,unknown>>;
    return rows.map(row=>({id:Number(row.id),entityKey:String(row.entity_key),changeId:Number(row.change_id),
      ruleId:String(row.rule_id),explanation:String(row.explanation),detectedAt:String(row.detected_at),
      path:String(row.path),before:row.before_json===null?null:JSON.parse(String(row.before_json)),
      after:row.after_json===null?null:JSON.parse(String(row.after_json))}));
  }
  return store.listEntities(projectId,{
    limit,offset,q:flags.get("search"),type:flags.get("type"),
    minScore:integer(flags,"min-score",0,0,100)
  });
}
function exportedEntity(store:KnowledgeStore,id:string,entity:KnowledgeEntity,compact:boolean):unknown{
  if(compact)return entity;
  const detail=store.entityEvidence(id,entity.key);
  if(!detail)throw new Error("Entity disappeared during export");
  return {...entity,provenance:{
    mentions:detail.mentions,reviews:detail.reviews,assessmentHistory:detail.assessments,
    mentionsTruncated:entity.observationCount>detail.mentions.length
  }};
}
function exportRecords(store:KnowledgeStore,id:string,dataset:DataSet,flags:Flags,
  limit:number,offset:number,compact:boolean):unknown[]{
  const values:unknown[]=[];
  let remaining=limit,current=offset;
  while(remaining>0){
    const count=Math.min(500,remaining);
    const page=readPage(store,id,dataset,count,current,flags);
    for(const item of page){
      values.push(dataset==="entities"?exportedEntity(store,id,item as KnowledgeEntity,compact):item);
    }
    current+=page.length;remaining-=page.length;
    if(page.length<count)break;
  }
  return values;
}
function ensureSafeFile(path:string,contents:string):void{
  // No silent overwrite: a repeated export must name another file.
  writeFileSync(resolve(path),contents,{flag:"wx",mode:0o600});
}
function init(dir:string):void{
  const root=resolve(dir),manifest=join(root,"project.json"),input=join(root,"observations.json");
  if(existsSync(manifest)||existsSync(input)){
    throw new Error("Starter files already exist; refusing to overwrite");
  }
  mkdirSync(root,{recursive:true,mode:0o700});
  const definition={
    id:"starter-project",name:"Source Scraper offline starter",
    sources:[{id:"local-observations",adapter:"json-snapshot",config:{
      path:"./observations.json",entityNamespace:"local-observations"
    }}],
    pipeline:["linked-resources","observation-entity"],evaluator:"keyword",
    policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]
  };
  writeFileSync(manifest,JSON.stringify(definition,null,2)+"\n",{flag:"wx",mode:0o600});
  writeFileSync(input,JSON.stringify(demoObservations(),null,2)+"\n",{flag:"wx",mode:0o600});
  output({schemaVersion:DATA_VERSION,command:"init",projectFile:manifest,
    observationsFile:input,databasePath:join(root,".source-scraper.sqlite"),synthetic:true});
}
async function execute(command:string,flags:Flags):Promise<void>{
  if(command==="version"){output({name:"source-scraper",version,jsonSchemaVersion:DATA_VERSION});return;}
  if(command==="init"){init(flags.get("dir")||"./source-scraper-project");return;}
  if(command==="adapters"){
    const r=createDefaultRegistry(flags.get("extension")?[resolve(required(flags,"extension"))]:[]);
    output({schemaVersion:DATA_VERSION,sources:[...r.sources.keys()].sort(),
      processors:[...r.processors.keys()].sort(),evaluators:[...r.evaluators.keys()].sort(),
      outputs:[...r.outputs.keys()].sort(),note:"Obsidian output is optional; no GUI is required"});
    return;
  }
  if(command==="validate"||command==="run"||command==="reprocess"){
    const {id,db,project}=projectContext(flags,true);
    if(!project)throw new Error("Missing project");
    // Validation must be side-effect-free and never load executable third-party extensions.
    if(command==="validate"){
      output({schemaVersion:DATA_VERSION,command,id,name:project.name,
        sourceAdapters:project.sources.map(source=>source.adapter),
        pipeline:project.pipeline,evaluator:project.evaluator,
        outputs:project.outputs.map(item=>item.adapter),valid:true});
      return;
    }
    const registry=createDefaultRegistry(flags.get("extension")?[resolve(required(flags,"extension"))]:[]);
    if(command==="run"){
      const result=await runProject(db,project,registry,{
        pageSize:integer(flags,"page-size",100,1,500),
        maxPages:integer(flags,"max-pages",100,1,1000)
      });
      output({schemaVersion:DATA_VERSION,command,id,result});
      if(!result.success)process.exitCode=1;
    }else{
      if(!existsSync(db))throw new Error("No database at the selected path. Run the project first.");
      const result=await reprocessProject(db,project,registry);
      output({schemaVersion:DATA_VERSION,command,id,result});
    }
    return;
  }
  if(command==="projects"){
    const db=resolve(flags.get("db")||(flags.get("config")?
      join(dirname(resolve(required(flags,"config"))),".source-scraper.sqlite"):"./.source-scraper.sqlite"));
    const store=openExisting(db);
    try{output({schemaVersion:DATA_VERSION,command,projects:store.listProjects()});}
    finally{store.close();}
    return;
  }
  const {id,db}=projectContext(flags,false);
  const store=openExisting(db);
  try{
    if(!store.listProjects().some(row=>row.id===id)){
      throw new Error("Project not found in database: "+id);
    }
    if(command==="inspect"){
      const data=store.entityEvidence(id,required(flags,"key"));
      if(!data)throw new Error("Entity not found");
      output({schemaVersion:DATA_VERSION,command,id,...data});
    }else if(command==="review"){
      const decision=required(flags,"decision");
      if(!["approved","rejected","pending"].includes(decision))throw new Error("Invalid --decision");
      const result=store.reviewEntity(id,required(flags,"key"),
        decision as "approved"|"rejected"|"pending",required(flags,"reason"));
      output({schemaVersion:DATA_VERSION,command,id,entity:result});
    }else if(command==="query"||command==="export"){
      const dataset=toDataset(flags.get("dataset"));
      const limit=integer(flags,"limit",command==="query"?100:100000,1,command==="query"?500:100000);
      const offset=integer(flags,"offset",0,0,1000000);
      if(command==="query"){
        const records=readPage(store,id,dataset,limit,offset,flags);
        output({schemaVersion:DATA_VERSION,command,dataset,projectId:id,limit,offset,
          count:records.length,records});
        return;
      }
      const format=flags.get("format")||"json";
      if(!["json","ndjson"].includes(format))throw new Error("Invalid --format");
      const compact=flags.get("compact")===undefined?false:
        ["true","false"].includes(flags.get("compact")!)?flags.get("compact")==="true":
        (()=>{throw new Error("--compact must be true or false");})();
      const records=exportRecords(store,id,dataset,flags,limit,offset,compact);
      const emitted= format==="json"?JSON.stringify({
        schemaVersion:DATA_VERSION,dataset,projectId:id,exportedAt:new Date().toISOString(),
        limit,offset,count:records.length,records
      },null,2)+"\n":records.map(record=>JSON.stringify({
        schemaVersion:DATA_VERSION,dataset,projectId:id,record
      })).join("\n")+(records.length?"\n":"");
      if(flags.get("out")){
        const path=resolve(required(flags,"out"));
        ensureSafeFile(path,emitted);
        output({schemaVersion:DATA_VERSION,command,dataset,projectId:id,
          format,path,count:records.length});
      }else process.stdout.write(emitted);
    }else throw new Error("Unknown command");
  }finally{store.close();}
}
function safeError(error:unknown):string{
  const message=error instanceof Error?error.message:String(error);
  return message.replace(/https?:\/\/[^\s'"<>]+/gi,"[redacted-url]")
    .replace(/(?:token|password|secret|cookie|session|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"[redacted]").slice(0,400);
}
export async function main(argv:readonly string[]=process.argv.slice(2)):Promise<void>{
  const command=argv[0]||"help";
  if(["help","--help","-h"].includes(command)){process.stdout.write(HELP+"\n");return;}
  if(!(command in COMMAND_FLAGS))throw new Error("Unknown command: "+command+". Use --help");
  const flags=argumentsToFlags(argv.slice(1),COMMAND_FLAGS[command]);
  await execute(command,flags);
}
if(process.argv[1]&&realpathSync(resolve(fileURLToPath(import.meta.url)))===realpathSync(resolve(process.argv[1]))){
  main().catch(error=>{process.stderr.write("source-scraper: "+safeError(error)+"\n");process.exitCode=1;});
}
