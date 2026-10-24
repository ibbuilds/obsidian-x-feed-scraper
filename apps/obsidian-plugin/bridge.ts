import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync} from "node:fs";

export interface BridgeConfig {
  executable:string;
  collectorPath:string;
  databasePath:string;
  profilePath:string;
  vaultPath:string;
  feedUrl?:string;
  fixturePath?:string;
  scheduleMinutes:number;
  threshold:number;
  confidence:number;
  preferFree:boolean;
  autoEnrich?:boolean;
}
export class LocalBridge {
  private child?:ChildProcessWithoutNullStreams;
  private starting?:Promise<number>;
  private tokenValue="";
  private portValue=0;
  lastError="";
  get port():number{return this.portValue;}
  get token():string{return this.tokenValue;}
  get running():boolean{return Boolean(this.child&&this.portValue);}
  get pid():number|undefined{return this.child?.pid;}
  start(config:BridgeConfig):Promise<number>{
    if(this.running)return Promise.resolve(this.portValue);
    if(this.starting)return this.starting;
    this.starting=this.boot(config).finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  private async boot(config:BridgeConfig):Promise<number>{
    if(!existsSync(config.collectorPath))throw new Error("collector.cjs missing. Install the complete plugin ZIP.");
    if(!existsSync(config.profilePath))throw new Error("design.json missing. Install the complete plugin ZIP.");
    const token=randomBytes(32).toString("hex");
    const args=[
      config.collectorPath,"serve","--port","0","--managed","true",
      "--db",config.databasePath,"--profile",config.profilePath,
      "--vault",config.vaultPath,"--interval",String(config.scheduleMinutes),
      "--threshold",String(config.threshold),
      "--confidence",String(config.confidence),
      "--prefer-free",String(config.preferFree),
      "--auto-enrich",String(config.autoEnrich??false)
    ];
    if(config.feedUrl)args.push("--feed",config.feedUrl);
    if(config.fixturePath)args.push("--fixture",config.fixturePath);
    this.lastError="";
    return new Promise<number>((resolve,reject)=>{
      let ready=false,settled=false,output="";
      const child=spawn(config.executable||"node",args,{
        cwd:config.vaultPath,
        env:{...process.env,XFS_API_TOKEN:token},
        windowsHide:true,
        stdio:["pipe","pipe","pipe"]
      });
      this.child=child;
      const timer=setTimeout(()=>fail(new Error("Node collector did not start within 15 seconds")),15000);
      const fail=(error:Error)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        this.lastError=error.message;
        this.tokenValue="";this.portValue=0;
        child.kill();
        if(this.child===child)this.child=undefined;
        reject(error);
      };
      child.stdout.on("data",(chunk:Buffer)=>{
        if(ready)return;
        output=(output+chunk.toString("utf8")).slice(-2048);
        const match=output.match(/(?:^|\n)XFS_READY_PORT=(\d+)\s*(?:\n|$)/);
        if(!match)return;
        const port=Number(match[1]);
        if(!Number.isInteger(port)||port<1024||port>65535){
          fail(new Error("Invalid collector port"));return;
        }
        if(settled)return;
        settled=true;ready=true;clearTimeout(timer);
        this.portValue=port;this.tokenValue=token;
        resolve(port);
      });
      // Never include stderr verbatim: it may contain user-provided feed URLs.
      child.stderr.on("data",()=>{});
      child.on("error",(error)=>fail(new Error("Could not launch Node.js. Check its path and version: "+error.message)));
      child.on("exit",(code)=>{
        if(!ready){fail(new Error("Collector exited before startup (code "+String(code)+"). Verify Node.js 22.16+."));return;}
        if(this.child===child){
          this.child=undefined;this.portValue=0;this.tokenValue="";
          this.lastError="Collector stopped (exit "+String(code)+")";
        }
      });
    });
  }
  async stop():Promise<void>{
    const child=this.child;
    this.child=undefined;this.tokenValue="";this.portValue=0;
    if(child&&child.exitCode===null){
      const ended=new Promise<void>(resolve=>{
        child.once("exit",()=>resolve());
        const timeout=setTimeout(resolve,2000);
        timeout.unref();
      });
      child.kill("SIGTERM");
      await ended;
    }
  }
}
