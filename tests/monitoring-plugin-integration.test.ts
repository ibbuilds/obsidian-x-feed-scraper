import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync,copyFileSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {LocalBridge} from "../apps/obsidian-plugin/bridge.ts";

test("packaged Obsidian collector monitors product-price changes via read-only local API",async()=>{
  const root=mkdtempSync(join(tmpdir(),"discovery-monitor-package-"));
  const db=join(root,"library.sqlite"),vault=join(root,"vault");
  const data=join(root,"snapshot.json"),manifest=join(root,"project.json");
  mkdirSync(vault);
  const references="# Owner notes\n- [Untouched](https://example.org/old)\n";
  writeFileSync(join(vault,"References.md"),references);
  copyFileSync(resolve("examples/price-monitor/snapshot.json"),data);
  const source=JSON.parse(readFileSync(resolve("examples/price-monitor/project.json"),"utf8")) as {
    sources:Array<{config:{path:string}}>;outputs:unknown[];
  };
  source.sources[0].config.path=data;
  source.outputs=[{id:"vault-notes",adapter:"obsidian",config:{folder:"Discovery Engine"}}];
  writeFileSync(manifest,JSON.stringify(source));
  const bridge=new LocalBridge();
  try{
    await bridge.start({
      executable:process.execPath,
      collectorPath:resolve("apps/obsidian-plugin/collector.cjs"),
      databasePath:db,
      profilePath:resolve("apps/obsidian-plugin/design.json"),
      vaultPath:vault,projectPath:manifest,
      scheduleMinutes:0,threshold:75,confidence:0.65,preferFree:true
    });
    const base="http://127.0.0.1:"+bridge.port,headers={
      authorization:"Bearer "+bridge.token
    };
    const first=await fetch(base+"/project/sync",{method:"POST",headers});
    assert.equal(first.status,200);
    const initial=await first.json() as {result:{success:boolean;newEntities:number}};
    assert.equal(initial.result.success,true);
    assert.equal(initial.result.newEntities,2);
    const firstAlerts=await (await fetch(base+
      "/project/alerts?project=price-monitor-demo",{headers})).json() as Array<{ruleId:string}>;
    assert.equal(firstAlerts.filter(x=>x.ruleId==="new-item").length,2);
    copyFileSync(resolve("examples/price-monitor/snapshot-updated.json"),data);
    const second=await fetch(base+"/project/sync",{method:"POST",headers});
    assert.equal(second.status,200);
    const updated=await second.json() as {result:{success:boolean;newEntities:number}};
    assert.equal(updated.result.success,true);
    assert.equal(updated.result.newEntities,0);
    const alerts=await (await fetch(base+
      "/project/alerts?project=price-monitor-demo",{headers})).json() as Array<{
        ruleId:string;before:number;after:number;explanation:string
      }>;
    const drop=alerts.find(x=>x.ruleId==="price-drop-10")!;
    assert.ok(drop);
    assert.equal(drop.before,129.99);
    assert.equal(drop.after,99.99);
    assert.match(drop.explanation,/decreased/);
    const changeResponse=await fetch(base+
      "/project/changes?project=price-monitor-demo&key=product%3Aprice-100",{headers});
    assert.equal(changeResponse.status,200);
    const changes=await changeResponse.json() as Array<{path:string;kind:string}>;
    assert.deepEqual(changes.map(x=>x.path),["/attributes/price","$"]);
    const versions=await (await fetch(base+
      "/project/versions?project=price-monitor-demo&key=product%3Aprice-100",{headers}))
      .json() as Array<{snapshot:{attributes:{price:number}}}>;
    assert.equal(versions.length,2);
    assert.equal(versions[0].snapshot.attributes.price,99.99);
    assert.equal(versions[1].snapshot.attributes.price,129.99);
    assert.equal(readFileSync(join(vault,"References.md"),"utf8"),references);
    assert.equal((await fetch(base+"/project/changes",{headers:{}})).status,401);
  }finally{
    await bridge.stop();
    rmSync(root,{recursive:true,force:true});
  }
});
