# Discovery Engine 0.8.0 acceptance and release boundaries

CI verification refers to the automated GitHub Actions tests, not the user's personal Obsidian vault or X account. Feature status must not be inferred from installability alone.

| Requirement | Status | Evidence/limitations |
| --- | --- | --- |
| Independent generic core | Implemented and tested | Projects/observations/entities do not require X, URLs or Obsidian |
| Source adapter SDK | Implemented and tested | Built-in JSON/RSS/MCP stdio and external sample ticket adapter |
| Processor/evaluator/output SDK | Implemented and tested | External ticket processor/evaluator, built-in generic pipelines and JSON/Obsidian outputs |
| Custom entity schemas | Implemented and tested | Typed JSON fields + validation; security/ticket/research examples |
| Project-specific evaluations and reviews | Implemented and tested | Separate project IDs prevent cross-project scoring/review contamination |
| Resumable incremental collection | Implemented and tested | Stable IDs, durable cursors, atomic per-page persistence, failed-page replay |
| Execution cache isolation and cancellation | Implemented and tested | Reusing a caller signal reloads snapshots between runs, isolates projects, preserves reviews and prevents a late page from committing after cancellation |
| Source configuration changes | Implemented and tested | Config fingerprints prevent reusing checkpoints for a different dataset |
| Offline re-evaluation | Implemented and tested | Reprocess stored observations without calling sources or losing manual approval |
| Relationship/provenance storage | Implemented and tested | SQLite `kb_mentions` and observation count, evidence JSON |
| Optional public metadata research | Implemented; explicitly opt-in | DNS-pinned public HTTP, blocks private destinations and X, per-run limit |
| Non-URL resources | Implemented and tested | Security advisory, ticket and research record entity examples |
| JSON and guarded Obsidian outputs | Implemented and tested | Markdown/Bases notes, SHA-256 ownership ledger, no modification of manual notes |
| Obsidian Desktop project UI | Implemented and tested in isolated Linux desktop | Guided no-code project creation, offline demo, saved-project switching, provenance and review history; owner-device smoke test pending |
| Guided project setup and offline sample | Tested in real Obsidian Desktop | RSS/JSON/MCP/demo setup, bundled offline sample completes without external services or touching References.md |
| CLI without Obsidian | Implemented and tested | project sync, list, entities, review, reprocess and export |
| Additive migration of v0.4.0 | Implemented and tested | Original posts, sources, relations, reviews and References.md retained |
| Immutable revisions and field change log | Implemented and tested | Repeated identical snapshots produce no duplicates; changed fields record old/new values and source identity |
| Configurable change watches | Implemented and tested | New records, changed values, percent drop/rise, equality; unchanged-currency guard |
| Product price monitor | Implemented with deterministic tests | Public Schema.org Product/Offer structured-data adapter and local price-drop scenario; real merchant support varies |
| Public source identity and transport | Implemented with deterministic tests | Multiple recognized Products are rejected before selecting an Offer; HTTPS redirects cannot downgrade to HTTP; DNS/private-address checks still apply |
| Job opportunities monitor | Implemented with deterministic tests | Generic HTTPS JSON API mapping, public Greenhouse example template and synthetic job status/location changes; cannot infer closure from absence |
| External notifications | Not implemented | Alerts are local SQLite/UI/CLI records, not email/SMS/push notifications |
| MCP interoperability | Tested with synthetic servers | Modern 2026-07-28 and legacy stdio, explicit selected tools, declarative provider JSON mapping, timeouts and secret scoping |
| External extensions security sandbox | **Not implemented** | Only explicitly trusted local .cjs files; OS-level isolation needed for untrusted modules |
| True account-personalized X For You connector | **Blocked** | No verified authorized endpoint/provider method; no real user feed accessed |
| Actual owner's Obsidian/MCP installation | **Not verified** | CI uses isolated test vaults, not the owner's device and files |

## Acceptance cases

1. Same JSON observations are processed by frontend and security projects with **different entity types and evaluations**, using the identical engine.
2. An independent .cjs ticket module registers its own adapter, processor and evaluator without changes to the generic core.
3. An interrupted source fails without advancing the failed page cursor and resumes from its last committed checkpoint.
4. Human decisions persist after quality reprocessing and database restarts.
5. Existing v0.4.0 reviews and post-source links are imported idempotently; the old SQLite tables and Markdown remain intact.
6. Generic Obsidian notes are generated under project-specific folders; edits produce conflicts, not overwritten files.
7. No generic project appends to root References.md.
8. The real Obsidian Desktop app can load an independent non-X project and produce notes in an isolated vault.
9. Linux/macOS/Windows typecheck, build and test, dependency audit and release packaging succeed.
10. A caller can reuse one cancellation signal without reusing another run's snapshot or another project's records. Cancelled pages leave observations, versions, alerts and cursors unchanged.
11. A product page containing an ambiguous primary product and a simpler accessory fails instead of recording the accessory's price under the requested product URL.
12. Public HTTP tests simulate redirects without external requests: HTTPS-to-HTTP is rejected, HTTPS redirects still work, private destinations remain blocked, and explicitly configured HTTP sources retain their existing support.

Source integrity regressions are covered in `tests/monitoring-run-isolation.test.ts` and `tests/public-source-integrity.test.ts`. These cases extend the automated acceptance suite; they do not establish real-merchant compatibility or owner-device acceptance.

## Domain curation acceptance

See [verifiable curation criteria](profiles.md#verifiable-curation-criteria) for identity, evidence, false positives, licenses and human decisions. These criteria distinguish current core guarantees from quality claims that require a labeled domain dataset or manual verification. Passing engine tests is not a measured precision score for real sources.

## Honest limitations

Generalization does not provide unlimited provider permissions or a universally reliable quality oracle. Authoritative source access and quality evidence must come from user-authorized adapters or independent processors. Automated website metadata is only a heuristic signal; visual aesthetic quality remains human-reviewed unless users implement their own validated evaluators.

The personalized X For You input still requires a source-specific authorized adapter, and actual end-to-end retrieval has **not** been implemented. This is independent from generic engine readiness.
