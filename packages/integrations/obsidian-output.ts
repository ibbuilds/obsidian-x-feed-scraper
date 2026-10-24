import {createHash} from "node:crypto";
import {join} from "node:path";
import {ensureVaultPath} from "../core/vault-safe.ts";
import {writeManagedNote,retireManagedNote} from "../core/managed-notes.ts";
import {KnowledgeStore} from "../storage/knowledge.ts";
import type {KnowledgeEntity,OutputAdapter} from "../sdk/contracts.ts";

function clean(value:string,max=500):string{
  return value.replace(/[\u0000-\u001f\u007f]/g," ").replace(/[<>]/g," ").trim().slice(0,max);
}
function yaml(value:string):string{return JSON.stringify(clean(value,1000));}
function md(entity:KnowledgeEntity,observed:Array<{connection_id:string;item_id:string;url:string|null}>):string{
  const name=clean(entity.title,200).replace(/[\[\]\\]/g," ");
  const lines=[
    "---","type: discovery-entity",
    "project: "+yaml(entity.projectId),"entity_type: "+yaml(entity.type),
    "identity: "+yaml(entity.key),"title: "+yaml(entity.title),
    "category: "+yaml(entity.category),
    "score: "+entity.score,"confidence: "+entity.confidence,
    "review: "+yaml(entity.review),
    "url: "+yaml(entity.url||""),
    "observation_count: "+entity.observationCount,
    "---","","# "+name,"",
    entity.url?"Resource: ["+name+"](<"+entity.url.replace(/[<>]/g,"")+">)":"",
    "","## Structured fields","",
    ...Object.entries(entity.attributes).map(([key,value])=>
      "- **"+clean(key,100)+"**: "+clean(JSON.stringify(value),500)),
    "","## Assessment","",...entity.reasons.map(x=>"- "+clean(x,300)),
    "","## Provenance","",
    ...observed.slice(0,100).map(row=>"- "+clean(row.connection_id)+
      " · "+clean(row.item_id,120)+(row.url?" · [Observation](<"+row.url.replace(/[<>]/g,"")+">)":"")),
    "","Automatic evaluation does not constitute human approval.",""
  ];
  return lines.filter((x,i)=>x||i>0).join("\n")+"\n";
}
const BASE=[
  "filters:","  and:",
  '    - file.inFolder("Discovery Engine")',
  '    - type == "discovery-entity"',
  "views:","  - type: table",'    name: "Knowledge"',
  "    order:","      - file.name","      - entity_type","      - category",
  "      - score","      - confidence","      - review",""
].join("\n");
export const obsidianOutput:OutputAdapter={
  id:"obsidian",
  offline:true,
  export({project,records,config,databasePath,vaultPath}){
    if(!vaultPath)throw new Error("Obsidian output requires an explicit vault path");
    const folder=config.folder===undefined?"Discovery Engine":config.folder;
    if(typeof folder!=="string"||folder.length>64||
      !/^[\p{L}\p{N} _-]{1,64}$/u.test(folder)||folder==="."||folder===".."){
      throw new Error("Unsafe output folder");
    }
    const root=ensureVaultPath(vaultPath,[]);
    const projectFolder=ensureVaultPath(root,[folder,project.id]);
    const store=new KnowledgeStore(databasePath);
    const result={created:0,updated:0,unchanged:0,conflicts:0,removed:0,conflictPaths:[] as string[]};
    const record=(status:"created"|"updated"|"unchanged"|"conflict",path:string)=>{
      if(status==="created")result.created++;
      else if(status==="updated")result.updated++;
      else if(status==="unchanged")result.unchanged++;
      else{result.conflicts++;if(result.conflictPaths.length<30)result.conflictPaths.push(path);}
    };
    try{
      const wanted=new Set<string>();
      for(const entity of records){
        const name=createHash("sha256").update(entity.key).digest("hex").slice(0,24)+".md";
        const relative=join(folder,project.id,name);
        wanted.add(relative);
        const observed=store.db.prepare(
          "SELECT o.connection_id,o.item_id,o.url FROM kb_mentions m JOIN kb_observations o "+
          "ON o.project_id=m.project_id AND o.connection_id=m.connection_id AND o.item_id=m.item_id "+
          "WHERE m.project_id=? AND m.entity_key=? LIMIT 100"
        ).all(project.id,entity.key) as Array<{connection_id:string;item_id:string;url:string|null}>;
        record(writeManagedNote(store,root,relative,md(entity,observed)),relative);
      }
      // Retire notes that no longer pass the active project policy or were rejected.
      // Only byte-for-byte verified machine output may be removed; annotated or
      // unrelated vault notes are never deleted.
      const previous=store.db.prepare(
        "SELECT note_path FROM exported_notes WHERE vault_id=?"
      ).all(root) as Array<{note_path:string}>;
      const prefix=join(folder,project.id).replace(/\\/g,"/")+"/";
      for(const row of previous){
        const relative=row.note_path.replace(/\\/g,"/");
        if(!relative.startsWith(prefix)||wanted.has(row.note_path)||
          !/^[0-9a-f]{24}\.md$/.test(relative.slice(prefix.length)))continue;
        const outcome=retireManagedNote(store,root,row.note_path);
        if(outcome==="removed")result.removed++;
        else if(outcome==="conflict"){
          result.conflicts++;
          if(result.conflictPaths.length<30)result.conflictPaths.push(row.note_path);
        }
      }
      const relative=join(folder,project.id,"Knowledge.base");
      // Restrict the Base to this project's folder, not to other projects.
      const base=BASE.replace('file.inFolder("Discovery Engine")',
        'file.inFolder("'+folder.replace(/"/g,"")+"/"+project.id+'")');
      record(writeManagedNote(store,root,relative,base),relative);
      return {...result,directory:projectFolder};
    }finally{store.close();}
  }
};
