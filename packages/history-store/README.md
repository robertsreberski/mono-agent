# @mono-agent/history-store

## Category

Category: `context`

## Responsibility

Durable, per-conversation chat history over SQLite. Implements the structural
`ConversationHistoryStore` contract (`load`/`append` keyed by `conversationId`) so it
can be injected in place of the agent harness's in-memory default, giving channels
history that survives restarts and is writable from a separate process (e.g. the
adapter send-tool subprocess recording a proactive send). Rows are keyed by the
channel-prefixed conversationId, so it is a shared *substrate*, not a cross-channel
merge — a harness only ever loads its own conversationIds.

## Install / Usage

```bash
pnpm --filter @mono-agent/history-store run build
```

```ts
import { createSqliteHistoryStore, bucketConversationId } from "@mono-agent/history-store";

const history = createSqliteHistoryStore({ path: "/data/history.db", maxMessages: 24 });
await history.append("telegram:42", [{ role: "assistant", content: "Morning brief", source: "proactive" }]);
const recent = await history.load("telegram:42"); // last 24, chronological
```

`bucketConversationId(id, rollover, timezone, now)` mirrors the harness responder's
daily-rollover bucketing so a recorded send lands in the same thread the next live
turn reads.

## Public API

- `SqliteConversationHistoryStore` / `createSqliteHistoryStore`
- `bucketConversationId`
- `SqliteHistoryStoreOptions`, `ConversationSummary` types
- Instance methods: `load`, `append`, `listConversations`, `showConversation`, `close`

## Dependency Boundary

Depends only on `@mono-agent/context` (for the `HistoryMessage` type) and
`better-sqlite3`. It must not depend on the harness, runtime, communication adapters,
memory, observability, or host code. Hosts inject it as a `ConversationHistoryStore`.

## What This Package Does Not Own

It does not build prompts, decide what to record, run models, derive conversationIds,
deliver messages to channels, or own memory/recall. It is a passive transcript store.

## Verification

```bash
pnpm --filter @mono-agent/history-store run build
pnpm --filter @mono-agent/history-store run typecheck
pnpm --filter @mono-agent/history-store run test
```
