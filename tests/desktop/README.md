# Live Obsidian desktop smoke suite

This is a separate, opt-in test harness that launches the genuine Obsidian Desktop
application in an isolated vault, rather than substituting API mocks for the UI.

From the repository root, install and build the plugin:

    npm ci
    npm run package
    npm install --prefix tests/desktop
    npm --prefix tests/desktop test

The runner uses wdio-obsidian-service to download/start Obsidian and open
tests/desktop/vault. The CI job prepares an Xvfb display on Linux.
Tests must never use a personal vault or real X credentials.

The smoke checks that the plugin command opens the native sidebar, that
the explicit X For You limitation is visible, that import/diagnostics are
present, and that References.md remains intact. Full device-level
acceptance still requires permission to install/test on the user's actual machine.
