import {ItemView,Modal,Notice,Plugin,PluginSettingTab,Setting,WorkspaceLeaf,requestUrl} from "obsidian";

const VIEW="x-feed-scraper-view";
interface SettingsData {serverUrl:string}
interface Source {
  id:number;url:string;title:string;category:string;access:string;score:number;
  confidence:number;status:string;reasons:string[];postUrl?:string;author?:string;
}
type Stat = {posts:number;sources:number;links:number;high_quality:number;needs_review:number;approved:number;
  errors:number;active:boolean;paused:boolean;connectedSource:string;lastRun?:{ended_at?:string;status:string}};
const DEFAULT:SettingsData={serverUrl:"http://127.0.0.1:47321"};

class ReviewModal extends Modal {
  constructor(plugin:ScraperPlugin,source:Source,decision:string,onDone:()=>void) {
    super(plugin.app);
    this.titleEl.setText((decision==="approved"?"Approve ":"Reject ")+(source.title||source.url));
    const reason=this.contentEl.createEl("textarea",{attr:{rows:"4",placeholder:"Reason for decision",style:"width:100%"}});
    new Setting(this.contentEl).addButton(btn=>btn.setButtonText("Confirm").setCta().onClick(async()=>{
      try {
        await plugin.call("/review","POST",{id:source.id,decision,reason:reason.value});
        new Notice("Review saved");
        this.close();onDone();
      } catch(e) {new Notice(String(e));}
    }));
  }
}

class ScraperView extends ItemView {
  plugin:ScraperPlugin;
  constructor(leaf:WorkspaceLeaf,plugin:ScraperPlugin) {super(leaf);this.plugin=plugin;}
  getViewType():string {return VIEW;}
  getDisplayText():string {return "X Feed Scraper";}
  getIcon():string {return "book-open-check";}
  async onOpen():Promise<void> {await this.draw();}
  async onClose():Promise<void> {}
  private button(parent:HTMLElement,label:string,fn:()=>void):void {
    const el=parent.createEl("button",{text:label});
    el.addEventListener("click",fn);
  }
  async draw():Promise<void> {
    const root=this.contentEl;root.empty();
    root.createEl("h3",{text:"X Feed Scraper"});
    if (!this.plugin.token) {
      root.createEl("p",{text:"Enter the local bridge token in the plugin settings. It is held in memory and not saved to the vault."});
      this.button(root,"Open settings",()=>this.plugin.app.setting.open());
      return;
    }
    try {
      const [stats,sources]=await Promise.all([
        this.plugin.call("/status") as Promise<Stat>,
        this.plugin.call("/sources") as Promise<Source[]>
      ]);
      root.createEl("p",{text:"Source: "+stats.connectedSource+" | "+(stats.paused?"Paused":stats.active?"Syncing":"Idle")});
      root.createEl("p",{text:"Posts: "+stats.posts+" | Sources: "+stats.sources+" | High quality: "+stats.high_quality+
        " | Review: "+stats.needs_review+" | Approved: "+stats.approved+" | Errors: "+stats.errors});
      if (stats.lastRun) root.createEl("p",{text:"Last run: "+(stats.lastRun.ended_at||"ongoing")+" ("+stats.lastRun.status+")"});
      const actions=root.createDiv();
      this.button(actions,"Refresh",()=>{void this.draw();});
      this.button(actions,"Sync now",()=>{void this.action("/sync");});
      this.button(actions,"Pause",()=>{void this.action("/pause");});
      this.button(actions,"Resume",()=>{void this.action("/resume");});
      root.createEl("h4",{text:"Candidates"});
      const visible=sources.filter(s=>s.status!=="rejected"&&s.status!=="approved");
      if (!visible.length) root.createEl("p",{text:"No candidates found."});
      for (const source of visible) {
        const card=root.createDiv({cls:"xfs-candidate"});
        card.createEl("h5",{text:source.title||source.url});
        card.createEl("p",{text:source.category+" | "+source.status+" | "+source.score+"/100 | confidence "+
          Math.round(source.confidence*100)+"% | "+source.access});
        const sourceLink=card.createEl("a",{text:"Open source",href:source.url});
        sourceLink.setAttr("target","_blank");sourceLink.setAttr("rel","noopener noreferrer");
        if (source.postUrl) {
          card.createSpan({text:" · "});
          const postLink=card.createEl("a",{text:"Original post",href:source.postUrl});
          postLink.setAttr("target","_blank");postLink.setAttr("rel","noopener noreferrer");
        }
        card.createEl("p",{text:source.reasons.join(" · ")});
        this.button(card,"Approve",()=>new ReviewModal(this.plugin,source,"approved",()=>{void this.draw();}).open());
        this.button(card,"Reject",()=>new ReviewModal(this.plugin,source,"rejected",()=>{void this.draw();}).open());
        card.createEl("hr");
      }
    } catch(e) {
      root.createEl("p",{text:"Collector unavailable: "+String(e)});
    }
  }
  private async action(path:string):Promise<void> {
    try {await this.plugin.call(path,"POST");await this.draw();}
    catch(e) {new Notice(String(e));}
  }
}
class ScraperSettings extends PluginSettingTab {
  constructor(private plugin:ScraperPlugin) {super(plugin.app,plugin);}
  display():void {
    const {containerEl}=this;containerEl.empty();
    new Setting(containerEl).setName("Local service URL").setDesc("Loopback only. The collector never contacts a remote server.")
      .addText(t=>t.setValue(this.plugin.settings.serverUrl).onChange(async value=>{
        this.plugin.settings.serverUrl=value;await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(containerEl).setName("Local access token (session only)")
      .setDesc("Paste the value of XFS_API_TOKEN. Not persisted to plugin data or the vault.")
      .addText(t=>t.setPlaceholder("Token of 24+ characters").onChange(value=>{this.plugin.token=value;}));
    containerEl.createEl("p",{text:"Start the collector separately with npm run serve -- --fixture ... . The plugin never starts duplicate processes."});
  }
}
export default class ScraperPlugin extends Plugin {
  settings:SettingsData=DEFAULT;
  token="";
  async onload():Promise<void> {
    this.settings=Object.assign({},DEFAULT,await this.loadData());
    this.registerView(VIEW,leaf=>new ScraperView(leaf,this));
    this.addRibbonIcon("book-open-check","X Feed Scraper",()=>{void this.activate();});
    this.addCommand({id:"open-scraper",name:"Open source candidates",callback:()=>{void this.activate();}});
    this.addSettingTab(new ScraperSettings(this));
  }
  async onunload():Promise<void> {this.token="";this.app.workspace.detachLeavesOfType(VIEW);}
  async activate():Promise<void> {
    let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {leaf=this.app.workspace.getRightLeaf(false)!;await leaf.setViewState({type:VIEW,active:true});}
    this.app.workspace.revealLeaf(leaf);
  }
  async call(path:string,method:"GET"|"POST"="GET",data?:unknown):Promise<unknown> {
    if (!this.token) throw new Error("Local token not configured");
    const url=new URL(this.settings.serverUrl);
    if (url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.username||url.password) {
      throw new Error("Only http://127.0.0.1 is supported");
    }
    const response=await requestUrl({
      url:url.origin+path,method,headers:{"Authorization":"Bearer "+this.token,
        "Content-Type":"application/json"},
      body:data?JSON.stringify(data):undefined,throw:false
    });
    if (response.status<200||response.status>=300) throw new Error("Collector: "+response.status+" "+response.text.slice(0,200));
    return response.json;
  }
}
