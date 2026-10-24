import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {jsonSnapshotSource} from "../packages/adapters/snapshots.ts";
import {builtinSources} from "../packages/adapters/builtin.ts";

const append=builtinSources.adapters!.find(item=>item.id==="json-file")!;
const observations=(suffix:string)=>[
  {id:"one",type:"record",title:"First"},
  {id:"two",type:"record",title:"Second "+suffix},
  {id:"three",type:"record",title:"Third"}
];
for(const source of [append,jsonSnapshotSource]){
  test(source.id+" freezes paginated input within one execution, but reloads in the next",async()=>{
    const root=mkdtempSync(join(tmpdir(),"source-scraper-pages-"));
    const file=join(root,"records.json"),src={id:"fixture",adapter:source.id,config:{path:file}};
    try{
      writeFileSync(file,JSON.stringify(observations("before")));
      const signal=new AbortController().signal;
      const first=await source.collect({source:src,cursor:undefined,limit:1,signal});
      assert.equal(first.observations[0].id,"one");
      assert.equal(first.hasMore,true);
      assert.ok(first.nextCursor);
      writeFileSync(file,JSON.stringify(observations("after")));
      const second=await source.collect({source:src,cursor:first.nextCursor,limit:1,signal});
      assert.equal(second.observations[0].title,"Second before",
        "Changed file must not splice another revision into an in-flight page");
      const newSignal=new AbortController().signal;
      const fresh=await source.collect({source:src,cursor:undefined,limit:3,signal:newSignal});
      assert.equal(fresh.observations[1].title,"Second after",
        "A future collection must not reuse the previous run's input");
      if(source.id==="json-snapshot"){
        const restart=await source.collect({
          source:src,cursor:first.nextCursor,limit:1,signal:newSignal
        });
        assert.equal(restart.observations[0].id,"one",
          "Changed revision must restart safely from the first record");
      }
    }finally{rmSync(root,{recursive:true,force:true});}
  });
}
