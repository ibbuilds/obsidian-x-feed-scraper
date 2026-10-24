# Extension SDK v1

The extension contracts live at `packages/sdk/contracts.ts`. They are independent of Obsidian, SQLite, X, or any specific domain. An extension can provide sources, processors, evaluators and/or outputs without editing the engine.

For a working external implementation, read `examples/extensions/tickets.cjs`.

## Module contract

Explicitly load only trusted local CommonJS modules:

    node dist/source-scraper.mjs run --config examples/tickets/project.json --db ./data/demo.db --extension examples/extensions/tickets.cjs

An extension exports:

    module.exports = {
      apiVersion: 1,
      adapters: [{
        id: "my-source",
        async collect({source,cursor,limit,signal}) {
          return {observations:[],nextCursor:undefined,hasMore:false};
        }
      }],
      processors: [{
        id: "my-processor",
        run(context,observation,previousEntities) {return previousEntities;}
      }],
      evaluators: [{
        id: "my-evaluator",
        assess(context,observation,entity) {
          return {category:"example",score:50,confidence:0.5,reasons:["Configured rule"]};
        }
      }],
      outputs: [{
        id: "my-output",
        export({project,records,config,databasePath,vaultPath}) {return {exported:records.length};}
      }]
    };

Each category is optional. An unsupported `apiVersion`, duplicate identifier or missing required method is rejected. Extension IDs are stable lowercase identifiers.

## Observations

Every item from `SourceAdapter.collect` must have `{id:string,type:string}`. Optional fields are `title`, `text`, `url`, `urls`, `media`, `occurredAt` and JSON `attributes`.

The source adapter owns permissions, authentication, paging and rate limiting. The engine validates each page's size and data, and commits the page and the new opaque cursor in one SQLite transaction. On a failed page, no checkpoint advancement occurs. Stable IDs are scoped to each project connection.

`runProject(..., {signal})` accepts a caller's cancellation signal. Each invocation passes a fresh, linked signal to its adapters, processors and evaluator, so built-in caches last for that execution only. Reusing a caller's signal across projects or scheduled runs does not reuse source data. Adapters should still stop promptly on cancellation; the engine also checks cancellation immediately before committing a page, preserving earlier committed pages while discarding a late result.

An observation does **not** need a URL, and can represent a scientific record, event, ticket, code issue, image reference or anything else a custom processor understands.

## Entity processors

A processor receives its project and source context, one validated observation, and the previously accumulated entity list. It returns candidate entities with `key`, `type`, `title`, optional canonical `url`, JSON `attributes` and optional `evidence` signals.

Multiple observations may refer to the same entity, deduplicated by project and entity key. Per-project optional schemas validate typed fields. Processor pipelines are ordered by the project manifest. The engine sets explicit page and result bounds.

Observation IDs are connection-scoped, but **entity keys must be unique across the project**. The built-in `observation-entity` processor retains `type:id` for existing sources. Set `source.config.entityNamespace` to a stable lowercase identifier to produce `@namespace:type:id`; the wizard does this for new observation-entity projects. Different providers should use different namespaces, while sources describing the same identity domain can intentionally share one. Cross-connection legacy collisions are rejected atomically instead of merging unrelated records. The public JSON/MCP mapping itself still reads provider IDs unchanged. Changing a namespace on an existing connection is rejected by its configuration fingerprint; migrating entity keys requires an explicit plan for reviews and history. See `examples/multi-source-jobs/project.json` and [0.9 migration](migration-v0.9.md).

## Evaluators

Each entity gets an `Assessment` containing category, score [0,100], confidence [0,1] and explanatory reasons. Evaluations are independent of human approvals/rejections; prior human decisions persist across reprocessing.

The built-in keyword evaluator is deterministic and heuristic. Terms are trimmed, deduplicated without regard to case, and rejected when blank. These checks apply to parsed manifests and direct SDK evaluations. You can implement different relevance, classification or local-model evaluators while preserving the same storage, review and output logic.

The engine retains original observation/draft inputs for offline reevaluation. Current per-mention assessments are aggregated by highest score, then confidence and stable source/item IDs. All displayed fields come from the same winning assessment, and a later observation can reduce its score. Historical aggregate values are not attributed to invented legacy mentions during migration.

## Output adapters

An output receives the project, structured `KnowledgeEntity[]`, its own configuration, the database path and optional vault path. `exportProject` also supplies optional `outputId`, preserving compatibility with existing SDK v1 consumers. Outputs that keep per-destination state, such as `webhook`, require this stable configured identity. The base package includes `json`, guarded `obsidian` and explicitly enabled `webhook` alert delivery.

The Obsidian output creates typed Markdown notes and Bases under `Discovery Engine/<project-id>/` by default. It updates only files whose SHA-256 matches the last machine-generated copy; manually edited or unknown files remain untouched and are reported as conflicts.

The webhook output consumes stored watch alerts for eligible records, not arbitrary new notifications on every export. It retains delivery state and stable idempotency keys. See [Webhook delivery](webhooks.md) for configuration, bounded retries and the receiver's deduplication responsibility.

An output may declare `offline:true` when it performs no external network operations. API/Obsidian reevaluation refreshes only such outputs; external or undeclared outputs are reported as skipped until collection or explicit export. Regular exports retain SDK v1 behavior. This declaration is a trusted-extension contract, not an OS network sandbox.

## Security contract

**The current .cjs loader is not a sandbox.** External code executes with the OS user's privileges, including filesystem and network access. A project author must explicitly enable and audit it. There is no remote marketplace, silent extension download or X credential extraction.

Adapters should use provider-authorized interfaces and never persist cookies/credentials into observations. Use scoped secret storage supplied by the OS or provider as appropriate; do not commit or sync credentials in manifest files.

## Testing

CI exercises frontend resource extraction, non-web security/research entities and a separate custom ticket adapter/processor/evaluator. It verifies source cursor recovery after a failed page, project-specific review isolation and additive import from v0.4.0.

This is a source-level SDK. A separately versioned npm SDK package has not been published; the `apiVersion:1` contract is the compatibility boundary for external extensions.

## Bridging existing MCP servers

The built-in `mcp-stdio` source calls an explicitly selected listing tool on a trusted local server. It can map arbitrary provider JSON fields into observations without additional TypeScript code. See `docs/mcp-stdio.md`. A connected MCP does not automatically imply access to private or personalized provider timelines.

## Versioned domain-neutral monitoring

Stable `Observation.id` and `EntityDraft.key` values allow the engine to compare successive snapshots from any adapter. Changes are stored per field in SQLite with original observation provenance. An optional project's `watch.rules` array generates local audit alerts. This is a capability of the generic core, not a product/job-specific SDK extension. Snapshots, source timestamps and availability claims remain the adapter's responsibility. See `docs/monitoring.md`.
