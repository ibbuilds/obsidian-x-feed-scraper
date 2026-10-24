# Extension execution isolation: design and release boundary

## Decision

**This release supports explicitly trusted local extensions and trusted MCP executables only. It does not sandbox third-party code.** This document completes the isolation-design task in the project handoff; it does not implement or activate a restricted execution mode.

The next execution boundary should be a supervised process with a small serialized protocol. A separate process can improve failure recovery, but admitting untrusted code additionally requires enforced operating-system restrictions and a narrowly scoped I/O broker. Until those restrictions have passed the platform acceptance cases below, the trust requirement remains unchanged.

## Threat model

The assets are the local SQLite database and its human review/history, vault contents, provider credentials, the collector API token, other account-accessible files, and the availability of the collector and desktop application. Information explicitly given to an extension is also an asset: containment cannot make a malicious source truthful or retract data it has already received.

Threats include a compromised extension or dependency, an MCP server that spawns persistent children, code that ignores cancellation, excessive output or allocation, unauthorized network access, and data crafted to exploit parsers. Trusted code can also fail accidentally. The current provider authorization rules remain necessary in every execution mode; an isolation mechanism does not grant access to a feed or account.

The proposed boundary assumes the host OS, Node runtime, built-in core and broker are trusted. Protecting against a compromised host, privileged administrator or kernel vulnerability is outside this design. Provider claims and evaluator scores continue to need provenance and human/domain verification even inside a future restricted runner.

## Current controls, checked against the implementation

| Surface | Implemented control | Remaining exposure |
| --- | --- | --- |
| Local `.cjs` extensions | Explicit paths, a maximum of 16 modules, SDK version/function checks, duplicate registration checks | `createRequire` executes module initialization in the collector before registration checks. Code has the collector's process and account access; validation is not admission control for malicious code |
| MCP launch | Explicit executable; absolute path or the current Node executable; argument array and `shell:false` | The executable still has account filesystem/network access and can launch its own processes |
| MCP environment | A selected OS environment plus explicit `passEnv`; collector token is not included by default | `passEnv` can deliberately forward secrets. Home/config paths are available; filtering environment variables does not prevent reading account-accessible files |
| MCP protocol | Selected tool, validated JSON observations, bounded tool discovery and cursors; 4,000,000 total stdout bytes and a 2,000,000-character pending-line limit | These are transport limits, not an OS memory, CPU, disk or network quota |
| MCP lifecycle | Configurable 1,000–120,000 ms timeout, cancellation listener, cleanup after a page, direct-child termination requests | Cleanup does not establish confirmed termination of every descendant; there is no process-tree supervisor or hard resource budget |
| Source data | JSON/schema/length validation and per-page transactions; failed or cancelled pages cannot advance their committed state | Arbitrary in-process code can bypass these functions. Valid JSON can still contain false or sensitive claims |
| Built-in public requests | Public-address checks, DNS pinning, redirect validation, HTTPS downgrade rejection, bounded response and timeout | External code can use its own network APIs instead of this client |
| Built-in Obsidian output | Managed paths, ownership fingerprints and conflicts for edited notes | An external module with filesystem access can write outside the managed output path |

Implementation references: [`extensions.ts`](../packages/core/extensions.ts), [`registry.ts`](../packages/core/registry.ts), [`mcp-stdio.ts`](../packages/adapters/mcp-stdio.ts), [`engine.ts`](../packages/core/engine.ts), [`project-config.ts`](../packages/core/project-config.ts), [`public-http.ts`](../packages/connectors/public-http.ts), and [`vault-safe.ts`](../packages/core/vault-safe.ts). Existing MCP cases in [`mcp-stdio.test.ts`](../tests/mcp-stdio.test.ts) cover successful protocol use, environment scoping and a timeout with a synthetic server; they do not test an OS sandbox escape boundary.

## Process and worker choice

Use a **process boundary** for the proposed extension runner. Keep SQLite handles, the collector API token, raw vault paths and mutation authority in the trusted core. Transfer only the observations/configuration required for one operation, then validate the returned value in the core before committing anything.

Worker threads could help CPU-bound trusted processors, but are not the proposed security boundary. Node documents shared-memory facilities for workers, and worker resource limits cover the JS engine rather than all process memory; global out-of-memory can still abort the process. See the official [Node 22.16 worker documentation](https://nodejs.org/download/release/v22.16.0/docs/api/worker_threads.html#new-workerfilename-options).

A Node child process has its own memory/V8 instance and incurs additional startup and memory cost. Sending a termination signal does not prove exit, and killing a parent does not automatically terminate its children on Linux. A supervisor must observe completion and enforce descendant cleanup through the supported platform backend. See the official [process creation](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#child_processforkmodulepath-args-options) and [termination](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#subprocesskillsignal) documentation.

Node's Permission Model may reduce accidental access by trusted Node code, but Node explicitly excludes protection against malicious code. It cannot be the sole basis for calling a runner safe for untrusted extensions. See [Node 22.16 permissions](https://nodejs.org/download/release/v22.16.0/docs/api/permissions.html#permissions). This repository does not enable that model today.

## Proposed portable boundary

The following is a future design, not a new manifest option or SDK guarantee.

1. **Supervised runner.** Start a process from an explicitly selected extension artifact, with a private working directory, bounded lifetime, minimal environment and controlled stdio. Load the extension only inside that process. Treat initialization as executable code subject to the same restrictions as method calls. Record the artifact/dependency digest and execution-policy revision for reproducibility; a digest identifies bytes, not trustworthiness.
2. **Versioned request/response protocol.** Send an operation identifier, request/run identity, scoped configuration and JSON input. Return JSON drafts/assessments/pages or typed errors. Bound frame size, nesting, item counts, concurrent requests and total response volume before retaining payloads. Do not transfer database connections, executable functions, arbitrary host handles or the collector's environment. Late responses after cancellation are discarded.
3. **Trusted core owns persistence.** The core validates every response, applies the selected project policy and commits a complete page with its cursor. Crashes, deadline expiry or malformed responses keep the last committed checkpoint. Existing reviews remain separate. A runner must not choose another project's identity or invoke review mutations through its protocol.
4. **Brokered capabilities.** A future restricted source requests narrowly scoped operations from a trusted broker: authorized public fetches, explicit provider operations or access to a particular staged input. The broker applies destination, redirect, payload and rate rules itself. Provider secrets stay with the broker where feasible and are never returned in generic errors. Granting an operation must not grant a general-purpose HTTP proxy, arbitrary shell, arbitrary path or database access.
5. **OS enforcement.** A platform backend must prevent direct access that would bypass the broker: unrelated files, vault/database paths, account secrets, network sockets, process inspection and unauthorized child execution. Required scratch locations and runtime dependencies must be explicitly provisioned. Descendants inherit the restrictions and cleanup responsibility. No specific Linux, macOS or Windows enforcement implementation has been selected or validated here.
6. **Outputs need a separate contract.** The current `OutputAdapter` receives `databasePath` and sometimes `vaultPath`; arbitrary extension output code is trusted today. A future restricted output should propose constrained render/write/delivery intents for the trusted host to validate and perform, or receive explicitly scoped staged files. Moving the existing output API into a subprocess unchanged would not remove its filesystem authority.

Pure processors/evaluators can be the first process-runner migration because their declared SDK inputs and outputs are data. Sources need explicit I/O capabilities. Outputs need a deliberate API evolution and a compatibility path; existing trusted extensions must not be silently reclassified as restricted.

## Protection and limits

| Risk | Current release | Supervised process only, proposed | Process + broker + verified OS backend, proposed |
| --- | --- | --- | --- |
| Blocking the collector's JavaScript execution | Possible for in-process extensions | Parent can observe and terminate a stuck runner, subject to supervisor implementation | Same, with enforced resource/descendant limits |
| Excessive memory/CPU/disk use | No general hard quota | Separate accounting is possible; a process alone is not a quota | Backend must enforce tested budgets for the process tree |
| Reading vault, SQLite or unrelated files | Available to extension code with account access | Still available unless separately denied | Denied except for explicitly granted/staged resources |
| Unauthorized external or local-network access | Available through an extension's own client | Still available unless separately denied | Direct access denied; broker checks authorized operations |
| Reading an explicitly supplied input or credential | Allowed | Allowed | Still allowed; minimize what is supplied |
| Forged but well-formed observations/evaluations | Possible | Possible | Still possible; provenance, domain checks and human review remain necessary |
| Partial database writes through the normal pipeline | Page transactions protect core writes | Core remains sole writer through the protocol | Same; OS denial also protects against direct runner access |
| OS/runtime compromise | Outside current guarantee | Outside this design | Outside this design |

## Costs and rollout gates

Process startup, serialization and copied payloads add latency and memory use. A per-page runner is simpler to reset; a reusable process reduces startup cost but needs explicit project separation, cache reset and secret teardown. Benchmark both against the existing bounded page sizes before choosing a default. Do not invent an overhead percentage or memory budget without measurements on supported machines.

Compatibility costs include extensions with module-global state, native dependencies, filesystem assumptions, long-lived provider sessions and output code that expects full database/vault access. Staging data and brokering requests also need explicit retention and failure semantics. Platform enforcement can add installation/packaging requirements; availability must be detected and surfaced before execution.

Roll out in independently reviewable stages:

- **Failure isolation for trusted code:** implement the protocol/supervisor and retain the trusted-only label. Verify initialization failure, crashes, cancellation, deadlines and bounded output without changing entity identities or transaction behavior.
- **Capability contract:** define input/output operations and resource ownership, including provider-secret handling and output intents. Test rejection of requests outside the granted project/resources.
- **OS backend per platform:** implement and test actual denials and process-tree lifecycle on each supported platform. An unsupported platform must fail closed when restricted execution is requested; do not silently fall back to unrestricted execution under the same label.
- **Restricted execution release decision:** require evidence for the selected threat model, independent review and a published support matrix. Only then consider supporting code that has not been individually trusted. This stage is not part of the current release.

## Verifiable acceptance plan

Use synthetic vaults, temporary databases, local test services and sentinel secrets created for tests. Do not use a personal vault or live provider credentials as attack fixtures.

| Scenario | Required observable result for a future restricted backend |
| --- | --- |
| Initialization loops, runtime loops, crashes or ignored cancellation | Parent remains responsive; supervisor confirms exit of the restricted process tree; no uncommitted page/cursor/history changes |
| Oversized/nested/malformed protocol messages or endless output | Bounded handling and deterministic failure before unbounded buffering; other projects continue |
| Attempts to read/write database, vault, home/config files or another project's staged input | OS/backend denial verified with sentinels; allowed input access still works |
| Path traversal, symlinks and resource replacement around a granted input/output | Access remains confined to the intended resource; failures do not overwrite unrelated files |
| Direct sockets, loopback/private destinations, DNS changes or redirect changes | Direct escape routes fail; broker enforces destination rules at each request/hop |
| Environment inspection, exception text, stdout/stderr or broker-error leakage | Undelegated sentinel secrets never appear in runner inputs or retained logs; supplied data is explicitly accounted for |
| Child/grandchild launch and outliving the parent | Execution is denied when not granted; permitted descendants stay restricted and are confirmed gone after shutdown |
| Budget exhaustion, restarts and repeated retries | Limits apply to the whole process tree; checkpoints/reviews remain intact; retries do not duplicate committed state |
| Identical valid source fixture through trusted and restricted paths | Same accepted observations/entities/reviews under the same policy; execution isolation does not alter identity or imply stronger evidence |

Run these cases on every platform claimed by a future restricted mode. Passing the existing Linux/macOS/Windows package tests or isolated Obsidian Desktop tests does not satisfy this new enforcement matrix. The current release remains a trusted-code integration with the controls listed above.
