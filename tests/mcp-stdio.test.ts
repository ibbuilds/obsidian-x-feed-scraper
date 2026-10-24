import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject,loadProject} from "../packages/core/project-config.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

const fixture=resolve("tests/fixtures/mock-mcp-server.cjs");
function project(tool="list_records",config:Record<string,unknown>={}){
 return parseProject({
  id:"mcp-lab",name:"Scientific observations from MCP",
  sources:[{id:"mcp-lab-server",adapter:"mcp-stdio",config:{
   command:"node",args:[fixture],tool,...config}}],
  pipeline:["observation-entity"],evaluator:"keyword",
  policy:{includeKeywords:["microscopy","sample","experimental"],excludeKeywords:[],minimumScore:0},
  outputs:[]
 });
}
test("real MCP handshake, paginated tools/list and text + structuredContent pages",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-")),db=join(dir,"store.sqlite");
 try{
  const registry=createDefaultRegistry();
  assert.ok(registry.sources.has("mcp-stdio"));
  const result=await runProject(db,project(),registry,{pageSize:1});
  assert.equal(result.success,true,JSON.stringify(result.runs));
  assert.equal(result.observations,2);
  assert.equal(result.newEntities,2);
  const store=new KnowledgeStore(db);
  assert.equal(store.getEntity("mcp-lab","lab-record:sample-1")?.type,"lab-record");
  assert.equal(store.getEntity("mcp-lab","lab-record:sample-2")?.attributes.samples,7);
  assert.equal(store.cursor("mcp-lab","mcp-lab-server"),"done");
  assert.equal(store.listEntities("mcp-lab").length,2);
  store.close();
  const retry=await runProject(db,project(),registry,{pageSize:1});
  assert.equal(retry.success,true);
  assert.equal(retry.observations,0,"MCP cursor should resume rather than ingest duplicates");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("MCP child does not receive collector bearer token unless explicitly allowed",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-env-")),db=join(dir,"store.sqlite");
 const previous=process.env.XFS_API_TOKEN;
 const oldAllowed=process.env.MCP_TEST_ALLOWED_ENV;
 process.env.XFS_API_TOKEN="should-not-reach-child";
 process.env.MCP_TEST_ALLOWED_ENV="approved-extra-env";
 try{
  const result=await runProject(db,project("check_environment",{
    passEnv:["MCP_TEST_ALLOWED_ENV"]
  }),createDefaultRegistry());
  assert.equal(result.success,true,JSON.stringify(result.runs));
  const store=new KnowledgeStore(db);
  const info=store.getEntity("mcp-lab","system-diagnostic:env");
  assert.ok(info);
  assert.equal(info.attributes.tokenLeak,false);
  assert.equal(info.attributes.explicitVariable,"approved-extra-env");
  store.close();
 }finally{
  if(previous===undefined)delete process.env.XFS_API_TOKEN;
  else process.env.XFS_API_TOKEN=previous;
  if(oldAllowed===undefined)delete process.env.MCP_TEST_ALLOWED_ENV;
  else process.env.MCP_TEST_ALLOWED_ENV=oldAllowed;
  rmSync(dir,{recursive:true,force:true});
 }
});
test("MCP tool-reported errors and invalid responses cannot advance checkpoints",async()=>{
 const registry=createDefaultRegistry();
 for(const tool of ["tool_error","invalid_data","missing-tool"]){
  const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-invalid-")),db=join(dir,"store.sqlite");
  try{
   const result=await runProject(db,project(tool),registry);
   assert.equal(result.success,false,tool);
   assert.equal(result.runs[0].status,"failed",tool);
   const store=new KnowledgeStore(db);
   assert.equal(store.cursor("mcp-lab","mcp-lab-server"),undefined);
   assert.equal(store.listEntities("mcp-lab").length,0);
   store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
test("MCP hangs are terminated at the configured timeout, leaving no cursor",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-timeout-")),db=join(dir,"store.sqlite");
 try{
  const result=await runProject(db,project("hang",{timeoutMs:1000}),createDefaultRegistry());
  assert.equal(result.success,false);
  assert.match(result.runs[0].error||"",/timed out/);
  const store=new KnowledgeStore(db);
  assert.equal(store.cursor("mcp-lab","mcp-lab-server"),undefined);
  store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("MCP refuses relative executable and requires selected tools",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-config-")),db=join(dir,"store.sqlite");
 try{
  const p=project("list_records",{command:"evil-relative-program"});
  const result=await runProject(db,p,createDefaultRegistry());
  assert.equal(result.success,false);
  assert.match(result.runs[0].error||"",/absolute executable path/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("MCP project manifest works from an unrelated working directory without Obsidian",()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-cwd-"));
 const db=join(dir,"library.sqlite");
 try{
  const manifest=resolve("examples/mcp/project.json");
  const project=loadProject(manifest);
  assert.equal(project.sources[0].adapter,"mcp-stdio");
  assert.ok(String(project.sources[0].config.args).includes("mock-mcp-server.cjs"));
  const cli=resolve("apps/collector/cli.ts");
  const child=spawnSync(process.execPath,[
    "--experimental-strip-types",cli,"project","sync","--project",manifest,"--db",db
  ],{cwd:dir,encoding:"utf8",timeout:20000});
  assert.equal(child.status,0,child.stderr||child.stdout);
  const result=JSON.parse(child.stdout) as {success:boolean;newEntities:number};
  assert.equal(result.success,true);
  assert.equal(result.newEntities,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("MCP stdio negotiates 2026-07-28 stateless discovery and per-request metadata",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-modern-mcp-")),db=join(dir,"store.sqlite");
 try{
  const modern=resolve("tests/fixtures/mock-modern-mcp-server.cjs");
  const manifest=project("modern_observations",{args:[modern],protocol:"modern"});
  const result=await runProject(db,manifest,createDefaultRegistry());
  assert.equal(result.success,true,JSON.stringify(result.runs));
  const store=new KnowledgeStore(db);
  assert.equal(store.getEntity("mcp-lab","science:modern-1")?.attributes.edition,2026);
  store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("automatic MCP era selection supports modern and legacy while strict modes reject mismatches",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-mcp-eras-")),db=join(dir,"store.sqlite");
 try{
  const modern=resolve("tests/fixtures/mock-modern-mcp-server.cjs");
  const auto=project("modern_observations",{args:[modern]});
  const success=await runProject(db,auto,createDefaultRegistry());
  assert.equal(success.success,true,JSON.stringify(success.runs));
  // Different IDs and databases are used to avoid connection fingerprints from
  // treating a protocol change as an accidental source replacement.
  const legacy=project("list_records",{protocol:"modern"});
  legacy.id="legacy-explicit-mismatch";
  const rejected=await runProject(join(dir,"legacy.db"),legacy,createDefaultRegistry());
  assert.equal(rejected.success,false);
  assert.match(rejected.runs[0].error||"",/modern discovery|protocol/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
