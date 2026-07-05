# Playbooks

Condensed, offline copy of the end-to-end recipes. Each maps a persona/goal to a
concrete `mono-agent.config.json` shape and the `init → configure → validate →
start → smoke` flow. Mirrors the published Playbooks index
(<https://mono-agent-docs.vercel.app/playbooks/>); this file is the
self-contained in-skill version so the composer can offer a matching recipe
without fetching anything. Before hand-assembling a config in the Composition
Flow, check whether one of these fits and adapt it. Verify every key against
`references/config-blueprint.md`.

---

## 1. Personal Telegram assistant with BuJo memory
**For:** an individual wanting a private assistant that remembers.
**Goal:** a Telegram bot (long polling) that captures every turn into BuJo memory with nightly reflection + monthly migration and recalls past notes semantically.
**Features:** `telegram.long-polling`, `channel.final-only-delivery`, `memory.bujo`, `memory.per-turn-capture`, `memory.bujo-reflection`, `memory.bujo-migration`, `memory.recall-tool`, `memory.embeddings`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "telegram": { "enabled": true, "botToken": "...", "allowedChatIds": ["123456789"] },
  "memory": {
    "mode": "bujo", "path": "./.mono-agent/memory", "writeMode": "capture",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "endpoint": "http://localhost:11434", "dim": 768 },
    "llm": { "provider": "ollama", "model": "qwen3.6:latest" },
    "reflection": { "enabled": true, "cron": "0 3 * * *" },
    "migration": { "enabled": true, "cron": "0 4 1 * *" }
  }
}
```
**Steps:** `ollama pull nomic-embed-text:v1.5 && ollama pull qwen3.6:latest` → `mono-agent init --model claude:claude-sonnet-4-6 --memory bujo` → add telegram + fill embeddings/llm + `writeMode: capture` → `mono-agent validate` (confirm memory liveness + ritual cadence) → `mono-agent start`.
**Smoke:** send a fact from the allowed chat, then ask a paraphrased question later; confirm `memory_recall` in the run JSONL and that the answer uses it.

## 2. Slack team bot with MCP tools
**For:** a DevOps engineer running a shared team bot.
**Goal:** a mention-triggered Slack Socket Mode bot with a custom MCP tool, Read/Grep, and `slack_send_message` for proactive posts.
**Features:** `slack.socket-mode`, `tool-policy.allowlist`, `tool-policy.mcp-servers`, `agent-app.adapter-send-tools`, `runtime.concurrency`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "slack": { "enabled": true, "botToken": "xoxb-...", "appToken": "xapp-...", "allowedChannelIds": ["C012345"], "botUserIds": ["U012345"], "mentionTextAliases": ["@agent"] },
  "tools": { "allowedTools": ["Read", "Grep", "slack_send_message", "deployTool"], "mcpConfigPath": "./mcp.json" },
  "concurrency": { "maxConcurrentRuns": 4, "maxPendingRuns": 8 }
}
```
**Steps:** create a Slack app (Socket Mode app token + bot token) → `mono-agent init` → write `mcp.json` and add the MCP tool's exact name to `allowedTools` → add slack + `slack_send_message` → `validate` → `start`.
**Smoke:** mention the bot in an allowed channel; confirm the 👀 reaction, final answer, the MCP tool firing in the artifact, and that `slack_send_message` posts only to allowed channels.

## 3. Fully local Ollama agent (no cloud)
**For:** a privacy-focused user with no cloud budget.
**Goal:** runs entirely on local Ollama via the Pi SDK, journal memory with local embeddings, no outbound network.
**Features:** `runtime.local-providers`, `runtime.multi-backend`, `memory.journal`, `memory.embeddings`, `sandbox.network-policy`.

```json
{
  "runtime": { "model": "pi:ollama:gemma4:31b" },
  "providers": { "local": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "enabled": true, "models": [{ "name": "gemma4:31b", "capabilities": { "context_window": 32768 } }] }] },
  "memory": { "mode": "journal", "path": "./.mono-agent/memory", "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "endpoint": "http://localhost:11434", "dim": 768 } },
  "sandbox": { "mode": "native", "network": { "mode": "localhost" } }
}
```
**Steps:** pull both models → `mono-agent init --model pi:ollama:gemma4:31b --memory journal` → add `providers.local` + embeddings + `sandbox.network.mode: localhost` → `validate` (Ollama reachable, models pulled) → `start`.
**Smoke:** `curl -X POST` the webhook path; confirm a local-model response and no outbound non-localhost network in the artifact.

## 4. OpenAI-compatible endpoint for Open WebUI
**For:** an AI-infra engineer fronting the agent with a chat UI.
**Goal:** expose `/v1` (SSE) so Open WebUI can stream and keep multi-turn state.
**Features:** `openai-api.chat-completions`, `runtime.provider-sessions`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "session": { "mode": "continuous", "idleTimeoutMs": 1800000 } },
  "openaiApi": { "enabled": true, "host": "0.0.0.0", "port": 4040, "basePath": "/v1", "allowNonLoopback": true, "modelId": "my-agent", "apiKey": "sk-secret" }
}
```
**Steps:** `mono-agent init` → add `openaiApi` (set `allowNonLoopback`, `apiKey`, `modelId`) + continuous session → `validate` → `start` → in Open WebUI add an OpenAI connection at `http://host:4040/v1` with the bearer.
**Smoke:** `curl /v1/models` returns `my-agent`; two calls with the same `X-OpenWebUI-Chat-Id` resume the session and stream via SSE.

## 5. Webhook automation (sync + async)
**For:** a backend developer wiring the agent into a pipeline.
**Goal:** fast sync calls + long-running async jobs (202 + status polling) across multiple named endpoints.
**Features:** `webhook.http-invoke` (sync/async modes, multiple endpoints, per-endpoint prompt).

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "webhook": {
    "enabled": true, "host": "127.0.0.1", "port": 8080, "defaultMode": "sync",
    "endpoints": [
      { "name": "invoke", "path": "/webhook/invoke", "mode": "sync", "prompt": "Respond to this request:" },
      { "name": "jobs", "path": "/webhook/jobs", "mode": "async" }
    ],
    "retentionMs": 300000, "maxStoredRequests": 100
  }
}
```
**Steps:** `mono-agent init` (webhook already enabled) → add `endpoints[]` (or `webhook/*.md` files; unique names AND paths) → `validate` → `start`.
**Smoke:** `POST /webhook/invoke` for an immediate body; `POST /webhook/jobs` → 202 + status URL → poll until the result returns.

## 6. Cron digest with proactive Slack notify
**For:** a data analyst wanting a scheduled briefing pushed to the team.
**Goal:** a timezone-aware cron job that builds a daily digest with shared history and posts it to Slack.
**Features:** `cron.scheduled-prompts`, `agent-app.adapter-send-tools`, `slack.socket-mode`, `memory.journal`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "slack": { "enabled": true, "botToken": "xoxb-...", "appToken": "xapp-...", "allowedChannelIds": ["C012345"] },
  "tools": { "allowedTools": ["slack_send_message", "WebSearch"] },
  "cron": { "jobs": [{ "id": "morning-digest", "enabled": true, "expression": "0 9 * * *", "timezone": "America/New_York", "prompt": "Build the morning digest and post it to #team via slack_send_message.", "conversationId": "daily-digest" }] }
}
```
**Steps:** `mono-agent init` → add slack + `slack_send_message` → add the cron job (or `cron/morning-digest.md`) with `conversationId` + IANA timezone → `validate` → `start`.
**Smoke:** trigger a one-off tick; confirm `slack_send_message` posts the digest to the allowed channel and `conversationId` shares context across ticks.

## 7. A2A provider + consumer pair
**For:** a platform integrator connecting two agents over A2A.
**Goal:** publish agent A as an A2A provider (Agent Card, bearer); configure agent B to discover and call it.
**Features:** `a2a.provider`, `a2a.consumer`.

```json
{
  "a2a": {
    "enabled": true,
    "provider": { "host": "127.0.0.1", "port": 4201, "requireBearer": true, "bearerToken": "..." },
    "agent": { "name": "Research Agent", "description": "Does research.", "version": "0.1.0" },
    "skill": { "id": "research", "name": "Research", "description": "Web research", "tags": ["research"] },
    "consumer": { "remoteAgentUrls": ["http://127.0.0.1:4201"], "defaultRemoteAgentUrl": "http://127.0.0.1:4201", "bearerToken": "...", "timeoutMs": 30000 }
  }
}
```
**Steps:** provider — `init`, add `a2a.provider/agent/skill` + bearer, `validate`, `start`, confirm the Agent Card is reachable. Consumer — set `a2a.consumer` (or compose `createA2AConsumerResponder`), send text to the provider's Agent Card URL with the bearer.
**Smoke:** send a message to the provider's Agent Card URL with the bearer; confirm a real response.

## 8. Multi-agent orchestration (`ask_collaborator`) — code
**For:** a workflow designer composing specialist agents.
**Goal:** one orchestrator delegates to named collaborator responders via the loopback `ask_collaborator` MCP tool.
**Features:** `orchestrator.ask-collaborator`, `harness.request-runtime-options`, `runtime.custom`.

```ts
const ext = createCollaboratorToolRuntimeExtension({
  collaborators: [
    { id: "researcher", label: "Research", responder: researcher },
    { id: "writer", label: "Writer", responder: writer },
  ],
  conversationId, maxCalls: 10,
});
// pass ext.runtimeOptions via createConfiguredAgentResponder({ runtimeOptionsForRequest })
// call ext.cleanup() on disposal to close the ephemeral MCP server
```
**Smoke:** give a compound task ("research X then write a summary"); confirm the artifact shows `ask_collaborator` delegating to both, and `cleanup()` closes the MCP port.

## 9. Sandboxed code agent (loopback only, deny .env)
**For:** a security team deploying an internal code assistant.
**Goal:** read repos + run Bash inside the native srt sandbox with loopback-only network access and protected secrets.
**Features:** `sandbox.mode`, `sandbox.network-policy`, `sandbox.filesystem-scopes`, `sandbox.fallback`, `tool-policy.allowlist`, `memory.journal`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "tools": { "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] },
  "sandbox": { "mode": "native", "network": { "mode": "localhost" }, "readableRoots": ["."], "writableRoots": ["."], "denyWrite": [".env", ".env.*", ".git/config", ".git/hooks/**"], "fallback": "fail-closed" }
}
```
**Steps:** `mono-agent init --memory journal` → allow Read/Write/Edit/Glob/Grep/Bash → `sandbox.mode native` + `network localhost` + deny-write defaults → keep `fallback: fail-closed` (do NOT set `unsafe-host-process`) → `validate` → `start`.
**Smoke:** ask it to read a file + run Bash (works), then fetch an external URL or write `.env` (both blocked in the artifact). Note: provider CLI bridges run their own tool loops and may not be srt-wrapped — pair with provider sandboxing.

## 10. Phoenix-observed agent with the TUI
**For:** an agent builder evaluating runs in a tracing dashboard.
**Goal:** run locally with the TUI and stream every run to Phoenix as OpenInference spans; local JSONL is the fallback.
**Features:** `observability.phoenix-exporter`, `observability.jsonl-artifacts`, `observability.trace-registry`, `tui.chat`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" },
  "artifacts": { "dir": ".mono-agent/artifacts" },
  "traceability": { "registryDir": ".mono-agent/trace-sources", "sourceId": "my-agent", "heartbeatMs": 10000 },
  "observability": { "exporters": [{ "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces", "projectName": "my-project", "includeSensitiveData": false, "timeoutMs": 5000 }] }
}
```
**Steps:** start Phoenix (6006) → `init` → add artifacts/traceability/exporter → `validate` (POSTs an empty protobuf) → `start` (prints the Phoenix endpoint) → `mono-agent tui`.
**Smoke:** complete a TUI prompt; confirm a redacted JSONL artifact AND a Phoenix trace with merged tool spans under the project.

## 11. Backfill historical runs to Phoenix
**For:** an ops engineer onboarding observability after the fact.
**Goal:** retroactively export recorded JSONL runs to Phoenix with original timestamps, idempotently.
**Features:** `observability.backfill`, `observability.phoenix-exporter`, `observability.jsonl-artifacts`.

```json
{ "artifacts": { "dir": ".mono-agent/artifacts" }, "observability": { "exporters": [{ "type": "phoenix", "endpoint": "http://127.0.0.1:6006/v1/traces", "projectName": "my-project" }] } }
```
**Steps:** ensure `run-*.summary.json` + `run-*.events.jsonl` exist and Phoenix is reachable → `mono-agent backfill --all --since <iso> --until <iso> --dry-run` → `mono-agent backfill --all --since <iso>`.
**Smoke:** dry-run then real export; historical timestamps preserved in Phoenix and a second run does not duplicate spans (deterministic ids).


## 12. Multi-model fallback chain with transcript resume
**For:** a reliability-minded builder who can't afford a single-provider outage.
**Goal:** a primary model with ordered backups the native failover router tries on retryable failures, resuming from the transcript tail — reported, never silent.
**Features:** `runtime.multi-backend`, `runtime.fallback-models`, `runtime.pi-native-tuning`, `runtime.provider-sessions`.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "fallbackModels": ["pi:openai-codex:gpt-5.5", "pi:ollama:gemma4:31b"], "session": { "mode": "continuous" } },
  "providers": { "local": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434", "enabled": true }], "piNative": { "piMaxRetries": 2, "maxRetryDelayMs": 60000, "piSessionsRoot": ".mono-agent/sessions" } }
}
```
**Steps:** `ollama pull gemma4:31b` → `mono-agent init --model claude:claude-sonnet-4-6 --fallback-models pi:openai-codex:gpt-5.5,pi:ollama:gemma4:31b` → add `providers.local` + `piNative.piSessionsRoot` → `validate` → `start`.
**Smoke:** force a retryable primary failure; confirm the run result reports failover to the next model (not silent) and the conversation resumes from the transcript tail.
