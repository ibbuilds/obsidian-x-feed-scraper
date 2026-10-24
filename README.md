# Source Scraper

**General-purpose, local-first source collection and data curation. JSON in, JSON out. No GUI, Obsidian or cloud account required.**

Connect a permitted source (JSON, RSS, public APIs, product pages, trusted MCP or custom SDK adapter), extract and normalize entities, deduplicate and evaluate evidence, retain provenance in SQLite, monitor changes, and export the information as **versioned JSON/NDJSON** for any consumer to use.

The project is a **data engine**, not an X-specific scraper, bookmarking app, Obsidian plugin or universal scraping bypass. It does **not** currently access the algorithmically personalized X **For You** feed.

## Quick start — one file, zero setup for the offline demo

**Requirement:** Node.js **22.16+**. Download [`source-scraper.mjs` from v0.11.0-beta.1](https://github.com/ibbuilds/source-scraper/releases/download/v0.11.0-beta.1/source-scraper.mjs), then:

```sh
node source-scraper.mjs init --dir ./demo
node source-scraper.mjs run --config ./demo/project.json
node source-scraper.mjs query --config ./demo/project.json --dataset entities
node source-scraper.mjs export --config ./demo/project.json --out ./results.json
node source-scraper.mjs export --config ./demo/project.json --format ndjson --out ./results.ndjson
```

That's it. The included synthetic example creates `project.json` and `observations.json`; the database `.source-scraper.sqlite` is created next to the manifest on the first run. No calls to X, no external network and no installation of Obsidian. Modify the JSON to use your own data or source adapter.

See the [complete CLI guide](docs/cli.md) and [stable JSON schemas](schemas/).

## How it works

```text
authorized SourceAdapter(s) → Observation JSON → Processor(s) → EntityDraft
                                        ↓
                              Evaluator / Review
                                        ↓
                   SQLite (provenance + versions + alerts)
                                        ↓
                          JSON / NDJSON outputs
                                        ↓
             your scripts, Obsidian, dashboards, other tools
```

The **JSON is the product**. SQLite provides persistence and history, not an interface users have to navigate directly. The CLI and the [extension SDK](docs/sdk.md) are the stable integration points. You can build any UI independently; Source Scraper needs none.

## CLI overview

| Command | Purpose |
| --- | --- |
| `init` | Create a runnable offline JSON demo |
| `validate` | Check the project manifest structure without running it |
| `run` | Collect and persist with per-source checkpoints |
| `projects` | List stored projects |
| `query` | Browse `entities`, `observations`, `changes`, or `alerts` |
| `inspect` | Examine a record's evidence and human review history |
| `review` | Explicitly approve, reject or reset a record |
| `reprocess` | Reevaluate retained data without making network requests |
| `export` | Emit versioned JSON or NDJSON to stdout or a create-only file |
| `adapters` | Inspect available source/processor/evaluator/output plugins |

**Machine-readable output is the default.** A partial or failed source collection returns nonzero exit status. The CLI does **not** run any optional OutputAdapter or send webhooks as a side effect of `run` or `export`. You decide what to do with the resulting JSON.

Example exported record (illustrative):

```json
{
  "projectId": "starter-project",
  "key": "https://example.org/tool",
  "type": "web-resource",
  "title": "tool",
  "url": "https://example.org/tool",
  "attributes": {},
  "category": "web-resource",
  "score": 50,
  "confidence": 0.75,
  "reasons": ["No positive filter defined"],
  "review": "pending",
  "updatedAt": "2026-10-24T00:00:00.000Z",
  "observationCount": 2
}
```

Exports have a `schemaVersion: 1` envelope and, by default, attach available provenance/review history to each entity. They never invent missing source or license facts.

## From a source checkout

```sh
git clone https://github.com/ibbuilds/source-scraper.git
cd source-scraper
npm ci
npm run build:cli
node dist/source-scraper.mjs init --dir ./demo
npm test
```

The `source-scraper-0.11.0.tgz` asset is also provided for users who prefer a local npm package. **The package has not been published to npm;** do not confuse this tarball with a public registry listing.

## Performance and release policy

The 0.11 release adds reusable SQLite prepared statements and per-entity
review/history indexes, avoids re-reading JSON files and hashing snapshots on
every page, and streams large JSON/NDJSON exports in bounded pages. See the
offline [performance comparison](docs/performance.md) for reproducible
measurements. The GitHub **Releases** list intentionally contains **only the
current tested release**; historical Git tags and commits remain available.

## Optional integrations

- **Obsidian Desktop:** optional [Community Plugin integration](apps/obsidian-plugin/README.md), distributed **separately** as the `obsidian-x-feed-scraper.zip` asset. Existing plugin installations keep ID `x-feed-scraper` for compatibility. **You do not need it to use Source Scraper.**
- **Third-party adapters/outputs:** the SDK supports independent source connectors, processors, evaluators and output sinks. Explicit local executable extensions run with your OS permissions and are not sandboxed.
- **Webhooks:** opt-in watch-alert output with bounded retries and idempotency state. These are distinct from the CLI's offline JSON exports.
- **API / legacy workflow:** still available as migration and integration surfaces, but not required for the JSON-first CLI.

The optional Obsidian plugin remains in this monorepo as a separate package; it has **not** yet been split into another GitHub repository.

## Safety and limitations

Only collect from **authorized** sources. The authenticated, algorithmically ranked X **For You** feed is **not available** through a verified connector; Following, search, bookmarks, RSS and demos must not be mislabeled as it. Public metadata, relevance scores and license fields remain evidence-dependent heuristics. A missing record is not proof of deletion. Trusted MCP and custom extensions execute as local processes with your permissions: audit before enabling. Back up existing SQLite files before migrations; source data and human decisions are not sold or uploaded by this local-first engine.

See [architecture](docs/architecture.md), [project manifest reference](docs/projects.md), [security](docs/security.md), [CLI/data contracts](docs/cli.md), [acceptance tests](docs/acceptance-matrix.md), and [contributing](CONTRIBUTING.md).

MIT licensed.
