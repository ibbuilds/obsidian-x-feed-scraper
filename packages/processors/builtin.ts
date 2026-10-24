import {normalizeUrl,isXUrl} from "../core/url.ts";
import {fetchPublicMetadata} from "../connectors/metadata.ts";
import {entityNamespace,normalizeKeywords} from "../core/project-config.ts";
import type {Extension,EntityDraft,Observation,Processor,Evaluator} from "../sdk/contracts.ts";

function candidates(observation:Observation):string[]{
  const found=new Set<string>();
  for(const candidate of [observation.url,...(observation.urls||[])]){
    if(!candidate)continue;
    try{found.add(normalizeUrl(candidate));}catch{/* Skip unusable URLs. */}
  }
  for(const match of (observation.text||"").matchAll(/https?:\/\/[^\s<>"']+/gi)){
    try{found.add(normalizeUrl(match[0].replace(/[),.;!?\]}]+$/,"")));}catch{}
    if(found.size>=100)break;
  }
  return [...found].slice(0,100);
}
function asWebResource(url:string):EntityDraft{
  const parsed=new URL(url);
  const slug=parsed.pathname.split("/").filter(Boolean).pop()||parsed.hostname;
  let readable=slug;
  try{readable=decodeURIComponent(slug);}catch{/* Keep URL-encoded slug. */}
  const label=readable.replace(/[-_]/g," ").slice(0,200);
  return {key:url,type:"web-resource",url,title:label,
    evidence:[{signal:"observed-url",detail:"Observed directly in the source item",confidence:1}]};
}
const links:Processor={
  id:"extract-links",
  run(_context,observation,previous){
    return [...previous,...candidates(observation).map(asWebResource)];
  }
};
/**
 * Discovery-oriented extractor: the original post/document is evidence, not
 * automatically a resource. All other observed links can become entities.
 */
const linked:Processor={
  id:"linked-resources",
  run(_context,observation,previous){
    const original=observation.url?normalizeUrl(observation.url):null;
    return [...previous,...candidates(observation).filter(url=>url!==original).map(asWebResource)];
  }
};
// The metadata stage is explicitly opt-in in project.pipeline. It shares the
// already hardened public HTTP client and never reads authenticated X content.
const metadataSessions=new WeakMap<AbortSignal,{count:number;cache:Map<string,
  Awaited<ReturnType<typeof fetchPublicMetadata>>|null>}>();
const metadata:Processor={
  id:"public-metadata",
  async run(context,_observation,previous){
    let state=metadataSessions.get(context.signal);
    if(!state){state={count:0,cache:new Map()};metadataSessions.set(context.signal,state);}
    const updated:EntityDraft[]=[];
    for(const draft of previous){
      if(!draft.url||isXUrl(draft.url)||new URL(draft.url).hostname==="t.co"){
        updated.push(draft);continue;
      }
      let result=state.cache.get(draft.url);
      if(result===undefined){
        if(state.count>=20){updated.push(draft);continue;}
        state.count++;
        try{result=await fetchPublicMetadata(draft.url);}
        catch{result=null;}
        state.cache.set(draft.url,result);
      }
      if(!result){
        updated.push({...draft,evidence:[...(draft.evidence||[]),
          {signal:"metadata-unavailable",detail:"Public metadata could not be verified"}]});
        continue;
      }
      const info=result.metadata;
      updated.push({
        ...draft,
        key:normalizeUrl(result.url),
        url:normalizeUrl(result.url),
        title:info.title||draft.title,
        attributes:{...(draft.attributes||{}),
          ...(info.description?{description:info.description}:{}),
          ...(info.license?{license:info.license}:{}),
          ...(info.access?{access:info.access}:{}),
          ...(info.contentType?{contentType:info.contentType}:{})},
        evidence:[...(draft.evidence||[]),
          ...(info.title?[{signal:"public-title",detail:"Public page title returned",confidence:0.9}]:[]),
          ...(info.license?[{signal:"license",detail:"Public license metadata: "+info.license,confidence:0.95}]:[])]
      });
    }
    return updated;
  }
};
const self:Processor={
  id:"observation-entity",
  run(context,observation,previous){
    const namespace=entityNamespace(context.source.config.entityNamespace);
    // Namespace and type cannot contain ':'. The remainder is the full local
    // ID, including any delimiters; '@' cannot begin a legacy type:id key.
    const key=(namespace===undefined?"":"@"+namespace+":")+observation.type+":"+observation.id;
    return [...previous,{key,type:observation.type,
      title:observation.title||observation.id,url:observation.url,
      attributes:observation.attributes,
      evidence:[{signal:"source-observation",detail:"Recorded by the configured adapter",confidence:1}]}];
  }
};
interface CompiledKeywordTerms {
  includeSource:string[];
  excludeSource:string[];
  include:string[];
  includeLower:string[];
  excludeLower:string[];
}
function sameTerms(values:readonly string[],saved:readonly string[]):boolean{
  if(values.length!==saved.length)return false;
  for(let i=0;i<values.length;i++)if(values[i]!==saved[i])return false;
  return true;
}
/**
 * Normalize and lowercase keywords once per policy revision and collection.
 * A cheap primitive-element comparison catches even in-place edits to arrays
 * while avoiding repeated JSON stringification and deduplication. No cache
 * outlives its run signal.
 */
const keywordTermsByRun=new WeakMap<AbortSignal,WeakMap<object,CompiledKeywordTerms>>();
function compiledKeywords(signal:AbortSignal,policy:{
  includeKeywords:string[];excludeKeywords:string[]
}):CompiledKeywordTerms{
  let policies=keywordTermsByRun.get(signal);
  if(!policies){policies=new WeakMap();keywordTermsByRun.set(signal,policies);}
  const prior=policies.get(policy);
  if(prior&&Array.isArray(policy.includeKeywords)&&Array.isArray(policy.excludeKeywords)&&
    sameTerms(policy.includeKeywords,prior.includeSource)&&
    sameTerms(policy.excludeKeywords,prior.excludeSource))return prior;
  // Always validate a changed policy, including malformed runtime SDK inputs.
  const include=normalizeKeywords(policy.includeKeywords,"include keywords");
  const exclude=normalizeKeywords(policy.excludeKeywords,"exclude keywords");
  const terms={includeSource:policy.includeKeywords.slice(),
    excludeSource:policy.excludeKeywords.slice(),include,
    includeLower:include.map(x=>x.toLowerCase()),
    excludeLower:exclude.map(x=>x.toLowerCase())};
  policies.set(policy,terms);
  return terms;
}
const keyword:Evaluator={
  id:"keyword",
  assess({project,signal},observation,entity){
    // SDK callers may edit a policy in place: signature invalidation keeps the
    // same observable assessment and invalid-input behavior after every edit.
    const {include,excludeLower,includeLower}=compiledKeywords(signal,project.policy);
    const corpus=[observation.title||"",observation.text||"",entity.title,
      JSON.stringify(entity.attributes||{})].join(" ").toLowerCase();
    if(excludeLower.some(term=>corpus.includes(term))){
      return {category:"excluded",score:0,confidence:0.9,reasons:["Explicit exclusion term matched"]};
    }
    const matched=include.filter((_,i)=>corpus.includes(includeLower[i]));
    const hasCriteria=include.length>0;
    const base=hasCriteria?0:50;
    const description=typeof entity.attributes?.description==="string"?
      entity.attributes.description:"";
    const licensed=typeof entity.attributes?.license==="string"&&
      entity.attributes.license.length>0;
    const score=Math.min(100,base+matched.length*25+(description.length>=60?15:0)+
      (licensed?8:0));
    const reasons=matched.length?["Matched project keywords: "+matched.slice(0,8).join(", ")]:
      [hasCriteria?"No positive project keywords matched":"No positive filter defined"];
    // Confidence measures the amount of source evidence, not inferred desirability.
    const confidence=Math.min(0.95,Number((0.25+(entity.url?0.2:0)+
      (observation.title?0.15:0)+(entity.evidence?.length?0.15:0)+
      (description.length>=60?0.1:0)+(licensed?0.1:0)).toFixed(2)));
    return {category:matched[0]||entity.type,score,confidence,reasons};
  }
};
export const builtinProcessing:Extension={apiVersion:1,
  processors:[links,linked,self,metadata],evaluators:[keyword]};
