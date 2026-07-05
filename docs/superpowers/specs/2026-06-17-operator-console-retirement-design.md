# Operator Console Retirement

> Scope: retire the `@mono-agent/operator-console` package entirely now that Phoenix
> is the trace viewer and config is JSON-first / agent-edited. Live config re-apply
> via the browser is dropped in favor of restart-to-apply.
> Date: 2026-06-17. Status: approved direction, ships in the same PR as the Phoenix
> observability exporter.

## 1. Goal

Remove the bespoke browser operator console. Two of its three capabilities are now
redundant:

- **Trace viewing** is replaced by the Phoenix OTLP exporter (see
  `2026-06-17-phoenix-observability-design.md`).
- **Browser settings editing** is redundant: config is JSON-first and most edits are
  made by AI agents directly against `mono-agent.config.json`.

The third capability — **live config re-apply** (reloading channels/memory without a
host restart, triggered by the console's `PUT /api/config`) — is intentionally dropped.
Config changes take effect on the next `mono-agent restart`.

The successful end state is:

- `@mono-agent/operator-console` no longer exists in the workspace.
- `@mono-agent/agent-app` runs headless with no console startup, no console config
  fields, and no `--no-console` flag.
- Manual and agent JSON edits apply on restart. There is no browser control plane.
- Trace-source registration and `mono-agent status` host discovery are unchanged.
- The agent self-capabilities live-apply path is unchanged.

## 2. Non-goals

- Do not remove `applyConfigChange` from `@mono-agent/agent-app`. The self-capabilities
  system (`app.ts:588`) still calls it to re-apply config the agent writes about itself.
  Only the *console* trigger (`applyConfigWrite` wiring) is removed.
- Do not remove trace-source registration, heartbeat, or stop. `mono-agent status`
  reads the registry to discover running hosts.
- Do not remove the trace-run reader API from `@mono-agent/observability`
  (`listTraceSources` / `listTraceRuns` / `readTraceRun` / `listRecordedRuns` /
  `readRecordedRun`). It is published library surface and `status` uses
  `listTraceSources`; it simply loses the console as a consumer.
- Do not change the Phoenix exporter behavior shipped in the companion spec.

## 3. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Delete the whole package, not just the trace view | Both the trace view and the settings form are redundant; keeping the HTTP server only to host a redundant form is not worth the dependency surface (vite/react/radix/tailwind). |
| 2 | Drop live-apply; restart to apply | Manual JSON edits already required a restart today — the console `PUT` was the only live trigger. Removing it changes nothing for hand edits. Confirmed acceptable: the live `~/local-agent-alpha` will need `mono-agent restart` (brief downtime) to pick up config changes. |
| 3 | Keep `applyConfigChange` | It is shared infrastructure: self-capabilities depends on it. Removing it would regress an unrelated feature. |
| 4 | Keep the observability trace-run readers | Published library API; `status` host discovery uses `listTraceSources`. Removing it is out of scope and would be a separate breaking change. |
| 5 | One combined PR with the Phoenix exporter | Operator preference. The deletion is gated behind the Phoenix smoke test, which the operator runs before merge. |

## 4. Capability Disposition

The console bundles three capabilities (from the dependency map):

- **(a) Trace view** — `src/server/traceability.ts` + `src/server/observability.ts` +
  `TraceabilityView.tsx`. Replaced by Phoenix. Deleted.
- **(b) Settings editing** — `src/server/handlers.ts` (`GET/PUT /api/config`, `/api/schema`)
  + `ConfigForm.tsx`. Redundant with JSON-first config. Deleted.
- **(c) Live-apply** — `applyConfigWrite` callback → `controller.applyConfigChange(...)`.
  The *trigger* is deleted; the orchestration (`applyConfigChange`) stays for
  self-capabilities.

## 5. Removal Plan

### 5.1 Delete the package

- Delete `packages/operator-console/` entirely.

### 5.2 `@mono-agent/agent-app`

- Remove the console launch path (`app.ts` console startup, the `operatorConsoleFactory`
  option, the `applyConfigWrite` → `applyConfigChange("operator-console-write")` wiring,
  and `app.operatorConsole`). **Keep** `applyConfigChange` and its self-capabilities and
  reload-from-config call sites.
- Remove `consoleFieldGroup` (`console.enabled`, `console.port`) from `app-config.ts`,
  the `MONO_AGENT_APP_FIELD_GROUPS` registration, and the `consoleFieldGroup` re-export
  in `index.ts`.
- Remove the `--no-console` / `noConsole` flag through `cli.ts`, `background.ts`,
  `launchd.ts`.
- Replace any "tokenized console link" language in start/status/doctor output with the
  Phoenix + "JSONL artifacts remain local" guidance already added by the exporter work.
  Remove the console base-URL line from the detached status output.
- Drop the `@mono-agent/operator-console` dependency from `package.json`.
- **Keep** trace-source registration, heartbeat, update, and stop unchanged.

### 5.3 Demos

- `demos/final-agent`: remove console wiring from `cli.ts`, `deploy-cli.ts`, and
  `final-demo.ts` (the `operatorConsoleFactory` override and the custom
  `applyConfigWrite`/restart-notice paths). Update affected demo tests
  (`final-demo.test.ts`, `deployment.test.ts`, etc.). Historical note: the former
  multi-agent source demo has since been removed.

### 5.4 TUI

- Update the stale `packages/tui/src/config/pane.ts` comment that says edits are
  delegated to the console; edits now go through JSON + restart.

### 5.5 Plumbing & docs

- Remove the `operator-console` entry from `scripts/package-catalog.mjs`.
- Remove `@mono-agent/operator-console` from root `package.json` devDependencies.
- Update the release lockstep snapshot test count (publishable package count drops by one).
- `README.md` / `PACKAGES.md`: remove console from the dependency diagram and capability
  matrix; the "Host Traceability" section recommends Phoenix and keeps JSONL as the local
  fallback (no console mention).
- `docs/feature-registry.md`: remove the `operator-console.http` and
  `operator-console.live-apply` rows.
- Final `0.3.x` release: after merge, deprecate `@mono-agent/operator-console` on npm
  (same pattern used for previously retired packages).

## 6. Error Handling / Behavior Changes

- Config changes (human or agent JSON edits) now require `mono-agent restart` to take
  effect. There is no live re-apply trigger.
- Headless start is the only mode. `mono-agent start` no longer prints a console URL or
  token; it prints exporter/trace-source status only.
- `mono-agent status` / `validate` continue to work and report exporter + trace-source
  state.

## 7. Testing

- `agent-app` tests updated: no console startup, no `console.*` field group, no
  `--no-console`, status output without console URL. `applyConfigChange` tests and
  self-capabilities tests stay green.
- Demo tests updated for removed console wiring.
- Repo gates: `pnpm run check:architecture`, `pnpm run typecheck`, `pnpm test`
  (incl. `release:test` count), `git diff --check`.
- Manual: `mono-agent start` runs headless; edit config JSON; `mono-agent restart`
  picks up the change; `mono-agent status` and `validate` work.

## 8. Sequencing Gate

The deletion is bundled with the Phoenix exporter in one PR. Before merge, the operator
runs the Phoenix live smoke test from the companion spec (start Phoenix, configure the
exporter, run one representative turn, confirm a readable trace + matching JSONL). The
combined PR must not merge until that smoke test passes — it is the gate that makes
dropping the browser trace view safe.

## 9. Spec Self-review

- No placeholders remain.
- Internally consistent with the companion Phoenix spec: this removes the console the
  Phoenix spec deferred, now that the trace-view replacement exists.
- Scope is one PR (paired with Phoenix). The only deliberately preserved pieces
  (`applyConfigChange`, trace-source registry, observability readers) are called out as
  non-goals with rationale.
- The single behavioral tradeoff (live-apply → restart-to-apply) is explicit and was
  approved.
