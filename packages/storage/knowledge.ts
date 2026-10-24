import {createHash,randomUUID} from "node:crypto";
import {Store} from "./store.ts";
import {acquireLock} from "../core/lock.ts";
import {diffSnapshots,matchingRules,snapshot,sameJson} from "../core/change-tracking.ts";
import type {EntitySnapshot,ChangeEvent,WatchAlert} from "../core/change-tracking.ts";
import type {ChangeRule,JsonValue,JsonRecord} from "../sdk/contracts.ts";
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
      "CREATE TABLE IF NOT EXISTS kb_migration_state (name TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS kb_connections (project_id TEXT NOT NULL REFERENCES kb_projects(id),connection_id TEXT NOT NULL,adapter_id TEXT NOT NULL,config_hash TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,PRIMARY KEY(project_id,connection_id));" +
      "CREATE TABLE IF NOT EXISTS kb_observations (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,type TEXT NOT NULL,title TEXT,text TEXT,url TEXT,attributes_json TEXT NOT NULL,media_json TEXT NOT NULL,occurred_at TEXT,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,observation_json TEXT,PRIMARY KEY(project_id,connection_id,item_id),FOREIGN KEY(project_id,connection_id) REFERENCES kb_connections(project_id,connection_id));" +
      "CREATE TABLE IF NOT EXISTS kb_entities (project_id TEXT NOT NULL REFERENCES kb_projects(id),entity_key TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,url TEXT,attributes_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_mentions (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,entity_key TEXT NOT NULL,evidence_json TEXT NOT NULL,draft_json TEXT,observation_json TEXT,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(project_id,connection_id,item_id,entity_key),FOREIGN KEY(project_id,connection_id,item_id) REFERENCES kb_observations(project_id,connection_id,item_id),FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_mention_assessments (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,entity_key TEXT NOT NULL,category TEXT NOT NULL,score INTEGER NOT NULL,confidence REAL NOT NULL,reasons_json TEXT NOT NULL,evaluator_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,connection_id,item_id,entity_key),FOREIGN KEY(project_id,connection_id,item_id,entity_key) REFERENCES kb_mentions(project_id,connection_id,item_id,entity_key));" +
      "CREATE INDEX IF NOT EXISTS kb_current_assessment ON kb_mention_assessments(project_id,entity_key,score DESC,confidence DESC,connection_id,item_id);" +
      "CREATE TABLE IF NOT EXISTS kb_assessments (project_id TEXT NOT NULL,entity_key TEXT NOT NULL,category TEXT NOT NULL,score INTEGER NOT NULL,confidence REAL NOT NULL,reasons_json TEXT NOT NULL,evaluator_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,entity_key),FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE TABLE IF NOT EXISTS kb_assessment_history (id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,entity_key TEXT NOT NULL,category TEXT NOT NULL,score INTEGER NOT NULL,confidence REAL NOT NULL,reasons_json TEXT NOT NULL,evaluator_id TEXT NOT NULL,recorded_at TEXT NOT NULL,FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
       "CREATE INDEX IF NOT EXISTS kb_assessment_history_entity ON kb_assessment_history(project_id,entity_key,id DESC);" +
      "CREATE TABLE IF NOT EXISTS kb_entity_versions (id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,entity_key TEXT NOT NULL,connection_id TEXT,observation_id TEXT,snapshot_json TEXT NOT NULL,observed_at TEXT NOT NULL,FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE INDEX IF NOT EXISTS kb_versions_entity ON kb_entity_versions(project_id,entity_key,id DESC);" +
      "CREATE TABLE IF NOT EXISTS kb_entity_changes (id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,entity_key TEXT NOT NULL,connection_id TEXT NOT NULL,observation_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,before_json TEXT,after_json TEXT,observed_at TEXT NOT NULL,FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
      "CREATE INDEX IF NOT EXISTS kb_changes_project ON kb_entity_changes(project_id,id DESC);" +
       "CREATE INDEX IF NOT EXISTS kb_changes_entity ON kb_entity_changes(project_id,entity_key,id DESC);" +
      "CREATE TABLE IF NOT EXISTS kb_watch_alerts (id INTEGER PRIMARY KEY,change_id INTEGER NOT NULL REFERENCES kb_entity_changes(id),project_id TEXT NOT NULL,entity_key TEXT NOT NULL,rule_id TEXT NOT NULL,explanation TEXT NOT NULL,detected_at TEXT NOT NULL,UNIQUE(change_id,rule_id));" +
      "CREATE INDEX IF NOT EXISTS kb_alerts_project ON kb_watch_alerts(project_id,id DESC);" +
      "CREATE TABLE IF NOT EXISTS kb_observation_versions (id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,observation_json TEXT NOT NULL,content_hash TEXT NOT NULL,observed_at TEXT NOT NULL,FOREIGN KEY(project_id,connection_id,item_id) REFERENCES kb_observations(project_id,connection_id,item_id));" +
      "CREATE INDEX IF NOT EXISTS kb_observation_history ON kb_observation_versions(project_id,connection_id,item_id,id DESC);" +

      "CREATE TABLE IF NOT EXISTS kb_reviews (id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,entity_key TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,reviewed_at TEXT NOT NULL,legacy_review_id INTEGER UNIQUE,FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));" +
       "CREATE INDEX IF NOT EXISTS kb_reviews_lookup ON kb_reviews(project_id,entity_key,id DESC);" +
      "CREATE TABLE IF NOT EXISTS kb_runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,connection_id TEXT,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,observations INTEGER NOT NULL DEFAULT 0,new_entities INTEGER NOT NULL DEFAULT 0,duplicates INTEGER NOT NULL DEFAULT 0,error TEXT);" +
      "CREATE TABLE IF NOT EXISTS kb_checkpoints (project_id TEXT NOT NULL,connection_id TEXT NOT NULL,cursor TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,connection_id));" +
      "CREATE INDEX IF NOT EXISTS kb_entities_type ON kb_entities(project_id,type);" +
      "CREATE INDEX IF NOT EXISTS kb_mentions_entity ON kb_mentions(project_id,entity_key);" +
      "CREATE INDEX IF NOT EXISTS kb_assessments_score ON kb_assessments(project_id,score DESC);"
    );
    const columns=this.prepareCached("PRAGMA table_info(kb_connections)").all() as Array<{name:string}>;
    if(!columns.some(col=>col.name==="config_hash")){
      this.db.exec("ALTER TABLE kb_connections ADD COLUMN config_hash TEXT NOT NULL DEFAULT ''");
    }
    for(const [table,column,definition] of [
      ["kb_observations","observation_json","TEXT"],["kb_mentions","draft_json","TEXT"],
      ["kb_mentions","observation_json","TEXT"],["kb_mentions","active","INTEGER NOT NULL DEFAULT 1"]
    ]){
      const existing=this.prepareCached("PRAGMA table_info("+table+")").all() as Array<{name:string}>;
      if(!existing.some(entry=>entry.name===column)){
        this.db.exec("ALTER TABLE "+table+" ADD COLUMN "+column+" "+definition);
      }
    }
    // Older libraries add the complete observation JSON column above. The
    // partial index avoids scanning fully restored libraries on each reopen.
    this.db.exec("CREATE INDEX IF NOT EXISTS kb_missing_observation_json "+
      "ON kb_observations(project_id,connection_id,item_id) WHERE observation_json IS NULL");
    const legacy=this.migrateLegacy();
    this.restoreObservationSnapshots();
    // Baselines for pre-v0.8 libraries. These are NOT synthetic change alerts:
    // previous records are simply recorded as the initial known state.
    const done=this.prepareCached(
      "SELECT fingerprint FROM kb_migration_state WHERE name='entity-baselines-v0.8'"
    ).get() as {fingerprint:string}|undefined;
    if(!done||legacy.entities>0){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.prepareCached(
          "INSERT INTO kb_entity_versions(project_id,entity_key,snapshot_json,observed_at) "+
          "SELECT e.project_id,e.entity_key,json_object('type',e.type,'title',e.title,'url',e.url,"+
          "'attributes',json(e.attributes_json)),e.updated_at FROM kb_entities e "+
          "WHERE NOT EXISTS(SELECT 1 FROM kb_entity_versions v WHERE "+
          "v.project_id=e.project_id AND v.entity_key=e.entity_key)"
        ).run();
        this.prepareCached(
          "INSERT OR IGNORE INTO kb_migration_state(name,fingerprint) VALUES('entity-baselines-v0.8','done')"
        ).run();
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }

  }
  /** Repair current replay data only where an actual immutable snapshot exists. */
  private restoreObservationSnapshots():void{
    // Old aggregate scores cannot be attributed to a particular mention. Leave
    // them unchanged until collection/reprocessing supplies real assessments.
    // Likewise, no original draft or observation revision is invented here.
    this.prepareCached(
      "UPDATE kb_observations AS o SET "+
      "(observation_json,title,text,url,attributes_json,media_json,occurred_at)=("+
      "SELECT v.observation_json,json_extract(v.observation_json,'$.title'),"+
      "json_extract(v.observation_json,'$.text'),json_extract(v.observation_json,'$.url'),"+
      "COALESCE(json_extract(v.observation_json,'$.attributes'),'{}'),"+
      "COALESCE(json_extract(v.observation_json,'$.media'),'[]'),"+
      "json_extract(v.observation_json,'$.occurredAt') FROM kb_observation_versions v "+
      "WHERE v.project_id=o.project_id AND v.connection_id=o.connection_id AND v.item_id=o.item_id "+
      "ORDER BY v.id DESC LIMIT 1) WHERE o.observation_json IS NULL AND EXISTS("+
      "SELECT 1 FROM kb_observation_versions v WHERE v.project_id=o.project_id "+
      "AND v.connection_id=o.connection_id AND v.item_id=o.item_id)"
    ).run();
  }
  saveProject(project:ProjectDefinition):void{
    const date=now();
    // Deliberately NEVER persist adapter config; it can contain credentials.
    const fingerprint=hash(JSON.stringify(project));
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.prepareCached(
        "INSERT INTO kb_projects(id,name,config_hash,created_at,updated_at) VALUES(?,?,?,?,?) "+
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_hash=excluded.config_hash,updated_at=excluded.updated_at"
      ).run(project.id,project.name,fingerprint,date,date);
      for(const source of project.sources)this.saveConnection(project.id,source);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  saveConnection(projectId:string,source:ProjectSource):void{
    const fingerprint=hash(JSON.stringify(source.config));
    const existing=this.prepareCached(
      "SELECT adapter_id,config_hash FROM kb_connections WHERE project_id=? AND connection_id=?"
    ).get(projectId,source.id) as {adapter_id:string;config_hash:string}|undefined;
    if(existing&&existing.adapter_id!==source.adapter){
      throw new Error("Connection "+source.id+" changed adapter; create a new connection ID");
    }
    if(existing?.config_hash&&existing.config_hash!==fingerprint){
      throw new Error("Connection "+source.id+" changed source configuration; choose a new connection ID");
    }
    this.prepareCached(
      "INSERT OR IGNORE INTO kb_connections(project_id,connection_id,adapter_id,config_hash,created_at) VALUES(?,?,?,?,?)"
    ).run(projectId,source.id,source.adapter,fingerprint,now());
    if(existing&&!existing.config_hash){
      this.prepareCached(
        "UPDATE kb_connections SET config_hash=? WHERE project_id=? AND connection_id=?"
      ).run(fingerprint,projectId,source.id);
    }
  }
  listProjects():Row[]{
    return this.prepareCached(
      "SELECT p.id,p.name,p.updated_at,(SELECT count(*) FROM kb_entities e WHERE e.project_id=p.id) entities,"+
      "(SELECT count(*) FROM kb_observations o WHERE o.project_id=p.id) observations "+
      "FROM kb_projects p ORDER BY p.id"
    ).all() as Row[];
  }
  cursor(projectId:string,connectionId:string):string|undefined{
    const row=this.prepareCached(
      "SELECT cursor FROM kb_checkpoints WHERE project_id=? AND connection_id=?"
    ).get(projectId,connectionId) as {cursor:string|null}|undefined;
    return row?.cursor??undefined;
  }
  resetCursor(projectId:string,connectionId:string):void{
    const release=acquireLock(this.file+".lock");
    try{
      this.prepareCached("DELETE FROM kb_checkpoints WHERE project_id=? AND connection_id=?")
        .run(projectId,connectionId);
    }finally{release();}
  }
  beginRun(projectId:string,connectionId:string):string{
    const runId=randomUUID();
    this.prepareCached(
      "INSERT INTO kb_runs(id,project_id,connection_id,status,started_at) VALUES(?,?,?,'running',?)"
    ).run(runId,projectId,connectionId,now());
    return runId;
  }
  finishRun(runId:string,status:"success"|"partial"|"failed",counts:{
    observations:number;newEntities:number;duplicates:number
  },error?:string):void{
    this.prepareCached(
      "UPDATE kb_runs SET status=?,ended_at=?,observations=?,new_entities=?,duplicates=?,error=? WHERE id=?"
    ).run(status,now(),counts.observations,counts.newEntities,counts.duplicates,
      error?safe(error).slice(0,250):null,runId);
  }
  saveBatch(projectId:string,source:ProjectSource,items:Array<{
    observation:Observation;entities:Array<{draft:EntityDraft;assessment:Assessment}>;
  }>,nextCursor:string|undefined,evaluatorId:string,watchRules:readonly ChangeRule[]=[],
  protectObservationIdentity=false):{observations:number;newEntities:number;duplicates:number}{
    const count={observations:0,newEntities:0,duplicates:0};
    const date=now();
    const assessedEntities=new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const {observation,entities} of items){
        const observationContent=JSON.stringify(observation);
        const observationHash=hash(observationContent);
        const oldObservation=this.prepareCached(
          "SELECT o.type,o.observation_json, "+
          "(SELECT v.content_hash FROM kb_observation_versions v WHERE "+
          "v.project_id=o.project_id AND v.connection_id=o.connection_id AND v.item_id=o.item_id "+
          "ORDER BY v.id DESC LIMIT 1) latest_hash "+
          "FROM kb_observations o WHERE o.project_id=? AND o.connection_id=? AND o.item_id=?"
        ).get(projectId,source.id,observation.id) as {
          type:string;observation_json:string|null;latest_hash:string|null
        }|undefined;
        if(oldObservation&&oldObservation.type!==observation.type){
          throw new Error("Observation identity reused for a different type");
        }
        const priorMentions=this.prepareCached(
          "SELECT m.entity_key,m.draft_json,m.evidence_json,m.observation_json,"+
          "a.category,a.score,a.confidence,a.reasons_json,a.evaluator_id "+
          "FROM kb_mentions m LEFT JOIN kb_mention_assessments a "+
          "ON a.project_id=m.project_id AND a.connection_id=m.connection_id "+
          "AND a.item_id=m.item_id AND a.entity_key=m.entity_key "+
          "WHERE m.project_id=? AND m.connection_id=? AND m.item_id=? AND m.active=1"
        ).all(projectId,source.id,observation.id) as Array<{
          entity_key:string;draft_json:string|null;evidence_json:string;
          observation_json:string|null;category:string|null;score:number|null;
          confidence:number|null;reasons_json:string|null;evaluator_id:string|null
        }>;
        const priorClaims=new Map(priorMentions.map(mention=>[mention.entity_key,mention]));
        // No external output or process execution is skipped: processors and
        // evaluators already ran. Skip only redundant SQLite writes when the
        // complete observation, retained claims, current assessments and latest
        // immutable observation revision are all byte-for-byte identical.
        // Identity protection remains checked on every run for legacy keys.
        if(!protectObservationIdentity&&oldObservation?.observation_json===observationContent&&
          oldObservation.latest_hash===observationHash&&
          priorMentions.length===entities.length&&entities.every(({draft,assessment})=>{
            const prior=priorClaims.get(draft.key);
            return Boolean(prior&&prior.draft_json===JSON.stringify(draft)&&
              prior.evidence_json===JSON.stringify(draft.evidence||[])&&
              prior.observation_json===observationContent&&
              prior.evaluator_id===evaluatorId&&prior.category===assessment.category&&
              prior.score===assessment.score&&prior.confidence===assessment.confidence&&
              prior.reasons_json===JSON.stringify(assessment.reasons));
          })){
          // last_seen is the one field that must advance on a repeated read.
          this.prepareCached("UPDATE kb_observations SET last_seen=? "+
            "WHERE project_id=? AND connection_id=? AND item_id=?")
            .run(date,projectId,source.id,observation.id);
          count.observations++;
          count.duplicates+=1+entities.length;
          continue;
        }
        const priorDrafts=new Map(priorMentions.map(mention=>[mention.entity_key,mention.draft_json]));
        for(const mention of priorMentions)assessedEntities.add(mention.entity_key);
        // Only an actually received update can supersede this observation's
        // support. Missing records in a snapshot imply no deletion or closure.
        this.prepareCached("UPDATE kb_mentions SET active=0 WHERE project_id=? AND connection_id=? AND item_id=?")
          .run(projectId,source.id,observation.id);
        this.prepareCached("DELETE FROM kb_mention_assessments WHERE project_id=? AND connection_id=? AND item_id=?")
          .run(projectId,source.id,observation.id);
        const inserted=this.prepareCached(
          "INSERT OR IGNORE INTO kb_observations(project_id,connection_id,item_id,type,title,text,url,attributes_json,media_json,occurred_at,first_seen,last_seen,observation_json) "+
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(projectId,source.id,observation.id,observation.type,
          observation.title??null,observation.text??null,observation.url??null,
          JSON.stringify(observation.attributes||{}),JSON.stringify(observation.media||[]),
          observation.occurredAt??null,date,date,observationContent);
        this.prepareCached(
          "UPDATE kb_observations SET last_seen=?,title=?,text=?,url=?,attributes_json=?,media_json=?,occurred_at=?,observation_json=? "+
          "WHERE project_id=? AND connection_id=? AND item_id=?"
        ).run(date,observation.title??null,observation.text??null,observation.url??null,
          JSON.stringify(observation.attributes||{}),JSON.stringify(observation.media||[]),
          observation.occurredAt??null,observationContent,
          projectId,source.id,observation.id);
        // Immutable original evidence, once per distinct revision. A re-read of
        // the same snapshot never produces an additional history entry.
        if(oldObservation?.latest_hash!==observationHash){
          this.prepareCached(
            "INSERT INTO kb_observation_versions(project_id,connection_id,item_id,observation_json,content_hash,observed_at) "+
            "VALUES(?,?,?,?,?,?)"
          ).run(projectId,source.id,observation.id,observationContent,observationHash,date);
        }
        if(inserted.changes===0)count.duplicates++;
        count.observations++;
        for(const {draft,assessment} of entities){
          if(protectObservationIdentity&&draft.key===observation.type+":"+observation.id&&
            this.prepareCached("SELECT 1 FROM kb_mentions WHERE project_id=? AND entity_key=? "+
              "AND connection_id<>? LIMIT 1").get(projectId,draft.key,source.id)){
            throw new Error("Observation identity already belongs to another source; configure entityNamespace");
          }
          const oldEntity=this.prepareCached(
            "SELECT type,title,url,attributes_json FROM kb_entities WHERE project_id=? AND entity_key=?"
          ).get(projectId,draft.key) as {
            type:string;title:string;url:string|null;attributes_json:string
          }|undefined;
          if(oldEntity&&oldEntity.type!==draft.type){
            throw new Error("Entity identity reused for a different type");
          }
          const previous:EntitySnapshot|undefined=oldEntity?snapshot({
            type:oldEntity.type,title:oldEntity.title,url:oldEntity.url||undefined,
            attributes:JSON.parse(oldEntity.attributes_json) as JsonRecord
          }):undefined;
          const priorDraft=priorDrafts.get(draft.key);
          const repeatedClaim=previous&&priorDraft&&sameJson(
            snapshot(JSON.parse(priorDraft) as EntityDraft) as unknown as JsonValue,
            snapshot(draft) as unknown as JsonValue);
          // Re-reading an unchanged active claim must not undo a different
          // mention's newer change. Evidence still refreshes below; a claim
          // that was inactive is deliberately eligible to establish state again.
          // Missing fields in partial updates mean "not supplied", not deleted.
          // Explicit null values remain observable changes.
          const next=repeatedClaim?previous!:snapshot({
            type:draft.type,title:draft.title,url:draft.url||oldEntity?.url||undefined,
            attributes:{...(previous?.attributes||{}),...(draft.attributes||{})}
          });
          const changes=diffSnapshots(previous,next);
          const entity=this.prepareCached(
            "INSERT OR IGNORE INTO kb_entities(project_id,entity_key,type,title,url,attributes_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
          ).run(projectId,draft.key,next.type,next.title,next.url,
            JSON.stringify(next.attributes),date,date);
          if(entity.changes)count.newEntities++;
          else count.duplicates++;
          if(changes.length){
            this.prepareCached(
              "UPDATE kb_entities SET type=?,title=?,url=?,attributes_json=?,updated_at=? WHERE project_id=? AND entity_key=?"
            ).run(next.type,next.title,next.url,JSON.stringify(next.attributes),
              date,projectId,draft.key);
            this.prepareCached(
              "INSERT INTO kb_entity_versions(project_id,entity_key,connection_id,observation_id,snapshot_json,observed_at) "+
              "VALUES(?,?,?,?,?,?)"
            ).run(projectId,draft.key,source.id,observation.id,JSON.stringify(next),date);
            for(const change of changes){
              const created=this.prepareCached(
                "INSERT INTO kb_entity_changes(project_id,entity_key,connection_id,observation_id,path,kind,before_json,after_json,observed_at) "+
                "VALUES(?,?,?,?,?,?,?,?,?)"
              ).run(projectId,draft.key,source.id,observation.id,change.path,change.kind,
                change.before===undefined?null:JSON.stringify(change.before),
                change.after===undefined?null:JSON.stringify(change.after),date);
              const matches=matchingRules(change,previous,next,watchRules);
              for(const match of matches){
                this.prepareCached(
                  "INSERT INTO kb_watch_alerts(change_id,project_id,entity_key,rule_id,explanation,detected_at) "+
                  "VALUES(?,?,?,?,?,?)"
                ).run(Number(created.lastInsertRowid),projectId,draft.key,match.rule.id,
                  match.explanation,date);
              }
            }
          }
          this.prepareCached(
            "INSERT INTO kb_mentions(project_id,connection_id,item_id,entity_key,evidence_json,draft_json,observation_json,active) VALUES(?,?,?,?,?,?,?,1) "+
            "ON CONFLICT(project_id,connection_id,item_id,entity_key) DO UPDATE SET "+
            "evidence_json=excluded.evidence_json,draft_json=excluded.draft_json,"+
            "observation_json=excluded.observation_json,active=1"
          ).run(projectId,source.id,observation.id,draft.key,JSON.stringify(draft.evidence||[]),JSON.stringify(draft),
            observationContent);
          this.writeMentionAssessment(projectId,draft.key,source.id,observation.id,assessment,evaluatorId,date);
          assessedEntities.add(draft.key);
        }
      }
      for(const key of assessedEntities)this.refreshAssessment(projectId,key,date);
      this.prepareCached(
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
  listChanges(projectId:string,options:{limit?:number;offset?:number;entityKey?:string}={}):ChangeEvent[]{
    const limit=Number.isFinite(options.limit)?Math.max(1,Math.min(500,Math.floor(options.limit!))):100;
    const offset=Number.isFinite(options.offset)?Math.max(0,Math.min(1000000,Math.floor(options.offset!))):0;
    const rows=this.prepareCached(
      "SELECT id,project_id,entity_key,connection_id,observation_id,path,kind,before_json,after_json,observed_at "+
      "FROM kb_entity_changes WHERE project_id=? AND (? IS NULL OR entity_key=?) "+
      "ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(projectId,options.entityKey||null,options.entityKey||null,limit,offset) as Row[];
    return rows.map(row=>({
      id:Number(row.id),projectId:String(row.project_id),entityKey:String(row.entity_key),
      connectionId:String(row.connection_id),observationId:String(row.observation_id),
      path:String(row.path),kind:row.kind as ChangeEvent["kind"],
      before:json(row.before_json,undefined as JsonValue|undefined),
      after:json(row.after_json,undefined as JsonValue|undefined),
      observedAt:String(row.observed_at)
    }));
  }
  listAlerts(projectId:string,limit=100):WatchAlert[]{
    const safeLimit=Number.isFinite(limit)?Math.max(1,Math.min(500,Math.floor(limit))):100;
    const rows=this.prepareCached(
      "SELECT a.id,a.project_id,a.entity_key,a.change_id,a.rule_id,a.explanation,a.detected_at,"+
      "c.path,c.before_json,c.after_json FROM kb_watch_alerts a "+
      "JOIN kb_entity_changes c ON c.id=a.change_id WHERE a.project_id=? "+
      "ORDER BY a.id DESC LIMIT ?"
    ).all(projectId,safeLimit) as Row[];
    return rows.map(row=>({
      id:Number(row.id),projectId:String(row.project_id),entityKey:String(row.entity_key),
      changeId:Number(row.change_id),ruleId:String(row.rule_id),
      explanation:String(row.explanation),detectedAt:String(row.detected_at),
      path:String(row.path),before:json(row.before_json,undefined as JsonValue|undefined),
      after:json(row.after_json,undefined as JsonValue|undefined)
    }));
  }
  listVersions(projectId:string,entityKey:string,limit=50):Array<{
    id:number;observedAt:string;connectionId:string|null;observationId:string|null;
    snapshot:EntitySnapshot
  }>{
    const size=Number.isFinite(limit)?Math.max(1,Math.min(100,Math.floor(limit))):50;
    const rows=this.prepareCached(
      "SELECT id,observed_at,connection_id,observation_id,snapshot_json FROM kb_entity_versions "+
      "WHERE project_id=? AND entity_key=? ORDER BY id DESC LIMIT ?"
    ).all(projectId,entityKey,size) as Row[];
    return rows.map(row=>({
      id:Number(row.id),observedAt:String(row.observed_at),
      connectionId:row.connection_id===null?null:String(row.connection_id),
      observationId:row.observation_id===null?null:String(row.observation_id),
      snapshot:JSON.parse(String(row.snapshot_json)) as EntitySnapshot
    }));
  }
  listEntities(projectId:string,opts:{limit?:number;offset?:number;type?:string;q?:string;minScore?:number}={}):KnowledgeEntity[]{
    const limit=Number.isFinite(opts.limit)?Math.max(1,Math.min(500,Math.floor(opts.limit!))):100;
    const offset=Number.isFinite(opts.offset)?Math.max(0,Math.min(1000000,Math.floor(opts.offset!))):0;
    const q=opts.q?"%"+opts.q.slice(0,100)+"%":null;
    const rows=this.prepareCached(
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
    const rows=this.prepareCached(
      "SELECT e.project_id,e.entity_key,e.type,e.title,e.url,e.attributes_json,e.updated_at,a.category,a.score,a.confidence,a.reasons_json,"+
      "COALESCE((SELECT CASE WHEN r.decision IN ('approved','excellent') THEN 'approved' WHEN r.decision='rejected' THEN 'rejected' ELSE 'pending' END FROM kb_reviews r WHERE r.project_id=e.project_id AND r.entity_key=e.entity_key ORDER BY r.id DESC LIMIT 1),'pending') review,"+
      "(SELECT COUNT(*) FROM kb_mentions m WHERE m.project_id=e.project_id AND m.entity_key=e.entity_key) observation_count "+
      "FROM kb_entities e LEFT JOIN kb_assessments a ON a.project_id=e.project_id AND a.entity_key=e.entity_key "+
      "WHERE e.project_id=? AND e.entity_key=?"
    ).get(projectId,key) as Row|undefined;
    return rows?asKnowledge(rows):undefined;
  }
  entityEvidence(projectId:string,key:string):{
    entity:KnowledgeEntity;mentions:Array<Record<string,unknown>>;
    reviews:Array<Record<string,unknown>>;assessments:Array<Record<string,unknown>>
  }|undefined{
    const entity=this.getEntity(projectId,key);
    if(!entity)return undefined;
    const mentions=(this.prepareCached(
      "SELECT m.connection_id,m.item_id,o.type,o.title,o.url,o.occurred_at,"+
      "m.evidence_json,m.observation_json,m.active,o.first_seen,o.last_seen "+
      "FROM kb_mentions m JOIN kb_observations o ON "+
      "o.project_id=m.project_id AND o.connection_id=m.connection_id AND o.item_id=m.item_id "+
      "WHERE m.project_id=? AND m.entity_key=? "+
      "ORDER BY o.last_seen DESC LIMIT 50"
    ).all(projectId,key) as Row[]).map(row=>{
      const original=json<Observation|undefined>(row.observation_json,undefined);
      return {connectionId:row.connection_id,itemId:row.item_id,type:row.type,
        title:original?original.title??null:row.title,
        url:original?original.url??null:row.url,
        occurredAt:original?original.occurredAt??null:row.occurred_at,
        firstSeen:row.first_seen,lastSeen:row.last_seen,active:Boolean(row.active),
        evidence:json(row.evidence_json,[])};
    });
    const reviews=(this.prepareCached(
      "SELECT decision,reason,reviewed_at FROM kb_reviews WHERE project_id=? "+
      "AND entity_key=? ORDER BY id DESC LIMIT 30"
    ).all(projectId,key) as Row[]).map(row=>({
      decision:row.decision,reason:row.reason,date:row.reviewed_at
    }));
    const assessments=(this.prepareCached(
      "SELECT category,score,confidence,reasons_json,evaluator_id,recorded_at "+
      "FROM kb_assessment_history WHERE project_id=? AND entity_key=? "+
      "ORDER BY id DESC LIMIT 30"
    ).all(projectId,key) as Row[]).map(row=>({
      category:row.category,score:row.score,confidence:row.confidence,
      reasons:json(row.reasons_json,[]),evaluatorId:row.evaluator_id,
      date:row.recorded_at
    }));
    return {entity,mentions,reviews,assessments};
  }
  listObservations(projectId:string,limit=100):Row[]{
    return this.prepareCached(
      "SELECT connection_id,item_id,type,title,text,url,occurred_at,first_seen,last_seen "+
      "FROM kb_observations WHERE project_id=? ORDER BY last_seen DESC LIMIT ?"
    ).all(projectId,Math.max(1,Math.min(500,Math.floor(limit)))) as Row[];
  }
  runs(projectId:string,limit=50):Row[]{
    return this.prepareCached(
      "SELECT id,connection_id,status,started_at,ended_at,observations,new_entities,duplicates,error "+
      "FROM kb_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?"
    ).all(projectId,Math.max(1,Math.min(100,Math.floor(limit)))) as Row[];
  }
  reviewEntity(projectId:string,key:string,decision:"approved"|"rejected"|"pending",reason:string):KnowledgeEntity{
    if(!reason.trim()||reason.length>1000)throw new Error("A review reason is required (max 1000 characters)");
    if(!["approved","rejected","pending"].includes(decision))throw new Error("Invalid review decision");
    const release=acquireLock(this.file+".lock");
    try{
      if(!this.getEntity(projectId,key))throw new Error("Knowledge entity not found");
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.prepareCached(
          "INSERT INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at) VALUES(?,?,?,?,?)"
        ).run(projectId,key,decision,reason,now());
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
      return this.getEntity(projectId,key)!;
    }finally{release();}
  }
  private writeMentionAssessment(projectId:string,key:string,connectionId:string,itemId:string,
    value:Assessment,evaluator:string,date:string):void{
    this.prepareCached(
      "INSERT INTO kb_mention_assessments(project_id,connection_id,item_id,entity_key,"+
      "category,score,confidence,reasons_json,evaluator_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) "+
      "ON CONFLICT(project_id,connection_id,item_id,entity_key) DO UPDATE SET "+
      "category=excluded.category,score=excluded.score,confidence=excluded.confidence,"+
      "reasons_json=excluded.reasons_json,evaluator_id=excluded.evaluator_id,updated_at=excluded.updated_at"
    ).run(projectId,connectionId,itemId,key,value.category,value.score,value.confidence,
      JSON.stringify(value.reasons),evaluator,date);
  }
  private refreshAssessment(projectId:string,key:string,date:string):void{
    const current=this.prepareCached(
      "SELECT a.category,a.score,a.confidence,a.reasons_json,a.evaluator_id FROM kb_mention_assessments a "+
      "JOIN kb_mentions m ON m.project_id=a.project_id AND m.connection_id=a.connection_id "+
      "AND m.item_id=a.item_id AND m.entity_key=a.entity_key "+
      "WHERE a.project_id=? AND a.entity_key=? AND m.active=1 "+
      "ORDER BY a.score DESC,a.confidence DESC,a.connection_id,a.item_id LIMIT 1"
    ).get(projectId,key) as {category:string;score:number;confidence:number;
      reasons_json:string;evaluator_id:string}|undefined;
    if(!current){
      this.writeAssessment(projectId,key,{category:"unassessed",score:0,confidence:0,
        reasons:["No current assessment is available from an active source mention"]},
        "engine-no-active-evidence",date);
      return;
    }
    // Copy one complete assessment. Separate maxima would combine a score and
    // confidence that no evaluator ever produced, and retain obsolete highs.
    this.writeAssessment(projectId,key,{category:current.category,score:current.score,
      confidence:current.confidence,reasons:JSON.parse(current.reasons_json) as string[]},
      current.evaluator_id,date);
  }
  /** Preserve the existing one-entity public API for custom SDK consumers. */
  updateMentionAssessments(projectId:string,key:string,values:Array<{
    connectionId:string;observationId:string;assessment:Assessment
  }>,evaluator:string):void{
    if(!values.length)return;
    this.updateMentionAssessmentsBatch(projectId,[{key,values}],evaluator);
  }
  /**
   * Reassessment is transactionally committed in bounded groups. This avoids
   * one BEGIN/COMMIT for every unchanged entity while retaining crash-safe
   * checkpoints between groups and preserving all independent human reviews.
   */
  updateMentionAssessmentsBatch(projectId:string,batch:readonly {
    key:string;values:Array<{connectionId:string;observationId:string;assessment:Assessment}>
  }[],evaluator:string):void{
    if(!batch.length)return;
    if(batch.length>100)throw new Error("Reassessment batch exceeds 100 entities");
    const date=now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const {key,values} of batch){
        if(!values.length)continue;
        this.prepareCached("DELETE FROM kb_mention_assessments WHERE project_id=? AND entity_key=?")
          .run(projectId,key);
        for(const value of values){
          this.writeMentionAssessment(projectId,key,value.connectionId,value.observationId,
            value.assessment,evaluator,date);
        }
        this.refreshAssessment(projectId,key,date);
      }
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private writeAssessment(projectId:string,key:string,value:Assessment,evaluator:string,date:string):void{
    const previous=this.prepareCached(
      "SELECT category,score,confidence,reasons_json,evaluator_id FROM kb_assessments "+
      "WHERE project_id=? AND entity_key=?"
    ).get(projectId,key) as {category:string;score:number;confidence:number;
      reasons_json:string;evaluator_id:string}|undefined;
    const reasons=JSON.stringify(value.reasons);
    this.prepareCached(
      "INSERT INTO kb_assessments(project_id,entity_key,category,score,confidence,reasons_json,evaluator_id,updated_at) "+
      "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,entity_key) DO UPDATE SET "+
      "category=excluded.category,score=excluded.score,confidence=excluded.confidence,"+
      "reasons_json=excluded.reasons_json,evaluator_id=excluded.evaluator_id,updated_at=excluded.updated_at"
    ).run(projectId,key,value.category,value.score,value.confidence,reasons,evaluator,date);
    if(!previous||previous.category!==value.category||previous.score!==value.score||
      previous.confidence!==value.confidence||previous.reasons_json!==reasons||
      previous.evaluator_id!==evaluator){
      this.prepareCached(
        "INSERT INTO kb_assessment_history(project_id,entity_key,category,score,confidence,reasons_json,evaluator_id,recorded_at) "+
        "VALUES(?,?,?,?,?,?,?,?)"
      ).run(projectId,key,value.category,value.score,value.confidence,reasons,evaluator,date);
    }
  }
  updateAssessment(projectId:string,key:string,value:Assessment,evaluator:string):void{
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.writeAssessment(projectId,key,value,evaluator,now());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  /**
   * Import the v0.4.0 database in place. The old schema remains intact and all
   * inserts are idempotent; opening the database again also migrates later posts.
   */
  migrateLegacy():{observations:number;entities:number}{
    const migrated={observations:0,entities:0};
    const state=this.prepareCached(
      "SELECT "+
      "(SELECT COUNT(*) FROM posts) posts,"+
      "(SELECT COUNT(*) FROM sources) sources,"+
      "(SELECT COUNT(*) FROM post_sources) links,"+
      "(SELECT COUNT(*) FROM reviews) reviews,"+
      "(SELECT MAX(updated_at) FROM sources) latest_source,"+
      "(SELECT MAX(last_seen) FROM posts) latest_post"
    ).get() as Record<string,unknown>;
    if(!Number(state.posts)&&!Number(state.sources))return migrated;
    const fingerprint=hash(JSON.stringify(state));
    const previous=this.prepareCached(
      "SELECT fingerprint FROM kb_migration_state WHERE name='legacy-v0.4'"
    ).get() as {fingerprint:string}|undefined;
    if(previous?.fingerprint===fingerprint)return migrated;
    const legacyId="legacy-x-feed",date=now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.prepareCached(
        "INSERT OR IGNORE INTO kb_projects(id,name,config_hash,created_at,updated_at) VALUES(?,?,?,?,?)"
      ).run(legacyId,"Legacy X Feed Scraper","legacy-v0.4.0",date,date);
      const posts=this.prepareCached(
        "SELECT id,connector,url,author,username,text,published_at,images_json,first_seen,last_seen FROM posts"
      ).all() as Row[];
      for(const post of posts){
        const connectionId="legacy-"+hash(String(post.connector)).slice(0,20);
        this.prepareCached(
          "INSERT OR IGNORE INTO kb_connections(project_id,connection_id,adapter_id,config_hash,created_at) VALUES(?,?,?,?,?)"
        ).run(legacyId,connectionId,"legacy",hash("legacy:"+String(post.connector)),date);
        const result=this.prepareCached(
          "INSERT OR IGNORE INTO kb_observations(project_id,connection_id,item_id,type,title,text,url,attributes_json,media_json,occurred_at,first_seen,last_seen) "+
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(legacyId,connectionId,String(post.id),"post",String(post.author||""),
          String(post.text||""),post.url?String(post.url):null,
          JSON.stringify({author:String(post.author||""),username:String(post.username||"")}),
          String(post.images_json||"[]"),post.published_at?String(post.published_at):null,
          String(post.first_seen||date),String(post.last_seen||date));
        if(result.changes)migrated.observations++;
      }
      const sources=this.prepareCached("SELECT * FROM sources").all() as Row[];
      for(const source of sources){
        const key=String(source.normalized_url);
        const result=this.prepareCached(
          "INSERT OR IGNORE INTO kb_entities(project_id,entity_key,type,title,url,attributes_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        ).run(legacyId,key,"web-resource",String(source.title||key),key,
          JSON.stringify({description:String(source.description||""),license:String(source.license||""),
            access:String(source.access||"unknown")}),String(source.first_seen||date),String(source.updated_at||date));
        if(result.changes)migrated.entities++;
        this.prepareCached(
          "INSERT OR IGNORE INTO kb_assessments(project_id,entity_key,category,score,confidence,reasons_json,evaluator_id,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        ).run(legacyId,key,String(source.category||"uncategorized"),Number(source.score||0),
          Number(source.confidence||0),String(source.reasons||"[]"),"legacy-heuristic",String(source.updated_at||date));
        const reviews=this.prepareCached(
          "SELECT id,decision,reason,reviewed_at FROM reviews WHERE source_id=? ORDER BY id"
        ).all(Number(source.id)) as Row[];
        for(const review of reviews){
          this.prepareCached(
            "INSERT OR IGNORE INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at,legacy_review_id) VALUES(?,?,?,?,?,?)"
          ).run(legacyId,key,String(review.decision),String(review.reason),String(review.reviewed_at||date),Number(review.id));
        }
        // Old schema can contain directly approved status with no review history.
        if(!reviews.length&&["approved","rejected"].includes(String(source.status))){
          this.prepareCached(
            "INSERT OR IGNORE INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at,legacy_review_id) VALUES(?,?,?,?,?,?)"
          ).run(legacyId,key,String(source.status),"Imported from original source status",String(source.updated_at||date),
            -Number(source.id));
        }
      }
      const mentions=this.prepareCached(
        "SELECT ps.connector,ps.post_id,s.normalized_url FROM post_sources ps JOIN sources s ON s.id=ps.source_id"
      ).all() as Row[];
      for(const link of mentions){
        const connectionId="legacy-"+hash(String(link.connector)).slice(0,20);
        this.prepareCached(
          "INSERT OR IGNORE INTO kb_mentions(project_id,connection_id,item_id,entity_key,evidence_json) VALUES(?,?,?,?,?)"
        ).run(legacyId,connectionId,String(link.post_id),String(link.normalized_url),
          JSON.stringify([{signal:"legacy-link",detail:"Imported from v0.4.0 post-source relationship"}]));
      }
      this.prepareCached(
        "INSERT INTO kb_migration_state(name,fingerprint) VALUES('legacy-v0.4',?) "+
        "ON CONFLICT(name) DO UPDATE SET fingerprint=excluded.fingerprint"
      ).run(fingerprint);
      this.db.exec("COMMIT");
      return migrated;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
}
