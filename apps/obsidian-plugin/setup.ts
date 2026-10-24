import {Modal,Notice,Setting,type App} from "obsidian";
import {randomBytes} from "node:crypto";
import {buildProject,type ProjectSetup} from "../../packages/core/project-builder.ts";
import type {ProjectDefinition} from "../../packages/sdk/contracts.ts";

export interface ProjectSetupHost {
  app:App;
  installResearchProject(project:ProjectDefinition,opts:{demo:boolean;intervalMinutes:number}):Promise<void>;
  projectDemoPath(id:string):string;
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
  private urlsText="";
  private jsonMappingText="";
  private watchMode:NonNullable<ProjectSetup["watchMode"]>="none";
  private watchPath="/attributes/status";
  private watchThreshold=10;
  private watchValue="closed";
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
      }else if(this.sourceType==="public-json"){
        new Setting(details).setName("Public JSON API URL")
          .setDesc("HTTPS public GET endpoint, for example a published job board API. "+
            "Credential-bearing query URLs are rejected.")
          .addText(t=>t.setPlaceholder("https://boards-api.greenhouse.io/v1/boards/.../jobs")
            .setValue(this.url).onChange(value=>{this.url=value.trim();}));
        const mapping=details.createEl("textarea",{attr:{rows:"4",style:"width:100%",
          placeholder:'{"itemsPath":"jobs","idPath":"id","type":"job-listing",'+
            '"titlePath":"title","urlPath":"absolute_url","attributes":'+
            '{"location":"location.name"}}'}});
        mapping.value=this.jsonMappingText;
        mapping.addEventListener("input",()=>{this.jsonMappingText=mapping.value;});
      }else if(this.sourceType==="public-product"){
        details.createEl("p",{text:"Reads public Schema.org Product/Offer JSON-LD "+
          "from HTTPS pages. A site's HTML price is not an independently verified quote."});
        const input=details.createEl("textarea",{attr:{rows:"3",style:"width:100%",
          placeholder:"One authorized HTTPS product page per line"}});
        input.value=this.urlsText;
        input.addEventListener("input",()=>{this.urlsText=input.value;});
      }else if(this.sourceType==="json-file"||this.sourceType==="json-snapshot"){
        new Setting(details).setName(this.sourceType==="json-snapshot"?
          "Local JSON monitored on every collection":"Local observations JSON")
          .setDesc("An absolute path to an array of observations. JSON snapshot mode "+
            "rechecks existing records for changes; JSON file mode is append-only.")
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
      new Setting(details).setName("Track changes")
        .setDesc("Optional: store watch alerts when a tracked entity changes. "+
          "All observed field changes are retained even without an alert.")
        .addDropdown(d=>d.addOptions({
          "none":"Store history only",
          "created":"New record discovered",
          "changed":"A selected field changed",
          "decrease-percent":"A number decreased by %",
          "increase-percent":"A number increased by %",
          "equals":"A field reached a value"
        }).setValue(this.watchMode).onChange(value=>{
          this.watchMode=value as NonNullable<ProjectSetup["watchMode"]>;
          configureSource();
        }));
      if(this.watchMode!=="none"&&this.watchMode!=="created"){
        new Setting(details).setName("Field to monitor")
          .setDesc("JSON pointer, e.g. /attributes/price, /attributes/status.")
          .addText(t=>t.setValue(this.watchPath).onChange(value=>{
            this.watchPath=value.trim();
          }));
      }
      if(this.watchMode==="decrease-percent"||this.watchMode==="increase-percent"){
        new Setting(details).setName("Minimum percent change")
          .addText(t=>t.setValue(String(this.watchThreshold)).onChange(value=>{
            this.watchThreshold=Number(value);
          }));
      }
      if(this.watchMode==="equals"){
        new Setting(details).setName("Target value")
          .addText(t=>t.setValue(this.watchValue).onChange(value=>{
            this.watchValue=value;
          }));
      }
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
        "json-file":"Local JSON observations (append-only)",
        "json-snapshot":"Monitor local JSON changes",
        "public-json":"Public JSON API (e.g. job listings)",
        "public-product":"Public product page prices (JSON-LD)",
        "mcp-stdio":"Trusted local MCP server"
      }).setValue(this.sourceType).onChange(value=>{
        this.sourceType=value as ProjectSetup["sourceType"];
        this.mode=value==="demo"||value==="rss"?"linked-resources":
          "observation-entity";
        if(value==="rss")this.mode="extract-links";
        if(value==="public-product"){
          this.watchMode="decrease-percent";this.watchPath="/attributes/price";
          this.watchThreshold=10;
        }else if(value==="public-json"){
          this.watchMode="created";this.watchPath="/attributes/status";
        }else if(value==="json-snapshot"){
          this.watchMode="changed";this.watchPath="/attributes/status";
        }else this.watchMode="none";

        this.interval=value==="demo"?0:60;
        configureSource();
      }));
    configureSource();
    const failure=root.createEl("p",{cls:"xfs-setup-error"});
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
          let args:string[]=[];
          let mapping:unknown;
          if(this.sourceType==="mcp-stdio"){
            let rawArgs:unknown;
            try{rawArgs=JSON.parse(this.argsText);}catch{
              throw new Error("MCP arguments must be a JSON array");
            }
            if(!Array.isArray(rawArgs)||rawArgs.some(x=>typeof x!=="string")){
              throw new Error("MCP arguments must be an array of strings");
            }
            args=rawArgs as string[];
            if(this.mappingText.trim()){
              try{mapping=JSON.parse(this.mappingText);}catch{
                throw new Error("MCP field mapping must be valid JSON");
              }
            }
          }
          let jsonMapping:unknown;
          if(this.sourceType==="public-json"){
            try{jsonMapping=JSON.parse(this.jsonMappingText);}catch{
              throw new Error("Public API mapping must be valid JSON");
            }
          }
          const id=projectId(this.name);
          const project=buildProject({
            id,name:this.name,
            sourceType:this.sourceType,sourceUrl:this.url,sourcePath:this.path,
            sourceUrls:this.urlsText,jsonMapping,
            demoPath:this.sourceType==="demo"?this.host.projectDemoPath(id):undefined,
            mcpCommand:this.command,mcpArgs:args,
            mcpTool:this.tool,mcpMapping:mapping,
            includeKeywords:this.positive,excludeKeywords:this.negative,
            mode:this.mode,publicMetadata:this.metadata,
            minimumScore:this.threshold,
            watchMode:this.watchMode,watchPath:this.watchPath,
            watchThreshold:this.watchThreshold,watchValue:this.watchValue
          });
          await this.host.installResearchProject(project,{
            demo:this.sourceType==="demo",intervalMinutes:this.interval
          });
          this.close();
          new Notice("Research project created and first collection started");
          this.done();
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          failure.setText("Project setup failed: "+message);
          new Notice("Project setup failed: "+message,10000);
        }finally{this.submitting=false;b.setDisabled(false);}
      }));
  }
  onClose():void{this.contentEl.empty();}
}
