import {build} from "esbuild";
await build({
  entryPoints:["main.ts"],
  bundle:true,
  outfile:"main.js",
  platform:"node",
  format:"cjs",
  target:"es2022",
  external:["obsidian","electron","@codemirror/*","@lezer/*"],
  sourcemap:false,
  logLevel:"info"
});
