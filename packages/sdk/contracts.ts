/**
 * Public extension SDK. No Obsidian, SQLite, X, or subject-specific types here.
 * Adapters yield observations; processors discover entities; evaluators assess
 * them; outputs consume structured records. v1 contracts are deliberately small.
 */
export type JsonValue = null | string | number | boolean | JsonValue[] | {[key:string]:JsonValue};
export type JsonRecord = {[key:string]:JsonValue};
/** Declarative, source-independent alerts on changes to retained entities. */
export interface ChangeRule {
  id:string;
  path:string; // RFC 6901 JSON pointer, e.g. /attributes/price
  operator:"created"|"changed"|"equals"|"decrease-percent"|"increase-percent";
  threshold?:number;
  value?:JsonValue;
  requireUnchanged?:string[]; // e.g. /attributes/currency
}

export interface Observation {
  id:string;
  type:string;
  title?:string;
  text?:string;
  url?:string;
  urls?:string[];
  media?:string[];
  occurredAt?:string;
  attributes?:JsonRecord;
}
export interface Evidence {
  signal:string;
  detail:string;
  confidence?:number;
}
export interface EntityDraft {
  key:string;
  type:string;
  title:string;
  url?:string;
  attributes?:JsonRecord;
  evidence?:Evidence[];
}
export type ReviewState = "pending"|"approved"|"rejected";
export interface Assessment {
  category:string;
  score:number;
  confidence:number;
  reasons:string[];
}
export interface ProjectSource {
  id:string;
  adapter:string;
  /** Optional config.entityNamespace scopes observation-entity keys. Keep it
   * stable; omitting it preserves legacy type:id keys. Shared explicit values
   * deliberately identify the same entities across source connections. */
  config:JsonRecord;
}
export interface ProjectOutput {
  id:string;
  adapter:string;
  config:JsonRecord;
}
export interface ProjectPolicy {
  includeKeywords:string[];
  excludeKeywords:string[];
  minimumScore:number;
}
export interface ProjectDefinition {
  id:string;
  name:string;
  sources:ProjectSource[];
  pipeline:string[];
  evaluator:string;
  policy:ProjectPolicy;
  outputs:ProjectOutput[];
  /** Per-entity attribute schemas: fields with types, all optional unless in required. */
  entitySchemas?:Record<string,{fields:Record<string,"string"|"number"|"boolean">;required?:string[]}>;
  watch?:{rules:ChangeRule[]};
}
export interface SourceContext {
  source:ProjectSource;
  cursor?:string;
  limit:number;
  signal:AbortSignal;
}
export interface ObservationPage {
  observations:Observation[];
  /** Next page cursor, opaque to the engine. */
  nextCursor?:string;
  /** Explicitly indicates that additional pages exist. */
  hasMore:boolean;
}
export interface SourceAdapter {
  id:string;
  collect(context:SourceContext):Promise<ObservationPage>;
}
export interface ProcessingContext {
  project:ProjectDefinition;
  source:ProjectSource;
  signal:AbortSignal;
}
export interface Processor {
  id:string;
  run(context:ProcessingContext,observation:Observation,previous:readonly EntityDraft[]):Promise<EntityDraft[]>|EntityDraft[];
}
export interface Evaluator {
  id:string;
  assess(context:ProcessingContext,observation:Observation,entity:EntityDraft):Promise<Assessment>|Assessment;
}
export interface KnowledgeEntity {
  projectId:string;
  key:string;
  type:string;
  title:string;
  url?:string;
  attributes:JsonRecord;
  category:string;
  score:number;
  confidence:number;
  reasons:string[];
  review:ReviewState;
  updatedAt:string;
  observationCount:number;
}
export interface ExportContext {
  project:ProjectDefinition;
  /** Stable configured output identity, supplied by exportProject. */
  outputId?:string;
  records:KnowledgeEntity[];
  config:JsonRecord;
  databasePath:string;
  vaultPath?:string;
}
export interface OutputAdapter {
  id:string;
  /** Declare true only when export performs no external network operations. */
  offline?:boolean;
  export(context:ExportContext):Promise<unknown>|unknown;
}
export interface Extension {
  apiVersion:1;
  adapters?:SourceAdapter[];
  processors?:Processor[];
  evaluators?:Evaluator[];
  outputs?:OutputAdapter[];
}
export interface Registry {
  sources:Map<string,SourceAdapter>;
  processors:Map<string,Processor>;
  evaluators:Map<string,Evaluator>;
  outputs:Map<string,OutputAdapter>;
}
