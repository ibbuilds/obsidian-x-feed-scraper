import {performance} from "node:perf_hooks";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {jsonSnapshotSource} from "../packages/adapters/snapshots.ts";
import {builtinSources} from "../packages/adapters/builtin.ts";

const n=Number(process.argv[2]||6000),size=Number(process.argv[3]||50);
if(!Number.isSafeInteger(n)||n<1||n>10000||
 !Number.isSafeInteger(size)||size<1||size>500)throw Error("Invalid bounds");
const root=mkdtempSync(join(tmpdir(),"source-scraper-page-bench-"));
const file=join(root,"records.json");
const records=Array.from({length:n},(_,i)=>({id:"id-"+i,type:"record",
  title:"Synthetic record "+i,text:"Content ".repeat(8),attributes:{group:i%11}}));
writeFileSync(file,JSON.stringify(records));
const result={count:n,pageSize:size,pages:Math.ceil(n/size),phases:{}};
try{
  for(const source of [builtinSources.adapters.find(x=>x.id==="json-file"),jsonSnapshotSource]){
    if(!source)throw Error("Missing source adapter");
    const signal=new AbortController().signal,config={id:"bench",adapter:source.id,config:{path:file}};
    let cursor,found=0,seen=0;
    const t=performance.now();
    for(let page=0;page<Math.ceil(n/size)+2;page++){
      const response=await source.collect({source:config,cursor,limit:size,signal});
      found+=response.observations.length;seen++;
      if(!response.hasMore)break;
      cursor=response.nextCursor;
      if(!cursor)throw Error("Missing pagination cursor");
    }
    if(found!==n)throw Error("Lost records: "+source.id+" "+found);
    result.phases[source.id==="json-file"?"jsonFileMs":"jsonSnapshotMs"]=
      Math.round((performance.now()-t)*100)/100;
    result[source.id==="json-file"?"jsonFilePages":"jsonSnapshotPages"]=seen;
  }
  process.stdout.write(JSON.stringify(result)+"\n");
}finally{rmSync(root,{recursive:true,force:true});}
