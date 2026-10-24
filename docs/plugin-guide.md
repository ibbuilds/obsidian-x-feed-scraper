# Discovery Engine in Obsidian Desktop

## Install

Requirements: Obsidian Desktop **1.9.2+** with the Bases core plugin enabled, and Node.js **22.16+** available to the desktop application.

Download the latest verified `v0.6.0-beta.1` release ZIP. Copy its three standard files (`main.js`, `manifest.json` and `styles.css`) into `<vault>/.obsidian/plugins/x-feed-scraper/`. **Do not rename this directory**: the original plugin ID is preserved for existing users. Enable **Discovery Engine** in Community plugins.

The plugin contains its own verified Node collector, stored outside the vault after first start. It binds an authenticated loopback port and stores its SQLite database in `~/.x-feed-scraper/<vault-hash>/library.db`. If Node cannot be found from a desktop launcher, use its absolute executable path in Settings.

## Run any research project

1. Create a JSON project manifest using `docs/projects.md` (or start from `examples/frontend/project.json`).
2. Configure the source adapters allowed to access your chosen sources. Optional third-party extensions must be installed and approved manually.
3. Enter the absolute manifest path under **Settings → Research project manifest**. For an external extension, enter its trusted absolute `.cjs` path.
4. Choose a sync interval (0 means manual execution; 15 minutes minimum for scheduled projects). Restart collector. A scheduled source collects immediately on startup, then on its interval, and displays status in the sidebar.
5. Open the Discovery Engine sidebar, click **Run research project**, and view entities, observation counts, scores and provenance. Approve/reject only the discoveries you personally verified.
6. Use **Reevaluate stored data** after changing scoring criteria, without refetching the source. **Export project** writes the configured outputs.

For a trusted local MCP server, select the `mcp-stdio` adapter with its listing tool; see `docs/mcp-stdio.md`. The initial example reads a local synthetic JSON file. It is not a substitute for an authorized personalized X For You connector.

## Existing v0.4 workflow

The earlier RSS and manual post ingestion, SQLite source library, visual-only items, manual recommendations and guarded References.md behavior remain available in the labeled **X Feed Scraper (legacy curation)** section. Their scores and categories are distinct from the new generic project database.

## Owner-device acceptance checklist

- [ ] The standard three-file plugin launches and **Diagnostics** reports SQLite integrity and a running collector.
- [ ] A frontend or custom project can be configured and executed without editing engine source code.
- [ ] A second project with another schema can be processed in the same database and produces isolated results.
- [ ] Obsidian Bases shows structured notes in the project-specific folder.
- [ ] SQLite survives restarting Obsidian; a second sync respects the source cursor and deduplication.
- [ ] Approval/rejection and re-evaluation preserve human review history.
- [ ] Manually editing a generated note produces a conflict rather than silent overwriting.
- [ ] The old References.md and legacy notes remain intact.
- [ ] The user's existing Obsidian MCP can find new project notes in the actual vault.
- [ ] If an external extension is used, its exact code and permissions are reviewed.

CI executes the generic engine and the real Obsidian Desktop flow in an isolated Linux test vault, plus cross-platform Node tests. It cannot replace this owner's device and connected MCP checks.

The real personalized X "For You" feed is NOT a supported connector, and no authenticated session extraction is performed.
