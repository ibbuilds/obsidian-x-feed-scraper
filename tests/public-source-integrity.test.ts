import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {syncBuiltinESMExports} from "node:module";
import dns from "node:dns/promises";
import http from "node:http";
import type * as HttpTypes from "node:http";
import https from "node:https";
import {parseProductPage,publicProductSource} from "../packages/adapters/product-jsonld.ts";
import {publicJsonSource} from "../packages/adapters/snapshots.ts";
import {fetchPublicText} from "../packages/connectors/public-http.ts";

const offer={"@type":"Offer",price:"100",priceCurrency:"USD"};
const product=(name:string,offers?:unknown)=>({"@type":"Product",name,offers});
const page=(data:unknown)=>'<script type="application/ld+json">'+JSON.stringify(data)+'</script>';

test("product pages reject a recommendation when the principal product has multiple offers",()=>{
  const html=page([
    product("Principal product",[offer,{...offer,price:"110"}]),
    product("Related accessory",{...offer,price:"5"})
  ]);
  assert.throws(()=>parseProductPage(html,"https://shop.example/principal"),/unambiguous/);
});

test("product pages reject a recommendation when another product has no supported offer",()=>{
  const html=page({"@graph":[
    product("Principal product"),product("Related accessory",{...offer,price:"5"})
  ]});
  assert.throws(()=>parseProductPage(html,"https://shop.example/principal"),/unambiguous/);
});

test("multiple priced products and multiple offers remain ambiguous",()=>{
  for(const data of [
    [product("First",offer),product("Second",offer)],
    product("Variants",[offer,{...offer,price:"110"}])
  ])assert.throws(()=>parseProductPage(page(data),"https://shop.example/item"),/unambiguous/);
});

test("a sole product with a supported offer still preserves its claimed price",()=>{
  for(const data of [
    product("Single product",offer),
    {"@graph":[product("Single product",offer)]},
    product("Single product",{"@type":"AggregateOffer",offers:[offer]})
  ]){
    const observation=parseProductPage(page(data),"https://shop.example/item");
    assert.equal(observation.title,"Single product");
    assert.equal(observation.attributes?.price,100);
    assert.equal(observation.attributes?.currency,"USD");
    assert.equal(observation.url,"https://shop.example/item");
  }
});

interface ResponseFixture {
  status?:number;location?:string;type?:string;body?:string;
}
/** Replace every DNS lookup and HTTP request; these tests never open a socket. */
function mockPublicHttp(t:TestContext,routes:Record<string,ResponseFixture>,
  addresses:Record<string,string>={}){
  const requests:string[]=[],lookups:string[]=[];
  t.mock.method(dns,"lookup",(async(hostname:string)=>{
    lookups.push(hostname);
    return [{address:addresses[hostname]||"93.184.216.34",family:4}];
  }) as unknown as typeof dns.lookup);
  const request=(url:URL,_options:HttpTypes.RequestOptions,
    callback:(response:HttpTypes.IncomingMessage)=>void)=>{
    requests.push(url.toString());
    const route=routes[url.toString()];
    assert.ok(route,"Unexpected mocked request: "+url);
    const req=new EventEmitter() as HttpTypes.ClientRequest;
    req.end=(()=>{
      queueMicrotask(()=>{
        const res=Readable.from([Buffer.from(route.body||"")]) as HttpTypes.IncomingMessage;
        res.statusCode=route.status??200;
        res.headers={"content-type":route.type||"application/json",
          ...(route.location?{location:route.location}:{})};
        callback(res);
      });
      return req;
    }) as typeof req.end;
    req.destroy=(error?:Error)=>{if(error)req.emit("error",error);return req;};
    return req;
  };
  t.mock.method(http,"request",request as typeof http.request);
  t.mock.method(https,"request",request as typeof https.request);
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return {requests,lookups};
}

for(const adapter of ["public-json","public-product"] as const){
  test(adapter+" refuses HTTPS downgrade before the destination is resolved or requested",async t=>{
    const {requests,lookups}=mockPublicHttp(t,{
      "https://catalog.example/item":{status:302,location:"http://plaintext.example/item"},
      "http://plaintext.example/item":adapter==="public-json"?
        {body:'{"records":[{"id":"one","title":"Example"}]}'}:
        {type:"text/html",body:page(product("Example",offer))}
    });
    const context={cursor:undefined,limit:10,signal:new AbortController().signal};
    const collection=adapter==="public-json"?
      publicJsonSource.collect({...context,source:{id:"public-api",adapter,config:{
        url:"https://catalog.example/item",mapping:{
          itemsPath:"records",idPath:"id",titlePath:"title",type:"product"
        }
      }}}):
      publicProductSource.collect({...context,source:{id:"product-page",adapter,
        config:{urls:["https://catalog.example/item"]}}});
    await assert.rejects(collection,/HTTPS.*HTTP|downgrade/i);
    assert.deepEqual(requests,["https://catalog.example/item"]);
    assert.deepEqual(lookups,["catalog.example"]);
  });
}

const jsonOptions={accept:"application/json",types:["application/json"]};
test("a public HTTP source cannot downgrade again after upgrading to HTTPS",async t=>{
  const {requests,lookups}=mockPublicHttp(t,{
    "http://legacy.example/data":{status:301,location:"https://secure.example/data"},
    "https://secure.example/data":{status:302,location:"http://plaintext.example/data"},
    "http://plaintext.example/data":{body:"[]"}
  });
  await assert.rejects(fetchPublicText("http://legacy.example/data",jsonOptions),/HTTPS.*HTTP|downgrade/i);
  assert.deepEqual(requests,["http://legacy.example/data","https://secure.example/data"]);
  assert.deepEqual(lookups,["legacy.example","secure.example"]);
});

test("public HTTPS redirects still resolve and return the final public response",async t=>{
  const {requests}=mockPublicHttp(t,{
    "https://catalog.example/data":{status:301,location:"https://cdn.example/data"},
    "https://cdn.example/data":{body:'{"items":[]}'}
  });
  const response=await fetchPublicText("https://catalog.example/data",jsonOptions);
  assert.equal(response.url,"https://cdn.example/data");
  assert.equal(response.body,'{"items":[]}');
  assert.equal(requests.length,2);
});

test("an explicitly configured public HTTP source remains supported",async t=>{
  const {requests}=mockPublicHttp(t,{"http://legacy.example/data":{body:"[]"}});
  const response=await fetchPublicText("http://legacy.example/data",jsonOptions);
  assert.equal(response.url,"http://legacy.example/data");
  assert.equal(response.body,"[]");
  assert.deepEqual(requests,["http://legacy.example/data"]);
});

test("HTTPS redirects cannot request a destination resolving to a private address",async t=>{
  const {requests,lookups}=mockPublicHttp(t,{
    "https://catalog.example/data":{status:302,location:"https://private.example/data"}
  },{"private.example":"127.0.0.1"});
  await assert.rejects(fetchPublicText("https://catalog.example/data",jsonOptions),/private DNS/);
  assert.deepEqual(requests,["https://catalog.example/data"]);
  assert.deepEqual(lookups,["catalog.example","private.example"]);
});
