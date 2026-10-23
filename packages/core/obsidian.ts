import {createHash, randomUUID} from "node:crypto";
import {existsSync, readFileSync, linkSync, writeFileSync, unlinkSync, lstatSync} from "node:fs";
import {join} from "node:path";
import {ensureVaultPath, isSymlink} from "./vault-safe.ts";
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
    "## Evaluation", "",
    ...source.reasons.map(r=>"- " + oneLine(r,300)),
    "",
    "> Scores are heuristic. Review before adding to References.md.",
    ""
  ].filter((line,index,all)=>index!==all.length-1 || line!=="").join("\n")+"\n";
}
/** Atomic create-only promotion; never overwrites an existing or edited vault note. */
function putIfAbsent(path:string,content:string):"created"|"same"|"conflict"{
  if(isSymlink(path)) return "conflict";
  if(existsSync(path))return readFileSync(path,"utf8")===content?"same":"conflict";
  const temp=path+".tmp-"+randomUUID();
  try{
    writeFileSync(temp,content,{encoding:"utf8",flag:"wx",mode:0o600});
    try{
      // Hard-link is an atomic create-only operation (EEXIST protects user files).
      linkSync(temp,path);
      return "created";
    }catch(e){
      const code=(e as NodeJS.ErrnoException).code;
      if(code==="EEXIST")return isSymlink(path)?"conflict":readFileSync(path,"utf8")===content?"same":"conflict";
      if(["EPERM","ENOTSUP","EOPNOTSUPP"].includes(code||"")){
        // Some filesystems do not support hard links; exclusive write still never clobbers.
        try{
          writeFileSync(path,content,{flag:"wx",mode:0o600});
          return "created";
        }catch(fallback){
          if((fallback as NodeJS.ErrnoException).code==="EEXIST"){
            return isSymlink(path)?"conflict":readFileSync(path,"utf8")===content?"same":"conflict";
          }
          throw fallback;
        }
      }
      throw e;
    }
  }finally{if(existsSync(temp))unlinkSync(temp);}
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
export function exportToVault(dbPath:string,vaultPath:string): {created:number;unchanged:number;conflicts:number;skipped:number} {
  const root=ensureVaultPath(vaultPath,[]);
  const folder=ensureVaultPath(root,["X Feed Scraper"]);
  for(const child of ["Candidates","Approved","Reports","Visuals"]){
    ensureVaultPath(root,["X Feed Scraper",child]);
  }
  const referencesFile=join(root,"References.md");
  const library=existsSync(referencesFile)?importReferences(readFileSync(referencesFile,"utf8")):new Set<string>();
  const store=new Store(dbPath);
  const result={created:0,unchanged:0,conflicts:0,skipped:0};
  try {
    for(let offset=0;;offset+=200){
      const page=store.listSourcesPage(offset,200);
      if(page.length===0)break;
    for (const source of page) {
      if (library.has(source.url) || source.status==="rejected" || source.category==="existing_reference" ||
          (source.category==="uncategorized" && source.status!=="approved")) {
        result.skipped++;continue;
      }
      const folderName=source.status==="approved"?"Approved":"Candidates";
      const shortId=createHash("sha256").update(source.url).digest("hex").slice(0,20);
      const output=join(folder,folderName,shortId+".md");
      const value=putIfAbsent(output,renderSource(source));
      if (value==="created") result.created++;
      else if (value==="same") result.unchanged++;
      else result.conflicts++;
      // Only discard an unmodified generated candidate once an approved file exists.
      if(source.status==="approved" && value!=="conflict"){
        const oldFile=join(folder,"Candidates",shortId+".md");
        if(isSymlink(oldFile)){
          result.conflicts++;
        }else if(existsSync(oldFile)){
          const oldContent=readFileSync(oldFile,"utf8");
          const generated=["discovered","pending_analysis","evaluated","high_quality","needs_review"]
            .some(status=>oldContent===renderSource({...source,status:status as Source["status"]}));
          if(generated)unlinkSync(oldFile);
          else result.conflicts++; // Edited candidate intentionally remains untouched.
        }
      }
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
      const resultType=putIfAbsent(join(folder,"Visuals",id+".md"),text);
      if(resultType==="created")result.created++;
      else if(resultType==="same")result.unchanged++;
      else result.conflicts++;
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
      const reportState=putIfAbsent(join(folder,"Reports",lastRun.id+".md"),report);
      if (reportState==="created") result.created++;
      else if (reportState==="same") result.unchanged++;
      else result.conflicts++;
    }
    const state=putIfAbsent(join(folder,"Sources.base"),BASE);
    if (state==="created") result.created++;
    else if (state==="same") result.unchanged++;
    else result.conflicts++;
    return result;
  } finally {store.close();}
}
