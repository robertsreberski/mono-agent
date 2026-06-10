# Validation

Use validation that matches the chosen composition path. Do not claim the host works from a typecheck alone.

## Documentation Validation

For this repository's bundled mono-agent composer skill:

```bash
node --input-type=module - <<'EOF'
import { loadSkillIndexFromDirectory } from './packages/context/dist/index.js';

const skills = await loadSkillIndexFromDirectory('docs/skills');
console.log(JSON.stringify(skills, null, 2));
EOF
```

Expected:

- `mono-agent-composer` appears in the index.
- The description is the first plain paragraph from `SKILL.md`.
- The `mainFile` points at `docs/skills/mono-agent-composer/SKILL.md`.

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
| Operator console | Open Settings and Traceability; confirm redaction and a visible run artifact. |

## Failure Handling

Report failures as explicit blockers or follow-up work. Do not present:

- a missing runtime as a successful fallback
- disabled tools as a successful MCP integration
- a fake adapter request as a product-runtime smoke
- a redacted or skipped secret as proof that the live adapter works
