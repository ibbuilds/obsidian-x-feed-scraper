import {createHash, randomUUID} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync} from "node:fs";
import {join, resolve} from "node:path";
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
    "author: " + yaml(source.author || ""),
    "post_url: " + yaml(source.postUrl || ""),
    "---", "",
    "# " + label, "",
    "Source: [" + label + "](" + url + ")",
    source.postUrl ? "Discovered in: [original post](" + source.postUrl.replace(/[<>]/g,"") + ")" : "",
    "",
    "## Evaluation", "",
    ...source.reasons.map(r=>"- " + oneLine(r,300)),
    "",
    "> Scores are heuristic. Review before adding to References.md.",
    ""
  ].filter((line,index,all)=>index!==all.length-1 || line!=="").join("\n")+"\n";
}
function putIfAbsent(path: string, content: string): "created"|"same"|"conflict" {
  if (existsSync(path)) return readFileSync(path,"utf8")===content ? "same":"conflict";
  const temporary=path+".tmp-"+randomUUID();
  try {
    writeFileSync(temporary,content,{encoding:"utf8",flag:"wx",mode:0o600});
    // Because the collector is single-writer and these paths are dedicated to generated notes,
    // a pre-existing file is never replaced, even if another process wrote it.
    if (existsSync(path)) return "conflict";
    renameSync(temporary,path);
    return "created";
  } finally {if (existsSync(temporary)) unlinkSync(temporary);}
}
const BASE = [
  "filters:",
  "  and:",
  '    - file.inFolder("X Feed Scraper")',
  '    - type == "x-feed-source"',
  "views:",
  "  - type: table",
  '    name: "Candidates"',
  "    filters:",
  '      and:',
  '        - status != "approved"',
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
  '      - status == "approved"',
  "    order:",
  "      - file.name",
  "      - category",
  "      - score",
  ""
].join("\n");
export function exportToVault(dbPath:string,vaultPath:string): {created:number;unchanged:number;conflicts:number;skipped:number} {
  const root=resolve(vaultPath);
  if (!existsSync(root)) throw new Error("Vault path does not exist");
  const folder=join(root,"X Feed Scraper");
  mkdirSync(join(folder,"Candidates"),{recursive:true});
  mkdirSync(join(folder,"Approved"),{recursive:true});
  mkdirSync(join(folder,"Reports"),{recursive:true});
  const referencesFile=join(root,"References.md");
  const library=existsSync(referencesFile)?importReferences(readFileSync(referencesFile,"utf8")):new Set<string>();
  const store=new Store(dbPath);
  const result={created:0,unchanged:0,conflicts:0,skipped:0};
  try {
    const all=store.listSources(undefined,undefined,500);
    for (const source of all) {
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
      // Never delete an old candidate note. Manual edits and previous review state survive.
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
