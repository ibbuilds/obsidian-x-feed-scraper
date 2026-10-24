import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

class InspectableStore extends KnowledgeStore{
  samePrepared(sql:string):boolean{
    return this.prepareCached(sql)===this.prepareCached(sql);
  }
}
test("hot SQLite statements are reused within one database lifetime",()=>{
  const root=mkdtempSync(join(tmpdir(),"source-scraper-prepared-"));
  try{
    const file=join(root,"data.sqlite");
    const db=new InspectableStore(file);
    assert.equal(db.samePrepared("SELECT 1 AS value"),true);
    assert.equal(db.samePrepared("SELECT 2 AS value"),true);
    assert.equal(db.listEntities("missing").length,0);
    db.close();
    const reopened=new InspectableStore(file);
    assert.equal(reopened.samePrepared("SELECT 1 AS value"),true);
    reopened.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("per-entity review, history, changes and missing-snapshot repair use indexes",()=>{
  const root=mkdtempSync(join(tmpdir(),"source-scraper-indexes-"));
  try{
    const file=join(root,"data.sqlite"),db=new KnowledgeStore(file);
    try{
      for(const name of ["kb_reviews_lookup","kb_assessment_history_entity",
        "kb_changes_entity","kb_missing_observation_json"]){
        const row=db.db.prepare("SELECT 1 present FROM sqlite_master WHERE type='index' AND name=?")
          .get(name) as {present:number}|undefined;
        assert.equal(row?.present,1,"Missing index: "+name);
      }
      for(const [sql,index] of [
        ["SELECT decision FROM kb_reviews WHERE project_id=? AND entity_key=? ORDER BY id DESC LIMIT 1",
          "kb_reviews_lookup"],
        ["SELECT category FROM kb_assessment_history WHERE project_id=? AND entity_key=? ORDER BY id DESC LIMIT 30",
          "kb_assessment_history_entity"],
        ["SELECT path FROM kb_entity_changes WHERE project_id=? AND entity_key=? ORDER BY id DESC LIMIT 50",
          "kb_changes_entity"]
      ]){
        const plan=db.db.prepare("EXPLAIN QUERY PLAN "+sql).all("demo","test-key")
          .map(row=>String(row.detail)).join(" ");
        assert.match(plan,new RegExp(index),"Unindexed hot query: "+sql+" => "+plan);
      }
      const snapshotPlan=db.db.prepare("EXPLAIN QUERY PLAN SELECT item_id FROM kb_observations "+
        "WHERE observation_json IS NULL").all().map(row=>String(row.detail)).join(" ");
      assert.match(snapshotPlan,/kb_missing_observation_json/,
        "Snapshot repair should avoid a full scan of already restored data");
    }finally{db.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
