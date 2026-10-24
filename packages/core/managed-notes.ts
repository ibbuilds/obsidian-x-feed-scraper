import {createHash,randomUUID} from "node:crypto";
import {closeSync,existsSync,fsyncSync,linkSync,lstatSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from "node:fs";
import {resolve,sep} from "node:path";
import {Store} from "../storage/store.ts";
import {isSymlink} from "./vault-safe.ts";

export type ManagedResult="created"|"unchanged"|"updated"|"conflict";
function digest(data:string|Buffer):string{
  return createHash("sha256").update(data).digest("hex");
}
function managedPath(root:string,relative:string):string{
  const path=resolve(root,relative);
  if(!path.startsWith(resolve(root)+sep)||relative.includes("\0")){
    throw new Error("Managed note escaped the vault root");
  }
  return path;
}
function safeRead(path:string):string|undefined{
  if(isSymlink(path))throw new Error("Managed path is a symbolic link");
  try{
    const stat=lstatSync(path);
    if(!stat.isFile())throw new Error("Managed path must be a regular file");
    if(stat.size>5_000_000)throw new Error("Managed file too large for automatic updates");
    return readFileSync(path,"utf8");
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;
    throw error;
  }
}
/** Immutable file creation, no overwritten user content. */
function createOnly(path:string,content:string):ManagedResult{
  const temp=path+".tmp-"+randomUUID();
  let descriptor:number|undefined;
  try{
    descriptor=openSync(temp,"wx",0o600);
    writeFileSync(descriptor,content);
    fsyncSync(descriptor);
    closeSync(descriptor);descriptor=undefined;
    try{linkSync(temp,path);return "created";}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code==="EEXIST")return "conflict";
      if(!["EPERM","ENOTSUP","EOPNOTSUPP"].includes(code||""))throw error;
      try{
        const fd=openSync(path,"wx",0o600);
        try{writeFileSync(fd,content);fsyncSync(fd);}
        finally{closeSync(fd);}
        return "created";
      }catch(inner){
        if((inner as NodeJS.ErrnoException).code==="EEXIST")return "conflict";
        throw inner;
      }
    }
  }finally{
    if(descriptor!==undefined)closeSync(descriptor);
    if(existsSync(temp))unlinkSync(temp);
  }
}
/**
 * Updates only if the last exported bytes are still present. Unknown or edited files
 * remain untouched. A second content check immediately before rename guards manual edits.
 */
export function writeManagedNote(store:Store,vault:string,relative:string,content:string):ManagedResult{
  const path=managedPath(vault,relative);
  let current:string|undefined;
  try{current=safeRead(path);}
  catch{return "conflict";}
  const desiredHash=digest(content);
  const previous=store.getExportHash(vault,relative);
  if(current===content){
    store.recordExport(vault,relative,desiredHash);
    return "unchanged";
  }
  if(current===undefined){
    const created=createOnly(path,content);
    if(created==="created")store.recordExport(vault,relative,desiredHash);
    return created;
  }
  if(!previous||digest(current)!==previous)return "conflict";
  const temp=path+".tmp-"+randomUUID();
  let fd:number|undefined;
  try{
    fd=openSync(temp,"wx",0o600);
    writeFileSync(fd,content);
    fsyncSync(fd);closeSync(fd);fd=undefined;
    const second=safeRead(path);
    if(second===undefined||digest(second)!==previous)return "conflict";
    try{renameSync(temp,path);}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(["EPERM","EACCES","EBUSY"].includes(code||""))return "conflict";
      throw error;
    }
    store.recordExport(vault,relative,desiredHash);
    return "updated";
  }finally{
    if(fd!==undefined)closeSync(fd);
    if(existsSync(temp))unlinkSync(temp);
  }
}
/** Removes only verified machine-written candidate files after approval/rejection/duplicate. */
export function retireManagedNote(store:Store,vault:string,relative:string):"removed"|"absent"|"conflict"{
  const path=managedPath(vault,relative);
  let current:string|undefined;
  try{current=safeRead(path);}
  catch{return "conflict";}
  if(current===undefined){
    store.clearExport(vault,relative);
    return "absent";
  }
  const last=store.getExportHash(vault,relative);
  if(!last||digest(current)!==last)return "conflict";
  const checked=safeRead(path);
  if(checked===undefined||digest(checked)!==last)return "conflict";
  unlinkSync(path);
  store.clearExport(vault,relative);
  return "removed";
}
