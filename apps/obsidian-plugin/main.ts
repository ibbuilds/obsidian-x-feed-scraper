import {
  FileSystemAdapter,ItemView,Modal,Notice,Plugin,PluginSettingTab,Setting,TFile,
  WorkspaceLeaf,requestUrl
} from "obsidian";
import {createHash,randomBytes} from "node:crypto";
import {homedir} from "node:os";
import {libraryContains,appendApprovedReference} from "./library.ts";
import {join} from "node:path";
import {LocalBridge} from "./bridge.ts";
import {prepareBundledAssets} from "./embedded.ts";
import {normalizeUrl} from "../../packages/core/url.ts";

const VIEW="x-feed-scraper-view";
interface SettingsData {
  nodeExecutable:string;autoStart:boolean;feedUrl:string;fixturePath:string;
  profilePath:string;intervalMinutes:number;scoreThreshold:number;
  confidenceThreshold:number;preferFree:boolean;autoEnrich:boolean;
}
interface Source {
  id:number;url:string;title:string;description?:string;license?:string;
  category:string;access:string;
  score:number;confidence:number;status:string;reasons:string[];
  firstSeen:string;postUrl?:string;author?:string;
}
interface Stats {
  posts:number;visuals:number;sources:number;links:number;high_quality:number;
  needs_review:number;approved:number;errors:number;
  active:boolean;paused:boolean;connectedSource:string;
  personalizedXFeed:string;feedUrl?:string|null;autoEnrich?:boolean;
  lastRun?:{started_at:string;ended_at:string;status:string;posts_seen:number;duplicates:number};
}
interface Recommendations {
  posts:Array<{post_url:string;author:string;username:string;score:number;categories:string}>;
  authors:Array<{author:string;username:string;posts_seen:number;quality_sources:number}>;
}
const DEFAULT:SettingsData={
  nodeExecutable:"node",autoStart:true,feedUrl:"",fixturePath:"",profilePath:"",
  intervalMinutes:60,scoreThreshold:75,confidenceThreshold:0.65,preferFree:true,autoEnrich:false
};
function asError(error:unknown):string {
  return error instanceof Error?error.message:String(error);
}
function button(parent:HTMLElement,title:string,action:()=>void):HTMLButtonElement{
  const el=parent.createEl("button",{text:title});
  el.addEventListener("click",action);
  return el;
}
function external(parent:HTMLElement,title:string,target:string):void{
  try{
    const url=new URL(target);
    if(url.protocol!=="https:"&&url.protocol!=="http:")return;
    const a=parent.createEl("a",{text:title,href:url.toString()});
    a.setAttr("target","_blank");a.setAttr("rel","noopener noreferrer");
  }catch{}
}
class ConfirmAction extends Modal {
  constructor(plugin:ScraperPlugin,headline:string,message:string,confirm:string,action:()=>Promise<void>){
    super(plugin.app);
    this.titleEl.setText(headline);
    this.contentEl.createEl("p",{text:message});
    new Setting(this.contentEl).addButton(b=>b.setButtonText(confirm).setCta().onClick(async()=>{
      try{await action();this.close();new Notice("Action completed");}
      catch(e){new Notice(asError(e));}
    }));
  }
}
class ReviewModal extends Modal {
  constructor(plugin:ScraperPlugin,source:Source,decision:"approved"|"rejected"|"excellent",done:()=>void){
    super(plugin.app);
    this.titleEl.setText(decision+" — "+(source.title||source.url));
    this.contentEl.createEl("p",{text:"Evaluation: "+source.score+"/100; confidence "+
      Math.round(source.confidence*100)+"%. State why this source meets or fails your standard."});
    const accessSetting=new Setting(this.contentEl).setName("Access type (manually verified)")
      .setDesc("Free is not the same as open source. Choose only what you have checked.");
    let selectedAccess=source.access;
    accessSetting.addDropdown(dropdown=>{
      dropdown.addOptions({
        unknown:"Unknown",free:"Free",open_source:"Open source (license verified)",
        freemium:"Freemium",paid:"Paid"
      });
      dropdown.setValue(source.access);
      dropdown.onChange(value=>{selectedAccess=value;});
    });
    const field=this.contentEl.createEl("textarea",{attr:{rows:"4",placeholder:"Reason (required)",style:"width:100%"}});
    new Setting(this.contentEl).addButton(b=>b.setButtonText("Save review").setCta().onClick(async()=>{
      if(!field.value.trim()){new Notice("A reason is required");return;}
      try{
        const response=await plugin.call("/review","POST",{id:source.id,decision,
          reason:field.value.trim(),access:selectedAccess});
        plugin.notifyExport(response);
        this.close();done();new Notice("Decision stored locally");
      }catch(e){new Notice(asError(e));}
    }));
  }
}
class ImportModal extends Modal {
  constructor(plugin:ScraperPlugin,done:()=>void){
    super(plugin.app);
    this.titleEl.setText("Import observed posts");
    this.contentEl.createEl("p",{text:"Paste lines: post URL | post text containing the shared resource URL. "+
      "You can also paste a JSON array with id, url, author, username and text fields. "+
      "This imports user-provided observations; it does not read your For You feed."});
    const field=this.contentEl.createEl("textarea",{attr:{rows:"10",
      placeholder:"https://x.com/example/status/123 | Useful resource https://example.org/design",
      style:"width:100%"}});
    new Setting(this.contentEl).addButton(b=>b.setButtonText("Import locally").setCta().onClick(async()=>{
      try{
        const content=field.value.trim();
        let posts:unknown;
        if(content.startsWith("[")){
          posts=JSON.parse(content);
        }else{
          posts=content.split(/\r?\n/).map(line=>{
            const bar=line.indexOf(" | ");
            const source=(bar>=0?line.slice(0,bar):line).trim();
            const url=new URL(source);
            if(!["https:","http:"].includes(url.protocol))throw new Error("Use an HTTP(S) post URL");
            const parts=url.pathname.split("/").filter(Boolean);
            const author=parts[0]||url.hostname;
            return {id:createHash("sha256").update(url.toString()).digest("hex"),
              url:url.toString(),author,username:author,
              text:bar>=0?line.slice(bar+3).trim():source};
          });
        }
        const response=await plugin.call("/import","POST",{posts});
        plugin.notifyExport(response);
        new Notice("Observations imported into SQLite");
        this.close();done();
      }catch(e){new Notice("Invalid import: "+asError(e));}
    }));
  }
}
class SourceView extends ItemView {
  private query="";
  private status="";
  private page=0;
  constructor(leaf:WorkspaceLeaf,private plugin:ScraperPlugin){super(leaf);}
  getViewType():string{return VIEW;}
  getDisplayText():string{return "X Feed Scraper";}
  getIcon():string{return "book-open-check";}
  async onOpen():Promise<void>{await this.draw();}
  async onClose():Promise<void>{}
  async draw():Promise<void>{
    const root=this.contentEl;
    root.empty();root.addClass("xfs-panel");
    root.createEl("h3",{text:"X Feed Scraper"});
    const warning=root.createDiv({cls:"xfs-warning"});
    warning.createEl("strong",{text:"X For You: not connected."});
    warning.createEl("p",{text:"The personalized X feed has no verified authorized connector. "+
      "RSS and manual imports are separately identified sources, never presented as For You."});
    if(!this.plugin.bridge.running){
      root.createEl("p",{text:this.plugin.bridge.lastError||
        "The local collector is not running. Node.js 22.16+ and the complete plugin ZIP are required."});
      button(root,"Start collector",()=>{void this.plugin.start().then(()=>this.draw()).catch(e=>new Notice(asError(e)));});
      root.createEl("p",{text:"Configure Node.js and a permitted feed under Settings → Community Plugins → X Feed Scraper."});
      return;
    }
    try{
      const query="/sources?limit=100&offset="+(this.page*100)+(this.status?"&status="+encodeURIComponent(this.status):"")+
        (this.query?"&q="+encodeURIComponent(this.query):"");
      const [stats,sources,recs,history,visuals,recentErrors]=await Promise.all([
        this.plugin.call("/status") as Promise<Stats>,
        this.plugin.call(query) as Promise<Source[]>,
        this.plugin.call("/recommendations") as Promise<Recommendations>,
        this.plugin.call("/history") as Promise<Array<{started_at:string;status:string;posts_seen:number;sources_new:number;duplicates:number}>>,
        this.plugin.call("/visuals") as Promise<Array<{id:string;url:string;author:string;first_seen:string}>>,
        this.plugin.call("/errors") as Promise<Array<{occurred_at:string;message:string}>>
      ]);
      root.createEl("div",{cls:"xfs-stats",text:"Source: "+stats.connectedSource+
        " · Posts "+stats.posts+" · Unique sources "+stats.sources+
        " · Review "+stats.needs_review+" · Visuals "+stats.visuals+" · High quality "+stats.high_quality+
        " · Approved "+stats.approved+" · Errors "+stats.errors});
      root.createEl("p",{cls:"xfs-meta",text:"Automatic public metadata analysis: "+
        (stats.autoEnrich?"enabled by user":"off (opt-in under Settings)")});
      root.createEl("p",{cls:"xfs-meta",text:stats.paused?"Paused":
        stats.active?"Synchronization running":"Collector active; service bound to localhost only"});
      if(stats.lastRun)root.createEl("p",{cls:"xfs-meta",text:"Last run: "+
        (stats.lastRun.ended_at||stats.lastRun.started_at)+" ("+stats.lastRun.status+")"});
      const actions=root.createDiv({cls:"xfs-actions"});
      button(actions,"Refresh",()=>{void this.draw();});
      button(actions,"Diagnostics",()=>{
        void this.plugin.call("/diagnostics").then(result=>{
          const diag=result as {
            sqliteIntegrity:string;nodeVersion:string;referencesPresent:boolean;
            collectorInput:string;personalizedXFeedAvailable:boolean
          };
          new Notice("Node "+diag.nodeVersion+" · SQLite "+diag.sqliteIntegrity+
            " · References.md "+(diag.referencesPresent?"found":"missing")+
            " · Input "+diag.collectorInput+" · X For You unavailable",9000);
        }).catch(e=>new Notice(asError(e)));
      });
      const sync=button(actions,"Sync authorized source",()=>{void this.action("/sync");});
      sync.disabled=stats.connectedSource==="none";
      button(actions,stats.paused?"Resume":"Pause",()=>{void this.action(stats.paused?"/resume":"/pause");});
      button(actions,"Import observations",()=>new ImportModal(this.plugin,()=>{void this.draw();}).open());
      button(actions,"Check public metadata",()=>new ConfirmAction(this.plugin,
        "Fetch public metadata?","This makes network requests to up to 10 discovered public websites. "+
        "No authenticated X content is retrieved.","Fetch metadata",async()=>{
          const response=await this.plugin.call("/enrich","POST",{limit:10});
          this.plugin.notifyExport(response);
          await this.draw();
        }).open());
      button(actions,"Export notes",()=>{void this.action("/export");});
      button(actions,"Open Bases",()=>{
        void this.plugin.app.workspace.openLinkText("X Feed Scraper/Sources.base","",false);
      });
      root.createEl("h4",{text:"Curated sources"});
      const controls=root.createDiv({cls:"xfs-controls"});
      const search=controls.createEl("input",{attr:{placeholder:"Search title, URL or category",value:this.query}});
      search.value=this.query;
      const filter=controls.createEl("select");
      const statuses=[
        ["","All statuses"],["needs_review","Needs review"],["high_quality","High quality"],
        ["approved","Approved"],["rejected","Rejected"],["evaluated","Evaluated"]
      ];
      for(const [id,title] of statuses){
        const item=filter.createEl("option",{text:title,attr:{value:id}});
        item.value=id;
      }
      filter.value=this.status;
      button(controls,"Search",()=>{
        this.query=search.value.trim().slice(0,100);this.status=filter.value;this.page=0;
        void this.draw();
      });
      const pager=controls.createDiv({cls:"xfs-actions"});
      button(pager,"Previous",()=>{
        this.page=Math.max(0,this.page-1);void this.draw();
      }).disabled=this.page===0;
      pager.createSpan({text:"Page "+(this.page+1)});
      button(pager,"Next",()=>{
        this.page++;void this.draw();
      }).disabled=sources.length<100;
      if(!sources.length)root.createEl("p",{cls:"xfs-muted",text:"No sources match the filter."});
      for(const source of sources){
        const card=root.createDiv({cls:"xfs-card"});
        card.createEl("h5",{text:source.title||source.url});
        card.createEl("p",{cls:"xfs-meta",text:source.category+" · "+source.status+" · "+
          source.score+"/100 · confidence "+Math.round(source.confidence*100)+"% · "+source.access});
        const links=card.createDiv({cls:"xfs-actions"});
        external(links,"Open source",source.url);
        if(source.postUrl)external(links,"Original observation",source.postUrl);
        if(source.description)card.createEl("p",{text:source.description.slice(0,500)});
        if(source.license)card.createEl("p",{cls:"xfs-meta",text:"License: "+source.license});
        card.createEl("p",{text:source.reasons.join(" · ")});
        const decisions=card.createDiv({cls:"xfs-actions"});
        if(source.status!=="approved"&&source.status!=="rejected"){
          button(decisions,"Approve",()=>new ReviewModal(this.plugin,source,"approved",()=>{void this.draw();}).open());
          button(decisions,"Excellent",()=>new ReviewModal(this.plugin,source,"excellent",()=>{void this.draw();}).open());
          button(decisions,"Reject",()=>new ReviewModal(this.plugin,source,"rejected",()=>{void this.draw();}).open());
        }
        if(source.status==="approved"){
          button(decisions,"Add to References.md",()=>new ConfirmAction(this.plugin,
            "Modify References.md?","This explicitly adds one approved URL to your primary library "+
            "after creating a timestamped backup. Existing entries remain untouched.",
            "Backup and add",async()=>{
              await this.plugin.addApprovedToReferences(source);
              await this.draw();
            }).open());
        }
      }
      const visualSection=root.createEl("details");
      visualSection.createEl("summary",{text:"Visual-only references ("+visuals.length+")"});
      visualSection.createEl("p",{text:"No external project URL was found. Image links are kept only for human review."});
      for(const visual of visuals){
        const item=visualSection.createDiv();
        external(item,visual.author+" · "+visual.first_seen,visual.url);
      }
      const errorSection=root.createEl("details");
      errorSection.createEl("summary",{text:"Recent errors ("+recentErrors.length+")"});
      if(!recentErrors.length)errorSection.createEl("p",{text:"No recent errors recorded."});
      for(const error of recentErrors){
        errorSection.createEl("p",{cls:"xfs-meta",text:error.occurred_at+" · "+error.message});
      }
      const log=root.createEl("details");
      log.createEl("summary",{text:"Run history"});
      for(const run of history.slice(0,15)){
        log.createEl("p",{cls:"xfs-meta",text:run.started_at+" · "+run.status+" · "+
          run.posts_seen+" posts · "+run.sources_new+" new · "+run.duplicates+" duplicates"});
      }
      const manual=root.createEl("details");
      manual.createEl("summary",{text:"Manual X post / account suggestions"});
      manual.createEl("p",{text:"These are links for human action only; no likes or follows are automated."});
      for(const post of recs.posts.slice(0,20)){
        const row=manual.createDiv();
        external(row,post.author+" · "+post.score+"/100",post.post_url);
        row.createSpan({text:" · "+post.categories});
      }
      for(const author of recs.authors.slice(0,20)){
        if(!/^[A-Za-z0-9_]{1,15}$/.test(author.username))continue;
        const row=manual.createDiv();
        external(row,"Visit @"+author.username,"https://x.com/"+author.username);
        row.createSpan({text:" · "+author.quality_sources+" useful sources"});
      }
    }catch(e){
      root.createEl("p",{text:"Collector error: "+asError(e)});
      button(root,"Restart local engine",()=>{void this.plugin.restart().then(()=>this.draw()).catch(e=>new Notice(asError(e)));});
    }
  }
  private async action(path:string):Promise<void>{
    try{
      const response=await this.plugin.call(path,"POST");
      this.plugin.notifyExport(response);
      await this.draw();
    }
    catch(e){new Notice(asError(e));}
  }
}
class ScraperSettings extends PluginSettingTab {
  constructor(private plugin:ScraperPlugin){super(plugin.app,plugin);}
  display():void{
    const root=this.containerEl;root.empty();
    root.createEl("h3",{text:"X Feed Scraper"});
    root.createEl("p",{text:"Obsidian launches the included local collector. X For You remains unavailable. "+
      "RSS is an independent permitted source; leave it blank to import observations manually."});
    new Setting(root).setName("Launch collector on startup")
      .addToggle(t=>t.setValue(this.plugin.settings.autoStart).onChange(async value=>{
        this.plugin.settings.autoStart=value;await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Node.js executable")
      .setDesc("Node.js 22.16+ (default: node). Specify an absolute node path if Obsidian cannot find it.")
      .addText(t=>t.setValue(this.plugin.settings.nodeExecutable).onChange(async value=>{
        this.plugin.settings.nodeExecutable=value.trim()||"node";await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Authorized RSS/Atom URL")
      .setDesc("Public HTTP(S) feeds only. Do not use account/session tokens here. Not an X feed.")
      .addText(t=>t.setValue(this.plugin.settings.feedUrl).onChange(async value=>{
        const candidate=value.trim();
        try{
          if(candidate)normalizeUrl(candidate);
        }catch{
          new Notice("Public feed URL rejected: credentials or invalid URL parameters. No secret was saved.");
          return;
        }
        this.plugin.settings.feedUrl=candidate;
        await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Local fixture file (tests only)")
      .setDesc("Alternative to RSS; must be a local JSON file. Never indicates actual X coverage.")
      .addText(t=>t.setValue(this.plugin.settings.fixturePath).onChange(async value=>{
        this.plugin.settings.fixturePath=value.trim();await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Sync interval (minutes)")
      .setDesc("Minimum 15 for RSS. Leave 0 for manual sync only.")
      .addText(t=>t.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async value=>{
        const n=Number(value);
        if(Number.isInteger(n)&&n>=0&&n<=1440){
          this.plugin.settings.intervalMinutes=n;await this.plugin.saveSettings();
        }
      }));
    new Setting(root).setName("Quality threshold")
      .setDesc("0–100, default 75")
      .addText(t=>t.setValue(String(this.plugin.settings.scoreThreshold)).onChange(async value=>{
        const n=Number(value);
        if(Number.isInteger(n)&&n>=0&&n<=100){this.plugin.settings.scoreThreshold=n;await this.plugin.saveSettings();}
      }));
    new Setting(root).setName("Confidence threshold")
      .setDesc("0–1, default 0.65; separate from quality score")
      .addText(t=>t.setValue(String(this.plugin.settings.confidenceThreshold)).onChange(async value=>{
        const n=Number(value);
        if(Number.isFinite(n)&&n>=0&&n<=1){this.plugin.settings.confidenceThreshold=n;await this.plugin.saveSettings();}
      }));
    new Setting(root).setName("Prefer free/open-source evidence")
      .addToggle(t=>t.setValue(this.plugin.settings.preferFree).onChange(async value=>{
        this.plugin.settings.preferFree=value;await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Automatically analyze public source metadata")
      .setDesc("Opt-in: on every permitted synchronization, fetch titles/descriptions and public GitHub license information from up to 10 external websites. No X website automation or credentials. Retries are bounded.")
      .addToggle(t=>t.setValue(this.plugin.settings.autoEnrich).onChange(async value=>{
        this.plugin.settings.autoEnrich=value;await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Custom research profile")
      .setDesc("Optional absolute path to a JSON profile; defaults to packaged design.json")
      .addText(t=>t.setValue(this.plugin.settings.profilePath).onChange(async value=>{
        this.plugin.settings.profilePath=value.trim();await this.plugin.saveSettings();
      }));
    new Setting(root).setName("Apply settings")
      .setDesc("Restart the local engine using the saved settings; no secrets are persisted.")
      .addButton(b=>b.setButtonText("Restart collector").onClick(async()=>{
        try{await this.plugin.restart();new Notice("Local collector restarted");}
        catch(e){new Notice(asError(e));}
      }));
    root.createEl("p",{text:"SQLite is stored outside the synced vault under ~/.x-feed-scraper. "+
      "Local API bearer tokens are randomized in memory every start. "+
      "References.md is only modified after confirmation and backup."});
  }
}
export default class ScraperPlugin extends Plugin {
  settings:SettingsData={...DEFAULT};
  readonly bridge=new LocalBridge();
  async onload():Promise<void>{
    const loaded=await this.loadData() as Partial<SettingsData>|null;
    this.settings={...DEFAULT,...(loaded||{})};
    if(this.settings.feedUrl){
      try{normalizeUrl(this.settings.feedUrl);}
      catch{
        this.settings.feedUrl="";
        await this.saveSettings();
        new Notice("An unsafe saved feed URL was cleared. Credentials must not be stored in the vault.");
      }
    }
    this.registerView(VIEW,leaf=>new SourceView(leaf,this));
    this.addRibbonIcon("book-open-check","Open X Feed Scraper",()=>{void this.activate();});
    this.addCommand({id:"open-candidates",name:"Open curated sources",callback:()=>{void this.activate();}});
    this.addCommand({id:"sync-authorized-source",name:"Sync authorized source",callback:()=>{
      void this.call("/sync","POST").then(()=>this.redraw()).catch(e=>new Notice(asError(e)));
    }});
    this.addSettingTab(new ScraperSettings(this));
    if(this.settings.autoStart)void this.start().then(()=>this.redraw()).catch(()=>this.redraw());
  }
  async onunload():Promise<void>{
    await this.bridge.stop();
    this.app.workspace.detachLeavesOfType(VIEW);
  }
  notifyExport(raw:unknown):void{
    if(!raw||typeof raw!=="object")return;
    const result=(raw as {export?:unknown}).export;
    if(!result||typeof result!=="object")return;
    const x=result as {created?:number;updated?:number;removed?:number;conflicts?:number;conflictPaths?:string[]};
    const summary="Notes: "+(x.created||0)+" created, "+(x.updated||0)+" updated, "+
      (x.removed||0)+" retired";
    if(x.conflicts){
      const paths=(x.conflictPaths||[]).slice(0,3).join("; ");
      new Notice(summary+". "+x.conflicts+" edit conflicts preserved. "+paths,12000);
    }else if((x.created||0)+(x.updated||0)+(x.removed||0)>0){
      new Notice(summary,5500);
    }
  }
  async saveSettings():Promise<void>{await this.saveData(this.settings);}
  private paths():{dir:string;vault:string}{
    const adapter=this.app.vault.adapter;
    if(!(adapter instanceof FileSystemAdapter))throw new Error("Desktop filesystem vault required");
    const vault=adapter.getBasePath();
    const dir=join(vault,(this.app.vault as unknown as {configDir:string}).configDir||".obsidian",
      "plugins",this.manifest.id);
    return {dir,vault};
  }
  async start():Promise<void>{
    const {vault}=this.paths();
    if(this.settings.feedUrl&&this.settings.fixturePath)throw new Error("Choose either RSS or fixture input");
    if(this.settings.feedUrl){
      const url=new URL(this.settings.feedUrl);
      if(!["https:","http:"].includes(url.protocol)||url.username||url.password||
        /(?:token|secret|api[_-]?key|password|session)=/i.test(url.search)){
        throw new Error("Use an authorized public RSS URL without credentials");
      }
    }
    const localData=join(homedir(),".x-feed-scraper",
      createHash("sha256").update(vault).digest("hex").slice(0,20));
    const embedded=prepareBundledAssets(localData);
    await this.bridge.start({
      executable:this.settings.nodeExecutable,
      collectorPath:embedded.collectorPath,
      databasePath:join(localData,"library.db"),
      profilePath:this.settings.profilePath||embedded.profilePath,
      vaultPath:vault,
      feedUrl:this.settings.feedUrl||undefined,
      fixturePath:this.settings.fixturePath||undefined,
      scheduleMinutes:this.settings.intervalMinutes,
      threshold:this.settings.scoreThreshold,
      confidence:this.settings.confidenceThreshold,
      preferFree:this.settings.preferFree,
      autoEnrich:this.settings.autoEnrich
    });
  }
  async restart():Promise<void>{
    await this.bridge.stop();
    await this.start();
    await this.redraw();
  }
  async activate():Promise<void>{
    let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];
    if(!leaf){
      leaf=this.app.workspace.getRightLeaf(false)||this.app.workspace.getLeaf(true);
      await leaf.setViewState({type:VIEW,active:true});
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  async redraw():Promise<void>{
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW)){
      if(leaf.view instanceof SourceView)await leaf.view.draw();
    }
  }
  async call(path:string,method:"GET"|"POST"="GET",value?:unknown):Promise<unknown>{
    if(!this.bridge.running)await this.start();
    if(!this.bridge.running)throw new Error("Local engine is not running");
    const res=await requestUrl({
      url:"http://127.0.0.1:"+this.bridge.port+path,method,
      headers:{"authorization":"Bearer "+this.bridge.token,
        "content-type":"application/json"},
      body:value!==undefined?JSON.stringify(value):undefined,
      throw:false
    });
    if(res.status<200||res.status>=300){
      const detail=(res.json as {error?:string}|undefined)?.error||res.text.slice(0,120);
      throw new Error("Local engine: "+detail);
    }
    return res.json;
  }
  private async ensureFolder(folder:string):Promise<void>{
    if(!this.app.vault.getAbstractFileByPath(folder))await this.app.vault.createFolder(folder);
  }
  async addApprovedToReferences(source:Source):Promise<void>{
    if(source.status!=="approved")throw new Error("Only manually approved sources can enter References.md");
    const fresh=await this.call("/source?id="+encodeURIComponent(String(source.id))) as Source;
    if(fresh.status!=="approved"||fresh.url!==source.url){
      throw new Error("Source approval changed since this view was loaded. Refresh before modifying References.md");
    }
    const file=this.app.vault.getAbstractFileByPath("References.md");
    if(!(file instanceof TFile))throw new Error("References.md not found at vault root");
    const original=await this.app.vault.read(file);
    if(libraryContains(original,source.url))throw new Error("Reference already present");
    await this.ensureFolder("X Feed Scraper");
    await this.ensureFolder("X Feed Scraper/Backups");
    const name="X Feed Scraper/Backups/References-"+new Date().toISOString().replace(/[:.]/g,"-")+
      "-"+randomBytes(4).toString("hex")+".md";
    await this.app.vault.create(name,original);
    await this.app.vault.process(file,current=>{
      if(current!==original)throw new Error("References.md changed during confirmation. Retry.");
      return appendApprovedReference(current,source);
    });
    const updated=await this.app.vault.read(file);
    if(!libraryContains(updated,source.url))throw new Error("Library write could not be verified");
    new Notice("Reference appended. Backup created: "+name);
  }
}
