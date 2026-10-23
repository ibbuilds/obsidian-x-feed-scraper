# Obsidian desktop guide

## Prerequisites and installation

- Obsidian Desktop 1.8+ and Node.js 22.16+ are required. No cloud account, paid API or X authentication is necessary for supported connectors.
- Download the successful GitHub Actions artifact named x-feed-scraper-obsidian from the CI workflow, then unpack the ZIP's five files into the vault plugin folder.
- Enable X Feed Scraper under Settings > Community plugins. Open the ribbon sidebar and allow the local collector to start.
- If Node.js is not found when Obsidian starts from a graphical launcher, configure its absolute executable path in the settings.
- The service binds only a random local port. Its temporary bearer token is never saved in the vault. The standard Obsidian three-file installer is supported: the `main.js` bundle contains versioned and SHA-256-verified collector code and a default profile, extracted to `~/.x-feed-scraper/<vault-hash>/` without reaching out to any download server.

## Choosing a discovery source

The UI supports public RSS/Atom feed URLs, user-provided post observations or a local JSON fixture (development/testing only). Configure only one scheduled feed or fixture, set a minimum 15-minute interval, save, and restart. When no source is configured the panel can still import observations and display previously saved sources.

For a manual observation paste lines in the form:
    https://x.com/example/status/123 | Open-source design system at https://example.org/components

The post URL and text are **provided by the user**, not fetched from X. This is not the authenticated For You timeline.

## Daily use

1. Press Sync authorized source or import observations.
2. Sources receive independent quality scores and evidence confidence. Low confidence is review-only and high score never means automatically approved.
3. Optionally press Check public metadata to fetch titles/descriptions of up to 10 linked public pages, respecting the network restrictions.
4. Search or filter the candidate list, inspect source/original post links and reasons, then Approve, Excellent or Reject with a required reason.
5. Open the generated Sources.base in Obsidian and query the same Markdown candidates through an existing Obsidian MCP.
6. Explicitly press Add to References.md on an approved source. This operation checks for duplicates, saves a unique snapshot backup in X Feed Scraper/Backups, and appends using Obsidian Vault.process.

The main References.md is not edited during synchronization or note export.

## On-device validation checklist

- [ ] The panel and settings render without console errors.
- [ ] The correct installed Node version is used and the packaged collector starts.
- [ ] Reopening Obsidian does not create duplicate collectors.
- [ ] The approved RSS source can be read in accordance with its terms.
- [ ] Manual import, SQLite persistence and incremental deduplication work after restart.
- [ ] Sources.base correctly displays typed YAML categories/status/quality.
- [ ] Approve and Reject produce expected note states without deleting manual edits.
- [ ] References.md insertion creates a backup and never drops existing records.
- [ ] The existing Obsidian MCP can find and read exported notes.
- [ ] Windows/macOS file permissions and paths are verified if relevant.

This list requires an actual Obsidian desktop test, not merely Node-based CI.
