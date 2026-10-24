import {normalizeUrl} from "../core/url.ts";
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
const links:Processor={
  id:"extract-links",
  run(_context,observation,previous){
    const added:EntityDraft[]=candidates(observation).map(url=>{
      const parsed=new URL(url);
      const label=decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop()||parsed.hostname)
        .replace(/[-_]/g," ").slice(0,200);
      return {key:url,type:"web-resource",url,title:label,
        evidence:[{signal:"observed-url",detail:"Observed directly in the source item",confidence:1}]};
    });
    return [...previous,...added];
  }
};
const self:Processor={
  id:"observation-entity",
  run(_context,observation,previous){
    return [...previous,{key:observation.type+":"+observation.id,type:observation.type,
      title:observation.title||observation.id,url:observation.url,
      attributes:observation.attributes,
      evidence:[{signal:"source-observation",detail:"Recorded by the configured adapter",confidence:1}]}];
  }
};
const keyword:Evaluator={
  id:"keyword",
  assess({project},observation,entity){
    const corpus=[observation.title||"",observation.text||"",entity.title,
      JSON.stringify(entity.attributes||{})].join(" ").toLowerCase();
    const negative=project.policy.excludeKeywords.filter(word=>corpus.includes(word.toLowerCase()));
    if(negative.length){
      return {category:"excluded",score:0,confidence:0.9,reasons:["Explicit exclusion term matched"]};
    }
    const matched=project.policy.includeKeywords.filter(word=>corpus.includes(word.toLowerCase()));
    const hasCriteria=project.policy.includeKeywords.length>0;
    const base=hasCriteria?0:50;
    const score=Math.min(100,base+matched.length*25);
    const reasons=matched.length?["Matched project keywords: "+matched.slice(0,8).join(", ")]:
      [hasCriteria?"No positive project keywords matched":"No positive filter defined"];
    // Confidence measures the amount of source evidence, not inferred desirability.
    const confidence=Math.min(0.95,Number((0.25+(entity.url?0.2:0)+
      (observation.title?0.15:0)+(entity.evidence?.length?0.15:0)).toFixed(2)));
    return {category:matched[0]||entity.type,score,confidence,reasons};
  }
};
export const builtinProcessing:Extension={apiVersion:1,processors:[links,self],evaluators:[keyword]};
