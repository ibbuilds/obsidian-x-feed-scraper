# X "For you" provider feasibility (2026-10-23)

**Status: BLOCKED / NOT INTEGRATED.** No actual user feed was accessed in development.

- Official X API documentation offers post lookup, search, list timelines, and user timelines,
  but none of these is a verified equivalent of the authenticated personalized "For you" feed.
- Official API access is pay-per-use. It does not satisfy the project's no-required-cost goal.
- A user OAuth token is not supplied, nor have provider permissions been verified.
- We do not use undocumented APIs, authenticated browser session extraction, CAPTCHA bypass,
  anti-bot evasion, automated likes, or automated follows.
- Existing browser-based MCP implementations are not treated as proof of authorization.
- Input is currently a local fixture connector only. Replace it with an authorized connector
  implementing the Post interface when an actual access method is verified.
- The feed is dynamic: future integrations should log observations, not promise full coverage.

Official sources:
- https://docs.x.com/x-api/introduction
- https://docs.x.com/x-api/getting-started/pricing
- https://docs.x.com/developer-terms/agreement
- https://help.x.com/en/rules-and-policies/x-rules

Verification still required: the user's permission to access personalized recommendations,
the endpoint's availability, actual billing and limits, and a successful local end-to-end read
without disclosing account secrets to ChatGPT.
