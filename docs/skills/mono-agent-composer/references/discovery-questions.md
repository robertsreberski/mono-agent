# Discovery Questions

Use this sequence to understand what to build before composing mono-agent packages. Ask one question at a time. Skip questions whose answer is already explicit in the user's request.

## 1. Product Shape

Question:

```text
What kind of agent experience are we building first?

1. Local terminal chat with config visibility (recommended for first integration)
2. Telegram or another chat adapter
3. OpenAI-compatible API for OpenWebUI or an API client
4. A2A provider/consumer for agent-to-agent calls
5. Webhook or cron invocation
6. Custom host using the shared responder contract
```

Decision rule: pick one primary surface for the first pass. Add secondary adapters only after the responder path works.

## 2. Runtime

Question:

```text
Which runtime should this host use?

1. `pi:<provider>:<model>` through SDK mode (recommended for local or OpenAI-compatible providers)
2. `codex:<model>` through CLI mode
3. `claude:<model>` through SDK or CLI mode
4. A custom `MonoRuntimeLike` supplied by the host
```

Follow-up only if needed:

```text
Should the runtime keep a continuous provider session per conversation, or run each message statelessly?
```

Default: `continuous` when the backend supports resume; otherwise let mono-agent fall back to per-message behavior.

## 3. Identity And Workspace

Question:

```text
What should the agent's role be, and which workspace should it operate in?
```

Capture:

- `context.identityPath`
- optional `context.soulPath`
- `runtime.workspace`
- any project instruction files the host should load into identity or skills

If the user has no identity text, create a small `IDENTITY.md` that states the agent role, allowed scope, confirmation boundaries, and failure behavior.

## 4. Skills

Question:

```text
Should this agent use selected skills?

1. Yes, from a repo-local `skills/` directory
2. Yes, from an external skills directory
3. No selected skills for the first pass
```

For selected skills, record:

- `context.skillsRoot`
- `context.selectedSkills`
- expected skill names
- whether each skill has a first non-heading description paragraph

Mono-agent skill discovery loads immediate child directories only: `<skillsRoot>/<skill-name>/SKILL.md`.

## 5. Tools And MCP

Question:

```text
What tools or MCP servers does the agent actually need?

1. No tools yet; fail closed (recommended)
2. A small allowlist of built-in tools
3. A specific MCP config file
4. Both built-in tools and MCP servers
```

Record exact allowlist/denylist names and the `tools.mcpConfigPath` if present. Denylist entries win over allowlist entries.

## 6. Memory

Question:

```text
Should the agent remember anything between conversations?

1. No durable memory yet (recommended for first integration)
2. Read-only Markdown memory
3. Append host summaries to Markdown memory
4. Journal/graph/search memory for richer local recall
```

Default: disabled writes. Use `append-host-summary` only when the host owner accepts deterministic host summaries being appended after successful turns.

## 7. Adapter And Safety

Question:

```text
Where can this agent listen or respond?

1. Loopback/local only (recommended)
2. Private network with bearer tokens or allowlists
3. Public endpoint behind a reverse proxy or platform boundary
```

For chat adapters, collect allowlisted chat IDs, channels, or group policy. For HTTP adapters, collect host, port, path, bearer/API key policy, and whether non-loopback binding is allowed.

## 8. Observability

Question:

```text
Do you need traceability in the operator console or just local logs?

1. JSONL artifacts and operator-console traceability (recommended)
2. JSONL artifacts only
3. No persisted run artifacts
```

Prefer JSONL artifacts for real verification. Do not expose private chain-of-thought; mono-agent traces runtime/tool/message events and summaries.

## 9. Verification

Question:

```text
What is the acceptance smoke test?

1. A terminal prompt through the TUI
2. A Telegram/Slack/WhatsApp message from an allowed sender
3. A curl request to OpenAI API or webhook
4. An A2A message to the Agent Card URL
5. A cron tick or one-off scheduled invocation
```

The answer determines which package-level tests and runtime smoke must pass before completion.
