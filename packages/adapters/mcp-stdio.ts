import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {isAbsolute} from "node:path";
import {StringDecoder} from "node:string_decoder";
import type {JsonRecord,ObservationPage,SourceAdapter} from "../sdk/contracts.ts";
import {validateObservation,jsonRecord} from "../core/project-config.ts";

type ObjectValue=Record<string,unknown>;
function record(x:unknown):ObjectValue {
  if(!x||typeof x!=="object"||Array.isArray(x))throw new Error("Unexpected MCP response object");
  return x as ObjectValue;
}
function checkedString(x:unknown,label:string,max=4096):string {
  if(typeof x!=="string"||!x||x.length>max)throw new Error("Invalid MCP "+label);
  return x;
}
function configStringArray(x:unknown,label:string,max=30):string[]{
  if(x===undefined)return [];
  if(!Array.isArray(x)||x.length>max||x.some(value=>typeof value!=="string"||value.length>4096)){
    throw new Error("Invalid MCP "+label);
  }
  return x as string[];
}
function options(source:JsonRecord):{
  command:string;args:string[];cwd?:string;tool:string;arguments:JsonRecord;
  cursorArgument:string;limitArgument:string;timeoutMs:number;passEnv:string[];
  protocol:"auto"|"legacy"|"modern";
}{
  const raw=record(source);
  const requested=checkedString(raw.command,"command",1000);
  // An absolute executable is required except for the already running trusted Node runtime.
  const command=requested==="node"?process.execPath:requested;
  if(!isAbsolute(command))throw new Error("MCP command must be an absolute executable path or 'node'");
  const tool=checkedString(raw.tool,"tool",128);
  if(!/^[a-zA-Z0-9_.-]+$/.test(tool))throw new Error("Invalid MCP tool name");
  const args=configStringArray(raw.args,"args");
  const cwd=raw.cwd===undefined?undefined:checkedString(raw.cwd,"cwd",1000);
  if(cwd!==undefined&&!isAbsolute(cwd))throw new Error("MCP working directory must be absolute");
  const cursorArgument=raw.cursorArgument===undefined?"cursor":
    checkedString(raw.cursorArgument,"cursor argument",100);
  const limitArgument=raw.limitArgument===undefined?"limit":
    checkedString(raw.limitArgument,"limit argument",100);
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cursorArgument)||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(limitArgument)||cursorArgument===limitArgument){
    throw new Error("MCP pagination argument keys are invalid");
  }
  const protocol=raw.protocol??"auto";
  if(!["auto","legacy","modern"].includes(String(protocol))){
    throw new Error("Invalid MCP protocol selection");
  }
  const timeoutMs=raw.timeoutMs===undefined?30000:Number(raw.timeoutMs);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000){
    throw new Error("MCP timeout must be 1000–120000 milliseconds");
  }
  const passEnv=configStringArray(raw.passEnv,"passEnv",20);
  if(passEnv.some(name=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))){
    throw new Error("Invalid MCP environment variable name");
  }
  const argumentsValue=raw.arguments===undefined?{}:jsonRecord(raw.arguments);
  if(cursorArgument in argumentsValue||limitArgument in argumentsValue){
    throw new Error("MCP cursor and limit arguments are reserved");
  }
  return {command,args,cwd,tool,arguments:argumentsValue,cursorArgument,
    limitArgument,timeoutMs,passEnv,protocol:protocol as "auto"|"legacy"|"modern"};
}
/**
 * A small stdio client with 2026 discovery and 2025 initialization fallback. The child is
 * explicitly user-configured and trusted. No shell, default inherited secrets,
 * HTTP transport or automatic downloads.
 */
class StdioPeer {
  private child:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;
    timer?:ReturnType<typeof setTimeout>}>();
  private nextId=1;
  private stdout="";
  private decoder=new StringDecoder("utf8");
  private totalBytes=0;
  private fatalError:Error|undefined;
  private stopping=false;
  private timeout:ReturnType<typeof setTimeout>;
  private abort:()=>void;
  constructor(config:ReturnType<typeof options>,signal:AbortSignal){
    const allowed=["PATH","HOME","USERPROFILE","SYSTEMROOT","WINDIR","TMP","TEMP","TMPDIR",
      "APPDATA","LOCALAPPDATA","XDG_RUNTIME_DIR","XDG_CONFIG_HOME","XDG_CACHE_HOME","LANG","LC_ALL"];
    const env:NodeJS.ProcessEnv={};
    for(const name of [...allowed,...config.passEnv]){
      if(process.env[name]!==undefined)env[name]=process.env[name];
    }
    this.child=spawn(config.command,config.args,{
      cwd:config.cwd,env,stdio:["pipe","pipe","pipe"],windowsHide:true,shell:false
    });
    this.abort=()=>this.fail(new Error("MCP collection aborted"));
    this.child.stdout.on("data",(buffer:Buffer)=>this.handleData(buffer));
    // Discard child stderr to avoid exposing connector credentials or blocking its pipe.
    this.child.stderr.on("data",()=>{});
    this.child.on("error",()=>this.fail(new Error("MCP process could not start")));
    this.child.on("exit",()=>{
      if(!this.stopping)this.fail(new Error("MCP server ended before completing the request"));
    });
    this.timeout=setTimeout(()=>this.fail(new Error("MCP request timed out")),config.timeoutMs);
    this.timeout.unref();
    signal.addEventListener("abort",this.abort,{once:true});
    if(signal.aborted)this.abort();
    this.cleanSignal=()=>signal.removeEventListener("abort",this.abort);
  }
  private cleanSignal:()=>void=()=>{};
  private handleData(chunk:Buffer):void{
    if(this.stopping||this.fatalError)return;
    this.totalBytes+=chunk.byteLength;
    if(this.totalBytes>4_000_000){this.fail(new Error("MCP response exceeds 4 MB"));return;}
    this.stdout+=this.decoder.write(chunk);
    if(this.stdout.length>2_000_000){this.fail(new Error("MCP response line too large"));return;}
    for(let pos=this.stdout.indexOf("\n");pos>=0;pos=this.stdout.indexOf("\n")){
      const line=this.stdout.slice(0,pos).trim();
      this.stdout=this.stdout.slice(pos+1);
      if(!line)continue;
      let response:ObjectValue;
      try{response=record(JSON.parse(line));}
      catch{this.fail(new Error("MCP server produced invalid JSON-RPC output"));return;}
      if(response.jsonrpc!=="2.0"){this.fail(new Error("MCP response is not JSON-RPC 2.0"));return;}
      if(response.id===undefined)continue; // notifications do not finish requests
      const id=response.id;
      if(typeof id!=="number")continue;
      const handler=this.pending.get(id);
      if(!handler)continue;
      this.pending.delete(id);
      if(handler.timer)clearTimeout(handler.timer);
      if(response.error){
        handler.reject(new Error("MCP request failed: "+String(record(response.error).code??"protocol error")));
      }else handler.resolve(response.result);
    }
  }
  private fail(error:Error):void{
    if(this.fatalError||this.stopping)return;
    this.fatalError=error;
    for(const handler of this.pending.values()){
      if(handler.timer)clearTimeout(handler.timer);
      handler.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }
  async call(method:string,params?:ObjectValue,probeTimeoutMs?:number):Promise<unknown>{
    if(this.fatalError)throw this.fatalError;
    const id=this.nextId++;
    return await new Promise<unknown>((resolve,reject)=>{
      const timer=probeTimeoutMs?setTimeout(()=>{
        this.pending.delete(id);
        reject(new Error("MCP discovery probe timed out"));
      },probeTimeoutMs):undefined;
      timer?.unref();
      this.pending.set(id,{resolve,reject,timer});
      const payload={jsonrpc:"2.0",id,method,...(params?{params}:{})};
      this.child.stdin.write(JSON.stringify(payload)+"\n",error=>{
        if(error)this.fail(new Error("MCP stdin write failed"));
      });
    });
  }
  notify(method:string):void{
    if(this.fatalError)throw this.fatalError;
    this.child.stdin.write(JSON.stringify({jsonrpc:"2.0",method})+"\n",error=>{
      if(error)this.fail(new Error("MCP initialization failed"));
    });
  }
  close():void{
    this.stopping=true;
    clearTimeout(this.timeout);
    this.cleanSignal();
    this.child.stdin.end();
    if(this.child.exitCode===null)this.child.kill();
    for(const handler of this.pending.values()){
      if(handler.timer)clearTimeout(handler.timer);
      handler.reject(new Error("MCP request closed"));
    }
    this.pending.clear();
  }
}
function parseToolResponse(raw:unknown,limit:number):ObservationPage{
  const result=record(raw);
  if(result.isError===true)throw new Error("MCP source tool returned isError=true");
  let contents:unknown=result.structuredContent;
  if(contents===undefined){
    const list=result.content;
    if(!Array.isArray(list)||list.length>20)throw new Error("MCP tool has no structured JSON response");
    const text=list.find(item=>item&&typeof item==="object"&&item.type==="text"&&typeof item.text==="string");
    if(!text)throw new Error("MCP tool must return JSON text or structuredContent");
    const str=checkedString(text.text,"JSON text",2_000_000);
    try{contents=JSON.parse(str);}catch{throw new Error("MCP tool returned invalid JSON text");}
  }
  const data=record(contents);
  if(!Array.isArray(data.observations)||data.observations.length>limit)throw new Error(
    "MCP source response requires an observations array within the requested page limit");
  if(typeof data.hasMore!=="boolean")throw new Error("MCP source must report hasMore");
  const nextCursor=data.nextCursor;
  if(data.hasMore&&(typeof nextCursor!=="string"||!nextCursor||nextCursor.length>2048)){
    throw new Error("MCP source must provide nextCursor while more records exist");
  }
  if(nextCursor!==undefined&&(typeof nextCursor!=="string"||nextCursor.length>2048)){
    throw new Error("Invalid MCP nextCursor");
  }
  return {
    observations:data.observations.map(validateObservation),
    hasMore:data.hasMore,
    nextCursor:typeof nextCursor==="string"?nextCursor:undefined
  };
}
export const mcpStdioSource:SourceAdapter={
  id:"mcp-stdio",
  async collect({source,cursor,limit,signal}){
    const config=options(source.config);
    const peer=new StdioPeer(config,signal);
    try{
      const metadata={
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{name:"discovery-engine",version:"0.6.0"}
      };
      let modern=false;
      if(config.protocol!=="legacy"){
        try{
          const discovery=record(await peer.call("server/discover",
            {_meta:metadata},Math.min(2500,config.timeoutMs)));
          const versions=discovery.supportedVersions;
          modern=Array.isArray(versions)&&versions.includes("2026-07-28");
        }catch{
          // Legacy stdio servers may reject or ignore pre-initialize discovery.
          if(config.protocol==="modern")throw new Error("MCP server did not support modern discovery");
        }
      }
      if(!modern){
        if(config.protocol==="modern")throw new Error("MCP server lacks protocol 2026-07-28");
        const handshake=record(await peer.call("initialize",{
          protocolVersion:"2025-11-25",
          capabilities:{},clientInfo:{name:"discovery-engine",version:"0.6.0"}
        }));
        if(typeof handshake.protocolVersion!=="string"||
          !/^202[45]-\d{2}-\d{2}$/.test(handshake.protocolVersion)){
          throw new Error("MCP server did not negotiate a supported legacy protocol");
        }
        peer.notify("notifications/initialized");
      }
      const request=(method:string,params?:ObjectValue)=>
        peer.call(method,modern?{...(params||{}),_meta:metadata}:params);
      let found=false,token:unknown=undefined;
      const known=new Set<string>();
      for(let pages=0;pages<10;pages++){
        const response=record(await request("tools/list",token?{cursor:token}:undefined));
        if(!Array.isArray(response.tools)||response.tools.length>1000){
          throw new Error("MCP tools/list returned an invalid tool collection");
        }
        if(response.tools.some(item=>item&&typeof item==="object"&&item.name===config.tool)){
          found=true;break;
        }
        token=response.nextCursor;
        if(token===undefined)break;
        if(typeof token!=="string"||token.length>2048||known.has(token)){
          throw new Error("MCP tool-list pagination is invalid");
        }
        known.add(token);
      }
      if(!found)throw new Error("Configured MCP source tool is not exposed by this server");
      const args:ObjectValue={...config.arguments,[config.limitArgument]:limit};
      if(cursor!==undefined)args[config.cursorArgument]=cursor;
      const response=await request("tools/call",{name:config.tool,arguments:args});
      return parseToolResponse(response,limit);
    }finally{peer.close();}
  }
};
