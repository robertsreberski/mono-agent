# Validation

Use validation that matches the chosen composition path. Do not claim the host works from a typecheck alone.

## Config Validation (default path)

In the user's agent folder:

```bash
mono-agent validate
```

The report covers core config, runtime support for the primary and every fallback model, identity/skills/memory/MCP paths, the sandbox policy, the observability section (artifacts, traceability, and any configured exporters), and every channel (`ok` / `waiting` / `off` / `error`). Exit 0 means the folder is ready to start. Fix every `[error]`; `[waiting]` channels are simply unconfigured.

From a separate orchestration folder, validate a downstream consumer without changing cwd:

```bash
mono-agent validate --consumer <agent-folder>
```

The consumer folder's `.env` loads by default, relative `--config` and `--env-file` paths resolve inside that folder, and missing memory roots warn read-only instead of being created.

Then start and confirm the status lines:

```bash
mono-agent start
```

Every channel the user asked for must report `running` with its endpoint facts; anything `failed` is a blocker, not a footnote.

## Documentation Validation

To confirm a skills folder is indexable (replace `<skillsRoot>` with the
agent's configured skills root, e.g. `./skills`):

```bash
node --input-type=module - <<'EOF'
import { loadSkillIndexFromDirectory } from '@mono-agent/agent-harness';

const skills = await loadSkillIndexFromDirectory('<skillsRoot>');
console.log(JSON.stringify(skills, null, 2));
EOF
```

Expected:

- Every selected skill appears in the index.
- The description is the first plain paragraph from its `SKILL.md`.
- The `mainFile` points at `<skillsRoot>/<skill-name>/SKILL.md`.

## Repo Validation

Run the narrow checks for doc-only changes:

```bash
pnpm run check:architecture
pnpm run typecheck
git diff --check
```

If code or config behavior changes, add the relevant package tests:

```bash
pnpm --filter @mono-agent/<package> run test
pnpm --filter @mono-agent/<package> run build
pnpm --filter @mono-agent/<package> run typecheck
```

For broad host or demo changes, run the full workspace gate:

```bash
pnpm run build
pnpm test
pnpm run build:demo
pnpm run typecheck:demo
pnpm run test:demo
```

## Smoke Tests By Surface

| Surface | Smoke |
| --- | --- |
| TUI | Start the host and complete one local prompt. |
| Telegram | Send one allowed chat message and verify the reply. |
| Slack | Send one allowed DM or channel message and verify formatting. |
| Adapter send tools | When `SlackSendMessage` / `TelegramSendMessage` are available (allow-all, or an explicit `tools.allowedTools` entry) with the channel enabled, call them from a non-Slack/Telegram surface such as TUI, cron, or OpenAI API to an allowed destination and verify delivery. |
| WhatsApp | Send one allowed sender/group trigger and verify the reply. |
| OpenAI API | `curl /v1/models` and `/v1/chat/completions`. |
| A2A | Send text to the Agent Card URL with `sendA2AMessage()`. |
| Webhook | `curl` the invocation path and inspect the response body/status. |
| Cron | Run a one-off scheduled invocation or wait for one tick. |
| Observability | Confirm a run writes a redacted JSONL artifact; if an `observability.exporters` Phoenix entry is set, confirm the trace appears in Phoenix. |
| Memory recall tool | With any memory tier configured (`memory.recallTool.enabled` defaults on), ask the agent to recall an old note and confirm `MemoryRecall` appears separately from action-tool allowlists and returns it. |
| Semantic memory search | With `memory.embeddings` set (Ollama: `ollama pull nomic-embed-text:v1.5` first), ask a paraphrased question about an old note and confirm `MemoryRecall` (hybrid keyword + semantic) returns it. |

## Failure Handling

Report failures as explicit blockers or follow-up work. Do not present:

- a missing runtime as a successful fallback
- disabled tools as a successful MCP integration
- a fake adapter request as a product-runtime smoke
- a redacted or skipped secret as proof that the live adapter works
