import {build} from "esbuild";
import {readFileSync,mkdirSync} from "node:fs";
import {resolve} from "node:path";

const pkg=JSON.parse(readFileSync("package.json","utf8"));
mkdirSync("dist",{recursive:true});
await build({
  entryPoints:[resolve("apps/collector/source-cli.ts")],
  outfile:resolve("dist/source-scraper.mjs"),
  bundle:true,platform:"node",format:"esm",target:"node22",
  external:["node:*"],
  banner:{js:"#!/usr/bin/env node"},
  define:{__SOURCE_SCRAPER_VERSION__:JSON.stringify(pkg.version)},
  logLevel:"info"
});
