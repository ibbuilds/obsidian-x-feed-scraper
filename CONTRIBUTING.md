# Contributing to Discovery Engine

Requires Node.js **22.16+**.

    npm ci
    npm run check
    npm run package
    npm test

GitHub CI additionally runs the real Obsidian Desktop app in an isolated Linux vault and Node integration tests on Linux/macOS/Windows.

The product has one responsibility: **turn authorized external observations into structured, traceable, configurable knowledge**. Do not hardcode particular source sites, professions, datasets or output programs into the core.

To add a new source, processor, evaluator or output, implement the v1 contracts in `packages/sdk/contracts.ts` and provide an independent project example and tests. See `docs/sdk.md`. No external extension should require editing the core just to register itself.

Preserve compatibility with the installed Obsidian plugin ID (`x-feed-scraper`) and existing SQLite tables and Markdown. Additive migrations must retain prior reviews, relationships and records. Never automatically edit or overwrite root References.md.

Never commit private vaults, access tokens, authenticated X session data, customer records or credentials. Extensions execute trusted local code and are not sandboxed. Use provider-authorized interfaces; do not implement undocumented account scraping or automated X engagement.

MCP sources should be explicitly authorized, test both modern discovery and legacy handshake using synthetic fixtures, and normalize untrusted tool output without executing expressions. An MCP server's existence is not evidence it can read a personalized X timeline.

The first-run wizard is a stable end-user interface: each new adapter type should support safe guided configuration or provide explicit manifest documentation. Test the bundled offline example and project switching in real Obsidian Desktop, including Electron-specific process restart semantics.
