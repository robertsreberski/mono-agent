# Local SearXNG companion

This optional, operator-owned companion gives mono-agent's `WebSearch` tool a
private loopback search endpoint. Mono-agent never starts, stops, upgrades, or
persists this container.

The image is pinned to the reviewed multi-architecture SearXNG
`2026.7.26-b060c780d` manifest. The service binds only to
`127.0.0.1:8088`, enables the JSON search format required by `WebSearch`, and
disables public-instance features, the limiter, and image proxying. It still
queries public search engines, so it is local infrastructure rather than an
offline search index.

## Engine selection

`settings.yml` overrides which engines are enabled, and this is not cosmetic:
the stock general set is unusable from an ordinary residential IP. DuckDuckGo,
Startpage and Qwant all answer with a CAPTCHA and `google cse` needs an API key
this instance does not carry, which leaves *every* query returning `HTTP 200`
with an empty result list.

Enabled instead: **bing** (the workhorse), plus **mwmbl** and **marginalia** —
small independent indexes kept for redundancy, because a single engine
eventually suspends under the query fan-out one `WebSearch` produces. **brave**
stays on from the defaults; it works but rate-limits too readily to carry the
load alone. Entries merge into the image defaults by name, so each override only
flips a `disabled` flag.

Verify an engine before enabling it — some are enabled-but-broken in a given
image and return zero results with no error at all:

```bash
curl --silent --request POST \
  --data 'q=best+time+to+visit+japan&format=json&engines=bing' \
  http://127.0.0.1:8088/search
```

## Start

```bash
cd demos/searxng
cp .env.example .env
openssl rand -hex 32
```

Put the generated value after `SEARXNG_SECRET=` in `.env`, then start the
companion:

```bash
docker compose up -d
docker compose ps
```

Verify the exact JSON API mono-agent uses:

```bash
curl --fail --silent --show-error \
  --request POST \
  --header 'Accept: application/json' \
  --data 'q=mono-agent&format=json&categories=general' \
  http://127.0.0.1:8088/search
```

## Configure mono-agent

Strict local-only search:

```json
{
  "tools": {
    "web": {
      "search": {
        "backend": "searxng",
        "endpoint": "http://127.0.0.1:8088"
      }
    }
  }
}
```

Use `"backend": "auto"` to try this endpoint first and fall back to the
keyless public-search adapters when it is unavailable.

Run `mono-agent validate` after editing the config. Its **Web search & fetch**
section performs a bounded JSON search probe when liveness checks are enabled.

## Operate

```bash
docker compose logs --tail 100 searxng
docker compose pull
docker compose down
```

`settings.yml` is bind-mounted, so an engine change needs only a restart — the
container re-reads it on boot, and the restart also clears the in-memory engine
suspensions that accumulate over a long uptime:

```bash
docker compose restart searxng
```

### Every query returns zero results

Check `unresponsive_engines` in the JSON response:

```bash
curl --silent --request POST \
  --data 'q=test&format=json&categories=general' \
  http://127.0.0.1:8088/search
```

An empty `results` array alongside a populated `unresponsive_engines` means the
engines are blocked, not that nothing matched — `WebSearch` reports this as an
error naming each engine, and `mono-agent validate` shows it as a `[WARN]` under
**Web search & fetch**. SearXNG suspends an engine with a growing backoff after
repeated failures, so an instance that has been up for days can be far worse off
than a freshly restarted one. Restart it, then re-probe the engines
individually and enable a working one.

Review a new image tag and digest before changing the pin. `docker compose
down` leaves the named cache volume intact; add `--volumes` only when you
deliberately want to remove it.
