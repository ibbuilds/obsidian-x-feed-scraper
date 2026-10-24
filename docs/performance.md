# Offline performance profiling — Source Scraper v0.11 to v0.13

This release was profiled with deterministic synthetic workloads on GitHub Actions. Results are not universal performance guarantees: hardware, database size, source latency, and number of revisions change real-world performance.

## Reproduce from source

Requires Node.js >=22.16.0 and `npm ci` on a source checkout.

```sh
node --experimental-strip-types scripts/bench-engine.mjs 1200 12000
node --experimental-strip-types scripts/bench-pagination.mjs 6000 50
node --experimental-strip-types scripts/bench-repeat.mjs 1800
node --experimental-strip-types scripts/bench-reprocess.mjs 2400
```

Both scripts generate temporary local JSON/SQLite fixtures and delete them after profiling. They make **no network requests**, run no third-party extensions, and do not touch personal Obsidian vaults.

The current [performance workflow](../.github/workflows/performance.yml) compares the immutable v0.11.0 commit `894bcf1577d07911f2d000e1464efcecdd324588` with the candidate in two checkouts on the **same Linux runner**. It runs the same synthetic SQL, source paging, unchanged-record replay and offline-reassessment workloads on both revisions, then uploads raw JSON measurements. It checks for meaningful repeat/reassessment speedups and guards against large regressions in existing indexed reads and first ingestion. Measurements can fluctuate under runner load; no one-run result is a universal guarantee. The historic v0.11 profile below compared to the immutable v0.10.0 commit.

## v0.13 compared with v0.12

The current [same-runner comparison](https://github.com/ibbuilds/source-scraper/actions/runs/40090326967) benchmarks the tested v0.12 commit `939c7c7314db15b709d5c0713571b3a35e82ef37` against the v0.13 candidate.

| CPU-bound operation | v0.12 | v0.13 candidate | Gain |
| --- | ---: | ---: | ---: |
| 16,000 equal nested JSON comparisons | 4,932.23 ms | 367.54 ms | 13.4× |
| 16,000 different nested JSON comparisons | 4,936.16 ms | 372.46 ms | 13.3× |
| 16,000 nested change detections | 14,829.16 ms | 1,273.77 ms | 11.6× |
| 65,000 evaluations with 60 keywords | 730.25 ms | 511.79 ms | 1.43× |
| Offline reprocess of 2,400 entities | 143.62 ms | 141.12 ms | Comparable |

The equality comparator uses direct structural traversal instead of sorting
keys and serializing complete subtrees. The test oracle compares the result
to the prior canonical implementation for 1,000 deterministic JSON objects
and checks escaped pointers, array order, missing values, and watch guards.
The keyword cache is scoped to the run and checks each source-array element,
so in-place policy edits are still recognized and invalid inputs still fail.

Offline reprocessing now iterates SQLite entities instead of materializing
the complete entity table before evaluation. This bounds the transient entity
list without changing saved revisions or human decisions; the table above
does **not** claim a measured memory reduction in MiB.

As before, these are synthetic CPU workloads, not benchmarks of remote
provider latency, network reliability, real license accuracy or X access.

## v0.12 compared with v0.11

[Measured PR comparison](https://github.com/ibbuilds/source-scraper/actions/runs/40087354367) on an isolated Linux runner with Node.js 22.16.0, SQLite and synthetic local JSON; no network/MCP calls:

| Operation | v0.11 | v0.12 candidate | Gain |
| --- | ---: | ---: | ---: |
| Ingest 1,800 initial records | 276.14 ms | 280.72 ms | Comparable (+1.7% cost) |
| Revisit 1,800 unchanged records | 242.90 ms | 123.30 ms | 1.97× faster |
| Revisit 1,800 records, one changed | 226.24 ms | 99.50 ms | 2.27× faster |
| Reevaluate 2,400 retained records | 1,000.74 ms | 170.69 ms | 5.86× faster |
| Reevaluate the same 2,400 records again | 972.46 ms | 155.46 ms | 6.26× faster |

The source adapter and evaluators still run on unchanged data: the optimization skips database writes **only if the full observation, retained evidence/drafts, evaluator identity and current assessment all match, and the latest immutable observation revision exists with the same hash**. `last_seen`, cursors and duplicate counters still advance. Explicit human decisions are never inferred or changed. Legacy unnamespaced identity checks continue through the full path.

Offline reevaluation reuses its source lookup and evaluator, commits 100 entities per SQLite transaction, and checks cancellation before each commit. A failed evaluator leaves earlier complete groups committed but does not apply an incomplete group. This preserves crash-safe partial progress with coarser (100-entity) checkpoints than v0.11.

**Discarded experiment:** grouping provenance lookups for full JSON exports provided only about 7.5% improvement on a 3,000-entity test and sometimes worsened 1,400-entity exports. The original output implementation was restored, not shipped as an unproven optimization.

## Recorded comparison

The first same-runner [CI profile](https://github.com/ibbuilds/source-scraper/actions/runs/40084011545) used Node.js 22.16.0 on Linux. Values below are single measurements of a synthetic workload and are not general throughput claims.

| Phase | v0.10 baseline | v0.11 candidate | Relative speedup |
| --- | ---: | ---: | ---: |
| Collect 1,200 records | 499.15 ms | 198.65 ms | 2.51× |
| List 1,200 entities with 12,000 reviews | 119.03 ms | 9.89 ms | 12.0× |
| Fetch evidence for 300 entities | 246.26 ms | 14.02 ms | 17.6× |
| `json-file`, 6,000 records in pages of 50 | 455.52 ms | 21.81 ms | 20.9× |
| `json-snapshot`, same pagination | 389.08 ms | 11.31 ms | 34.4× |

The review query plan changed from `SCAN kb_reviews` to `SEARCH kb_reviews USING INDEX kb_reviews_lookup (project_id=? AND entity_key=?)`. Building review fixtures became slightly slower (36.46 ms → 39.71 ms), which is an expected tradeoff of maintaining indexes. A separately isolated real-user benchmark is needed to estimate performance on external sources.

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
