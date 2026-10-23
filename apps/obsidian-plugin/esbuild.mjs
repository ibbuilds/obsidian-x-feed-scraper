import {build} from "esbuild";
import {copyFileSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const dir=dirname(fileURLToPath(import.meta.url));

// Build the independent collector first, then embed its exact bytes into main.js.
// Obsidian Community Plugins normally install only main.js, manifest.json and styles.css.
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
const collector=readFileSync(join(dir,"collector.cjs"));
const design=readFileSync(resolve(dir,"../../profiles/design.json"));
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
await build({
  entryPoints:[join(dir,"main.ts")],
  bundle:true,
  outfile:join(dir,"main.js"),
  platform:"node",
  format:"cjs",
  target:"es2022",
  external:["obsidian","electron","@codemirror/*","@lezer/*"],
  define:{
    __XFS_COLLECTOR_BASE64__:JSON.stringify(collector.toString("base64")),
    __XFS_PROFILE_BASE64__:JSON.stringify(design.toString("base64")),
    __XFS_COLLECTOR_SHA256__:JSON.stringify(sha256(collector)),
    __XFS_PROFILE_SHA256__:JSON.stringify(sha256(design))
  },
  logLevel:"info"
});
copyFileSync(resolve(dir,"../../profiles/design.json"),join(dir,"design.json"));
