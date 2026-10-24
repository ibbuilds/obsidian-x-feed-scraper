import type {Observation} from "../sdk/contracts.ts";

export interface McpResultMapping {
  itemsPath:string;
  idPath:string;
  type:string;
  nextCursorPath:string;
  hasMorePath:string;
  titlePath?:string;
  textPath?:string;
  urlPath?:string;
  urlsPath?:string;
  mediaPath?:string;
  occurredAtPath?:string;
  attributes:Record<string,string>;
}
function obj(x:unknown):Record<string,unknown>{
  if(!x||typeof x!=="object"||Array.isArray(x))throw new Error("Invalid MCP result mapping");
  return x as Record<string,unknown>;
}
function validPath(x:unknown,name:string):string{
  if(typeof x!=="string"||x.length>180||
    !/^[A-Za-z_0-9-]+(?:\.[A-Za-z_0-9-]+){0,7}$/.test(x)||
    x.split(".").some(segment=>["__proto__","prototype","constructor"].includes(segment))){
    throw new Error("Invalid MCP field path: "+name);
  }
  return x;
}
function optionalPath(x:unknown,name:string):string|undefined{
  return x===undefined?undefined:validPath(x,name);
}
export function parseMcpMapping(raw:unknown):McpResultMapping|undefined{
  if(raw===undefined)return undefined;
  const x=obj(raw);
  const type=x.type;
  if(typeof type!=="string"||!(/^[a-z][a-z0-9_-]{1,63}$/.test(type))){
    throw new Error("MCP field mapping requires a normalized observation type");
  }
  const attributes:Record<string,string>={};
  if(x.attributes!==undefined){
    const source=obj(x.attributes);
    if(Object.keys(source).length>30)throw new Error("MCP mapping has too many attribute fields");
    for(const [key,value] of Object.entries(source)){
      if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)||
        ["__proto__","prototype","constructor"].includes(key)){
        throw new Error("Invalid MCP mapped attribute name");
      }
      attributes[key]=validPath(value,"attributes."+key);
    }
  }
  return {
    type,itemsPath:validPath(x.itemsPath,"itemsPath"),idPath:validPath(x.idPath,"idPath"),
    hasMorePath:validPath(x.hasMorePath,"hasMorePath"),
    nextCursorPath:validPath(x.nextCursorPath,"nextCursorPath"),
    titlePath:optionalPath(x.titlePath,"titlePath"),
    textPath:optionalPath(x.textPath,"textPath"),
    urlPath:optionalPath(x.urlPath,"urlPath"),
    urlsPath:optionalPath(x.urlsPath,"urlsPath"),
    mediaPath:optionalPath(x.mediaPath,"mediaPath"),
    occurredAtPath:optionalPath(x.occurredAtPath,"occurredAtPath"),
    attributes
  };
}
export function mcpField(root:unknown,path:string):unknown{
  let current:unknown=root;
  for(const segment of path.split(".")){
    if(!current||typeof current!=="object")return undefined;
    if(!Object.prototype.hasOwnProperty.call(current,segment))return undefined;
    current=(current as Record<string,unknown>)[segment];
  }
  return current;
}
function textField(root:unknown,path?:string):string|undefined{
  if(!path)return undefined;
  const value=mcpField(root,path);
  if(value===undefined||value===null)return undefined;
  if(typeof value==="string")return value;
  if(typeof value==="number"&&Number.isFinite(value))return String(value);
  throw new Error("Mapped MCP text field must be a string or number");
}
function linkList(root:unknown,path?:string):string[]|undefined{
  if(!path)return undefined;
  const value=mcpField(root,path);
  if(value===undefined||value===null)return undefined;
  if(typeof value==="string")return [value];
  if(Array.isArray(value)&&value.length<=100&&value.every(item=>typeof item==="string")){
    return value as string[];
  }
  throw new Error("Mapped MCP links must be strings");
}
/** Declarative mapping lets existing MCP tools feed the engine without JS glue. */
export function mapMcpToolResult(raw:unknown,mapping:McpResultMapping):{
  observations:Observation[];hasMore:unknown;nextCursor:unknown
}{
  const items=mcpField(raw,mapping.itemsPath);
  if(!Array.isArray(items))throw new Error("Mapped MCP items path is not an array");
  if(items.length>500)throw new Error("Mapped MCP item page exceeds 500 records");
  const observations:Observation[]=items.map(item=>{
    const id=textField(item,mapping.idPath);
    if(!id)throw new Error("Mapped MCP record has no stable ID");
    const attrs:Record<string,unknown>={};
    for(const [name,path] of Object.entries(mapping.attributes)){
      const value=mcpField(item,path);
      if(value!==undefined)attrs[name]=value;
    }
    return {
      id,type:mapping.type,
      title:textField(item,mapping.titlePath),
      text:textField(item,mapping.textPath),
      url:textField(item,mapping.urlPath),
      urls:linkList(item,mapping.urlsPath),
      media:linkList(item,mapping.mediaPath),
      occurredAt:textField(item,mapping.occurredAtPath),
      attributes:attrs as Observation["attributes"]
    };
  });
  return {
    observations,
    hasMore:mcpField(raw,mapping.hasMorePath),
    nextCursor:mcpField(raw,mapping.nextCursorPath)
  };
}
