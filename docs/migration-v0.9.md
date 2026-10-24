# Upgrade from Discovery Engine 0.8 to 0.9

Install the new three-file plugin over the previous installation under `.obsidian/plugins/x-feed-scraper/` after backing up the vault and local SQLite database. The plugin ID, database location, existing entity keys and source cursors remain compatible. All database migrations are additive and idempotent; earlier source/entity versions and review decisions are retained.

## Faithful observation replay

New collection stores the complete validated observation and the original entity draft for each mention. Offline reevaluation receives the source URL list, timestamp, attributes and extraction evidence used during collection instead of a reduced reconstruction. The current observation timestamp is refreshed along with the rest of the payload.

For an older database, the latest immutable observation revision supplies missing replay data when it exists. Rows that predate those revisions can only reuse fields that were actually saved. Migration never invents missing URLs, historical drafts or old source events. Recollecting an authorized source fills its current replay data; the old history remains intact.

Current assessments are retained per mention. The entity's displayed assessment comes from one current assessment, including its score, confidence, reasons and evaluator identity; it is no longer a combination of historical maxima. If previously relevant evidence becomes excluded, the automatic score can decrease. Human approval or rejection remains a separate decision. Legacy aggregate assessments are preserved during migration; run `project reprocess` to establish current evaluations for all retained mentions.

If an actually received update to the same observation stops extracting entity A and instead extracts B, the old A mention remains historical and its earlier assessment stops contributing to A's current score. A with no remaining active assessment becomes unassessed (score/confidence zero), retaining its attributes, versions and human review. This does not mark A closed or deleted. A record merely absent from a later source snapshot is not changed or deactivated. The source-evidence panel distinguishes historical and current mentions.

## Stable entity namespaces

Existing `observation-entity` projects keep keys such as `job-listing:123`. To combine providers that have overlapping local IDs, give each source a stable `config.entityNamespace`:

```json
{
  "id": "board-one",
  "adapter": "json-snapshot",
  "config": {
    "path": "./board-one.json",
    "entityNamespace": "employer-one"
  }
}
```

The corresponding key is `@employer-one:job-listing:123`. A second provider can use `employer-two`; two sources should share a namespace only when they intentionally describe the same identity domain. Namespace values are lowercase identifiers with 2–64 characters, using letters, numbers, hyphens or underscores and starting with a letter.

The first-run wizard uses a namespace for new observation-entity projects. Existing manifests are not rewritten. A legacy key encountered from two different connections is rejected instead of silently combining unrelated entities. Configure a new connection/project or a reviewed migration; existing reviews must not be copied onto newly identified records by guessing.

Source configuration fingerprints include the namespace. Changing it behind a used connection is rejected, just like replacing that connection's dataset. Use a new connection ID for an intentional change. Existing generated notes retain their old identity and are still protected against overwriting manual edits.

## Keyword policies

Policy terms are trimmed and deduplicated without regard to letter case. A blank or whitespace-only term is invalid; it is not silently changed into an unrestricted policy. An intentionally empty list still means no positive filter. Repeated variants such as `React`, `react` and ` React ` count once.

Projects that previously relied on duplicate words to increase a score must revise their criteria. Keyword scores remain heuristic, and a declared license remains a source claim until independently verified.

## Optional external delivery

Existing projects do not acquire a network output during upgrade. Add and explicitly enable a `webhook` output only for a receiver you intend to send alerts to; see [Webhook delivery](webhooks.md). The ledger begins at the first enabled export by default, excluding older alerts. `includeExisting:true` explicitly requests historical delivery.

Changing a configured receiver requires a new output ID. Successfully delivered records are not resent on ordinary retries. A receiver must honor the stable idempotency key to avoid duplicates if a response or local acknowledgement is lost.
