---
title: "Local-first web research"
description: "Configure explicit WebSearch and WebFetch provider chains, Parallel MCP, local extraction, and isolated browser rendering."
sidebar:
  order: 5
---

Mono-agent's Pi runtime exposes two complementary public-web tools:

- `WebSearch` discovers and ranks candidate URLs.
- `WebFetch` retrieves one URL and converts its content into compact,
  model-readable text.

Both tools return a compact JSON envelope with `status`
(`ok`/`partial`/`blocked`/`error`), a host-written `summary`, untrusted
`content` or `results`, source and `coverage` metadata, and typed
`next_actions` with schema-valid tool arguments. `partial` means usable but
incomplete output, `blocked` means policy/access/budget prevents progress, and
`error` means execution failure. Untrusted provider and page text is listed in
`untrusted_fields`; host-written summaries, coverage, and next actions never
quote page bodies, headers, or credentials.

Both tools run inside one ephemeral controller per model run. Identical calls
share in-flight work and a bounded in-memory cache; the controller and any
browser namespace close at the end of the run. Successful searches also share
a bounded process cache for 15 minutes. Host coordination persists operational
limits only; it creates no durable search history, cookie jar, or browser profile.

## Recommended configuration

The framework defaults to `["parallel", "ollama"]` search (Parallel, then local
Ollama) and `"local"` static fetch extraction. Keyless engines are opt-in. For several
agents running under the same OS user, opt into host coordination:

```json
{
  "tools": {
    "web": {
      "coordination": "host",
      "search": {
        "backend": ["parallel", "ollama"],
        "maxRequestsPerRun": 4,
        "ollama": { "baseUrl": "http://127.0.0.1:11434" }
      },
      "fetch": {
        "provider": "local",
        "render": "never",
        "browserCommand": "agent-browser"
      }
    }
  }
}
```

No provider block is required for anonymous Parallel or local Ollama, including
when Ollama appears in a chain. To opt into SearXNG, select it explicitly, for
example `["searxng", "parallel"]`, and configure `searxng.endpoint`.
The legacy
`tools.web.search.endpoint` spelling remains a migration alias. When present, it must be
an unauthenticated loopback `http://` URL; remote endpoints, URL credentials,
queries, and fragments are rejected during config loading. The companion
service is deliberately operator-owned—mono-agent probes it but never starts,
stops, or upgrades it.

Set `tools.web.fetch.render` to `auto` only when this agent regularly needs
JavaScript-heavy pages and `agent-browser` 0.33.1 or newer is installed. Static
extraction remains the first choice even in `auto` mode.

Environment equivalents:

| Config key | Environment variable | Default |
| --- | --- | --- |
| `tools.web.coordination` | `MONO_AGENT_WEB_COORDINATION` | `process` |
| `tools.web.search.backend` | `MONO_AGENT_WEB_SEARCH_BACKEND` | `parallel,ollama` |
| `tools.web.search.maxRequestsPerRun` | `MONO_AGENT_WEB_SEARCH_MAX_REQUESTS_PER_RUN` | `4` |
| `tools.web.search.searxng.endpoint` | `MONO_AGENT_WEB_SEARCH_SEARXNG_ENDPOINT` | unset |
| legacy `tools.web.search.endpoint` | `MONO_AGENT_WEB_SEARCH_ENDPOINT` | unset |
| `tools.web.search.ollama.baseUrl` | `MONO_AGENT_WEB_SEARCH_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` when Ollama is selected |
| `tools.web.search.ollama.apiKeyEnv` | `MONO_AGENT_WEB_SEARCH_OLLAMA_API_KEY_ENV` | unset |
| `tools.web.search.ollama.trustPublicUrl` | `MONO_AGENT_WEB_SEARCH_OLLAMA_TRUST_PUBLIC_URL` | `false` |
| `tools.web.search.codex.model` | `MONO_AGENT_WEB_SEARCH_CODEX_MODEL` | `gpt-5.6-luna` |
| `tools.web.search.parallel.apiKeyEnv` | `MONO_AGENT_WEB_SEARCH_PARALLEL_API_KEY_ENV` | unset (anonymous) |
| `tools.web.fetch.provider` | `MONO_AGENT_WEB_FETCH_PROVIDER` | `local` |
| `tools.web.fetch.parallel.apiKeyEnv` | `MONO_AGENT_WEB_FETCH_PARALLEL_API_KEY_ENV` | unset (anonymous) |
| `tools.web.fetch.render` | `MONO_AGENT_WEB_FETCH_RENDER` | `never` |
| `tools.web.fetch.browserCommand` | `MONO_AGENT_WEB_BROWSER_COMMAND` | `agent-browser` |

## WebSearch

A provider name is strict; a non-empty array is an ordered fallback chain.
Duplicate or unknown names are config errors. Providers returning failures,
empty, irrelevant or out-of-domain results advance the chain; cooldowns and
deferrals skip work. Budget exhaustion or unsafe host coordination stops the
whole call. SearXNG requires an endpoint at load time; Ollama needs no block.

| Provider name | Behavior |
| --- | --- |
| `parallel` | Anonymous Parallel Search MCP, with optional named API-key variable. |
| `searxng` | Configured loopback JSON endpoint. |
| `ollama` | Local Ollama by default; explicitly configured hosted search is also supported. |
| `codex` | ChatGPT-authenticated `codex` app-server with the configured model and web-search capability. |
| `keyless` | Virtual opt-in group: DuckDuckGo HTML, then Startpage. |
| `duckduckgo`, `startpage` | Select either HTML engine individually. |

### Migrating from auto

Search `auto` was removed, including `MONO_AGENT_WEB_SEARCH_BACKEND=auto`.
Config loading prints the equivalent previous chain for that configuration:
explicit Ollama block first, then a configured SearXNG endpoint, then Codex and
keyless. For example, an old SearXNG configuration reports:

```text
tools.web.search.backend "auto" was removed; use ["searxng","codex","keyless"] (the previous auto order for this configuration)
```

Use that array to preserve old behavior, or omit `backend` to adopt the new
Parallel → local Ollama default. Environment arrays use comma-separated names,
for example `MONO_AGENT_WEB_SEARCH_BACKEND=searxng,codex,keyless`.

### Parallel Search MCP

The fixed streamable HTTP endpoint is `https://search.parallel.ai/mcp`.
Anonymous access has provider-controlled limits; no unlimited quota is promised.
Queries, advisory objectives, and fetched URLs go to **parallel.ai**. A local
fallback does not make the first Parallel request private. Select strict local
Ollama/SearXNG instead when remote query disclosure is inappropriate.

Primary and up to three alternate queries are sent unchanged in one
`web_search` call, costing one answered-search request. Language, time range,
and domain preferences also inform an advisory objective; local relevance and
domain gates still apply. Published dates are shown when supplied. Excerpts use
the normal bounded snippets, not an unbounded provider payload.

Optional `search.parallel.apiKeyEnv` and `fetch.parallel.apiKeyEnv` name an
environment variable. Omit them for anonymous access. A named missing/empty
variable is an error, not anonymous downgrade. Credentials are read at call
time, never logged, and only their digest affects cache identity. No OAuth or
paid REST API integration is involved.

A session id hashes the runtime run id (`mono-` plus SHA-256); without a run id,
a random identity is memoized on the shared run state. Search and fetch share
it only within that run. It is never persisted, logged, or added to shared
result-cache keys. Each attempt closes its MCP client/transport, propagates
abort, rejects redirects, and bounds streamed responses to 2 MiB for search or
20 MiB for fetch. Both the endpoint and fetch target must pass sandbox policy.
Remote extraction cannot attest redirects that Parallel performs internally;
use `local` when policy requires enforcement at every source redirect hop.

HTTP 429 or MCP rate-limit errors open a cooldown; malformed/protocol/auth
responses are `backend_unavailable`, never a fabricated `No results`. Strict
Parallel doctor/validate liveness uses only `tools/list`, without a query or
extraction, and reports anonymous versus configured `apiKeyEnv` access.

### Ollama Web Search

Local and signed-in self-hosted Ollama default to `http://127.0.0.1:11434`:

```json
{ "tools": { "web": { "search": { "backend": "ollama" } } } }
```

Hosted search is bound to the exact official origin and an explicitly named
environment variable:

```json
{
  "tools": { "web": { "search": {
    "backend": "ollama",
    "ollama": { "baseUrl": "https://ollama.com", "apiKeyEnv": "OLLAMA_API_KEY" }
  } } }
}
```

Mono-agent posts to `/api/experimental/web_search` locally and retries
`/api/web_search` at the same origin only for `404` or `405`. Hosted search uses
only `https://ollama.com/api/web_search` with bearer auth. The credential is
never sent to local, private, or custom origins; `apiKeyEnv` is rejected for
those origins. A custom public origin requires HTTPS and
`trustPublicUrl: true`, remains unauthenticated, and never receives an Ollama
hosted key. Redirects are rejected. Language and time range are advisory for
Ollama, and strict Ollama never falls back to another provider. Both Ollama
endpoint variants receive the caller's effective 1–10 result limit as
`max_results`; a compatibility retry does not reset it.

The tool accepts one `query`, up to three `alternate_queries`, a result `limit`
from 1–10, `domains`, `exclude_domains`, `language`, and a `time_range` of
`day`, `month`, or `year`. For sequential providers, the primary query runs first. Supplied alternates run in order only while no
relevant result has been accepted. A transport failure, quota skip or block ends
that stage immediately; alternate wording cannot repair it. Codex gets at most
one exact-query turn. Quotes and `site:` operators are never
stripped or relaxed. Results are normalized, tracking parameters are removed,
duplicates are fused with reciprocal-rank fusion, and include/exclude domain
filters plus a deterministic query-term/quoted-phrase relevance gate are
enforced before a provider can end the chain. Parallel batches the primary and
alternates once; Codex receives only the primary query.

Every backend shares the same model-facing output bounds. A result title is at
most 500 characters and its snippet is at most 4,000 characters, including the
visible marker `[snippet truncated; use WebFetch for full source]`. The ranked
result entries reuse the 64 KiB UTF-8 body allocation; envelope framing
(summary, coverage, and next actions) stays outside it. Under pressure,
lower-ranked snippets are shortened before a whole result is omitted, and
lossy truncation is reported as `partial`. Result entries carry the source
citations (`title`/`url`/`published`); snippets are untrusted discovery leads.
Use `WebFetch` on a result URL when the marker says the snippet is incomplete.
Successful searches offer up to three typed `WebFetch` next actions for the
strongest returned URLs. No next action is offered for genuine no-results,
rate limits, budgets, or other terminal failures, and next actions never
repeat page prose or suggest bypasses, cooldown waits, or provider changes to
evade access gates.

Start research with one broad, high-yield query that covers the decision's main
constraints. Treat snippets as leads and use `WebFetch` on the strongest
returned URLs before searching again. Supply alternate queries only when a
material evidence gap remains; do not split a topic into many narrow searches.

`maxRequestsPerRun` is a hard integer limit from 1 through 20 on answered
provider searches in one logical runtime run. It defaults to 4 and is shared by
runtime route retries. Each child agent and later run receives a fresh budget.
A successful provider response costs one request, including a well-formed empty
answer. Failed attempts are refunded; cache hits, in-flight followers, provider
cooldown skips, sandbox denials, and Codex quota skips consume zero requests.
Reservations are synchronous, so concurrent searches cannot oversubscribe the
budget while responses are pending.

A separate, non-refundable ceiling of `maxRequestsPerRun * 4` provider dispatches
(16 by default) bounds network work even when every attempt fails. A local Ollama
compatibility probe across both supported paths costs one answered search if it
succeeds, but two dispatches. Outcomes expose `dispatchesUsed`, `maxDispatches`,
and `dispatchesRemaining` alongside the existing request counters.

When either limit refuses a dispatch, WebSearch returns `search_budget_exhausted`,
`requestsUsed`, `requestsRemaining`, `retryInRun: false`, and
`nextAction: "use_available_evidence"` without sending that request. The message
includes a bounded, deduplicated summary of actual provider failures in the run
and known retry timing, not provider URLs or raw error bodies. If the dispatch
ceiling was reached, it explicitly says the run spent its dispatches on failing
providers; `requestsRemaining` may still be positive in that case.

A provider that returns a rate limit is deferred for the rest of that run.
An ordered chain advances immediately to the next eligible provider; single names stay
strict. The result reports `retryAfterMs` when known, an absolute `retryAt`, the
provider disposition, and whether another search attempt in the run can help.
Do not sleep, retry, or delegate to wait out a cooldown. Fetch URLs already
returned, or answer from available evidence and state the limitation.

### ChatGPT-subscription Codex search

Codex search uses the installed `codex app-server` and the operator's existing
ChatGPT sign-in. It does not read, export, log, or persist OAuth tokens, and it
does not use an OpenAI API key or API-billed Responses request. Readiness
requires all three of:

- `account/read` reports ChatGPT authentication;
- `modelProvider/capabilities/read` reports `webSearch: true`;
- `model/list` includes `tools.web.search.codex.model`.

Each fallback executes one ephemeral, low-effort search turn in a private
scratch working directory. MCP servers, environments, dynamic tools, project
instructions, and capability roots are empty. Mono-agent consumes only the one
completed structured `webSearch.results` item; assistant prose and any URLs it
contains are ignored. A server interaction, a second search item, or any
non-search tool item interrupts and rejects the fallback. Concurrent
subscription searches are serialized process-wide (and across opted-in host
processes), while the ordinary
successful-result cache still prevents repeated calls for the same request.

Search reads `account/rateLimits/read` or its update notification and caches the
snapshot for at most 60 seconds. It preserves a 10% allowance reserve: if either
reported Codex window is at least 90% used, it skips the turn until quota is
available. Missing, invalid, or stale/unrefreshable quota also skips Codex.
This uses subscription allowance, not unlimited free search. No automatic credit
purchase or account rotation is involved. Language and time-range preferences
are sent separately from the unchanged query; they are advisory for Codex.
SearXNG supports both filters, DuckDuckGo receives its date parameter and a
language hint, and Startpage receives an advisory date parameter. These HTML
endpoints do not guarantee freshness.
`outcome.filterSupport` reports these limitations; verify dates in fetched sources.

An empty result set is a successful answer (`No results.`) **only when the
backend that produced it was actually working**. A tool error means every
eligible backend failed or policy blocked every request; the result keeps that
distinction so the model does not waste another reasoning round repeating the
same call. Because `No results.` is a claim about the web rather than about the
infrastructure, every way a backend can be blocked while still answering `200`
is classified as an error instead — see the two sections below.

### SearXNG engine health

A SearXNG instance whose engines are all rate-limited or captcha'd still answers
`HTTP 200` with an empty `results` array. The response's `unresponsive_engines`
field is the only thing that separates that from a query nothing matched:

| SearXNG response | Treated as |
| --- | --- |
| results present | success |
| empty results, no unresponsive engines | genuine `No results.` |
| empty results, one or more unresponsive engines | `rate_limited` or `backend_unavailable`, naming each engine and its reason |

The error text names every failed engine (`duckduckgo: CAPTCHA; brave: too many
requests`), so a blocked instance is diagnosable from the tool output without
reading container logs. An explicitly configured chain can continue to its next provider after it.

The stock SearXNG engine set may not be usable from an ordinary residential IP:
engines can answer with a CAPTCHA or require an API key. Configure at least one
engine that works from the operator network and use the copyable loopback,
JSON-shape, and engine-health checks in the
[local-first web research playbook](/playbooks/local-web-research/#1-provision-an-optional-searxng-instance).

### Keyless rate limiting

The keyless engines are free HTML endpoints that throttle by source IP, and they
announce it in ways that look like success or like a network fault:

| Signal | Engine | Treated as |
| --- | --- | --- |
| `HTTP 202`, `403`, or `429` | DuckDuckGo | `rate_limited` |
| `3xx` to a captcha or block page | Startpage | `rate_limited` |
| `2xx` that parses to nothing but carries challenge markers | either | `rate_limited` |
| `2xx` proof-of-work interstitial (Anubis, "Verifying your request…") | Startpage | `rate_limited` |
| `2xx` that parses to nothing | either | genuine `No results.` |

No credentials are ever sent to these endpoints, so a `403` can only mean
"blocked", never "unauthorized".

Redirects are never followed for search: on these engines a redirect *is* the
block, so following it only costs a round trip and still yields no results.

The default `process` mode retains the process-wide keyless bounds: three
requests in flight, 1.5 seconds between starts to the same engine, and a
five-minute throttle cooldown. `host` adds admission shared by every opted-in
agent and subagent under the same OS user:

| Backend scope | Concurrent requests | Minimum start spacing |
| --- | --- | --- |
| SearXNG endpoint | 1 | 2 seconds |
| Ollama origin | 1 | 2 seconds |
| Parallel MCP (search and fetch) | 1 | 2 seconds |
| Other registered provider kinds | 1 | 2 seconds |
| DuckDuckGo / Startpage, separately | 1 each | 3 seconds |
| Codex subscription | 1 | serialized |
| Fetch origin (HTTP and renderer admission) | 2 | 500 ms |

Host mode honors `Retry-After`; without it, throttled searches cool down for five
minutes and fetch origins for one minute. Repeated throttling doubles that delay
up to an hour. Two infrastructure failures open a one-minute cooldown. Only one
probe is admitted when a cooldown expires. A later successful probe resets the
failure streak. Cooldown skips make no provider request.

A search has a 60-second deadline including admission, startup and I/O. SearXNG
admission and execution get a three-second stage budget when it is not the only
provider in the chain.
Strict SearXNG retains its 15-second per-request timeout within the total budget.
Cancellation closes active Codex transport before releasing admission; process
shutdown may add its bounded cleanup time.

Successful searches are cached process-wide for **15 minutes**, keyed by the
query parameters *and* the backend configuration, so sibling subagents and later
turns reuse a result instead of re-querying. Failures are never cached.

`outcome.rateLimited` and `outcome.cooldownBackends` report throttling even when
a fallback backend rescued the query, so a silent degradation stays visible.

### Host state and recovery

`~/.mono-agent/web-control/state.json` stores hashed backend keys, cooldowns,
PID/incarnation leases, and quota counters. Owner-private locking and atomic
replacement coordinate processes without a daemon. The directory is `0700`,
state is `0600`, capped at 256 KiB and 512 buckets. Query text, fetched content,
headers and credentials are never written there. Expired leases and proven-dead
owners are reclaimed during admission. Unsafe or corrupt state fails closed;
there is no uncoordinated network fallback.

```bash
mono-agent web-control status --json
mono-agent web-control reset --json
```

Status reports only operational metadata. Reset clears validated state only when
there are no active requests. It does not repair unsafe permissions or corrupt
JSON; stop opted-in consumers and inspect the private directory before manual
recovery. Ordinary session reset and restart do not clear host cooldowns.

SearXNG remains dependent on upstream engine limits. A VPN changes the network
path, but does not expand account quota or provide a reliable search budget;
shared exits can themselves be blocked. Prefer fewer queries, cached results,
working operator-selected engines and respected cooldowns. The framework does
not rotate accounts, proxies or VPN exits.

## WebFetch

`tools.web.fetch.provider` defaults to `"local"`. Select `"parallel"` for strict
remote extraction or an ordered array such as `["local", "parallel"]` for
explicit fallback. No remote fetch fallback is enabled by default.

Parallel calls `web_fetch` for one URL with `full_content: true`, preferring
full content. If only excerpts are returned, document metadata explicitly says
`[excerpts only]`; continuation ranges refer only to the available extracted
text. It supports Markdown/plain text and the usual line/output bounds.

Parallel-only calls reject `format: "raw"`, any custom request headers, and
explicit `render: "auto"` or `"always"` with `unsupported_parameter`, naming
the option, before any connection. Config `fetch.render: "auto"` requires a
local provider. In a chain, incompatible options skip Parallel and are handled
by local extraction; they are never silently discarded or sent remotely.

Fetch advances to the next selected provider only for `unusable_content`
(sparse loading shell), `access_challenge`, `backend_unavailable`, HTTP errors
other than 401/407, or retryable `request_failed`/`timeout`. Local transient
retries complete first. Authentication, sandbox, invalid parameters, unsupported
content, byte limits, cancellation, and unsafe coordination are terminal; a
successful local extraction never triggers Parallel. Source failures in
Parallel's `errors[]` preserve their HTTP status. Rendering and alternate
providers do not grant permission to bypass site policy or access controls.


`WebFetch` accepts `http://` and `https://` URLs and returns one of:

| `format` | Result |
| --- | --- |
| `markdown` | Default. Article-shaped Markdown for HTML/RSS, pretty JSON, PDF text, or decoded plain text. |
| `text` | Readable plain text with Markdown decoration removed. |
| `raw` | Decoded response body; requires `render: "never"`. |

Static extraction is local and content-aware:

1. Follow at most five redirects, re-checking sandbox network policy at every
   hop.
2. Bound transport at 20 MiB and structured parsing at 8 MiB.
3. Decode by BOM, HTTP charset, HTML meta/XML declaration, then UTF-8, reporting replacement characters and rejecting unsupported declared charsets.
4. Parse HTML with Defuddle, then Readability plus Turndown, then a cleaned-body Turndown fallback. Relative links become safe absolute HTTP(S) links.
5. Strictly parse declared JSON/XML, extract RSS/Atom entries and PDF text, or decode
   ordinary text.
6. Apply the normal tool-output cap and return the result inside the JSON
   envelope's untrusted `content` field.

Request headers are limited to `Accept`, `Accept-Language`, `Range`, and
`User-Agent`. Cookie, authorization, proxy, forwarding, and arbitrary custom
headers are rejected, as are credentials embedded in a URL.

Transient transport failures and HTTP 408/425/429/5xx responses receive up to
two bounded retries. `Retry-After` is honored up to five seconds. Non-success
HTTP responses, unsupported content, and policy denials are returned as
structured tool failures; browser rendering never runs for those responses.

### Read a bounded page slice

Use `start_line` (one-based) and `max_lines` (1–10000, default 200 when slicing).
Omitting both preserves the normal capped document output. `max_output_chars`
still bounds the selected text. The result reports `startLine`, `endLine`,
`totalLines` and `nextLine` in `coverage`, plus a typed `WebFetch`
continuation next action that preserves the call's format, focus, and link
options. A line too large for the
budget requires a larger character cap or reading the saved output artifact;
it is never silently skipped.

```json
{ "url": "https://example.com/guide", "start_line": 201, "max_lines": 100 }
```

### Focused views and page links

`WebFetch` accepts an optional `focus` string (at most 500 characters) and an
optional `include_links` boolean. Both are deterministic post-extraction views
over the cached document: they never change transport or cache identity and
add no requests.

- `focus` keeps the blank-line-separated blocks relevant to the focus terms,
  preserving document order and provenance. Filtering happens before
  pagination, so continuations stay in focused coordinates while the focus
  string is preserved. A focused subset is reported as `partial`; a focus with
  no matching blocks reports `focus_no_match` with no content rather than
  pretending full success.
- `include_links` lists up to 20 deduplicated absolute HTTP(S) links from the
  already-downloaded static HTML, labeled `main-content` or `page`. Rendered,
  remote, raw, and non-HTML documents report the capability as unavailable
  with an explicit reason instead of empty success. Parallel remote extraction
  rejects `include_links` as `unsupported_parameter` before any connection.

The run caches at most 64 extracted documents and 32 MiB of document text.
Changing the slice reuses extraction without refetching or rerendering. Cache
keys retain headers, extraction/render settings and resolved network policy.
Cache eviction or run completion requires a fresh fetch. One 45-second deadline
covers admission, redirects, retry waits and rendering, plus bounded cleanup.
In host mode a throttle starts an origin cooldown, so a retry cannot bypass it.

### Browser rendering

The tool call may request `render: "never"`, `"auto"`, or `"always"`, but the
agent config is the authority:

- Config `never` is a capability ceiling: every call stays static, even if
  model input requests `always`.
- Config `auto` lets individual calls request or automatically trigger browser
  rendering.
- Call `always` is browser-first and strict: Node static fetch is not attempted, and a rendering failure is a tool error.
- Call `auto` escalates only after a successful HTML response is classified as
  a sparse application shell. If rendering then fails, the loading shell is not
  returned as success; cancellation is never returned as static success.

Automatic rendering is attempted only for successful HTML whose extracted text
is sparse and whose markup looks like a client-rendered application. JSON,
PDFs, feeds, plain text, and HTTP errors never launch a browser.

Each render uses one 20-second budget, a random `agent-browser` namespace and session, an empty locked
config file, origin-scoped `--allowed-domains`, untrusted-content boundaries,
and no profile, restore state, remote CDP attachment, auto-connect, or state autosave. It opens the
requested URL, waits for `DOMContentLoaded`, validates the browser's final URL against the sandbox and domain policy, reads agent-oriented page content, then
closes the browser and removes its temporary config. The executable is invoked
directly—`browserCommand` is not evaluated by a shell.

Clear authentication pages and CAPTCHA/access challenges return
`authentication_required` or `access_challenge`. The renderer does not click,
type, solve challenges, reuse a profile, defeat Cloudflare, or bypass robots,
access controls, authentication, or site policy.

## Sandbox and validation

Tool policy controls whether `WebSearch` / `WebFetch` exist. The native sandbox
separately controls which network destinations they may contact:

- `network.mode: "none"` blocks every web request.
- `localhost` admits local SearXNG or Ollama but blocks public keyless
  search and public fetches.
- an allowlist must include the local endpoint, `chatgpt.com` for Codex search,
  plus every public destination
  the agent is authorized to search or fetch.
- `all` permits public egress while retaining filesystem enforcement.

`mono-agent validate` adds a **Web search & fetch** section. With liveness
enabled it sends a bounded JSON query to the selected SearXNG or Ollama endpoint. Strict
`codex` mode also verifies ChatGPT login, web-search capability, and model
availability; `auto` checks that fallback lazily only if a search reaches it.
When rendering is enabled, validation checks that `browserCommand --version`
reports `agent-browser` 0.33.1 or newer. `liveness: false` skips external probes
without changing structural validation.

## Security and observability

Search snippets, the actual search query, and fetched pages are always labelled
untrusted through `untrusted_fields`. WebSearch output includes bounded
backend/query/provenance coverage so fallback behavior is inspectable, while
sanitized failures expose only a backend and stable category. Fetch failures
carry a stable code and a `blocked` (`network_denied`, `access_challenge`,
`authentication_required`, rate limits, exhausted search budget, unavailable
coordination) versus `error` (execution/provider failure) status. Timing events retain only bounded operational
fields such as status, error code, backend, attempt count, request budget and
remaining count, absolute retry time, next action, byte count,
HTTP/exit status, timeout, rendered, cache-hit, truncation flags, queue wait,
backend time, cooldown skips and quota skips; request
headers and command arguments stay out of them. WebFetch additionally reports
bounded content-kind, charset, extraction-stage, parser-failure, rendering-reason,
and browser-recommendation metadata without source URLs or page content.

The tools are public-web readers, not an authenticated browsing surface. Codex
uses an existing ChatGPT subscription only as the search transport; neither
search results nor model-visible output receives account data. The tools do not
expose browser profiles, cookies, login state, file downloads, arbitrary
headers, or remote SearXNG credentials. Browser rendering is a retrieval mode,
not an anti-bot or authenticated browsing feature.

## Adding a provider

Providers are source-level modules, not dynamically loaded config plugins:

1. Add one module under
   `packages/agent-runtime/src/agent/tools/web-search-providers/` implementing
   the JSDoc `SearchProvider` contract in `registry.js`.
2. Register it once in that registry. Declare its `name`, `configure`,
   `eligibility`/requirements, `admission` kind/key/process policy,
   `networkTargets`, `filterSupport`, `batchesQueries`, and `search` function.
   Optional `primaryOnly` and `chainDeadlineMs` cover restricted providers.
3. Add its name/config validation, config-view/reference, docs, and tests.
   Do not add branches to the search chain body. Unknown coordination kinds
   receive the generic one-request/two-second host limit.

The chain owns admission, deferrals, refund settlement, local relevance/domain
gates, reciprocal-rank fusion, and bounded untrusted output. An adapter claims
its request immediately before dispatch using `web-search-state.js`; failed
answers are refunded, while dispatches remain counted. Every actual network
destination must be sandbox-gated. Never put queries, targets, credentials, or
response bodies into timing/coordination metadata. The registry tests demonstrate
both a fake standalone provider and `["fake-fail", "keyless"]` fallback without
orchestrator edits.
