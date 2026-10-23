import {build} from "esbuild";
import {copyFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const dir=dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints:[join(dir,"main.ts")],
  bundle:true,
  outfile:join(dir,"main.js"),
  platform:"node",
  format:"cjs",
  target:"es2022",
  external:["obsidian","electron","@codemirror/*","@lezer/*"],
  logLevel:"info"
});
await build({
  entryPoints:[resolve(dir,"../collector/cli.ts")],
  bundle:true,
  outfile:join(dir,"collector.cjs"),
  platform:"node",
  format:"cjs",
  target:"node22",
  external:["node:*"],
  logLevel:"info"
});
copyFileSync(resolve(dir,"../../profiles/design.json"),join(dir,"design.json"));
