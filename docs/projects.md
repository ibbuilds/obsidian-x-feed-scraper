# Generic projects and automated research

A **project** is a repeatable information-processing task. It can ingest from any registered authorized source, produce typed entities, preserve evidence and use project-specific evaluation criteria. Nothing in the public project contract assumes X, news, software projects or Obsidian.

## Manifest and isolation

See `examples/frontend/project.json`, `examples/security/project.json` and `examples/tickets/project.json`. The first two operate on the **same observations** but define different entities and criteria. All three are covered by tests.

    {
      "id": "frontend-discovery",
      "name": "Frontend Resource Discovery",
      "sources": [{
        "id": "shared-observations",
        "adapter": "json-file",
        "config": {"path": "../shared/observations.json"}
      }],
      "pipeline": ["extract-links"],
      "evaluator": "keyword",
      "policy": {
        "includeKeywords": ["react", "motion", "interface"],
        "excludeKeywords": ["sponsored"],
        "minimumScore": 25
      },
      "outputs": [{"id":"vault","adapter":"obsidian",
        "config":{"folder":"Discovery Engine"}}]
    }

Projects isolate entities, assessments, reviews, connections and checkpoints by project ID. A **connection ID and configuration fingerprint** define source identity. Changing the source configuration while reusing a checkpoint is rejected to prevent mixing unrelated datasets. Create a new connection ID for a genuinely new dataset.

## Source adapters

- `json-file` reads a JSON observation array and advances a persisted cursor through it; paths are relative to the manifest.
- `rss` fetches public user-authorized RSS/Atom feeds via the SSRF-hardened network client and rechecks the currently exposed feed entries on every run (the source returns at most 50 entries per fetch).
- `mcp-stdio` calls one selected tool on a trusted local MCP server with automatic modern/legacy negotiation, page cursors and optional declarative response mappings. See `docs/mcp-stdio.md`.
- Custom sources are user-provided extensions; `examples/extensions/tickets.cjs` demonstrates this without any core changes.

Each observation has a stable ID and type plus optional title, text, URL, linked URLs, images, timestamp and JSON attributes. Records do **not** need web URLs.

## Processors and evaluation

- `extract-links` creates web-resource entities from original and linked URLs.
- `linked-resources` excludes the observation's original URL, treating posts as discovery leads instead of automatically storing the post itself as a resource.
- `observation-entity` turns arbitrary non-web observations into structured entities.
- `public-metadata` is **explicit opt-in**: adding it to the pipeline fetches public titles/descriptions/license evidence through the hardened HTTP client, with a limit of 20 requests per run. Private addresses and X-host automation are blocked.

    "pipeline": ["linked-resources", "public-metadata"]

The `keyword` evaluator uses per-project inclusion/exclusion criteria and public evidence. It emits a score (0–100), confidence (0–1) and reasons, but it cannot establish aesthetic excellence or accessibility. Automated reassessment never overrides independently stored human decisions.

Entity schemas are optional manifest rules that type-check JSON attributes (`string`, `number` or `boolean`, with optional required fields). Custom processors and evaluators can be registered via the public SDK.

## Commands

    npm run cli -- project help
    npm run cli -- project sync --project examples/frontend/project.json --db ./data/discovery.db --page-size 100 --max-pages 100
    npm run cli -- project list --db ./data/discovery.db
    npm run cli -- project entities --id frontend-discovery --db ./data/discovery.db
    npm run cli -- project review --id frontend-discovery --key "https://example.org/tool" --decision approved --reason "Verified"
    npm run cli -- project reprocess --project examples/frontend/project.json --db ./data/discovery.db
    npm run cli -- project export --project examples/frontend/project.json --db ./data/discovery.db --vault /path/to/test-vault

`reprocess` reevaluates persisted observations without querying any connector. To intentionally reset an unchanged source's cursor:

    npm run cli -- project reset-cursor --id frontend-discovery --connection shared-observations --db ./data/discovery.db

## Scheduler, CLI and Obsidian

In Obsidian, set a manifest path in **Discovery Engine → Settings → Research project manifest**, restart the collector and use the project dashboard to run, review and export. Configure the interval (minimum 15 minutes for projects); it runs immediately after service startup and then on its interval while the collector is active (unless paused). Without Obsidian, the CLI can be supervised by your OS scheduler.

A shared SQLite database can host many separate projects. The Obsidian UI configures one active project at a time and displays the library; the CLI can execute any number of manifests.

## Local API

The managed service listens on 127.0.0.1 with an in-memory bearer token. Project endpoints include:

- GET `/projects`; `/project/entities?project=...&limit=...&offset=...`; `/project/runs`; `/project/observations`
- POST `/project/sync`, `/project/reprocess`, `/project/export`
- POST `/project/review`, JSON body `{"projectId":"...","key":"...","decision":"approved","reason":"..."}`

Existing legacy endpoints remain for backward compatibility. **No project API request automatically appends to References.md**.

## Reliability and limitations

The engine commits each processed source page and its next cursor in one transaction. A failed page leaves its cursor unchanged; a restarted run resumes. Data and reports for other sources remain intact. A source run reports failures instead of claiming complete collection, and limit caps prevent endless pagination.

A connector can only fetch content it has permission and technical ability to access. Do not store login credentials in synced project manifests. Extensions run trusted local code with normal OS permissions; they are not sandboxed.

## Guided creation from Obsidian

End users can create a complete, schema-validated project without writing a JSON manifest. The **Create research project** wizard supports a built-in offline demo, public RSS, local JSON and trusted MCP stdio, with project-specific interest terms, extraction mode, optional public metadata and schedule. The resulting manifest is written to a private per-vault local data directory; its original source connection configuration remains immutable to protect persisted cursors. Developers can still create advanced projects using JSON and the SDK. See `docs/first-run.md`.
