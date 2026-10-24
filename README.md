# Discovery Engine — extensible knowledge discovery and curation

**Open-source, local-first engine that turns observations from user-authorized sources into structured, evidence-linked, reviewable knowledge.** It is not a news summarizer. Sources, extractors, evaluators and outputs are interchangeable.

Version **0.5.0 beta**. The Obsidian plugin retains its original ID `x-feed-scraper`, repository URL and ZIP filename to protect existing installations.

## What it does

1. A source adapter retrieves authorized observations, with stable IDs and pagination.
2. Configured processors extract entities, optionally research public information, normalize and deduplicate.
3. A project-specific evaluator creates scores, confidence and evidence reasons; human reviews stay separate.
4. SQLite preserves observations, entities, relationships, evaluation history, human review, run logs and cursors.
5. Outputs deliver queryable JSON or safe Markdown/Bases in Obsidian. Existing edited notes remain untouched.

**Not supported:** the real account-personalized X **For You** feed. No provider-authorized integration has been verified. RSS, manually supplied posts and other connectors are not substitutes masquerading as For You. See `docs/x-access.md` and issue #2.

## Quick start: generic engine, no Obsidian required

Requirements: Node.js **22.16+**, Git and npm.

    npm ci
    npm run check
    npm run package
    npm test

Run the **frontend resource** example:

    npm run cli -- project sync --project examples/frontend/project.json --db ./data/demo.db
    npm run cli -- project entities --id frontend-discovery --db ./data/demo.db
    npm run cli -- project export --project examples/frontend/project.json --db ./data/demo.db --vault /absolute/path/to/a/TEST-vault

Run a **different research project** against the same input observations:

    npm run cli -- project sync --project examples/security/project.json --db ./data/demo.db
    npm run cli -- project entities --id security-research --db ./data/demo.db
    npm run cli -- project reprocess --project examples/security/project.json --db ./data/demo.db

Or use a **third-party adapter + processor + evaluator** without modifying our engine:

    npm run cli -- project sync --project examples/tickets/project.json --db ./data/demo.db --extension examples/extensions/tickets.cjs

All example inputs are synthetic. Project manifests define source adapters, an ordered pipeline, evaluator, entity schemas, policy and outputs. JSON input file paths are resolved relative to each manifest.

## Install in Obsidian Desktop

1. Install Obsidian Desktop **1.9.2+** and Node.js **22.16+**.
2. Download the [v0.5.0-beta.1 release](https://github.com/ibbuilds/obsidian-x-feed-scraper/releases/tag/v0.5.0-beta.1).
3. Extract `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/x-feed-scraper/`. Keep this directory: the plugin ID is intentionally backward compatible.
4. Enable **Bases** under Core plugins, then **Discovery Engine** under Community plugins.
5. Enter an absolute **Research project manifest** path in plugin Settings (optionally a trusted local `.cjs` extension file); choose **Restart collector**.
6. Open the sidebar to run, search, review and export your project. The `obsidian` output uses `Discovery Engine/<project-id>/` in the vault.
7. Optionally set a schedule (minimum 15 minutes for a generic project). Collection runs while the local collector is active; the CLI can also operate without Obsidian.

The standard three-file package embeds a SHA-256 checked Node collector and profile. SQLite stays outside your synced vault in `~/.x-feed-scraper/<vault-hash>/library.db`. The local API uses a random in-memory bearer token and listens only on 127.0.0.1.

## Extensibility

- **Source SDK:** `SourceAdapter.collect({source,cursor,limit,signal})` returns pages of generic observations.
- **Processors:** `extract-links`, `linked-resources`, `observation-entity` and opt-in `public-metadata`, or third-party implementations.
- **Evaluators:** evidence and relevance scoring according to each project's own rules; never automatic human approval.
- **Outputs:** bundled `json` and `obsidian`, plus independent third-party output adapters.
- **Local extensions:** load explicit, audited CommonJS `.cjs` modules via `--extension` or Settings. Extensions execute with the OS user's privileges; **there is no security sandbox**.

See `docs/sdk.md` and `docs/projects.md` for the exact v1 contracts, manifests and example integrations.

## Migration and compatibility

Opening a v0.4 SQLite database with the new engine adds `kb_*` tables and idempotently imports original posts, sources, relationships and reviews into project `legacy-x-feed`. It preserves **all original tables, approval records, generated files and References.md**. The old RSS/manual workflow stays available as an explicitly labeled legacy section. New projects use separate entity identities and note folders.

The generic engine **never automatically writes into References.md**. Existing legacy manual confirmation-and-backup behavior is unchanged. See `docs/migration-v0.5.md`.

## Limitations and verification

Collection is bounded by authorized source permissions, rate limits, available records and scheduled runs; no connector can guarantee full coverage of a changing recommendation feed. Scores are heuristic, not proof of visual excellence or accessibility. Optional public metadata processing respects SSRF protections and X host blocks. No paid AI account, X session extraction or automatic likes/follows is required.

CI validates different domains, the external SDK example, migration, cursor recovery and safe exports, plus real Obsidian Desktop in an **isolated** vault. The user's personal vault and connected Obsidian MCP still require their own smoke test. Personalized X For You remains blocked pending an authorized connector.

Documentation: `docs/projects.md`, `docs/sdk.md`, `docs/architecture.md`, `docs/security.md`, `docs/migration-v0.5.md`, `docs/plugin-guide.md`, `docs/x-access.md` and `docs/acceptance-matrix.md`.

Contributions are welcome under the MIT license. Never commit credentials or private user data.
