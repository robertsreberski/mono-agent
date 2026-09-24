---
title: "Write modes, capture & recall"
description: "Understand completed-turn admission, write modes, automatic context recall, targeted MemoryRecall, and bounded local MemoryJournal chronology."
sidebar:
  order: 2
---

This page covers the two halves of the memory loop: how the host **writes** each completed turn (`memory.writeMode`) and how the agent reads memory through targeted `MemoryRecall` search or bounded local `MemoryJournal` chronology. Both are driven by the single `config.memory` block — there is no separate `.mcp.json` entry to hand-wire.

For tier selection (lite / journal / bujo) and embeddings setup, start at the [Memory overview](/memory/) and [Embeddings](/memory/embeddings/). Recall is the read path; scheduled consolidation is the maintenance path covered in [Consolidation](/memory/rituals/).

## Write modes (`memory.writeMode`)

`memory.writeMode` controls how the **host runtime** persists each completed turn. It is independent of the tier's recall capability. Coverage: **config** .

| Mode | What it does | Backend / tiers | LLM |
|------|--------------|-------|-----|
| `disabled` | Never persist turns. Recall still works over existing memory state. | Lite/Journal/BuJo | no |
| `append-host-summary` | Admit one deterministic host observation by provider run id, then fsync and project it. | Lite/Journal/BuJo | no |
| `capture` | Admit the host summary plus full approved capture text by provider run id, then curate it in the background. | BuJo | configured chat model |

The host deliberately skips memory writes for two low-signal successful turns, in every write mode: final answers that are `NOTHING_TO_REPORT` (the cron/webhook no-op sentinel), or that end with it on their final line, and tiny explicit test/ping probes such as `test` / `test ok`. Short contextual acknowledgements are not skipped by this default.

Cron and webhook turns omit their trigger prompt and webhook pre-instructions from memory. Intelligent capture receives an honest scheduled-task or webhook source label (not `User`) plus the assistant answer; the deterministic host summary remains assistant-answer-only. The extractor must not treat an assistant recap as a first-party report. There is no deterministic recap classifier, so model-guided capture may still make mistakes; the no-op sentinel remains the deterministic skip.

Memory persistence is **host-owned**. When a user says “remember this,” the agent should acknowledge the request normally and let the configured write mode decide whether and how to persist the completed turn after the reply succeeds. It must not use shell, filesystem, or database tools to edit `.mono-agent/memory`, canonical Markdown, SQLite rows, manifests, generations, or indexes directly. Operators should stop the agent and use the `mono-agent memory ...` maintenance commands when they need to rebuild, migrate, audit, or repair memory state. `memory export` is the one exception: it is strictly read-only and can back up a live agent. `memory import apply` and `import restore` do require a stopped agent.

```json
{
  "memory": {
    "mode": "journal",
    "writeMode": "append-host-summary",
    "path": "./.mono-agent/memory"
  }
}
```

```json
{ "memory": { "writeMode": "append-host-summary" } }
```

### Durable completed-turn admission

The built-in store implements the harness's strong completed-turn write. Before a successful
turn reaches terminal reporting, the harness awaits an owner-only, fsynced record under
`memory.path/.capture-intake/pending/`. The filename is the SHA-256 hash of the stable provider
run id; retrying the same run and payload is a successful duplicate, while reusing that run id
with different bytes fails closed. An admission failure does not replace the provider's answer,
but it emits an explicit memory-degradation warning instead of pretending the turn was saved.

Only a turn that reaches the successful commit boundary qualifies. A cancelled
or failed non-isolated turn may publish a bounded continuity account into
canonical conversation history, but neither account nor its partial
assistant/tool content is admitted to `append-host-summary` or `capture`.
Hard-interrupted, isolated, and never-started turns remain excluded as well.

The admitted record is the restart boundary. It contains the bounded deterministic summary and,
for `writeMode: "capture"`, the bounded host-approved capture text. Projection and BuJo curation
may run after the reply, but a process restart resumes them from the durable record. Pending work
uses 16 bounded exponential-backoff attempts (one minute initially, capped at six hours, spanning
more than 24 hours) before moving to a durable dead letter. Resolved receipts are retained in a
bounded rich set, while an exact content-free `id + payload-hash` commitment remains permanently
in one of 256 cataloged compact append-only ledger shards. A sibling owner-only integrity catalog
commits every shard's byte high-water mark and SHA-256 after the shard append is fsynced. Missing,
truncated, or valid-looking replacement shards therefore fail closed. A crash between shard append
and catalog commit can advance the catalog only when every suffix entry still has an exact
materialized intake receipt and after the exact shard inode is fsynced again. A separate
owner-only schema marker at the memory root proves that the catalog has existed, so deleting both
the ledger and catalog cannot masquerade as a pre-ledger upgrade. Receipt pruning therefore cannot make an old run
admissible again or create another raw-audit line/curated fact. The intake directories are `0700`
and records/ledger shards are `0600`; symlinks, ownership changes, conflicting payloads, malformed
records, partial ledger writes, and unsafe crash transitions are rejected or deterministically
recovered before admission.

A safe rebuild may change the BuJo embedding provider or dimension while a run-owned semantic
plan is retained: the candidate is rebuilt from canonical source with the new embedding identity,
and the exact plan remains available until intake resolution. Rebuilding that retained plan into
Lite or Journal is refused before source mutation, because those tiers cannot preserve the same
BuJo run-derived ids and provider-bound replay contract. Start the current BuJo configuration to
finish the durable intake before changing tiers.

External writable `MemoryStore` implementations must implement `persistCompletedTurn`
and own stable `runId` admission and deduplication semantics. Read-only stores may
omit it; the harness rejects enabled writing when the method is absent. Mono-agent
does not infer, provision, or configure an external service. The optional
`captureSpeakerKind` on completed turns is host-verified outer-turn provenance,
not a label extracted from text or `metadata.source`: `human-turn`, `trigger`, or
`unknown` (the default for legacy and direct callers). An external store must
preserve the distinction without silently upgrading unknown/trigger assertions
into first-party evidence. Owner-authorized operator turns, including keyless
loopback-only clients, are treated as the human owner; automation using that
interface is consequently attributed as the owner. A keyless non-loopback
operator endpoint is not trusted for human attribution. Channel adapters must
verify the sender before setting `human-turn`; a copied payload field is not
verification. This provenance contract does not itself produce typed graph facts.

### Direct integrations

The harness, direct embedders, and offline calibration use `persistCompletedTurn`.
Capture mode reaches strict extraction after durable, run-idempotent admission.
The legacy capture queue, direct `capture()` method, and loose capture exports have
been removed. See the [migration guide](/reference/framework-simplification-migration/).

### Strict tier write behavior

- **Lite:** projects the admitted normalized host observation to `daily/YYYY-MM-DD.md` and indexes it for FTS. It never embeds and never calls a chat model.
- **Journal:** projects the admitted observation with a case-preserving, NFKC/whitespace-normalized SHA-256 identity, then makes it available to FTS. Semantic indexing is queued in batches of up to 32, so Ollama/LM Studio/OpenAI embedding latency is not on the provider-success critical path. Repeated content converges on one markdown/index identity.
- **BuJo:** projects each admitted compact host observation to `audit/YYYY-MM-DD.md`, outside curated recall. Only `writeMode: "capture"` asks the memory model to promote durable facts into canonical `daily/` notes and the graph. A model outage therefore cannot turn an uncurated raw transcript into recalled fact.

### Exact BuJo replay projection

BuJo capture can also create replay-owned state that canonical daily markdown
and `graph.jsonl` cannot reconstruct by themselves: thread edges, supersession
lifecycle/edges, and terminal timestamps from an explicit migration forget.
The owner-only `memory.path/.replay-projection-v1.json` is the exact canonical
authority for that state. It contains only metadata—memory ids, timestamps,
thread weights, authority kinds, and content-free SHA-256 authority digests;
it contains no memory text or model output.

Capture and migration publish their exact projection delta while the durable
capture intent or migration marker still exists, prove that SQLite matches it,
and only then retire that durable authority. A crash at any boundary therefore
leaves enough state for an idempotent replay. Strict health compares the full
sidecar and SQLite projection exactly; structurally plausible lifecycle or
edges written directly to SQLite are `canonical_mismatch`, not trusted history.
The sidecar itself is strict canonical JSON, an owner-owned single-link regular
file with mode `0600`, and is bounded to 32 MiB / 131,072 entries.

Lite and Journal do not consume the BuJo sidecar and reject replay-owned
lifecycle or edges in their SQLite index. BuJo also never infers a nonempty
projection from SQLite: if a legacy managed generation or unmanaged `memory.db`
has replay state but no sidecar, keep the agent stopped and use the explicit
metadata-only `mono-agent memory adopt-replay --json` trust-on-first-use flow
before rebuild. Adoption can safely attest multiple disjoint capture
intents/receipts and at most one migration marker. Mutable pending capture work
and a pending migration are mutually exclusive; immutable completed capture
receipts may coexist with the later migration, and retained receipts remain
until intake resolves.
Rebuild must immediately follow adoption and completes any attested protocol
without repeating provider work. Building the replacement semantic generation
still uses the configured embeddings provider before activation. Never start
the service between those steps.
See [Validation & CLI](/memory/validation-and-cli/#bujo-replay-projection-and-explicit-legacy-adoption).

The durable intake and both downstream paths are bounded and observable. Intake admits at most
4,096 active pending/dead records of at most 640 KiB each and retains at most 4,096 resolved
receipts. Its permanent content-free ledger grows by one fixed 129-byte entry per distinct run id
across up to 256 lazily created shard files plus one fixed-size 256-slot integrity catalog. Journal
indexing holds at most 256 items / 2 MiB. Each capture-model completion is
rejected before parsing when it exceeds 262,144 JavaScript characters. Runtime snapshots report
content-free intake pending/dead/resolved/due/transition counts alongside downstream queue and
shutdown state. The store republishes that snapshot immediately after admission and every durable
intake transition, so a strict health audit sees newly accepted work as `in_progress` without
waiting for the periodic heartbeat. Notification failures never roll back or misreport the durable
transition; the on-disk intake remains authoritative. Shutdown gives work up to 10 seconds to
drain; after that deadline it aborts the cooperative active attempt and returns while the intake
record remains pending for restart.

Operators can inspect that intake without reading its summaries or capture text:

```bash
mono-agent memory inspect --json
mono-agent memory inspect <64-character-id> --json
```

Inspection returns only ids, states, timestamps, attempts/revisions, due flags, bounded failure
categories, and aggregate counts. With the matching agent stopped, `memory retry [<id>]` makes
dead/delayed work due for processing after restart. `memory resolve <id> <reason-slug>` is the
explicit loss-accepting path: it records `operator_resolved` without claiming capture succeeded,
preserves permanent duplicate protection, and refuses recoverable retained semantic plans. See
[Validation & CLI](/memory/validation-and-cli/#completed-turn-intake-inspection-and-recovery) for
the liveness fence, exact inputs, and no-op semantics.

### `capture` — per-turn intelligent capture (bujo)

`capture` fsyncs the completed turn into durable intake, then projects its compact raw audit and
runs curation in the background, except for the low-signal skipped turns described above. The plan
uses exactly one chat-LLM call to extract up to eight atomic memories plus their precise
entities/relations, then at most one additional batched call to classify close existing candidates
as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP`. Clearly novel candidates skip the second call. Entity
extraction is part of the first call, not a third pass.

Key properties:

- **Local admission before terminal status.** The provider call is already complete; terminal reporting waits only for the bounded filesystem admission, never for embeddings or the chat model.
- **Restartable background work.** Raw-audit projection and curation resume from pending intake after restart or provider recovery.
- **Serialized per store.** Captures do not race each other against the same memory root.
- **Bounded shutdown without admitted-work loss.** A normal stop drains accepted work with a 10-second safety deadline. If a provider ignores cancellation, stop still returns and the durable pending record resumes on restart.
- **Strict model contracts.** Extraction and reconciliation accept one exact, bounded JSON value with complete arrays/decisions and no duplicate keys, unknown fields, partial filtering, unsafe text, or ambiguous target collisions. Reconciliation spells out the exact per-action shape: `ADD` has index/action only; `NOOP` requires a supplied target id; `UPDATE` and `SUPERSEDE` require that target plus complete replacement text. Invalid output retries and never counts as successful capture.
- **Reconcile is intelligent**, not append-only: the pipeline classifies each observation as `ADD` / `UPDATE` / `SUPERSEDE` / `NOOP` against existing memories to avoid duplication.
- **Crash-idempotent semantic commit.** Run-derived fact ids, a retained semantic plan, and the exact replay projection make a post-commit/pre-receipt replay converge without another model call, duplicate fact, or unattested lifecycle/edge.
- **Associations are precise.** Each curated fact carries only the entity IDs explicitly extracted for that fact; the implementation never creates a turn-wide memory/entity Cartesian product.
- **Time is observation-grounded.** Capture asks the model to resolve unambiguous relative calendar dates against the immutable host-owned UTC admission instant, retain broad intervals when precision is unavailable, and express an age snapshot as historical (`was 7.5 months old as of 2026-09-08`), not a permanent current age. When the anchor is absent it must not fabricate one. Reconciliation converts a recognizably new age/current-status UPDATE to a newly dated ADD rather than rewriting an older daily bullet. These are model instructions plus a finite snapshot guard, not factual verification.

This path uses a chat LLM, so `writeMode: "capture"` **requires
`mode: "bujo"`** and fails config validation otherwise—there is no silent fallback
or tier downshift.

```json
{
  "memory": {
    "mode": "bujo",
    "writeMode": "capture",
    "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "agent-host", "model": "openai-codex:gpt-5.6-terra" }
  }
}
```

```json
{ "memory": { "mode": "bujo", "writeMode": "capture" } }
```

An agent can optionally narrow automatic capture with `memory.capture.focus` (up to
2048 UTF-8 bytes of operator-written guidance, inside a delimited extraction-prompt
section) and `memory.capture.only` (a subset of `fact`, `preference`, `lesson`).
For example, a fictional coding agent might use:

```json
{
  "memory": {
    "mode": "bujo", "writeMode": "capture", "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "llm": { "provider": "agent-host", "model": "openai-codex:gpt-5.6-terra" },
    "capture": {
      "focus": "Keep durable coding preferences and lessons; skip PR and CI status.",
      "only": ["preference", "lesson"]
    }
  }
}
```

`focus` guides selection, but cannot override the strict JSON contract, attribution
or host safety checks. `only` is deterministic: after host label validation and
reconciliation, capture stores a memory only if one accepted label has an allowed
kind; unrelated graph nodes are also dropped. An empty `only` list suppresses
all automatic capture; unset preserves existing capture behavior. These settings
require BuJo capture mode, and never affect explicit `Remember` writes or the
compact host audit of admitted turns.

:::caution
The capture pipeline never replaces the user's successful provider answer. An LLM/embedding timeout emits a memory warning, leaves the admitted turn pending, and retries it durably; only exhaustion moves it to a dead letter. Raise the in-app per-call timeout — `memory.llm.timeoutMs`, **default `60000`** — for a slow model; see [Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout).
:::

The BuJo chat model used by capture comes from the tier's required `memory.llm` block. [Scheduled consolidation](/memory/rituals/) keeps that strict tier contract but is projection-only and makes no LLM call. With `memory.llm.provider: "agent-host"`, capture can point at an SDK runtime model reference (e.g. `openai-codex:gpt-5.6-terra`). The extraction prompt explicitly states exact fields, array bounds, identifier/reference grammar, lowercase relations, and the canonical `0..1` salience range. The provider-neutral strict parser remains authoritative and never clamps, rescales, or coerces model values. Standalone `migrate` remains Ollama-only; legacy `reflect` is a read-only due-state report and needs no model.

## The `MemoryRecall` tool

The agent performs targeted durable-memory search through the read-only `MemoryRecall` tool: hybrid **keyword (FTS) + vector** search over the same memory it writes to. Coverage: **config** .

`MemoryRecall` runs **no chat LLM** — recall is embeddings + full-text search only. Durable writes stay in-app on the agent-host LLM via [per-turn capture](#capture--per-turn-intelligent-capture-bujo); recall just reads.

Recall returns live records, which includes completed, scheduled, and migrated
items — not only open ones. Terminal `dropped`/`invalidated` records stay
excluded. So that a finished or deferred item cannot read as a current fact, a
result whose status is not `open` is prefixed with that status, for example
`0.800  [recorded 2026-07-06T12:00:00.000Z] [done] Ship the 0.9 release.`; an ordinary open record also includes the recorded timestamp when supplied. Explicit tool hits are reranked by coverage of the query terms present in the candidate set without changing automatic recall thresholds. Structured results carry optional `type`, `status`, `createdAt`, `validFrom`, and `validTo` alongside `id`, `score`, and `text` whenever the backend supplies them — a remote backend that reports none keeps its previous result shape unchanged. `createdAt` is the recording instant, not necessarily the event date.

Questions about the active chat are intentionally not durable-memory queries. For
unqualified prompts such as `What did you send in the last message?`, `What was your
previous reply?`, or `What happened in this conversation?`, automatic recall injects
nothing and `MemoryRecall` returns guidance to use the active conversation history
without calling the memory backend. A targeted archived question such as `Which release
color did we decide on?` still uses durable recall. A broad explicit-period question such
as `What did we work on last week?` belongs to `MemoryJournal` when available. This
prevents an older semantically similar record from displacing the actual latest message
and keeps broad chronology distinct from targeted search.

Interrupted-run recovery is also not a durable-memory query. For a request to
pick up, continue, or recover interrupted work, the model-facing tool contract
routes to `RunHistory {}` first when available. An empty `MemoryRecall` response
repeats that conditional exact handoff so the agent does not keep rephrasing
memory searches for evidence owned by run history.

:::note
**Where recalled memory appears in the prompt.** Beyond this on-demand tool, the harness *automatically* appends recalled memory to the **user message** at the start of each turn (when a recall returns hits), clearly delimited as background context — it is **not** folded into the system prompt. Riding the user message is what lets memory survive a session resume on runtimes that drop the system prompt. The injected block is not persisted to history, and a `memory_recalled` diagnostic records that recall fired (source + byte size, not the content). See [Context assembly → Memory recall](/context/assembly/#memory-recall).
:::

### How it is provisioned

The configured harness auto-provisions `MemoryRecall` from the single `config.memory` block unless `config.memory.recallTool.enabled` is explicitly `false`. This default applies both to config loaded from disk and to direct `createConfiguredAgentHarness` / `createConfiguredAgentResponder` composition whose typed memory block omits `recallTool`. It exposes a request-scoped loopback MCP endpoint backed by the **same open store and retrieval service** as automatic recall. Identical normalized automatic/tool queries share one per-turn lookup; a different tool query may search again. No second SQLite handle, embedding request, or hand-maintained MCP config is involved. Caller-supplied request extensions are composed with the default tool instead of replacing it.

On this request-scoped configured-harness path, the tool also offers a deliberate
`useOriginalQuery: true` mode. It reuses the bounded direct lookup already made for
the current logical turn's original user question, even when the finite automatic
evidence gate correctly abstained and a later rephrased search would retrieve a
different set. Existing deliberate-recall graph expansion still applies when
supported; it can add related evidence within the existing result limit. The mode
does not combine results from different queries, widen automatic injection, or
repeat the direct backend lookup. Supply either `query` for an ordinary
query-local search or `useOriginalQuery: true`, never both. The mode is unavailable
after an in-turn nonduplicate memory write, for active-conversation-relative or
empty questions, after turn cleanup, and on standalone or capability-free
programmatic recall servers that do not own the bound automatic lookup.

The shared writable store counts only delivered memory IDs, once per logical
turn, in either mode, including tiers without graph expansion.

The endpoint is allocated only after the turn acquires a provider-concurrency slot, so queued turns do not accumulate listeners. If endpoint startup fails, the host warns and omits the explicit tool for that turn; automatic recall and the provider response continue. If the memory backend itself fails during a tool call, `MemoryRecall` returns an explicit degraded result instead of fabricated hits.

```json
{
  "memory": {
    "mode": "bujo",
    "path": "./.mono-agent/memory",
    "embeddings": { "provider": "ollama", "model": "nomic-embed-text:v1.5", "dim": 768 },
    "recallTool": { "enabled": true }
  }
}
```

```json
{ "memory": { "recallTool": { "enabled": true } } }
```

| `recallTool.enabled` default | Condition |
|------------------------------|-----------|
| **on** | every configured tier: Lite (FTS), Journal/BuJo (hybrid), and external backends |
| off | only when set explicitly to `false` |

This replaces the retired standalone `@mono-agent/memory-mcp` package (which also shipped `memory_capture` / `memory_note` write tools — both dropped, since in-app capture now covers durable writes). To build a recall server directly in your own code, compose `@mono-agent/memory/bujo` (`createBujoMemoryStore`) with `@mono-agent/memory/search` (`createEmbeddingProvider`) — exactly what the bundled server does. See [Programmatic composition](/programmatic/composition/).

### Recall scoring

Recall fuses two retrievers and re-ranks the result:

- **BM25 keyword (FTS)** over the markdown entries.
- **Vector similarity** over the configured embeddings.
- Results are combined with **Reciprocal Rank Fusion (RRF)** and evidence strength; salience/insight are small tie-breakers. `lastAccessedAt` and access counts are telemetry only and never affect ranking.
- Automatic recall treats raw embedding similarity as ranking evidence, not a calibrated probability: it first considers the `0.65` absolute / `77%` top-relative score band, then applies a deterministic direct-fact gate to a bounded candidate window. The gate admits only canonical, unambiguous shapes: an explicitly named possessive property (`Morgan's phone number is ...`), a direct choice (`Morgan selected ... as the deployment color`), a scope-qualified choice (`What color did Mira select for the Velin launch?` answered by `Mira selected cobalt as the color for the Velin launch.`), a direct event date/time, or a direct work/live location. A scope is not a property: a record that only says `Mira selected cobalt for the Velin launch` never states that cobalt is the *color* and still abstains. Scope identity is compared conservatively, so `Project A`/`Project B`, `launch 1`/`launch 2`, `Bora Bora`/`Bora` and `A-team`/`-team` stay distinct. Only case, whitespace, Unicode compatibility forms and a single *standalone* leading article are normalized; an article merges only when followed by whitespace or by nothing, so an identifying prefix such as `A-team` survives. Compatibility normalization (NFKC) is the same folding the query already receives before the gate and the backend cache, so it also treats `release²` and `release2` as one scope. When the bounded candidate window holds contradictory values for the same subject, property and scope, automatic recall abstains entirely rather than injecting both or letting retrieval score pick a winner. Three finite first-party forms may preserve an explicit report around an otherwise supported property, choice, or work/live location, such as `Avery reports that their service port is 8443` or `Avery reports working in Amsterdam`. The textual reporter must equal the query subject exactly apart from case; the broader canonical-name stemming used by legacy direct facts is not used at this attributed boundary. NFKC is applied only as a safety check for compatibility characters that conceal quotation, separators, or punctuation, never to sanitize such text into an admissible report, and the original qualified sentence is injected unchanged. This is query-to-evidence matching: it does not authenticate that Avery is the current user, establish identity from a same-name match, or verify the reported proposition. Conflicting canonical/attributed or attributed/attributed values abstain before score slicing. A matching same-property correction blocks automatic selection even when its leading value equals a canonical record; the selector does not infer either the old or replacement value. Coordination, all other reported or ditransitive speech, assistant/third-party/quoted claims, uncertainty, correction, negation/unknown values, causal or conditional clauses, actor/relationship questions, subordinate clauses, and multi-hop evidence abstain. Those records remain available through the default-on `MemoryRecall` tool, where the model can inspect separate results and provenance instead of receiving a fabricated binding. The gate adds no embedding or chat-model call, works across provider score scales, injects nothing for unsupported questions, and remains capped at five hits / 8 KB. Deliberate tool calls may inspect more results (up to the requested limit).

Scheduled temporal questions are one bounded copular-time form. For example,
`When is the Project Atlas production migration scheduled?` can use a direct
record such as `Project Atlas production migration is scheduled for 20 November
2026 at 08:30 Europe/Paris.` The event identity remains exact apart from case,
whitespace, Unicode compatibility forms, and a standalone leading article;
project words, one-character tokens, digits, punctuation, order, and repetition
remain significant. Clock colons are accepted only as valid ASCII `HH:MM` tokens
in a supported temporal answer, not in generic properties, choices, or
locations. Quoted, uncertain, attributed, or control/format-bearing schedule
payloads abstain. NFKC safety discovery applies the same forbidden-language
policy to compatibility-folded text, but never converts an unsupported clock or
separator into accepted syntax. Automatic recall abstains when the retrieved
cohort contains two scheduled payloads that
are not textually identical after case, whitespace, and Unicode compatibility
normalization. It deliberately does not equate alternate date formats or
date-only and date-time values; use `MemoryRecall` to inspect those raw
candidates instead.

You can exercise the same hybrid scoring config-aware from the agent folder with `mono-agent memory search`:

```bash
mono-agent memory search "what did we decide about the rollout?"
```

### Entity graph (bujo auto)

The BuJo tier also maintains a lightweight entity graph beside the curated daily notes. During `writeMode: "capture"`, the first bounded extraction plan records people, projects, organizations, concepts, precise per-memory associations, and directed relationships in `graph.jsonl` under `memory.path`.

There is no separate config switch. The graph is built only for a valid configured `bujo` tier: `memory.mode: "bujo"` plus embeddings and `memory.llm`. The `lite` and `journal` tiers do not build it. Capture is serialized per store and runs after durable local admission, so graph extraction never blocks on the provider-success path; if the memory LLM fails or times out, the pending intake retries without publishing partial graph state.

Only an explicit `MemoryRecall` call uses the graph, and expansion is deterministic and limited to one hop: direct BM25/vector seeds contribute their associated entities, and one directly related entity may pull in neighboring memories. Automatic prompt injection stays direct-only and never synthesizes a graph answer in the background. Lite and Journal never expand the graph. The living `index.md`, regenerated by the in-app consolidation scheduler, includes a bounded top-entity preview so the graph is inspectable as plain markdown. That projection scans deterministic source pages through inventory exhaustion or a 10,000-row safety ceiling, retaining only bounded reconciliation state before rendering at most 50 lexical groups. It filters ephemeral calendar/time nodes and collapses lexically equivalent display names without changing canonical graph state; it is not canonical entity resolution.

### The `MemoryJournal` chronological tool

`MemoryJournal` answers broad retrospectives over explicit calendar dates from
the curated local index. It complements `MemoryRecall`; it is not another
search index, does not copy or auto-inject journals, and is not exact execution
evidence. Use `RunHistory`/`SessionHistory` to substantiate exact tool inputs,
results, failures, or interrupted execution.

The first call requires all three range fields:

```json
{
  "fromDate": "2026-09-01",
  "throughDate": "2026-09-07",
  "timeZone": "Europe/Amsterdam",
  "limit": 10
}
```

Dates are inclusive local civil dates in the explicit IANA zone. The resolver
echoes the resulting half-open UTC instant interval, rejects nonexistent dates
or zones and ranges over 31 days, and never guesses the host zone or defaults
to UTC. `limit` defaults to 10 and caps at 25. Continue a frozen per-run
snapshot only with `{ "cursor": "..." }`; the request-private authenticated cursor
accepts only its exact issued offset, and range or limit overrides are not accepted
on continuation.

Each request can hold four ephemeral snapshots. A snapshot caps at 1,000
entries and 2 MiB; each page caps at 25 entries/8 KiB and each text at 2 KiB.
Coverage says whether the range scan completed and why it stopped. A complete
empty range is successful with `noData: true`; backend failure is the generic
`journal_unavailable` error; unsupported backends do not advertise the tool.

Lite, Journal, and BuJo are supported, including read-only local stores. Custom
stores must affirm chronological support before the tool is advertised. Results
include canonical daily source references and stored validity/supersession state
at snapshot time. Dropped records, raw BuJo
audit observations, session ids, memory-root paths, embeddings, salience,
access telemetry, and raw backend errors are excluded. Unsafe text and ids are
replaced with fixed markers, and all returned content is untrusted historical
evidence.

### The `Remember` write tool

`Remember` stores one explicitly stated fact directly, without waiting for the
capture pass. It writes the curated `daily/` source on every tier and indexes in
the same critical section, so the fact is recallable immediately.

It requires a writable bujo-backend store and `memory.rememberTool.enabled`
(default on), and — unlike recall — it is gated by `tools.allowedTools`. Writes
are idempotent: the bullet id derives from the content hash, and a canonical
bullet whose index row is missing is completed rather than duplicated. Text
carrying a credential is rejected and nothing is written. See
[MCP servers](/tools/mcp/#remember-durable-memory-writes).

### Tool policy for explicit memory reads

`memory.recallTool.enabled` is the shared opt-out for both explicit read tools.
It defaults on for configured memory. `MemoryRecall` is gated by that
declaration rather than `tools.allowedTools`, so a restrictive or empty
allowlist still leaves targeted search available. `MemoryJournal` enumerates a
date range and has the additional normal app-tool policy gate: under a
restrictive allowlist, include `MemoryJournal`; exact/server/global deny wins.

:::caution
Setting `config.memory.recallTool.enabled: false` removes both explicit memory
read tools. It does not disable automatic score- and answer-evidence-gated
context recall from an otherwise configured backend, and it does not disable
operator-only `mono-agent memory` inspection.
:::

See [Tool policy](/tools/policy/) and [MCP tools](/tools/mcp/) for how MCP-provided tools differ from the built-in allowlist.

## Environment variables

| Env var | Config key | Notes |
|---------|-----------|-------|
| — | `memory.writeMode` | `disabled` / `append-host-summary` / `capture`; `capture` requires `mode: bujo` |
| — | `memory.recallTool.enabled` | Explicit memory-read family: targeted `MemoryRecall` plus policy-allowed `MemoryJournal` on local tiers; default on |
| — | `memory.mode` | `lite` / `journal` / `bujo` |
| — | `memory.llm.model` | Chat model for the capture pipeline |
| — | `memory.llm.endpoint` | Ollama chat endpoint (default `http://localhost:11434`) |
| — | `memory.llm.timeoutMs` | Per-call in-app chat-LLM timeout, **default `60000`**. See [Validation & CLI](/memory/validation-and-cli/#the-memory-llm-timeout). |
| — | `memory.embeddings.provider` | `ollama` / `lmstudio` / `openai`; defaults to `ollama` once the required Journal/BuJo embeddings block is present; no cross-provider fallback |
| — | `memory.embeddings.model` | Defaults by provider (`nomic-embed-text:v1.5` for Ollama; `text-embedding-nomic-embed-text-v1.5` for LM Studio) |
| — | `memory.embeddings.dim` | Defaults to `768`; set it when the model output dimension differs |

See [Environment variables](/config/env-vars/) for the full table and precedence rules.

Journal and BuJo require an explicit, non-empty `memory.embeddings` **block**, but they do not require every field in that block. Provider, model, and dimension use the defaults above; even a block that only overrides `dim` is valid.

## Related pages

- [Memory overview](/memory/) — tier matrix and the single `memory` config block
- [Embeddings](/memory/embeddings/) — the provider/model behind vector recall
- [Consolidation](/memory/rituals/) — scheduled projection refresh and duplicate-group counting, without canonical-memory mutation
- [Validation & CLI](/memory/validation-and-cli/) — `mono-agent validate` checks and `mono-agent memory` maintenance
