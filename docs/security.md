# Security and privacy

## Local processing

The plugin creates a random session-only API token and starts its child collector on a 127.0.0.1 ephemeral port. Every request requires the token and browser Origin requests are rejected. The token is held in memory and passed only to the child process environment; it is not stored in plugin settings, Markdown files or logs.

The plugin does not read browser cookies or sessions, send X passwords to ChatGPT, invoke unofficial X automation, generate likes/follows, collect private information remotely or transmit telemetry. The X For You feed remains blocked.

SQLite stays outside the synced vault under the local home directory. Structured notes, Bases and reports are written inside the vault. Generated notes are written with tracked SHA-256 fingerprints. The exporter updates only files whose bytes still match the last generated version; unknown or manually edited files stay untouched with conflict paths reported. The exporter, source reviews, and ingestion share a process lock. A user-approved reference can enter References.md only after a backup, duplicate check and atomic Obsidian Vault.process operation.

## External input

The RSS connector is opt-in and only supports user-selected public feeds. The network client validates each redirect, pins DNS resolution, rejects private/loopback/documentation IP ranges, verifies TLS, limits sizes/time, and blocks X hosts. XML DTDs and custom entity definitions are rejected; feed/post text is treated as untrusted data and is never executed.

Optional public page metadata retrieval occurs only on a manual request or after the user explicitly enables automatic enrichment. Each automatic cycle examines up to 10 sources, with persisted cooldowns and at most 3 automatic retries per source; it does not confirm that a site is free, open source, visually excellent, accessible or trustworthy.

## Risks and operational requirements

- Install Node.js 22.16+ from a trusted source; keep the OS, Obsidian and its community plugins updated.
- Do not paste access tokens into public feed URLs, project profiles or manual fixture files.
- A website may change between evaluations and human review is necessary for curation.
- Local platform-specific Obsidian runtime validation remains necessary.
- Do not expose the local API outside loopback or bypass social-platform access restrictions.
