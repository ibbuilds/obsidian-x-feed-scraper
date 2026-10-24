# Source Scraper CLI — the public product

The product is a **local-first JSON data engine**. It is not a website, an Obsidian plugin, or an X-specific scraper. Any source adapter can produce observations; the pipeline normalizes, deduplicates and assesses entities in SQLite, preserving evidence and changes. Consumers read JSON or NDJSON and implement their own user interface or integration.

Requires **Node.js >=22.16.0**. The release asset `source-scraper.mjs` is a **single self-contained JavaScript file** with its dependencies bundled. Download it and invoke it with Node; npm and Obsidian are not required for users of the binary.

## Five-minute offline workflow

```sh
node source-scraper.mjs init --dir ./demo
node source-scraper.mjs validate --config ./demo/project.json
node source-scraper.mjs run --config ./demo/project.json
node source-scraper.mjs projects --config ./demo/project.json
node source-scraper.mjs query --config ./demo/project.json --dataset entities
node source-scraper.mjs export --config ./demo/project.json --out ./entities.json
node source-scraper.mjs export --config ./demo/project.json --format ndjson --out ./entities.ndjson
```

The starter creates only `project.json` and `observations.json` (synthetic local data); running the project creates `.source-scraper.sqlite` next to the manifest by default. **No network or vault writes occur.** Re-run `run` to detect changed observations. To create a custom workflow, edit the JSON manifest and observations or use authorized RSS, public JSON, public product or trusted MCP adapters.

Every command's successful output is a JSON document, except `help` (human-readable) and `export --format ndjson` (one JSON object per line). Errors use **stderr + nonzero exit status**; partial per-source runs also exit nonzero. No banner or hidden progress messages pollute stdout.

## Commands

| Command | Inputs | Result |
| --- | --- | --- |
| `init` | `--dir DIR` | Create an isolated offline sample; **will not overwrite** prior sample files |
| `validate` | `--config FILE` | Parse the manifest without network, database migration or executable extensions; confirms syntax/structure, **not** source availability |
| `run` | `--config FILE [--db FILE] [--page-size N --max-pages N]` | Collect configured sources and persist each validated page plus cursor atomically |
| `projects` | `--db FILE` or `--config FILE` | List projects already saved in SQLite |
| `query` | `--config FILE [--dataset TYPE --limit N --offset N]` | Page over `entities`, `observations`, `changes` or `alerts` |
| `inspect` | `--config FILE --key KEY` | Full known entity and available provenance, reviews, assessment history |
| `review` | `--config FILE --key KEY --decision approved|rejected|pending --reason TEXT` | Record explicit human decision; never implicit |
| `reprocess` | `--config FILE` | Reassess persisted observations **offline**, preserving human decisions |
| `export` | `--config FILE [--dataset TYPE --format json|ndjson --out FILE]` | Export versioned, portable JSON records. Defaults to stdout, entities with provenance. Writes are **create-only** |
| `adapters` | Optional `--extension ABSOLUTE_TRUSTED_FILE.cjs` | Show registered source, processor, evaluator, output IDs |
| `version` | None | Build and JSON schema version |

`--db FILE` overrides the default sibling database. For `query`, `inspect`, `review`, `export`, supply `--id PROJECT_ID --db FILE` instead of `--config` if a manifest is unavailable. Empty or nonexistent databases are not silently created by read commands. `query` returns at most 500 records per page. `export` allows up to 100,000 records per call with `--offset` for subsequent batches; use NDJSON to pipe records into streaming consumers. Both formats are UTF-8.

`export --compact true` omits provenance detail for smaller files; otherwise entity exports include available source mentions, review history and assessment history. Histories in `entityEvidence` are bounded to 50 source mentions, 30 review entries and 30 assessment revisions per entity. `mentionsTruncated` identifies shortened source mentions. For older migrated data, a null `observation` means complete original JSON was **not retained**; only known legacy fields are exposed, never fabricated.

Project definitions may declare optional `outputs`, including Obsidian or opt-in webhooks. **`run`, `query` and `export` do not invoke OutputAdapters or send webhooks.** They operate on source observations and JSON data only. External delivery remains an explicit integration action in the legacy project CLI, subject to destination and authorization controls.

## JSON contracts

- [Project v1 schema](../schemas/project-v1.schema.json) — manifest shape (adapter-specific configuration still validated by adapters).
- [Observation v1 schema](../schemas/observation-v1.schema.json) — normalized source record.
- [JSON export v1 schema](../schemas/export-v1.schema.json) — `{schemaVersion:1,dataset,projectId,exportedAt,count,records}`.
- [NDJSON line v1 schema](../schemas/ndjson-v1.schema.json) — `{schemaVersion:1,dataset,projectId,record}` per line.

The stable schemaVersion is separate from the program's package version, so minor CLI changes do not invalidate consumers. Changes to documented v1 field meanings require a new schema version. Producers must never infer unavailable source URLs, licenses or product facts; assessment scores are explicitly heuristic.

## Developer/source checkout

```sh
git clone https://github.com/ibbuilds/source-scraper.git
cd source-scraper
npm ci
npm run build:cli
node dist/source-scraper.mjs init --dir ./demo
```

For local source debugging, use `node --experimental-strip-types apps/collector/source-cli.ts ...`; the binary release is the user-facing path. `npm run package` additionally builds the **optional** Obsidian Community Plugin, which is not necessary for the data CLI. Never clone the entire repo into an Obsidian plugin directory: the integration has its own packaged `main.js`, `manifest.json`, and `styles.css`.

## Safety, boundaries and limitations

- Run only source adapters you have authorization to access; X's personalized algorithmic **For You** timeline remains unsupported. The CLI does not try to read cookies or bypass provider protections.
- Explicit local CommonJS extensions and MCP subprocesses execute with the current OS user's permissions. They are **not sandboxed**. Audit them and supply `--extension` only to code you trust.
- SQLite uses an exclusive writer lease and transactional page checkpoints. **Back up the DB before upgrading**; opening a legacy DB may run additive migrations. No cloud account or telemetry is required.
- The toolkit does not guarantee the completeness of third-party sources, universal truth of a classification or license, delivery of an external webhook, or that a data source's absence signifies deletion.
- The optional Obsidian integration consumes the same engine; it is not part of the CLI's execution prerequisites.
