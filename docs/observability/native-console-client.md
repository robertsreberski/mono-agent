---
title: Building a native console client
description: Pin the console HTTP and SSE v1 contract, reconcile live state, and safely upload and retrieve files from a non-TypeScript client.
---

The console serves JSON over HTTP and live updates over server-sent events
(SSE). A SwiftUI or other native client can use this API without embedding the
webapp or importing TypeScript. This is the **console** API, not an agent's
operator endpoint or the private notification ingress.

## Pin the contract

Pin an exact `@mono-agent/web` package version in your contract-fetching tooling.
The published tarball includes these JSON export subpaths:

- `@mono-agent/web/schema/console-api.v1.schema.json`: JSON Schema draft-07.
- `@mono-agent/web/schema/console-api.v1.routes.json`: methods, Express-style path
  patterns, request/response DTO names, success statuses, query DTOs and origin
  policies for every console `/api/v1` route (plus `/healthz`).
- `@mono-agent/web/schema/console-api.v1.fixtures.json`: fictional golden DTOs;
  each event example also includes the complete SSE `frame` string.
- `@mono-agent/web/schema/message-delta-vectors.v1.json`: shared delta conformance
  cases (`prev`, `next`, ordered `ops`).

In a source checkout these live in `packages/web/schema/`. The manifest's type
names resolve to `#/definitions/<name>` in the schema, for example `ApiBootstrap`,
`ApiMessagePage` and `ApiEvent`. Validate a fixture's `value` against its named
`type`, **not** against the whole schema document: the document is a definition
library, not a union that guesses which response you received. `NoBody` means no
body (including 204 responses); `Binary` means bytes and `Html` is the fixed MCP iframe proxy document,
not JSON. Query schemas
use logical scalars; serialize their booleans and numbers as URL query strings.
Path parameters and cursors are opaque; percent-encode each path segment.

`ApiEvent` uses the discriminated `WebTypedEvent` envelope and the exhaustive
`WebEventPayloadMap`. Existing TypeScript `WebEvent` remains permissive for
source compatibility. Opaque tool arguments/results, telemetry `data`, MCP
results and peer-provided schemas intentionally remain arbitrary JSON: do not
invent Swift models for their unknown contents. Unknown billing amounts omit
numeric fields and send `costUnknown: true` (projects: `monthCostUnknown: true`),
with optional separately known spend. Absence without a marker is not zero.
Other nullable fields, such as `thread.projectId`, still carry JSON `null`.

The schema describes structural DTOs, not every admission rule: respect server
errors, runtime limits, revision checks and capability availability. Timestamps
are ISO strings; IDs are strings, not necessarily UUIDs. Native decoders should
ignore unknown object fields so additive v1 responses remain consumable.

## Base URL and network boundary

Store a console base URL such as `https://console.example.ts.net` (or
`http://127.0.0.1:5050` locally). Resolve API paths against that origin; the server
serves `/api/v1` at the root, not under an arbitrary reverse-proxy path prefix.
Keep the scheme and any explicit port. Derive returned relative URLs against
this same base, and do not forward capability tokens to another origin.

Every request passes the Host allowlist. Loopback/private local addresses,
the configured hostname, the machine hostname and its `.local` name are accepted;
an arbitrary remote alias may require `MONO_AGENT_WEB_ALLOWED_HOSTS`, a
comma-separated list of **hostnames**, without scheme, path or port. Configure
that on the console host, not in the client. Preserve the intended Host through
any trusted proxy; rewriting it inconsistently also breaks exact-origin checks.
This is not a new authentication protocol. Use a trusted local/private network
and an appropriately secured tunnel/proxy; do not expose an unauthenticated
console directly to the public Internet.

## Claimed origin

For a native request with no browser `Origin`, send:

```http
X-Mono-Agent-Web-Origin: https://console.example.ts.net
```

The value must be a bare HTTP(S) origin with the same Host authority, including
port, as the request. No credentials, path, query or fragment. If both `Origin`
and the claimed-origin header are sent, exact-origin routes require them to
agree. The claim is not a secret or bearer token, and it does not override the
Host allowlist. Do not send browser `Sec-Fetch-Site` headers from a native client.

Use `requiresClaimedOrigin` in the manifest rather than assuming that every
mutation needs it or that every GET is exempt. Specifically:

- `originPolicy: "exact"` accepts matching `Origin` or, for native clients, the
  claimed-origin header. This covers provider usage (including reads), provider
  auth, restart (including reads and proposal actions), cron actions/replies,
  wake-schedule mutations, reply-file/MCP access issuance, MCP requests, and
  push subscription mutations/acknowledgements.
- `originPolicy: "claimed"` requires the claimed header even when `Origin` exists
  (push subscription GET).
- `originPolicy: "host"` does not require the claim. Host validation still
  applies, and mutations reject cross-site browser origins when supplied.

Sending the correct claimed origin consistently on your console requests is
simpler than maintaining a second route list in the native app.

## Read and reconcile

Read `/healthz` or `/api/v1/bootstrap` and require `version: 1`. Events also carry
`version: 1`. The `/api/v1` path is the API version selector; there is currently
**no** Accept/header-based version negotiation. Package versions pin a specific
v1 contract snapshot, not a new API major. Treat an unsupported major as an
upgrade/reconfiguration requirement rather than silently interpreting it as v1.

Bootstrap supplies discovered agents, a scoped first thread page, projects,
tags, upload limits and console identity. Follow page cursors rather than
assuming bootstrap contains all conversations. Read the selected thread and its
message pages; reconcile individual messages through their message GET route.
Some tool payloads are truncated in normal reads: use the tool-call route or
`?full=1` for the full transcript. Schedule edits require the latest
`expectedRevision`; on 409 re-read instead of overwriting another client.
Submission IDs support reconciliation after uncertain delivery: read the
submission receipt rather than blindly sending the same user input again.

## One SSE stream

Open one long-lived `GET /api/v1/events` stream per active client. Optional
`?thread=<encoded-id>` selects the open conversation; reconnect with the new
selection when it changes. This is not a filter on global events. Selected
message deltas pass through; other conversations receive rate-limited change
hints instead. With no selection, deltas become hints too. Process every named
event listed in the contract, not just the browser's default `message` event.

A frame is:

```text
id: event-example
event: ready
data: {"id":"event-example","version":1,"type":"ready","at":"2030-01-02T12:00:00.000Z","payload":{"version":1}}

```

`data` is the **whole envelope**, not just its payload. Its type matches `event`.
Parse SSE lines and blank-line frame boundaries incrementally across arbitrary
network chunks; UTF-8 characters and JSON can span chunks. Comments such as
`: heartbeat ...` arrive approximately every **15 seconds** and carry no JSON.
The stream may close under backpressure, capacity or network failure. Reconnect
with bounded backoff, but do not treat a reconnect as proof of freshness.

`ready` arrives on every connection. **There is no replay**: `Last-Event-ID` is
ignored. On connect/reconnect, reconcile bootstrap, the selected thread/messages,
active-thread counts and any affected lists. Event IDs are opaque, not durable
log offsets. Subscribe before reconciliation reads and reconcile again if an
in-flight change makes those reads obsolete. Some invalidation events omit
`payload` (`agents.changed`, `threads.changed`); a removal carries its ID and
`removed: true`. Never infer a deletion solely from an unloaded page.

For `message.delta`, apply ordered `ops` only when the cached message's `seq`
equals `baseSeq` and the new `seq` equals `baseSeq + 1`. Otherwise fetch that
message and replace its snapshot. `truncate` drops the tail; `set` replaces an
index or appends exactly one past the end; `append` extends a text/reasoning
part's text. Do not skip gaps or append to other part kinds. Apply status,
updated/finished timestamps and replacement attribution as well. Re-read on
`message.changed`; it is a hint, not a message body. Run the exported delta
vectors against your own implementation before relying on streaming updates.

## Two-step uploads

1. POST JSON `{ "name": "example.txt", "contentType": "text/plain", "sizeBytes": 7 }`
   to `/api/v1/uploads`. Keep the returned staged attachment ID.
2. PUT the exact bytes to `/api/v1/uploads/:id/content` with
   `Content-Type: application/octet-stream`. Compressed bodies are rejected;
   declared length/size must match. Wait for `uploaded: true` in the response.
3. Include the ID in `attachmentIds` on a turn/submission. Metadata creation
   alone does not upload bytes. DELETE unused staged uploads when practical.

Honor bootstrap's `limits.maxFileBytes`, `maxFilesPerTurn`, `maxTurnBytes` and
MIME `accept` list, and the selected agent/thread's attachment capabilities.
Current ceilings are 20 MiB per file, 10 files and 64 MiB per turn; staging is
bounded to 100 uploads / 256 MiB, expires after 24 hours, and admits four
concurrent content uploads. Active attachment turns also have a 64 MiB budget
and at most 32 queued attachment turns. Admission can therefore fail even when
a single file fits. Handle 4xx/409/413/415/429 responses; never claim that an
attachment was sent merely because its reservation succeeded.

## Reply files and capability URLs

Reply `attachment` and `mcp_app` parts are not staged uploads. A message read can
include short-lived `contentUrl`, `resourceUrl` and `bridgeUrl`. If a URL expires,
POST to that part's manifest-listed `access` route with exact origin and use the
refreshed part. URLs are message/part-bound, HMAC capability URLs containing
`expires` and `token`; they are typically valid for five to ten minutes and
never beyond artifact retention. Do not persist/log/share these tokens. A
`storedUrl` for a console-owned durable image copy is different: it is stable
and does not require a capability refresh. Respect failures such as expired,
missing or integrity-failed artifacts instead of retrying stale URLs forever.

## Maintaining the contract

The schema generator reads `src/contracts.ts`, its referenced shared types and
the HTTP wrappers in `src/api-contract.ts`. Route descriptors and fictional
fixture inputs live under `packages/web/scripts/contract/`. No server or webapp
runtime behavior is changed by generation.

```sh
pnpm --filter @mono-agent/web run generate:api-contract
pnpm --filter @mono-agent/web run check:api-contract
```

The check is part of the web package's `test` script, reached by recursive root
`pnpm test` in CI and local `pnpm verify:all`. It regenerates in memory, validates
fixtures and rejects stale committed artifacts. Independent route discovery
checks both missing and extra routes and origin-policy drift; focused tests also
prove that adding an unlisted handler fails. Static/PWA/shell routes and the
internal ingress listener are outside this contract.

## Optional voice transcription

When bootstrap `voice.enabled` is true, `POST /api/v1/threads/:id/transcriptions`
accepts raw WebM, MP4 or Ogg audio bytes and returns `{ "text": "..." }` without
creating a turn. This route requires the actual exact `Origin` header, not just
`X-Mono-Agent-Web-Origin` (manifest `requiresOriginHeader: true`). It is ephemeral,
`no-store`, byte/deadline/concurrency bounded, and disabled if capability metadata
is absent. Submit the transcript separately through the normal UUID-bearing
submission/receipt path; never replay an ambiguous submission with a new ID.
The browser stages recorded audio through ordinary uploads, then transcribes it
before the normal synchronous UUID submission, including the same ordered
attachment IDs. Audio retention is ordinary committed-attachment retention;
this raw endpoint itself still stores no audio. Recording intent and successful
transcript cache are client-memory only, never inferred from arbitrary audio
filenames. Preparation must not bypass running-turn attachment restrictions.

`voice.maxSeconds` is deprecated, optional on reads for old-server compatibility,
and no longer emitted. There is no fixed browser recording-duration cutoff;
byte/count/deadline/provider limits remain. Update pinned strict generated
schemas/decoders accordingly. No asynchronous submission or processing receipt
has been added.
See [voice configuration, limits and retention](./web-console.md#voice-messages-opt-in).

For immutable prepared submissions, `StartWebTurnInput.inheritRunSettings:
false` disables fallback to mutable thread overrides. Supply captured effective
`model`, compatible `effort` when known, and resolved `context1M` (`false` is an
explicit choice). Omitted/true preserves ordinary text behavior. An absent effort
with inheritance disabled uses the agent/model default, never a later thread
selection. This flag is part of submission identity; active-turn live input still
uses the existing active run rather than starting a differently configured turn.
