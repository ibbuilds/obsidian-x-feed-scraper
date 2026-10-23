import {randomUUID} from "node:crypto";
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,statSync,unlinkSync,writeSync} from "node:fs";
import {dirname} from "node:path";

interface Lease {pid:number; token:string; created:number}
function alive(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}
  catch(e){
    // EPERM signals the process exists but is owned by another user.
    return (e as NodeJS.ErrnoException).code!=="ESRCH";
  }
}
function lease(path:string):Lease|undefined{
  try{
    const obj:unknown=JSON.parse(readFileSync(path,"utf8"));
    if(!obj||typeof obj!=="object")return undefined;
    const row=obj as Record<string,unknown>;
    if(typeof row.pid!=="number"||typeof row.token!=="string"||
      typeof row.created!=="number")return undefined;
    return row as unknown as Lease;
  }catch{return undefined;}
}
export function acquireLock(path:string):()=>void {
  mkdirSync(dirname(path),{recursive:true});
  for(let attempt=0;attempt<3;attempt++){
    let descriptor:number;
    try{descriptor=openSync(path,"wx",0o600);}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      let canRecover=false;
      const previous=lease(path);
      if(previous){
        canRecover=!alive(previous.pid);
      }else{
        // Incomplete older lock writes are not assumed dead immediately.
        try{canRecover=Date.now()-statSync(path).mtimeMs>60_000;}
        catch{continue;}
      }
      if(!canRecover)throw new Error("Another collector is active");
      // Recheck the identity to reduce the chance of deleting a newer owner.
      const current=lease(path);
      if(previous && current?.token!==previous.token)continue;
      try{unlinkSync(path);}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      continue;
    }
    const token=randomUUID();
    const info:Lease={pid:process.pid,token,created:Date.now()};
    try{writeSync(descriptor,JSON.stringify(info));}
    catch(e){
      closeSync(descriptor);
      try{unlinkSync(path);}catch{}
      throw e;
    }
    let released=false;
    return ()=>{
      if(released)return;
      released=true;
      try{
        if(lease(path)?.token===token)unlinkSync(path);
      }catch(e){
        if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
      }finally{closeSync(descriptor);}
    };
  }
  throw new Error("Could not acquire collection lock");
}
