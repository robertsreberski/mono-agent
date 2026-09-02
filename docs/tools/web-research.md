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
browser namespace close at the end of the run. Nothing creates a durable search
history, cookie jar, or browser profile.

## Recommended configuration

The framework defaults to keyless search fallback and static fetch extraction:

```json
{
  "tools": {
    "web": {
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
`day`, `month`, or `year`. Query variants run concurrently in a deterministic
order for local and keyless search. Quotes and `site:` operators are never
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
subscription searches are serialized process-wide, while the ordinary
successful-result cache still prevents repeated calls for the same request.

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
engine that works from the operator network and check it directly with
`curl -sS -X POST http://127.0.0.1:8088/search -d 'q=test&format=json'`.

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

Three bounds keep an agent from provoking the block in the first place. All are
process-wide, because a single turn can fan out four query variants per search
and every subagent runs its own web controller:

- at most **3** keyless requests in flight at once;
- at least **1.5 s** between two requests to the same engine (only a multi-query
  fan-out pays this; a single-query search never waits);
- an engine that signals throttling is **skipped for 5 minutes**, so the chain
  falls through to the next backend instead of re-hitting a blocked one.

Successful searches are cached process-wide for **15 minutes**, keyed by the
query parameters *and* the backend configuration, so sibling subagents and later
turns reuse a result instead of re-querying. Failures are never cached.

`outcome.rateLimited` and `outcome.cooldownBackends` report throttling even when
a fallback backend rescued the query, so a silent degradation stays visible.

### Search-heavy agents should not rely on the keyless chain

The keyless engines are a fallback, not a budget. An agent that issues tens of
searches per turn — subagent fan-out especially — will eventually be blocked no
matter how politely it is throttled. Point such an agent at a local SearXNG:

```json
{ "tools": { "web": { "search": { "backend": "searxng", "endpoint": "http://127.0.0.1:8088" } } } }
```

Provision the instance independently using the upstream
[container installation guide](https://docs.searxng.org/admin/installation-docker),
bind it to loopback, and enable SearXNG's JSON format.

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

### Browser rendering

The tool call may request `render: "never"`, `"auto"`, or `"always"`, but the
agent config is the authority:

- Config `never` is a capability ceiling: every call stays static, even if
  model input requests `always`.
- Config `auto` lets individual calls request or automatically trigger browser
  rendering.
- Call `always` is strict: a rendering failure is a tool error.
- Call `auto` falls back to the successful static extraction if rendering fails.

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
HTTP/exit status, timeout, rendered, cache-hit, and truncation flags; request
headers and command arguments stay out of them.

The tools are public-web readers, not an authenticated browsing surface. Codex
uses an existing ChatGPT subscription only as the search transport; neither
search results nor model-visible output receives account data. The tools do not
expose browser profiles, cookies, login state, file downloads, arbitrary
headers, or remote SearXNG credentials.
