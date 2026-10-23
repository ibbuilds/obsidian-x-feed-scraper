import {test} from "node:test";
import assert from "node:assert/strict";
import {appendApprovedReference,libraryContains} from "../apps/obsidian-plugin/library.ts";

const source={url:"https://example.org/tool?utm_source=x",title:"Tool [Open]\nUnsafe",
  category:"frontend",status:"approved"};
test("explicit library additions preserve existing content and detect tracked duplicates",()=>{
  const original="# My library\n- [Motion](https://motion.dev/docs)\n";
  const added=appendApprovedReference(original,source);
  assert.ok(added.startsWith(original.trimEnd()));
  assert.match(added,/## Approved via X Feed Scraper/);
  assert.ok(libraryContains(added,"https://example.org/tool?utm_medium=y"));
  assert.throws(()=>appendApprovedReference(added,source),/Already/);
});
test("inserts within dedicated section, never into a different topic",()=>{
  const before="# Research\n\n## Approved via X Feed Scraper\n- [Old](https://example.org/old)\n\n## Other topic\nKeep.\n";
  const after=appendApprovedReference(before,source);
  assert.ok(after.indexOf("example.org/tool")<after.indexOf("## Other topic"));
  assert.ok(after.includes("Keep."));
  assert.ok(after.includes("[Old]"));
});
test("rejected sources cannot be inserted",()=>{
  assert.throws(()=>appendApprovedReference("# References",{...source,status:"rejected"}),/approved/);
});
