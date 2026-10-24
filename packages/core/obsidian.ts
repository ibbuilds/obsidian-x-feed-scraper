import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {ensureVaultPath} from "./vault-safe.ts";
import {retireManagedNote,writeManagedNote,type ManagedResult} from "./managed-notes.ts";
import {Store} from "../storage/store.ts";
import type {Source} from "./types.ts";
import {importReferences} from "./pipeline.ts";

function oneLine(s: string,limit=500):string {
  return s.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,limit);
}
function yaml(s: string): string {return JSON.stringify(oneLine(s));}
export function renderSource(source: Source): string {
  const label=oneLine(source.title||source.url,200).replace(/[\[\]\\]/g," ");
  const url=source.url.replace(/[<>]/g,"");
  return [
    "---",
    "type: x-feed-source",
    "url: " + yaml(source.url),
    "title: " + yaml(source.title),
    ...(source.description ? ["description: " + yaml(source.description)] : []),
    ...(source.license ? ["license: " + yaml(source.license)] : []),
    "category: " + yaml(source.category),
    "status: " + yaml(source.status),
    "access: " + yaml(source.access),
    "score: " + source.score,
    "confidence: " + source.confidence,
    "discovered: " + yaml(source.firstSeen),
    "discovered_date: " + source.firstSeen.slice(0,10),
    "free: " + (source.access==="free"||source.access==="open_source"?"true":source.access==="paid"?"false":"null"),
    "open_source: " + (source.access==="open_source"?"true":"null"),
    "author: " + yaml(source.author || ""),
    "post_url: " + yaml(source.postUrl || ""),
    "---", "",
    "# " + label, "",
    "Source: [" + label + "](<" + url + ">)",
    source.postUrl ? "Discovered in: [original post](<" + source.postUrl.replace(/[<>]/g,"") + ">)" : "",
    "",
    ...(source.description ? ["## Description","",oneLine(source.description,500),""] : []),
    "## Evaluation", "",
    ...source.reasons.map(r=>"- " + oneLine(r,300)),
    "",
    "> Scores are heuristic. Review before adding to References.md.",
    ""
  ].filter((line,index,all)=>index!==all.length-1 || line!=="").join("\n")+"\n";
}
const BASE = [
  "filters:",
  "  and:",
  '    - file.inFolder("X Feed Scraper")',
  '    - or:',
  '        - type == "x-feed-source"',
  '        - type == "x-feed-visual"',
  "views:",
  "  - type: table",
  '    name: "Candidates"',
  "    filters:",
  '      and:',
  '        - status != "approved"',
  '        - type == "x-feed-source"',
  "    order:",
  "      - file.name",
  "      - category",
  "      - score",
  "      - confidence",
  "      - access",
  "      - status",
  "  - type: table",
  '    name: "Approved"',
  "    filters:",
  "      and:",
  '        - status == "approved"',
  '        - type == "x-feed-source"',
  "    order:",
  "      - file.name",
  "      - category",
  "      - score",
  "  - type: table",
  '    name: "Visual references"',
  "    filters:",
  "      and:",
  '        - type == "x-feed-visual"',
  "    order:",
  "      - file.name",
  "      - author",
  "      - discovered_date",
  ""
].join("\n");
export function exportToVault(dbPath:string,vaultPath:string):
  {created:number;unchanged:number;updated:number;removed:number;conflicts:number;skipped:number} {
  const root=ensureVaultPath(vaultPath,[]);
  const folder=ensureVaultPath(root,["X Feed Scraper"]);
  for(const child of ["Candidates","Approved","Reports","Visuals"]){
    ensureVaultPath(root,["X Feed Scraper",child]);
  }
  const referencesFile=join(root,"References.md");
  const library=existsSync(referencesFile)?importReferences(readFileSync(referencesFile,"utf8")):new Set<string>();
  const store=new Store(dbPath);
  const result={created:0,unchanged:0,updated:0,removed:0,conflicts:0,skipped:0};
  const countWrite=(value:ManagedResult):void=>{
    if(value==="created")result.created++;
    else if(value==="unchanged")result.unchanged++;
    else if(value==="updated")result.updated++;
    else result.conflicts++;
  };
  const retire=(relative:string):void=>{
    const decision=retireManagedNote(store,root,relative);
    if(decision==="removed")result.removed++;
    else if(decision==="conflict")result.conflicts++;
  };
  try {
    for(let offset=0;;offset+=200){
      const page=store.listSourcesPage(offset,200);
      if(page.length===0)break;
    for (const source of page) {
      const shortId=createHash("sha256").update(source.url).digest("hex").slice(0,20);
      const candidatePath=join("X Feed Scraper","Candidates",shortId+".md");
      const approvedPath=join("X Feed Scraper","Approved",shortId+".md");
      if(library.has(source.url) || source.category==="existing_reference" ||
          source.status==="rejected" || source.category==="excluded" ||
          (source.category==="uncategorized" && source.status!=="approved")){
        result.skipped++;
        retire(candidatePath);
        if(source.status==="rejected")retire(approvedPath);
        continue;
      }
      const relative=source.status==="approved"?approvedPath:candidatePath;
      const value=writeManagedNote(store,root,relative,renderSource(source));
      countWrite(value);
      // Approval transitions do not leave stale generated candidate notes.
      if(source.status==="approved"&&value!=="conflict")retire(candidatePath);
    }
    }
    for(const visual of store.listVisualPosts(1000)){
      const id=createHash("sha256").update(String(visual.connector)+"\0"+String(visual.id)).digest("hex").slice(0,20);
      const images=JSON.parse(String(visual.images_json||"[]")) as unknown[];
      const media:string[]=[];
      for(const image of images){
        if(typeof image!=="string" || image.length>2048)continue;
        try{
          const parsed=new URL(image);
          if(!["https:","http:"].includes(parsed.protocol)||parsed.username||parsed.password)continue;
          const safe=parsed.toString();
          if(/[\r\n<>]/.test(safe))continue;
          media.push(safe);
        }catch{}
        if(media.length>=12)break;
      }
      const text=[
        "---","type: x-feed-visual",
        "status: needs_review",
        "post_url: "+yaml(String(visual.url)),
        "author: "+yaml(String(visual.author)),
        "discovered_date: "+String(visual.first_seen).slice(0,10),
        "---","","# Visual reference pending review","",
        "Original observation: [view post](<"+String(visual.url).replace(/[<>]/g,"")+">)","",
        "Image links (not downloaded automatically):","",
        ...media.map(link=>"- [Open image](<"+link.replace(/[<>]/g,"")+">)"),
        "","No source project URL was observed. Do not infer one.",""
      ].join("\n");
      countWrite(writeManagedNote(store,root,join("X Feed Scraper","Visuals",id+".md"),text));
    }
    const stats=store.stats();
    const lastRun=stats.lastRun as {id?:string;started_at?:string;status?:string}|null;
    if (lastRun?.id && /^[\w-]+$/.test(lastRun.id)) {
      const report=[
        "---","type: x-feed-report",
        "run_id: "+yaml(lastRun.id),
        "started: "+yaml(lastRun.started_at||""),
        "status: "+yaml(lastRun.status||""),
        "---","","# Discovery report","",
        "- Posts in database: "+Number(stats.posts),
        "- Unique sources: "+Number(stats.sources),
        "- Post-source associations: "+Number(stats.links),
        "- High-quality candidates: "+Number(stats.high_quality),
        "- Pending review: "+Number(stats.needs_review),
        "- Approved: "+Number(stats.approved),
        "- Recorded errors: "+Number(stats.errors),
        "",
        "Scores are heuristic; the personalized X feed has not been accessed.",""
      ].join("\n");
      countWrite(writeManagedNote(store,root,join("X Feed Scraper","Reports",lastRun.id+".md"),report));
    }
    countWrite(writeManagedNote(store,root,join("X Feed Scraper","Sources.base"),BASE));
    return result;
  } finally {store.close();}
}
