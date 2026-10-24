# Offline performance profiling — Source Scraper v0.11

This release was profiled with deterministic synthetic workloads on GitHub Actions. Results are not universal performance guarantees: hardware, database size, source latency, and number of revisions change real-world performance.

## Reproduce from source

Requires Node.js >=22.16.0 and `npm ci` on a source checkout.

```sh
node --experimental-strip-types scripts/bench-engine.mjs 1200 12000
node --experimental-strip-types scripts/bench-pagination.mjs 6000 50
```

Both scripts generate temporary local JSON/SQLite fixtures and delete them after profiling. They make **no network requests**, run no third-party extensions, and do not touch personal Obsidian vaults.

The [CI performance workflow](../.github/workflows/performance.yml) compares the immutable v0.10.0 commit `1bc4759ec514b74d974d318af35f7b27bb2dd6b9` and the candidate using two separate source checkouts and the **same runner**. The old source receives only the identical benchmark script. Results are uploaded as JSON artifacts. The workflow checks query-plan use of the new review index and requires measured speedups for entity listing, evidence lookups, append-only JSON pagination and snapshot pagination.

## Measured operations

| Workload | What it tests | Optimization |
| --- | --- | --- |
| 1,200 entities, 12,000 reviews | Ingest, review insertion, list entities, get full evidence, reopen | Prepared-statement cache, per-entity review/history indexes, partial snapshot-repair index |
| 6,000 source observations, 50 per page | Iterate a 120-page local `json-file` collection | Load and parse input **once per execution** |
| Same 6,000 source observations as a `json-snapshot` | Iterate a 120-page snapshot with validated revision cursor | Compute snapshot revision hash **once per execution** |
| JSON/NDJSON exports | Paginate at most 500 records at a time, progressively write stdout or a create-only file | Avoid holding up to 100,000 fully enriched records and a second giant output string in memory |

All changes preserve data identity, human decisions, observation versions and source cursor semantics. A new run reloads the configured source. When a source file changes *during* collection, the run's existing pages remain internally consistent; a future run observes the update. This deliberately avoids mixing two revisions during one paginated ingest.

## Limits

- Synthetic input removes remote network latency, so public HTTP/MCP speedups are not quantified.
- Extra indexes consume SQLite disk space and slightly increase writes. Per-run caches use memory proportional to the selected source's allowed maximum of 10,000 observations.
- Statement caching lasts only for the life of its SQLite connection and does not persist across processes.
- The export keeps its v1 JSON contract but writes `count` **after** `records`; consumers must parse JSON properties by key rather than rely on property ordering. NDJSON remains one versioned record per line.
- Real users should separately profile their own authorized sources and restore from a backup if migrations reveal compatibility issues.
