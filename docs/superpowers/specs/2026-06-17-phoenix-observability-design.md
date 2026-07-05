# Phoenix Observability Export

> Scope: replace the custom browser traceability UX as the default operator answer by exporting mono-agent traces to Phoenix, while preserving local JSONL artifacts and trace-source status.
> Date: 2026-06-17. Status: approved direction, ready for implementation planning after review.

## 1. Goal

Give mono-agent a trace viewer with mature UX without owning another browser console.
Phoenix is the first supported target. A running mono-agent host should keep writing
local JSONL artifacts, and, when configured, export the same run lifecycle to a
Phoenix-compatible OTLP HTTP endpoint.

The successful end state is:

- `@mono-agent/observability` remains the local source of truth for run artifacts,
  summaries, and trace-source registry data.
- Phoenix becomes the recommended trace viewer for local development.
- Export failures never fake success and never fail the agent run.
- Raw prompts, reasoning text, tool inputs, and tool outputs are not exported by
  default.
- The bespoke React traceability view in `@mono-agent/operator-console` is no
  longer the default product direction. Removing it is a later migration after
  Phoenix proof and replacement config/control paths are in place.

## 2. Non-goals

- Do not delete `@mono-agent/observability`.
- Do not make Phoenix the only source of trace data.
- Do not copy Mickey's SQLite `agent_logs` store into mono-agent.
- Do not remove settings/live-apply behavior from `@mono-agent/operator-console`
  until equivalent CLI, TUI, or control API behavior exists.
- Do not add a generic observability product matrix in this first slice. The
  implementation should stay Phoenix-first, with an exporter boundary that can
  support Langfuse or generic OTLP later.

## 3. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Keep JSONL recording always on when artifacts are configured | Local artifacts are deterministic, testable, and already used by runtime packages and evals. |
| 2 | Add a Phoenix preset backed by OTLP HTTP | Phoenix gives a mature local trace UI; OTLP keeps the transport standard. |
| 3 | Export is additive and best-effort | Observability backend failures must not change the runtime outcome. |
| 4 | Sensitive payload export is opt-in | Agent traces can contain prompts, tool I/O, local paths, and provider diagnostics. Metadata-only is the safe default. |
| 5 | Preserve mono-agent identifiers as attributes | Phoenix must show `runId`, `conversationId`, `sourceId`, status, warning, and artifact context so local artifact lookup remains possible. |
| 6 | Defer deleting the console package | The console still owns browser config editing and live apply. Trace UX replacement should not silently remove control workflows. |

## 4. Config

Add exporter configuration under `observability` rather than `traceability`.
`traceability` remains the local source registry; `artifacts` remains the local
artifact directory.

```jsonc
{
  "observability": {
    "exporters": [
      {
        "type": "phoenix",
        "endpoint": "http://127.0.0.1:6006/v1/traces",
        "includeSensitiveData": false
      }
    ]
  }
}
```

The initial type model should support:

- `type: "phoenix"`
- `endpoint?: string`, defaulting to Phoenix's local OTLP HTTP traces endpoint
- `headers?: Record<string, string>` for future authenticated collectors
- `includeSensitiveData?: boolean`, default `false`
- `timeoutMs?: number`, default short enough that export cannot stall shutdown

Environment overrides should use explicit names, for example:

- `MONO_AGENT_OBSERVABILITY_EXPORTERS` for JSON config if the repo already has a
  pattern for structured env values, or
- focused Phoenix variables such as `MONO_AGENT_PHOENIX_ENDPOINT` and
  `MONO_AGENT_PHOENIX_INCLUDE_SENSITIVE_DATA`

The implementation plan should choose the smallest option that fits the existing
config loader style and tests.

## 5. Package Shape

Preferred package shape:

- Add exporter contracts and pure mapping helpers to `@mono-agent/observability`.
- Keep the actual network exporter in the same package only if dependencies stay
  small and Node-only imports do not leak into browser-safe subpath exports.
- Keep OTLP dependencies behind the explicit `@mono-agent/observability/otel`
  subpath so Node-only exporter code does not leak into browser-safe exports.

The public API should make the boundary explicit:

```ts
export interface RunExporter {
  start?(context: RunExportContext): Promise<void> | void;
  onEvent?(event: RuntimeEventLike, context: RunExportEventContext): Promise<void> | void;
  finish?(summary: RunSummary, context: RunExportContext): Promise<void> | void;
  fail?(summary: RunSummary, error: unknown, context: RunExportContext): Promise<void> | void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
```

The implementation can adjust names, but the contract must separate run
recording from export transport. JSONL recorder behavior must remain unchanged
and test-pinned.

## 6. Runtime Data Flow

1. `@mono-agent/agent-app` loads config and resolves artifacts, traceability,
   and observability exporter settings.
2. `@mono-agent/agent-host` creates the run recorder as it does today.
3. The recorder writes:
   - `<runId>.events.jsonl`
   - `<runId>.summary.json`
4. In parallel, the exporter maps the run to Phoenix:
   - one root trace/span per mono-agent run
   - tool call start/completion as child spans or paired span events
   - provider/model latency as a model span or root span event
   - runtime warnings and failures as span events/status
   - artifact references as attributes, not embedded blobs
5. `mono-agent start` and `mono-agent status` report exporter state:
   - configured endpoint
   - last export warning/error, if known
   - a clear note that JSONL artifacts are still available locally

The exporter may batch events until finish if that is simpler and reliable.
Streaming export is not required for the first implementation, but the mapping
should preserve event indexes so Phoenix spans can be traced back to JSONL rows.

## 7. Attribute Mapping

Root trace/span attributes:

- `service.name = "mono-agent"`
- `mono.agent.run_id`
- `mono.agent.conversation_id`
- `mono.agent.source_id`
- `mono.agent.source_label`
- `mono.agent.config_path`
- `mono.agent.status`
- `mono.agent.failure_kind`
- `mono.agent.provider_session_id`
- `mono.agent.artifact_dir` only when explicitly allowed for local debug
- `mono.agent.events.count`
- `mono.agent.warnings.count`

Per-event/span attributes:

- `mono.agent.event.index`
- `mono.agent.event.type`
- `mono.agent.event.category`
- `mono.agent.event.label`
- `mono.agent.event.summary`
- `mono.agent.source_id`
- `mono.agent.run_id`

When `includeSensitiveData` is false, payload fields should be summarized rather
than copied. When true, the existing redaction helper still runs before export.

## 8. CLI And Operator Surface

The product direction changes from "open the operator console to inspect traces"
to "open Phoenix to inspect traces".

First implementation slice:

- Keep `--no-console` and `console.enabled` behavior as-is.
- Keep trace-source registration as-is so `mono-agent status` can discover
  running hosts.
- Add Phoenix/exporter status to CLI output and doctor/status surfaces.
- Update docs to recommend Phoenix for trace viewing.
- Do not remove `TraceabilityView` in the first PR unless a real Phoenix smoke
  test has passed and affected console tests/docs are migrated.

Later migration:

- Remove traceability routes and `TraceabilityView` from `@mono-agent/operator-console`.
- Keep or replace settings/control separately.
- Replace any "tokenized console link" traceability language with Phoenix and
  local artifact guidance.

## 9. Error Handling

Exporter errors:

- are recorded as exporter warnings/status
- do not change run success/failure
- do not suppress JSONL artifact writes
- are visible in `doctor`, `status`, or startup logs
- are bounded by timeout and never hang shutdown indefinitely

Config errors:

- invalid exporter type, endpoint, header shape, or timeout should fail
  validation clearly before startup
- an unreachable Phoenix endpoint should not fail validation by default because
  Phoenix may start after the agent; `doctor` can perform live reachability

Privacy errors:

- exported content defaults to metadata-only
- opt-in sensitive export must be explicit in config or env
- secrets still pass through existing redaction before export

## 10. Testing

Unit tests:

- config parsing and redaction of Phoenix exporter settings
- event-to-trace/span mapping for representative tool, message, runtime warning,
  provider latency, and failure events
- metadata-only export omits prompt/tool payloads
- `includeSensitiveData: true` still redacts secret-looking fields
- exporter failures do not prevent JSONL summary/event writes

Package tests:

```sh
pnpm --filter @mono-agent/observability run test
pnpm --filter @mono-agent/observability run typecheck
pnpm --filter @mono-agent/config run test
pnpm --filter @mono-agent/agent-host run test
pnpm --filter @mono-agent/agent-app run test
```

Repository tests:

```sh
pnpm run check:architecture
pnpm run typecheck
pnpm test
git diff --check
```

Live proof before removing console trace UI:

1. Start local Phoenix.
2. Configure mono-agent with the Phoenix exporter.
3. Run one representative local agent turn with a tool call and a warning or
   failure case if practical.
4. Confirm Phoenix shows a readable trace with run/source identifiers.
5. Confirm JSONL artifacts still exist and match the exported run.

## 11. Documentation

Update:

- `README.md`: local traceability now recommends Phoenix when an exporter is
  configured; JSONL remains local fallback.
- `docs/feature-registry.md`: add Phoenix exporter/config mapping.
- `packages/observability/README.md`: exporter contract, Phoenix preset, privacy
  defaults.
- `packages/agent-app/README.md`: startup/status output and `--no-console`
  guidance.
- `packages/operator-console/README.md`: mark browser traceability as legacy or
  local fallback once Phoenix proof exists.

## 12. Open Implementation Checks

These are not product unknowns; they are checks to resolve while planning:

- Whether OTLP dependencies can stay isolated behind the
  `@mono-agent/observability/otel` subpath.
- Whether the existing config loader style supports structured env overrides
  cleanly enough for exporter arrays.
- Whether first export should stream events or batch on run finish.
- Whether Phoenix returns a stable local trace URL that mono-agent can print, or
  whether the CLI should print only the Phoenix app URL plus run identifiers.

## 13. Spec Self-review

- No placeholders remain.
- Scope is one implementation plan: Phoenix exporter plus surfacing; console UI
  deletion is a later migration gate.
- The design preserves package boundaries and local JSONL behavior.
- Ambiguities that depend on exact package dependency shape are isolated as
  implementation checks rather than product decisions.
