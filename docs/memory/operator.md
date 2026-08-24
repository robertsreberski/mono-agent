---
title: "Memory operator"
description: "Inspect built-in memory safely and opt into revision-checked, durable BuJo edit, forget, and restore actions."
sidebar:
  order: 4
---

The agent-owned memory operator exposes a bounded, sanitized view of the live
configured memory store through the default-on operator endpoint. Read access
does not make an embedding or chat-model request and does not require memory
actions to be enabled.

This is an operator surface, not a model tool. `MemoryRecall` remains the
read-only, model-facing retrieval path; the operator API is for an owner client
that needs inventory, lifecycle history, graph inspection, or an explicitly
authorized correction.

## Enable owner actions

Reads are available automatically for a live built-in Lite, Journal, or BuJo
store. Mutations default off and require both gates below:

```json
{
  "memory": {
    "operatorActions": { "enabled": true }
  },
  "tui": {
    "apiKey": "keep-this-in-env-instead"
  }
}
```

Keep the bearer out of JSON in a real agent:

```bash
MONO_AGENT_MEMORY_OPERATOR_ACTIONS_ENABLED=true
MONO_AGENT_TUI_API_KEY=<owner-bearer>
```

`memory.operatorActions.enabled` defaults to `false`. It controls only
`edit`, `forget`, and `restore`; turning it off does not hide the provider-free
read projection. A mutation is advertised only when the actual opened tier is
BuJo and the operator endpoint has a configured API key. Merely declaring
`memory.mode: "bujo"` is not enough if the live store resolved to Lite or
Journal.

Supermemory is explicitly unsupported by this v1 operator. Its capability says
`status: "unsupported"`, `read: false`, `actions: false`, and
`graph: "unavailable"`; mono-agent does not attempt to reinterpret a remote
service's private index as canonical built-in records.

## Capability and read routes

`GET {basePath}/v1/info` adds `capabilities.memory` without changing the
operator wire schema. The capability names the backend, actual built-in tier,
`ready | degraded | unsupported` status, separate `read` and `actions` flags,
and graph fidelity (`captured | derived | unavailable`). A sanitized `reason`
may explain a disabled or degraded state.

The bounded read routes are:

| Route | Projection |
| --- | --- |
| `GET {basePath}/v1/memory` | Counts by lifecycle/type, aggregate access counts, capability, and optional embedding model/dimension metadata. |
| `GET {basePath}/v1/memory/records` | Cursor-paged records, with optional `q`, `lifecycle`, `type`, and `collection` filters. |
| `GET {basePath}/v1/memory/records/:recordId` | One record plus its terminal edit/forget/restore history. |
| `GET {basePath}/v1/memory/graph` | Bounded entity/memory nodes and captured relation, association, support, and supersession edges. `focusId`, `includeHistory`, and `limit` are optional. |
| `GET {basePath}/v1/memory/operations/:operationId` | One known mutation receipt for polling; there is no operation-list or internal-queue endpoint. |

Record lifecycle is `active`, `superseded`, or `forgotten`; record type is
`task`, `event`, or `note`. List pages default to 50 and cap at 100. Graph
responses default to 100 nodes and cap at 200. Lite and Journal return their
canonical record inventory but report graph fidelity as unavailable. The
captured entity graph exists only for the actual BuJo tier.

When `tui.apiKey` is configured, every read requires that bearer. When it is
unset, reads retain the loopback operator endpoint's compatibility posture and
are keyless. Mutations are never keyless. The web console proxy adds exact
same-origin enforcement; the underlying TUI route authenticates with its bind
and bearer policy, not an `Origin` header.

## Sanitized, provider-free projection

Overview, record, action-history, and graph reads are snapshots of local
canonical/SQLite state. They do not call Ollama, LM Studio, OpenAI, a memory chat
model, or Supermemory. Record text and bounded graph labels are intentionally
visible to the owner, but the projection never returns:

- filesystem paths, filenames, or source line numbers;
- raw embedding vectors;
- capture intake/outbox payloads, internal queues, or the durable operation
  ledger;
- provider credentials, raw provider/native errors, or arbitrary database
  fields.

Logical conversation provenance may appear as `source.conversationId`; it is
not a host path. A degraded recovery or maintenance state publishes a fixed
reason and closes canonical record/graph reads plus new actions instead of
exposing an underlying exception.

## Semantic edit, forget, and restore

Every action body carries the record's current 64-character `expectedRevision`
and a caller-generated `idempotencyKey`. The revision is an optimistic
concurrency precondition: a stale record or lifecycle produces a conflict and
nothing is applied. Reusing an idempotency key for the exact same request
returns the existing operation; reusing it for different content is rejected.

`PATCH {basePath}/v1/memory/records/:recordId` accepts a non-empty semantic
patch over `text`, `type`, `tags`, `salience`, `collection`, `dueAt`, and
`validFrom`. An edit never rewrites a canonical record in place. It creates a
new active record with a new id, marks the original superseded, retains its
supported entity evidence, and records the replacement relation.

`POST {basePath}/v1/memory/records/:recordId/forget` is the only action that
requires a confirmation round trip. The first exact request returns `428` with
a short-lived, one-use token bound to that request. Resubmit the same revision,
idempotency key, and action with the token to queue the forget. Forgetting keeps
the canonical record as a tombstone with lifecycle `forgotten`; it is not a
physical row/file deletion.

`POST {basePath}/v1/memory/records/:recordId/restore` accepts only an
operator-forgotten tombstone. Restore creates a new active record id from the
prior semantic value and leaves the forgotten record intact as lifecycle
history. Edit and restore therefore return a `resultRecordId`; forget does not.

## Durable queue and polling

Accepted mutations return `202` with one operation whose status advances
through `queued`, `draining`, and `applying` to `succeeded` or `failed`. Poll the
exact operation route until it is terminal, then refresh the record/detail
projection. A failed receipt contains only a stable error code and sanitized
message.

The owner-private operation ledger makes an accepted action restart-safe. An
action that was queued behind lifecycle work remains queued for the next store
start. An action that reached its durable semantic intent but crashed before
its terminal receipt is proven/replayed from that exact outcome rather than
blindly duplicated. The public API exposes the requested operation receipt, not
ledger contents or a queue inventory.

Exact known-receipt polling is intentionally separate from canonical store-read
and new-action admission, so an owner can continue observing an already accepted
operation while the app lifecycle is paused or degraded. It still reveals no
other operation id or queue state.

Pending operations are never pruned. Full terminal receipts are retained for up
to 7 days and the newest 512 entries; compact idempotency commitments remain for
up to 30 days. Operations and commitments share an aggregate 1,024-entry and
4 MiB ledger bound. If the full receipt was compacted but its commitment remains,
polling the old operation or replaying the exact request reports
`replay_expired`; reusing the key for a changed request still reports
`idempotency_conflict`. Once the 30-day commitment expires, the key is reusable
subject to the target's current revision and lifecycle. Non-prunable saturation
temporarily disables new actions while leaving authoritative reads available.
A publication whose durability cannot be proven degrades the operator instead
of exposing a possibly phantom receipt.

## App-wide lifecycle serialization

A memory action uses the same app-operation tail as configuration reload and
shutdown. Before the mutation enters the store, the host synchronously closes
new responder admission, stops memory rituals, and drains already-admitted
turns. It then applies and flushes the canonical mutation, restarts configured
rituals, and only then admits new turns. Live-input offers made after the pause
are rejected as inactive.

Reload follows the same order: pause and drain responders before channels,
operator state, and the shared memory store are replaced. Stop closes admission
synchronously, then waits its turn behind any already-entered mutation or
reload. Queued operator work that has not entered the mutation gate stays
durable for restart instead of deadlocking teardown.

A rejected request such as a revision conflict can safely restart rituals and
resume admission. An unknown durability/replay failure, a failed post-mutation
ritual restart, or a failed reload degrades running channels and keeps responder
and memory-operator admission closed. A successful full agent reload is the
recovery boundary; the host never reports the affected memory seam healthy by
falling back to an uncoordinated read or turn.

## Related

- [Memory overview](/memory/) — built-in tiers and persistence model.
- [Capture and recall](/memory/capture-and-recall/) — host writes and the
  model-facing `MemoryRecall` tool.
- [Operator stream endpoint](/channels/tui/) — bearer and route boundary.
- [Setup security](/reference/setup-security/) — exposure and lifecycle trust
  model.
