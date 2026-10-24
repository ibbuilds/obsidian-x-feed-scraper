import {acquireLock} from "./lock.ts";
import {KnowledgeStore} from "../storage/knowledge.ts";
import type {ProjectDefinition,Registry} from "../sdk/contracts.ts";

/** Export only user-configured destinations, never touch the original References.md. */
export async function exportProject(dbPath:string,project:ProjectDefinition,
  registry:Registry,vaultPath?:string,options:{localOnly?:boolean}={}):Promise<Array<{output:string;result:unknown}>>{
  const release=acquireLock(dbPath+".lock");
  let store:KnowledgeStore|undefined;
  try{
    store=new KnowledgeStore(dbPath);
    const records=store.listEntities(project.id,{limit:500});
    for(let offset=500;;offset+=500){
      const page=store.listEntities(project.id,{limit:500,offset});
      if(!page.length)break;
      records.push(...page);
    }
    const filtered=records.filter(item=>
      item.review!=="rejected"&&item.score>=project.policy.minimumScore);
    // Store is closed before adapters run, but the process-wide collector lock
    // remains held through all filesystem writes.
    store.close();store=undefined;
    const results:Array<{output:string;result:unknown}>=[];
    for(const output of project.outputs){
      const adapter=registry.outputs.get(output.adapter);
      if(!adapter)throw new Error("Output adapter not registered: "+output.adapter);
      if(options.localOnly&&adapter.offline!==true){
        results.push({output:output.id,result:{skipped:true,reason:"Explicit export required for this output"}});
        continue;
      }
      const result=await adapter.export({
        project,outputId:output.id,records:filtered,config:output.config,databasePath:dbPath,vaultPath
      });
      results.push({output:output.id,result});
    }
    return results;
  }finally{
    try{store?.close();}finally{release();}
  }
}
