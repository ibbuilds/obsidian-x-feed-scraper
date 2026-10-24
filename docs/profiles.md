# Project policies and legacy research profiles

For new projects, use a manifest with `policy.includeKeywords`, `policy.excludeKeywords`, `policy.minimumScore`, `pipeline`, `evaluator` and optional `entitySchemas`. This allows an arbitrary research domain and typed entity attributes without hardcoding frontend or X behavior.

See `docs/projects.md` for schema examples, reprocessing and output selection. Custom evaluators can use any verified signals they can access while conforming to the SDK and preserving human decision state.

The original `profiles/design.json` is retained for the **legacy X Feed Scraper source-scoring flow** only. It specifies categories, excluded domains, score/confidence thresholds and free/open-source preferences. Legacy approved and rejected sources are never silently reapproved by the generic system.

Automated scores indicate heuristic relevance and evidence coverage, not proven visual quality or accessibility. Source access/license classifications require actual evidence or a manual check.
