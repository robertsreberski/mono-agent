# Validation

Use validation that matches the chosen composition path. Do not claim the host works from a typecheck alone.

## Config Validation (default path)

In the user's agent folder:

```bash
mono-agent validate
```

The report covers core config, runtime support for the primary and every fallback model, identity/skills/memory/MCP paths, the sandbox policy, the operator console section, and every channel (`ok` / `waiting` / `off` / `error`). Exit 0 means the folder is ready to start. Fix every `[error]`; `[waiting]` channels are simply unconfigured.

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
import { loadSkillIndexFromDirectory } from '@mono-agent/context';

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
| WhatsApp | Send one allowed sender/group trigger and verify the reply. |
| OpenAI API | `curl /v1/models` and `/v1/chat/completions`. |
| A2A | Send text to the Agent Card URL with `sendA2AMessage()`. |
| Webhook | `curl` the invocation path and inspect the response body/status. |
| Cron | Run a one-off scheduled invocation or wait for one tick. |
| Self capabilities | In `propose` mode, ask for a proposed skill/cron and confirm the preview plus saved proposal file under `.mono-agent/self-capabilities/proposals/`. In `apply` mode, set `MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN`, explicitly provide the saved `proposalId` and a proposal-scoped approval token derived from that host secret in the confirming request, then confirm the file, linked audit record, and app reload. |
| Operator console | Open Settings and Traceability; confirm redaction and a visible run artifact. |
| Memory recall tool | With `memory.recallTool.enabled` (default on for journal/bujo with embeddings), ask the agent to recall an old note and confirm `memory_recall` appears in the run artifact and returns it. |
| Semantic memory search | With `memory.embeddings` set (Ollama: `ollama pull nomic-embed-text:v1.5` first), ask a paraphrased question about an old note and confirm `memory_recall` (hybrid keyword + semantic) returns it. |

## Failure Handling

Report failures as explicit blockers or follow-up work. Do not present:

- a missing runtime as a successful fallback
- disabled tools as a successful MCP integration
- a fake adapter request as a product-runtime smoke
- a redacted or skipped secret as proof that the live adapter works
