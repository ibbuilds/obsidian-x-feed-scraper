import {isAbsolute,resolve} from "node:path";
import {normalizeUrl} from "./url.ts";
import {parseProject} from "./project-config.ts";
import {parseMcpMapping} from "../adapters/mcp-mapping.ts";
import type {ProjectDefinition,JsonRecord} from "../sdk/contracts.ts";

/** Validated input for first-run project creation; no Obsidian dependencies. */
export interface ProjectSetup {
  id:string;name:string;
  sourceType:"demo"|"rss"|"json-file"|"mcp-stdio";
  sourceUrl?:string;sourcePath?:string;
  demoPath?:string;
  mcpCommand?:string;mcpArgs?:string[];mcpTool?:string;
  mcpMapping?:unknown;
  mcpProtocol?:"auto"|"modern"|"legacy";
  includeKeywords?:string;excludeKeywords?:string;
  mode:"linked-resources"|"extract-links"|"observation-entity";
  publicMetadata?:boolean;
  minimumScore?:number;
  outputFolder?:string;
}
function terms(raw:string|undefined):string[]{
  const items=(raw||"").split(/[,\n]/g).map(part=>part.trim()).filter(Boolean);
  if(items.length>60||items.some(x=>x.length>100))throw new Error(
    "Enter at most 60 research terms, each at most 100 characters");
  return [...new Set(items)];
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
  }else if(setup.sourceType==="json-file"||setup.sourceType==="demo"){
    adapter="json-file";
    const raw=required(setup.sourceType==="demo"?setup.demoPath:setup.sourcePath,"local JSON file");
    if(!isAbsolute(raw))throw new Error("Local JSON file path must be absolute");
    config={path:resolve(raw)};
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
  if(setup.publicMetadata&&setup.mode==="observation-entity"){
    throw new Error("Public metadata requires a link-extraction processor");
  }
  const outputFolder=setup.outputFolder||"Discovery Engine";
  if(outputFolder.length>64||
    !/^[\p{L}\p{N} _-]{1,64}$/u.test(outputFolder)||outputFolder==="."||outputFolder===".."){
    throw new Error("Invalid Obsidian output folder");
  }
  return parseProject({
    id:setup.id,name:setup.name,
    sources:[{id:"primary-source",adapter,config}],
    pipeline:[setup.mode,...(setup.publicMetadata?["public-metadata"]:[])],
    evaluator:"keyword",policy,
    outputs:[{id:"obsidian-library",adapter:"obsidian",config:{folder:outputFolder}}]
  });
}
/** Offline synthetic observations shipped at first use, never fetched from X. */
export function demoObservations():Array<{
  id:string;type:string;title:string;text:string;url?:string;urls?:string[];
  attributes:Record<string,string>
}>{
  return [
    {id:"demo-motion-1",type:"community-post",
      title:"Reusable motion components for interfaces",
      text:"Public sample about interface components and animation",
      url:"https://example.org/posts/motion-1",
      urls:["https://github.com/example/motion-kit"],
      attributes:{author:"synthetic-demo"}},
    {id:"demo-motion-2",type:"community-post",
      title:"A second useful mention of the same motion library",
      text:"Independent observation about UI and motion",
      url:"https://example.org/posts/motion-2",
      urls:["https://github.com/example/motion-kit"],
      attributes:{author:"synthetic-demo"}},
    {id:"demo-research-3",type:"research-note",
      title:"Scientific observation without a web link",
      text:"A sample note demonstrating source-independent research",
      attributes:{domain:"research-demo"}}
  ];
}
