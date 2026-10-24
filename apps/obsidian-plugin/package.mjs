import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {zipSync,strToU8} from "fflate";
const dir=dirname(fileURLToPath(import.meta.url));
const files=["main.js","manifest.json","styles.css"];
const entries={};
for(const file of files){
  const content=readFileSync(join(dir,file));
  entries[file]=new Uint8Array(content.buffer,content.byteOffset,content.byteLength);
}
const destination=resolve(dir,"../../dist");
mkdirSync(destination,{recursive:true});
const output=join(destination,"obsidian-x-feed-scraper.zip");
writeFileSync(output,zipSync(entries,{level:6}));
console.log("Packaged "+output+" ("+files.join(", ")+")");
