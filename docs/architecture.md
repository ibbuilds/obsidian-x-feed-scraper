# Architecture and security

CLI / optional local HTTP service -> connector -> SQLite -> scoring -> structured Markdown -> Obsidian.

- packages/connectors: local JSON fixture and optional public HTML metadata discovery.
- packages/core: input normalization, source extraction, orchestration, vault export.
- packages/storage: indexed SQLite with posts, sightings, sources, join table, reviews, runs and checkpoints.
- packages/quality: configuration-driven, evidence-gated heuristic ranking.
- apps/collector: CLI and explicitly enabled localhost service with bearer authentication.
- apps/obsidian-plugin: native desktop plugin; reads API, requests sync and records human reviews.

The collector works independently of Obsidian. No passwords or tokens are stored in Markdown.
The plugin asks for the local service token each session and never persists it.
The HTTP service listens only on 127.0.0.1, requires a 24+ character bearer token for every route,
rejects Origin-bearing cross-site requests and caps request sizes.
The token never appears in logs. Remote enrichment is opt-in, enforces protocol allowlisting,
DNS/public-address checks, pins the destination IP for the request, caps redirects, response length,
and timeouts. It does not execute remote code or download media.

Note export never modifies References.md. Candidate/approved files are create-only. A preexisting
file with different bytes is flagged as a conflict, not overwritten. Users approve explicitly;
even high_quality sources are not automatically approved. The existing Obsidian MCP can read
these notes without a second MCP service.

Heuristic quality scores do not establish aesthetic quality or verified site usefulness.
Visual-only posts remain in SQLite and need separate manual curation.
