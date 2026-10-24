import {isAbsolute,resolve} from "node:path";
import {normalizeUrl} from "./url.ts";
import {normalizeKeywords,parseProject} from "./project-config.ts";
import {parseMcpMapping} from "../adapters/mcp-mapping.ts";
import type {ProjectDefinition,JsonRecord} from "../sdk/contracts.ts";

/** Validated input for first-run project creation; no Obsidian dependencies. */
export interface ProjectSetup {
  id:string;name:string;
  sourceType:"demo"|"rss"|"json-file"|"json-snapshot"|"public-json"|"public-product"|"mcp-stdio";
  sourceUrl?:string;sourcePath?:string;sourceUrls?:string;
  jsonMapping?:unknown;
  demoPath?:string;
  mcpCommand?:string;mcpArgs?:string[];mcpTool?:string;
  mcpMapping?:unknown;
  mcpProtocol?:"auto"|"modern"|"legacy";
  includeKeywords?:string;excludeKeywords?:string;
  mode:"linked-resources"|"extract-links"|"observation-entity";
  publicMetadata?:boolean;
  minimumScore?:number;
  outputFolder?:string;
  watchMode?:"none"|"created"|"changed"|"decrease-percent"|"increase-percent"|"equals";
  watchPath?:string;watchThreshold?:number;watchValue?:string;
}
function terms(raw:string|undefined):string[]{
  if(raw===undefined||raw.trim()==="")return [];
  return normalizeKeywords(raw.split(/[,\n]/g),"research terms");
}
function required(value:string|undefined,label:string,max=3000):string {
  if(!value?.trim()||value.length>max)throw new Error("Enter a valid "+label);
  return value.trim();
}
export function buildProject(setup:ProjectSetup):ProjectDefinition{
  const policy={includeKeywords:terms(setup.includeKeywords),
    excludeKeywords:terms(setup.excludeKeywords),
    minimumScore:setup.minimumScore??25};
  let adapter:string,config:JsonRecord;
  if(setup.sourceType==="rss"){
    adapter="rss";
    config={url:normalizeUrl(required(setup.sourceUrl,"public RSS URL"))};
    if(config.url&&typeof config.url==="string"&&
      ["x.com","www.x.com","twitter.com","www.twitter.com"].includes(new URL(config.url).hostname)){
      throw new Error("X is not an authorized RSS source");
    }
  }else if(["json-file","json-snapshot","demo"].includes(setup.sourceType)){
    adapter=setup.sourceType==="json-snapshot"?"json-snapshot":"json-file";
    const raw=required(setup.sourceType==="demo"?setup.demoPath:setup.sourcePath,"local JSON file");
    if(!isAbsolute(raw))throw new Error("Local JSON file path must be absolute");
    config={path:resolve(raw)};
  }else if(setup.sourceType==="public-json"){
    adapter="public-json";
    const url=normalizeUrl(required(setup.sourceUrl,"public JSON API URL"));
    if(new URL(url).protocol!=="https:")throw new Error("Public JSON requires HTTPS");
    if(!setup.jsonMapping||typeof setup.jsonMapping!=="object"||
      Array.isArray(setup.jsonMapping))throw new Error("Public JSON API requires a field mapping");
    const fields=parseMcpMapping({
      ...setup.jsonMapping as Record<string,unknown>,
      hasMorePath:"ignoredHasMore",nextCursorPath:"ignoredCursor"
    });
    if(!fields)throw new Error("Invalid public JSON mapping");
    config={url,mapping:JSON.parse(JSON.stringify(fields)) as JsonRecord};
  }else if(setup.sourceType==="public-product"){
    adapter="public-product";
    const urls=(setup.sourceUrls||"").split(/[\n,]/g).map(s=>s.trim()).filter(Boolean);
    if(!urls.length||urls.length>100)throw new Error("Enter 1–100 public product URLs");
    const unique=[...new Set(urls.map(value=>normalizeUrl(value)))];
    if(unique.some(url=>new URL(url).protocol!=="https:")){
      throw new Error("Public product monitoring requires HTTPS URLs");
    }
    config={urls:unique};
  }else if(setup.sourceType==="mcp-stdio"){
    adapter="mcp-stdio";
    const command=required(setup.mcpCommand,"trusted MCP command",1000);
    if(command!=="node"&&!isAbsolute(command))throw new Error(
      "MCP executable must be an absolute path or 'node'");
    const tool=required(setup.mcpTool,"MCP tool name",128);
    if(!/^[A-Za-z0-9_.-]+$/.test(tool))throw new Error("MCP tool name is invalid");
    const args=setup.mcpArgs||[];
    if(args.length>30||args.some(a=>typeof a!=="string"||a.length>4096)){
      throw new Error("Invalid MCP command arguments");
    }
    const mapping=setup.mcpMapping===undefined?undefined:parseMcpMapping(setup.mcpMapping);
    config={command,args,tool,protocol:setup.mcpProtocol||"auto",
      ...(mapping?{mapping:JSON.parse(JSON.stringify(mapping)) as JsonRecord}:{})};
  }else throw new Error("Unsupported research source");
  if(setup.mode==="observation-entity")config.entityNamespace="primary-source";
  if(setup.publicMetadata&&setup.mode==="observation-entity"){
    throw new Error("Public metadata requires a link-extraction processor");
  }
  const outputFolder=setup.outputFolder||"Discovery Engine";
  if(outputFolder.length>64||
    !/^[\p{L}\p{N} _-]{1,64}$/u.test(outputFolder)||outputFolder==="."||outputFolder===".."){
    throw new Error("Invalid Obsidian output folder");
  }
  const watchRules:Array<Record<string,unknown>>=[];
  const watchMode=setup.watchMode||"none";
  if(watchMode!=="none"){
    const field=setup.watchPath||"/attributes/price";
    const rule:Record<string,unknown>={
      id:"user-watch",path:watchMode==="created"?"$":field,
      operator:watchMode
    };
    if(watchMode==="decrease-percent"||watchMode==="increase-percent"){
      rule.threshold=setup.watchThreshold??10;
      if(field==="/attributes/price"){
        rule.requireUnchanged=["/attributes/currency"];
      }
    }
    if(watchMode==="equals")rule.value=setup.watchValue||"";
    watchRules.push(rule);
  }
  return parseProject({
    id:setup.id,name:setup.name,
    sources:[{id:"primary-source",adapter,config}],
    pipeline:[setup.mode,...(setup.publicMetadata?["public-metadata"]:[])],
    evaluator:"keyword",policy,
    ...(watchRules.length?{watch:{rules:watchRules}}:{}),
    outputs:[{id:"obsidian-library",adapter:"obsidian",config:{folder:outputFolder}}]
  });
}

export {demoObservations} from "./demo.ts";
