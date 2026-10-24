import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {syncBuiltinESMExports} from "node:module";
import dns from "node:dns/promises";
import https from "node:https";
import type {ClientRequest,IncomingMessage,RequestOptions} from "node:http";
import {parseProject} from "../packages/core/project-config.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {exportProject} from "../packages/core/export-project.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {getWebhookDeliveryStatus} from "../packages/outputs/webhook.ts";
import {postPublicWebhook,validateWebhookEndpoint} from "../packages/connectors/public-webhook.ts";
import type {JsonRecord,Observation} from "../packages/sdk/contracts.ts";

interface MockResponse {status?:number;body?:string;location?:string;error?:string;hang?:boolean}
interface CapturedRequest {url:string;options:RequestOptions;body:string;destroyed:boolean}
/** All DNS and HTTPS I/O is replaced before adapters run; no sockets are opened. */
function mockNetwork(t:TestContext,response:(index:number)=>MockResponse=()=>({status:204}),
  resolveAddress:(host:string)=>Promise<Array<{address:string;family:number}>>=
    async()=>[{address:"93.184.216.34",family:4}]){
  const requests:CapturedRequest[]=[],lookups:string[]=[];
  t.mock.method(dns,"lookup",(async(host:string)=>{
    lookups.push(host);return resolveAddress(host);
  }) as unknown as typeof dns.lookup);
  const request=(url:URL,options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{
    const captured={url:url.toString(),options,body:"",destroyed:false};
    requests.push(captured);
    const fixture=response(requests.length-1),req=new EventEmitter() as ClientRequest;
    let res:IncomingMessage|undefined;
    req.destroy=()=>{captured.destroyed=true;res?.destroy();return req;};
    req.end=((data?:string)=>{
      captured.body=data||"";
      queueMicrotask(()=>{
        if(fixture.error){req.emit("error",new Error(fixture.error));return;}
        res=(fixture.hang?new Readable({read(){}}):Readable.from([Buffer.from(fixture.body||"")])) as IncomingMessage;
        res.statusCode=fixture.status??200;
        res.headers={"content-type":"application/json",...(fixture.location?{location:fixture.location}:{})};
        callback(res);
      });
      return req;
    }) as typeof req.end;
    return req;
  };
  t.mock.method(https,"request",request as typeof https.request);
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return {requests,lookups};
}
const registry=createDefaultRegistry();
const endpoint="https://hooks.example/receive/";
const item=(id="one",price=100):Observation=>({id,type:"product",title:"Product "+id,
  text:"Useful match",url:"https://shop.example/items/"+id,attributes:{price,currency:"USD"}});
function setup(t:TestContext,config:JsonRecord={},id="webhook-project"){
  const root=mkdtempSync(join(tmpdir(),"discovery-webhook-")),db=join(root,"library.sqlite"),file=join(root,"items.json");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const write=(items:Observation[])=>writeFileSync(file,JSON.stringify(items));
  write([item()]);
  const project=parseProject({id,name:"Synthetic webhook project",sources:[
    {id:"shop",adapter:"json-snapshot",config:{path:file}}
  ],pipeline:["observation-entity"],policy:{minimumScore:0},watch:{rules:[
    {id:"new",operator:"created",path:"$"},
    {id:"price",operator:"changed",path:"/attributes/price"}
  ]},outputs:[{id:"alerts",adapter:"webhook",config:{enabled:true,url:endpoint,...config}}]});
  const collect=async()=>{
    const result=await runProject(db,project,registry);
    assert.equal(result.success,true,JSON.stringify(result));
  };
  const deliver=()=>exportProject(db,project,registry);
  return {root,db,file,project,write,collect,deliver};
}
function scopedEnv(t:TestContext,key:string,value:string){
  const previous=process.env[key];process.env[key]=value;
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
}

test("webhook output is inert without explicit opt-in and status does not activate it",async t=>{
  const io=mockNetwork(t),ctx=setup(t,{enabled:false});
  assert.deepEqual(getWebhookDeliveryStatus(ctx.db,ctx.project.id),[]);
  await ctx.collect();
  assert.deepEqual(getWebhookDeliveryStatus(ctx.db,ctx.project.id),[]);
  const result=await ctx.deliver();
  assert.equal((result[0].result as {enabled:boolean}).enabled,false);
  assert.equal(io.requests.length,0);
  assert.equal(io.lookups.length,0);
  const store=new KnowledgeStore(ctx.db);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name LIKE 'kb_webhook_%'").get()?.count,0);
  store.close();
});

test("activation skips history and new alert delivery is stable across repeated sync and export",async t=>{
  const io=mockNetwork(t),ctx=setup(t);
  await ctx.collect();await ctx.deliver();
  assert.equal(io.requests.length,0,"Existing creation alert must not be sent by default");
  ctx.write([item("one",80)]);await ctx.collect();await ctx.deliver();
  await ctx.collect();await ctx.deliver();
  assert.equal(io.requests.length,1);
  const payload=JSON.parse(io.requests[0].body);
  assert.equal(io.requests[0].url,endpoint,"A significant endpoint trailing slash is preserved");
  assert.equal(payload.schemaVersion,1);
  assert.equal(payload.project.id,ctx.project.id);
  assert.equal(payload.alert.ruleId,"price");
  assert.equal(payload.change.path,"/attributes/price");
  assert.equal(payload.change.before,100);assert.equal(payload.change.after,80);
  assert.deepEqual(payload.source,{connectionId:"shop",adapterId:"json-snapshot",observationId:"one"});
  assert.equal(payload.entity.key,"product:one");
  assert.equal(payload.idempotencyKey,(io.requests[0].options.headers as Record<string,string>)["idempotency-key"]);
  assert.equal(getWebhookDeliveryStatus(ctx.db,ctx.project.id)[0].counts.delivered,1);
});

test("explicit historical backfill is bounded and never resends a successful alert",async t=>{
  const io=mockNetwork(t),ctx=setup(t,{maxPerExport:1});
  ctx.write([item("one"),item("two")]);await ctx.collect();await ctx.deliver();
  ctx.project.outputs[0].config.includeExisting=true;
  await ctx.deliver();assert.equal(io.requests.length,1);
  await ctx.deliver();assert.equal(io.requests.length,2);
  await ctx.deliver();assert.equal(io.requests.length,2);
  assert.notEqual(JSON.parse(io.requests[0].body).alert.id,JSON.parse(io.requests[1].body).alert.id);
});

test("outputs and projects have independent delivery identities for the same endpoint",async t=>{
  const io=mockNetwork(t),ctx=setup(t,{includeExisting:true});
  ctx.project.outputs.push({...ctx.project.outputs[0],id:"other-output",config:{...ctx.project.outputs[0].config}});
  await ctx.collect();await ctx.deliver();
  const other={...ctx.project,id:"other-project"};
  assert.equal((await runProject(ctx.db,other,registry)).success,true);
  await exportProject(ctx.db,other,registry);
  assert.equal(io.requests.length,4);
  assert.equal(new Set(io.requests.map(req=>JSON.parse(req.body).idempotencyKey)).size,4);
  assert.equal(getWebhookDeliveryStatus(ctx.db,ctx.project.id).length,2);
  assert.equal(getWebhookDeliveryStatus(ctx.db,other.id,"alerts").length,1);
});

test("an export stops at its total time budget and resumes undelivered alerts later",async t=>{
  let clock=0;
  const io=mockNetwork(t,()=>{clock=30_000;return {status:204};});
  const ctx=setup(t,{includeExisting:true});
  ctx.write([item("one"),item("two")]);await ctx.collect();
  t.mock.method(Date,"now",()=>clock);
  const first=await ctx.deliver();
  assert.equal((first[0].result as {budgetReached:boolean}).budgetReached,true);
  assert.equal(io.requests.length,1);
  await ctx.deliver();
  assert.equal(io.requests.length,2);
  assert.equal(getWebhookDeliveryStatus(ctx.db,ctx.project.id)[0].counts.delivered,2);
});

test("a failed delivery retries an identical payload and key without persisting endpoint or auth secrets",async t=>{
  const secretPath="https://hooks.example/private-path-secret",secretToken="synthetic-bearer-secret";
  scopedEnv(t,"DISCOVERY_TEST_WEBHOOK_URL",secretPath);
  scopedEnv(t,"DISCOVERY_TEST_WEBHOOK_TOKEN",secretToken);
  const io=mockNetwork(t,index=>index===0?{error:"network failure "+secretPath+" "+secretToken}:{status:204});
  const ctx=setup(t,{includeExisting:true});
  ctx.project.outputs[0].config={enabled:true,includeExisting:true,
    endpointEnv:"DISCOVERY_TEST_WEBHOOK_URL",bearerTokenEnv:"DISCOVERY_TEST_WEBHOOK_TOKEN"};
  await ctx.collect();await ctx.deliver();
  const failed=getWebhookDeliveryStatus(ctx.db,ctx.project.id)[0];
  assert.equal(failed.counts.failed,1);assert.equal(failed.recent[0].attempts,1);
  assert.doesNotMatch(JSON.stringify(failed),/private-path-secret|synthetic-bearer-secret/);
  await ctx.deliver();await ctx.deliver();
  assert.equal(io.requests.length,2);
  assert.equal(io.requests[0].body,io.requests[1].body);
  const firstHeaders=io.requests[0].options.headers as Record<string,string>;
  const nextHeaders=io.requests[1].options.headers as Record<string,string>;
  assert.equal(firstHeaders.authorization,"Bearer "+secretToken);
  assert.equal(firstHeaders["idempotency-key"],nextHeaders["idempotency-key"]);
  const store=new KnowledgeStore(ctx.db);
  const saved=JSON.stringify({outputs:store.db.prepare("SELECT * FROM kb_webhook_outputs").all(),
    deliveries:store.db.prepare("SELECT * FROM kb_webhook_deliveries").all()});
  assert.doesNotMatch(saved,/private-path-secret|synthetic-bearer-secret/);
  store.close();
  const done=getWebhookDeliveryStatus(ctx.db,ctx.project.id)[0];
  assert.equal(done.counts.delivered,1);assert.equal(done.recent[0].attempts,2);
});

test("exhausted retries remain visible and increasing the explicit attempt limit can resume them",async t=>{
  const io=mockNetwork(t,index=>({status:index<2?503:204})),ctx=setup(t,{includeExisting:true,maxAttempts:2});
  await ctx.collect();await ctx.deliver();await ctx.deliver();await ctx.deliver();
  assert.equal(io.requests.length,2);
  assert.equal(getWebhookDeliveryStatus(ctx.db,ctx.project.id)[0].counts.exhausted,1);
  ctx.project.outputs[0].config.maxAttempts=3;
  await ctx.deliver();
  assert.equal(io.requests.length,3);
  assert.equal(getWebhookDeliveryStatus(ctx.db,ctx.project.id)[0].counts.delivered,1);
  assert.equal(io.requests[0].body,io.requests[2].body);
});

test("changing a destination under an existing output ID fails before any delivery",async t=>{
  const io=mockNetwork(t),ctx=setup(t,{includeExisting:true});
  await ctx.collect();await ctx.deliver();
  ctx.project.outputs[0].config.url="https://other.example/receive";
  await assert.rejects(ctx.deliver(),/destination changed.*new output ID/);
  assert.equal(io.requests.length,1);
  ctx.project.outputs[0].id="new-destination";
  await ctx.deliver();
  assert.equal(io.requests.length,2);
  assert.notEqual(JSON.parse(io.requests[0].body).idempotencyKey,JSON.parse(io.requests[1].body).idempotencyKey);
});

test("rejected and below-policy entities are not sent, including a rejected failed retry",async t=>{
  const io=mockNetwork(t,()=>({status:503})),ctx=setup(t,{includeExisting:true});
  ctx.project.policy={minimumScore:20,includeKeywords:["match"],excludeKeywords:[]};
  ctx.write([item("eligible"),item("rejected"),{...item("low"),text:"unrelated"}]);
  await ctx.collect();
  let store=new KnowledgeStore(ctx.db);
  store.reviewEntity(ctx.project.id,"product:rejected","rejected","Synthetic rejection");store.close();
  await ctx.deliver();
  assert.equal(io.requests.length,1);
  assert.equal(JSON.parse(io.requests[0].body).entity.key,"product:eligible");
  store=new KnowledgeStore(ctx.db);
  store.reviewEntity(ctx.project.id,"product:eligible","rejected","Rejected after initial failed delivery");store.close();
  await ctx.deliver();
  assert.equal(io.requests.length,1);
});

test("webhook destinations reject insecure schemes, credentials, X and local addresses",()=>{
  for(const url of ["http://hooks.example","https://user:secret@hooks.example",
    "https://hooks.example?token=secret","https://hooks.example?utm_token=secret",
    "https://x.com","https://www.x.com.","https://api.twitter.com",
    "https://t.co/example","https://localhost","https://host.local.","https://host.internal",
    "https://127.0.0.1","https://169.254.169.254","https://[::1]"]){
    assert.throws(()=>validateWebhookEndpoint(url),/Webhook delivery destination/);
  }
});

test("mixed DNS answers containing a private address never create a webhook request",async t=>{
  const io=mockNetwork(t,()=>({status:204}),async()=>[
    {address:"93.184.216.34",family:4},{address:"127.0.0.1",family:4}
  ]);
  await assert.rejects(postPublicWebhook(endpoint,"{}",{idempotencyKey:"synthetic-key-123456"}),/destination/);
  assert.equal(io.requests.length,0);
});

test("HTTPS sockets use the already validated DNS address and family",async t=>{
  const io=mockNetwork(t);
  await postPublicWebhook(endpoint,"{}",{idempotencyKey:"synthetic-key-123456"});
  const options=io.requests[0].options;
  assert.equal(options.family,4);
  const pinnedLookup=options.lookup as (host:string,options:unknown,
    callback:(error:Error|null,address:string,family:number)=>void)=>void;
  const resolved=await new Promise<{address:string;family:number}>((resolve,reject)=>{
    pinnedLookup("hooks.example",{},(error,address,family)=>error?reject(error):resolve({address,family}));
  });
  assert.deepEqual(resolved,{address:"93.184.216.34",family:4});
  assert.equal(io.lookups.length,1,"Creating the socket must not perform a second DNS lookup");
});

test("all redirects are rejected without forwarding body or authorization",async t=>{
  const destinations=["http://plaintext.example/","https://other.example/","https://127.0.0.1/"];
  const io=mockNetwork(t,index=>({status:[301,307,308][index],location:destinations[index]}));
  for(let i=0;i<destinations.length;i++){
    await assert.rejects(postPublicWebhook(endpoint,"{}",{
      idempotencyKey:"synthetic-key-123456",bearerToken:"synthetic-secret"
    }),/redirect/);
  }
  assert.deepEqual(io.requests.map(req=>req.url),[endpoint,endpoint,endpoint]);
  assert.deepEqual(io.lookups,["hooks.example","hooks.example","hooks.example"]);
});

test("webhook payload and response sizes are bounded",async t=>{
  const io=mockNetwork(t,()=>({body:"x".repeat(16_385)}));
  await assert.rejects(postPublicWebhook(endpoint,"x".repeat(131_073),{
    idempotencyKey:"synthetic-key-123456"
  }),/payload/);
  assert.equal(io.lookups.length,0);
  await assert.rejects(postPublicWebhook(endpoint,"{}",{idempotencyKey:"synthetic-key-123456"}),/response/);
  assert.equal(io.requests[0].destroyed,true);
});

test("the total webhook deadline includes DNS and late answers cannot send a request",async t=>{
  let complete!:(value:Array<{address:string;family:number}>)=>void;
  const io=mockNetwork(t,()=>({status:204}),()=>new Promise(resolve=>{complete=resolve;}));
  await assert.rejects(postPublicWebhook(endpoint,"{}",{
    idempotencyKey:"synthetic-key-123456",timeoutMs:10
  }),/timeout/);
  complete([{address:"93.184.216.34",family:4}]);
  await new Promise<void>(resolve=>queueMicrotask(resolve));
  assert.equal(io.requests.length,0);
});

test("a stalled response times out and an explicit abort destroys the pending request",async t=>{
  const io=mockNetwork(t,()=>({hang:true}));
  await assert.rejects(postPublicWebhook(endpoint,"{}",{
    idempotencyKey:"synthetic-key-123456",timeoutMs:10
  }),/timeout/);
  assert.equal(io.requests[0].destroyed,true);
  const controller=new AbortController();
  const delivery=postPublicWebhook(endpoint,"{}",{
    idempotencyKey:"synthetic-key-123456",signal:controller.signal
  });
  await new Promise<void>(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(delivery,/aborted/);
  assert.equal(io.requests[1].destroyed,true);
});
