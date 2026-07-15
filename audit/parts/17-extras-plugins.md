# 17 · Extras plugin tier

**Scope:** the four `extras/*` packages — `a2a-adapter`, `whatsapp-adapter`, `memory-supermemory`, `agent-orchestrator` — as external-plugin exemplars for the "open to external plugins" premise clause. **Maturity grade: B+ (verifier-adjusted, unchanged from raw audit).** All four packages genuinely honor the plugin-boundary premise (each depends only on `@mono-agent/agent-contracts` plus its own domain SDK, zero cross-coupling to the harness/config/each other) and are unusually careful (fail-closed validation, no fake-success paths, no secrets, comprehensive tests, a genuinely sophisticated durable-dispatch idempotency implementation in `a2a-adapter`). The verifier reproduced every finding's evidence but deflated both correctness findings (F1, F2) from P2 to P3 on reasoned grounds — the deviations are real but the practical blast radius is small for this tier — and narrowed F4 to the one map that is actually unbounded. Nothing in this territory blocks the freeze.

## Findings

**F1 — [P3 after verification] [verifier: AMENDED, P2→P3]** — `extras/agent-orchestrator/src/index.ts:113-119`. The per-request `res.on("close", ...)` cleanup listener is attached **after** `await transport.handleRequest(...)` resolves, deviating from the MCP SDK's documented stateless-HTTP pattern (register the listener *before* `handleRequest`, since in stateless mode `handleRequest` itself ends the response and Node can emit `'close'` before a listener attached afterward gets to register). Every orchestrator turn creates a **new** `McpServer`+`StreamableHTTPServerTransport` pair per POST, so a missed registration means a skipped `transport.close()`/`server.close()` for that call, up to `maxCalls` (default 6) times per turn. The verifier confirmed the deviation but downgraded severity: the error path (lines 131-132) already closes correctly; `res`'s `'close'` event is I/O-driven and fires on a later loop tick, so the microtask continuation after the `handleRequest` await almost always attaches the listener in time; stateless mode holds no long-lived socket/session state beyond the request; and this is a code-only, no-demo-consumer extras package. Evidence:
```ts
await transport.handleRequest(req, res, req.body);
res.on("close", () => {
  void transport.close().catch(() => undefined);
```

**F2 — [P3 after verification] [verifier: AMENDED, P2→P3]** — `extras/whatsapp-adapter/src/event-runner.ts:57-66, 164-184`. All inbound WhatsApp messages for the whole adapter instance — across every chat, not just one — are serialized onto a single promise chain, each `await`ed to full completion (including the entire agent turn) before the next is even looked at. Confirmed intentional (test title "processes notify messages sequentially"), and confirmed by the verifier that `WhatsAppAdapter.activeRuns` per-chat busy-tracking is effectively unreachable via the bundled runner (though not strictly dead code, since `handleMessage` is a public API another caller could drive concurrently). No README/doc-site caveat exists. Verifier deflated severity to P3: this is an extras, personal/single-user-oriented example, and the harm (a blocked concurrent chat) only bites multi-contact use, which isn't the primary scenario — genuine premise-fit note, not a defect. Evidence:
```ts
this.processing = this.processing.then(async () => {
  await this.processMessagesUpsert(payload);
});
```

**F3 — [P3] [verifier: CONFIRMED]** — `extras/a2a-adapter/src/idempotency.ts:1129-1131`. `cloneRecord` is defined but never called anywhere in the package (repo-wide grep, excluding `dist/`, confirms zero call sites and no export from `index.ts`). Trivial, but unreachable code inside otherwise meticulously-reviewed correctness-critical code. Evidence:
```ts
function cloneRecord<T extends IdempotencyRecord>(value: T): T {
  return structuredClone(value);
}
```

**F4 — [P3] [verifier: AMENDED — scope narrowed]** — `extras/memory-supermemory/src/store.ts:56`. `completedTurns` accumulates one entry per distinct `runId` for the process lifetime with no eviction/cap, unlike the A2A idempotency store's explicit `maxRecords`/`retentionMs`. The verifier confirmed this but corrected the finding: the sibling map `completedTurnInflight` (line 57), which the raw audit implicated together with `completedTurns`, **is** bounded — its `finally` block (`store.ts:155-157`) deletes each entry once the turn settles, so it's capped by concurrent in-flight turns, not lifetime. Only `completedTurns` is genuinely unbounded. Per-entry cost is two ~64-byte hex strings; realistic weeks-long uptime yields at most a few MB, and only when the (opt-in, non-default) supermemory backend is selected. Evidence:
```ts
private readonly completedTurns = new Map<string, string>();
private readonly completedTurnInflight = new Map<string, {
  readonly payloadDigest: string;
  readonly promise: Promise<MemoryCompletedTurnResult>;
}>();
```

## Dead code & deprecation

**Proven dead:**
- `extras/a2a-adapter/src/idempotency.ts:1129` `cloneRecord` — defined, never called, not exported. Proof (verifier-reproduced): `grep -rn "cloneRecord\b" --include=*.ts --include=*.md --include=*.mjs . | grep -v node_modules | grep -v /dist/ | grep -iv continuation-store` returns only the definition (plus the audit doc itself); the similarly-named `cloneRecords` in `packages/agent-app/src/continuation-store.ts` is an unrelated function in a different package; zero hits against `~/personal-agent` and `~/a8c-agents`. Disposition: delete.

**Refuted-as-dead (do not delete):** none — `agent-orchestrator`'s entire surface was checked and confirmed to be an intentional code-only capability (documented in its README/doc site), not dead code, despite having no in-repo demo consumer.

**Deprecation classifications (both confirmed by verifier):**
- README "Upgrading from 0.4.0 (npm skew)" sections in all three channel/adapter READMEs — forward-looking operator guidance, not legacy code. **Keep.**
- `MONO_AGENT_A2A_PROVIDER_ENABLED` / `a2a.provider.enabled` alias (`extras/a2a-adapter/src/config.ts:99-102`) — canonical `a2a.enabled`/`MONO_AGENT_A2A_ENABLED` always wins when both are set; has a dedicated regression test. **Load-bearing — keep**, not removable without a breaking config migration.

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
|---|---|---|---|---|---|---|
| D1-1 | Move `agent-orchestrator`'s per-request `res.on("close", ...)` registration to before `server.connect`/`transport.handleRequest` | Correctness: matches MCP SDK's documented stateless-mode pattern, avoids a plausible (if now P3) skipped-cleanup race per collaborator call (F1) | Reorder the 3 lines in `index.ts`'s POST handler; add a regression test asserting `transport.close`/`server.close` are called even under a fast synchronous fake responder | S | New test fails on current code, passes after reorder; existing 2 tests still green | n |
| D1-2 | Document that `whatsapp-adapter` serializes message handling across all chats for one adapter instance, or add per-chat concurrent processing | Premise-fit: "channels easily" / responsiveness for concurrent multi-chat use (F2) | Either (a) add a one-paragraph caveat to `extras/whatsapp-adapter/README.md` and `docs/`, or (b) key the processing chain per-`chatJid` instead of globally, matching `WhatsAppAdapter`'s existing per-chat `activeRuns` model | S (docs) / M (per-chat concurrency) | Docs: caveat present and matches observed behavior in `event-runner.test.ts`. Code fix: new test proves a message to chat B is handled while chat A's turn is still in flight | n |
| D1-3 | Delete unused `cloneRecord` in `extras/a2a-adapter/src/idempotency.ts` | Dead code in an otherwise meticulously-reviewed correctness-critical file (F3) | Remove the function | S | `grep -rn cloneRecord extras/a2a-adapter/src` returns nothing; build/tests still green | n |
| D1-4 | Bound `SupermemoryMemoryStore`'s `completedTurns` map (LRU cap or TTL sweep) — `completedTurnInflight` is already bounded and needs no change | Long-uptime correctness/health for personal-agent-style deployments (F4, scoped to `completedTurns` only per verifier) | Add a small LRU eviction (e.g. cap at N entries, evict oldest) to `store.ts`'s `completedTurns` map | S | New test: inserting more than the cap evicts the oldest entry without breaking exact-retry/duplicate detection for recent entries | n |

## Quarantine (refuted/unproven)

None. Every D1 finding, dead-code entry, and deprecation classification the verifier examined was CONFIRMED or AMENDED (severity/scope corrections applied above) — none were refuted outright, and no freeze-blocker was proposed for this territory to reject.
