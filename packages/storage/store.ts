import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
import type {Access, Evaluation, Metadata, Post, Source, Status} from "../core/types.ts";
import {normalizeUrl} from "../core/url.ts";
import {acquireLock} from "../core/lock.ts";

type Row = Record<string, unknown>;
function asSource(row: Row): Source {
  return {
    id: Number(row.id), url: String(row.normalized_url), title: String(row.title || ""),
    description: typeof row.description === "string" ? row.description : undefined,
    license: typeof row.license === "string" ? row.license : undefined,
    contentType: typeof row.content_type === "string" ? row.content_type : undefined,
    category: String(row.category || "uncategorized"), access: String(row.access) as Source["access"],
    score: Number(row.score), confidence: Number(row.confidence), status: String(row.status) as Status,
    reasons: JSON.parse(String(row.reasons || "[]")) as string[],
    firstSeen: String(row.first_seen), postUrl: row.post_url ? String(row.post_url) : undefined,
    author: row.author ? String(row.author) : undefined
  };
}
export class Store {
  readonly db: DatabaseSync;
  readonly file: string;
  constructor(file: string) {
    this.file=file;
    mkdirSync(dirname(file), {recursive: true});
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, connector TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, posts_seen INTEGER DEFAULT 0, sources_new INTEGER DEFAULT 0, duplicates INTEGER DEFAULT 0, error TEXT);" +
      "CREATE TABLE IF NOT EXISTS posts (id TEXT NOT NULL, connector TEXT NOT NULL, url TEXT, author TEXT, username TEXT, text TEXT, published_at TEXT, images_json TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, processing_status TEXT, PRIMARY KEY(connector,id));" +
      "CREATE TABLE IF NOT EXISTS sightings (run_id TEXT NOT NULL REFERENCES runs(id), connector TEXT NOT NULL, post_id TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY(run_id,connector,post_id), FOREIGN KEY(connector,post_id) REFERENCES posts(connector,id));" +
      "CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, normalized_url TEXT NOT NULL UNIQUE, title TEXT, description TEXT, content_type TEXT, license TEXT, category TEXT, access TEXT NOT NULL DEFAULT 'unknown', score INTEGER NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'discovered', reasons TEXT NOT NULL DEFAULT '[]', first_seen TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS post_sources (connector TEXT NOT NULL, post_id TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources(id), PRIMARY KEY(connector,post_id,source_id), FOREIGN KEY(connector,post_id) REFERENCES posts(connector,id));" +
      "CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), decision TEXT NOT NULL, reason TEXT NOT NULL, reviewed_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id), post_id TEXT, message TEXT NOT NULL, occurred_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS checkpoints (connector TEXT PRIMARY KEY, last_run_id TEXT, updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS exported_notes (vault_id TEXT NOT NULL, note_path TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(vault_id,note_path));" +
      "CREATE TABLE IF NOT EXISTS enrichment_attempts (source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT);" +
      "CREATE INDEX IF NOT EXISTS idx_source_status_score ON sources(status,score DESC);" +
      "CREATE INDEX IF NOT EXISTS idx_sightings_post ON sightings(connector,post_id);" +
      "CREATE INDEX IF NOT EXISTS idx_post_sources_source ON post_sources(source_id);"
    );
    const reviewColumns=this.db.prepare("PRAGMA table_info(reviews)").all() as Array<{name:string}>;
    if(!reviewColumns.some(c=>c.name==="access")){
      this.db.exec("ALTER TABLE reviews ADD COLUMN access TEXT");
    }
  }
  close(): void {this.db.close();}
  begin(connector: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO runs (id,connector,started_at,status) VALUES (?,?,?,'running')").run(id,connector,new Date().toISOString());
    return id;
  }
  finish(id: string, state: "success"|"failed"|"partial", posts: number, sources: number, duplicates: number, error?: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE runs SET ended_at=?, status=?, posts_seen=?, sources_new=?, duplicates=?, error=? WHERE id=?")
      .run(now,state,posts,sources,duplicates,error || null,id);
    if (state === "success") {
      const row = this.db.prepare("SELECT connector FROM runs WHERE id=?").get(id) as Row;
      this.db.prepare("INSERT INTO checkpoints(connector,last_run_id,updated_at) VALUES(?,?,?) ON CONFLICT(connector) DO UPDATE SET last_run_id=excluded.last_run_id,updated_at=excluded.updated_at")
        .run(row.connector as string,id,now);
    }
  }
  savePost(runId: string, connector: string, post: Post): boolean {
    if (!post.id?.trim() || !post.url?.trim()) throw new Error("Post requires nonempty ID and URL");
    // Never store raw post/media URLs containing fragments or credential-bearing query parameters.
    const postUrl=normalizeUrl(post.url);
    const images:string[]=[];
    for(const raw of post.images||[]){
      try{images.push(normalizeUrl(raw));}
      catch{/* Images with unsafe or non-web URLs are not exported. */}
      if(images.length>=30)break;
    }
    const now = new Date().toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO posts(id,connector,url,author,username,text,published_at,images_json,first_seen,last_seen,processing_status) VALUES (?,?,?,?,?,?,?,?,?,?,'processing')")
      .run(post.id, connector, postUrl, post.author, post.username, post.text, post.publishedAt || null, JSON.stringify(images), now, now);
    this.db.prepare("UPDATE posts SET last_seen=? WHERE id=? AND connector=?").run(now,post.id,connector);
    this.db.prepare("INSERT OR IGNORE INTO sightings(run_id,connector,post_id,seen_at) VALUES(?,?,?,?)").run(runId,connector,post.id,now);
    return result.changes > 0;
  }
  markProcessed(connector: string, postId: string): void {
    this.db.prepare("UPDATE posts SET processing_status='processed' WHERE connector=? AND id=?").run(connector,postId);
  }
  addSource(connector: string, postId: string, url: string, title: string, value: Evaluation): {id:number; fresh:boolean} {
    const now = new Date().toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO sources(normalized_url,title,category,access,score,confidence,status,reasons,first_seen,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(url,title,value.category,value.access,value.score,value.confidence,value.status,JSON.stringify(value.reasons),now,now);
    const row = this.db.prepare("SELECT id FROM sources WHERE normalized_url=?").get(url) as Row;
    const id = Number(row.id);
    this.db.prepare("INSERT OR IGNORE INTO post_sources(connector,post_id,source_id) VALUES(?,?,?)").run(connector,postId,id);
    return {id, fresh:result.changes > 0};
  }
  repointSource(id:number,canonicalUrl:string):number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing=this.db.prepare("SELECT id FROM sources WHERE normalized_url=?").get(canonicalUrl) as Row|undefined;
      if (!existing) {
        this.db.prepare("UPDATE sources SET normalized_url=?,updated_at=? WHERE id=?").run(canonicalUrl,new Date().toISOString(),id);
        this.db.exec("COMMIT");return id;
      }
      const target=Number(existing.id);
      if (target!==id) {
        this.db.prepare("INSERT OR IGNORE INTO post_sources(connector,post_id,source_id) SELECT connector,post_id,? FROM post_sources WHERE source_id=?").run(target,id);
        this.db.prepare("DELETE FROM post_sources WHERE source_id=?").run(id);
        this.db.prepare("UPDATE reviews SET source_id=? WHERE source_id=?").run(target,id);
        this.db.prepare("DELETE FROM sources WHERE id=?").run(id);
      }
      this.db.exec("COMMIT");
      return target;
    } catch(e) {this.db.exec("ROLLBACK");throw e;}
  }
  updateEvaluation(id: number, metadata: Metadata, evaluation: Evaluation): void {
    const old = this.db.prepare("SELECT status FROM sources WHERE id=?").get(id) as Row | undefined;
    if (!old) throw new Error("Source not found");
    if (old.status === "approved" || old.status === "rejected") return;
    this.db.prepare("UPDATE sources SET title=COALESCE(?,title),description=COALESCE(?,description),content_type=COALESCE(?,content_type),license=COALESCE(?,license),category=?,access=?,score=?,confidence=?,status=?,reasons=?,updated_at=? WHERE id=?")
      .run(metadata.title || null,metadata.description || null,metadata.contentType || null,metadata.license || null,
        evaluation.category,evaluation.access,evaluation.score,evaluation.confidence,evaluation.status,
        JSON.stringify(evaluation.reasons),new Date().toISOString(),id);
  }
  error(runId: string, postId: string, message: string): void {
    const sanitized=message
      .replace(/https?:\/\/[^\s'"<>]+/gi,"[redacted-url]")
      .replace(/\bBearer\s+[a-z0-9._~+/-]+/gi,"Bearer [redacted]")
      .replace(/(?:token|password|secret|cookie|session|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"[redacted-credential]");
    this.db.prepare("INSERT INTO errors(run_id,post_id,message,occurred_at) VALUES(?,?,?,?)")
      .run(runId,postId,sanitized.slice(0,300),new Date().toISOString());
  }
  recentErrors(limit=20):Row[]{
    return this.db.prepare(
      "SELECT occurred_at,message FROM errors ORDER BY id DESC LIMIT ?"
    ).all(Math.min(100,Math.max(1,Math.floor(limit)))) as Row[];
  }
  getSource(id: number): Source | undefined {
    const row = this.db.prepare("SELECT s.*,p.url post_url,p.author FROM sources s LEFT JOIN post_sources ps ON ps.source_id=s.id LEFT JOIN posts p ON p.id=ps.post_id AND p.connector=ps.connector WHERE s.id=? LIMIT 1").get(id) as Row|undefined;
    return row ? asSource(row) : undefined;
  }
  listSources(status?: string, search?: string, limit = 100, offset = 0): Source[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500,Math.floor(limit))) : 100;
    const safeOffset = Number.isFinite(offset) ? Math.max(0,Math.min(1000000,Math.floor(offset))) : 0;
    const query = "SELECT s.*, (SELECT p.url FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id LIMIT 1) post_url," +
      " (SELECT p.author FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id LIMIT 1) author FROM sources s" +
      " WHERE (? IS NULL OR s.status=?) AND (? IS NULL OR (s.title LIKE ? OR s.normalized_url LIKE ? OR s.category LIKE ?)) ORDER BY s.score DESC,s.first_seen DESC LIMIT ? OFFSET ?";
    const q = search ? "%" + search.slice(0,100) + "%" : null;
    return (this.db.prepare(query).all(status || null,status || null,q,q,q,q,safeLimit,safeOffset) as Row[]).map(asSource);
  }
  pendingForEnrichment(limit=20,manual=true):Source[] {
    const safeLimit=Math.max(1,Math.min(100,Math.floor(limit)));
    const rows=this.db.prepare(
      "SELECT s.*, "+
      "(SELECT p.url FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id LIMIT 1) post_url,"+
      "(SELECT p.author FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id LIMIT 1) author "+
      "FROM sources s LEFT JOIN enrichment_attempts ea ON ea.source_id=s.id "+
      "WHERE s.status NOT IN ('approved','rejected') "+
      "AND s.category NOT IN ('existing_reference','excluded') "+
      "AND (s.description IS NULL OR s.description='') "+
      "AND (?=1 OR (COALESCE(ea.attempts,0)<3 AND "+
      "(ea.next_attempt_at IS NULL OR ea.next_attempt_at<=?))) "+
      "ORDER BY s.score DESC LIMIT ?"
    ).all(manual?1:0,new Date().toISOString(),safeLimit) as Row[];
    return rows.map(asSource);
  }
  markMetadataAttempt(id:number,error?:string):void {
    if(error){
      const previous=this.db.prepare("SELECT attempts FROM enrichment_attempts WHERE source_id=?")
        .get(id) as {attempts:number}|undefined;
      const attempt=Math.min(3,(previous?.attempts||0)+1);
      const after=new Date(Date.now()+3600000*Math.pow(2,attempt-1)).toISOString();
      this.db.prepare(
        "INSERT INTO enrichment_attempts(source_id,attempts,next_attempt_at,last_error) VALUES(?,?,?,?) "+
        "ON CONFLICT(source_id) DO UPDATE SET attempts=excluded.attempts,"+
        "next_attempt_at=excluded.next_attempt_at,last_error=excluded.last_error"
      ).run(id,attempt,after,error.slice(0,200));
    }else{
      const next=new Date(Date.now()+7*86400000).toISOString();
      this.db.prepare(
        "INSERT INTO enrichment_attempts(source_id,attempts,next_attempt_at,last_error) VALUES(?,0,?,NULL) "+
        "ON CONFLICT(source_id) DO UPDATE SET attempts=0,next_attempt_at=excluded.next_attempt_at,last_error=NULL"
      ).run(id,next);
    }
  }
  listSourcesPage(offset=0,limit=200):Source[] {
    const safeOffset=Math.max(0,Math.floor(offset));
    const safeLimit=Math.max(1,Math.min(500,Math.floor(limit)));
    const rows=this.db.prepare(
      "SELECT s.*,"+
      "(SELECT p.url FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id LIMIT 1) post_url,"+
      "(SELECT p.author FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id LIMIT 1) author "+
      "FROM sources s ORDER BY s.id ASC LIMIT ? OFFSET ?"
    ).all(safeLimit,safeOffset) as Row[];
    return rows.map(asSource);
  }
  getExportHash(vaultId:string,relativePath:string):string|undefined {
    const row=this.db.prepare("SELECT content_hash FROM exported_notes WHERE vault_id=? AND note_path=?")
      .get(vaultId,relativePath) as {content_hash:string}|undefined;
    return row?.content_hash;
  }
  recordExport(vaultId:string,relativePath:string,hash:string):void {
    this.db.prepare(
      "INSERT INTO exported_notes(vault_id,note_path,content_hash,updated_at) VALUES(?,?,?,?) "+
      "ON CONFLICT(vault_id,note_path) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at"
    ).run(vaultId,relativePath,hash,new Date().toISOString());
  }
  clearExport(vaultId:string,relativePath:string):void {
    this.db.prepare("DELETE FROM exported_notes WHERE vault_id=? AND note_path=?").run(vaultId,relativePath);
  }
  listVisualPosts(limit=200):Row[] {
    return this.db.prepare(
      "SELECT p.id,p.connector,p.url,p.author,p.username,p.images_json,p.first_seen "+
      "FROM posts p WHERE p.images_json != '[]' AND NOT EXISTS "+
      "(SELECT 1 FROM post_sources ps WHERE ps.connector=p.connector AND ps.post_id=p.id) "+
      "ORDER BY p.last_seen DESC LIMIT ?"
    ).all(Math.max(1,Math.min(1000,Math.floor(limit)))) as Row[];
  }
  listPosts(limit=100): Row[] {return this.db.prepare("SELECT id,connector,url,author,username,text,first_seen,last_seen,processing_status FROM posts ORDER BY last_seen DESC LIMIT ?").all(Math.min(500,Math.max(1,limit))) as Row[];}
  review(id: number, decision: "approved"|"rejected"|"needs_review"|"excellent", reason: string, access?:Access): Source {
    if (!reason.trim()) throw new Error("Review reason is required");
    if(access && !["unknown","free","open_source","freemium","paid"].includes(access)) throw new Error("Invalid access classification");
    const release=acquireLock(this.file+".lock");
    try{
    const source = this.getSource(id);
    if (!source) throw new Error("Source not found");
    const status = decision === "excellent" ? "approved" : decision;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO reviews(source_id,decision,reason,reviewed_at,access) VALUES(?,?,?,?,?)")
        .run(id,decision,reason.slice(0,1000),new Date().toISOString(),access||null);
      this.db.prepare("UPDATE sources SET status=?,access=COALESCE(?,access),updated_at=? WHERE id=?")
        .run(status,access||null,new Date().toISOString(),id);
      this.db.exec("COMMIT");
    } catch (e) {this.db.exec("ROLLBACK");throw e;}
    return this.getSource(id)!;
    }finally{release();}
  }
  getMetadata(id: number): Metadata & {context: string} {
    const row = this.db.prepare("SELECT s.*,COALESCE((SELECT group_concat(p.text,' ') FROM post_sources ps JOIN posts p ON p.connector=ps.connector AND p.id=ps.post_id WHERE ps.source_id=s.id),'') context FROM sources s WHERE s.id=?").get(id) as Row | undefined;
    if (!row) throw new Error("Source not found");
    return {title: row.title as string,description: row.description as string,contentType:row.content_type as string,
      license:row.license as string,access:row.access as Metadata["access"],context:String(row.context)};
  }
  preferenceBoost(category: string): number {
    const row = this.db.prepare("SELECT SUM(CASE WHEN r.decision='excellent' THEN 2 WHEN r.decision='approved' THEN 1 ELSE -1 END) boost FROM reviews r JOIN sources s ON s.id=r.source_id WHERE s.category=?").get(category) as Row;
    return Math.max(-8,Math.min(8,Number(row.boost || 0)*2));
  }
  stats(): Row {
    const counts = this.db.prepare("SELECT (SELECT count(*) FROM posts) posts,(SELECT count(*) FROM posts p WHERE p.images_json != '[]' AND NOT EXISTS (SELECT 1 FROM post_sources ps WHERE ps.connector=p.connector AND ps.post_id=p.id)) visuals,(SELECT count(*) FROM sources) sources,(SELECT count(*) FROM post_sources) links,(SELECT count(*) FROM sources WHERE status='high_quality') high_quality,(SELECT count(*) FROM sources WHERE status='needs_review') needs_review,(SELECT count(*) FROM sources WHERE status='approved') approved,(SELECT count(*) FROM errors) errors,(SELECT count(*) FROM enrichment_attempts WHERE attempts>=3) metadata_backoff_exhausted").get() as Row;
    const run = this.db.prepare("SELECT id,connector,started_at,ended_at,status,posts_seen,sources_new,duplicates FROM runs ORDER BY started_at DESC LIMIT 1").get() || null;
    return {...counts,lastRun:run,checkpoint:this.db.prepare("SELECT * FROM checkpoints ORDER BY updated_at DESC LIMIT 1").get() || null};
  }
  paused():boolean {
    const row=this.db.prepare("SELECT value FROM settings WHERE key='paused'").get() as Row|undefined;
    return row?.value==="true";
  }
  setPaused(paused:boolean):void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(paused?"true":"false");
  }
  recommendations(limit=30):{posts:Row[];authors:Row[]} {
    const size=Math.max(1,Math.min(100,limit));
    const posts=this.db.prepare(
      "SELECT p.url post_url,p.author,p.username,MAX(s.score) score,"+
      "GROUP_CONCAT(DISTINCT s.normalized_url) sources, GROUP_CONCAT(DISTINCT s.category) categories "+
      "FROM posts p JOIN post_sources ps ON ps.connector=p.connector AND ps.post_id=p.id "+
      "JOIN sources s ON s.id=ps.source_id WHERE s.status IN ('approved','high_quality') "+
      "GROUP BY p.connector,p.id ORDER BY score DESC LIMIT ?").all(size) as Row[];
    const authors=this.db.prepare(
      "SELECT p.author,p.username,COUNT(DISTINCT p.id) posts_seen,"+
      "COUNT(DISTINCT CASE WHEN s.status='approved' THEN s.id END) approved_sources,"+
      "COUNT(DISTINCT CASE WHEN s.status IN ('approved','high_quality') THEN s.id END) quality_sources,"+
      "GROUP_CONCAT(DISTINCT CASE WHEN s.status IN ('approved','high_quality') THEN s.category END) categories "+
      "FROM posts p LEFT JOIN post_sources ps ON ps.connector=p.connector AND ps.post_id=p.id "+
      "LEFT JOIN sources s ON s.id=ps.source_id GROUP BY p.username "+
      "HAVING quality_sources>0 ORDER BY approved_sources DESC,quality_sources DESC,posts_seen DESC LIMIT ?").all(size) as Row[];
    return {posts,authors};
  }
  history(limit=20): Row[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(Math.max(1,Math.min(100,limit))) as Row[];
  }
}
