---
title: "Local-first web research agent"
description: "Build a Pi agent that searches through explicit Ollama or loopback SearXNG and fetches pages with deterministic static extraction plus optional isolated rendering."
sidebar:
  order: 12
---

This playbook gives a Pi-backed mono-agent a reliable public-web research path:
explicit Ollama or local SearXNG for discovery, deterministic result fusion, local content
extraction, and optional isolated browser rendering for sparse JavaScript pages.
SearXNG and the browser run locally, but fetched/search-engine traffic still
leaves the machine.

## 1. Provision an optional SearXNG instance

Mono-agent does not ship or manage SearXNG. The current upstream Compose
template publishes on every host interface unless `SEARXNG_HOST` is set, and
the current default `search.formats` contains only `html`. Use the upstream
[container template](https://github.com/searxng/searxng/blob/master/container/docker-compose.yml)
with both defaults overridden explicitly:

```bash
searxng_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mono-agent/searxng"
umask 077
mkdir -p "$searxng_dir/core-config"
cd "$searxng_dir"
curl --fail --silent --show-error --location --remote-name \
  https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml
curl --fail --silent --show-error --location --output .env.example \
  https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example
cp -i .env.example .env
searxng_secret="$(openssl rand -hex 32)"
{
  printf '\nSEARXNG_HOST=127.0.0.1\n'
  printf 'SEARXNG_PORT=8088\n'
  printf 'SEARXNG_BASE_URL=http://127.0.0.1:8088/\n'
  printf 'SEARXNG_SECRET=%s\n' "$searxng_secret"
} >> .env
unset searxng_secret
cat > core-config/settings.yml <<'YAML'
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  secret_key: "overridden-by-SEARXNG_SECRET"
  limiter: false
  public_instance: false
  image_proxy: false
YAML
```

Review the downloaded template as upstream recommends, configure at least one
engine that works from the operator network, then validate and start it:

```bash
docker compose --project-name mono-agent-searxng config --quiet
docker compose --project-name mono-agent-searxng up -d
test "$(docker compose --project-name mono-agent-searxng port core 8088)" = \
  "127.0.0.1:8088"
```

The exact port assertion proves Docker published only IPv4 loopback. Verify the
JSON contract that `WebSearch` uses, including the required result-array shape:

```bash
curl --fail --silent --show-error \
  --request POST \
  --header 'Accept: application/json' \
  --data 'q=mono-agent&format=json&categories=general' \
  http://127.0.0.1:8088/search \
  | node --input-type=module -e '
let body = "";
for await (const chunk of process.stdin) body += chunk;
const value = JSON.parse(body);
if (!Array.isArray(value.results)) throw new Error("missing results array");
const blocked = Array.isArray(value.unresponsive_engines) ? value.unresponsive_engines : [];
if (value.results.length === 0 && blocked.length > 0) {
  throw new Error(`empty results with unresponsive engines: ${JSON.stringify(blocked)}`);
}
console.log(`JSON API OK: ${value.results.length} result(s)`);
'
```

The examples below assume the independently managed service listens at
`http://127.0.0.1:8088`. Keep credentials out of the endpoint URL; mono-agent's
SearXNG transport is deliberately unauthenticated and loopback-only.

### Migrate an existing repository-managed Compose project

In a reused checkout, the ignored legacy `.env` may remain after the tracked
Compose files are removed. From the repository root, copy that secret and the
last compatible Compose contract into a new operator-owned directory:

```bash
legacy_searxng_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mono-agent/searxng-retired"
node scripts/migrate-retired-searxng.mjs --destination "$legacy_searxng_dir"
docker compose --project-name mono-agent-searxng \
  --file "$legacy_searxng_dir/compose.yaml" \
  --project-directory "$legacy_searxng_dir" config --quiet
docker compose --project-name mono-agent-searxng \
  --file "$legacy_searxng_dir/compose.yaml" \
  --project-directory "$legacy_searxng_dir" ps
```

Pass `--env-file <path>` if the old `.env` is elsewhere. The migration accepts
exactly one 64-hex `SEARXNG_SECRET` and writes a fresh `.env` containing only
that assignment, so legacy Compose control variables cannot change the project.
It fails closed when the secret is invalid or missing, the canonical destination
is inside this repository, another path owns the destination, or the canonical
parent is not owned by the current user or is group/world writable. It builds
and verifies one complete random sibling directory, then exposes that directory
with one rename. A crash before the rename leaves the destination absent; a
retry uses a new staging directory. A crash after the rename leaves the exact
complete bundle, which a retry accepts idempotently. The bundle preserves the
project name `mono-agent-searxng` and cache volume
`mono-agent-searxng_cache`, and the command makes **no Docker calls**: it does
not start, stop, restart, or recreate a container and does not remove a volume.
The source `.env` remains in place until the operator removes it after a
verified cutover.

This migration is supported only on POSIX local filesystems where Node exposes
`process.getuid()` and Unix ownership and mode metadata are authoritative. It
fails closed before creating staging on unsupported platforms, including
Windows; native Windows ACL ownership validation is not implemented. The
implementation does not claim protection from an actively hostile same-UID
process in the final check-to-rename syscall window, power loss without
filesystem durability, or non-local/NFS rename semantics. Do not use a shared
or adversarially writable parent for this migration.

The existing container still has its old bind-mount source. During an operator-
chosen maintenance window, cut it over to the new path, then verify the
migrated service's distinct Compose service and container port:

```bash
docker compose --project-name mono-agent-searxng \
  --file "$legacy_searxng_dir/compose.yaml" \
  --project-directory "$legacy_searxng_dir" up -d --no-deps searxng
test "$(docker compose --project-name mono-agent-searxng \
  --file "$legacy_searxng_dir/compose.yaml" \
  --project-directory "$legacy_searxng_dir" port searxng 8080)" = \
  "127.0.0.1:8088"
curl --fail --silent --show-error \
  --request POST \
  --header 'Accept: application/json' \
  --data 'q=mono-agent&format=json&categories=general' \
  http://127.0.0.1:8088/search \
  | node --input-type=module -e '
let body = "";
for await (const chunk of process.stdin) body += chunk;
const value = JSON.parse(body);
if (!Array.isArray(value.results)) throw new Error("missing results array");
const blocked = Array.isArray(value.unresponsive_engines) ? value.unresponsive_engines : [];
if (value.results.length === 0 && blocked.length > 0) {
  throw new Error(`empty results with unresponsive engines: ${JSON.stringify(blocked)}`);
}
console.log(`JSON API OK: ${value.results.length} result(s)`);
'
```

That explicit command may recreate the container; the migration command never
runs it. If the service is later retired permanently, choose one cleanup:

```bash
# Stop/remove the container and network, but retain the named cache volume.
docker compose --project-name mono-agent-searxng \
  --file "$legacy_searxng_dir/compose.yaml" \
  --project-directory "$legacy_searxng_dir" down

# Destructive opt-in: also delete the named cache volume.
docker compose --project-name mono-agent-searxng \
  --file "$legacy_searxng_dir/compose.yaml" \
  --project-directory "$legacy_searxng_dir" down --volumes
```

Do not run the second form unless deleting the cache is intentional. See the
upstream [container operations and volume documentation](https://docs.searxng.org/admin/installation-docker.html#volumes)
before changing the migrated deployment.

## 2. Configure the agent

Create an agent through the ordinary guided path, then keep the managed web
tools enabled and add their local-first settings:

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.5",
    "workspace": "."
  },
  "context": {
    "identityPath": "./IDENTITY.md"
  },
  "tools": {
    "allowedTools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    "web": {
      "coordination": "host",
      "search": {
        "backend": "searxng",
        "searxng": { "endpoint": "http://127.0.0.1:8088" }
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

`coordination: "host"` shares admission and cooldowns with other opted-in agents
under this OS user; it does not start a service. Inspect with
`mono-agent web-control status --json`.

Strict `searxng` mode makes companion failure explicit. Change it to `auto` to
fall through to ChatGPT-subscription Codex search and then DuckDuckGo/Startpage.
The existing `codex` CLI must be signed in with ChatGPT; mono-agent consumes
only app-server's structured search sources and never extracts OAuth tokens.

To use a signed-in local Ollama daemon instead, replace the search block with:

```json
{ "search": { "backend": "ollama" } }
```

This defaults to `http://127.0.0.1:11434` and sends no credential. Hosted
Ollama Web Search is explicit and host-bound:

```json
{
  "search": {
    "backend": "ollama",
    "ollama": { "baseUrl": "https://ollama.com", "apiKeyEnv": "OLLAMA_API_KEY" }
  }
}
```

Set the named variable outside repository config. Mono-agent never auto-reads
it, never sends it to a different origin, and never falls back from strict
Ollama to another provider. Existing top-level `search.endpoint` remains a
SearXNG compatibility alias; use `search.searxng.endpoint` for new config.

`network.mode: "all"` is required here because SearXNG itself contacts public
engines and `WebFetch` contacts the result sites. A narrower allowlist works
only when the research targets are known in advance. `localhost` admits
SearXNG but blocks public page fetches.

## 3. Optionally enable browser rendering

Static Defuddle/Readability/Turndown extraction is the safe default and handles ordinary
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

Use `render: "always"` in one `WebFetch` call only for a known JavaScript page
or when `browserRecommended` is reported. That call is browser-first. It does
not bypass login, CAPTCHA, Cloudflare, robots/access controls, or site policy.

`auto` renders only successful, sparse, SPA-like HTML. Each render gets a fresh
anonymous namespace and closes after the fetch; it does not reuse a personal
Chrome profile.

## 4. Validate and start

```bash
mono-agent validate
mono-agent start
```

Require the validation lines for the selected backend:

- strict SearXNG: **WebSearch backend: searxng.** and
  **SearXNG JSON search probe succeeded.** (`auto` with a configured SearXNG
  endpoint also requires the successful SearXNG probe)
- strict Ollama: **WebSearch backend: ollama.** and
  **Ollama Web Search JSON probe succeeded.**
- every backend: **WebFetch browser rendering: never.**, or an `agent-browser`
  version at least 0.33.1 when rendering is enabled

The SearXNG probe fails when the endpoint answers with an empty result set *and*
one or more unresponsive engines — a fully blocked instance still returns
`HTTP 200`, so treat that `[WARN]` as "search is down", not as a slow start. Fix
the engine selection in the operator-owned SearXNG instance before continuing.
An Ollama probe failure is likewise terminal in strict `ollama` mode; it never
falls through to another search provider.

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

## Researcher instructions

Start with one narrow query; supply alternates only for a plausible empty result.
Fetch the strongest sources and request bounded line slices for long documents.
Respect cooldown and quota errors instead of repeating the same request or
spawning more search workers. Cite retrieved sources and check publication dates
when freshness matters. Enable host coordination in every participating agent;
an agent left in process mode does not join the shared budget.
