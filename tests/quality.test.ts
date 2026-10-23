import {test} from "node:test";
import assert from "node:assert/strict";
import {evaluate} from "../packages/quality/evaluate.ts";
import {loadProfile} from "../packages/core/profile.ts";

const p=loadProfile("./profiles/design.json");
test("low-evidence candidate never receives confident approval",()=>{
  const e=evaluate("https://example.com/ui","ui motion","motion design",{},p);
  assert.equal(e.status,"needs_review");
  assert.ok(e.confidence<p.confidenceThreshold);
});
test("public evidence, access, and relevance are independently tracked",()=>{
  const e=evaluate("https://example.com/gallery","Motion design interaction website", "motion design interaction",{
    title:"Motion design gallery for interactive interfaces",
    description:"A curated open and extensive library of interaction components and practical frontend motion patterns.",
    contentType:"text/html",
    access:"free",license:"MIT"
  },p);
  assert.equal(e.access,"free");
  assert.ok(e.score>=p.scoreThreshold);
  assert.equal(e.status,"high_quality");
  assert.ok(e.reasons.some(reason=>reason.includes("heuristic")));
});
test("paid does not equal open-source; references are not rediscovered",()=>{
  const paid=evaluate("https://example.com/learn","motion design","motion",{
    title:"Professional lessons",description:"A library of premium motion tutorials for professional design teams with real examples.",
    access:"paid",contentType:"text/html"
  },p);
  assert.equal(paid.access,"paid");
  assert.ok(paid.reasons.some(x=>x.includes("Paid")));
  const duplicate=evaluate("https://example.org/path?utm_source=x","UI","UI",{},p,new Set(["https://example.org/path"]));
  assert.equal(duplicate.category,"existing_reference");
  assert.equal(duplicate.score,0);
});
