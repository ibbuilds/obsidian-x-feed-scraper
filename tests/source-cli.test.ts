import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,existsSync,readdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";

const binary=resolve("dist/source-scraper.mjs");
function invoke(args:string[],success=true){
  const r=spawnSync(process.execPath,[binary,...args],{encoding:"utf8",timeout:30_000,maxBuffer:4_000_000});
  if(r.error)throw r.error;
  if(success)assert.equal(r.status,0,r.stderr+"\n"+r.stdout);
  else assert.notEqual(r.status,0,JSON.stringify({args,stdout:r.stdout,stderr:r.stderr}));
  return r;
}
function asJson(args:string[]){
  return JSON.parse(invoke(args).stdout) as Record<string,any>;
}

test("standalone executable is bundled independently of Obsidian",()=>{
  assert.equal(existsSync(binary),true,"Run npm run build:cli before tests");
  const raw=readFileSync(binary,"utf8");
  assert.match(raw,/^#!\/usr\/bin\/env node/);
  assert.ok(raw.length>30000);
  const v=asJson(["version"]);
  assert.equal(v.name,"source-scraper");
  assert.equal(v.version,JSON.parse(readFileSync("package.json","utf8")).version);
  assert.equal(v.jsonSchemaVersion,1);
  const adapters=asJson(["adapters"]);
  assert.ok(adapters.sources.includes("json-snapshot"));
  assert.ok(adapters.sources.includes("mcp-stdio"));
});

test("first run needs only a JSON manifest, JSON observations and standalone Node executable",()=>{
  const root=mkdtempSync(join(tmpdir(),"source-scraper-"));
  const dir=join(root,"starter");
  try{
    const init=asJson(["init","--dir",dir]);
    assert.equal(init.schemaVersion,1);
    assert.equal(init.synthetic,true);
    assert.ok(existsSync(join(dir,"project.json")));
    assert.ok(existsSync(join(dir,"observations.json")));
    assert.ok(!existsSync(join(dir,".source-scraper.sqlite")));
    const config=join(dir,"project.json"),source=join(dir,"observations.json");
    const manifest=JSON.parse(readFileSync(config,"utf8"));
    assert.deepEqual(manifest.outputs,[],"Starter must not depend on Obsidian output");
    assert.equal(manifest.sources[0].adapter,"json-snapshot");
    assert.equal(asJson(["validate","--config",config]).valid,true);
    assert.ok(!existsSync(join(dir,".source-scraper.sqlite")),"Validate must not create DB");
    const first=asJson(["run","--config",config]);
    assert.equal(first.result.success,true);
    assert.equal(first.result.observations,3);
    assert.ok(existsSync(join(dir,".source-scraper.sqlite")));
    const projects=asJson(["projects","--config",config]);
    assert.equal(projects.projects.length,1);
    const queried=asJson(["query","--config",config,"--dataset","entities"]);
    assert.equal(queried.dataset,"entities");
    assert.equal(queried.count,4,"Two mentions of one external URL must deduplicate");
    const obs=asJson(["query","--config",config,"--dataset","observations"]);
    assert.equal(obs.count,3);
    const stored=obs.records.find((r:any)=>r.itemId==="demo-motion-1");
    assert.deepEqual(stored.observation.urls,["https://github.com/example/motion-kit"]);
    const exportJson=asJson(["export","--config",config]);
    assert.equal(exportJson.schemaVersion,1);
    assert.equal(exportJson.dataset,"entities");
    assert.equal(exportJson.count,4);
    const shared=exportJson.records.find((r:any)=>r.key==="https://github.com/example/motion-kit");
    assert.ok(shared);
    assert.equal(shared.observationCount,2);
    assert.equal(shared.provenance.mentions.length,2);
    assert.equal(shared.provenance.mentionsTruncated,false);
    assert.equal(shared.review,"pending");
    assert.equal(asJson(["inspect","--config",config,"--key",shared.key]).mentions.length,2);
    const reviewed=asJson(["review","--config",config,"--key",shared.key,
      "--decision","approved","--reason","Reviewed the synthetic record"]);
    assert.equal(reviewed.entity.review,"approved");
    const next=asJson(["run","--config",config]);
    assert.equal(next.result.success,true);
    assert.equal(asJson(["query","--config",config]).count,4);
    assert.equal(asJson(["inspect","--config",config,"--key",shared.key]).entity.review,"approved");
    const offline=asJson(["reprocess","--config",config]);
    assert.ok(offline.result.reassessed>0);
    assert.equal(asJson(["inspect","--config",config,"--key",shared.key]).entity.review,"approved");

    const out=join(root,"records.json");
    const wrote=asJson(["export","--config",config,"--out",out]);
    assert.equal(wrote.count,4);
    assert.equal(JSON.parse(readFileSync(out,"utf8")).records.length,4);
    const cannotOverwrite=invoke(["export","--config",config,"--out",out],false);
    assert.match(cannotOverwrite.stderr,/EEXIST/);
    assert.equal(JSON.parse(readFileSync(out,"utf8")).count,4);

    const ndjson=invoke(["export","--config",config,"--format","ndjson","--compact","true"]).stdout;
    const records=ndjson.trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(records.length,4);
    assert.ok(records.every(row=>row.schemaVersion===1&&row.dataset==="entities"));
    assert.ok(records.every(row=>!Object.hasOwn(row.record,"provenance")));

    const changes=asJson(["query","--config",config,"--dataset","changes"]);
    assert.ok(changes.records.length>=4);
    const edited=JSON.parse(readFileSync(source,"utf8"));
    edited[0].attributes.author="synthetic-updated";
    writeFileSync(source,JSON.stringify(edited));
    assert.equal(asJson(["run","--config",config]).result.success,true);
    const versions=asJson(["query","--config",config,"--dataset","observations"]);
    assert.equal(versions.records.find((r:any)=>r.itemId==="demo-motion-1").observation.attributes.author,
      "synthetic-updated");
    assert.equal(readdirSync(dir).some(file=>file==="Knowledge.base"||file==="References.md"),false,
      "Generic CLI must not generate Obsidian artifacts implicitly");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("standalone CLI refuses unsafe options and never silently creates a DB for queries",()=>{
  const root=mkdtempSync(join(tmpdir(),"source-scraper-invalid-"));
  try{
    const bad=invoke(["query","--db",join(root,"missing.sqlite"),"--id","fake-project"],false);
    assert.match(bad.stderr,/No database/);
    assert.equal(existsSync(join(root,"missing.sqlite")),false);
    const unknown=invoke(["init","--dir",join(root,"new"),"--mystery","1"],false);
    assert.match(unknown.stderr,/Unknown option/);
    assert.equal(existsSync(join(root,"new")),false);
    const d=join(root,"demo");
    asJson(["init","--dir",d]);
    const repeat=invoke(["init","--dir",d],false);
    assert.match(repeat.stderr,/refusing to overwrite/);
    const manifest=JSON.parse(readFileSync(join(d,"project.json"),"utf8"));
    manifest.outputs=[{id:"external-webhook",adapter:"webhook",config:{enabled:true,
      url:"https://alerts.example.org/receive"}}];
    writeFileSync(join(d,"project.json"),JSON.stringify(manifest));
    assert.equal(asJson(["run","--config",join(d,"project.json")]).result.success,true,
      "Collection must never implicitly deliver configured external outputs");
  }finally{rmSync(root,{recursive:true,force:true});}
});
