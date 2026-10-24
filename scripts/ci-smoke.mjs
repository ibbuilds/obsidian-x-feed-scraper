/**
 * Cross-platform CI smoke: invoke Node directly so npm/PowerShell cannot
 * silently consume --flags. Green requires persisted, nonempty results.
 */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const workspace=mkdtempSync(join(tmpdir(),"discovery-ci-smoke-"));
const executable=resolve(root,"apps/collector/cli.ts");

function execute(args,shouldSucceed=true){
  const result=spawnSync(process.execPath,["--experimental-strip-types",executable,...args],{
    cwd:root,encoding:"utf8",timeout:30_000,maxBuffer:2_000_000,
    env:{...process.env,XFS_DB:join(workspace,"default-should-stay-unused.db")}
  });
  if(result.error)throw result.error;
  const details="\nargs: "+JSON.stringify(args)+"\nexit: "+String(result.status)+
    "\nstdout: "+result.stdout+"\nstderr: "+result.stderr;
  if(shouldSucceed){
    assert.equal(result.status,0,"CLI must finish successfully"+details);
    let value;
    try{value=JSON.parse(result.stdout);}
    catch{throw new Error("CLI did not output valid JSON"+details);}
    return value;
  }
  assert.notEqual(result.status,0,"Invalid CLI invocation must fail"+details);
  return result;
}

try{
  const legacyDb=join(workspace,"legacy.db");
  const imported=execute(["sync","--fixture","tests/fixtures/posts.json","--db",legacyDb]);
  assert.equal(imported.result.posts,4);
  assert.equal(imported.result.newSources,3);
  assert.equal(imported.result.errors,0);
  assert.ok(existsSync(legacyDb),"Legacy database must be created at the requested path");
  const legacy=execute(["status","--db",legacyDb]);
  assert.equal(Number(legacy.posts),4,"Fixture posts were not persisted");
  assert.equal(Number(legacy.sources),3,"Fixture sources were not persisted");
  assert.equal(Number(legacy.links),4,"Fixture relationships were not persisted");
  assert.equal(legacy.lastRun?.status,"success");
  execute(["sync","--fixture","tests/fixtures/posts.json","--db",legacyDb]);
  const repeated=execute(["status","--db",legacyDb]);
  assert.equal(Number(repeated.posts),4,"Re-running fixture must not duplicate posts");
  assert.equal(Number(repeated.sources),3,"Re-running fixture must not duplicate sources");

  const projectDb=join(workspace,"project.db");
  const project=execute(["project","sync","--project","examples/frontend/project.json","--db",projectDb]);
  assert.equal(project.success,true,"Generic research project must finish successfully");
  assert.ok(project.observations>0,"Generic project must collect real fixture observations");
  assert.ok(existsSync(projectDb),"Generic project database must be created at the requested path");
  const entities=execute(["project","entities","--id","frontend-discovery","--db",projectDb]);
  assert.ok(Array.isArray(entities)&&entities.length>0,
    "Generic engine must persist queryable knowledge entities");

  const invalid=execute(["sync","--db",join(workspace,"invalid.db")],false);
  assert.match(invalid.stderr,/Set --feed or --fixture/);

  // Ensure the fallback path was never touched due dropped --db arguments.
  assert.equal(existsSync(join(workspace,"default-should-stay-unused.db")),false,
    "CLI flags were lost and operations used the wrong database");
  console.log("Cross-platform CLI smoke passed: legacy ingest, deduplication, generic project, error exits.");
}finally{
  rmSync(workspace,{recursive:true,force:true});
}
