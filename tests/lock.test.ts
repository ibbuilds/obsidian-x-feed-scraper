import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireLock} from "../packages/core/lock.ts";

test("two collectors cannot hold the same lock",()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-lease-"));const lock=join(root,"library.db.lock");
 try{
   const unlock=acquireLock(lock);
   assert.throws(()=>acquireLock(lock),/Another collector/);
   unlock();
   assert.equal(existsSync(lock),false);
   const another=acquireLock(lock);
   another();another();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("process crash lock can be recovered immediately without six-hour delay",()=>{
 const root=mkdtempSync(join(tmpdir(),"xfs-stale-"));const lock=join(root,"db.lock");
 try{
   writeFileSync(lock,JSON.stringify({pid:99999999,token:"dead-owner",created:Date.now()}));
   const release=acquireLock(lock);
   assert.notEqual(JSON.parse(readFileSync(lock,"utf8")).token,"dead-owner");
   release();
   assert.equal(existsSync(lock),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
