# Using an existing MCP server as a Discovery Engine source

**Discovery Engine can consume observations from an explicitly trusted local MCP server without requiring the author to fork or modify the engine.** This is a source adapter, not autonomous permission to access private third-party accounts.

The built-in `mcp-stdio` adapter supports standard local MCP **stdio**, with automatic detection of the 2026-07-28 stateless discovery protocol and fallback to 2025-era `initialize`. It does **not** currently implement Streamable HTTP or remote MCP OAuth. Prefer a separate adapter if your integration requires those.

## 1. Choose the MCP tool to poll

The MCP server must expose a tool, through `tools/list`, that returns a bounded, repeatable batch of observations. Discovery Engine calls exactly the user-selected tool through `tools/call`, with a `limit` and optional opaque `cursor`.

The tool's result must provide a page of source records, an explicit `hasMore` boolean and `nextCursor` if more pages exist. Each item needs a stable ID and type. The engine persists the page and its cursor together in SQLite, then sends the returned cursor on the next call.

If your MCP server only offers interactive search or detail tools, you must either create a listing tool, supply a declarative result mapping where possible or implement a purpose-built source adapter. **MCP connectivity alone does not imply that an authenticated recommendation feed is available.**

## 2. Sample manifest

The repository includes a runnable synthetic server and project:

    npm ci
    npm run cli -- project sync --project examples/mcp/project.json --db ./data/mcp-test.db
    npm run cli -- project entities --id mcp-lab-research --db ./data/mcp-test.db

Its source configuration is similar to:

    {
      "id": "trusted-lab-server",
      "adapter": "mcp-stdio",
      "config": {
        "command": "node",
        "args": ["./trusted-server.cjs"],
        "tool": "list_records",
        "protocol": "auto",
        "arguments": {"topic": "scientific-research"},
        "cursorArgument": "cursor",
        "limitArgument": "limit",
        "timeoutMs": 30000,
        "passEnv": []
      }
    }

Relative script paths in `args` (beginning with `./` or `../`) are resolved relative to the project manifest. `command` must be an absolute executable path or the special value `node` (the currently running trusted Node executable). No shell is used and nothing is installed or downloaded automatically.

`protocol` may be `auto` (default), `modern` (2026-07-28 only) or `legacy` (2025-era initialize only). In auto mode, the client probes `server/discover` before falling back to `initialize`. Stdio messages are newline-delimited JSON-RPC. The child process is stopped after each page, and source timeouts/size limits are enforced.

## 3. Tool result format

The simplest compatible MCP tool returns the following object directly in `structuredContent` or as JSON-encoded `content[].text`:

    {
      "observations": [
        {
          "id": "event-123",
          "type": "research-event",
          "title": "New experiment",
          "text": "Scientific observations and context",
          "url": "https://example.org/research/123",
          "attributes": {"laboratory": "Example"}
        }
      ],
      "hasMore": false,
      "nextCursor": "end"
    }

For a continuation page, return `hasMore:true` and a nonempty `nextCursor`. The engine passes this cursor through unchanged. Stable observation IDs prevent duplicates across repeated collections.

**Never return session tokens, browser cookies or private authorization material as observation attributes.**

## 4. Adapting a tool with a different result shape

Many existing MCP servers return provider-specific JSON instead of standardized observations. You can configure `mapping` in the MCP source without writing an extension:

    "mapping": {
      "itemsPath": "data.rows",
      "idPath": "recordId",
      "type": "incident",
      "titlePath": "headline",
      "textPath": "details",
      "urlPath": "link",
      "hasMorePath": "data.paging.more",
      "nextCursorPath": "data.paging.cursor",
      "attributes": {
        "severity": "priority",
        "provider": "source"
      }
    }

The mapping supports up to eight levels of safe dotted JSON fields and common observation fields, plus selected JSON attributes. It does not execute templates, arbitrary JS or expressions. The engine still validates record types, sizes and URLs after mapping. More complicated transformations belong in a custom `Processor` or `SourceAdapter` from the SDK.

## 5. Privacy and trust

**Configuring an MCP server launches a local executable with your OS user's privileges.** It is an explicitly trusted integration, **not a sandbox**. Use only server code and tools whose permissions you understand.

Discovery Engine does not forward its own local API bearer token to the child. The MCP subprocess starts with a minimal OS environment (for example `PATH` and `HOME`), not the full inherited environment. If the MCP server requires a specific environment variable, list its **name** in `passEnv`; its value will then be forwarded from the operating-system environment. Never place actual secret values in a project JSON file or a synced vault.

Only one named MCP tool is invoked. Other server-exposed tools are not called. However, a malicious or buggy **server process** can still perform arbitrary actions with its OS permissions; selecting a read-only tool cannot sandbox the process itself.

Limits: up to 500 observations per source page (the project engine may impose a lower limit), 4 MB total JSON-RPC output per subprocess, a configurable 1–120 second process timeout and ten tool-discovery pages. Failed collection leaves the last successfully committed cursor unchanged.

## 6. What this does **not** solve about X

An MCP server that retrieves authorized bookmarked posts, public user timelines or generic search results does not automatically supply the same personalized ranking as the account's **For You** tab. An account-specific For You connector remains blocked until its supported source and permissions can be demonstrated.

For the details, see [the tracked provider issue](https://github.com/ibbuilds/obsidian-x-feed-scraper/issues/2). Never paste an X session cookie or account password into Discovery Engine project configuration.
