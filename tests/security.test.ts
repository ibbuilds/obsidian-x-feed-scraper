import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadProfile} from "../packages/core/profile.ts";
import {startServer} from "../apps/collector/server.ts";

test("loopback server refuses missing credentials and cross-origin requests",async()=>{
  const root=mkdtempSync(join(tmpdir(),"xfs-server-"));
  const port=48000+Math.floor(Math.random()*1000);
  const secret="test-token-0123456789-abcdef";
  const server=startServer({db:join(root,"store.db"),profile:loadProfile("./profiles/design.json"),port,intervalMinutes:0,token:secret});
  try {
    await new Promise<void>(resolve=>server.listening?resolve():server.on("listening",resolve));
    const url="http://127.0.0.1:"+port+"/status";
    const forbidden=await fetch(url);
    assert.equal(forbidden.status,401);
    const cross=await fetch(url,{headers:{authorization:"Bearer "+secret,origin:"https://evil.example"}});
    assert.equal(cross.status,403);
    const ok=await fetch(url,{headers:{authorization:"Bearer "+secret}});
    assert.equal(ok.status,200);
    const value=await ok.json() as Record<string,unknown>;
    assert.equal(value.connectedSource,"none");
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(root,{recursive:true,force:true});
  }
});
