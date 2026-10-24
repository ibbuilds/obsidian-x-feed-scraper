# Discovery Engine architecture

## Invariant: the engine is independent of sources, domains and outputs

`apps/collector/` (CLI and local API) and `apps/obsidian-plugin/` are integration layers. `packages/sdk/contracts.ts` describes replaceable source, processor, evaluator and output interfaces. `packages/core/engine.ts` owns pipeline execution, paging and validation. `packages/storage/knowledge.ts` owns generic SQLite persistence and in-place legacy import.

    SourceAdapter → Observation[] → Processor[] → EntityDraft[]
                                                ↓
                                   Evaluator → Assessment
                                                ↓
          SQLite: observation / entity / mention / evidence / review
                                                ↓
                                  OutputAdapter (JSON, Obsidian, ...)

Source IDs and cursors belong to project-specific connections. Entity identity and reviews are scoped to project ID. One raw observation may cite several entities; repeated observations may cite the same entity. No URL is necessary for a non-web entity.

## Generic SQLite schema

- `kb_projects` and `kb_connections`: project and adapter identifiers, config fingerprints **not raw credentials**.
- `kb_observations`: source payload identifiers, observed text, typed attributes and timestamps.
- `kb_entities`: unique entities and machine-readable attributes.
- `kb_mentions`: many-to-many provenance with evidence JSON.
- `kb_assessments`: score, confidence, category, reasons and evaluator ID.
- `kb_reviews`: independent, append-only human decisions; never implicitly auto-approved.
- `kb_checkpoints` and `kb_runs`: per-source cursors, attempts, outcome and error reporting.

The original v0.4 tables remain intact and are imported additively into project `legacy-x-feed`. Migration is idempotent and does not rewrite old vault files.

## Failure boundaries

All pages are schema-checked before writing. Each source page, its resulting entities/mentions and its next cursor are committed as **one SQLite transaction**. A failed page never advances its cursor. Processing runs are recorded with success/failure, and separate project sources can continue independently.

A process-level database lock serializes collectors and output writes. External adapters may perform network requests while that lock is held; a long request can delay manual review, and timeouts should be enforced by the adapter.

Offline `project reprocess` reevaluates existing stored observations without calling source adapters. Entity scores may change, but manual approvals/rejections stay in their own audit table.

## Output and safety

The built-in Obsidian output writes project-specific typed Markdown and a Base under `Discovery Engine/<project-id>/`. Generated files are fingerprinted: only unchanged machine output can be refreshed. Modified or unknown files are preserved and appear as conflicts. The generic pipeline never appends to the existing root `References.md`.

SQLite remains outside Obsidian vault sync by default. The plugin uses an embedded verified collector process and an authenticated 127.0.0.1 service. The CLI works without Obsidian.

The personalized X For You feed remains a **missing, separately tracked authorized adapter**. The generic engine neither implements undocumented X APIs nor claims generic RSS is an equivalent.
