import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../packages/storage/store.ts";

test("old v0.1 review tables are migrated additively without losing records",()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-migrate-"));
 const path=join(root,"previous.db");
 try{
   const old=new DatabaseSync(path);
   old.exec("CREATE TABLE reviews (id INTEGER PRIMARY KEY,source_id INTEGER NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,reviewed_at TEXT NOT NULL)");
   old.prepare("INSERT INTO reviews(source_id,decision,reason,reviewed_at) VALUES(1,'approved','Important','2026-09-01')").run();
   old.close();
   const current=new Store(path);
   const cols=current.db.prepare("PRAGMA table_info(reviews)").all() as Array<{name:string}>;
   assert.ok(cols.some(c=>c.name==="access"));
   const oldReview=current.db.prepare("SELECT reason,access FROM reviews WHERE id=1").get() as {reason:string;access:null};
   assert.equal(oldReview.reason,"Important");
   assert.equal(oldReview.access,null);
   current.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
