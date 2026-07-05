# @mono-agent/session-web

Discovers local mono-agent instances and serves a read-only **web PWA** that
visualises their runs in real time — the browser counterpart to the TUI. It is
the single backend the browser talks to: it aggregates recorded-run history (from
each instance's artifact dir) with live sub-run streams (from each running
agent's `live-adapter`), and never drives an agent.

## Category

Category: `operator-surface`

A drop-in operator surface, like `@mono-agent/tui`: launched separately, it
discovers everything on the machine via the trace-source registry.

## Responsibility

- Discover instances (registry `listTraceSources`/`mergeTraceSources`), exposing
  name, cwd, `artifactDir`, health, and the optional `live` SSE endpoint.
- Read recorded runs per instance and map them to the UI `Session` model
  (`mapRunToSession`, from `@mono-agent/observability`).
- Watch artifact dirs (run-level) and connect to `live-adapter` SSE (sub-run);
  fold both into one live session model.
- Serve the built PWA (`express.static`), a JSON API, and a browser SSE stream.

## Install / Usage

```ts
import { startSessionWebServer } from "@mono-agent/session-web";

const server = await startSessionWebServer({
  registryDirs: ["/Users/me/.mono-agent/trace-sources"],
  host: "127.0.0.1",
  port: 4599,
});
console.log(server.url);
await server.stop();
```

The `mono-agent web` CLI command wraps this with registry resolution + browser open.
Loopback on port `4599` is the default. Startup prints the exact URL to target
from reverse proxies. A non-loopback bind requires `allowNonLoopback: true`
and an `authToken`; `/api/*` and `/api/stream` require `Authorization: Bearer
<token>` (or `?token=<token>` for browser `EventSource`).

Run lists and the initial browser SSE snapshot are summary-only and step-less.
Full run timelines are read lazily from `/api/sessions/:sourceId/:runId` when a
detail view opens.

## Public API

- `startSessionWebServer(options)` → `{ url, stop() }`.
- `discoverWebInstances(options)` and the `Session`/`SessionStep`/`WebInstance` types.

## Dependency Boundary

Depends only on `core` + `observability`: `@mono-agent/agent-contracts`,
`@mono-agent/settings`, `@mono-agent/observability`. Plus `express`. It reaches
`live-adapter` endpoints **over HTTP only** — it does not (and, per the
architecture rule, may not) depend on that `communication` package. The browser
SPA lives in the isolated `webapp/` sub-project (its own lockfile), built to
`webapp/dist` and served statically.

## What This Package Does Not Own

- The agent-side broadcast tap or the `live` channel driver.
- Turn-driving / any write path to an agent (read-only by construction).
- The recorder, the trace-source registry writer, or run persistence.

## Verification

```sh
pnpm --filter @mono-agent/session-web... run build
pnpm --filter @mono-agent/session-web run test
```
