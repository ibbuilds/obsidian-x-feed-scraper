import {readFileSync} from "node:fs";
import {acquireLock} from "./lock.ts";
import {normalizeUrl,extractUrls,isXUrl} from "./url.ts";
import {evaluate} from "../quality/evaluate.ts";
import {fetchPublicMetadata} from "../connectors/metadata.ts";
import {Store} from "../storage/store.ts";
import type {Post,Profile} from "./types.ts";

export function importReferences(markdown: string): Set<string> {
  const result = new Set<string>();
  for (const match of markdown.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    try {result.add(normalizeUrl(match[0].replace(/[.,;]+$/,"")));}
    catch { /* Not a web reference. */ }
  }
  return result;
}
export function referencesFromFile(file?:string): Set<string> {
  if (!file) return new Set();
  return importReferences(readFileSync(file,"utf8"));
}
export function deriveTitle(url: string):string {
  const value = new URL(url);
  const name = value.pathname.split("/").filter(Boolean).pop() || value.hostname;
  return decodeURIComponent(name).replace(/[-_]/g," ").slice(0,160);
}
export interface Result {runId:string;posts:number;newSources:number;duplicates:number;errors:number;visualOnly:number}
export function ingest(dbPath: string, posts: Post[], profile: Profile, connector = "fixture", references: ReadonlySet<string> = new Set()): Result {
  const release=acquireLock(dbPath+".lock");
  let store: Store | undefined;
  let runId = "";
  const result:Result = {runId:"",posts:0,newSources:0,duplicates:0,errors:0,visualOnly:0};
  try {
    store=new Store(dbPath);
    runId = store.begin(connector);result.runId=runId;
    for (const post of posts) {
      store.db.exec("SAVEPOINT item");
      try {
        const fresh = store.savePost(runId,connector,post);
        result.posts++;
        if (!fresh) result.duplicates++;
        const urls = extractUrls(post);
        if (!urls.length && post.images?.length) result.visualOnly++;
        for (const url of urls) {
          const title = deriveTitle(url);
          const evalResult = evaluate(url,title,post.text+" "+(post.quotedText || ""),{},profile,references);
          const added = store.addSource(connector,post.id,url,title,evalResult);
          if (added.fresh) result.newSources++;
          else result.duplicates++;
        }
        store.markProcessed(connector,post.id);
        store.db.exec("RELEASE SAVEPOINT item");
      } catch (e) {
        store.db.exec("ROLLBACK TO SAVEPOINT item; RELEASE SAVEPOINT item");
        result.errors++;
        store.error(runId,post.id,e instanceof Error?e.message:"Unknown per-post error");
      }
    }
    store.finish(runId,result.errors?"partial":"success",result.posts,result.newSources,result.duplicates);
    return result;
  } catch (e) {
    if (runId && store) store.finish(runId,"failed",result.posts,result.newSources,result.duplicates,e instanceof Error?e.message:"unknown");
    throw e;
  } finally {
    try{store?.close();}finally{release();}
  }
}
export async function enrich(dbPath:string,profile:Profile,references:ReadonlySet<string>,limit=20):
  Promise<{checked:number;updated:number;failed:number}> {
  const release=acquireLock(dbPath+".lock");
  let store:Store|undefined;
  const results={checked:0,updated:0,failed:0};
  let runId="";
  try {
    store=new Store(dbPath);
    runId=store.begin("metadata");
    const pending=store.pendingForEnrichment(limit);
    for(const source of pending){
      results.checked++;
      try {
        const {url:canonical,metadata}=await fetchPublicMetadata(source.url);
        if(isXUrl(canonical))throw new Error("Resolved to X, not an external resource");
        const canonicalId=store.repointSource(source.id,normalizeUrl(canonical));
        const old=store.getMetadata(canonicalId);
        const evaluation=evaluate(normalizeUrl(canonical),metadata.title||old.title||"",old.context,metadata,profile,references);
        const boost=store.preferenceBoost(evaluation.category);
        evaluation.score=Math.max(0,Math.min(100,evaluation.score+boost));
        if(evaluation.score>=profile.scoreThreshold&&evaluation.confidence>=profile.confidenceThreshold){
          evaluation.status="high_quality";
        }
        store.updateEvaluation(canonicalId,metadata,evaluation);
        results.updated++;
      }catch(error){
        results.failed++;
        const message=error instanceof Error?error.message:"Unknown metadata failure";
        store.error(runId,String(source.id),message.replace(/https?:\/\/\S+/g,"[redacted-url]").slice(0,200));
      }
    }
    store.finish(runId,results.failed?"partial":"success",results.checked,0,0);
    return results;
  }catch(error){
    if(store&&runId){
      store.finish(runId,"failed",results.checked,0,0,"Metadata run aborted");
    }
    throw error;
  }finally{
    try{store?.close();}finally{release();}
  }
}
