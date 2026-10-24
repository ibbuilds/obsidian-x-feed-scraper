# Discovery Engine 0.9.1 — before the owner's first real-vault test

## What is verified automatically

| Area | Evidence | Boundary |
| --- | --- | --- |
| Platform and CLI | `node scripts/ci-smoke.mjs` runs direct Node commands; requires 4 imported posts, 3 sources, 4 links, repeat-import idempotence, queryable generic project entities, and a nonzero invalid-input exit | These are synthetic fixtures, not a personalized X feed |
| Core | `npm run check && npm run package && npm test` includes observations/replay, namespaces, migration, change events, webhook security and cancellation | Heuristic assessments are not universal ground truth |
| Obsidian Desktop | Linux CI launches the real app with an isolated synthetic vault and 6 end-to-end cases | This is not a test on the owner's machine/OS/vault |
| Public sources | SSRF and redirect handling are tested; X-owned hosts and `t.co` variants cannot be automatically retrieved | An authorized For You connector remains unavailable |
| Release | Tag derives from the exact tested `main` checkout, and the installer contains only three standard plugin files | The local plugin still needs user acceptance |

## Owner acceptance (only after a backup)

1. Copy the current Obsidian vault and the local `~/.x-feed-scraper/` data folder to separate backup locations. Do not publish either to GitHub.
2. Confirm Obsidian Desktop 1.9.2+ and Node.js 22.16+. Unzip `main.js`, `manifest.json`, `styles.css` into `.obsidian/plugins/x-feed-scraper/`. Reload Obsidian and enable **Discovery Engine**.
3. Check **Diagnostics** and the native sidebar. The engine must start without missing assets, invalid Node path, localhost authentication errors, or a damaged SQLite database.
4. Create and run the **offline demo project** first. Expect populated findings rather than an empty successful status. Re-run it: no duplicate entities or new unchanged historical changes should appear. Relaunch Obsidian: they must remain available.
5. Reject one discovery and approve another, using the UI. Verify that *only explicitly confirmed* additions change `References.md`, and that a backup was created when a confirmed addition occurs.
6. Edit an automatically created candidate note manually. Re-run export and scoring; the note must remain intact, with a conflict or preserved-edit indication, not overwritten or removed.
7. Open the generated `Knowledge.base`/`Sources.base` for the chosen mode; confirm file grouping and filters in this exact Obsidian version.
8. With explicit permission, connect a **known authorized** RSS/JSON/MCP source and confirm the observed item IDs, provenance and visibility through the connected Obsidian MCP. Never put credentials in repository manifests or share private vault contents.
9. If enabling a webhook, first check the receiver uses `Idempotency-Key` and accepts the schema. Confirm exactly one new watch alert and a readable delivery state; do not infer guaranteed delivery from a mock test.
10. Restore a backup in a separate test vault to prove that the recovery instructions are usable before trusting automatic scheduling on the primary vault.

## Known non-goals and release blockers

- **No personalized X For You access**: issue [#2](https://github.com/ibbuilds/obsidian-x-feed-scraper/issues/2) requires a documented authorized provider and a redacted real read. Do not mislabel Following, bookmarks or RSS as that feed.
- **No personal-vault verification**: issue [#3](https://github.com/ibbuilds/obsidian-x-feed-scraper/issues/3) must remain open until the owner reports actual results.
- Production dependency audit is not a complete security audit. Arbitrary trusted extensions and MCP subprocesses share host permissions. Public-webhook receiver-side idempotency, live destination reachability, and empirical precision of curation have not been established.
- No test suite can rule out all defects. Stop and preserve the database/vault if anything modifies user-authored Markdown, changes review decisions, or returns an empty success after a configured sync.
