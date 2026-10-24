# Upgrading from X Feed Scraper v0.4 to Discovery Engine v0.5

This release migrates the **data model** without destructive replacement. It is safe to keep an existing v0.4 installation when upgrading, but back up the vault and local SQLite directory before major version transitions.

## Installation compatibility

- The public name becomes **Discovery Engine**, but its Obsidian `manifest.id` remains `x-feed-scraper`. Continue using `.obsidian/plugins/x-feed-scraper/`; do not create a second plugin directory.
- The standard installer remains `main.js`, `manifest.json` and `styles.css`, with the collector embedded in `main.js`.
- The default local SQLite path stays `~/.x-feed-scraper/<vault-hash>/library.db`. No user data is moved into a synced vault.
- Existing `X Feed Scraper/` generated files, custom settings, original observations and `References.md` are **not deleted or replaced**.
- The legacy RSS/manual review and explicit backed-up References.md append workflow remains accessible in its labeled legacy section.

## Additive database migration

When the new KnowledgeStore opens an existing library, it creates separate `kb_*` tables for projects, connections, observations, entities, mentions, assessments, reviews, checkpoints and runs. It creates historical project `legacy-x-feed` and maps:

| Existing v0.4 table | New generic representation |
| --- | --- |
| `posts` | `kb_observations` with original connector-specific IDs |
| `sources` | `kb_entities` of type `web-resource` |
| `post_sources` | `kb_mentions` connecting originals to resources |
| `reviews` and source status | `kb_reviews`; recorded approvals/rejections preserved |
| quality scores and reasons | `kb_assessments` marked as legacy heuristic |

All existing tables remain in place; importing existing rows is idempotent. Opening the database repeatedly does not duplicate sources or reviews. Newly imported projects and legacy records do not share scoring, identity or review state unless explicitly designed to.

The old `References.md` remains untouched by the generic pipeline. New project notes are created in project-specific paths under `Discovery Engine/<project-id>/`, and only machine-generated notes with tracked content fingerprints can be automatically refreshed.

## Upgrade procedure

1. Copy or back up the whole vault and the existing local `~/.x-feed-scraper/` directory while Obsidian is closed.
2. Replace the three files in the existing `x-feed-scraper` plugin directory with the new release.
3. Enable the same plugin. Its original settings are retained; the legacy data is available as before.
4. Open the new **Knowledge projects** panel, or run `npm run cli -- project list --db /path/to/library.db` to inspect historical import.
5. Create a separate JSON project manifest, choose the appropriate source adapter/pipeline and specify it in plugin Settings. Restart the collector.
6. Test against a backup or test vault before allowing any output adapter to operate on your primary vault.
7. Verify your existing `References.md` records, old approvals and candidate notes are still present.

## Rollback considerations

Because migration only adds tables, the old v0.4 binary can still read its original SQLite tables and notes. **However, old versions do not understand new generic projects, decisions or exports.** Reverting the code does not convert new project entities into the legacy structure. Use the backup to recover exact pre-migration state when necessary.

Do not point two collectors at the same SQLite file concurrently. The engine uses a durable per-database lock for ingest/export and runs checkpoints atomically, but different engine versions may have incompatible long-term expectations.

## Non-migrated functionality

A provider-authorized connector for the real X personalized "For You" feed is **not included**. Migrating the database does not make a nonexistent authorized source available. The original feed blocker remains in `docs/x-access.md`.

Obsidian Desktop tests use an isolated synthetic vault; an existing user's vault and their connected MCP need separate owner-device validation.
