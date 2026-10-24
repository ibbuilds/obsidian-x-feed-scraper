import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../packages/storage/store.ts";
import {ingest,enrich} from "../packages/core/pipeline.ts";
import {loadProfile} from "../packages/core/profile.ts";

test("automatic metadata enrichment retries are bounded, durable, and manually overridable",async()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-auto-metadata-")),db=join(root,"db.sqlite");
 const profile=loadProfile("./profiles/design.json");
 try{
  ingest(db,[{id:"example",url:"https://x.com/test/status/88",author:"A",username:"a",
    text:"Creative UX UI example at http://127.0.0.1/private"}],profile);
  const store=new Store(db);
  const source=store.listSources()[0];
  assert.ok(source);
  store.markMetadataAttempt(source.id,"Unsafe network destination");
  store.markMetadataAttempt(source.id,"Unsafe network destination");
  store.markMetadataAttempt(source.id,"Unsafe network destination");
  assert.equal(store.pendingForEnrichment(10,false).length,0);
  assert.equal(store.pendingForEnrichment(10,true).length,1);
  assert.equal(Number(store.stats().metadata_backoff_exhausted),1);
  store.close();
  const reopened=new Store(db);
  assert.equal(reopened.pendingForEnrichment(10,false).length,0);
  reopened.close();
  const result=await enrich(db,profile,new Set(),10,true);
  assert.equal(result.checked,1);
  assert.equal(result.failed,1);
  const after=new Store(db);
  assert.equal(after.pendingForEnrichment(10,false).length,0);
  assert.equal(after.history()[0].status,"partial");
  after.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
