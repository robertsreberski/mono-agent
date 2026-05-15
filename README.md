# Mono Agent

Mono Agent is a small npm monorepo of reusable building blocks around `@worklab-ai/agent-runtime`. The packages are intentionally modular: communication adapters stay independent, runtime/provider details stay in the runtime adapter, and the final Telegram demo composes modules instead of carrying framework logic itself.

## Packages

| Package | Responsibility |
| --- | --- |
| `@worklab-ai/context` | Deterministic prompt/context assembly from identity, default SOUL/core guidance, optional memory, recent history, skill index, selected skill instructions, and the current user message. |
| `@worklab-ai/telegram-bridge` | Telegram Bot API client, edit-based streaming bridge, allowlisted update handling, cancellation, and long polling. It does not know about memory, config, or the harness. |
| `@worklab-ai/runtime-adapter` | Typed facade over JS-first `@worklab-ai/agent-runtime`; parses model references and validates execution-mode compatibility before delegating real runtime execution. |
| `@worklab-ai/config` | Strict env config loader with required Telegram token/chat allowlist/model/identity path, optional memory/skills/tools/artifacts, and redacted diagnostics. |
| `@worklab-ai/memory-md` | Optional Markdown memory store with capped reads, safe per-conversation names, and explicit host-owned append APIs. |
| `@worklab-ai/observability` | JSONL runtime event recorder plus compact run summary artifacts with redaction. |
| `@worklab-ai/tool-policy` | Fail-closed allowed/disallowed tool and MCP policy normalization for runtime options. |
| `@worklab-ai/skills` | Deterministic configured-skill activation that loads only selected `SKILL.md` bodies with byte caps. |
| `@worklab-ai/agent-harness` | Main composition spine: communication request → context assembly → runtime run → explicit success/failure response, with memory/history/skills/tool policy/observability hooks. |
| `@worklab-ai/telegram-agent-demo` | Private local demo host that wires the real Telegram bridge, harness, and runtime adapter. Tests use fakes; product use requires real Telegram/runtime credentials. |

## Dependency direction

```text
telegram-agent-demo
  ├─ telegram-bridge
  ├─ agent-harness
  │   ├─ context
  │   ├─ memory-md
  │   ├─ observability
  │   ├─ runtime-adapter ── @worklab-ai/agent-runtime
  │   ├─ skills ── context
  │   └─ tool-policy
  ├─ config ── runtime-adapter
  └─ runtime-adapter
```

Communication adapters remain leaf-ish packages. The harness exposes a structural responder compatible with Telegram without depending on Telegram types.

## Telegram demo configuration

Required environment:

```bash
MONO_AGENT_TELEGRAM_BOT_TOKEN=123456:bot-token
MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS=123456789
MONO_AGENT_MODEL=pi:openai-codex:gpt-5.5
MONO_AGENT_IDENTITY_PATH=./IDENTITY.md
```

Useful optional environment:

```bash
MONO_AGENT_SOUL_PATH=./SOUL.md
MONO_AGENT_SKILLS_ROOT=./skills
MONO_AGENT_SELECTED_SKILLS=research,writing
MONO_AGENT_MEMORY_PATH=./memory.md
MONO_AGENT_MEMORY_WRITE_MODE=disabled
MONO_AGENT_ALLOWED_TOOLS=Read,Grep
MONO_AGENT_DISALLOWED_TOOLS=Bash
MONO_AGENT_ARTIFACT_DIR=.mono-agent/artifacts
MONO_AGENT_WORKSPACE=.
MONO_AGENT_MAX_TURNS=8
```

The chat allowlist is required. Provider credentials stay outside config exports and are handled by the runtime/provider environment expected by `@worklab-ai/agent-runtime`.

## Run the demo locally

```bash
npm install
npm run build
node packages/telegram-agent-demo/dist/cli.js
```

The demo uses the real Telegram Bot API client, real long poller, and real runtime adapter by default. If Telegram or provider credentials are wrong, the harness and bridge surface honest failure states and observability artifacts rather than fake success.

## Development verification

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

For package-level work, run the same scripts with `--workspace @worklab-ai/<package>`. Cross-workspace packages expose built `dist` types, so run `npm run build` before typechecking dependents from a fresh checkout if necessary.

## Safety model

- No secrets, `.env*`, OAuth files, provider keys, Telegram tokens, or transcripts are committed.
- Config redaction omits the Telegram token and raw chat ids.
- Tool policy defaults to an empty allowlist; tools/MCP access must be configured explicitly.
- Memory writes are host-owned and explicit; models do not rewrite durable `memory.md` directly.
- Fixtures/fakes are used only in tests, not in the demo runtime path.
