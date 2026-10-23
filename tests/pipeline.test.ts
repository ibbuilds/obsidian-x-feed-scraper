import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync,symlinkSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readFixture} from "../packages/connectors/fixtures.ts";
import {ingest,importReferences} from "../packages/core/pipeline.ts";
import {exportToVault} from "../packages/core/obsidian.ts";
import {Store} from "../packages/storage/store.ts";
import {loadProfile} from "../packages/core/profile.ts";

const fixture=readFixture("./tests/fixtures/posts.json");
const profile=loadProfile("./profiles/design.json");
test("SQLite survives restart, deduplicates sources and preserves many-to-many links",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-db-"));const db=join(root,"main.db");
  try {
    const first=ingest(db,fixture,profile);
    assert.equal(first.posts,4);assert.equal(first.newSources,3);assert.equal(first.visualOnly,1);
    const store=new Store(db);
    assert.equal(store.stats().posts,4);assert.equal(store.stats().sources,3);assert.equal(store.stats().links,4);
    store.close();
    const again=ingest(db,fixture,profile);
    assert.equal(again.newSources,0);
    const reopened=new Store(db);
    assert.equal(reopened.stats().posts,4);
    assert.equal(reopened.history().length,2);
    reopened.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("read-only References import and safe Obsidian export preserve manually edited files",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-vault-"));const db=join(root,"collector.db");
  const vault=join(root,"vault");mkdirSync(vault);
  const references="# Library\n- [Motion](https://motion.dev/docs)\n";
  writeFileSync(join(vault,"References.md"),references);
  try {
    const present=importReferences(references);
    ingest(db,fixture,profile,"fixture",present);
    const store=new Store(db);
    const sources=store.listSources();
    assert.equal(sources.length,3);
    assert.equal(sources.find(s=>s.url==="https://motion.dev/docs")?.category,"existing_reference");
    const selected=sources.find(s=>s.url.includes("github.com"))!;
    store.review(selected.id,"approved","Manually verified as useful");
    store.close();
    const first=exportToVault(db,vault);
    assert.ok(first.created>0);
    const approvedDir=join(vault,"X Feed Scraper","Approved");
    const approvedFiles=readdirSync(approvedDir);
    assert.equal(approvedFiles.length,1);
    const approvedContent=readFileSync(join(approvedDir,approvedFiles[0]),"utf8");
    assert.match(approvedContent,/^---\ntype: x-feed-source/m);
    assert.match(approvedContent,/status: "approved"/);
    const modified=approvedContent+"\nManual annotation\n";
    writeFileSync(join(approvedDir,approvedFiles[0]),modified);
    const again=exportToVault(db,vault);
    assert.ok(again.conflicts>=1);
    assert.equal(readFileSync(join(approvedDir,approvedFiles[0]),"utf8"),modified);
    assert.equal(readFileSync(join(vault,"References.md"),"utf8"),references);
    assert.equal(existsSync(join(vault,"X Feed Scraper","Sources.base")),true);
    assert.equal(readdirSync(join(vault,"X Feed Scraper","Reports")).length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("failed duplicate fixture writes are recoverable",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-recovery-"));const db=join(root,"store.db");
  try {
    const bad=[...fixture,{...fixture[0],id:"",text:"https://example.org/valid"}];
    const result=ingest(db,bad,profile);
    assert.ok(result.posts>=4);
    assert.equal(result.errors,1);
    const store=new Store(db);
    assert.equal(store.stats().sources,3);
    store.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("canonical redirects merge URLs without losing post-source relationships",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-canonical-"));const db=join(root,"store.db");
  try {
    ingest(db,[...fixture,{id:"short",url:"https://x.com/x/status/9",author:"S",username:"s",
      text:"Motion reference https://t.co/redirect"}],profile);
    const store=new Store(db);
    const short=store.listSources().find(s=>s.url==="https://t.co/redirect")!;
    const target=store.listSources().find(s=>s.url==="https://motion.dev/docs")!;
    const combined=store.repointSource(short.id,"https://motion.dev/docs");
    assert.equal(combined,target.id);
    assert.equal(store.stats().sources,3);
    const count=store.db.prepare("SELECT count(*) n FROM post_sources WHERE source_id=?").get(combined) as {n:number};
    assert.equal(count.n,3);
    store.close();
  } finally{rmSync(root,{recursive:true,force:true});}
});

test("pause state and manual recommendation queue persist across restarts",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-feedback-"));const db=join(root,"store.db");
  try {
    ingest(db,fixture,profile);
    const store=new Store(db);
    store.setPaused(true);
    const one=store.listSources().find(s=>s.url.includes("github.com"))!;
    store.review(one.id,"approved","Trusted technical reference");
    assert.equal(store.recommendations().posts.length,1);
    assert.equal(store.recommendations().authors.length,1);
    store.close();
    const reopened=new Store(db);
    assert.equal(reopened.paused(),true);
    assert.equal(reopened.recommendations().authors[0].username,"studioa");
    reopened.close();
  } finally{rmSync(root,{recursive:true,force:true});}
});

test("export includes sources beyond the first 500 records",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-large-"));
  const vault=join(root,"vault"),db=join(root,"db.sqlite");
  mkdirSync(vault);
  try{
    const many=Array.from({length:510},(_,index)=>({
      id:"entry-"+index,url:"https://x.com/test/status/"+(index+1),
      author:"Study",username:"study",text:"Great motion design article "+
        "https://example.org/motion/design/"+index
    }));
    const ingested=ingest(db,many,profile,"fixture");
    assert.equal(ingested.newSources,510);
    const result=exportToVault(db,vault);
    assert.ok(result.created>=511);
    assert.equal(readdirSync(join(vault,"X Feed Scraper","Candidates")).length,510);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("approved files retire only untouched generated candidates",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-promotion-"));
  const vault=join(root,"vault"),db=join(root,"db.sqlite");
  mkdirSync(vault);
  try{
    ingest(db,fixture,profile);
    exportToVault(db,vault);
    const candidates=join(vault,"X Feed Scraper","Candidates");
    const store=new Store(db);
    const selected=store.listSources().find(s=>s.url.includes("github.com"))!;
    const candidateName=readdirSync(candidates).find(name=>
      readFileSync(join(candidates,name),"utf8").includes(selected.url))!;
    assert.ok(candidateName);
    store.review(selected.id,"approved","Verified useful");
    store.close();
    const result=exportToVault(db,vault);
    assert.equal(existsSync(join(candidates,candidateName)),false);
    assert.equal(readdirSync(join(vault,"X Feed Scraper","Approved")).length,1);
    assert.ok(result.created>0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("edited candidate notes are never deleted during approval",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-edits-"));
  const vault=join(root,"vault"),db=join(root,"db.sqlite");
  mkdirSync(vault);
  try{
    ingest(db,fixture,profile);
    exportToVault(db,vault);
    const candidates=join(vault,"X Feed Scraper","Candidates");
    const store=new Store(db);
    const selected=store.listSources().find(s=>s.url.includes("github.com"))!;
    const oldName=readdirSync(candidates).find(name=>
      readFileSync(join(candidates,name),"utf8").includes(selected.url))!;
    const path=join(candidates,oldName);
    const modified=readFileSync(path,"utf8")+"\nPersonal note\n";
    writeFileSync(path,modified);
    store.review(selected.id,"approved","Checked");
    store.close();
    const result=exportToVault(db,vault);
    assert.ok(result.conflicts>=1);
    assert.equal(readFileSync(path,"utf8"),modified);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("public metadata enrichment excludes approved and existing-library sources",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-enrichment-"));
  const db=join(root,"db.sqlite");
  try{
    ingest(db,fixture,profile,"fixture",new Set(["https://motion.dev/docs"]));
    const store=new Store(db);
    const items=store.listSources();
    const candidate=items.find(s=>s.url.includes("github.com"))!;
    store.review(candidate.id,"approved","Reviewed");
    const pending=store.pendingForEnrichment(20);
    assert.ok(pending.every(s=>s.status!=="approved" && s.category!=="existing_reference"));
    assert.ok(pending.length>=1);
    store.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("manual access classification and audit survive SQLite restarts",()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-access-"));const db=join(root,"library.db");
 try{
   ingest(db,fixture,profile);
   const store=new Store(db);
   const resource=store.listSources().find(s=>s.url.includes("motion.dev"))!;
   const reviewed=store.review(resource.id,"approved","Free tier checked manually","freemium");
   assert.equal(reviewed.access,"freemium");
   const audits=store.db.prepare("SELECT decision,access FROM reviews WHERE source_id=?").all(resource.id) as Array<{decision:string;access:string}>;
   assert.equal(audits.at(-1)?.access,"freemium");
   store.close();
   const after=new Store(db);
   assert.equal(after.getSource(resource.id)?.access,"freemium");
   assert.throws(()=>after.review(resource.id,"approved","Bad field","pirated" as never),/Invalid access/);
   after.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("vault symlink directory cannot redirect generated notes outside vault",()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-symlink-"));
 const vault=join(root,"vault"),outside=join(root,"outside"),db=join(root,"store.db");
 mkdirSync(vault);mkdirSync(outside);
 try{
   try{symlinkSync(outside,join(vault,"X Feed Scraper"),process.platform==="win32"?"junction":"dir");}
   catch(error){
     if(["EPERM","EACCES"].includes((error as NodeJS.ErrnoException).code||""))return;
     throw error;
   }
   ingest(db,fixture,profile);
   assert.throws(()=>exportToVault(db,vault),/symbolic link|symlink/i);
   assert.equal(readdirSync(outside).length,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
