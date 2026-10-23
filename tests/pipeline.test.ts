import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from "node:fs";
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
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("failed duplicate fixture writes are recoverable",()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-recovery-"));const db=join(root,"store.db");
  try {
    const bad=[...fixture,{...fixture[0],id:"",text:"https://example.org/valid"}];
    const result=ingest(db,bad,profile);
    assert.ok(result.posts>=4);
    assert.equal(new Store(db).stats().sources,3);
  } finally {rmSync(root,{recursive:true,force:true});}
});
