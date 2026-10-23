# X Feed Scraper for Obsidian

A local-first desktop Obsidian plugin that discovers, deduplicates, scores, reviews and organizes useful resources. It runs a bundled Node.js collector locally, stores observations in SQLite, and generates structured Markdown plus an Obsidian Base.

**Version: 0.2.0.** The packaged collector passes CI integration tests. The real personalized X **For You** feed is **NOT CONNECTED**, because no authorized method for it has been verified. Public RSS/Atom feeds and user-supplied observations are distinct connectors; they are never represented as your X For You recommendations.

## Install in Obsidian Desktop

1. Install Node.js 22.16+ and Obsidian Desktop 1.8+.
2. Download the ZIP from the successful **x-feed-scraper-obsidian** GitHub Actions artifact: https://github.com/ibbuilds/obsidian-x-feed-scraper/actions/workflows/ci.yml
3. Extract the five ZIP files directly into the vault plugin folder (usually <vault>/.obsidian/plugins/x-feed-scraper/): main.js, manifest.json, collector.cjs, design.json and styles.css.
4. In Obsidian Settings > Community plugins, reload and enable X Feed Scraper. Open the ribbon panel. Press **Diagnostics** to verify Node.js, SQLite integrity and detection of `References.md`.
5. The panel auto-starts the packaged local engine with a random temporary token and an OS-selected loopback port. There is no manual daemon or token setup. If Node is not on your GUI application's PATH, specify the absolute Node.js executable in plugin settings.
6. Configure an authorized public RSS or Atom feed URL if you want periodic collection; the default interval is 60 minutes. Leave it blank for manual observations. Press Restart collector after settings changes.
7. Use Import observations for post URLs and the corresponding text containing external resource URLs, then review candidates and opt in to metadata enrichment. Approved sources can be added to References.md only via explicit confirmation and timestamped backup.

**No real user X feed has been accessed, and the actual desktop Obsidian installation still needs user-device smoke testing.** Do not paste X cookies, passwords, sessions or secrets into this project.

## Current capabilities

- Native Obsidian sidebar, search and status filters, run history, review reasons, candidates and manually suggested posts/authors.
- SQLite persistence, deduplication across observations, checkpoints and preference feedback.
- Configurable design profile; separate heuristic score and evidence confidence. High scores do not auto-approve sources.
- Optional authorized RSS/Atom syncing while Obsidian runs, and separately labeled local fixture/manual import.
- Explicit, opt-in public website metadata enrichment (private destinations and X automation blocked).
- Generate candidates, approvals, reports and Sources.base under the X Feed Scraper vault folder.
- Protect References.md by performing live duplicate checks, creating a full backup, then using Obsidian's atomic Vault.process only after user approval.
- No paid AI, automated X likes/follows, telemetry or internet-facing service.

The Obsidian plugin requires a local Node.js installation but does not require a separately configured service. SQLite for plugin-managed mode is stored outside the synced vault under ~/.x-feed-scraper/<vault-hash>/library.db. Candidate notes live inside the vault and are accessible to existing Obsidian MCP integrations.

## Develop and test

    git clone https://github.com/ibbuilds/obsidian-x-feed-scraper.git
    cd obsidian-x-feed-scraper
    npm install
    npm run check
    npm run package
    npm test

The distribution ZIP is at dist/obsidian-x-feed-scraper.zip. GitHub CI runs typecheck, packaging, unit tests and a packaged collector smoke test on a synthetic vault.

The collector also runs without Obsidian, allowing external OS scheduling:

    npm run sync -- --fixture tests/fixtures/posts.json
    npm run cli -- sources
    npm run cli -- status

For a public feed instead, use the --feed option with a permitted RSS/Atom URL, and optionally --vault with an absolute path. The standalone database defaults to ./data/x-feed.db.

## Detailed guides

- docs/plugin-guide.md — installation, workflow and real-device smoke-test checklist.
- docs/architecture.md — data model and lifecycle.
- docs/security.md — privacy, network and vault integrity.
- docs/profiles.md — research category profiles and scoring.
- docs/x-access.md — X permissions and For You blocker.
- CONTRIBUTING.md and LICENSE — open-source development and MIT license.

Current project blockers: https://github.com/ibbuilds/obsidian-x-feed-scraper/issues/2 (actual X For You feed) and https://github.com/ibbuilds/obsidian-x-feed-scraper/issues/3 (real Obsidian desktop validation).
