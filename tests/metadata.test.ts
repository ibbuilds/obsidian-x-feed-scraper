import {test} from "node:test";
import assert from "node:assert/strict";
import {githubRepoPath,parseGithubMetadata} from "../packages/connectors/metadata.ts";

test("GitHub repository paths are detected safely",()=>{
 assert.deepEqual(githubRepoPath("https://github.com/pmndrs/drei/tree/master"),{owner:"pmndrs",repo:"drei"});
 assert.deepEqual(githubRepoPath("https://github.com/example/project.git"),{owner:"example",repo:"project"});
 assert.equal(githubRepoPath("https://example.com/example/repo"),null);
 assert.equal(githubRepoPath("https://github.com/user"),null);
});
test("a recognized public SPDX license is evidence of open source",()=>{
 const metadata=parseGithubMetadata({
   full_name:"owner/beautiful-motion",private:false,
   description:"Open framework for creative motion interfaces",
   license:{spdx_id:"MIT"}
 });
 assert.equal(metadata.access,"open_source");
 assert.equal(metadata.license,"MIT");
 assert.equal(metadata.description,"Open framework for creative motion interfaces");
});
test("a public repository alone does not prove an open-source license",()=>{
 const unknown=parseGithubMetadata({full_name:"org/repo",private:false,license:{spdx_id:"NOASSERTION"}});
 assert.equal(unknown.access,"unknown");
 assert.equal(unknown.license,undefined);
 const restricted=parseGithubMetadata({full_name:"org/repo",license:{spdx_id:"CC-BY-NC-4.0"}});
 assert.equal(restricted.access,"unknown");
 assert.equal(restricted.license,"CC-BY-NC-4.0");
 assert.throws(()=>parseGithubMetadata({private:true,license:{spdx_id:"MIT"}}),/not public/);
});
