# First-run setup in Obsidian

Discovery Engine includes a native **Create research project** wizard. You do not have to clone the repository, write a JSON manifest or set up a separate Node service to test the generic engine.

## Start with the offline example

1. Install the current tested plugin ZIP under the existing `x-feed-scraper` plugin folder.
2. Verify Obsidian Desktop 1.9.2+, the Bases core plugin and Node.js 22.16+.
3. Open Discovery Engine from the ribbon and choose **Create research project**.
4. Keep **Built-in offline demo** selected and click **Create & run project**.
5. The plugin creates three explicitly synthetic observations, deduplicates the resource shared by two of them, stores the observations and its entity in SQLite, and exports a new project folder containing typed Markdown and an Obsidian Base.
6. Open **Sources, evidence and review history** to inspect the original observations and score evidence. Approvals and rejections are stored independently from automatic scoring.

The sample deliberately does **not** contact X or any other website. It is a self-test for project configuration, collection, deduplication, persistence, scoring and Obsidian output.

## Configure an authorized source instead

The same wizard also offers:

- **Public RSS/Atom**: enter a feed URL you may access. The original entry URL is eligible as a resource; optionally enable public metadata enrichment if you consent to external HTTP requests.
- **Local JSON observations**: enter the absolute path to a JSON array. Choose *Monitor local JSON changes* to re-read the same stable IDs every run; append-only JSON ingests only new records. This supports records without URLs.
- **Public JSON API**: enter an authorized HTTPS GET endpoint and a JSON field mapping (for example public job listings).
- **Public product pages**: enter 1–100 authorized HTTPS product page URLs containing unambiguous Schema.org Product and Offer structured data; arbitrary visual price labels are not supported.
- **Trusted local MCP server**: choose the local executable (`node` or an absolute path), enter command arguments as a JSON array, specify the exact listing tool, and optionally provide the declarative JSON field mapping described in [MCP setup](mcp-stdio.md). The server **must** already exist locally and expose a legally accessible source.

Choose project-specific keywords, exclusions, entity-extraction mode, minimum output score, optional monitored-field alert rules and an interval. An interval of **0** means manual collection. **15–1440 minutes** enables automatic collection on startup and periodically while the collector runs. A newly scheduled project starts without an extra Sync click.

## Storage and privacy

Wizard-created projects are stored in the per-vault local data directory:

`~/.x-feed-scraper/<vault-hash>/projects/<project-id>.json`

This is **outside** the synced vault. New directories use private permissions where supported, and manifests are create-only. The wizard does not overwrite another project's manifest and does not silently inherit third-party executable extensions. External MCP code runs under the current OS user and is **not sandboxed**.

The existing `References.md` remains untouched by generic collection and export. Generated project notes are updated only when their fingerprint confirms they are still machine-generated. Personal edits are preserved and surfaced as conflicts. The earlier X-focused workflow remains available in the collapsed **Legacy X Feed Scraper tools** area.

The project switcher lets you activate other projects created with the wizard. Their SQLite records remain isolated.

## Common problems

- **Collector cannot start:** set the absolute Node.js executable path in plugin Settings and restart.
- **Empty project:** inspect its source and configured keywords, verify the selected adapter, and review **Project run history**. The demo does not require network connectivity.
- **MCP tool unavailable:** verify the MCP server is installed *on this computer*, its executable path and tool name, and that it exposes a listing or pagination operation. A ChatGPT-connected MCP is not automatically installed locally.
- **No source authorization:** the engine cannot manufacture access to protected feeds. An MCP that offers bookmarks/search does not imply it offers your personalized X For You recommendations.
- **Source note conflicts:** an edited Markdown note was intentionally preserved; review it manually.

For custom manifest schemas, examples and developer SDK, consult [Projects](projects.md), [SDK](sdk.md), and [MCP integration](mcp-stdio.md).

## Monitor changes between runs

Run the same source project again after the source data changes and expand **Monitoring** in the sidebar. All changed fields are retained in SQLite. Optional watch rules (new entity, specific field changed, numeric increase/decrease, or reaching a value) create locally stored alerts. They do not automatically email, push notifications, or independently verify a merchant price. See `docs/monitoring.md`.
