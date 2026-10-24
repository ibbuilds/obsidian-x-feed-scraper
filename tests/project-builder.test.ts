import {test} from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {buildProject,demoObservations} from "../packages/core/project-builder.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";

const id="p-sample-research-123abc89";
test("guided demo configuration produces executable generic project and no network processor",()=>{
  const project=buildProject({id,name:"Sample research",
    sourceType:"demo",demoPath:resolve("/tmp/offline-demo.json"),
    includeKeywords:"motion, motion, research",excludeKeywords:"sponsored",
    mode:"linked-resources",minimumScore:25});
  assert.equal(project.id,id);
  assert.equal(project.sources[0].adapter,"json-file");
  assert.deepEqual(project.pipeline,["linked-resources"]);
  assert.deepEqual(project.policy.includeKeywords,["motion","research"]);
  assert.equal(project.outputs[0].adapter,"obsidian");
  const registered=createDefaultRegistry();
  assert.equal(registered.sources.has(project.sources[0].adapter),true);
  assert.equal(registered.processors.has(project.pipeline[0]),true);
  assert.equal(registered.outputs.has(project.outputs[0].adapter),true);
  assert.equal(demoObservations().length,3);
  assert.equal(demoObservations()[2].url,undefined,"Demo must handle entities without URLs");
});
test("guided RSS configuration validates a public feed and supports public research opt-in",()=>{
  const project=buildProject({id,name:"Feed study",sourceType:"rss",
    sourceUrl:"https://example.org/feed.xml?utm_source=tests",includeKeywords:"python, science",
    mode:"extract-links",publicMetadata:true});
  assert.equal(project.sources[0].config.url,"https://example.org/feed.xml");
  assert.deepEqual(project.pipeline,["extract-links","public-metadata"]);
  assert.equal(parseProject(project).id,id);
  assert.throws(()=>buildProject({id,name:"Bad",sourceType:"rss",
    sourceUrl:"http://127.0.0.1/feed.xml?api_key=secret",mode:"extract-links"}),
    /credential-like/);
  assert.throws(()=>buildProject({id,name:"Not RSS",sourceType:"rss",
    sourceUrl:"https://x.com/user/status/1",mode:"extract-links"}),
    /not an authorized RSS/);
});
test("guided MCP configuration validates executable/tool schema and mappings",()=>{
  const project=buildProject({id,name:"Trusted MCP",sourceType:"mcp-stdio",
    mcpCommand:"node",mcpArgs:["/absolute/path/server.cjs"],mcpTool:"list_records",
    mcpMapping:{itemsPath:"data.records",idPath:"recordId",type:"ticket",
      hasMorePath:"data.more",nextCursorPath:"data.cursor",attributes:{priority:"rating"}},
    mode:"observation-entity",minimumScore:50});
  assert.equal(project.sources[0].adapter,"mcp-stdio");
  assert.equal(project.sources[0].config.mapping!==undefined,true);
  assert.throws(()=>buildProject({id,name:"Unsafe",sourceType:"mcp-stdio",
    mcpCommand:"npx",mcpTool:"list_records",mode:"observation-entity"}),/absolute path/);
  assert.throws(()=>buildProject({id,name:"Unsafe",sourceType:"mcp-stdio",
    mcpCommand:"node",mcpTool:"list_records",mode:"observation-entity",
    mcpMapping:{itemsPath:"__proto__.items",idPath:"id",type:"ticket",
      hasMorePath:"more",nextCursorPath:"cursor"}}),/Invalid MCP field path/);
});
test("standalone generic research can use the no-code builder with typed observation entities",()=>{
  const project=buildProject({id,name:"Scientific Research",sourceType:"json-file",
    sourcePath:resolve("examples/shared/observations.json"),mode:"observation-entity",
    includeKeywords:"scientific, research",minimumScore:0});
  assert.equal(project.sources[0].adapter,"json-file");
  assert.deepEqual(project.pipeline,["observation-entity"]);
  assert.throws(()=>buildProject({id,name:"Invalid",sourceType:"json-file",
    sourcePath:"../relative/observations.json",mode:"observation-entity"}),
    /absolute/);
  assert.throws(()=>buildProject({id,name:"Invalid",sourceType:"demo",
    demoPath:resolve("/tmp/example.json"),mode:"observation-entity",publicMetadata:true}),
    /requires a link-extraction processor/);
  assert.throws(()=>buildProject({id,name:"Invalid",sourceType:"demo",
    demoPath:resolve("/tmp/example.json"),mode:"linked-resources",
    minimumScore:101}),/minimum score/);
});

test("guided project builder configures JSON snapshots and domain-independent watch alerts",()=>{
  const project=buildProject({
    id,name:"Price changes",sourceType:"json-snapshot",
    sourcePath:resolve("examples/price-monitor/snapshot.json"),
    mode:"observation-entity",watchMode:"decrease-percent",
    watchPath:"/attributes/price",watchThreshold:10,minimumScore:0
  });
  assert.equal(project.sources[0].adapter,"json-snapshot");
  assert.equal(project.watch?.rules[0].operator,"decrease-percent");
  assert.deepEqual(project.watch?.rules[0].requireUnchanged,["/attributes/currency"]);
  const second=buildProject({id,name:"Job radar",sourceType:"public-json",
    sourceUrl:"https://boards-api.greenhouse.io/v1/boards/example/jobs",
    jsonMapping:{
      itemsPath:"jobs",idPath:"id",type:"job-listing",
      titlePath:"title",urlPath:"absolute_url",
      attributes:{location:"location.name"}
    },
    mode:"observation-entity",watchMode:"created"
  });
  assert.equal(second.sources[0].adapter,"public-json");
  assert.equal(second.watch?.rules[0].path,"$");
  assert.equal(second.watch?.rules[0].operator,"created");
  assert.throws(()=>buildProject({id,name:"Bad",sourceType:"public-json",
    sourceUrl:"http://example.org/api",jsonMapping:{itemsPath:"items",idPath:"id",type:"item"},
    mode:"observation-entity"}),/requires HTTPS/);
});
test("guided product pages and authorization guardrails",()=>{
  const project=buildProject({id,name:"Products",sourceType:"public-product",
    sourceUrls:"https://example.org/p/1\nhttps://example.org/p/2",
    mode:"observation-entity",
    watchMode:"decrease-percent",watchPath:"/attributes/price",watchThreshold:12
  });
  assert.equal(project.sources[0].adapter,"public-product");
  assert.equal((project.sources[0].config.urls as string[]).length,2);
  assert.equal(project.watch?.rules[0].threshold,12);
  assert.throws(()=>buildProject({id,name:"Product",sourceType:"public-product",
    sourceUrls:"http://example.org/p/1",mode:"observation-entity"}),/requires HTTPS/);
});
