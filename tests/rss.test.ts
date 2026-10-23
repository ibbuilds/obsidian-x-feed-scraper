import {test} from "node:test";
import assert from "node:assert/strict";
import {parseFeed} from "../packages/connectors/rss.ts";

const RSS='<?xml version="1.0"?><rss version="2.0"><channel><title>Design</title>'+
 '<item><guid>article-1</guid><title>Great React components</title>'+
 '<link>https://example.org/posts/react?utm_source=rss</link>'+
 '<description><![CDATA[<p>Original accessible designs, with examples.</p>]]></description>'+
 '<pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>'+
 '<item><guid>article-1</guid><title>Duplicate</title><link>https://example.org/posts/react</link></item>'+
 '<item><guid>article-2</guid><title>Next</title><link>https://example.org/posts/motion</link></item>'+
 '</channel></rss>';
test("RSS entries are normalized, capped and stable across runs",()=>{
  const first=parseFeed(RSS,"https://example.org/feed.xml");
  const second=parseFeed(RSS,"https://example.org/feed.xml");
  assert.equal(first.length,2);
  assert.equal(first[0].url,"https://example.org/posts/react");
  assert.equal(first[0].id,second[0].id);
  assert.equal(first[0].publishedAt,"2026-10-19T10:00:00.000Z");
  assert.ok(first[0].text.includes("Original accessible designs"));
});
test("Atom feeds with relative links are supported",()=>{
 const atom='<feed><title>Research</title><entry><id>a</id><title>Study on UX</title><link href="/articles/ux"/></entry></feed>';
 const result=parseFeed(atom,"https://example.org/feed");
 assert.equal(result.length,1);
 assert.equal(result[0].url,"https://example.org/articles/ux");
});
test("invalid documents are rejected",()=>{
 assert.throws(()=>parseFeed("<foo><bar/></foo>","https://example.org/rss"));
});
