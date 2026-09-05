---
title: "Local-first web research"
description: "Configure WebSearch with local SearXNG, ChatGPT-subscription Codex search, and keyless fallbacks, plus static or browser-backed WebFetch."
sidebar:
  order: 5
---

Mono-agent's Pi runtime exposes two complementary public-web tools:

- `WebSearch` discovers and ranks candidate URLs.
- `WebFetch` retrieves one URL and converts its content into compact,
  model-readable text.

Both tools run inside one ephemeral controller per model run. Identical calls
share in-flight work and a bounded in-memory cache; the controller and any
browser namespace close at the end of the run. Successful searches also share
a bounded process cache for 15 minutes. Host coordination persists operational
limits only; it creates no durable search history, cookie jar, or browser profile.

## Recommended configuration

The framework defaults to `auto` search and static fetch extraction. For several
agents running under the same OS user, opt into host coordination:

```json
{
  "tools": {
    "web": {
      "coordination": "host",
      "search": {
        "backend": "auto",
        "endpoint": "http://127.0.0.1:8088",
        "codex": { "model": "gpt-5.6-luna" }
      },
      "fetch": {
        "render": "never",
        "browserCommand": "agent-browser"
      }
    }
  }
}
```

`tools.web.search.endpoint` is optional in `auto` mode. When present, it must be
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
| `tools.web.search.backend` | `MONO_AGENT_WEB_SEARCH_BACKEND` | `auto` |
| `tools.web.search.endpoint` | `MONO_AGENT_WEB_SEARCH_ENDPOINT` | unset |
| `tools.web.search.codex.model` | `MONO_AGENT_WEB_SEARCH_CODEX_MODEL` | `gpt-5.6-luna` |
| `tools.web.fetch.render` | `MONO_AGENT_WEB_FETCH_RENDER` | `never` |
| `tools.web.fetch.browserCommand` | `MONO_AGENT_WEB_BROWSER_COMMAND` | `agent-browser` |

## WebSearch

Search backends have explicit behavior:

| Backend | Behavior |
| --- | --- |
| `auto` | Try configured SearXNG first, then ChatGPT-subscription Codex search, then the keyless chain. A non-empty but irrelevant or out-of-domain result does not stop the chain. Without an endpoint, start with Codex. |
| `searxng` | Require the configured local endpoint and fail when it fails. No silent fallback. |
| `codex` | Require a ChatGPT-authenticated `codex` CLI whose app-server exposes web search and the configured model. No SearXNG/keyless fallback. |
| `keyless` | Skip SearXNG and try DuckDuckGo HTML, then Startpage. |

The tool accepts one `query`, up to three `alternate_queries`, a result `limit`
from 1–10, `domains`, `exclude_domains`, `language`, and a `time_range` of
`day`, `month`, or `year`. The primary query runs first. Supplied alternates run in order only while no
relevant result has been accepted. A transport failure, quota skip or block ends
that stage immediately; alternate wording cannot repair it. Codex gets at most
one exact-query turn. Quotes and `site:` operators are never
stripped or relaxed. Results are normalized, tracking parameters are removed,
duplicates are fused with reciprocal-rank fusion, and include/exclude domain
filters plus a deterministic query-term/quoted-phrase relevance gate are
enforced before a backend can end `auto` mode.

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
reading container logs. In `auto` mode Codex subscription search and then the
keyless chain still run after it.

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
| DuckDuckGo / Startpage, separately | 1 each | 3 seconds |
| Codex subscription | 1 | serialized |
| Fetch origin (HTTP and renderer admission) | 2 | 500 ms |

Host mode honors `Retry-After`; without it, throttled searches cool down for five
minutes and fetch origins for one minute. Repeated throttling doubles that delay
up to an hour. Two infrastructure failures open a one-minute cooldown. Only one
probe is admitted when a cooldown expires. A later successful probe resets the
failure streak. Cooldown skips make no provider request.

A search has a 60-second deadline including admission, startup and I/O; automatic
SearXNG admission and execution get a three-second stage budget before fallback.
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

`WebFetch` accepts `http://` and `https://` URLs and returns one of:

| `format` | Result |
| --- | --- |
| `markdown` | Default. Article-shaped Markdown for HTML/RSS, pretty JSON, PDF text, or decoded plain text. |
| `text` | Readable plain text with Markdown decoration removed. |
| `raw` | Decoded response body; requires `render: "never"`. |

Static extraction is local and content-aware:

1. Follow at most five redirects, re-checking sandbox network policy at every
   hop.
2. Bound the decoded response at 20 MiB.
3. Parse HTML with Defuddle, then Readability as a fallback.
4. Pretty-print JSON, extract RSS/Atom/XML entries, extract PDF text, or decode
   ordinary text.
5. Apply the normal tool-output cap and wrap the result in explicit untrusted
   content boundaries.

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
`totalLines` and `nextLine`, plus a continuation hint. A line too large for the
budget requires a larger character cap or reading the saved output artifact;
it is never silently skipped.

```json
{ "url": "https://example.com/guide", "start_line": 201, "max_lines": 100 }
```

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
- Call `always` is strict: a rendering failure is a tool error.
- Call `auto` falls back only when the static extraction is readable. An unusable
  loading shell is an error; cancellation is never returned as static success.

Automatic rendering is attempted only for successful HTML whose extracted text
is sparse and whose markup looks like a client-rendered application. JSON,
PDFs, feeds, plain text, and HTTP errors never launch a browser.

Each render uses a random `agent-browser` namespace and session, an empty locked
config file, origin-scoped `--allowed-domains`, untrusted-content boundaries,
and no profile, restore state, auto-connect, or state autosave. It opens the
final URL, waits for `DOMContentLoaded`, reads agent-oriented page content, then
closes the browser and removes its temporary config. The executable is invoked
directly—`browserCommand` is not evaluated by a shell.

## Sandbox and validation

Tool policy controls whether `WebSearch` / `WebFetch` exist. The native sandbox
separately controls which network destinations they may contact:

- `network.mode: "none"` blocks every web request.
- `localhost` admits the local SearXNG companion but blocks public keyless
  search and public fetches.
- an allowlist must include the local endpoint, `chatgpt.com` for Codex search,
  plus every public destination
  the agent is authorized to search or fetch.
- `all` permits public egress while retaining filesystem enforcement.

`mono-agent validate` adds a **Web search & fetch** section. With liveness
enabled it sends a bounded JSON query to a configured SearXNG endpoint. Strict
`codex` mode also verifies ChatGPT login, web-search capability, and model
availability; `auto` checks that fallback lazily only if a search reaches it.
When rendering is enabled, validation checks that `browserCommand --version`
reports `agent-browser` 0.33.1 or newer. `liveness: false` skips external probes
without changing structural validation.

## Security and observability

Search snippets, the actual search query, and fetched pages are always labelled
untrusted. WebSearch output includes bounded backend/query/provenance metadata
so fallback behavior is inspectable, while sanitized failures expose only a
backend and stable category. Timing events retain only bounded operational
fields such as status, error code, backend, attempt count, byte count,
HTTP/exit status, timeout, rendered, cache-hit, truncation flags, queue wait,
backend time, cooldown skips and quota skips; request
headers and command arguments stay out of them.

The tools are public-web readers, not an authenticated browsing surface. Codex
uses an existing ChatGPT subscription only as the search transport; neither
search results nor model-visible output receives account data. The tools do not
expose browser profiles, cookies, login state, file downloads, arbitrary
headers, or remote SearXNG credentials.
