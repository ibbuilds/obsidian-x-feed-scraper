# Discovery Engine 0.6.0 acceptance and release boundaries

CI verification refers to the automated GitHub Actions tests, not the user's personal Obsidian vault or X account. Feature status must not be inferred from installability alone.

| Requirement | Status | Evidence/limitations |
| --- | --- | --- |
| Independent generic core | Implemented and tested | Projects/observations/entities do not require X, URLs or Obsidian |
| Source adapter SDK | Implemented and tested | Built-in JSON/RSS/MCP stdio and external sample ticket adapter |
| Processor/evaluator/output SDK | Implemented and tested | External ticket processor/evaluator, built-in generic pipelines and JSON/Obsidian outputs |
| Custom entity schemas | Implemented and tested | Typed JSON fields + validation; security/ticket/research examples |
| Project-specific evaluations and reviews | Implemented and tested | Separate project IDs prevent cross-project scoring/review contamination |
| Resumable incremental collection | Implemented and tested | Stable IDs, durable cursors, atomic per-page persistence, failed-page replay |
| Source configuration changes | Implemented and tested | Config fingerprints prevent reusing checkpoints for a different dataset |
| Offline re-evaluation | Implemented and tested | Reprocess stored observations without calling sources or losing manual approval |
| Relationship/provenance storage | Implemented and tested | SQLite `kb_mentions` and observation count, evidence JSON |
| Optional public metadata research | Implemented; explicitly opt-in | DNS-pinned public HTTP, blocks private destinations and X, per-run limit |
| Non-URL resources | Implemented and tested | Security advisory, ticket and research record entity examples |
| JSON and guarded Obsidian outputs | Implemented and tested | Markdown/Bases notes, SHA-256 ownership ledger, no modification of manual notes |
| Obsidian Desktop project UI | Implemented and tested in isolated Linux desktop | Project manifest, sidebar list, run, review and export; owner-device smoke test pending |
| CLI without Obsidian | Implemented and tested | project sync, list, entities, review, reprocess and export |
| Additive migration of v0.4.0 | Implemented and tested | Original posts, sources, relations, reviews and References.md retained |
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

## Honest limitations

Generalization does not provide unlimited provider permissions or a universally reliable quality oracle. Authoritative source access and quality evidence must come from user-authorized adapters or independent processors. Automated website metadata is only a heuristic signal; visual aesthetic quality remains human-reviewed unless users implement their own validated evaluators.

The personalized X For You input still requires a source-specific authorized adapter, and actual end-to-end retrieval has **not** been implemented. This is independent from generic engine readiness.
