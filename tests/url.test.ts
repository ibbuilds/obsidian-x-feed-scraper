import {test} from "node:test";
import assert from "node:assert/strict";
import {extractUrls,isLocalOrUnsafeAddress,normalizeUrl,safeHostname} from "../packages/core/url.ts";
import type {Post} from "../packages/core/types.ts";

const post:Post={id:"1",url:"https://x.com/sample/status/1",author:"A",username:"a",text:""};

test("normalization removes tracking but preserves meaningful paths and query",()=>{
  assert.equal(normalizeUrl("https://EXAMPLE.com/docs/?utm_source=x&b=2&a=1#top"),"https://example.com/docs?a=1&b=2");
  assert.notEqual(normalizeUrl("https://example.com/articles/a"),normalizeUrl("https://example.com/articles/b"));
  assert.equal(normalizeUrl("https://example.com/page?fbclid=123"),normalizeUrl("https://example.com/page"));
  assert.throws(()=>normalizeUrl("file:///etc/passwd"));
  assert.throws(()=>normalizeUrl("https://user:pass@example.com"));
});
test("multiple, quoted, and entity URLs are extracted once",()=>{
  const urls=extractUrls({...post,text:"Read (https://example.org/a?utm_medium=x). https://github.com/acme/tool",
    urls:["https://example.org/a","https://x.com/a/status/3"],quotedUrls:["https://example.org/b"]});
  assert.deepEqual(urls,["https://example.org/a","https://github.com/acme/tool","https://example.org/b"]);
});
test("visual-only references do not fabricate a project link",()=>{
  assert.deepEqual(extractUrls({...post,text:"A visual experiment",images:["https://example.org/shot.png"]}),[]);
});
test("IP and loopback destinations cannot be used for enrichment",()=>{
  for (const host of ["127.0.0.1","10.2.3.4","169.254.169.254","192.168.1.1","[::1]","localhost","local.internal"]) {
    assert.throws(()=>safeHostname("http://"+host+"/"));
  }
  assert.equal(isLocalOrUnsafeAddress("8.8.8.8"),false);
  assert.equal(safeHostname("https://example.com"),"example.com");
});

test("shortened t.co links remain explicit unresolved candidates",()=>{
  const urls=extractUrls({...post,text:"Worth reading https://t.co/aBcDe"});
  assert.deepEqual(urls,["https://t.co/aBcDe"]);
});

test("credential-like URL parameters cannot enter normalized sources",()=>{
  for(const query of ["token=my-secret","api_key=abc","session=xyz","Authorization=Bearer123","client_secret=oops","jwt=header.payload.sig"]){
    assert.throws(()=>normalizeUrl("https://example.org/resource?"+query),/credential-like/);
  }
  assert.equal(normalizeUrl("https://example.org/resource?utm_source=x&id=7"),"https://example.org/resource?id=7");
});
