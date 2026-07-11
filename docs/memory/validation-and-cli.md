---
title: "Validation & CLI maintenance"
sidebar:
  order: 5
---

This page covers how `mono-agent validate` verifies memory liveness (writable root, Ollama reachability, consolidation cadence), how `mono-agent memory` inspects and safely rebuilds the configured backend from an agent folder, and how the standalone `memory-bujo` CLI runs advanced out-of-band maintenance against a memory root. It also explains the `memory.llm` provider choices (`ollama` vs `agent-host`) that the validator inspects.

The memory subsystem **never silently downshifts**: invalid tier prerequisites fail configuration, while operational liveness or index-identity problems appear explicitly as `waiting` in the Memory section. Run `mono-agent validate` before cutover, after changing the tier/model/dimension, and after pulling any model.

## `mono-agent memory` — config-aware preview

`mono-agent memory` is the operator preview for the memory configured in the current agent folder. It loads the same `mono-agent.config.json` and `.env` resolution path as the app, so it sees the active memory mode, backend, root path, embeddings provider, and Supermemory settings without a separate root argument.

Coverage: cli.

```bash
# High-level memory configuration and local-store counts
mono-agent memory stats

# Today's or a specific daily markdown file
mono-agent memory today
mono-agent memory show 2026-07-06

# Recall through the configured backend
mono-agent memory search "release checklist"

# Highest-salience local memories
mono-agent memory top --limit 10

# Aggregate health only: never prints memory text or entity names
mono-agent memory audit --json

# Build and atomically activate a fresh index from canonical files
mono-agent memory rebuild --json

# Swap back to the retained prior generation
mono-agent memory rollback --json

# Machine-readable output for scripts
mono-agent memory stats --json
```

If memory is disabled or missing from config, the command exits successfully and says no memory backend is configured. For local BuJo/journal/lite memory, `stats` reports the configured tier, write mode, recall-tool state, memory root and active database paths, daily-file counts, markdown/database sizes, record/status/type counts, latest capture/access timestamps, and top entities. `today` / `show <date>` print daily markdown when present, and `top` ranks local memories by salience.

`audit` is the safe automation surface: its JSON contains counts, store bytes, exact-duplicate ratio, vector coverage, access concentration, vector backlog, active-generation identity, rebuild policy/source fingerprint, and explicit source-migration accounting. The latter distinguishes indexed items from raw-audit records, unstructured records, missing-identity records (with source locations), recognized legacy-source records (with source locations), and Journal duplicates. It never includes memory text, query text, entity names, queue keys, or source content.

While the configured store runs, it atomically publishes a coalesced metadata-only snapshot at `.index/runtime.json` (plus a 30-second heartbeat). `audit` uses that snapshot for queue capacity/backlog/high-water/drain/failure/discard counts and embedding/LLM call counts since that store start. It marks a closed, dead-process, invalid, or older-than-90-seconds snapshot as stale. Monetary cost, tokens, and search percentiles remain `null` unless another telemetry surface records them; audit does not guess them from memory content.

`search` uses the same recall path as the `MemoryRecall` tool. When local semantic embeddings are configured but unavailable, it prints a warning and falls back to FTS-only recall instead of pretending semantic search succeeded. For Supermemory-backed agents, `search` queries Supermemory and `stats` reports the known configured container/base URL while marking local SQLite-only counts as unknown.

## `mono-agent validate` — memory liveness

`mono-agent validate` (the agent-app doctor) checks both the configured identity and liveness. A managed generation whose tier, embeddings model, or dimension differs from the current config reports `waiting` immediately—before any Ollama/network probe—with the exact active and configured identities plus the stop/rebuild/validate sequence. Operational failures also report `waiting`, so they do not flip the overall result; malformed managed metadata and invalid config remain errors. Read the Memory section. When validating a downstream folder with `mono-agent validate --consumer <path>`, missing memory roots warn instead of being created because consumer validation is read-only.

Coverage: cli.

| Tier | Checks performed |
| --- | --- |
| `lite` | Memory root creatable and writable. |
| `journal` | Root writable + Ollama embeddings reachable + embeddings model pulled (Ollama embeddings only). |
| `bujo` | All journal checks + chat model pulled (`llm.provider: "ollama"` only) + consolidation cadence. |

The checks run in this order:

1. **Managed generation identity** — if `.index/manifest.json` exists, compares its active tier/model/dimension with the configured identity. A mismatch tells you to `mono-agent stop`, run `mono-agent memory rebuild`, and validate again.
2. **Memory root writable** — confirms `memory.path` is creatable and writable.
3. **Ollama embeddings reachable** — only when `memory.embeddings.provider` is `ollama`; probes the embedding endpoint's `GET /api/tags` with a short timeout.
4. **Embeddings model pulled** — for Ollama embeddings only, confirms `nomic-embed-text:v1.5` (or whichever `memory.embeddings.model` you set) appears in that endpoint's `/api/tags`. If absent it emits:
   `⚠  memory embeddings model "nomic-embed-text:v1.5" not found — run: ollama pull nomic-embed-text:v1.5`
5. **Chat model pulled** (bujo only) — only when `memory.llm.provider` is `ollama`; probes the chat endpoint and checks the chat model against its `/api/tags`. `agent-host` chat LLMs are **not** checked against Ollama.
6. **Consolidation cadence** (bujo only) — reports the consolidation cron expression and whether the scheduler will run for the configured `bujo` tier.

A healthy bujo report looks like:

```
[ok] memory.mode     bujo
[ok] consolidation   0 */2 * * * (auto)
```

The embeddings reachability and pull checks only run when embeddings/chat actually use Ollama. With `embeddings.provider: "openai"` the embeddings probes are skipped, and with `llm.provider: "agent-host"` the chat-model pull check is skipped. See [Embeddings](/memory/embeddings/) for the provider matrix and [Consolidation](/memory/rituals/) for the auto-scheduler.

:::caution
Use the exact `:v1.5` tag for the default embeddings model. The bare alias `nomic-embed-text` (no tag) may be absent from your Ollama install and will fail the provider at startup — `validate` checks for the exact tag.
:::

## `memory.llm` provider choices

The validator's behavior depends on `memory.llm.provider`. There are two providers, and which one you pick changes both what runs BuJo capture and what `validate` probes. The tier contract is strict: `journal` requires embeddings, and `bujo` requires both embeddings and `memory.llm`; an invalid tier never silently downshifts.

| Field | `ollama` | `agent-host` |
| --- | --- | --- |
| `provider` | `"ollama"` | `"agent-host"` |
| `model` | local model string, e.g. `qwen3.6:latest` | SDK runtime ref, e.g. `pi:openai-codex:gpt-5.6-terra` |
| `executionMode` | (n/a) | must be `"sdk"` |
| `endpoint` | Ollama URL (default `http://localhost:11434`) | **rejected** — Ollama-only |
| `validate` chat-model check | yes (probes `/api/tags`) | no |

Env overrides: `MONO_AGENT_MEMORY_LLM_PROVIDER`, `MONO_AGENT_MEMORY_LLM_MODEL`, `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE`, `MONO_AGENT_MEMORY_LLM_ENDPOINT`.

### Ollama-backed memory LLM

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "append-host-summary",
    "embeddings": {
      "provider": "ollama",
      "model": "nomic-embed-text:v1.5",
      "endpoint": "http://localhost:11434",
      "dim": 768
    },
    "llm": {
      "provider": "ollama",
      "model": "qwen3.6:latest",
      "endpoint": "http://localhost:11434"
    }
  }
}
```

### Host-runtime (SDK) memory LLM

The `agent-host` provider runs memory LLM passes (one batched memory/graph extraction and, only when close existing candidates need classification, one batched reconcile) on their **own dedicated SDK runtime built from `memory.llm.model`** — independent of the channel runtime — so there is no separate local chat model to pull. The `model` is a runtime reference and `executionMode` **must** be `"sdk"`. Do not set `endpoint` — it is Ollama-only and rejected here.

:::note
The memory LLM always executes on `memory.llm.model`, and that model is its **sole primary** — the memory turn does **not** inherit canonical `runtime.fallbacks` or legacy `runtime.fallbackModels`, so there is no failover chain on memory passes. This is deliberate: reusing the channel fallback router would silently run capture on `runtime.model`.
:::

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "writeMode": "capture",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKeyEnv": "OPENAI_API_KEY",
      "dim": 1536
    },
    "llm": {
      "provider": "agent-host",
      "model": "pi:openai-codex:gpt-5.6-terra",
      "executionMode": "sdk"
    }
  }
}
```

:::caution
`agent-host` memory LLMs are SDK-only for now. CLI-backed refs (e.g. `codex:gpt-5.6-terra`) or an explicit `executionMode: "cli"` are **rejected** at config validation, because those runtimes cannot yet guarantee a no-tools / no-external-actions memory turn.
:::

## The two memory-LLM timeouts

There are **two** per-call memory-LLM timeouts. They share the env var name `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` but belong to different binaries and have **different defaults** — a common source of confusion:

| Path | Config / env | Default | Governs |
| --- | --- | --- | --- |
| **In-app** (the running agent) | `memory.llm.timeoutMs` (env `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS`) | `60000` | Each per-turn [capture](/memory/capture-and-recall/#capture--per-turn-intelligent-capture-bujo) LLM call (one extraction + at most one reconcile) |
| **Standalone CLI** | `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` only | `120000` | Legacy `memory-bujo reflect` / `migrate` run by hand |

So in the app, raise `memory.llm.timeoutMs` (config) when a slow local memory model trips the cap on extraction or reconcile — its default is **`60000`**, not the CLI's `120000`. The value is bounded `1000`–`600000` ms.

When the in-app memory LLM does exceed its timeout, the run reports it explicitly — `agent-host memory LLM timed out after 60000ms (provider too slow or unavailable)` — rather than the generic `cancelled` it used to surface, so a slow or dead provider is diagnosable from the run record. (Capture still swallows the error and stores nothing for that turn rather than failing the user's turn — see [Capture & recall](/memory/capture-and-recall/).)

## Safe index generations: rebuild and rollback

Use the config-aware commands for normal operation:

```bash
cd /path/to/agent
mono-agent stop
mono-agent memory rebuild --json
mono-agent memory audit --json
mono-agent start
```

`rebuild` reads the configured tier, embeddings model, and dimension; snapshots the canonical markdown/graph sources; builds a complete candidate under `.index/generations/<generation>/memory.db`; validates its schema, exact payloads, graph edges, FTS coverage, vector coverage, and model identity; then atomically switches a small manifest. The old active database is retained as the rollback generation. The previous active index remains usable if any step fails before activation, and a legacy `memory.db` is adopted by online backup without changing its bytes.

The running agent must be stopped. The command refuses a matching live process, an active writer lease/SQLite transaction, concurrent source changes, symlinked source paths, or a concurrent manifest change. Journal/BuJo rebuilds can call the configured embeddings provider in bounded batches; rebuild never calls the chat LLM. Rollback swaps already-validated generations and makes no embedding or chat-model request.

`rollback` is deliberately conservative: its retained generation must match the currently configured tier/model/dimension, and its canonical source fingerprint must still match. If the rebuild accompanied a tier, embeddings-model, or dimension change, restore that prior config first, then run:

```bash
mono-agent stop
# restore the prior memory.mode / embeddings model / dimension in mono-agent.config.json
mono-agent memory rollback --json
mono-agent memory audit --json
mono-agent start
```

Rebuild output and `audit --json` report the generation name, indexed count, raw/unstructured/missing-identity/legacy-source/Journal-duplicate skips, source locations that require review, and legacy associations derived by exact unique whole-name matching. BuJo raw audit files are never promoted automatically into the curated index, and no command replays history through a paid chat model.

Supermemory owns its remote index, so `mono-agent memory rebuild` and `rollback` reject that backend explicitly.

## Enable v1 on an existing agent

After the product-v1 packages are published, this is the complete cutover for an existing local agent, with one backend-specific branch in step 5. Use the exact lockstep version named in the release announcement; “product v1” does not by itself imply npm major `1`.

1. Install the v1 CLI and confirm the exact published version:

   ```bash
   VERSION="<published-v1-version>"
   npm i -g "create-mono-agent@$VERSION"
   mono-agent --version
   ```

2. In the agent directory, stop the old process, check/refresh the two managed configuration skills, and open the post-wizard configuration conversation. Reconcile any operator-modified skill before using `--update`:

   ```bash
   cd /path/to/agent
   mono-agent stop
   mono-agent install-skill --project --check
   mono-agent install-skill --project --update
   mono-agent tui --local --configure
   mono-agent config
   ```

   The first local turn asks how you would like to configure the agent. The bundled `mono-agent-configure` and `mono-agent-memory` skills can prepare a constrained proposal; the host still validates it and asks for separate approval before writing.

3. If the configured embeddings provider is Ollama, confirm the exact embeddings model is present:

   ```bash
   ollama list
   ollama pull nomic-embed-text:v1.5   # only if that exact tag is absent
   ```

4. Validate the configured folder and read the **Memory** section. A running Ollama process is not sufficient if the active managed generation has a different tier/model/dimension, the configured endpoint differs, or the exact model tag is missing:

   ```bash
   mono-agent validate
   ```

5. For the built-in Lite, Journal, or BuJo backend, build the first managed index and inspect its local accounting. Then start the agent:

   ```bash
   mono-agent memory rebuild --json
   mono-agent memory audit --json
   mono-agent start
   mono-agent status
   ```

   If `memory.backend` is `supermemory`, skip both `memory rebuild` and the local index audit: Supermemory owns its remote index and those built-in maintenance commands intentionally reject it. Start/status the agent after validation instead.

6. Verify both kinds of context in Telegram without restarting between messages: send `Reply exactly with this token: V1-HISTORY-<unique>`, wait for that reply, then ask `What did you send in the last message?` and confirm the token comes back. That second run should use active history and inject no durable memory. Finally ask a qualified durable-memory question such as `What did we decide about releases last month?` to exercise `MemoryRecall`.

If `memory.llm.provider` is `agent-host`, Ollama is needed only for `memory.embeddings.provider: "ollama"`; you do not need an Ollama chat model. If rollback is needed, stop the agent, restore the prior tier/model/dimension if it changed, run `mono-agent memory rollback --json`, then start again.

## `memory-bujo` CLI — advanced out-of-band maintenance

The `memory-bujo` binary runs maintenance directly against a bujo memory root (the positional `<root>` argument). It is available for all tiers for manual runs; the in-app [auto-scheduler](/memory/rituals/) handles routine lightweight consolidation for `bujo` automatically.

Coverage: cli.

```bash
# Rebuild an already-managed root using an explicitly declared tier
memory-bujo rebuild <root> --tier journal

# Roll back an already-managed root using an explicitly declared tier
memory-bujo rollback <root> --tier journal

# Recall: hybrid BM25 + vector search (prints matching entries)
memory-bujo recall <root> "<query>"

# Write the living index.md (counts, top memories, entities)
memory-bujo index <root>

# Legacy reflection pass: decay + insight synthesis (Ollama-only; needs MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo reflect <root>

# Legacy migration: promote/reschedule/cluster/forget (Ollama-only; needs MONO_AGENT_MEMORY_LLM_MODEL)
MONO_AGENT_MEMORY_LLM_MODEL=qwen3.6:latest memory-bujo migrate <root>
```

| Command | Needs embeddings? | Needs chat LLM? |
| --- | --- | --- |
| `rebuild` | required for `journal` / `bujo`; forbidden for `lite` | no |
| `rollback` | required to declare the retained `journal` / `bujo` identity; no provider request | no |
| `recall` | only if `MONO_AGENT_MEMORY_EMBEDDINGS_*` set (else FTS-only) | no |
| `index` | no | no |
| `reflect` | no | yes — Ollama-only, `MONO_AGENT_MEMORY_LLM_MODEL` required |
| `migrate` | no | yes — Ollama-only, `MONO_AGENT_MEMORY_LLM_MODEL` required |

`rebuild` and `rollback` require `--tier <lite|journal|bujo>`. The standalone CLI refuses the first managed activation because it cannot safely infer the configured agent identity or prove that the configured process is stopped; use `mono-agent memory rebuild` for that transition. For subsequent standalone rebuilds, the embeddings environment must match the declared tier and retained generation exactly.

### Semantic recall is opt-in for read-only recall

The standalone CLI reads the **same `MONO_AGENT_MEMORY_*` env vars** as the app. Embeddings remain opt-in for `recall`: set `MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER` (`ollama` / `openai`) to enable semantic recall, or omit it for FTS-only recall. For safe rebuild/rollback, the strict tier decides whether embeddings are forbidden (`lite`) or required (`journal`/`bujo`). When enabled, the model defaults to `nomic-embed-text:v1.5` (`MONO_AGENT_MEMORY_EMBEDDINGS_MODEL`) and the dimension to 768 (`MONO_AGENT_MEMORY_EMBEDDINGS_DIM`). See [Embeddings](/memory/embeddings/) for the full env list.

### reflect / migrate are legacy and Ollama-only

The standalone CLI uses the built-in Ollama chat adapter for `reflect` / `migrate` — it does **not** route through the agent host, so `memory.llm.provider: "agent-host"` does not apply to the CLI. These commands are manual compatibility tools, not the app's scheduled maintenance path. You must set `MONO_AGENT_MEMORY_LLM_MODEL`; if it is unset when running `reflect` or `migrate`, the command prints a clear error and exits `2` (no silent fallback). `MONO_AGENT_MEMORY_LLM_ENDPOINT` overrides the Ollama endpoint (default `http://localhost:11434`), and `MONO_AGENT_MEMORY_LLM_TIMEOUT_MS` sets the per-call timeout (CLI default `120000` — distinct from the in-app default; see [The two memory-LLM timeouts](#the-two-memory-llm-timeouts)); raise it for slow models.

For the in-app runtime you can instead use `memory.llm.provider: "agent-host"` for capture through an SDK model — see the [provider choices](#memoryllm-provider-choices) above and [Consolidation](/memory/rituals/) for the deterministic auto-scheduler the CLI complements.

## Related

- [Embeddings](/memory/embeddings/) — providers, models, dimensions, and env vars.
- [Capture & recall](/memory/capture-and-recall/) — `writeMode` and the `MemoryRecall` tool.
- [Consolidation](/memory/rituals/) — in-app consolidation auto-scheduler.
- [Config blueprint](/config/blueprint/) — the full annotated `memory` block.
- [Environment variables](/config/env-vars/) — every `MONO_AGENT_MEMORY_*` override.
- [CLI reference](/observability/cli-reference/) — the broader `mono-agent` command surface.
