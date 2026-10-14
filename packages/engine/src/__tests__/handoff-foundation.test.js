import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { findContextBuilderBypasses } from "./projection-source-check.js";
import { fileURLToPath } from "node:url";
import { MemorySessionRepo } from "../session-store.js";
import { createEvidenceView, evidenceDigest } from "../evidence-view.js";
import { projectContext, inspectCurrentLifecycle } from "../request-projection.js";
import { createHandoffBudget, buildHandoff, buildOpenWorkLedger, renderHandoffMessage, prepareHandoff, checkHandoffDispatch, validateHandoffSummary } from "../handoff.js";

const provenance = { provider: "fictional", api: "fictional-api", account: "fixture-account" };
const target = { ...provenance, model: "A" };
/** @type {import("../header-authority.js").HostJournalAuthority} */
const hostAuthority = { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const hostContext = { systemPrompt: "Current fictional rules", tools: [{ name: "Read", parameters: { type: "object" } }] };
const budget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext });
const options = { target, budget, hostContext, timestamp: 17, producer: "outgoing" };
const text = (value) => ({ role: "user", content: value, timestamp: 1 });
const summary = { intent: ["Fictional goal"], constraints: ["No deployment approval"], decisions: [], completedWork: [], failures: [], openWork: ["Inspect result"], nextActions: ["Wait"], references: [] };
/** @param {string} id @param {any[]} [messages] */
async function segment(id, messages = [text(id)], guarded = false) {
  const repo = new MemorySessionRepo(); const store = await repo.create({ id, cwd: "/fictional", ...(guarded ? { hostAuthority, assertOwned: async () => {} } : {}) });
  await store.beginTurn(`turn-${id}`);
  await store.openOperation(`op-${id}`, { model: { provider: provenance.provider, api: provenance.api, id }, nativeProvenance: provenance });
  for (let i = 0; i < messages.length; i++) await store.appendMessage(messages[i], `${id}-message-${i}`);
  await store.closeOperation(`op-${id}`, "completed");
  await store.endTurn(`turn-${id}`, "completed");
  const descriptor = { ownerKey: "fictional-owner", historyBucket: "fictional-bucket", journalId: store.metadata.journalId,
    handleId: id, sourceDigest: evidenceDigest(store.records), sourceSeq: store.seq, sourceTipId: store.tip, provenance };
  return { descriptor, header: { format: "mono-harness", version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id }, ...store.metadata }, records: store.records, store };
}
function view(segments, extra = {}) { return createEvidenceView({ ownerKey: "fictional-owner", historyBucket: "fictional-bucket", segments, ...extra }); }
/** An accepted prior handoff the current journal inherits, as the host reads it back. */
async function priorHandoff(content, withSummary = true) {
  const b = await segment("B", [text(content)]);
  const built = buildHandoff(view([b]), { ...options, summary });
  if (built.status !== "ready") throw new Error("Expected prior handoff");
  return withSummary ? built.artifact : { ...built.artifact, summary: null };
}
function refreshed(segment) { return { ...segment, records: segment.store.records, descriptor: { ...segment.descriptor,
  sourceDigest: evidenceDigest(segment.store.records), sourceSeq: segment.store.seq, sourceTipId: segment.store.tip } }; }

it("A -> B -> A returns through a neutral handoff with the inherited prior as producer evidence only, referencing opaque reasoning", async () => {
  const prior = await priorHandoff("B fact");
  const back = await segment("A-return", [text("A fact"), { role: "assistant", provider: "fictional", api: "fictional-api", model: "A", stopReason: "stop", timestamp: 1,
    content: [{ type: "thinking", thinking: "Fictional reasoning", thinkingSignature: "opaque-fixture-signature" }, { type: "text", text: "A reply" }] }]);
  const evidence = view([back], { prior });
  // Native envelopes are never projected across a model change, even with matching provenance.
  expect(() => projectContext(evidence, { ...options, switching: true })).toThrow("native journal entries");
  const prepared = prepareHandoff(evidence, options);
  expect(JSON.stringify(prepared.prior)).toContain("B fact"); expect(prepared.prior).not.toHaveProperty("prior");
  const result = buildHandoff(evidence, { ...options, summary }); expect(result.status).toBe("ready");
  expect(JSON.stringify(result.artifact)).toContain("A reply"); expect(JSON.stringify(result.artifact)).not.toContain("B fact"); // the new summary subsumes the prior
  expect(JSON.stringify(result.artifact)).not.toContain("opaque-fixture-signature"); expect(JSON.stringify(result.artifact)).toContain("opaque_native_reference");
  expect(result.messages).toEqual([expect.objectContaining({ role: "user", content: [expect.objectContaining({ text: expect.stringContaining("Historical handoff") })] })]);
});
it("rejects fabricated views, foreign owners, changed frozen tips/digests and anything but one current journal", async () => {
  const a = await segment("A"); const b = await segment("B");
  for (const change of [{ ownerKey: "foreign" }, { sourceTipId: "missing" }, { sourceDigest: "bad" }, { handleId: "other" }]) {
    expect(() => view([{ ...b, descriptor: { ...b.descriptor, ...change } }])).toThrow("Invalid");
  }
  expect(() => buildHandoff({ segments: [a], gaps: [] }, options)).toThrow("unvalidated");
  expect(() => view([a, b])).toThrow("Invalid"); expect(() => view([])).toThrow("Invalid");
});
it("persists opt-in composed coverage of the inherited prior handoff and never repeats it", async () => {
  const prior = await priorHandoff("Inherited B fact");
  const inheritedCoverage = { version: 1, sources: prior.coverage.map(({ journalId, sourceTipId, sourceSeq, sourceDigest }) => ({ journalId, sourceTipId, sourceSeq, sourceDigest })) };
  const c = await segment("C", [text("C")], true);
  await c.store.beginTurn("composed-turn");
  await c.store.openOperation("composed-op", { model: { provider: provenance.provider, api: provenance.api, id: "C" }, nativeProvenance: provenance }, "compaction");
  await c.store.appendCompaction({ summary: "Prior and C checkpoint", tokensBefore: 100, retainedTail: [], tokensAfter: 20 }, inheritedCoverage, { sourceTipId: c.store.tip, sourceSeq: c.store.seq });
  await c.store.closeOperation("composed-op", "completed"); await c.store.endTurn("composed-turn", "completed");
  expect(c.store.records.find((r) => r.kind === "compaction").schemaVersion).toBe(2);
  const result = buildHandoff(view([refreshed(c)], { prior }), options);
  expect(result.status).toBe("ready"); expect(JSON.stringify(result.artifact.checkpoint.suffix)).toContain("Prior and C checkpoint");
  expect(() => view([refreshed(c)])).toThrow("composed coverage");
  expect(() => view([refreshed(c)], { prior: { ...prior, coverage: [] } })).toThrow("composed coverage");
});
it("drops a covered free-checkpoint suffix after composed compaction and stays reusable", async () => {
  const paid = await priorHandoff("Fictional A history"), b = await segment("free-B", [text("Fictional covered B suffix")]);
  const prior = buildHandoff(view([b], { prior: paid }), options).artifact;
  expect(prior.summary).toBeNull(); expect(JSON.stringify(prior.checkpoint.suffix)).toContain("Fictional covered B suffix");
  const inheritedCoverage = { version: 1, sources: prior.coverage.map(({ journalId, sourceTipId, sourceSeq, sourceDigest }) => ({ journalId, sourceTipId, sourceSeq, sourceDigest })) };
  const c = await segment("composed-C", [text("Fictional C suffix")], true);
  await c.store.beginTurn("composed-C-turn");
  await c.store.openOperation("composed-C-op", { model: { provider: provenance.provider, api: provenance.api, id: "C" }, nativeProvenance: provenance }, "compaction");
  await c.store.appendCompaction({ summary: "Fictional exact composed checkpoint", tokensBefore: 100, retainedTail: [], tokensAfter: 20 }, inheritedCoverage, { sourceTipId: c.store.tip, sourceSeq: c.store.seq });
  await c.store.closeOperation("composed-C-op", "completed"); await c.store.endTurn("composed-C-turn", "completed");
  const result = buildHandoff(view([refreshed(c)], { prior }), options);
  expect(result.status).toBe("ready"); expect(result.artifact.checkpoint.summary).toEqual(prior.checkpoint.summary);
  expect(JSON.stringify(result.artifact.checkpoint.suffix)).not.toContain("Fictional covered B suffix");
  expect(JSON.stringify(result.artifact.checkpoint.suffix)).toContain("Fictional exact composed checkpoint");
  const d = await segment("reuse-D", [text("Fictional D suffix")]);
  const reused = buildHandoff(view([d], { prior: result.artifact }), options);
  expect(reused.status).toBe("ready"); expect(reused.artifact.checkpoint.summary).toEqual(prior.checkpoint.summary);
  const checkpointId = c.store.records.find((record) => record.kind === "compaction").id;
  expect(reused.artifact.checkpoint.suffix.filter((entry) => entry.id === checkpointId)).toHaveLength(1);
  expect(JSON.stringify(reused.artifact.checkpoint.suffix)).toContain("Fictional D suffix");
});
it("keeps whole latest turns, visible text verbatim and historical calls as neutral data", async () => {
  const a = await segment("turn0", [text("verbatim-0")]);
  for (let i = 1; i < 5; i++) { await a.store.beginTurn(`turn${i}`); await a.store.appendMessage(text(`verbatim-${i}`)); await a.store.endTurn(`turn${i}`, "completed"); }
  const evidence = view([refreshed(a)]); const prepared = prepareHandoff(evidence, options);
  expect(prepared.recent).toHaveLength(3); expect(prepared.older).toHaveLength(2);
  const result = buildHandoff(evidence, { ...options, summary }); expect(result.status).toBe("ready");
  expect(JSON.stringify(result.messages)).toContain("verbatim-4"); expect(JSON.stringify(result.messages)).not.toContain('"role":"toolResult"');
  const neutral = renderHandoffMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "Write", arguments: { file_path: "/fictional" } }, { type: "thinking", thinking: "not fabricated", thinkingSignature: "opaque" }] });
  expect(neutral.data[0].label).toBe("historical_tool_call_data"); expect(neutral.data[1].label).toBe("opaque_native_reference"); expect(JSON.stringify(neutral)).not.toContain("not fabricated");
  expect(buildHandoff(evidence, { ...options, summary })).toEqual(result);
});
it("accounts for started unknown effects, returned-but-unplaced results, interruption and unconsumed input without replay", async () => {
  const s = await segment("ledger"); const store = s.store;
  await store.beginTurn("pending"); await store.openOperation("op", { model: { provider: "fictional", api: "fictional-api", id: "A" } });
  await store.appendMessage({ role: "assistant", provider: "fictional", api: "fictional-api", model: "A", content: [{ type: "toolCall", id: "unknown", name: "Write", arguments: { file_path: "/fictional/unknown" } }, { type: "toolCall", id: "returned", name: "Read", arguments: { file_path: "/fictional/result" } }], stopReason: "toolUse", timestamp: 1 }, "calls");
  for (const [callId, name] of [["unknown", "Write"], ["returned", "Read"]]) for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId, name, messageId: "calls", admission }, { operationId: "op" });
  await store.write("tool_result", { callId: "returned", name: "Read", phase: "returned", messageId: null, outcome: "success", message: { role: "toolResult", toolCallId: "returned", toolName: "Read", isError: false, content: [{ type: "text", text: "Confirmed fixture result" }], timestamp: 2 } }, { operationId: "op" });
  await store.write("interruption", { cause: "crashed", operationIds: ["op"], tipId: store.tip, calls: [] });
  await store.write("input_queued", { inputId: "later", state: "queued", placement: "live" });
  const ledger = buildOpenWorkLedger(view([refreshed(s)]));
  expect(ledger.find((r) => r.callId === "unknown")).toMatchObject({ outcome: "unknown", admission: "started", placed: false, cause: "crashed" });
  expect(ledger.find((r) => r.callId === "returned")).toMatchObject({ outcome: "success", returned: true, placed: false });
  expect(ledger.find((r) => r.kind === "input")).toMatchObject({ id: "later", outcome: "not_consumed" });
  expect(buildHandoff(view([refreshed(s)]), { ...options, summary }).status).toBe("ready");
});
it("checkpoint route = exact prior validated structured summary + complete suffix after the last checkpoint; a suffix alone is text-only replay", async () => {
  const b = await segment("B");
  await b.store.appendCompaction({ summary: "exact fixture compaction", tokensBefore: 50, retainedTail: [] });
  for (let i = 0; i < 4; i++) { await b.store.beginTurn(`suffix${i}`); await b.store.appendMessage(text(`suffix-${i}`), `suffix-message-${i}`); await b.store.endTurn(`suffix${i}`, "completed"); }
  // No prior structured summary: a compaction checkpoint or the whole suffix is not a handoff.
  expect(buildHandoff(view([refreshed(b)]), options)).toMatchObject({ status: "summary_required" });
  expect(buildHandoff(view([refreshed(b)], { prior: await priorHandoff("text-only prior", false) }), options)).toMatchObject({ status: "summary_required" });
  const prior = await priorHandoff("validated prior fact"), result = buildHandoff(view([refreshed(b)], { prior }), options);
  expect(result.status).toBe("ready"); expect(result.artifact.summary).toBeNull();
  expect(result.artifact.checkpoint).toEqual({ summary: prior.summary, ledger: prior.ledger, suffix: expect.any(Array) });
  // The compaction checkpoint stands in for everything it summarized; nothing after it is clipped.
  expect(result.artifact.checkpoint.suffix.map((message) => message.id)).toEqual([expect.any(String), "suffix-message-0", "suffix-message-1", "suffix-message-2", "suffix-message-3"]);
  expect(result.artifact.checkpoint.suffix[0].data[0].text).toBe("exact fixture compaction");
  expect(result.artifact.recent).toHaveLength(1); expect(result.artifact.recent[0].messages[0].id).toBe("suffix-message-3");
  // A malformed prior summary is never accepted as a checkpoint.
  expect(() => buildHandoff(view([refreshed(b)], { prior: { ...prior, summary: { intent: "not-array" } } }), options)).toThrow("structured handoff summary");
});
it("refuses mandatory latest/ledger overflow, host-cap extensions and oversized current input; never clips", async () => {
  const a = await segment("huge", [text("x".repeat(300000))]);
  expect(buildHandoff(view([a]), options)).toMatchObject({ status: "budget_failure", reason: "mandatory_history" });
  expect(checkHandoffDispatch({ messages: [], systemPrompt: "x".repeat(100000) }, budget)).toMatchObject({ status: "budget_failure", reason: "host_cap" });
  expect(checkHandoffDispatch({ messages: [], currentInput: "x".repeat(1000) }, budget).reason).toBe("input_allowance");
  expect(createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext: { tools: [{ parameters: "x".repeat(60000) }] } }).hostCap).toBeGreaterThan(20000);
  for (const malformed of [null, {}, { ...summary, intent: "not-array" }, { ...summary, extra: [] }, Object.fromEntries(Object.keys(summary).map((key) => [key, []]))]) expect(() => validateHandoffSummary(malformed)).toThrow();
  expect(buildHandoff(view([await segment("A")]), { ...options, summary: {} })).toEqual({ status: "summary_rejected", reason: "malformed_summary" });
});
it("enforces one context-builder seam in production source (definition and compatibility export remain)", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  expect(await findContextBuilderBypasses(root)).toEqual([]);
});

it("a missing current journal hands off canonical history as a gap; gaps never masquerade as native evidence", async () => {
  const gap = { afterJournalId: null, reference: "canonical-fixture-reference", reason: "journal_missing", messages: [text("Canonical-only fictional fact")] };
  const missing = view([], { gaps: [gap] });
  expect(prepareHandoff(missing, options).coverage).toEqual([]);
  expect(buildHandoff(missing, options)).toMatchObject({ status: "summary_required" });
  expect(JSON.stringify(buildHandoff(missing, { ...options, summary }))).toContain("Canonical-only fictional fact");
  const a = await segment("A", [text("A")]);
  expect(JSON.stringify(buildHandoff(view([refreshed(a)], { gaps: [gap] }), { ...options, summary }))).toContain("Canonical-only fictional fact");
});

it("retains imported summary-only envelopes and checkpoint evidence even without older raw turns", async () => {
  const a = await segment("summary-only", [{ role: "compactionSummary", summary: "Fictional retained older fact", tokensBefore: 10, timestamp: 1 }]);
  expect(JSON.stringify(buildHandoff(view([a]), { ...options, summary }))).toContain("Fictional retained older fact");
  await a.store.appendCompaction({ summary: "Fictional checkpoint-only fact", tokensBefore: 10, retainedTail: [] });
  const evidence = view([refreshed(a)]);
  expect(JSON.stringify(prepareHandoff(evidence, options).checkpoints)).toContain("Fictional checkpoint-only fact");
  expect(JSON.stringify(buildHandoff(view([refreshed(a)], { prior: await priorHandoff("prior") }), options))).toContain("Fictional checkpoint-only fact");
});

it("evidence inspection never hides rewound current-journal contradictions", async () => {
  const a = await segment("raw-evidence");
  await a.store.appendMessage(text("Rewound native evidence"), "rewound-message");
  await a.store.moveTo("raw-evidence-message-0");
  const evidence = view([refreshed(a)]).segments[0];
  expect(evidence.records.some((r) => r.id === "rewound-message")).toBe(true);
  expect(evidence.entries.some((r) => r.id === "rewound-message")).toBe(false);
});

it("groups cold-boundary seeded user/call/result/reply scopes as whole logical turns", async () => {
  const a = await segment("seeded");
  const messages = [text("seed user one"), { role: "assistant", stopReason: "toolUse", timestamp: 1, content: [{ type: "toolCall", id: "seed-call", name: "Read", arguments: { file_path: "/fictional" } }] },
    { role: "toolResult", toolCallId: "seed-call", toolName: "Read", isError: false, timestamp: 1, content: [{ type: "text", text: "seed result" }] },
    { role: "assistant", stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "seed final one" }] }, text("seed user two"),
    { role: "assistant", stopReason: "stop", timestamp: 1, content: [{ type: "text", text: "seed final two" }] }];
  for (let i = 0; i < messages.length; i++) await a.store.appendMessage(messages[i], `seed-${i}`);
  await a.store.beginTurn("native-latest"); await a.store.appendMessage(text("native latest"), "native-latest-message"); await a.store.endTurn("native-latest", "completed");
  const prepared = prepareHandoff(view([refreshed(a)]), options);
  expect(prepared.recent.map((t) => t.messages.map((m) => m.id))).toEqual([["seed-0", "seed-1", "seed-2", "seed-3"], ["seed-4", "seed-5"], ["native-latest-message"]]);
  expect(prepared.recent[0].sourceTurnIds).toHaveLength(4);
  expect(buildHandoff(view([refreshed(a)]), { ...options, summary }).artifact.recent).toEqual(prepared.recent);
});
it("keeps a seeded tool result with its call even when a user boundary intervenes", async () => {
  const a = await segment("seed-pair");
  await a.store.appendMessage(text("first seed user"), "first-seed");
  await a.store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "seed-cross", name: "Read", arguments: {} }], stopReason: "toolUse", timestamp: 1 }, "seed-call-message");
  await a.store.appendMessage(text("intervening seed user"), "intervening-seed");
  await a.store.appendMessage({ role: "toolResult", toolCallId: "seed-cross", toolName: "Read", content: [], isError: false, timestamp: 1 }, "seed-result-message");
  const prepared = prepareHandoff(view([refreshed(a)]), options);
  expect(prepared.recent.find((t) => t.messages.some((m) => m.id === "seed-call-message")).messages.map((m) => m.id)).toEqual(["first-seed", "seed-call-message", "seed-result-message"]);
});
it("never drops authoritative recent turns after summary production to force a fit", async () => {
  const a = await segment("frozen-recent", [text("earlier".repeat(600))]);
  for (let i = 0; i < 3; i++) { await a.store.beginTurn(`retained-${i}`); await a.store.appendMessage(text(`${i}`.repeat(4000))); await a.store.endTurn(`retained-${i}`, "completed"); }
  const local = { ...options, budget: createHandoffBudget({ contextWindow: 30256, outputReserve: 1000, inputTokens: 0, hostContext }) };
  const evidence = view([refreshed(a)]); const prepared = prepareHandoff(evidence, local);
  expect(prepared.recent).toHaveLength(3);
  expect(buildHandoff(evidence, { ...local, summary: { ...summary, intent: ["summary ".repeat(2000)] } })).toMatchObject({ status: "budget_failure" });
  expect(prepareHandoff(evidence, local).recent).toEqual(prepared.recent);
});
it("retains started rewound effects and their arguments in the unknown ledger", async () => {
  const a = await segment("rewound-effect"); const baseline = a.store.tip;
  await a.store.beginTurn("rewound-turn"); await a.store.openOperation("rewound-op", {});
  await a.store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "rewound-write", name: "Write", arguments: { file_path: "/fictional/effect", content: "fictional" } }], stopReason: "toolUse", timestamp: 1 }, "rewound-call-message");
  for (const admission of ["observed", "admitted", "started"]) await a.store.write("tool_call", { callId: "rewound-write", name: "Write", messageId: "rewound-call-message", admission }, { operationId: "rewound-op" });
  await a.store.write("interruption", { cause: "user_interrupted", operationIds: ["rewound-op"], tipId: a.store.tip, calls: [] });
  await a.store.closeOperation("rewound-op", "failed"); await a.store.endTurn("rewound-turn", "failed"); await a.store.moveTo(baseline);
  const row = buildOpenWorkLedger(view([refreshed(a)])).find((r) => r.callId === "rewound-write");
  expect(row).toMatchObject({ outcome: "unknown", admission: "started", rewound: true, cause: "user_interrupted", messageId: "rewound-call-message", arguments: { file_path: "/fictional/effect", content: "fictional" } });
});
it("keeps only unresolved work in the ledger: earlier seen failures drop, far-back outcome-unknown calls never do", async () => {
  const a = await segment("bounded-ledger"); const store = a.store;
  const call = async (turnId, callId, outcome) => {
    await store.beginTurn(turnId); await store.openOperation(`${turnId}-op`, {});
    await store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "Write", arguments: { file_path: `/fictional/${callId}` } }], stopReason: "toolUse", timestamp: 1 }, `${callId}-message`);
    for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId, name: "Write", messageId: `${callId}-message`, admission }, { operationId: `${turnId}-op` });
    if (outcome === "error") {
      await store.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "Write", isError: true, content: [{ type: "text", text: "Fictional failure" }], timestamp: 1 }, `${callId}-result`);
      await store.write("tool_result", { callId, name: "Write", messageId: `${callId}-result`, phase: "placed", outcome: "error" }, { operationId: `${turnId}-op` });
    } else await store.write("interruption", { cause: "crashed", operationIds: [`${turnId}-op`], tipId: store.tip, calls: [] });
    await store.closeOperation(`${turnId}-op`, outcome === "error" ? "completed" : "interrupted"); await store.endTurn(turnId, outcome === "error" ? "failed" : "interrupted");
  };
  await call("far-unknown-turn", "far-unknown", "unknown"); await call("seen-failure-turn", "seen-failure", "error");
  await store.beginTurn("completed-turn"); await store.openOperation("completed-op", {}); await store.appendMessage(text("Fictional completed reply"), "completed-message");
  await store.closeOperation("completed-op", "completed"); await store.endTurn("completed-turn", "completed");
  await call("recent-failure-turn", "recent-failure", "error");
  const ledger = buildOpenWorkLedger(view([refreshed(a)]));
  expect(ledger.filter((entry) => entry.kind === "tool").map((entry) => [entry.callId, entry.outcome])).toEqual([["far-unknown", "unknown"], ["recent-failure", "error"]]);
  expect(ledger.find((entry) => entry.callId === "far-unknown")).toMatchObject({ arguments: { file_path: "/fictional/far-unknown" }, cause: "crashed" });
  expect(ledger.filter((entry) => entry.kind === "turn").map((entry) => entry.turnId)).toEqual(["recent-failure-turn"]);
});
it("lifecycle inspection is synchronous and performs no context payload reads", () => {
  const turn = { start: { turnId: "fixture" } }; const getEntries = vi.fn(() => { throw new Error("must not read"); });
  const result = inspectCurrentLifecycle({ validator: { turns: new Map([["fixture", turn]]), calls: new Map() }, getEntries });
  expect(result.turns[0]).toBe(turn); expect(result).not.toBeInstanceOf(Promise); expect(getEntries).not.toHaveBeenCalled();
});

it("source enforcement catches JS/TS imports and re-exports in other packages and apps", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const fake = await mkdtemp(join(root, "node_modules", ".p3a-source-check-"));
  try {
    const paths = ["packages/other/src/bypass.ts", "packages/other/src/session-context.js", "packages/another/src/index.js", "apps/chat/src/bypass.tsx"];
    for (const path of paths) { const directory = path.slice(0, path.lastIndexOf("/")); await mkdir(join(fake, directory), { recursive: true }); await writeFile(join(fake, path), 'import { buildHarnessSessionContext as bypass } from "@mono-agent/engine";'); }
    await writeFile(join(fake, paths[2]), 'export { buildHarnessSessionContext } from "@mono-agent/engine";');
    expect(await findContextBuilderBypasses(fake)).toEqual(paths.sort());
  } finally { await rm(fake, { recursive: true, force: true }); }
});

it("keeps observed successful outcomes from rewound calls as ledger evidence, not active receipts", async () => {
  const a = await segment("rewound-return"); const baseline = a.store.tip;
  await a.store.beginTurn("returned-turn"); await a.store.openOperation("returned-op", {});
  await a.store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "known-return", name: "Read", arguments: {} }], stopReason: "toolUse", timestamp: 1 }, "known-call-message");
  for (const admission of ["observed", "admitted", "started"]) await a.store.write("tool_call", { callId: "known-return", name: "Read", messageId: "known-call-message", admission }, { operationId: "returned-op" });
  const returned = { role: "toolResult", toolCallId: "known-return", toolName: "Read", content: [{ type: "text", text: "Fictional observed result" }], isError: false, timestamp: 1 };
  await a.store.write("tool_result", { callId: "known-return", name: "Read", messageId: null, phase: "returned", outcome: "success", message: returned }, { operationId: "returned-op" });
  await a.store.appendMessage(returned, "known-result-message");
  await a.store.write("tool_result", { callId: "known-return", name: "Read", messageId: "known-result-message", phase: "placed", outcome: "success" }, { operationId: "returned-op" });
  await a.store.closeOperation("returned-op", "failed"); await a.store.endTurn("returned-turn", "failed"); await a.store.moveTo(baseline);
  expect(buildOpenWorkLedger(view([refreshed(a)])).find((r) => r.callId === "known-return")).toMatchObject({ rewound: true, outcome: "success", returned: true, placed: true, result: renderHandoffMessage(returned) });
});

it("does not project a guarded journal under a contradictory host owner", async () => {
  const a = await segment("guarded-view", [text("guarded fictional fact")], true);
  const foreign = { ...a, header: { ...a.header, hostAuthority: { ...hostAuthority, ownerKey: "foreign" } } };
  expect(() => view([foreign])).toThrow("upgraded header owner");
  expect(() => view([a])).not.toThrow();
});


it("A -> B -> C keeps A's outcome-unknown Write in the deterministic ledger on paid-summary routes, once, and refuses rather than dropping it", async () => {
  const a = await segment("A-unknown"); const store = a.store;
  await store.beginTurn("unknown-turn"); await store.openOperation("unknown-op", { model: { provider: "fictional", api: "fictional-api", id: "A" } });
  await store.appendMessage({ role: "assistant", provider: "fictional", api: "fictional-api", model: "A", content: [{ type: "toolCall", id: "write-call", name: "Write", arguments: { file_path: "/fictional/unknown" } }], stopReason: "toolUse", timestamp: 1 }, "write-message");
  for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId: "write-call", name: "Write", messageId: "write-message", admission }, { operationId: "unknown-op" });
  await store.write("interruption", { cause: "crashed", operationIds: ["unknown-op"], tipId: store.tip, calls: [] });
  const ab = buildHandoff(view([refreshed(a)]), { ...options, summary });
  if (ab.status !== "ready") throw new Error("Expected A -> B handoff");
  const unknown = (artifact) => artifact.ledger.filter((entry) => entry.callId === "write-call");
  expect(unknown(ab.artifact)).toEqual([expect.objectContaining({ name: "Write", outcome: "unknown", admission: "started" })]);
  // B completes an ordinary turn, then B -> C summarizes again: A's entry is carried verbatim, not left to prose.
  const bc = buildHandoff(view([await segment("B-ordinary")], { prior: ab.artifact }), { ...options, summary });
  if (bc.status !== "ready") throw new Error("Expected B -> C handoff");
  expect(unknown(bc.artifact)).toEqual(unknown(ab.artifact));
  const cd = buildHandoff(view([await segment("C-ordinary")], { prior: bc.artifact }), { ...options, summary });
  if (cd.status !== "ready") throw new Error("Expected C -> D handoff");
  expect(unknown(cd.artifact)).toHaveLength(1); // deduplicated by stable identity
  const oversized = { ...ab.artifact, ledger: [...ab.artifact.ledger, { kind: "tool", journalId: "fictional-old", operationId: "big-op", callId: "big-call", arguments: { text: "x".repeat(300000) } }] };
  expect(buildHandoff(view([await segment("B-tight")], { prior: oversized }), { ...options, summary })).toMatchObject({ status: "budget_failure", reason: "mandatory_history" });
});


it("A -> B paid, B -> C free, C -> D free composes every prior suffix within one budget", async () => {
  const a = await segment("A-source", [text("A fact")]);
  const ab = buildHandoff(view([a]), { ...options, summary, target: { ...target, model: "B" } }); expect(ab.status).toBe("ready");
  const b = await segment("B-source", [text("B suffix fact")]);
  const bc = buildHandoff(view([b], { prior: ab.artifact }), { ...options, producer: "checkpoint", target: { ...target, model: "C" } }); expect(bc.status).toBe("ready");
  const c = await segment("C-source", [text("C suffix fact")]);
  const cd = buildHandoff(view([c], { prior: bc.artifact }), { ...options, producer: "checkpoint", target: { ...target, model: "D" } }); expect(cd.status).toBe("ready");
  expect(cd.artifact.checkpoint.summary).toEqual(summary);
  expect(cd.artifact.checkpoint.suffix.map((entry) => entry.id)).toEqual(["B-source-message-0", "C-source-message-0"]);
  expect(JSON.stringify(cd.artifact)).toContain("B suffix fact"); expect(JSON.stringify(cd.artifact)).toContain("C suffix fact");
  const huge = { ...bc.artifact, checkpoint: { ...bc.artifact.checkpoint, suffix: [{ data: [{ text: "x".repeat(300000) }] }] } };
  expect(buildHandoff(view([c], { prior: huge }), { ...options, producer: "checkpoint" })).toMatchObject({ status: "budget_failure" });
});


it("streams many small ancestry records in order without losing unresolved effects", async () => {
  const s = await segment("long-ancestry");
  await s.store.beginTurn("fictional-many-records");
  for (let i = 0; i < 2000; i++) await s.store.appendMessage(text(`fictional-${i}`), `small-${i}`);
  await s.store.endTurn("fictional-many-records", "interrupted");
  const evidence = view([refreshed(s)]);
  expect(evidence.segments[0].entries.slice(-2000).map((entry) => entry.id)).toEqual(Array.from({ length: 2000 }, (_, i) => `small-${i}`));
  expect(buildOpenWorkLedger(evidence)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "turn", turnId: "fictional-many-records" })]));
});
