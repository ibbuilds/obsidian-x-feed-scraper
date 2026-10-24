import {acquireLock} from "./lock.ts";
import {validateObservation,validateEntity,validateAssessment} from "./project-config.ts";
import {KnowledgeStore} from "../storage/knowledge.ts";
import type {Registry,ProjectDefinition,EntityDraft,Observation,Assessment,KnowledgeEntity} from "../sdk/contracts.ts";

export interface SourceRun {
  sourceId:string;runId:string;status:"success"|"failed";
  observations:number;newEntities:number;duplicates:number;error?:string;
}
export interface ProjectRun {
  projectId:string;runs:SourceRun[];observations:number;newEntities:number;duplicates:number;
  success:boolean;
}
function summarize(error:unknown):string {
  const message=error instanceof Error?error.message:String(error);
  return message.replace(/https?:\/\/[^\s'"<>]+/gi,"[redacted-url]")
    .replace(/(?:token|password|secret|cookie|session|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"[redacted]").slice(0,240);
}
function assertRegistered(project:ProjectDefinition,registry:Registry):void{
  for(const source of project.sources){
    if(!registry.sources.has(source.adapter))throw new Error("Adapter not registered: "+source.adapter);
  }
  for(const step of project.pipeline){
    if(!registry.processors.has(step))throw new Error("Processor not registered: "+step);
  }
  if(!registry.evaluators.has(project.evaluator))throw new Error("Evaluator not registered: "+project.evaluator);
}
async function processItem(project:ProjectDefinition,source:ProjectDefinition["sources"][number],
  observation:Observation,registry:Registry,signal:AbortSignal):
  Promise<Array<{draft:EntityDraft;assessment:Assessment}>>{
  const context={project,source,signal};
  let drafts:EntityDraft[]=[];
  for(const step of project.pipeline){
    const processor=registry.processors.get(step)!;
    drafts=await processor.run(context,observation,drafts);
    if(!Array.isArray(drafts)||drafts.length>250)throw new Error("Processor output exceeds 250 entities");
    drafts=drafts.map(draft=>validateEntity(draft,project.entitySchemas));
  }
  const unique=new Map<string,EntityDraft>();
  for(const draft of drafts){
    const previous=unique.get(draft.key);
    if(previous&&previous.type!==draft.type)throw new Error("Incompatible entity types for the same identity");
    if(previous){
      previous.evidence=[...(previous.evidence||[]),...(draft.evidence||[])].slice(0,40);
      previous.attributes={...(previous.attributes||{}),...(draft.attributes||{})};
    }else unique.set(draft.key,draft);
  }
  const results:Array<{draft:EntityDraft;assessment:Assessment}>=[];
  for(const draft of unique.values()){
    const assessment=validateAssessment(await registry.evaluators.get(project.evaluator)!.assess(context,observation,draft));
    results.push({draft,assessment});
  }
  return results;
}
/**
 * Single-writer autonomous collection. Each fetched page and its cursor are
 * committed together. A failed page never advances its checkpoint; later runs
 * resume from the last committed page.
 */
export async function runProject(dbPath:string,project:ProjectDefinition,registry:Registry,opts:{
  signal?:AbortSignal;pageSize?:number;maxPages?:number
}={}):Promise<ProjectRun>{
  assertRegistered(project,registry);
  const pageSize=opts.pageSize??100,maxPages=opts.maxPages??100;
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>500||
    !Number.isInteger(maxPages)||maxPages<1||maxPages>1000)throw new Error("Invalid execution page bounds");
  const signal=opts.signal??new AbortController().signal;
  const release=acquireLock(dbPath+".lock");
  let store:KnowledgeStore|undefined;
  const result:ProjectRun={projectId:project.id,runs:[],observations:0,newEntities:0,duplicates:0,success:true};
  try{
    store=new KnowledgeStore(dbPath);
    store.saveProject(project);
    for(const source of project.sources){
      let runId="";
      const stats:SourceRun={sourceId:source.id,runId:"",status:"success",
        observations:0,newEntities:0,duplicates:0};
      try{
        if(signal.aborted)throw new Error("Processing aborted");
        runId=store.beginRun(project.id,source.id);
        stats.runId=runId;
        let cursor=store.cursor(project.id,source.id);
        const seenCursors=new Set<string>();
        let finished=false;
        for(let pageNo=0;pageNo<maxPages;pageNo++){
          if(signal.aborted)throw new Error("Processing aborted");
          if(cursor!==undefined){
            if(seenCursors.has(cursor))throw new Error("Connector repeated a cursor");
            seenCursors.add(cursor);
          }
          const page=await registry.sources.get(source.adapter)!.collect({
            source,cursor,limit:pageSize,signal
          });
          if(!page||!Array.isArray(page.observations)||page.observations.length>pageSize){
            throw new Error("Adapter returned invalid page size");
          }
          if(typeof page.hasMore!=="boolean"||
            (page.hasMore&&(!page.nextCursor||page.nextCursor===cursor))){
            throw new Error("Adapter pagination contract violated");
          }
          const processed:Array<{observation:Observation;entities:Array<{
            draft:EntityDraft;assessment:Assessment
          }>}>=[];
          for(const raw of page.observations){
            const observation=validateObservation(raw);
            const entities=await processItem(project,source,observation,registry,signal);
            processed.push({observation,entities});
          }
          // A page that fails during processing never enters this transaction.
          const committed=store.saveBatch(project.id,source,processed,page.nextCursor,project.evaluator);
          stats.observations+=committed.observations;
          stats.newEntities+=committed.newEntities;
          stats.duplicates+=committed.duplicates;
          cursor=page.nextCursor;
          if(!page.hasMore){finished=true;break;}
        }
        if(!finished)throw new Error("Maximum page count reached; cursor saved for continuation");
        store.finishRun(runId,"success",stats);
      }catch(error){
        stats.status="failed";
        stats.error=summarize(error);
        result.success=false;
        if(runId)store.finishRun(runId,"failed",stats,stats.error);
      }
      result.runs.push(stats);
      result.observations+=stats.observations;
      result.newEntities+=stats.newEntities;
      result.duplicates+=stats.duplicates;
    }
    return result;
  }finally{
    try{store?.close();}finally{release();}
  }
}
/** Re-evaluate already persisted observations when criteria change: zero connector requests. */
export async function reprocessProject(dbPath:string,project:ProjectDefinition,registry:Registry,
  signal:AbortSignal=new AbortController().signal):Promise<{entities:number;reassessed:number}>{
  assertRegistered(project,registry);
  const release=acquireLock(dbPath+".lock");
  let store:KnowledgeStore|undefined;
  const counters={entities:0,reassessed:0};
  try{
    store=new KnowledgeStore(dbPath);
    store.saveProject(project);
    const entities=store.db.prepare(
      "SELECT entity_key,type,title,url,attributes_json FROM kb_entities WHERE project_id=?"
    ).all(project.id) as Array<{entity_key:string;type:string;title:string;url:string|null;attributes_json:string}>;
    for(const entity of entities){
      if(signal.aborted)throw new Error("Reprocessing aborted");
      counters.entities++;
      const observations=store.db.prepare(
        "SELECT o.connection_id,o.item_id,o.type,o.title,o.text,o.url,o.attributes_json,o.media_json,o.occurred_at "+
        "FROM kb_mentions m JOIN kb_observations o ON o.project_id=m.project_id "+
        "AND o.connection_id=m.connection_id AND o.item_id=m.item_id "+
        "WHERE m.project_id=? AND m.entity_key=?"
      ).all(project.id,entity.entity_key) as Array<Record<string,unknown>>;
      const draft=validateEntity({key:entity.entity_key,type:entity.type,title:entity.title,
        url:entity.url||undefined,attributes:JSON.parse(entity.attributes_json)},project.entitySchemas);
      let best:Assessment|undefined;
      for(const row of observations){
        const source=project.sources.find(s=>s.id===row.connection_id);
        if(!source)continue;
        const observation=validateObservation({id:row.item_id,type:row.type,
          title:row.title||undefined,text:row.text||undefined,url:row.url||undefined,
          attributes:JSON.parse(String(row.attributes_json||"{}")),
          media:JSON.parse(String(row.media_json||"[]")),
          occurredAt:row.occurred_at||undefined});
        const assessment=validateAssessment(await registry.evaluators.get(project.evaluator)!.assess(
          {project,source,signal},observation,draft));
        if(!best||assessment.score>best.score)best=assessment;
      }
      if(best){store.updateAssessment(project.id,entity.entity_key,best,project.evaluator);counters.reassessed++;}
    }
    return counters;
  }finally{try{store?.close();}finally{release();}}
}
export function listKnowledge(dbPath:string,projectId:string,options:{
  limit?:number;offset?:number;q?:string;type?:string;minScore?:number
}={}):KnowledgeEntity[]{
  const store=new KnowledgeStore(dbPath);
  try{return store.listEntities(projectId,options);}finally{store.close();}
}
