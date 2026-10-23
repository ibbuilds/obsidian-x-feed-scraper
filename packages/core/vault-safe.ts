import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {join,resolve} from "node:path";

/** Reject symlinks along generated vault directories (including pre-existing folders). */
export function isSymlink(path:string):boolean {
  try{return lstatSync(path).isSymbolicLink();}
  catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return false;
    throw e;
  }
}
export function ensureVaultPath(vaultPath:string,segments:readonly string[]):string {
  const root=realpathSync(resolve(vaultPath));
  if(!lstatSync(root).isDirectory())throw new Error("Vault root must be a directory");
  let current=root;
  for(const name of segments){
    if(!name||name==="."||name===".."||name.includes("/")||name.includes("\\")){
      throw new Error("Unsafe vault folder name");
    }
    current=join(current,name);
    if(isSymlink(current))throw new Error("Vault output directory is a symbolic link");
    try{mkdirSync(current,{mode:0o700});}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      if(isSymlink(current)||!lstatSync(current).isDirectory()){
        throw new Error("Vault output path is not a safe directory");
      }
    }
  }
  return current;
}
