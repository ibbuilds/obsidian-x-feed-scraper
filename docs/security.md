# Security and privacy

## Local processing

The plugin creates a random session-only API token and starts its child collector on a 127.0.0.1 ephemeral port. Every request requires the token and browser Origin requests are rejected. The token is held in memory and passed only to the child process environment; it is not stored in plugin settings, Markdown files or logs.

The plugin does not read browser cookies or sessions, send X passwords to ChatGPT, invoke unofficial X automation, generate likes/follows, collect private information remotely or transmit telemetry. The X For You feed remains blocked.

SQLite stays outside the synced vault under the local home directory. Structured notes, Bases and reports are written inside the vault. Exported notes are create-only and existing modified notes are protected from overwriting. A user-approved reference can enter References.md only after a backup, duplicate check and atomic Obsidian Vault.process operation.

## External input

The RSS connector is opt-in and only supports user-selected public feeds. The network client validates each redirect, pins DNS resolution, rejects private/loopback/documentation IP ranges, verifies TLS, limits sizes/time, and blocks X hosts. XML DTDs and custom entity definitions are rejected; feed/post text is treated as untrusted data and is never executed.

Optional public page metadata retrieval is user-initiated; it does not confirm that a site is free, open source, visually excellent, accessible or trustworthy.

## Risks and operational requirements

- Install Node.js 22.16+ from a trusted source; keep the OS, Obsidian and its community plugins updated.
- Do not paste access tokens into public feed URLs, project profiles or manual fixture files.
- A website may change between evaluations and human review is necessary for curation.
- Local platform-specific Obsidian runtime validation remains necessary.
- Do not expose the local API outside loopback or bypass social-platform access restrictions.
