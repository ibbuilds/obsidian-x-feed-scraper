import type {Registry,Extension,SourceAdapter,Processor,Evaluator,OutputAdapter} from "../sdk/contracts.ts";
export function registry():Registry{
  return {sources:new Map(),processors:new Map(),evaluators:new Map(),outputs:new Map()};
}
function add<T extends {id:string}>(map:Map<string,T>,item:T):void{
  if(!item||typeof item.id!=="string"||!(/^[a-z][a-z0-9_-]{1,63}$/.test(item.id)))throw new Error("Invalid extension id");
  if(map.has(item.id))throw new Error("Duplicate extension id: "+item.id);
  map.set(item.id,item);
}
export function registerExtension(target:Registry,extension:Extension):void{
  if(!extension||extension.apiVersion!==1)throw new Error("Unsupported extension API version");
  for(const item of extension.adapters||[]){
    if(typeof item.collect!=="function")throw new Error("Source adapter must implement collect");
    add<SourceAdapter>(target.sources,item);
  }
  for(const item of extension.processors||[]){
    if(typeof item.run!=="function")throw new Error("Processor must implement run");
    add<Processor>(target.processors,item);
  }
  for(const item of extension.evaluators||[]){
    if(typeof item.assess!=="function")throw new Error("Evaluator must implement assess");
    add<Evaluator>(target.evaluators,item);
  }
  for(const item of extension.outputs||[]){
    if(typeof item.export!=="function")throw new Error("Output adapter must implement export");
    add<OutputAdapter>(target.outputs,item);
  }
}
