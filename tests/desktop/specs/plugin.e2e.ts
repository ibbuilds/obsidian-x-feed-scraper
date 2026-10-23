import {browser,expect} from "@wdio/globals";
import {before,describe,it} from "mocha";
import {existsSync} from "node:fs";
import {join} from "node:path";

describe("X Feed Scraper in actual Obsidian Desktop",function(){
  before(async()=>{
    // The actual Obsidian launcher installs only main.js, manifest.json and styles.css.
    // No manually staged collector.cjs or design.json is allowed: main.js must be self-contained.
    const path=await browser.executeObsidian(({app})=>{
      return (app.vault.adapter as {getBasePath:()=>string}).getBasePath();
    });
    const pluginDir=join(path,".obsidian","plugins","x-feed-scraper");
    for(const file of ["collector.cjs","design.json"]){
      if(existsSync(join(pluginDir,file))){
        throw new Error("Test incorrectly staged "+file+" in Obsidian's three-file installer");
      }
    }
    const started=await browser.executeObsidian(async({app})=>{
      const instance=(app as unknown as {plugins:{plugins:Record<string,{
        start:()=>Promise<void>;bridge:{running:boolean;lastError:string}
      }>}}).plugins.plugins["x-feed-scraper"];
      if(!instance)return {running:false,error:"Plugin instance not loaded"};
      try{
        await instance.start();
        return {running:instance.bridge.running,error:instance.bridge.lastError};
      }catch(error){
        return {running:false,error:String(error)};
      }
    });
    if(!started.running)throw new Error("Three-file Obsidian install could not boot embedded collector: "+started.error);
  });
  it("loads the real plugin and opens its native sidebar without touching References",async()=>{
    await browser.executeObsidianCommand("x-feed-scraper:open-candidates");
    const panel=browser.$(".xfs-panel");
    await panel.waitForExist({timeout:45000});
    await expect(panel).toHaveText(expect.stringContaining("X Feed Scraper"));
    await expect(panel).toHaveText(expect.stringContaining("X For You: not connected"));
    const panelText=await panel.getText();
    expect(panelText).toContain("Import observations");
    expect(panelText).toContain("Diagnostics");
    const content=await browser.executeObsidian(async({app,obsidian})=>{
      const file=app.vault.getAbstractFileByPath("References.md");
      if(!(file instanceof obsidian.TFile))throw new Error("Missing test References.md");
      return app.vault.read(file);
    });
    expect(content).toContain("Unmodified test reference");
  });
  it("imports an observation, reviews it, and updates References only on confirmation",async()=>{
    const button=(text:string)=>browser.$("//button[normalize-space()='"+text+"']");
    await button("Import observations").click();
    const textarea=browser.$(".modal-container textarea");
    await textarea.waitForDisplayed({timeout:15000});
    await textarea.setValue("https://x.com/ux/status/123456 | Motion design interface inspiration https://example.org/motion-reference-demo");
    await button("Import locally").click();
    await browser.waitUntil(async()=>(await browser.$(".xfs-panel").getText()).includes("motion reference demo"),
      {timeout:20000,timeoutMsg:"Imported candidate did not appear in Obsidian"});
    await button("Approve").click();
    const reason=browser.$(".modal-container textarea");
    await reason.waitForDisplayed({timeout:15000});
    await reason.setValue("Human-verified reference for production interaction design");
    await button("Save review").click();
    await browser.waitUntil(async()=>(await browser.$(".xfs-panel").getText()).includes("Add to References.md"),
      {timeout:20000,timeoutMsg:"Review was not reflected in the sidebar"});
    await button("Add to References.md").click();
    await button("Backup and add").click();
    await browser.waitUntil(async()=>{
      const markdown=await browser.executeObsidian(async({app,obsidian})=>{
        const file=app.vault.getAbstractFileByPath("References.md");
        if(!(file instanceof obsidian.TFile))return "";
        return await app.vault.read(file);
      });
      return markdown.includes("https://example.org/motion-reference-demo");
    },{timeout:20000,timeoutMsg:"Approved link was not appended to References.md"});
    const result=await browser.executeObsidian(async({app,obsidian})=>{
      const target=app.vault.getAbstractFileByPath("References.md");
      if(!(target instanceof obsidian.TFile))throw new Error("Missing References.md");
      return {markdown:await app.vault.read(target),files:app.vault.getMarkdownFiles().map(f=>f.path)};
    });
    expect(result.markdown).toContain("Unmodified test reference");
    expect(result.markdown).toContain("https://example.org/motion-reference-demo");
    expect(result.files.some(path=>path.startsWith("X Feed Scraper/Approved/"))).toBe(true);
    expect(result.files.some(path=>path.startsWith("X Feed Scraper/Backups/References-"))).toBe(true);
  });

});
