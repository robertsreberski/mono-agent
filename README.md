# Mono Agent

Mono Agent is a small pnpm workspace of reusable npm packages under the `@worklab-ai` scope. The framework is built around `@worklab-ai/agent-runtime`, but keeps runtime access, communication adapters, settings, skills, memory, observability, and operator surfaces as separate packages.

## Package Architecture

| Layer | Packages | Responsibility |
| --- | --- | --- |
| Runtime | `@worklab-ai/runtime-adapter` | The only package that wraps `@worklab-ai/agent-runtime`; parses model refs and validates execution modes. |
| Core host contracts | `@worklab-ai/agent-contracts`, `@worklab-ai/config`, `@worklab-ai/settings`, `@worklab-ai/tool-policy` | Shared responder contracts, adapter-neutral core config, generic settings JSON/schema helpers, and fail-closed tool/MCP policy normalization. |
| Prompt/context | `@worklab-ai/context`, `@worklab-ai/skills`, `@worklab-ai/memory-md` | Deterministic prompt assembly, selected-skill loading, and optional Markdown memory. |
| Execution spine | `@worklab-ai/agent-harness` | Composes context, runtime, memory, history, tool policy, skills, and observability for one request. |
| Local evidence | `@worklab-ai/observability` | JSONL run recorder and local artifact reader. |
| Communication adapters | `@worklab-ai/telegram-adapter`, `@worklab-ai/whatsapp-adapter` | Leaf-ish transport adapters that accept structural responders and own adapter-specific safety/config. |
| Operator surfaces | `@worklab-ai/operator-console`, `@worklab-ai/tui` | Local browser and terminal operator surfaces. They do not own runtime hosting or communication transport. |

## Dependency Direction

```text
demos/final-agent (not a workspace package)
  ├─ operator-console ── settings, observability
  ├─ telegram-adapter ── agent-contracts, settings
  ├─ agent-harness
  │   ├─ agent-contracts
  │   ├─ context
  │   ├─ memory-md
  │   ├─ observability
  │   ├─ runtime-adapter ── @worklab-ai/agent-runtime
  │   ├─ skills ── context
  │   └─ tool-policy
  ├─ config ── settings, runtime-adapter
  ├─ tui ── config
  └─ core leaf packages as needed
```

Rules for future packages:

- New packages live under `packages/<package-name>` and publish as `@worklab-ai/<package-name>`.
- Communication packages use `*-adapter` naming and must not depend on other adapters, the harness, or operator surfaces.
- Core config stays adapter-neutral; adapter credentials and allowlists live with the adapter package.
- Operator surfaces register field groups from other packages; they do not hardcode adapter settings.
- Demos compose packages but are not publishable packages.

## Final Demo

The final demo lives at `demos/final-agent/`. It starts the local operator console first, then starts Telegram only after both core config and Telegram adapter config are valid.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

The demo composes:

- `CORE_AGENT_FIELD_GROUPS` from `@worklab-ai/config`
- `telegramFieldGroup` and `loadTelegramAdapterConfig` from `@worklab-ai/telegram-adapter`
- `startOperatorConsole` from `@worklab-ai/operator-console`
- the harness, runtime adapter, memory, tool policy, and observability packages

See [`demos/final-agent/README.md`](./demos/final-agent/README.md) for config shape and CLI options.

## Development Verification

```bash
pnpm install --frozen-lockfile
pnpm run check:architecture
pnpm run build
pnpm run typecheck
pnpm test
pnpm run build:demo
pnpm run typecheck:demo
pnpm run test:demo
git diff --check
```

For package-level work:

```bash
pnpm --filter @worklab-ai/<package> run build
pnpm --filter @worklab-ai/<package> run typecheck
pnpm --filter @worklab-ai/<package> run test
```

## Safety Model

- No secrets, `.env*`, OAuth files, provider keys, Telegram tokens, WhatsApp auth state, or transcripts are committed.
- Settings JSON is local, schema-validated, and written with restrictive file permissions where the settings helper writes it.
- Secret fields are write-only in the operator console and redacted in diagnostics.
- Tool policy is explicit and fail-closed.
- Memory writes are host-owned and optional.
- Fixtures and fake runtimes are for tests only, not product-runtime substitutes.
