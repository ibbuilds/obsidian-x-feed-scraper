# Research profiles

Profiles are JSON configurations like profiles/design.json. The core does not hardcode
design-specific criteria. Set categories (each name and keyword strings), excludeDomains,
scoreThreshold (0–100), confidenceThreshold (0–1), and preferFree. Supply
--profile ./profiles/your-profile.json to use another research area.

Scores are heuristic. Positive signals come from topic relevance, public title,
substantial description, HTML evidence, verified free/open-source access and licensing.
Confidence is an independent coverage measure; poor evidence routes sources to needs_review.
Neither a GitHub link nor a textual claim establishes an open-source license.

Use review --decision approved, rejected or excellent --reason ... to record preferences.
The optional enrichment step uses prior review signals as a bounded category-specific score
adjustment. It does not train a model or alter anyone's X account.
