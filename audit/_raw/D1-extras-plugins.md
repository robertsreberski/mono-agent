# D1-extras-plugins — extras plugin tier

## 1 Verdict & maturity grade

**Grade: B+**

All four packages genuinely prove the "open to external plugins" premise clause: every package's `package.json` depends on `@mono-agent/agent-contracts` plus only its own domain SDK (`@a2a-js/sdk`+`express`, `@whiskeysockets/baileys`, nothing but fetch, `@modelcontextprotocol/sdk`+`zod`) — zero dependency on the harness, config package, operator surfaces, or each other, and every README states and the source confirms this boundary. The A2A durable-dispatch idempotency work (issue #248, PR #249, merged as `cb1a57c6` and an ancestor of current `HEAD`) is a genuinely sophisticated, well-tested (30 tests, 950 lines) fail-closed implementation — durable admission before responder invocation, typed conflict/in-doubt/capacity-exhausted errors, restart recovery, atomic slot allocation, directory-identity/symlink hardening. `agent-orchestrator` is real, not vestigial: a working, tested (real over-the-wire MCP client/server round trip), request-scoped `AskCollaborator` tool with per-call limits, timeouts, and visible tool errors — it is simply unconsumed by any demo/e2e in this repo (by design: it's a code-only capability with no config key). `memory-supermemory` is an honest, clean alt-memory reference: `load` degrades to `undefined` on any failure, `persistCompletedTurn` is strongly awaited and propagates failure, legacy writes never throw and say so.

The grade is not A because of one real defect in `agent-orchestrator` (event-listener race that deviates from the MCP SDK's documented-safe cleanup ordering, F1) and one real behavioral gap in `whatsapp-adapter` (fully cross-chat-serialized message processing with no documented caveat, F2) that undercuts its role as "the documented plugin example" for a multi-conversation channel. Both are genuine, evidenced findings, not nitpicks; neither is a P0.

## 2 Findings

**F1 — P2 (correctness, resource-cleanup race).** `extras/agent-orchestrator/src/index.ts:113-119`:
```ts
await server.connect(transport as unknown as Transport);
await transport.handleRequest(req, res, req.body);
res.on("close", () => {
  void transport.close().catch(() => undefined);
  void server.close().catch(() => undefined);
});
```
The per-request `res.on("close", ...)` cleanup listener is attached **after** `await transport.handleRequest(...)` resolves. The MCP TypeScript SDK's own documented stateless-HTTP pattern attaches this listener **before** calling `server.connect`/`handleRequest`, precisely because in stateless mode (`sessionIdGenerator: undefined`) `handleRequest` itself ends the response, and Node can emit `'close'` before a listener attached afterward gets a chance to register. If `'close'` has already fired by the time this line runs, `transport.close()`/`server.close()` never execute for that request — a per-tool-call cleanup skip, up to `maxCalls` (default 6) times per orchestrator turn. Every orchestrator turn creates a **new** `McpServer`+`StreamableHTTPServerTransport` pair per POST (not per extension lifetime), so this is not a one-time leak but potentially one skipped cleanup per collaborator call. Impact is likely bounded (stateless mode holds no long-lived socket/session state beyond the request), but it is a real, reproducible deviation from the safe-ordering pattern, and the existing tests (`orchestrator.test.ts`) do not assert cleanup actually ran.

**F2 — P2 (correctness/premise fit, undocumented behavior).** `extras/whatsapp-adapter/src/event-runner.ts:57-66` and `164-184`:
```ts
private readonly handleMessagesUpsert = (payload: unknown): void => {
  this.processing = this.processing.then(async () => {
    await this.processMessagesUpsert(payload);
  });
```
```ts
for (const message of payload.messages ?? []) {
  try {
    const result = await this.adapter.handleMessage(message);
```
All inbound WhatsApp messages for the whole adapter instance — across **every** chat, not just one — are serialized onto a single promise chain, and each is `await`ed to full completion (including the entire agent turn / LLM call) before the next is even looked at. This is confirmed intentional by the test title "processes notify messages sequentially" (`event-runner.test.ts:80`), but the consequence is: while the bot is answering person A in a long-running turn (minutes for some models), a message from person B in a **different, already-authorized** chat receives no "busy"/"thinking" acknowledgment and is not processed at all until A's turn fully finishes — `WhatsAppAdapter`'s per-chat `activeRuns` busy-tracking (which implies per-chat concurrency was a design goal) never even gets a chance to run for B. Neither the package README nor the doc site discloses this limitation. For a channel documented as "the" WhatsApp example and pitched for personal multi-contact use, this is a genuine premise-fit gap ("channels easily," "agents in seconds-to-minutes" — for the *other* chat, it can be minutes-to-never during a concurrent turn).

**F3 — P3 (dead code).** `extras/a2a-adapter/src/idempotency.ts:1129-1131`:
```ts
function cloneRecord<T extends IdempotencyRecord>(value: T): T {
  return structuredClone(value);
}
```
Defined but never called anywhere in the package (confirmed by repo-wide grep — only the `dist/` build artifact mirrors it). Trivial, but it is unreachable production code inside otherwise extremely carefully-reviewed correctness-critical code, which stands out.

**F4 — P3 (unbounded in-process growth, long-uptime risk).** `extras/memory-supermemory/src/store.ts:56-60`:
```ts
private readonly completedTurns = new Map<string, string>();
private readonly completedTurnInflight = new Map<string, {
  readonly payloadDigest: string;
  readonly promise: Promise<MemoryCompletedTurnResult>;
}>();
```
`completedTurns` accumulates one entry per distinct `runId` for the lifetime of the process with no eviction/cap (unlike the A2A idempotency store's explicit `maxRecords`/`retentionMs`). For a long-running personal-agent instance (per `MEMORY.md`, uptimes of weeks are the norm), this grows without bound. Impact is low per-entry (two ~64-byte hex strings), so this is unlikely to matter in practice at realistic turn volumes, but it is the one place in this territory that doesn't mirror the A2A package's bounded-admission discipline.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
|---|---|---|---|
| `extras/a2a-adapter/src/idempotency.ts:1129` `cloneRecord` | Defined, never called (only `structuredClone` used directly elsewhere for cloning); not exported from `index.ts` | Delete | `grep -rn cloneRecord extras/a2a-adapter/` shows only the definition and its `dist/` mirror |

No other dead code found in scope; all other exported surface (per `index.ts` barrels) has a real production caller or is a documented, intentional programmatic-only API (e.g. `agent-orchestrator`'s entire surface, which is code-only by design per its README/doc site).

## 4 Deprecation & legacy

No `@deprecated` JSDoc tags or explicit "legacy"/"deprecated" code markers exist anywhere in the four packages' `src/` trees (verified by grep). The only "legacy" language present is user-facing upgrade guidance in each README's "Upgrading from 0.4.0 (npm skew)" section (e.g. `extras/a2a-adapter/README.md:9`, `extras/whatsapp-adapter/README.md:9`, `extras/agent-orchestrator/README.md:9`), describing what happens if a host still has the pre-`channels.plugins[]` npm tag installed. This is load-bearing, forward-looking operator documentation, not legacy code — classify as **keep**.

One in-code compatibility alias is genuinely legacy-shaped but still load-bearing: `extras/a2a-adapter/src/config.ts:99-102` keeps `MONO_AGENT_A2A_PROVIDER_ENABLED` / `a2a.provider.enabled` working alongside the canonical `a2a.enabled` / `MONO_AGENT_A2A_ENABLED`, with the canonical form always winning when both are set. This is intentionally retained (comment: "the legacy `a2a.provider.enabled` form keeps working") and has a dedicated regression test (`a2a-adapter.test.ts:564`). **Load-bearing — keep**, not removable without a breaking-config migration.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| D1-1 | Move `agent-orchestrator`'s per-request `res.on("close", ...)` registration to before `server.connect`/`transport.handleRequest`, matching the MCP SDK's documented stateless-mode pattern | Correctness: avoids a plausible skipped-cleanup race on every collaborator tool call (F1) | Reorder the 3 lines in `index.ts`'s POST handler; add a regression test that asserts `transport.close`/`server.close` are called even under a fast synchronous fake responder | S | New test fails on current code, passes after reorder; existing 2 tests still green | n |
| D1-2 | Document (README + doc site) that `whatsapp-adapter` serializes message handling across all chats for one adapter instance, or add per-chat concurrent processing | Premise: "channels easily" / responsiveness for concurrent multi-chat use (F2) | Either (a) add a one-paragraph caveat to `extras/whatsapp-adapter/README.md` and `docs/`, or (b) change `event-runner.ts` to key its processing chain per-`chatJid` instead of globally, matching `WhatsAppAdapter`'s existing per-chat `activeRuns` model | S (docs) / M (per-chat concurrency) | Docs: caveat present and matches observed behavior in `event-runner.test.ts`. Code fix: new test proves message to chat B is handled/acked while chat A's turn is still in flight | n |
| D1-3 | Delete unused `cloneRecord` in `extras/a2a-adapter/src/idempotency.ts` | Dead code in an otherwise meticulously-reviewed correctness-critical file (F3) | Remove the function | S | `grep -rn cloneRecord extras/a2a-adapter/src` returns nothing; build/tests still green | n |
| D1-4 | Bound `SupermemoryMemoryStore`'s `completedTurns`/`completedTurnInflight` maps (LRU cap or TTL sweep), mirroring the A2A idempotency store's `maxRecords`/`retentionMs` discipline | Long-uptime correctness/health for personal-agent-style deployments (F4) | Add a small LRU eviction (e.g. cap at N entries, evict oldest) to `store.ts` | S | New test: inserting more than the cap evicts the oldest entry without breaking exact-retry/duplicate detection for recent entries | n |

## 6 Skill-worthy flags

- **pi-upstream-recon-adjacent gotcha (new, general SDK-recon note):** when wiring any stateless HTTP transport from `@modelcontextprotocol/sdk`, the safe cleanup-listener ordering is "register `res.on('close', ...)` before calling `handleRequest`," not after — the SDK's own examples show this ordering and it is easy to get backwards (as `agent-orchestrator` did, F1). Worth a one-line addition to whichever skill covers building MCP servers/tools in this repo, so future request-scoped ephemeral MCP servers don't repeat it.
- No other recurring/process-shaped issues found in this territory worth a new skill or amendment; the four packages are otherwise unusually careful (fail-closed validation, no fake-success paths, no secrets, comprehensive tests).

## 7 Coverage note

Source files read in full:
- `extras/a2a-adapter/src/index.ts`
- `extras/a2a-adapter/src/card.ts`
- `extras/a2a-adapter/src/config.ts`
- `extras/a2a-adapter/src/errors.ts`
- `extras/a2a-adapter/src/idempotency.ts`
- `extras/a2a-adapter/src/provider.ts`
- `extras/a2a-adapter/src/consumer.ts`
- `extras/a2a-adapter/src/channel-driver.ts`
- `extras/a2a-adapter/README.md`
- `extras/whatsapp-adapter/src/index.ts`
- `extras/whatsapp-adapter/src/types.ts`
- `extras/whatsapp-adapter/src/adapter.ts`
- `extras/whatsapp-adapter/src/message-normalizer.ts`
- `extras/whatsapp-adapter/src/message-stream.ts`
- `extras/whatsapp-adapter/src/baileys-socket.ts`
- `extras/whatsapp-adapter/src/event-runner.ts`
- `extras/whatsapp-adapter/src/start.ts`
- `extras/whatsapp-adapter/src/config.ts`
- `extras/whatsapp-adapter/src/channel-driver.ts`
- `extras/whatsapp-adapter/README.md`
- `extras/memory-supermemory/src/index.ts`
- `extras/memory-supermemory/src/client.ts`
- `extras/memory-supermemory/src/store.ts`
- `extras/memory-supermemory/src/format.ts`
- `extras/memory-supermemory/README.md`
- `extras/agent-orchestrator/src/index.ts`
- `extras/agent-orchestrator/README.md`

Test files skimmed (describe/it names enumerated, not line-by-line audited) to judge coverage adequacy:
- `extras/a2a-adapter/src/__tests__/a2a-adapter.test.ts` (1160 lines, 24 tests)
- `extras/a2a-adapter/src/__tests__/dispatch.test.ts` (467 lines, 8 tests)
- `extras/a2a-adapter/src/__tests__/idempotency.test.ts` (950 lines, ~25 tests)
- `extras/whatsapp-adapter/src/__tests__/adapter.test.ts`
- `extras/whatsapp-adapter/src/__tests__/channel-driver.test.ts`
- `extras/whatsapp-adapter/src/__tests__/config.test.ts`
- `extras/whatsapp-adapter/src/__tests__/event-runner.test.ts`
- `extras/whatsapp-adapter/src/__tests__/message-normalizer.test.ts`
- `extras/whatsapp-adapter/src/__tests__/message-stream.test.ts`
- `extras/whatsapp-adapter/src/__tests__/start.test.ts`
- `extras/memory-supermemory/src/__tests__/client.test.ts`
- `extras/memory-supermemory/src/__tests__/store.test.ts`
- `extras/memory-supermemory/src/__tests__/index.test.ts`
- `extras/memory-supermemory/src/__tests__/e2e.test.ts`
- `extras/agent-orchestrator/src/__tests__/orchestrator.test.ts` (full read, 140 lines, 2 tests — both real over-the-wire MCP client/server round trips)

Additional evidence gathered (not "source" but load-bearing to findings):
- `package.json` for all four `extras/*` packages (dependency-boundary verification)
- GitHub issue #248 (title + both checkpoint comments) and confirmation via `git merge-base --is-ancestor` that the merged idempotency commit (`cb1a57c6`) is an ancestor of current `HEAD` (5f27a0ec) — the mono-agent-repo-side implementation for #248 is done and released (v0.9.1); the issue remains open only for an external, out-of-repo A8C fleet cutover
- `PACKAGES.md` catalog entries for all four packages (architecture-gate registration check)
- Repo-wide grep for `@deprecated`/legacy markers and for `agent-orchestrator` consumers outside its own package (none found — confirms it is a documented code-only capability, not silently unused)
