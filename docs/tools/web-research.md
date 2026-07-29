---
title: "Local-first web research"
description: "Configure WebSearch and WebFetch with local SearXNG, static extraction, and isolated browser rendering."
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
        "endpoint": "http://127.0.0.1:8088"
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
| `tools.web.fetch.render` | `MONO_AGENT_WEB_FETCH_RENDER` | `never` |
| `tools.web.fetch.browserCommand` | `MONO_AGENT_WEB_BROWSER_COMMAND` | `agent-browser` |

## WebSearch

Search backends have explicit behavior:

| Backend | Behavior |
| --- | --- |
| `auto` | Try configured SearXNG first; if that request fails, use the keyless chain. Without an endpoint, start with the keyless chain. |
| `searxng` | Require the configured local endpoint and fail when it fails. No silent fallback. |
| `keyless` | Skip SearXNG and try DuckDuckGo HTML, then Startpage. |

The tool accepts one `query`, up to three `alternate_queries`, a result `limit`
from 1–10, `domains`, `exclude_domains`, `language`, and a `time_range` of
`day`, `month`, or `year`. Query variants run concurrently in a deterministic
order. Results are normalized, tracking parameters are removed, duplicates are
fused with reciprocal-rank fusion, and include/exclude domain filters are
enforced again on returned URLs.

An empty result set is a successful answer (`No results.`). A tool error means
every eligible backend failed or policy blocked every request; the result keeps
that distinction so the model does not waste another reasoning round repeating
the same call.

For the copyable local companion, see
[`demos/searxng`](https://github.com/robertsreberski/mono-agent/tree/main/demos/searxng).
Its Compose service is loopback-only and enables SearXNG's JSON format.

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
- an allowlist must include the local endpoint plus every public destination
  the agent is authorized to search or fetch.
- `all` permits public egress while retaining filesystem enforcement.

`mono-agent validate` adds a **Web search & fetch** section. With liveness
enabled it sends a bounded JSON query to a configured SearXNG endpoint and, when
rendering is enabled, checks that `browserCommand --version` reports
`agent-browser` 0.33.1 or newer. `liveness: false` skips both external probes
without changing structural validation.

## Security and observability

Search snippets and fetched pages are always labelled untrusted. Tool-result
details deliberately omit the query, URL, request headers, and command
arguments. Timing events retain only bounded operational fields such as status,
error code, backend, attempt count, byte count, HTTP/exit status, timeout,
rendered, cache-hit, and truncation flags.

The tools are public-web readers, not an authenticated browsing surface. They
do not expose browser profiles, cookies, login state, file downloads, arbitrary
headers, or remote SearXNG credentials.
