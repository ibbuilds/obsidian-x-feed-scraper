import {resolve} from "node:path";
import {parseObsidianVersions} from "wdio-obsidian-service";

const cacheDir=resolve(".obsidian-cache");
const versions=await parseObsidianVersions(
  process.env.OBSIDIAN_VERSIONS||"latest/latest",
  {cacheDir}
);
export const config:WebdriverIO.Config={
  runner:"local",
  framework:"mocha",
  specs:["./specs/plugin.e2e.ts"],
  maxInstances:1,
  capabilities:versions.map(([appVersion,installerVersion])=>({
    browserName:"obsidian",
    "wdio:obsidianOptions":{
      appVersion,installerVersion,
      plugins:["../../apps/obsidian-plugin"],
      vault:"vault"
    }
  })),
  services:["obsidian"],
  reporters:["spec"],
  mochaOpts:{ui:"bdd",timeout:90000},
  waitforInterval:350,
  waitforTimeout:30000,
  logLevel:"warn",
  cacheDir,
  injectGlobals:false
};
