---
title: Operational environment variables
description: "Environment variables reserved for secrets, process plumbing, managed workers, and adapter compatibility."
---

Core agent configuration comes only from `mono-agent.config.json`, followed by
built-in defaults. `MONO_AGENT_*` variables that previously mapped to core
fields are silently ignored, including retired names. Move those values into
the corresponding JSON fields before upgrading.

Environment variables remain appropriate for values that are not core
configuration: credentials named by JSON, managed-process markers, and
parent-to-child runtime protocols. Adapter packages still document their own
environment inputs separately.

## Secret references

A JSON `apiKeyEnv`, `tokenEnv`, or similar field stores the **name** of an
environment variable, not its value. The process reads the named variable only
when it needs the credential. For example:

```json
{
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "https://ollama.com",
      "apiKeyEnv": "OLLAMA_API_KEY"
    }
  }
}
```

```bash
export OLLAMA_API_KEY="..."
```

Keep secret values outside committed JSON. The CLI may load an owner-private
`.env` file so these referenced credentials and adapter secrets reach the
process; dotenv values do not override core JSON configuration.

## Internal process protocols

The host injects reserved variables when it starts child tools or probes. They
are runtime protocol values, not operator configuration:

- `MONO_AGENT_INTERACTION_BRIDGE_URL`
- `MONO_AGENT_INTERACTION_BRIDGE_TOKEN`
- `MONO_AGENT_ASK_USER_TIMEOUT_MS`
- `MONO_AGENT_ADAPTER_TOOLS_*`
- `MONO_AGENT_CONTINUATION_*`
- `MONO_AGENT_CRON_JOB_ID`, `MONO_AGENT_CRON_RUN_ID`,
  `MONO_AGENT_CRON_SCHEDULED_AT`, and `MONO_AGENT_CRON_TRIGGER`
- `MONO_AGENT_MCP_*`
- `MONO_AGENT_PI_AUTH_PATH` when injected into a readiness-probe child

Values supplied by an operator under formerly supported core names are ignored
by core config resolution. Child readers consume only the explicit protocol
contract constructed by their parent.

## Managed-worker and operational controls

These variables control process supervision or machine-local discovery rather
than the resolved agent configuration:

- `MONO_AGENT_MANAGED_WORKER`, `MONO_AGENT_SYSTEMD_WORKER`, and
  `MONO_AGENT_MANAGED_WEB_WORKER`
- `MONO_AGENT_MANAGED_LOG_MAINTENANCE` and
  `MONO_AGENT_MANAGED_WEB_LOG_MAINTENANCE`
- `MONO_AGENT_WEB_ALLOWED_HOSTS` and `MONO_AGENT_WEB_PUSH_SUBJECT`
- `MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR` and
  `MONO_AGENT_TRACE_TMPDIR_ROOT`
- `MONO_AGENT_REPRO_CONSOLE_STALL`

Managed launchers own these values. Do not copy them into
`mono-agent.config.json`.

## Adapter environment inputs

Channel and plugin adapters retain their package-owned environment inputs for
now. See each [channel guide](/channels/) for its exact credential and
compatibility surface. These inputs are outside `@mono-agent/config`; core
precedence is always JSON, then built-in defaults.
