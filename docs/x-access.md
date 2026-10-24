# X "For you" provider feasibility (2026-10-23)

**Status: BLOCKED / NOT INTEGRATED.** No actual user feed was accessed in development.

- The official timeline documentation describes the home endpoint as reverse chronological, from followed accounts, and explicitly excludes algorithmic ranking. It is not the personalized ranked "For you" feed.
- X also documents an official hosted MCP endpoint through its `xurl mcp` bridge. Its listed API capabilities include search, users/timelines, bookmarks, trends and Articles. That transport does not establish access to personalized For You ranking.
- Billing, scopes and permitted usage depend on the concrete provider/endpoint selected; the engine does not silently purchase or enable API access.
- A user OAuth token is not supplied, nor have provider permissions been verified.
- We do not use undocumented APIs, authenticated browser session extraction, CAPTCHA bypass,
  anti-bot evasion, automated likes, or automated follows.
- Existing browser-based MCP implementations are not treated as proof of authorization.
- Currently supported independent inputs include permitted public RSS/Atom, JSON snapshots/APIs, public Product/Offer pages, user-provided observations and trusted MCP tools. None are equivalent to personalized For You results. An authorized connector can implement the generic SourceAdapter/Observation contract once the true feed is accessible.
- The feed is dynamic: future integrations should log observations, not promise full coverage.

Official sources:
- https://docs.x.com/x-api/posts/timelines/introduction
- https://docs.x.com/tools/mcp
- https://docs.x.com/x-api/introduction
- https://docs.x.com/x-api/getting-started/pricing
- https://docs.x.com/developer-terms/agreement
- https://help.x.com/en/rules-and-policies/x-automation

Verification still required: the user's permission to access personalized recommendations,
the endpoint's availability, actual billing and limits, and a successful local end-to-end read
without disclosing account secrets to ChatGPT.
