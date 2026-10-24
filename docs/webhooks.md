# Opt-in webhook delivery for watch alerts

The `webhook` output delivers matching watch alerts to an explicitly configured public HTTPS receiver. Local watch rules and history work without it. There is no default recipient, email service, SMS account or automatic subscription.

## Configure a receiver

Use an HTTPS service you control or are authorized to notify. A webhook request contains the watched entity, the observed change and source identifiers; choose a destination appropriate for that data.

Add an output to a project manifest:

```json
{
  "id": "my-alert-receiver",
  "adapter": "webhook",
  "config": {
    "enabled": true,
    "endpointEnv": "DISCOVERY_WEBHOOK_URL",
    "bearerTokenEnv": "DISCOVERY_WEBHOOK_TOKEN",
    "includeExisting": false,
    "maxPerExport": 20,
    "maxAttempts": 5
  }
}
```

Set the named environment variables for the collector process using your OS or service manager. `bearerTokenEnv` is optional; omit it when the receiver does not use Bearer authentication. A non-secret HTTPS destination can alternatively be provided as `url`, instead of `endpointEnv`. Secrets and destination URLs are not included in the SQLite delivery ledger or error messages.

`enabled` must be `true`. A disabled output sends nothing. `examples/price-monitor/webhook-template.json` starts disabled, so copying or inspecting the example does not send any data.

The first enabled export records the current alert boundary. With the default `includeExisting:false`, alerts already present at that moment are treated as history. Subsequent changes can be delivered. To send existing alerts deliberately, set `includeExisting:true`; successful previous deliveries are still excluded.

## Run and inspect

The standalone CLI keeps collection and output explicit:

```sh
npm run cli -- project sync --project /path/to/project.json --db /path/to/library.db
npm run cli -- project export --project /path/to/project.json --db /path/to/library.db
npm run cli -- project deliveries --id my-project --db /path/to/library.db
```

An Obsidian project exports its configured outputs after manual or scheduled collection. **Reevaluate stored data remains local:** it refreshes outputs declared offline (the built-in JSON and Obsidian outputs) and skips webhook/undeclared outputs. Use **Export project** or collection to attempt delivery explicitly. The **Monitoring → Alert delivery** section displays delivery totals and recent failures. The authenticated local API exposes `GET /project/deliveries?project=my-project`, with optional `output=output-id`. Inspecting delivery status never sends anything or starts a delivery boundary.

Retry transient failures by exporting again or on the next scheduled collection. Each export is bounded by `maxPerExport` (1–100; default 20) and 30 seconds of delivery work, and each alert by `maxAttempts` (1–20; default 5). Unattempted records remain eligible for a later export. Records at their retry limit remain visible as exhausted. Fix the destination or credential issue before increasing that limit. A changed receiver URL requires a new output ID, preventing silent redirection of an existing delivery stream.

The status counts describe delivery records that have already had an attempt; they are not a total of every unattempted alert. `pending` identifies an interrupted attempt awaiting acknowledgement/retry. `failed` is retryable and `exhausted` has reached the configured attempt limit. A retry after an ambiguous interruption can repeat a request, which is why receiver-side idempotency is required.

## Delivery semantics

Each attempt uses the same stored JSON payload and `Idempotency-Key` header for that alert/output pair. The key also distinguishes separate databases. Successful requests are recorded durably and skipped by later exports. Failures are recorded with a sanitized reason and attempt count.

The sender cannot guarantee exactly-once processing across a network failure or a crash after the receiver accepted a request but before the local acknowledgement was committed. Delivery uses **bounded retry attempts and may repeat a request after an ambiguous failure**. Successful delivery is not guaranteed within the retry budget. The receiver must store and honor the idempotency key before applying side effects; duplicates should receive a successful response without repeating those side effects.

Payloads carry a version and the alert/change/source identity. The recorded old/new values describe collected source claims, not independent verification of the underlying price, job status or other domain fact. Entity decisions remain separate. Entities currently rejected or excluded from the project's export policy are not delivered.

## Transport boundary

Requests are POSTs to HTTPS only, with DNS validation and address pinning. Private, internal, loopback and X destinations are rejected. Redirect responses are not followed, so a receiver cannot redirect an authorization header or payload to another host. Payloads are limited to 128 KiB and responses to 16 KiB. `timeoutMs` covers DNS and response time (1,000–30,000 ms, default 8,000), within the overall export budget. Delivery errors never contain the receiver URL, token or response body.

Automated tests replace DNS and HTTP with deterministic mocks. They validate transport and ledger behavior without contacting a real receiver. A particular external service still needs its own receiver-contract check, using data you authorize to send.
