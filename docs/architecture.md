# Obsidian-first architecture

Obsidian desktop UI -> bundled LocalBridge Node child process -> authenticated loopback API -> authorized connector -> posts -> SQLite -> normalized linked resources -> evidence-based scoring -> Markdown and native Bases -> human review -> optional References.md insertion.

The collector can run independently with the CLI when Obsidian is closed. The Obsidian UI is the normal application entrypoint. The standard `main.js` embeds the Node collector and default profile, verifies SHA-256 integrity, materializes versioned local files outside the vault, then launches the collector with a temporary bearer token.

## Persistence and relationships

SQLite records posts (connector ID, original permalink, author, text, observed times), sources (unique normalized URL and quality fields), many-to-many post/source relations, every observed run, checkpoints, errors, reviews and stored pause state. The plugin uses a database under ~/.x-feed-scraper/<vault-hash>/library.db to avoid vault sync conflicts. The standalone CLI database path is separately configurable.

The vault stores only important candidate and approved notes with typed YAML, a Sources.base file and short run reports. References.md remains the existing primary curated library and is never overwritten by the pipeline.

## Connectors and limitations

- Fixture: synthetic tests with no X access.
- Manual: observations explicitly pasted/imported by the user, including any user-provided X post URLs.
- RSS/Atom: user-authorized public feeds, configurable interval and incremental deduplication.
- Personalized X For You: no authorized, verified connector exists in this release.

The core keeps connector-specific logic separate from domain models, scoring and persistence. The initial profile is design; profiles may use other categories.

## Quality

Rules use relevance, public page evidence, explicit licensing and access facts. Score is 0–100; confidence is an independent evidence metric. A high score does not establish aesthetic quality and never auto-approves candidates. Reviews record user decisions, and a bounded category-specific preference adjustment helps prioritize future discoveries.

## File safety

The export creates Markdown notes without replacing pre-existing files, flags conflicts, and removes only byte-identical generated candidates after a separate approved note has been successfully written. References.md writes require explicit action, a timestamped backup and re-validation in Obsidian's atomic Vault.process callback.
