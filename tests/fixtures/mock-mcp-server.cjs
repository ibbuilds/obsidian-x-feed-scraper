/* Synthetic legacy MCP stdio server for end-to-end protocol tests. No network calls. */
"use strict";
const readline=require("node:readline");
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function reply(id,result){
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
}
function err(id,code){
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,error:{code,message:"mock failure"}})+"\n");
}
rl.on("line",line=>{
 let req;
 try{req=JSON.parse(line);}catch{return;}
 if(req.method==="initialize"){
  reply(req.id,{protocolVersion:"2025-11-25",capabilities:{tools:{}},
    serverInfo:{name:"discovery-test-mcp",version:"1.0.0"}});
  return;
 }
 if(req.method==="notifications/initialized")return;
 if(req.method==="tools/list"){
  if(!req.params?.cursor){
   reply(req.id,{tools:[{name:"unrelated-tool",inputSchema:{type:"object"}}],
     nextCursor:"second-page"});return;
  }
  reply(req.id,{tools:["list_records","check_environment","tool_error","hang","invalid_data","provider_records"]
    .map(name=>({name,inputSchema:{type:"object"}}))});
  return;
 }
 if(req.method!=="tools/call"){err(req.id,-32601);return;}
 const name=req.params?.name, args=req.params?.arguments||{};
 if(name==="hang")return;
 if(name==="tool_error"){
  reply(req.id,{isError:true,content:[{type:"text",text:"Sensitive content was blocked"}]});return;
 }
 if(name==="invalid_data"){
  reply(req.id,{structuredContent:{observations:[{id:"",type:"record"}],hasMore:false}});return;
 }
 if(name==="provider_records"){
  reply(req.id,{structuredContent:{data:{
   rows:[{recordId:112,headline:"Infrastructure incident",
     details:"A useful security research observation",
     link:"https://example.org/incidents/112",priority:4,
     source:"trusted-internal-mcp"}],
   paging:{more:false,cursor:"end-of-observations"}
  }}});
  return;
 }
 if(name==="check_environment"){
  reply(req.id,{structuredContent:{observations:[{
   id:"env",type:"system-diagnostic",title:"Scoped environment",
   attributes:{tokenLeak:!!process.env.XFS_API_TOKEN,
    explicitVariable:process.env.MCP_TEST_ALLOWED_ENV||null}
  }],hasMore:false}});return;
 }
 if(name!=="list_records"){err(req.id,-32602);return;}
 const cursor=args.cursor;
 if(cursor===undefined){
  reply(req.id,{content:[{type:"text",text:JSON.stringify({observations:[
   {id:"sample-1",type:"lab-record",title:"Microscopy sample",text:"Cell imagery analysis",
    attributes:{specimen:"A",samples:3}}
  ],nextCursor:"cursor-1",hasMore:true})}]});return;
 }
 if(cursor==="cursor-1"){
  reply(req.id,{structuredContent:{observations:[
   {id:"sample-2",type:"lab-record",title:"Second experimental record",
    text:"Additional scientific sample",attributes:{specimen:"B",samples:7}}
  ],nextCursor:"done",hasMore:false}});return;
 }
 if(cursor==="done"){
  reply(req.id,{structuredContent:{observations:[],nextCursor:"done",hasMore:false}});return;
 }
 err(req.id,-32602);
});
