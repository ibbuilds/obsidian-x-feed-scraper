import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync,statSync} from "node:fs";
import {resolve} from "node:path";
import {unzipSync} from "fflate";
test("Obsidian distribution ships complete installable desktop plugin",()=>{
  const archive=resolve("dist/obsidian-x-feed-scraper.zip");
  assert.equal(existsSync(archive),true);
  const archiveEntries=unzipSync(new Uint8Array(readFileSync(archive)));
  for(const file of ["main.js","manifest.json","collector.cjs","design.json","styles.css"]){
    assert.ok(archiveEntries[file]?.byteLength>0,"Missing "+file);
  }
  const manifest=JSON.parse(Buffer.from(archiveEntries["manifest.json"]).toString("utf8")) as {id:string;version:string;isDesktopOnly:boolean};
  assert.equal(manifest.id,"x-feed-scraper");
  assert.equal(manifest.isDesktopOnly,true);
  assert.equal(manifest.version,"0.2.0");
  assert.ok(statSync(archive).size>10000);
  // Community plugin installers copy only these three standard assets.
  // The compiled main.js must therefore embed the collector and default profile.
  const standalone=Buffer.from(archiveEntries["main.js"]).toString("utf8");
  assert.ok(standalone.includes("collector-"),"main.js lacks embedded collector extraction");
  assert.ok(standalone.includes("design-"),"main.js lacks embedded profile extraction");
  assert.ok(standalone.length>50000,"main.js is unexpectedly small for a bundled runtime");
});
