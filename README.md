# X Feed Scraper

Local-first discovery, deduplication, evaluation and curation of source links from an
**authorized post connector**. Designed to export quality candidates to Obsidian and
make them searchable through an existing Obsidian MCP.

> **Provider status:** the authenticated X "For you" feed is **not available or verified**.
> Demo fixtures are **not** a substitute for this feed. See docs/x-access.md.

## What works

- Typed ingestion of JSON post fixtures including text, quoted links, media references, author and post URLs.
- Normalized URL extraction, tracking removal, relational deduplication and observed-run history in SQLite.
- Pluggable category profiles, evidence-aware quality scoring (score and confidence), persisted reviews.
- Manual opt-in public metadata discovery with network safety checks.
- Read-only use of your existing References.md as a baseline; create-only Obsidian candidate and approved notes.
- Native Obsidian Bases view and minimal review plugin, with a protected local HTTP service.
- No commercial AI dependency, hidden telemetry, X password or automated X engagement.

## Requirements

Node.js >=22.16 (the built-in node:sqlite and --experimental-strip-types are used).
The collector uses no paid API or runtime npm dependency. Obsidian plugin building needs npm dependencies.

## Install and test

    git clone https://github.com/ibbuilds/obsidian-x-feed-scraper.git
    cd obsidian-x-feed-scraper
    npm install
    npm test
    npm run check
    npm run build

## First local run (synthetic fixtures)

    npm run sync -- --fixture tests/fixtures/posts.json
    npm run cli -- status
    npm run cli -- sources
    npm run cli -- history
    npm run cli -- recommendations
    npm run cli -- report

Default DB: ./data/x-feed.db (ignored by Git). Pass --db /path/to/local.db to change.
Pass --profile ./profiles/design.json for the initial design profile or create your own.
No real X scraping occurs. Recommendations show links for manual likes/follows only.

## Obsidian integration

To compare against your real library and create new notes:

    npm run sync -- --fixture tests/fixtures/posts.json --vault "/absolute/path/to/your/vault"
    npm run cli -- sources --status needs_review
    npm run cli -- review --id 1 --decision approved --reason "Validated source"
    npm run cli -- export --vault "/absolute/path/to/your/vault"

The collector reads <vault>/References.md but **never edits it**. It creates files in
X Feed Scraper/Candidates and X Feed Scraper/Approved, run reports under X Feed Scraper/Reports,
plus X Feed Scraper/Sources.base.
Conflicting, manually edited notes are never replaced. Approved notes still require a
separate explicit human decision before entering References.md.

## Local plugin / service (desktop Obsidian)

After npm run build, copy apps/obsidian-plugin/main.js and manifest.json to
<your vault>/.obsidian/plugins/x-feed-scraper/ and enable the community plugin.

Generate a local token (keep it private), then start the local collector:

    export XFS_API_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
    npm run serve -- --fixture tests/fixtures/posts.json --vault "/absolute/path/to/your/vault"

In the plugin settings, paste the same token. It is held in memory **only for this session**.
The plugin can display status, sources, recommended candidates, approval/rejection and
trigger sync/pause/resume. Pause state persists across restarts. The collector binds 127.0.0.1:47321 only. Do not expose it publicly.

With no --fixture, the service can show stored results but cannot sync; no real X connector
is claimed. Set --interval 60 to reprocess a permitted, configured input hourly; fixture
mode simply replays the same local data idempotently.

## Optional public metadata enrichment

    npm run cli -- enrich --limit 20 --vault "/absolute/path/to/your/vault"

This explicitly makes network requests to linked public pages (not the X feed) to discover
titles/descriptions. It is OFF by default. It does not prove design quality, licensing or price.

## Documentation

- docs/architecture.md — data model, behavior and security boundaries.
- docs/profiles.md — build reusable research profiles.
- docs/x-access.md — verification of X dependency and limitations.
- CONTRIBUTING.md — development rules.
- LICENSE — MIT.

Version 0.1.0 is a verifiable local pipeline, **not** a working personalized X scraper.
