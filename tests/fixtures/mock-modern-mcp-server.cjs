/* Synthetic MCP protocol 2026-07-28 server. Stateless per-request _meta. */
"use strict";
const readline=require("node:readline");
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const version="2026-07-28";
function send(id,result){
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
}
function error(id,code){
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,error:{code,message:"Synthetic protocol failure"}})+"\n");
}
rl.on("line",line=>{
 let request;
 try{request=JSON.parse(line);}catch{return;}
 const {id,method,params}=request;
 if(method==="server/discover"){
  send(id,{resultType:"complete",supportedVersions:[version],capabilities:{tools:{}},
   _meta:{"io.modelcontextprotocol/serverInfo":{name:"modern-test",version:"1.0.0"}}});
  return;
 }
 if(method==="initialize"){error(id,-32601);return;}
 const meta=params?._meta||{};
 if(meta["io.modelcontextprotocol/protocolVersion"]!==version||
   !meta["io.modelcontextprotocol/clientCapabilities"]){
  error(id,-32602);return;
 }
 if(method==="tools/list"){
  send(id,{resultType:"complete",
   tools:[{name:"modern_observations",inputSchema:{type:"object"}}]});
  return;
 }
 if(method==="tools/call"){
  if(params.name!=="modern_observations"){error(id,-32602);return;}
  send(id,{resultType:"complete",structuredContent:{
   observations:[{id:"modern-1",type:"science",title:"Metagenomics sample",
     text:"Data from a 2026 protocol server",attributes:{edition:2026}}],
   hasMore:false,nextCursor:"done"
  }});
  return;
 }
 error(id,-32601);
});
