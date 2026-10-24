import {createHash,randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {KnowledgeStore} from "../storage/knowledge.ts";
import {postPublicWebhook,validateWebhookEndpoint,WebhookDeliveryError} from "../connectors/public-webhook.ts";
import type {JsonRecord,OutputAdapter} from "../sdk/contracts.ts";

type DeliveryState="pending"|"delivered"|"failed"|"exhausted";
interface OutputState {
  output_id:string;destination_hash:string;delivery_namespace:string;
  baseline_alert_id:number;enabled_at:string;max_attempts:number;
}
interface AlertRow {
  id:number;entity_key:string;change_id:number;rule_id:string;explanation:string;detected_at:string;
  connection_id:string;observation_id:string;adapter_id:string;
  path:string;kind:string;before_json:string|null;after_json:string|null;observed_at:string;
  idempotency_key:string|null;payload_json:string|null;attempts:number|null;
}
export interface WebhookDeliveryStatus {
  outputId:string;enabledAt:string;baselineAlertId:number;
  counts:Record<DeliveryState,number>;
  recent:Array<{alertId:number;idempotencyKey:string;status:DeliveryState;
    attempts:number;lastError:string|null;updatedAt:string}>;
}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const now=()=>new Date().toISOString();

function envValue(name:unknown):string{
  if(typeof name!=="string"||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)){
    throw new WebhookDeliveryError("configuration");
  }
  const value=process.env[name];
  if(!value)throw new WebhookDeliveryError("configuration");
  return value;
}
function integer(config:JsonRecord,key:string,fallback:number,max:number,min=1):number{
  const value=config[key]??fallback;
  if(typeof value!=="number"||!Number.isInteger(value)||value<min||value>max){
    throw new WebhookDeliveryError("configuration");
  }
  return value;
}
function options(config:JsonRecord){
  if(config.includeExisting!==undefined&&typeof config.includeExisting!=="boolean"){
    throw new WebhookDeliveryError("configuration");
  }
  if((config.url===undefined)===(config.endpointEnv===undefined)){
    throw new WebhookDeliveryError("configuration");
  }
  const endpoint=validateWebhookEndpoint(config.endpointEnv===undefined?config.url:envValue(config.endpointEnv));
  const bearerToken=config.bearerTokenEnv===undefined?undefined:envValue(config.bearerTokenEnv);
  if(bearerToken!==undefined&&(bearerToken.length>4096||/[\u0000-\u0020\u007f]/.test(bearerToken))){
    throw new WebhookDeliveryError("configuration");
  }
  return {endpoint,bearerToken,includeExisting:config.includeExisting===true,
    maxPerExport:integer(config,"maxPerExport",20,100),
    maxAttempts:integer(config,"maxAttempts",5,20),
    timeoutMs:integer(config,"timeoutMs",8000,30_000,1000)};
}
function initialize(store:KnowledgeStore):void{
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS kb_webhook_outputs (project_id TEXT NOT NULL,output_id TEXT NOT NULL,"+
    "destination_hash TEXT NOT NULL,delivery_namespace TEXT NOT NULL,baseline_alert_id INTEGER NOT NULL,"+
    "enabled_at TEXT NOT NULL,max_attempts INTEGER NOT NULL,PRIMARY KEY(project_id,output_id));"+
    "CREATE TABLE IF NOT EXISTS kb_webhook_deliveries (project_id TEXT NOT NULL,output_id TEXT NOT NULL,"+
    "alert_id INTEGER NOT NULL REFERENCES kb_watch_alerts(id),idempotency_key TEXT NOT NULL UNIQUE,"+
    "payload_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,"+
    "last_error TEXT,response_status INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,delivered_at TEXT,"+
    "PRIMARY KEY(project_id,output_id,alert_id),"+
    "FOREIGN KEY(project_id,output_id) REFERENCES kb_webhook_outputs(project_id,output_id));"
  );
}

/** Inspect ledger only. No migrations, activation, environment lookup or network. */
export function getWebhookDeliveryStatus(databasePath:string,projectId:string,outputId?:string):WebhookDeliveryStatus[]{
  if(!existsSync(databasePath))return [];
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(databasePath,{readOnly:true});
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND "+
      "name IN ('kb_webhook_outputs','kb_webhook_deliveries')").all();
    if(tables.length!==2)return [];
    const outputs=db.prepare("SELECT output_id,baseline_alert_id,enabled_at FROM kb_webhook_outputs "+
      "WHERE project_id=? AND (? IS NULL OR output_id=?) ORDER BY output_id")
      .all(projectId,outputId??null,outputId??null) as Array<Pick<OutputState,"output_id"|"baseline_alert_id"|"enabled_at">>;
    return outputs.map(output=>{
      const counts:Record<DeliveryState,number>={pending:0,delivered:0,failed:0,exhausted:0};
      const rows=db!.prepare("SELECT status,COUNT(*) count FROM kb_webhook_deliveries "+
        "WHERE project_id=? AND output_id=? GROUP BY status").all(projectId,output.output_id) as Array<{status:DeliveryState;count:number}>;
      for(const row of rows)if(Object.hasOwn(counts,row.status))counts[row.status]=Number(row.count);
      const recent=db!.prepare("SELECT alert_id,idempotency_key,status,attempts,last_error,updated_at "+
        "FROM kb_webhook_deliveries WHERE project_id=? AND output_id=? ORDER BY updated_at DESC,alert_id DESC LIMIT 50")
        .all(projectId,output.output_id) as Array<{alert_id:number;idempotency_key:string;status:DeliveryState;
          attempts:number;last_error:string|null;updated_at:string}>;
      return {outputId:output.output_id,enabledAt:output.enabled_at,baselineAlertId:Number(output.baseline_alert_id),
        counts,recent:recent.map(row=>({alertId:Number(row.alert_id),idempotencyKey:row.idempotency_key,
          status:row.status,attempts:Number(row.attempts),lastError:row.last_error,updatedAt:row.updated_at}))};
    });
  }catch{throw new Error("Unable to read webhook delivery status");}
  finally{db?.close();}
}

/**
 * Explicit opt-in delivery. exportProject holds the existing single-writer lock.
 * A crash after POST can require retry: receivers must honor Idempotency-Key.
 */
export const webhookOutput:OutputAdapter={
  id:"webhook",
  offline:false,
  async export({project,records,config,databasePath,outputId}){
    if(config.enabled!==undefined&&typeof config.enabled!=="boolean")throw new WebhookDeliveryError("configuration");
    if(config.enabled!==true)return {enabled:false,attempted:0,delivered:0,failed:0};
    if(!outputId||!/^[a-z][a-z0-9_-]{1,63}$/.test(outputId))throw new WebhookDeliveryError("configuration");
    const settings=options(config),destinationHash=hash(settings.endpoint);
    const eligible=new Map(records.filter(entity=>entity.projectId===project.id&&
      entity.review!=="rejected"&&entity.score>=project.policy.minimumScore).map(entity=>[entity.key,entity]));
    const store=new KnowledgeStore(databasePath);
    try{
      initialize(store);
      let state=store.db.prepare("SELECT * FROM kb_webhook_outputs WHERE project_id=? AND output_id=?")
        .get(project.id,outputId) as OutputState|undefined;
      if(state&&state.destination_hash!==destinationHash){
        throw new Error("Webhook destination changed; configure a new output ID");
      }
      if(!state){
        const high=store.db.prepare("SELECT COALESCE(MAX(id),0) id FROM kb_watch_alerts WHERE project_id=?")
          .get(project.id) as {id:number};
        state={output_id:outputId,destination_hash:destinationHash,delivery_namespace:randomUUID(),
          baseline_alert_id:Number(high.id),enabled_at:now(),max_attempts:settings.maxAttempts};
        store.db.prepare("INSERT INTO kb_webhook_outputs(project_id,output_id,destination_hash,delivery_namespace,"+
          "baseline_alert_id,enabled_at,max_attempts) VALUES(?,?,?,?,?,?,?)").run(project.id,outputId,
            destinationHash,state.delivery_namespace,state.baseline_alert_id,state.enabled_at,settings.maxAttempts);
      }
      store.db.prepare("UPDATE kb_webhook_outputs SET max_attempts=? WHERE project_id=? AND output_id=?")
        .run(settings.maxAttempts,project.id,outputId);
      // Recover an interrupted last permitted attempt without claiming it was delivered.
      store.db.prepare("UPDATE kb_webhook_deliveries SET status='exhausted' WHERE project_id=? AND output_id=? "+
        "AND status!='delivered' AND attempts>=?").run(project.id,outputId,settings.maxAttempts);
      const baseline=settings.includeExisting?0:state.baseline_alert_id;
      const rows=store.db.prepare(
        "SELECT a.id,a.entity_key,a.change_id,a.rule_id,a.explanation,a.detected_at,"+
        "c.connection_id,c.observation_id,c.path,c.kind,c.before_json,c.after_json,c.observed_at,s.adapter_id,"+
        "d.idempotency_key,d.payload_json,d.attempts FROM kb_watch_alerts a "+
        "JOIN kb_entity_changes c ON c.id=a.change_id AND c.project_id=a.project_id "+
        "JOIN kb_connections s ON s.project_id=c.project_id AND s.connection_id=c.connection_id "+
        "LEFT JOIN kb_webhook_deliveries d ON d.project_id=a.project_id AND d.alert_id=a.id AND d.output_id=? "+
        "WHERE a.project_id=? AND a.id>? AND COALESCE(d.status,'pending')!='delivered' AND COALESCE(d.attempts,0)<? "+
        "AND a.entity_key IN (SELECT value FROM json_each(?)) ORDER BY a.id LIMIT ?"
      ).all(outputId,project.id,baseline,settings.maxAttempts,JSON.stringify([...eligible.keys()]),settings.maxPerExport) as unknown as AlertRow[];
      const deadline=Date.now()+30_000;
      const result={enabled:true,attempted:0,delivered:0,failed:0,budgetReached:false,
        deliverySemantics:"at-least-once attempts with bounded retries; receiver must honor Idempotency-Key",
        status:undefined as WebhookDeliveryStatus|undefined};
      for(const row of rows){
        if(Date.now()>=deadline){result.budgetReached=true;break;}
        const entity=eligible.get(row.entity_key)!;
        const key=row.idempotency_key||"discovery-v1-"+hash(JSON.stringify([
          state.delivery_namespace,project.id,outputId,row.id
        ]));
        const payload=row.payload_json||JSON.stringify({
          schemaVersion:1,event:"discovery.watch-alert",idempotencyKey:key,
          project:{id:project.id,name:project.name},outputId,
          alert:{id:row.id,ruleId:row.rule_id,explanation:row.explanation,detectedAt:row.detected_at},
          change:{id:row.change_id,path:row.path,kind:row.kind,observedAt:row.observed_at,
            before:row.before_json===null?undefined:JSON.parse(row.before_json),
            after:row.after_json===null?undefined:JSON.parse(row.after_json)},
          source:{connectionId:row.connection_id,adapterId:row.adapter_id,observationId:row.observation_id},
          entity:{key:entity.key,type:entity.type,title:entity.title,url:entity.url,
            review:entity.review,score:entity.score,updatedAt:entity.updatedAt}
        });
        const date=now();
        store.db.prepare("INSERT OR IGNORE INTO kb_webhook_deliveries(project_id,output_id,alert_id,idempotency_key,"+
          "payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)")
          .run(project.id,outputId,row.id,key,payload,date,date);
        store.db.prepare("UPDATE kb_webhook_deliveries SET status='pending',attempts=attempts+1,last_error=NULL,updated_at=? "+
          "WHERE project_id=? AND output_id=? AND alert_id=?").run(date,project.id,outputId,row.id);
        result.attempted++;
        try{
          const response=await postPublicWebhook(settings.endpoint,payload,{idempotencyKey:key,
            bearerToken:settings.bearerToken,timeoutMs:Math.min(settings.timeoutMs,Math.max(1,deadline-Date.now()))});
          store.db.prepare("UPDATE kb_webhook_deliveries SET status='delivered',response_status=?,delivered_at=?,updated_at=? "+
            "WHERE project_id=? AND output_id=? AND alert_id=?").run(response.status,now(),now(),project.id,outputId,row.id);
          result.delivered++;
        }catch(error){
          const safe=error instanceof WebhookDeliveryError?error.message:"Webhook delivery failed";
          store.db.prepare("UPDATE kb_webhook_deliveries SET status=CASE WHEN attempts>=? THEN 'exhausted' ELSE 'failed' END,"+
            "last_error=?,updated_at=? WHERE project_id=? AND output_id=? AND alert_id=?")
            .run(settings.maxAttempts,safe,now(),project.id,outputId,row.id);
          result.failed++;
        }
      }
      result.status=getWebhookDeliveryStatus(databasePath,project.id,outputId)[0];
      return result;
    }finally{store.close();}
  }
};
