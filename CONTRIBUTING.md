# Contributing

Requires Node.js 22.16 or later. Start with npm ci, npm run check, npm run package and npm test. GitHub Actions additionally runs real Obsidian Desktop tests in an isolated vault.

Do not commit credentials, browser cookies, session exports, private vault files, or user-specific data.
Use synthetic fixtures for tests. A new connector needs a documented permission model and
must not silently claim to represent X's personalized "For you" feed.

Prefer narrowly scoped PRs. New scoring signals need clear evidence, confidence thresholds and
regression tests. Rejected sources and user-edited notes must remain recoverable.
