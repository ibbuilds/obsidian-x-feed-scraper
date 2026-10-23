import {browser,expect} from "@wdio/globals";
import {describe,it} from "mocha";

describe("X Feed Scraper in actual Obsidian Desktop",function(){
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
