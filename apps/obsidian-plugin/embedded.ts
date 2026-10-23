import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";

// Build-time definitions inserted by esbuild into the standard Obsidian main.js.
// These static bytes are never fetched at runtime from the network or from X.
declare const __XFS_COLLECTOR_BASE64__:string;
declare const __XFS_PROFILE_BASE64__:string;
declare const __XFS_COLLECTOR_SHA256__:string;
declare const __XFS_PROFILE_SHA256__:string;

function storeAsset(dir:string,label:string,extension:string,base64:string,hash:string):string{
  const bytes=Buffer.from(base64,"base64");
  const actual=createHash("sha256").update(bytes).digest("hex");
  if(actual!==hash)throw new Error("Embedded "+label+" failed the integrity check");
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=join(dir,label+"-"+hash.slice(0,24)+extension);
  try{
    writeFileSync(path,bytes,{flag:"wx",mode:0o600});
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    const existing=readFileSync(path);
    if(createHash("sha256").update(existing).digest("hex")!==hash){
      throw new Error("Local "+label+" file was modified; refusing to execute it");
    }
  }
  return path;
}

/** Materialize only bundled, SHA-256 verified application code in the per-vault local data folder. */
export function prepareBundledAssets(directory:string):{collectorPath:string;profilePath:string}{
  return {
    collectorPath:storeAsset(directory,"collector",".cjs",__XFS_COLLECTOR_BASE64__,__XFS_COLLECTOR_SHA256__),
    profilePath:storeAsset(directory,"design",".json",__XFS_PROFILE_BASE64__,__XFS_PROFILE_SHA256__)
  };
}
