# Mono Agent

Mono Agent is a small pnpm workspace monorepo of reusable npm packages around `@worklab-ai/agent-runtime`. Packages stay modular: communication adapters are independent, runtime/provider details stay in the runtime adapter, and the final Telegram demo composes packages without becoming a package itself.

## Packages

| Package | Responsibility |
| --- | --- |
| `@worklab-ai/context` | Deterministic prompt/context assembly from identity, default SOUL/core guidance, optional memory, recent history, skill index, selected skill instructions, and the current user message. |
| `@worklab-ai/telegram-bridge` | Telegram Bot API client, edit-based streaming bridge, allowlisted update handling, cancellation, and long polling. It does not know about memory, config, or the harness. |
| `@worklab-ai/runtime-adapter` | Typed facade over JS-first `@worklab-ai/agent-runtime`; parses model references and validates execution-mode compatibility before delegating real runtime execution. |
| `@worklab-ai/config` | Strict env + JSON config loader with required Telegram token/chat allowlist/model/identity path, optional memory/skills/tools/artifacts, and redacted diagnostics. |
| `@worklab-ai/memory-md` | Optional Markdown memory store with capped reads, safe per-conversation names, and explicit host-owned append APIs. |
| `@worklab-ai/observability` | JSONL runtime event recorder plus compact run summary artifacts with redaction. |
| `@worklab-ai/tool-policy` | Fail-closed allowed/disallowed tool and MCP policy normalization for runtime options. |
| `@worklab-ai/skills` | Deterministic configured-skill activation that loads only selected `SKILL.md` bodies with byte caps. |
| `@worklab-ai/agent-harness` | Main composition spine: communication request → context assembly → runtime run → explicit success/failure response, with memory/history/skills/tool policy/observability hooks. |
| `@worklab-ai/config-ui` | Browser UI + loopback HTTP bridge that reads/writes `mono-agent.config.json`. Hosts register `FieldGroup`s on top of the built-in identity/runtime/memory/tools/telegram groups. |
| `@worklab-ai/tui` | Ink-based React TUI console adapter: chat, in-memory history, and a redacted, read-only Config pane sourced from `@worklab-ai/config`. Communication adapter; depends only on `@worklab-ai/config`. |

## Dependency direction

```text
demos/final-agent (not a package)
  ├─ config-ui
  ├─ telegram-bridge
  ├─ tui ── config            (leaf-ish, parallel to telegram-bridge)
  ├─ agent-harness
  │   ├─ context
  │   ├─ memory-md
  │   ├─ observability
  │   ├─ runtime-adapter ── @worklab-ai/agent-runtime
  │   ├─ skills ── context
  │   └─ tool-policy
  ├─ config ── runtime-adapter
  ├─ runtime-adapter
  ├─ memory-md
  ├─ observability
  └─ tool-policy
```

Communication adapters remain leaf-ish packages. The harness exposes a structural responder compatible with Telegram without depending on Telegram types.

## Final demo (not a package)

The final demo lives at `demos/final-agent/`. It has TypeScript source and root scripts, but no `package.json`, no workspace entry, and no publishable package name.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run demo:final
```

Flow:

1. The CLI starts the loopback config UI first and prints `http://127.0.0.1:<port>/?t=<token>` plus the config path.
2. Edit and save `mono-agent.config.json` in the UI. The demo uses the core Identity/Runtime/Memory/Tools/Telegram groups plus a tiny Artifacts group for observability output.
3. Once the layered config is valid, the demo starts the real Telegram bridge, long poller, harness, runtime adapter, memory, tool policy, and observability path.
4. Later config writes do not hot-reload a running Telegram poller; restart the demo to apply runtime/token/allowlist changes.

Environment variables override JSON values. Provider credentials stay in the provider/runtime environment expected by `@worklab-ai/agent-runtime`; the config UI JSON is not a secret manager. Telegram bot tokens are write-only in the UI and redacted from diagnostics; raw chat ids are reported only as counts.

See [`demos/final-agent/README.md`](./demos/final-agent/README.md) for the minimal config shape and CLI options.

## Configuration UI package

`@worklab-ai/config-ui` ships the reusable settings surface and local HTTP bridge. Hosts call it directly:

```ts
import {
  startConfigUiBridge,
  CORE_FIELD_GROUPS,
  defineFieldGroup,
} from "@worklab-ai/config-ui";

const bridge = await startConfigUiBridge({
  configPath: "/path/to/mono-agent.config.json",
  cwd: process.cwd(),
  fieldGroups: [
    ...CORE_FIELD_GROUPS,
    defineFieldGroup({
      id: "telemetry",
      label: "Telemetry",
      fields: [
        {
          id: "telemetry.endpoint",
          label: "OTLP endpoint",
          kind: "string",
          path: ["telemetry", "endpoint"],
        },
      ],
    }),
  ],
});
console.log(bridge.url, bridge.token);
```

`@worklab-ai/config` provides `loadMonoAgentConfigWithSources({ env, cwd, jsonPath })` so the same JSON file edited by the UI can feed an agent host while environment variables continue to win.

### Config UI safety model

- The bridge binds to `127.0.0.1` by default and refuses non-loopback hosts.
- Every `/api/*` request except health requires a per-boot bearer token; `?t=` is accepted on first browser load and the SPA keeps it in memory.
- Secret fields are write-only over the wire. GET responses replace them with `{ __secret: true, set: <boolean> }`.
- `mono-agent.config.json` is written with mode `0o600` and is `.gitignore`-d.
- `expectedVersion` on PUT prevents two browser tabs from silently overwriting each other.

## Development verification

```bash
pnpm run build
pnpm run typecheck
pnpm test
git diff --check
```

For package-level work, run the same scripts with `pnpm --filter @worklab-ai/<package> run <script>`. Cross-workspace packages expose built `dist` types, so run `pnpm run build` before typechecking dependents from a fresh checkout.

Useful demo-focused checks:

```bash
pnpm run build:demo
pnpm run typecheck:demo
pnpm run test:demo
```

## Safety model

- No secrets, `.env*`, OAuth files, provider keys, Telegram tokens, or transcripts are committed.
- Config redaction omits the Telegram token and raw chat ids.
- Tool policy defaults to an empty allowlist; tools/MCP access must be configured explicitly.
- Memory writes are host-owned and explicit; models do not rewrite durable `memory.md` directly.
- Fixtures/fakes are used only in tests, not in the demo runtime path.
