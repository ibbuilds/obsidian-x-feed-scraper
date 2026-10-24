# Data monitoring: reusable price, job and change-tracking pipelines

Discovery Engine now stores **immutable versions of source observations and structured entities**. Each time a collector sees the same stable entity key, the engine compares its normalized attributes with the last recorded state, persists changes and optionally evaluates declarative watch rules. This is generic infrastructure; no price or hiring concepts are hardcoded into the SQLite engine.

## What is actually supported

- **Price monitoring**: compare numeric `attributes.price` values for an identified product and record price history. The built-in public-product adapter reads one unambiguous Schema.org `Product` + `Offer` from a public HTTPS HTML page. Alternatively use a JSON API, a local observation snapshot or an independently implemented connector.
- **Job discovery**: read job objects from an authorized public JSON API (example: Greenhouse's GET Job Board API) or a user-created connector; track new listings, updated location or actual status values when the provider supplies them.
- **Any other entity type**: watch nested JSON fields such as stock availability, security severity, documentation version or project activity using the same engine.
- **Manual review and auditability**: all field changes, original observation revisions, assessment history and optional watch alerts stay in SQLite. Existing human approvals remain separate.

**Not supported or implied:** universal scraping of arbitrary websites, credentials, bypassing anti-bot systems, legal access to every source, automatic semantic reasoning about every field, or delivery of SMS/email/push notifications. Rules currently create **locally queryable watch alerts**, visible in the Obsidian sidebar and CLI. Notifications require an explicit output adapter.

## Test the working offline price monitor

Use a *copy* of the example so you do not modify tracked repository fixtures:

    cp -R examples/price-monitor /tmp/discovery-price-demo
    npm run cli -- project sync --project /tmp/discovery-price-demo/project.json --db /tmp/discovery-price-demo/library.db
    npm run cli -- project alerts --id price-monitor-demo --db /tmp/discovery-price-demo/library.db
    cp /tmp/discovery-price-demo/snapshot-updated.json /tmp/discovery-price-demo/snapshot.json
    npm run cli -- project sync --project /tmp/discovery-price-demo/project.json --db /tmp/discovery-price-demo/library.db
    npm run cli -- project changes --id price-monitor-demo --db /tmp/discovery-price-demo/library.db
    npm run cli -- project alerts --id price-monitor-demo --db /tmp/discovery-price-demo/library.db

The sample has two synthetic products. The second snapshot changes one price from USD 129.99 to USD 99.99. The engine records the numeric field change and the configured ≥10% price-decrease rule matches. Repeatedly collecting the unchanged file creates **no duplicate change events**. A change of currency suppresses the comparison rule, because numbers in different currencies are not directly comparable.

Equivalent exercise for `examples/job-radar/project.json` and its two snapshots: discover a new listing, observe an explicit status change, and detect an updated location. **Disappearance from the returned set is not proof that a job closed.**

On Windows, copy the two example folders using Explorer or PowerShell instead of `cp -R`.

## Connect to real public sources

### Public Greenhouse job boards (GET only)

Greenhouse documents that its Job Board GET endpoints return published positions as JSON without requiring authentication. A board exposes:

`https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs`

Use the template `examples/job-radar/greenhouse-template.json` and replace the placeholder board token with one from a public employer board you are permitted to monitor. Its `public-json` adapter maps `jobs[].id` into stable job IDs, title, public URL, location and updatedAt. It tracks **new IDs** and changed `updated_at` values. It does not infer salaries, employment status or closing dates absent from the API.

See the [official Greenhouse Job Board API documentation](https://docs.greenhouse.io/job-board).

The generic `public-json` adapter accepts a user-configured **HTTPS GET** endpoint returning `application/json` with a response no greater than 1 MB and up to 10,000 mapped items. Field mapping uses the same safe dotted paths as the MCP adapter. Requests use the DNS-pinned SSRF-hardened public HTTP client. Authentication tokens in project URLs are disallowed; use a dedicated authorized adapter for private services.

### Public product pages with Schema.org

The template `examples/price-monitor/public-product-template.json` accepts a list of 1–100 HTTPS product URLs.

The `public-product` adapter downloads public HTML (up to 1 MB per page), searches for JSON-LD Schema.org `Product` and a single unambiguous `Offer` with a numeric price and ISO currency, and records price, currency, availability and SKU when published. It processes at most five pages per API call and each finished collection revisits the configured pages at the next scheduled run.

This **does not** scrape arbitrary visual price labels, execute JavaScript, support logins, reconcile arbitrary variants or guarantee a merchant's displayed price matches the structured data. A page without supported structured data returns an explicit failure rather than an invented price.

See [Schema.org Product offer price](https://schema.org/price). Respect each source's published terms, robots controls, permission boundaries and rate limits.

## Configuring change rules

Use the project's optional `watch.rules` array. Each rule has a unique ID, a JSON pointer to a monitored field and an operator:

- `created`, with path `$`: first time an entity is observed
- `changed`, with path `/attributes/status`, for instance: a field was added, removed or changed
- `equals`, with path `/attributes/status` and `value:"closed"`: a source explicitly reported that state
- `decrease-percent` / `increase-percent`: numeric old and new values with `threshold` in (0,100]
- `requireUnchanged`: optional pointers that must not change between snapshots, e.g. `/attributes/currency` when comparing prices

Example:

    "watch": {
      "rules": [
        {"id":"new-product","operator":"created","path":"$"},
        {
          "id":"price-down-10",
          "operator":"decrease-percent",
          "path":"/attributes/price",
          "threshold":10,
          "requireUnchanged":["/attributes/currency"]
        }
      ]
    }

The guided Obsidian project wizard supports common alert types. An advanced JSON manifest can define multiple watch rules. Changes are persisted **even without** configured rules, but alerts are generated only for matching rules during ingestion; creating a new rule later does not invent alerts for historical events.

## Durable state and guarantees

- `kb_observation_versions` retains distinct original observation revisions, including source attributes.
- `kb_entity_versions` retains each distinct entity snapshot. Pre-v0.8 knowledge gets a baseline without fabricating historical events.
- `kb_entity_changes` stores each changed field with previous/new JSON and the source that revealed it.
- `kb_watch_alerts` records matching rules with explanations; creation events are distinguished from updates.
- Every state change, corresponding alert, and next source cursor are written atomically in the existing SQLite transaction. Failed pages do not advance the cursor.
- Reprocessing relevance rules is separate and **does not** fabricate new source changes or clear human reviews.
- Repeated unchanged snapshots are idempotent.

To inspect from the CLI:

    npm run cli -- project changes --id price-monitor-demo --db /path/to/library.db
    npm run cli -- project alerts --id price-monitor-demo --db /path/to/library.db
    npm run cli -- project versions --id price-monitor-demo --key product:price-100 --db /path/to/library.db

The authenticated loopback API also exposes GET `/project/changes`, `/project/alerts` and `/project/versions`. In Obsidian, expand **Monitoring** in the active project sidebar.

The source does not report deletions, closure or unavailability unless an adapter returns explicit evidence. Record identity must remain stable across runs; developers should include merchant/site in product identity when equivalent SKUs occur across unrelated stores. An alert is a verified **change in collected source data**, not independent verification that the underlying claim is correct.
