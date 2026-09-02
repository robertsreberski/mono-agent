---
title: "Local-first web research agent"
description: "Build a Pi agent that searches through loopback SearXNG and fetches pages with static extraction plus optional isolated rendering."
sidebar:
  order: 12
---

This playbook gives a Pi-backed mono-agent a reliable public-web research path:
local SearXNG for discovery, deterministic result fusion, local content
extraction, and optional isolated browser rendering for sparse JavaScript pages.
SearXNG and the browser run locally, but fetched/search-engine traffic still
leaves the machine.

## 1. Provision an optional SearXNG instance

Mono-agent does not ship or manage SearXNG. Provision an operator-owned
instance by following the upstream
[container installation guide](https://docs.searxng.org/admin/installation-docker),
bind it to loopback, and enable JSON search responses. Configure at least one
engine that works from the operator network, then verify the exact API that
`WebSearch` uses:

```bash
curl --fail --silent --show-error \
  --request POST \
  --header 'Accept: application/json' \
  --data 'q=mono-agent&format=json&categories=general' \
  http://127.0.0.1:8088/search
```

The examples below assume the independently managed service listens at
`http://127.0.0.1:8088`. Keep credentials out of the endpoint URL; mono-agent's
SearXNG transport is deliberately unauthenticated and loopback-only.

## 2. Configure the agent

Create an agent through the ordinary guided path, then keep the managed web
tools enabled and add their local-first settings:

```json
{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.5",
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md"
  },
  "tools": {
    "allowedTools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    "web": {
      "search": {
        "backend": "searxng",
        "endpoint": "http://127.0.0.1:8088"
      },
      "fetch": {
        "render": "never",
        "browserCommand": "agent-browser"
      }
    }
  },
  "sandbox": {
    "mode": "native",
    "network": {
      "mode": "all",
      "allowlist": []
    },
    "readableRoots": ["."],
    "writableRoots": ["."],
    "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"],
    "fallback": "fail-closed",
    "unsafeAllowHostProcess": false
  }
}
```

Strict `searxng` mode makes companion failure explicit. Change it to `auto` to
fall through to ChatGPT-subscription Codex search and then DuckDuckGo/Startpage.
The existing `codex` CLI must be signed in with ChatGPT; mono-agent consumes
only app-server's structured search sources and never extracts OAuth tokens.

`network.mode: "all"` is required here because SearXNG itself contacts public
engines and `WebFetch` contacts the result sites. A narrower allowlist works
only when the research targets are known in advance. `localhost` admits
SearXNG but blocks public page fetches.

## 3. Optionally enable browser rendering

Static Defuddle/Readability extraction is the safe default and handles ordinary
HTML, JSON, feeds, PDFs, and text without a browser.

For client-rendered sites:

```bash
npm install --global agent-browser@0.33.1
agent-browser install
```

Then change:

```json
{
  "tools": {
    "web": {
      "fetch": {
        "render": "auto",
        "browserCommand": "agent-browser"
      }
    }
  }
}
```

`auto` renders only successful, sparse, SPA-like HTML. Each render gets a fresh
anonymous namespace and closes after the fetch; it does not reuse a personal
Chrome profile.

## 4. Validate and start

```bash
mono-agent validate
mono-agent start
```

Require these lines in the validation report:

- **WebSearch backend: searxng**
- **SearXNG JSON search probe succeeded**
- **WebFetch browser rendering: never**, or an `agent-browser` version at least
  0.33.1 when rendering is enabled

The probe fails when the endpoint answers with an empty result set *and* one or
more unresponsive engines — a fully blocked instance still returns `HTTP 200`,
so treat that `[WARN]` as "search is down", not as a slow start. Fix the engine
selection in the operator-owned SearXNG instance before continuing.

## 5. Smoke the real tools

From an enabled channel or the TUI, ask:

```text
Search for the current SearXNG settings documentation using two query variants.
Fetch the strongest official result. Report the page title and which search and
fetch backends the tool results used.
```

The run artifact should contain:

- one or more `WebSearch` calls with ranked, canonical URLs;
- one `WebFetch` result wrapped as untrusted web content;
- bounded `tool_timing` metadata (`backend`, attempts, bytes, HTTP status,
  cache/render flags) without the query or URL;
- no duplicate network work when an identical call repeats within that run.

See [Local-first web research](/tools/web-research/) for all parameters,
failure behavior, extraction formats, retries, browser isolation, and sandbox
interactions.
