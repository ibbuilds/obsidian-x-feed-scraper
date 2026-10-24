# Contributing to Source Scraper

Requires Node.js **22.16+**.

    npm ci
    npm run check
    npm run package
    npm test

Reproducible local performance profiles (synthetic; no network or vault access):

    node --experimental-strip-types scripts/bench-engine.mjs
    node --experimental-strip-types scripts/bench-pagination.mjs
    node --experimental-strip-types scripts/bench-repeat.mjs
    node --experimental-strip-types scripts/bench-reprocess.mjs

GitHub CI additionally runs the real Obsidian Desktop app in an isolated Linux vault and Node integration tests on Linux/macOS/Windows.

The product has one responsibility: **turn authorized external observations into structured, traceable, configurable knowledge**. Do not hardcode particular source sites, professions, datasets or output programs into the core.

To add a new source, processor, evaluator or output, implement the v1 contracts in `packages/sdk/contracts.ts` and provide an independent project example and tests. See `docs/sdk.md`. No external extension should require editing the core just to register itself.

Preserve compatibility with the installed Obsidian plugin ID (`x-feed-scraper`) and existing SQLite tables and Markdown. Additive migrations must retain prior reviews, relationships and records. Never automatically edit or overwrite root References.md.

Never commit private vaults, access tokens, authenticated X session data, customer records or credentials. Extensions execute trusted local code and are not sandboxed. Use provider-authorized interfaces; do not implement undocumented account scraping or automated X engagement.

MCP sources should be explicitly authorized, test both modern discovery and legacy handshake using synthetic fixtures, and normalize untrusted tool output without executing expressions. An MCP server's existence is not evidence it can read a personalized X timeline.

The JSON-first CLI, export schemas and standalone single-file release are the primary compatibility contract. New source adapters must support manifest documentation and isolated CLI tests; the Obsidian wizard is a separate, optional integration with its own E2E tests. Do not introduce Obsidian imports into the default core registry.

All adapters that emit updateable observations must document **stable record identity** and whether missing records mean deleted, unavailable or simply unobserved. Never infer closure from absence without explicit source semantics. Snapshot changes, watch comparisons and currency/unit guards belong in reusable core rules, not hardcoded per-domain SQL. Add an example source and test for a second independent domain whenever extending shared monitoring logic.
