# Optional Source Scraper integration: Obsidian Desktop

**This is not the Source Scraper product.** The engine's public interface is its JSON-first CLI and SDK. Obsidian is only one output/UI integration, kept as an **optional workspace** in `apps/obsidian-plugin` so previous user vaults and plugin IDs remain compatible.

The plugin UI uses Obsidian APIs and embeds its own pre-built Node collector; it is packaged separately into `obsidian-x-feed-scraper.zip`. The core CLI can run without installing or enabling Obsidian. No internal core package imports the Obsidian application.

For plugin users: install only the three files inside the release ZIP into `<vault>/.obsidian/plugins/x-feed-scraper/` and enable **Discovery Engine** in Community plugins. Keep the existing plugin ID `x-feed-scraper`; renaming it would break upgrades for existing installations. Do **not** clone the entire repository into the plugin folder; a source checkout does not contain the final compiled `main.js` at its root.

For developers only:

```sh
npm ci
npm run build:obsidian
node apps/obsidian-plugin/package.mjs
```

Obsidian plugin functional acceptance remains separate from the JSON CLI suite. Test the plugin against synthetic vault data before touching an actual user's vault. The personalized X For You feed remains unsupported unless a provider-authorized connector becomes available.

The plugin currently contains the earlier native review/sidebar workflow for backward compatibility. It may eventually be moved into a distinct repository, but that has **not** happened yet; it is a separate package and release artifact inside this monorepo.
