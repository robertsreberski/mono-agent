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

Review a new image tag and digest before changing the pin. `docker compose
down` leaves the named cache volume intact; add `--volumes` only when you
deliberately want to remove it.
