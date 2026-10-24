import {Modal,Notice,Setting,type App} from "obsidian";
import {randomBytes} from "node:crypto";
import {buildProject,type ProjectSetup} from "../../packages/core/project-builder.ts";
import type {ProjectDefinition} from "../../packages/sdk/contracts.ts";

export interface ProjectSetupHost {
  app:App;
  installResearchProject(project:ProjectDefinition,opts:{demo:boolean;intervalMinutes:number}):Promise<void>;
}
function projectId(name:string):string{
  const normalized=name.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-")
    .replace(/^-|-$/g,"").slice(0,35)||"research";
  return "p-"+normalized+"-"+randomBytes(4).toString("hex");
}
export class ProjectSetupModal extends Modal {
  private name="My research";
  private sourceType:ProjectSetup["sourceType"]="demo";
  private url="";
  private path="";
  private command="node";
  private argsText="[]";
  private tool="";
  private mappingText="";
  private positive="motion, design, research";
  private negative="";
  private mode:ProjectSetup["mode"]="linked-resources";
  private metadata=false;
  private threshold=25;
  private interval=0;
  private submitting=false;
  constructor(private host:ProjectSetupHost,private done:()=>void){
    super(host.app);
  }
  onOpen():void{
    this.titleEl.setText("Create a research project");
    const root=this.contentEl;
    root.empty();
    root.createEl("p",{text:"Choose what to collect and how to turn it into knowledge. "+
      "The offline demo works immediately. A real source requires its own authorized connector."});
    new Setting(root).setName("Project name")
      .setDesc("Used to identify this independent knowledge collection.")
      .addText(t=>t.setValue(this.name).onChange(value=>{this.name=value;}));
    const details=root.createDiv();
    const configureSource=():void=>{
      details.empty();
      const isDemo=this.sourceType==="demo";
      if(this.sourceType==="rss"){
        new Setting(details).setName("Public RSS / Atom URL")
          .setDesc("Only feeds you are permitted to access. Not an X For You feed.")
          .addText(t=>t.setPlaceholder("https://example.org/feed.xml")
            .setValue(this.url).onChange(value=>{this.url=value.trim();}));
      }else if(this.sourceType==="json-file"){
        new Setting(details).setName("Local observations JSON")
          .setDesc("An absolute path to an array of observations. No account tokens.")
          .addText(t=>t.setPlaceholder("/absolute/path/observations.json")
            .setValue(this.path).onChange(value=>{this.path=value.trim();}));
      }else if(this.sourceType==="mcp-stdio"){
        details.createEl("p",{text:"Runs an explicitly trusted local MCP server. "+
          "It does not inherit your ChatGPT connections or give the server extra permissions."});
        new Setting(details).setName("MCP executable")
          .setDesc("Absolute path, or 'node' for the current Node runtime.")
          .addText(t=>t.setValue(this.command).onChange(value=>{this.command=value.trim();}));
        new Setting(details).setName("MCP command arguments (JSON array)")
          .setDesc('Example: ["/absolute/path/to/server.cjs"]. No credentials here.')
          .addText(t=>t.setPlaceholder('["/path/to/server.cjs"]')
            .setValue(this.argsText).onChange(value=>{this.argsText=value;}));
        new Setting(details).setName("MCP collection tool")
          .setDesc("The exact tool name exposing authorized, paginated data.")
          .addText(t=>t.setPlaceholder("list_records")
            .setValue(this.tool).onChange(value=>{this.tool=value.trim();}));
        const field=details.createEl("textarea",{
          attr:{rows:"3",placeholder:"Optional JSON field mapping (see docs/mcp-stdio.md)",
            style:"width:100%"}
        });
        field.value=this.mappingText;
        field.addEventListener("input",()=>{this.mappingText=field.value;});
      }else{
        details.createEl("p",{text:"Includes three synthetic observations with shared links and a "+
          "record without a URL. No network access and no X account needed."});
      }
      new Setting(details).setName("Extract what?")
        .addDropdown(d=>d.addOptions({
          "linked-resources":"Resources linked from observations",
          "extract-links":"Original and linked URLs",
          "observation-entity":"Source records themselves (URLs optional)"
        }).setValue(this.mode).onChange(value=>{
          this.mode=value as ProjectSetup["mode"];configureSource();
        }));
      new Setting(details).setName("Relevant terms")
        .setDesc("Comma-separated keywords. Blank means do not filter by topic.")
        .addText(t=>t.setPlaceholder("react, accessibility, motion")
          .setValue(this.positive).onChange(value=>{this.positive=value;}));
      new Setting(details).setName("Exclude terms")
        .setDesc("Optional comma-separated terms to de-prioritize.")
        .addText(t=>t.setPlaceholder("ads, sponsorship")
          .setValue(this.negative).onChange(value=>{this.negative=value;}));
      new Setting(details).setName("Minimum output score")
        .setDesc("0–100. All evaluated records remain in SQLite even if not exported.")
        .addText(t=>t.setValue(String(this.threshold)).onChange(value=>{
          const n=Number(value);
          this.threshold=Number.isInteger(n)?n:NaN;
        }));
      if(this.mode!=="observation-entity"){
        new Setting(details).setName("Research public metadata")
          .setDesc("Explicit opt-in. Makes bounded network requests to public resources.")
          .addToggle(t=>t.setValue(this.metadata).onChange(value=>{this.metadata=value;}));
      }else this.metadata=false;
      new Setting(details).setName("Automatic interval (minutes)")
        .setDesc(isDemo?"Demo defaults to manual execution.":"0 for manual, or 15–1440 for scheduled collection.")
        .addText(t=>t.setValue(String(this.interval)).onChange(value=>{
          const n=Number(value);
          this.interval=Number.isInteger(n)?n:NaN;
        }));
    };
    new Setting(root).setName("Source type")
      .addDropdown(d=>d.addOptions({
        "demo":"Built-in offline demo",
        "rss":"Public RSS / Atom",
        "json-file":"Local JSON observations",
        "mcp-stdio":"Trusted local MCP server"
      }).setValue(this.sourceType).onChange(value=>{
        this.sourceType=value as ProjectSetup["sourceType"];
        this.mode=value==="demo"||value==="rss"?"linked-resources":
          "observation-entity";
        if(value==="rss")this.mode="extract-links";
        this.interval=value==="demo"?0:60;
        configureSource();
      }));
    configureSource();
    new Setting(root).addButton(b=>b.setButtonText("Create & run project").setCta()
      .onClick(async()=>{
        if(this.submitting)return;
        this.submitting=true;
        b.setDisabled(true);
        try{
          if(!Number.isInteger(this.interval)||this.interval<0||this.interval>1440||
            (this.interval!==0&&this.interval<15)){
            throw new Error("Interval must be 0 or between 15 and 1440 minutes");
          }
          let args:unknown;
          try{args=JSON.parse(this.argsText);}catch{
            throw new Error("MCP arguments must be a JSON array");
          }
          if(this.sourceType==="mcp-stdio"&&
            (!Array.isArray(args)||args.some(x=>typeof x!=="string"))){
            throw new Error("MCP arguments must be an array of strings");
          }
          let mapping:unknown;
          if(this.mappingText.trim()){
            try{mapping=JSON.parse(this.mappingText);}catch{
              throw new Error("MCP field mapping must be valid JSON");
            }
          }
          const project=buildProject({
            id:projectId(this.name),name:this.name,
            sourceType:this.sourceType,sourceUrl:this.url,sourcePath:this.path,
            demoPath:this.sourceType==="demo"?"/synthetic-demo-placeholder.json":undefined,
            mcpCommand:this.command,mcpArgs:args as string[],
            mcpTool:this.tool,mcpMapping:mapping,
            includeKeywords:this.positive,excludeKeywords:this.negative,
            mode:this.mode,publicMetadata:this.metadata,
            minimumScore:this.threshold
          });
          await this.host.installResearchProject(project,{
            demo:this.sourceType==="demo",intervalMinutes:this.interval
          });
          this.close();
          new Notice("Research project created and first collection started");
          this.done();
        }catch(error){
          new Notice(error instanceof Error?error.message:String(error),10000);
        }finally{this.submitting=false;b.setDisabled(false);}
      }));
  }
  onClose():void{this.contentEl.empty();}
}
