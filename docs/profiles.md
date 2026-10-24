# Project policies and legacy research profiles

For new projects, use a manifest with `policy.includeKeywords`, `policy.excludeKeywords`, `policy.minimumScore`, `pipeline`, `evaluator` and optional `entitySchemas`. This allows an arbitrary research domain and typed entity attributes without hardcoding frontend or X behavior.

See `docs/projects.md` for schema examples, reprocessing and output selection. Custom evaluators can use any verified signals they can access while conforming to the SDK and preserving human decision state.

The original `profiles/design.json` is retained for the **legacy X Feed Scraper source-scoring flow** only. It specifies categories, excluded domains, score/confidence thresholds and free/open-source preferences. Legacy approved and rejected sources are never silently reapproved by the generic system.

Automated scores indicate heuristic relevance and evidence coverage, not proven visual quality or accessibility. Source access/license classifications require actual evidence or a manual check.

## Verifiable curation criteria

Before accepting a domain configuration, record what an entity represents, its stable identity, required fields, authoritative sources and which decisions require human review. Keep those expectations with a small synthetic or authorized, labeled dataset. Report actual outcomes for that dataset; do not invent a precision percentage or treat the keyword score as a probability.

| Criterion | Acceptance case | Current boundary |
| --- | --- | --- |
| Identity and deduplication | Equivalent observations yield one entity with both provenances; unrelated records remain separate even when providers reuse a local ID | URL normalization, project-scoped keys and optional `config.entityNamespace` are tested. Legacy cross-source key collisions fail explicitly; existing keys/reviews are preserved |
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

### Acceptance corrections delivered in 0.9

The concrete gaps found during the 0.8 acceptance review are covered by the 0.9 implementation and regression tests:

- Empty/whitespace-only terms are rejected and repeated case variants contribute once, including direct SDK use.
- Namespaces are explicit and immutable for an existing connection. New guided observation projects use them; legacy projects keep their keys and reject ambiguous cross-source collisions.
- Full observations and original per-mention drafts retain URL lists, timestamps and evidence for offline reevaluation. Legacy backfill uses only actual stored revisions; data never recorded cannot be reconstructed.
- Current per-mention evaluations replace historical maximum scoring. Score, confidence, category and reasons come from one assessment, and changing evidence can reduce relevance while preserving human decisions.

See [0.9 migration](migration-v0.9.md) for compatibility and older-data limits. These deterministic cases do not establish precision on an arbitrary live dataset. The personalized X For You connector and the owner's actual vault/MCP validation remain the separate external blockers in issues #2 and #3.
