# @mono-agent/session-web

Discovers local mono-agent instances and serves a read-only **web PWA** that
visualises their runs in real time — the browser counterpart to the TUI. It is
the single backend the browser talks to: it aggregates recorded-run history (from
each instance's artifact dir) with live sub-run streams (from each running
agent's operator-adapter live endpoint), and never drives an agent.

## Category

Category: `operator-surface`

A drop-in operator surface, like `@mono-agent/tui`: launched separately, it
discovers everything on the machine via the trace-source registry.

## Responsibility

- Discover instances (registry `listTraceSources`/`mergeTraceSources`), exposing
  name, cwd, `artifactDir`, process health, independent typed memory health, and
  the optional `live` SSE endpoint.
- Read recorded runs per instance and map them to the UI `Session` model
  (`mapRunToSession`, from `@mono-agent/observability`).
- Watch artifact dirs (run-level) and connect to operator-adapter live SSE (sub-run);
  fold both into one live session model.
- Serve the built PWA (`express.static`), a JSON API, and a browser SSE stream.

## Install / Usage

```ts
import { startSessionWebServer } from "@mono-agent/session-web";

const server = await startSessionWebServer({
  registryDirs: ["/Users/me/.mono-agent/trace-sources"],
  host: "127.0.0.1",
  port: 4599,
  // Defaults to agent runs only. Uncomment to include memory-maintenance runs.
  // includeMemory: true,
});
console.log(server.url);
await server.stop();
```

The `mono-agent web` CLI command wraps this with registry resolution + browser open.
Loopback on port `4599` is the default. Startup prints the exact URL to target
from reverse proxies. A non-loopback bind requires `allowNonLoopback: true`
and an `authToken`; `/api/*` and `/api/stream` require `Authorization: Bearer
<token>`. The PWA consumes SSE with authenticated `fetch`, so the bearer never
appears in the stream URL. CLI bootstrap URLs use a fragment that is not sent
to the server and is removed from browser history after capture. A configured
token is also enforced when the server binds loopback.

For each browser origin, the PWA mirrors a captured or manually entered token
into current-tab `sessionStorage` as
`mono-agent.session-web.authToken` and persistent `localStorage` as
`mono-agent.session-web.authToken.persisted`. The persistent copy survives page
reloads, tab or browser closes, and browser restarts. It remains until a
401/403 response exposes the authentication form and its **Clear** action
removes both copies, or you clear the site's browser storage/site data; closing
the browser alone does not sign out.

For direct LAN/Tailscale access, the CLI can bind the server itself; Tailscale
Serve is not a prerequisite:

```bash
MONO_AGENT_WEB_AUTH_TOKEN='<strong-stable-token>' \
  mono-agent web --host 0.0.0.0 --allow-non-loopback --no-open
```

Startup advertises concrete loopback, private-LAN, and Tailscale IPv4 URLs, not
`0.0.0.0`. Direct Tailscale HTTP is protected by the tailnet transport; plain
LAN HTTP is not encrypted. Use Tailscale Serve (or another HTTPS proxy) only
when HTTPS-dependent browser behavior such as installable/offline PWA support
is required.

Run lists and the initial browser SSE snapshot are summary-only and step-less.
Full run timelines are read lazily from `/api/sessions/:sourceId/:runId` when a
detail view opens.
`/api/sessions` supports `instance`, `limit`, and `offset` query parameters and
returns page metadata (`total`, `offset`, `limit`, `hasMore`) so the browser can
load older history without replaying already-loaded rows. Stale `running`
summaries are projected as `stalled` in the web surface instead of being treated
as live.
Instance metadata includes the source timezone when it is discoverable; the PWA
uses that timezone for per-instance run lists and details, and falls back to the
viewer locale/timezone for mixed-instance views. Failure summaries preserve
`failureKind`, error text, and provider failover attempts so failed runs are
inspectable from the list and detail views.
Memory-maintenance runs are hidden by default across disk history, watched
updates, API responses, browser SSE frames, and live folds; pass
`includeMemory: true` to opt them back in.

Instance cards render memory separately from process/live health: healthy is
green, in-progress teal, degraded amber, unhealthy red, and unknown/off gray.
Accessible labels/tooltips contain only the status and stable closed issue
codes. The aggregator compares typed `memoryHealth` values during discovery;
a memory-only registry change emits an `instances` browser SSE frame, so the
badge refreshes without a new run or process-health transition.
Backend-discriminated normalization prevents impossible remote/absent combinations
from rendering green, and overlapping registry reconciles are single-flight with
one bounded trailing replay so an older read cannot replace newer health.
The browser also revalidates the closed, canonical issue list and partial count
relationships so malformed raw runtime data fails closed to `unknown` without
surfacing provider text or unknown keys.

## Public API

- `startSessionWebServer(options)` → `{ url, boundAddress, stop() }`
  (`boundAddress` is Node's post-listen address for safety checks and wildcard
  advertisement; `includeMemory` defaults to `false`; `true` includes
  memory-maintenance runs in history/API/SSE/live frames).
- `discoverWebInstances(options)` and the `Session`/`SessionStep`/`WebInstance`
  types (`WebInstance.memoryHealth` carries the normalized trace-source health).

## Dependency Boundary

Depends only on `core` + `observability`: `@mono-agent/agent-contracts`,
`@mono-agent/observability`. Plus `express`. It reaches
operator-adapter live endpoints **over HTTP only** — it does not (and, per the
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
