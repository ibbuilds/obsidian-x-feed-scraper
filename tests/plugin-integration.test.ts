import {test} from "node:test";
import assert from "node:assert/strict";
import {join,resolve} from "node:path";
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {LocalBridge} from "../apps/obsidian-plugin/bridge.ts";

test("shipped Obsidian collector boots, authenticates and exports without changing References",async()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-installed-plugin-"));
  const vault=join(root,"vault");
  const dir=join(vault,".obsidian","plugins","x-feed-scraper");
  mkdirSync(dir,{recursive:true});
  for(const name of ["collector.cjs","design.json","manifest.json"]){
    copyFileSync(resolve("apps/obsidian-plugin",name),join(dir,name));
  }
  const references="# Existing library\n- [Reference](https://motion.dev/docs)\n";
  writeFileSync(join(vault,"References.md"),references);
  const bridge=new LocalBridge();
  try{
    const port=await bridge.start({
      executable:process.execPath,
      collectorPath:join(dir,"collector.cjs"),
      databasePath:join(dir,"storage","library.db"),
      profilePath:join(dir,"design.json"),
      vaultPath:vault,
      fixturePath:resolve("tests/fixtures/posts.json"),
      scheduleMinutes:0,threshold:75,confidence:0.65,preferFree:true
    });
    assert.ok(port>=1024&&port<=65535);
    const url="http://127.0.0.1:"+port;
    const auth={authorization:"Bearer "+bridge.token};
    assert.equal((await fetch(url+"/status")).status,401);
    const status=await fetch(url+"/status",{headers:auth});
    assert.equal(status.status,200);
    assert.equal((await status.json() as {connectedSource:string}).connectedSource,"fixture");
    const sync=await fetch(url+"/sync",{method:"POST",headers:auth});
    assert.equal(sync.status,200);
    const syncBody=await sync.json() as {result:{posts:number;newSources:number}};
    assert.equal(syncBody.result.posts,4);
    assert.equal(syncBody.result.newSources,3);
    const sources=await (await fetch(url+"/sources",{headers:auth})).json() as Array<{id:number;url:string;status:string}>;
    const github=sources.find(s=>s.url.startsWith("https://github.com/"));
    assert.ok(github);
    const review=await fetch(url+"/review",{method:"POST",headers:{...auth,"content-type":"application/json"},
      body:JSON.stringify({id:github.id,decision:"approved",reason:"Human reviewed resource"})});
    assert.equal(review.status,200);
    const notes=readdirSync(join(vault,"X Feed Scraper","Approved"));
    assert.equal(notes.length,1);
    assert.equal(readFileSync(join(vault,"References.md"),"utf8"),references);
    assert.ok(existsSync(join(vault,"X Feed Scraper","Sources.base")));
    assert.equal(readdirSync(join(vault,"X Feed Scraper","Visuals")).length,1);
    assert.ok(existsSync(join(dir,"storage","library.db")));
    const imported=await fetch(url+"/import",{method:"POST",headers:{...auth,"content-type":"application/json"},
      body:JSON.stringify({posts:[{
        id:"personal-post-1",url:"https://x.com/user/status/123",author:"User",username:"user",
        text:"Great open source UI resource https://github.com/example/new-components"
      }]})});
    assert.equal(imported.status,200);
    const after=await (await fetch(url+"/status",{headers:auth})).json() as {posts:number};
    assert.equal(after.posts,5);
  }finally{
    await bridge.stop();
    rmSync(root,{recursive:true,force:true});
  }
});
test("bridge surfaces missing package assets without storing tokens",async()=>{
 const bridge=new LocalBridge();
 await assert.rejects(bridge.start({
   executable:process.execPath,collectorPath:"/missing/collector.cjs",
   databasePath:"/missing/db",profilePath:"/missing/design.json",vaultPath:"/",
   scheduleMinutes:0,threshold:75,confidence:0.65,preferFree:true
 }),/missing/);
 assert.equal(bridge.token,"");
 assert.equal(bridge.running,false);
});
