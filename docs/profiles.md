# Project policies and legacy research profiles

For new projects, use a manifest with `policy.includeKeywords`, `policy.excludeKeywords`, `policy.minimumScore`, `pipeline`, `evaluator` and optional `entitySchemas`. This allows an arbitrary research domain and typed entity attributes without hardcoding frontend or X behavior.

See `docs/projects.md` for schema examples, reprocessing and output selection. Custom evaluators can use any verified signals they can access while conforming to the SDK and preserving human decision state.

The original `profiles/design.json` is retained for the **legacy X Feed Scraper source-scoring flow** only. It specifies categories, excluded domains, score/confidence thresholds and free/open-source preferences. Legacy approved and rejected sources are never silently reapproved by the generic system.

Automated scores indicate heuristic relevance and evidence coverage, not proven visual quality or accessibility. Source access/license classifications require actual evidence or a manual check.

## Verifiable curation criteria

Before accepting a domain configuration, record what an entity represents, its stable identity, required fields, authoritative sources and which decisions require human review. Keep those expectations with a small synthetic or authorized, labeled dataset. Report actual outcomes for that dataset; do not invent a precision percentage or treat the keyword score as a probability.

| Criterion | Acceptance case | Current boundary |
| --- | --- | --- |
| Identity and deduplication | Equivalent observations yield one entity with both provenances; unrelated records remain separate even when providers reuse a local ID | URL normalization and project-scoped entity keys exist. `observation-entity` uses `type:id`, so overlapping provider IDs need separate projects or a namespaced custom processor; see the SDK |
| Traceable evidence | Each saved entity resolves to its source observation; a page claim, observed link and human approval remain distinguishable | Observation provenance and immutable ingestion revisions exist. `Evidence` contains signal/detail/confidence, not a structured per-claim source URL, verification date or license scope |
| Relevance and false positives | Label relevant, irrelevant, ambiguous, explicitly excluded and insufficient-evidence cases before evaluation; compare predicted inclusion with those labels | The generic `keyword` evaluator is deterministic and heuristic. It is not a calibrated measure of usefulness, visual quality or source truth |
| License and access | Missing evidence remains unknown; a declared license is traceable to an official license document for the relevant resource/version before claiming verified compatibility | Metadata may contain license claims. There is no universal license verifier; free access, public source code and an open-source license are different claims |
| Human decisions and notes | Recollection and reevaluation preserve approvals/rejections and their reasons; export reports a conflict for an edited note | Separate review history and managed-note fingerprints are tested; CI uses synthetic vaults |

For each labeled dataset, record the dataset/configuration revision, expected entity count and identities, actual false positives and false negatives, and unresolved cases. Precision is `TP / (TP + FP)` and recall is `TP / (TP + FN)` when their denominators are nonzero. Define how ambiguous labels are handled before calculating either metric. A synthetic regression suite checks stated invariants; a representative authorized dataset is needed to estimate real-world curation quality.

### Domain-specific evidence

| Domain | Minimum identity/evidence contract | Claims that require additional verification |
| --- | --- | --- |
| Frontend tools and design resources | Identify the actual tool/resource and retain the post as discovery evidence. An image/video without a resource link remains inspiration | Official URL ownership, license applicability, maintained status, accessibility and visual usefulness cannot be established by keyword matches alone |
| Prices | Identify the merchant, product and comparable offer; require numeric price and explicit currency; reject an ambiguous Product/Offer page | Collected structured data is a merchant claim, not a verified checkout price. Currency changes must suppress numeric comparisons; variants and shipping/taxes need explicit semantics |
| Jobs | Identify provider/board and listing; require project-specific fields such as role, company and URL | Missing listings are unobserved, not closed. Closing requires an explicit source status; salary and location must not be inferred when absent |
| Other domains | Define stable keys, typed required attributes, evidence and change semantics in the adapter/processor and fixtures | Add domain checks through the SDK; the storage core does not supply a universal truth or quality oracle |

### Follow-up gaps found during acceptance

The following remain pending and are not covered by the source-integrity fixes:

- Generic keyword policies currently allow empty, whitespace-only and repeated terms. Use distinct nonempty terms while validation and deduplication are tightened; empty strings can match every record and repeated terms can inflate a score.
- Automatic namespacing for `observation-entity` needs an explicit compatibility/migration decision so existing reviews and histories keep their identities.
- Offline reevaluation currently reconstructs an observation from the current table: it omits `urls`, and `occurred_at` is not refreshed by subsequent collection. Immutable observation revisions retain the received payload, but a custom evaluator depending on those fields needs a storage/replay correction before relying on offline equivalence.

These are concrete follow-up acceptance cases, not completed guarantees. The personalized X For You connector and the owner's actual vault/MCP validation remain the separate external blockers in issues #2 and #3.
