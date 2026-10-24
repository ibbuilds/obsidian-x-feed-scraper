import {createHash,randomUUID} from "node:crypto";
import {Store} from "./store.ts";
import type {ProjectDefinition,ProjectSource,Observation,EntityDraft,Assessment,KnowledgeEntity,ReviewState} from "../sdk/contracts.ts";

type Row=Record<string,unknown>;
const now=()=>new Date().toISOString();
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function json<T>(raw:unknown,fallback:T):T{
  if(typeof raw!=="string")return fallback;
  try{return JSON.parse(raw) as T;}catch{return fallback;}
}
function asKnowledge(row:Row):KnowledgeEntity{
  return {
    projectId:String(row.project_id),key:String(row.entity_key),type:String(row.type),
    title:String(row.title),url:row.url?String(row.url):undefined,
    attributes:json(String(row.attributes_json||"{}"),{}),
    category:String(row.category||"unclassified"),
    score:Number(row.score||0),confidence:Number(row.confidence||0),
    reasons:json(String(row.reasons_json||"[]"),[]),
    review:String(row.review||"pending") as ReviewState,
    updatedAt:String(row.updated_at),
    observationCount:Number(row.observation_count||0)
  };
}
function safe(message:string):string{
  return message.replace(/https?:\/\/[^\s'"<>]+/gi,"[redacted-url]")
    .replace(/(?:token|password|secret|cookie|session|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"[redacted]");
}
/** Additive SQLite schema. All v0.4.0 tables and vault notes remain untouched. */
export class KnowledgeStore extends Store {
  constructor(file:string){
    super(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS kb_projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,config_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS kb_connections (project_id TEXT NOT NULL REFERENCES kb_projects(id),connection_id TEXT NOT NULL,adapter_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,connection_id));" +
      "CREATE TABLE IF NOT EXISTS kb_observations (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,type TEXT NOT NULL,title TEXT,text TEXT,url TEXT,attributes_json TEXT NOT NULL,media_json TEXT NOT NULL,occurred_at TEXT,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(project_id,connection_id,item_id),FOREIGN KEY(project_id,connection_id) REFERENCES kb_connections(project_id,connection_id));" +
      "CREATE TABLE IF NOT EXISTS kb_entities (project_id TEXT NOT NULL REFERENCES kb_projects(id),entity_key TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,url TEXT,attributes_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_mentions (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,entity_key TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(project_id,connection_id,item_id,entity_key),FOREIGN KEY(project_id,connection_id,item_id) REFERENCES kb_observations(project_id,connection_id,item_id),FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_assessments (project_id TEXT NOT NULL,entity_key TEXT NOT NULL,category TEXT NOT NULL,score INTEGER NOT NULL,confidence REAL NOT NULL,reasons_json TEXT NOT NULL,evaluator_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,entity_key),FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_reviews (id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,entity_key TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,reviewed_at TEXT NOT NULL,legacy_review_id INTEGER UNIQUE,FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,connection_id TEXT,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,observations INTEGER NOT NULL DEFAULT 0,new_entities INTEGER NOT NULL DEFAULT 0,duplicates INTEGER NOT NULL DEFAULT 0,error TEXT);" +
      "CREATE TABLE IF NOT EXISTS kb_checkpoints (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,cursor TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,connection_id));" +
      "CREATE INDEX IF NOT EXISTS kb_entities_type ON kb_entities(project_id,type);" +
      "CREATE INDEX IF NOT EXISTS kb_mentions_entity ON kb_mentions(project_id,entity_key);" +
      "CREATE INDEX IF NOT EXISTS kb_assessments_score ON kb_assessments(project_id,score DESC);"
    );
    this.migrateLegacy();
  }
  saveProject(project:ProjectDefinition):void{
    const date=now();
    // Deliberately NEVER persist adapter config; it can contain credentials.
    const fingerprint=hash(JSON.stringify(project));
    this.db.prepare(
      "INSERT INTO kb_projects(id,name,config_hash,created_at,updated_at) VALUES(?,?,?,?,?) "+
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_hash=excluded.config_hash,updated_at=excluded.updated_at"
    ).run(project.id,project.name,fingerprint,date,date);
    for(const source of project.sources)this.saveConnection(project.id,source);
  }
  saveConnection(projectId:string,source:ProjectSource):void{
    const existing=this.db.prepare(
      "SELECT adapter_id FROM kb_connections WHERE project_id=? AND connection_id=?"
    ).get(projectId,source.id) as {adapter_id:string}|undefined;
    if(existing&&existing.adapter_id!==source.adapter){
      throw new Error("Connection "+source.id+" changed adapter; create a new connection ID");
    }
    this.db.prepare(
      "INSERT OR IGNORE INTO kb_connections(project_id,connection_id,adapter_id,created_at) VALUES(?,?,?,?)"
    ).run(projectId,source.id,source.adapter,now());
  }
  listProjects():Row[]{
    return this.db.prepare(
      "SELECT p.id,p.name,p.updated_at,(SELECT count(*) FROM kb_entities e WHERE e.project_id=p.id) entities,"+
      "(SELECT count(*) FROM kb_observations o WHERE o.project_id=p.id) observations "+
      "FROM kb_projects p ORDER BY p.id"
    ).all() as Row[];
  }
  cursor(projectId:string,connectionId:string):string|undefined{
    const row=this.db.prepare(
      "SELECT cursor FROM kb_checkpoints WHERE project_id=? AND connection_id=?"
    ).get(projectId,connectionId) as {cursor:string|null}|undefined;
    return row?.cursor??undefined;
  }
  resetCursor(projectId:string,connectionId:string):void{
    this.db.prepare("DELETE FROM kb_checkpoints WHERE project_id=? AND connection_id=?").run(projectId,connectionId);
  }
  beginRun(projectId:string,connectionId:string):string{
    const runId=randomUUID();
    this.db.prepare(
      "INSERT INTO kb_runs(id,project_id,connection_id,status,started_at) VALUES(?,?,?,'running',?)"
    ).run(runId,projectId,connectionId,now());
    return runId;
  }
  finishRun(runId:string,status:"success"|"partial"|"failed",counts:{
    observations:number;newEntities:number;duplicates:number
  },error?:string):void{
    this.db.prepare(
      "UPDATE kb_runs SET status=?,ended_at=?,observations=?,new_entities=?,duplicates=?,error=? WHERE id=?"
    ).run(status,now(),counts.observations,counts.newEntities,counts.duplicates,
      error?safe(error).slice(0,250):null,runId);
  }
  saveBatch(projectId:string,source:ProjectSource,items:Array<{
    observation:Observation;entities:Array<{draft:EntityDraft;assessment:Assessment}>;
  }>,nextCursor:string|undefined):{observations:number;newEntities:number;duplicates:number}{
    const count={observations:0,newEntities:0,duplicates:0};
    const date=now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const {observation,entities} of items){
        const inserted=this.db.prepare(
          "INSERT OR IGNORE INTO kb_observations(project_id,connection_id,item_id,type,title,text,url,attributes_json,media_json,occurred_at,first_seen,last_seen) "+
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(projectId,source.id,observation.id,observation.type,
          observation.title||null,observation.text||null,observation.url||null,
          JSON.stringify(observation.attributes||{}),JSON.stringify(observation.media||[]),
          observation.occurredAt||null,date,date);
        this.db.prepare(
          "UPDATE kb_observations SET last_seen=?,title=?,text=?,url=?,attributes_json=?,media_json=? "+
          "WHERE project_id=? AND connection_id=? AND item_id=?"
        ).run(date,observation.title||null,observation.text||null,observation.url||null,
          JSON.stringify(observation.attributes||{}),JSON.stringify(observation.media||[]),
          projectId,source.id,observation.id);
        if(inserted.changes===0)count.duplicates++;
        count.observations++;
        for(const {draft,assessment} of entities){
          const entity=this.db.prepare(
            "INSERT OR IGNORE INTO kb_entities(project_id,entity_key,type,title,url,attributes_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
          ).run(projectId,draft.key,draft.type,draft.title,draft.url||null,
            JSON.stringify(draft.attributes||{}),date,date);
          if(entity.changes)count.newEntities++;
          else count.duplicates++;
          this.db.prepare(
            "UPDATE kb_entities SET type=?,title=?,url=?,attributes_json=?,updated_at=? WHERE project_id=? AND entity_key=?"
          ).run(draft.type,draft.title,draft.url||null,JSON.stringify(draft.attributes||{}),
            date,projectId,draft.key);
          this.db.prepare(
            "INSERT INTO kb_mentions(project_id,connection_id,item_id,entity_key,evidence_json) VALUES(?,?,?,?,?) "+
            "ON CONFLICT(project_id,connection_id,item_id,entity_key) DO UPDATE SET evidence_json=excluded.evidence_json"
          ).run(projectId,source.id,observation.id,draft.key,JSON.stringify(draft.evidence||[]));
          // Prefer strongest evidence when several observations refer to one entity.
          this.db.prepare(
            "INSERT INTO kb_assessments(project_id,entity_key,category,score,confidence,reasons_json,evaluator_id,updated_at) "+
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,entity_key) DO UPDATE SET "+
            "category=CASE WHEN excluded.score>=score THEN excluded.category ELSE category END,"+
            "score=max(score,excluded.score),confidence=max(confidence,excluded.confidence),"+
            "reasons_json=CASE WHEN excluded.score>=score THEN excluded.reasons_json ELSE reasons_json END,"+
            "evaluator_id=excluded.evaluator_id,updated_at=excluded.updated_at"
          ).run(projectId,draft.key,assessment.category,assessment.score,assessment.confidence,
            JSON.stringify(assessment.reasons),source.adapter,date);
        }
      }
      this.db.prepare(
        "INSERT INTO kb_checkpoints(project_id,connection_id,cursor,updated_at) VALUES(?,?,?,?) "+
        "ON CONFLICT(project_id,connection_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at"
      ).run(projectId,source.id,nextCursor??null,date);
      this.db.exec("COMMIT");
      return count;
    }catch(error){
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  listEntities(projectId:string,opts:{limit?:number;offset?:number;type?:string;q?:string;minScore?:number}={}):KnowledgeEntity[]{
    const limit=Number.isFinite(opts.limit)?Math.max(1,Math.min(500,Math.floor(opts.limit!))):100;
    const offset=Number.isFinite(opts.offset)?Math.max(0,Math.min(1000000,Math.floor(opts.offset!))):0;
    const q=opts.q?"%"+opts.q.slice(0,100)+"%":null;
    const rows=this.db.prepare(
      "SELECT e.project_id,e.entity_key,e.type,e.title,e.url,e.attributes_json,e.updated_at,"+
      "a.category,a.score,a.confidence,a.reasons_json,"+
      "COALESCE((SELECT CASE WHEN r.decision IN ('approved','excellent') THEN 'approved' "+
      "WHEN r.decision='rejected' THEN 'rejected' ELSE 'pending' END FROM kb_reviews r "+
      "WHERE r.project_id=e.project_id AND r.entity_key=e.entity_key ORDER BY r.id DESC LIMIT 1),'pending') review,"+
      "(SELECT COUNT(*) FROM kb_mentions m WHERE m.project_id=e.project_id AND m.entity_key=e.entity_key) observation_count "+
      "FROM kb_entities e LEFT JOIN kb_assessments a ON a.project_id=e.project_id AND a.entity_key=e.entity_key "+
      "WHERE e.project_id=? AND (? IS NULL OR e.type=?) AND (? IS NULL OR e.title LIKE ? OR e.entity_key LIKE ?) "+
      "AND COALESCE(a.score,0)>=? ORDER BY COALESCE(a.score,0) DESC,e.entity_key LIMIT ? OFFSET ?"
    ).all(projectId,opts.type||null,opts.type||null,q,q,q,
      Number.isFinite(opts.minScore)?opts.minScore!:0,limit,offset) as Row[];
    return rows.map(asKnowledge);
  }
  getEntity(projectId:string,key:string):KnowledgeEntity|undefined{
    // Key may contain arbitrary URL punctuation: always parameterized.
    const rows=this.db.prepare(
      "SELECT e.project_id,e.entity_key,e.type,e.title,e.url,e.attributes_json,e.updated_at,a.category,a.score,a.confidence,a.reasons_json,"+
      "COALESCE((SELECT CASE WHEN r.decision IN ('approved','excellent') THEN 'approved' WHEN r.decision='rejected' THEN 'rejected' ELSE 'pending' END FROM kb_reviews r WHERE r.project_id=e.project_id AND r.entity_key=e.entity_key ORDER BY r.id DESC LIMIT 1),'pending') review,"+
      "(SELECT COUNT(*) FROM kb_mentions m WHERE m.project_id=e.project_id AND m.entity_key=e.entity_key) observation_count "+
      "FROM kb_entities e LEFT JOIN kb_assessments a ON a.project_id=e.project_id AND a.entity_key=e.entity_key "+
      "WHERE e.project_id=? AND e.entity_key=?"
    ).get(projectId,key) as Row|undefined;
    return rows?asKnowledge(rows):undefined;
  }
  listObservations(projectId:string,limit=100):Row[]{
    return this.db.prepare(
      "SELECT connection_id,item_id,type,title,text,url,occurred_at,first_seen,last_seen "+
      "FROM kb_observations WHERE project_id=? ORDER BY last_seen DESC LIMIT ?"
    ).all(projectId,Math.max(1,Math.min(500,Math.floor(limit)))) as Row[];
  }
  runs(projectId:string,limit=50):Row[]{
    return this.db.prepare(
      "SELECT id,connection_id,status,started_at,ended_at,observations,new_entities,duplicates,error "+
      "FROM kb_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?"
    ).all(projectId,Math.max(1,Math.min(100,Math.floor(limit)))) as Row[];
  }
  reviewEntity(projectId:string,key:string,decision:"approved"|"rejected"|"pending",reason:string):KnowledgeEntity{
    if(!reason.trim()||reason.length>1000)throw new Error("A review reason is required (max 1000 characters)");
    if(!["approved","rejected","pending"].includes(decision))throw new Error("Invalid review decision");
    if(!this.getEntity(projectId,key))throw new Error("Knowledge entity not found");
    this.db.prepare(
      "INSERT INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at) VALUES(?,?,?,?,?)"
    ).run(projectId,key,decision,reason,now());
    return this.getEntity(projectId,key)!;
  }
  updateAssessment(projectId:string,key:string,value:Assessment,evaluator:string):void{
    this.db.prepare(
      "UPDATE kb_assessments SET category=?,score=?,confidence=?,reasons_json=?,evaluator_id=?,updated_at=? "+
      "WHERE project_id=? AND entity_key=?"
    ).run(value.category,value.score,value.confidence,JSON.stringify(value.reasons),
      evaluator,now(),projectId,key);
  }
  /**
   * Import the v0.4.0 database in place. The old schema remains intact and all
   * inserts are idempotent; opening the database again also migrates later posts.
   */
  migrateLegacy():{observations:number;entities:number}{
    const migrated={observations:0,entities:0};
    const count=this.db.prepare("SELECT COUNT(*) count FROM posts").get() as {count:number};
    const sourceCount=this.db.prepare("SELECT COUNT(*) count FROM sources").get() as {count:number};
    if(!count.count&&!sourceCount.count)return migrated;
    const legacyId="legacy-x-feed",date=now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare(
        "INSERT OR IGNORE INTO kb_projects(id,name,config_hash,created_at,updated_at) VALUES(?,?,?,?,?)"
      ).run(legacyId,"Legacy X Feed Scraper","legacy-v0.4.0",date,date);
      const posts=this.db.prepare(
        "SELECT id,connector,url,author,username,text,published_at,images_json,first_seen,last_seen FROM posts"
      ).all() as Row[];
      for(const post of posts){
        const connectionId="legacy-"+hash(String(post.connector)).slice(0,20);
        this.db.prepare(
          "INSERT OR IGNORE INTO kb_connections(project_id,connection_id,adapter_id,created_at) VALUES(?,?,?,?)"
        ).run(legacyId,connectionId,"legacy",date);
        const result=this.db.prepare(
          "INSERT OR IGNORE INTO kb_observations(project_id,connection_id,item_id,type,title,text,url,attributes_json,media_json,occurred_at,first_seen,last_seen) "+
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(legacyId,connectionId,String(post.id),"post",String(post.author||""),
          String(post.text||""),post.url?String(post.url):null,
          JSON.stringify({author:String(post.author||""),username:String(post.username||"")}),
          String(post.images_json||"[]"),post.published_at?String(post.published_at):null,
          String(post.first_seen||date),String(post.last_seen||date));
        if(result.changes)migrated.observations++;
      }
      const sources=this.db.prepare("SELECT * FROM sources").all() as Row[];
      for(const source of sources){
        const key=String(source.normalized_url);
        const result=this.db.prepare(
          "INSERT OR IGNORE INTO kb_entities(project_id,entity_key,type,title,url,attributes_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        ).run(legacyId,key,"web-resource",String(source.title||key),key,
          JSON.stringify({description:String(source.description||""),license:String(source.license||""),
            access:String(source.access||"unknown")}),String(source.first_seen||date),String(source.updated_at||date));
        if(result.changes)migrated.entities++;
        this.db.prepare(
          "INSERT OR IGNORE INTO kb_assessments(project_id,entity_key,category,score,confidence,reasons_json,evaluator_id,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        ).run(legacyId,key,String(source.category||"uncategorized"),Number(source.score||0),
          Number(source.confidence||0),String(source.reasons||"[]"),"legacy-heuristic",String(source.updated_at||date));
        const reviews=this.db.prepare(
          "SELECT id,decision,reason,reviewed_at FROM reviews WHERE source_id=? ORDER BY id"
        ).all(Number(source.id)) as Row[];
        for(const review of reviews){
          this.db.prepare(
            "INSERT OR IGNORE INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at,legacy_review_id) VALUES(?,?,?,?,?,?)"
          ).run(legacyId,key,String(review.decision),String(review.reason),String(review.reviewed_at||date),Number(review.id));
        }
        // Old schema can contain directly approved status with no review history.
        if(!reviews.length&&["approved","rejected"].includes(String(source.status))){
          this.db.prepare(
            "INSERT OR IGNORE INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at,legacy_review_id) VALUES(?,?,?,?,?,?)"
          ).run(legacyId,key,String(source.status),"Imported from original source status",String(source.updated_at||date),
            -Number(source.id));
        }
      }
      const mentions=this.db.prepare(
        "SELECT ps.connector,ps.post_id,s.normalized_url FROM post_sources ps JOIN sources s ON s.id=ps.source_id"
      ).all() as Row[];
      for(const link of mentions){
        const connectionId="legacy-"+hash(String(link.connector)).slice(0,20);
        this.db.prepare(
          "INSERT OR IGNORE INTO kb_mentions(project_id,connection_id,item_id,entity_key,evidence_json) VALUES(?,?,?,?,?)"
        ).run(legacyId,connectionId,String(link.post_id),String(link.normalized_url),
          JSON.stringify([{signal:"legacy-link",detail:"Imported from v0.4.0 post-source relationship"}]));
      }
      this.db.exec("COMMIT");
      return migrated;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
}
