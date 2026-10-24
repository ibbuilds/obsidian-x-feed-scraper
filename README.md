# Discovery Engine — extensible knowledge discovery and curation

**Open-source, local-first engine that turns observations from user-authorized sources into structured, evidence-linked, reviewable knowledge.** It is not a news summarizer. Sources, extractors, evaluators and outputs are interchangeable.

Version **0.8.0 beta**. The Obsidian plugin retains its original ID `x-feed-scraper`, repository URL and ZIP filename to protect existing installations.

## What it does

1. A source adapter retrieves authorized observations, with stable IDs and pagination.
2. Configured processors extract entities, optionally research public information, normalize and deduplicate.
3. A project-specific evaluator creates scores, confidence and evidence reasons; human reviews stay separate.
4. SQLite preserves observations, entities, relationships, evaluation history, human review, run logs and cursors.
5. Outputs deliver queryable JSON or safe Markdown/Bases in Obsidian. Existing edited notes remain untouched.

**Not supported:** the real account-personalized X **For You** feed. No provider-authorized integration has been verified. RSS, manually supplied posts and other connectors are not substitutes masquerading as For You. See `docs/x-access.md` and issue #2.

## What else can this power? Changes over time

Discovery Engine can now **monitor identified records between collections**, not merely aggregate new links. It retains immutable source/entity revisions, creates field-level change events, and evaluates optional watch rules. This supports reusable pipelines for price-history tracking, job opportunity radar, security advisories and other domain-specific datasets.

Reproducible examples: `examples/price-monitor/project.json` (USD 129.99 → 99.99, alert on ≥10% reduction) and `examples/job-radar/project.json` (new job, explicit status update and changed location). Both use the same generic engine and source interface. Real authorized inputs can use `public-json` (such as a public Greenhouse job board) or `public-product` (a public Schema.org Product/Offer page); support depends on what each provider exposes.

**Alerts are currently local records and an Obsidian/CLI feed**, not push notifications. Disappearance from a job board is not sufficient evidence of closure; price comparisons are guarded against currency changes. See [Monitoring guide](docs/monitoring.md).

## First run in Obsidian — no code or JSON required

1. Install the latest three-file ZIP and open **Discovery Engine** in the sidebar.
2. Click **Create research project**, leave **Built-in offline demo** selected, and press **Create & run project**.
3. The plugin imports synthetic observations, deduplicates a shared resource, evaluates it and generates a separate Obsidian knowledge Base/Markdown notes. Open **Sources, evidence and review history** on a card to see why the resource was included.
4. To collect actual data, create another project using **Public RSS / Atom**, **Local JSON observations** or an explicit **trusted local MCP server**. Configure topics and interval from the same wizard; you do not need to edit a JSON manifest.
5. Projects created by the wizard are saved under the per-vault local data directory, outside your synced vault. Use **Switch project** to activate another one; prior SQLite records remain isolated.

For a full step-by-step explanation, see [First run](docs/first-run.md). External custom project manifests and the SDK remain supported for developers.

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

Use an explicitly trusted **MCP server** as a source—no engine fork required:

    npm run cli -- project sync --project examples/mcp/project.json --db ./data/mcp-demo.db
    npm run cli -- project entities --id mcp-lab-research --db ./data/mcp-demo.db

The example uses a synthetic MCP server; real providers can expose normalized observations or use a safe declarative JSON field mapping. Modern 2026-07-28 and legacy 2025 MCP stdio are supported. See `docs/mcp-stdio.md`.

Run a **different research project** against the same input observations:

    npm run cli -- project sync --project examples/security/project.json --db ./data/demo.db
    npm run cli -- project entities --id security-research --db ./data/demo.db
    npm run cli -- project reprocess --project examples/security/project.json --db ./data/demo.db

Or use a **third-party adapter + processor + evaluator** without modifying our engine:

    npm run cli -- project sync --project examples/tickets/project.json --db ./data/demo.db --extension examples/extensions/tickets.cjs

All example inputs are synthetic. Project manifests define source adapters, an ordered pipeline, evaluator, entity schemas, policy and outputs. JSON input file paths are resolved relative to each manifest.

## Install in Obsidian Desktop

1. Install Obsidian Desktop **1.9.2+** and Node.js **22.16+**.
2. Download the [v0.8.0-beta.1 release](https://github.com/ibbuilds/obsidian-x-feed-scraper/releases/tag/v0.8.0-beta.1).
3. Extract `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/x-feed-scraper/`. Keep this directory: the plugin ID is intentionally backward compatible.
4. Enable **Bases** under Core plugins, then **Discovery Engine** under Community plugins.
5. Click **Create research project** in the sidebar to use the guided setup (including an offline test), or supply an existing absolute **Research project manifest** in Settings for advanced use.
6. Open the sidebar to run, inspect provenance, search, review and export your project. The `obsidian` output uses `Discovery Engine/<project-id>/` in the vault.
7. Optionally set a schedule (minimum 15 minutes for a generic project). Scheduled sources collect immediately after service startup, respect Pause and then run on their interval while the collector is active; the CLI can also operate without Obsidian.

The standard three-file package embeds a SHA-256 checked Node collector and profile. SQLite stays outside your synced vault in `~/.x-feed-scraper/<vault-hash>/library.db`. The local API uses a random in-memory bearer token and listens only on 127.0.0.1.

## Extensibility

- **Source SDK:** `SourceAdapter.collect({source,cursor,limit,signal})` returns pages of generic observations.
- **Processors:** `extract-links`, `linked-resources`, `observation-entity` and opt-in `public-metadata`, or third-party implementations.
- **Evaluators:** evidence and relevance scoring according to each project's own rules; never automatic human approval.
- **Outputs:** bundled `json` and `obsidian`, plus independent third-party output adapters.
- **Local extensions:** load explicit, audited CommonJS `.cjs` modules via `--extension` or Settings. Extensions execute with the OS user's privileges; **there is no security sandbox**.

See `docs/sdk.md`, `docs/projects.md` and `docs/mcp-stdio.md` for SDK contracts, example manifests and MCP interoperability.

## Migration and compatibility

Opening a v0.4 SQLite database with the new engine adds `kb_*` tables and idempotently imports original posts, sources, relationships and reviews into project `legacy-x-feed`. It preserves **all original tables, approval records, generated files and References.md**. The old RSS/manual workflow stays available as an explicitly labeled legacy section. New projects use separate entity identities and note folders.

The generic engine **never automatically writes into References.md**. Existing legacy manual confirmation-and-backup behavior is unchanged. See `docs/migration-v0.5.md`.

## Limitations and verification

Collection is bounded by authorized source permissions, rate limits, available records and scheduled runs; no connector can guarantee full coverage of a changing recommendation feed. Scores are heuristic, not proof of visual excellence or accessibility. Optional public metadata processing respects SSRF protections and X host blocks. No paid AI account, X session extraction or automatic likes/follows is required.

CI validates different domains, the external SDK example, migration, cursor recovery and safe exports, plus real Obsidian Desktop in an **isolated** vault. The user's personal vault and connected Obsidian MCP still require their own smoke test. Personalized X For You remains blocked pending an authorized connector.

Documentation: `docs/monitoring.md`, `docs/first-run.md`, `docs/projects.md`, `docs/sdk.md`, `docs/mcp-stdio.md`, `docs/architecture.md`, `docs/security.md`, `docs/migration-v0.5.md`, `docs/plugin-guide.md`, `docs/x-access.md` and `docs/acceptance-matrix.md`.

Contributions are welcome under the MIT license. Never commit credentials or private user data.
