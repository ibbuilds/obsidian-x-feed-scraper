import {browser,expect} from "@wdio/globals";
import {describe,it} from "mocha";

describe("X Feed Scraper in actual Obsidian Desktop",function(){
  it("loads the real plugin and opens its native sidebar without touching References",async()=>{
    await browser.executeObsidianCommand("x-feed-scraper:open-candidates");
    const panel=browser.$(".xfs-panel");
    await panel.waitForExist({timeout:45000});
    await expect(panel).toHaveText(expect.stringContaining("X Feed Scraper"));
    await expect(panel).toHaveText(expect.stringContaining("X For You: not connected"));
    await expect(browser.$(".xfs-panel button=Import observations")).toExist();
    await expect(browser.$(".xfs-panel button=Diagnostics")).toExist();
    const content=await browser.executeObsidian(async({app,obsidian})=>{
      const file=app.vault.getAbstractFileByPath("References.md");
      if(!(file instanceof obsidian.TFile))throw new Error("Missing test References.md");
      return app.vault.read(file);
    });
    expect(content).toContain("Unmodified test reference");
  });
});
