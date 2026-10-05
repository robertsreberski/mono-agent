import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { findContextBuilderBypasses } from "./projection-source-check.js";
import { fileURLToPath } from "node:url";
import { MemorySessionRepo } from "../session-store.js";
import { createEvidenceView, evidenceDigest, nativeCompatibility } from "../evidence-view.js";
import { buildHarnessSessionContext } from "../session-context.js";
import { projectContext, inspectCurrentLifecycle } from "../request-projection.js";
import { createHandoffBudget, buildHandoff, buildOpenWorkLedger, renderHandoffMessage, prepareHandoff, checkHandoffDispatch, validateHandoffSummary } from "../handoff.js";

const provenance = { provider: "fictional", api: "fictional-api", account: "fixture-account" };
const target = { ...provenance, model: "A" };
const hostContext = { systemPrompt: "Current fictional rules", tools: [{ name: "Read", parameters: { type: "object" } }] };
const budget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext });
const options = { target, budget, hostContext, timestamp: 17, producer: "outgoing" };
const text = (value) => ({ role: "user", content: value, timestamp: 1 });
const summary = { intent: ["Fictional goal"], constraints: ["No deployment approval"], decisions: [], completedWork: [], failures: [], openWork: ["Inspect result"], nextActions: ["Wait"], references: [] };
async function segment(id, epoch, predecessorJournalId = null, messages = [text(id)]) {
  const repo = new MemorySessionRepo(); const store = await repo.create({ id, cwd: "/fictional" });
  await store.beginTurn(`turn-${id}`);
  for (let i = 0; i < messages.length; i++) await store.appendMessage(messages[i], `${id}-message-${i}`);
  await store.endTurn(`turn-${id}`, "completed");
  const descriptor = { ownerKey: "fictional-owner", historyBucket: "fictional-bucket", epoch, journalId: store.metadata.journalId,
    handleId: id, predecessorJournalId, sourceDigest: evidenceDigest(store.records), sourceSeq: store.seq, sourceTipId: store.tip, provenance };
  return { descriptor, header: { ...store.metadata, format: "mono-harness", version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id } }, records: store.records, store };
}
function view(segments) { return createEvidenceView({ ownerKey: "fictional-owner", historyBucket: "fictional-bucket", segments }); }
function refreshed(segment) { return { ...segment, records: segment.store.records, descriptor: { ...segment.descriptor,
  sourceDigest: evidenceDigest(segment.store.records), sourceSeq: segment.store.seq, sourceTipId: segment.store.tip } }; }

describe("positive native compatibility", () => {
  it.each(["provider", "api", "account"])("rejects missing, unknown and different %s", (key) => {
    for (const value of [undefined, "", "unknown", " UNKNOWN ", "different"]) expect(nativeCompatibility({ ...provenance, [key]: value }, target).compatible).toBe(false);
    expect(nativeCompatibility(provenance, target).compatible).toBe(true);
  });
});
it("projects A -> B -> A including intervening B and opaque signatures, with no copies in current evidence mode", async () => {
  const a = await segment("A", 1, null, [text("A fact"), { role: "assistant", provider: "fictional", api: "fictional-api", model: "A", stopReason: "stop", timestamp: 1,
    content: [{ type: "thinking", thinking: "Fictional reasoning", thinkingSignature: "opaque-fixture-signature" }, { type: "text", text: "A reply" }] }]);
  const b = await segment("B", 2, a.header.journalId, [text("B fact")]); const c = await segment("A-return", 3, b.header.journalId);
  const evidence = view([a, b, c]); const result = projectContext(evidence, { ...options, switching: true });
  expect(result.status).toBe("ready"); expect(JSON.stringify(result.messages)).toContain("B fact"); expect(JSON.stringify(result.messages)).toContain("opaque-fixture-signature");
  expect(projectContext(evidence, { mode: "evidence" }).entries.map((e) => e.id)).toEqual(["A-return-message-0"]);
  const missing = structuredClone({ descriptor: b.descriptor, header: b.header, records: b.records }); missing.descriptor.provenance.account = undefined;
  expect(projectContext(view([a, missing, c]), { ...options, switching: true })).toMatchObject({ status: "handoff_required", reason: "unknown_account" });
  expect(projectContext(evidence, { ...options, budget: createHandoffBudget({ contextWindow: 20000, outputReserve: 2000, inputTokens: 100 }), switching: true }).status).toBe("handoff_required");
});
it("rejects fabricated views, cycles, foreign owners, changed frozen tips/digests and nonmonotonic epochs", async () => {
  const a = await segment("A", 1); const b = await segment("B", 2, a.header.journalId);
  for (const change of [{ predecessorJournalId: "cycle" }, { ownerKey: "foreign" }, { sourceTipId: "missing" }, { sourceDigest: "bad" }, { epoch: 0 }]) {
    expect(() => view([a, { ...b, descriptor: { ...b.descriptor, ...change } }])).toThrow("Invalid");
  }
  expect(() => projectContext({ segments: [a] }, options)).toThrow("unvalidated");
  expect(() => view([a, a])).toThrow("Invalid");
});
it("persists opt-in composed coverage and replays inherited material exactly once", async () => {
  const a = await segment("A", 1); const b = await segment("B", 2, a.header.journalId);
  b.store.enableVersion3Writes({ exclusiveWriters: true });
  const frozen = view([a, b]);
  await b.store.appendComposedCompaction({ summary: "A and B checkpoint", tokensBefore: 100, retainedTail: [], tokensAfter: 20 }, frozen);
  expect(b.store.records.find((r) => r.kind === "compaction").schemaVersion).toBe(3);
  const c = await segment("C", 3, b.header.journalId); const result = projectContext(view([a, refreshed(b), c]), { ...options, switching: true });
  expect(result.messages).toHaveLength(2); expect(result.messages[0].summary).toBe("A and B checkpoint");
  const bad = refreshed(b); bad.records = structuredClone(bad.records); bad.records.find((r) => r.kind === "compaction").payload.compaction.checkpoint.inheritedCoverage.sources[0].sourceDigest = "0".repeat(64);
  bad.descriptor.sourceDigest = evidenceDigest(bad.records);
  expect(() => projectContext(view([a, bad, c]), { ...options, switching: true })).toThrow("coverage");
  await expect(b.store.appendComposedCompaction({}, frozen)).rejects.toThrow("changed");
});
it("keeps whole latest turns, visible text verbatim and historical calls as neutral data", async () => {
  const segments = []; for (let i = 0; i < 5; i++) segments.push(await segment(`turn${i}`, i, segments.at(-1)?.header.journalId ?? null, [text(`verbatim-${i}`)]));
  const evidence = view(segments); const prepared = prepareHandoff(evidence, options);
  expect(prepared.recent).toHaveLength(3); expect(prepared.older).toHaveLength(2);
  const result = buildHandoff(evidence, { ...options, summary }); expect(result.status).toBe("ready");
  expect(JSON.stringify(result.messages)).toContain("verbatim-4"); expect(JSON.stringify(result.messages)).not.toContain('"role":"toolResult"');
  const neutral = renderHandoffMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "Write", arguments: { file_path: "/fictional" } }, { type: "thinking", thinking: "not fabricated", thinkingSignature: "opaque" }] });
  expect(neutral.data[0].label).toBe("historical_tool_call_data"); expect(neutral.data[1].label).toBe("opaque_native_reference"); expect(JSON.stringify(neutral)).not.toContain("not fabricated");
  expect(buildHandoff(evidence, { ...options, summary })).toEqual(result);
});
it("accounts for started unknown effects, returned-but-unplaced results, interruption and unconsumed input without replay", async () => {
  const s = await segment("ledger", 0); const store = s.store;
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
  expect(buildHandoff(view([refreshed(s)]), options).status).toBe("ready");
});
it("checkpoint fallback retains exact envelope plus COMPLETE suffix and all uncovered predecessors", async () => {
  const a = await segment("A", 0); const b = await segment("B", 1, a.header.journalId);
  await b.store.appendCompaction({ summary: "exact fixture checkpoint", tokensBefore: 50, retainedTail: [] });
  for (let i = 0; i < 4; i++) { await b.store.beginTurn(`suffix${i}`); await b.store.appendMessage(text(`suffix-${i}`), `suffix-message-${i}`); await b.store.endTurn(`suffix${i}`, "completed"); }
  const evidence = view([a, refreshed(b)]); const result = buildHandoff(evidence, options);
  expect(result.status).toBe("ready"); expect(result.artifact.checkpoint.suffix).toHaveLength(4); expect(result.artifact.checkpoint.prefix).toHaveLength(1);
  expect(result.artifact.checkpoint.envelope).toEqual((await b.store.getEntries()).find((e) => e.type === "compaction").checkpoint);
});
it("refuses mandatory latest/ledger overflow, host-cap extensions and oversized current input; never clips", async () => {
  const a = await segment("huge", 0, null, [text("x".repeat(300000))]);
  expect(buildHandoff(view([a]), options)).toMatchObject({ status: "budget_failure", reason: "mandatory_history" });
  expect(checkHandoffDispatch({ messages: [], systemPrompt: "x".repeat(100000) }, budget)).toMatchObject({ status: "budget_failure", reason: "host_cap" });
  expect(checkHandoffDispatch({ messages: [], currentInput: "x".repeat(1000) }, budget).reason).toBe("input_allowance");
  expect(createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext: { tools: [{ parameters: "x".repeat(60000) }] } }).hostCap).toBeGreaterThan(20000);
  for (const malformed of [null, {}, { ...summary, intent: "not-array" }, { ...summary, extra: [] }, Object.fromEntries(Object.keys(summary).map((key) => [key, []]))]) expect(() => validateHandoffSummary(malformed)).toThrow();
  expect(buildHandoff(view([await segment("A", 0)]), { ...options, summary: {} }).status).toBe("summary_rejected");
});
it("enforces one context-builder seam in production source (definition and compatibility export remain)", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  expect(await findContextBuilderBypasses(root)).toEqual([]);
});

it("opt-in model-change records carry only an artifact reference; canonical gaps cannot masquerade as native evidence", async () => {
  const a = await segment("A", 0);
  a.store.enableVersion3Writes({ exclusiveWriters: true });
  await a.store.appendModelChangeReference({ switchId: "fictional-switch", from: provenance, to: target, artifactRef: { id: "fictional-artifact", hash: "0".repeat(64) } });
  const event = a.store.records.find((r) => r.kind === "model_change");
  expect(event.schemaVersion).toBe(3); expect(event.payload.artifactRef).toEqual({ id: "fictional-artifact", hash: "0".repeat(64) });
  await expect(a.store.appendModelChangeReference({ switchId: "invalid", from: provenance, to: target, artifactRef: { id: "bad", hash: "bad", summary: "not authoritative" } })).rejects.toThrow("Invalid");
  const evidence = createEvidenceView({ ownerKey: "fictional-owner", historyBucket: "fictional-bucket", segments: [refreshed(a)], gaps: [
    { afterJournalId: a.header.journalId, reference: "canonical-fixture-reference", reason: "missing-native-history", messages: [text("Canonical-only fictional fact")] },
  ] });
  expect(projectContext(evidence, { ...options, switching: true })).toMatchObject({ status: "handoff_required", reason: "canonical_only_gap" });
  expect(JSON.stringify(buildHandoff(evidence, options))).toContain("Canonical-only fictional fact");
});

it("retains imported summary-only envelopes and checkpoint evidence even without older raw turns", async () => {
  const a = await segment("summary-only", 0, null, [{ role: "compactionSummary", summary: "Fictional retained older fact", tokensBefore: 10, timestamp: 1 }]);
  expect(JSON.stringify(buildHandoff(view([a]), options))).toContain("Fictional retained older fact");
  await a.store.appendCompaction({ summary: "Fictional checkpoint-only fact", tokensBefore: 10, retainedTail: [] });
  const evidence = view([refreshed(a)]);
  expect(JSON.stringify(prepareHandoff(evidence, options).checkpoints)).toContain("Fictional checkpoint-only fact");
  expect(JSON.stringify(buildHandoff(evidence, options))).toContain("Fictional checkpoint-only fact");
});

it("evidence inspection never hides rewound current-journal contradictions", async () => {
  const a = await segment("raw-evidence", 0);
  await a.store.appendMessage(text("Rewound native evidence"), "rewound-message");
  await a.store.moveTo("raw-evidence-message-0");
  const evidence = projectContext(view([refreshed(a)]), { mode: "evidence" });
  expect(evidence.records.some((r) => r.id === "rewound-message")).toBe(true);
  expect(evidence.entries.some((r) => r.id === "rewound-message")).toBe(false);
});

it("checkpoint fallback carries nonempty preserved tail content as neutral history", async () => {
  const call = { role: "assistant", content: [{ type: "toolCall", id: "retained-call", name: "Read", arguments: { file_path: "/fictional/retained" } }], stopReason: "toolUse", timestamp: 1 };
  const result = { role: "toolResult", toolCallId: "retained-call", toolName: "Read", isError: false, content: [{ type: "text", text: "Retained fixture fact outside summary" }], timestamp: 2 };
  const a = await segment("nonempty-tail", 0, null, [text("Older fixture intent"), call, result]);
  await a.store.appendCompaction({ summary: "Older intent only", tokensBefore: 100, retainedTail: [call, result] });
  for (let i = 0; i < 4; i++) { await a.store.beginTurn(`after-${i}`); await a.store.appendMessage(text(`later-${i}`)); await a.store.endTurn(`after-${i}`, "completed"); }
  const built = buildHandoff(view([refreshed(a)]), options);
  expect(built.status).toBe("ready"); expect(built.artifact.recent).toHaveLength(3);
  expect(built.artifact.checkpoint.retained).toEqual([renderHandoffMessage(call), renderHandoffMessage(result)]);
  expect(built.artifact.checkpoint.retained[0].data[0].label).toBe("historical_tool_call_data");
  expect(JSON.stringify(built.artifact.recent)).not.toContain("Retained fixture fact outside summary");
  expect(JSON.stringify(built.messages)).toContain("Retained fixture fact outside summary");
});
it("groups cold-boundary seeded user/call/result/reply scopes as whole logical turns", async () => {
  const a = await segment("seeded", 0);
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
  const a = await segment("seed-pair", 0);
  await a.store.appendMessage(text("first seed user"), "first-seed");
  await a.store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "seed-cross", name: "Read", arguments: {} }], stopReason: "toolUse", timestamp: 1 }, "seed-call-message");
  await a.store.appendMessage(text("intervening seed user"), "intervening-seed");
  await a.store.appendMessage({ role: "toolResult", toolCallId: "seed-cross", toolName: "Read", content: [], isError: false, timestamp: 1 }, "seed-result-message");
  const prepared = prepareHandoff(view([refreshed(a)]), options);
  expect(prepared.recent.find((t) => t.messages.some((m) => m.id === "seed-call-message")).messages.map((m) => m.id)).toEqual(["first-seed", "seed-call-message", "seed-result-message"]);
});
it("never drops authoritative recent turns after summary production to force a fit", async () => {
  const a = await segment("frozen-recent", 0, null, [text("earlier".repeat(600))]);
  for (let i = 0; i < 3; i++) { await a.store.beginTurn(`retained-${i}`); await a.store.appendMessage(text(`${i}`.repeat(4000))); await a.store.endTurn(`retained-${i}`, "completed"); }
  const local = { ...options, budget: createHandoffBudget({ contextWindow: 30000, outputReserve: 1000, inputTokens: 0, hostContext }) };
  const evidence = view([refreshed(a)]); const prepared = prepareHandoff(evidence, local);
  expect(prepared.recent).toHaveLength(3);
  expect(buildHandoff(evidence, { ...local, summary: { ...summary, intent: ["summary ".repeat(2000)] } })).toMatchObject({ status: "budget_failure" });
  expect(prepareHandoff(evidence, local).recent).toEqual(prepared.recent);
});
it("retains started rewound effects and their arguments in the unknown ledger", async () => {
  const a = await segment("rewound-effect", 0); const baseline = a.store.tip;
  await a.store.beginTurn("rewound-turn"); await a.store.openOperation("rewound-op", {});
  await a.store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "rewound-write", name: "Write", arguments: { file_path: "/fictional/effect", content: "fictional" } }], stopReason: "toolUse", timestamp: 1 }, "rewound-call-message");
  for (const admission of ["observed", "admitted", "started"]) await a.store.write("tool_call", { callId: "rewound-write", name: "Write", messageId: "rewound-call-message", admission }, { operationId: "rewound-op" });
  await a.store.write("interruption", { cause: "user_interrupted", operationIds: ["rewound-op"], tipId: a.store.tip, calls: [] });
  await a.store.closeOperation("rewound-op", "failed"); await a.store.endTurn("rewound-turn", "failed"); await a.store.moveTo(baseline);
  const row = buildOpenWorkLedger(view([refreshed(a)])).find((r) => r.callId === "rewound-write");
  expect(row).toMatchObject({ outcome: "unknown", admission: "started", rewound: true, cause: "user_interrupted", messageId: "rewound-call-message", arguments: { file_path: "/fictional/effect", content: "fictional" } });
});
it("view and store share exact repair projection timestamps and last-account selection", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  try {
    const a = await segment("repair-differential", 0); const store = a.store;
    await store.beginTurn("repair-turn"); await store.openOperation("repair-op", {});
    clock.mockReturnValue(1700000000010);
    await store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "repair-call", name: "Read", arguments: {} }], stopReason: "toolUse", timestamp: 10 }, "repair-call-message");
    for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId: "repair-call", name: "Read", messageId: "repair-call-message", admission }, { operationId: "repair-op" });
    clock.mockReturnValue(1700000000020); await store.write("interruption", { cause: "crashed", operationIds: ["repair-op"], tipId: store.tip, calls: [] });
    clock.mockReturnValue(1700000000030); await store.write("interruption", { cause: "crashed", operationIds: ["repair-op"], tipId: store.tip, calls: [] });
    await store.closeOperation("repair-op", "interrupted"); await store.endTurn("repair-turn", "interrupted");
    const evidence = view([refreshed(a)]); const repairs = await store.getRepairEntries();
    expect(evidence.segments[0].repairs).toEqual(repairs);
    expect(repairs.map((r) => r.calls.length)).toEqual([0, 1]); expect(repairs[1].calls[0].timestamp).toBe(1700000000010);
    expect(projectContext(evidence, { ...options, switching: true }).messages).toEqual(buildHarnessSessionContext(await store.getEntries(), { repairs }));
  } finally { clock.mockRestore(); }
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
    for (const path of paths) { const directory = path.slice(0, path.lastIndexOf("/")); await mkdir(join(fake, directory), { recursive: true }); await writeFile(join(fake, path), 'import { buildHarnessSessionContext as bypass } from "@mono-agent/harness";'); }
    await writeFile(join(fake, paths[2]), 'export { buildHarnessSessionContext } from "@mono-agent/harness";');
    expect(await findContextBuilderBypasses(fake)).toEqual(paths.sort());
  } finally { await rm(fake, { recursive: true, force: true }); }
});

it("gates every opt-in v3 writer on an explicit exclusive-upgraded-writers acknowledgement", async () => {
  const a = await segment("v3-gate", 0); const before = structuredClone(a.store.records);
  const change = { switchId: "fictional-switch", from: provenance, to: target, artifactRef: { id: "fixture", hash: "0".repeat(64) } };
  await expect(a.store.appendModelChangeReference(change)).rejects.toThrow("exclusive upgraded writers");
  await expect(a.store.appendComposedCompaction({ summary: "fixture", retainedTail: [] }, view([a]))).rejects.toThrow("exclusive upgraded writers");
  await expect(a.store.write("model_change", {}, { schemaVersion: 3 })).rejects.toThrow("exclusive upgraded writers");
  expect(() => a.store.enableVersion3Writes({ exclusiveWriters: false })).toThrow("exclusive upgraded writers");
  expect(a.store.records).toEqual(before);
  a.store.enableVersion3Writes({ exclusiveWriters: true }); await a.store.appendModelChangeReference(change);
  expect(a.store.records.some((r) => r.kind === "model_change" && r.schemaVersion === 3)).toBe(true);
});

it("keeps observed successful outcomes from rewound calls as ledger evidence, not active receipts", async () => {
  const a = await segment("rewound-return", 0); const baseline = a.store.tip;
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

it("sheds only optional complete groups duplicated in an exact checkpoint suffix, without a producer", async () => {
  const a = await segment("checkpoint-shedding", 0);
  await a.store.appendCompaction({ summary: "Exact fictional older context", tokensBefore: 100, retainedTail: [] });
  for (let i = 0; i < 4; i++) {
    await a.store.beginTurn(`suffix-turn-${i}`);
    await a.store.appendMessage(text(`${i}:` + "f".repeat(6000)), `suffix-id-${i}`);
    await a.store.endTurn(`suffix-turn-${i}`, "completed");
  }
  const evidence = view([refreshed(a)]);
  const local = { ...options, producer: "checkpoint", budget: createHandoffBudget({ contextWindow: 34000, outputReserve: 1000, inputTokens: 0, hostContext }) };
  const prepared = prepareHandoff(evidence, local);
  expect(prepared.recent).toHaveLength(3);
  const built = buildHandoff(evidence, local);
  expect(built.status).toBe("ready");
  expect(built.artifact.summary).toBeNull();
  expect(built.artifact.recent.length).toBeLessThan(3);
  expect(built.artifact.recent.at(-1)).toEqual(prepared.recent.at(-1));
  expect(built.artifact.ledger).toEqual(prepared.ledger);
  expect(built.artifact.checkpoint.suffix.map((message) => message.id)).toEqual(["suffix-id-0", "suffix-id-1", "suffix-id-2", "suffix-id-3"]);
  expect(built.artifact.retainedIds).toEqual(built.artifact.recent.flatMap((group) => group.messages.map((message) => message.id)));
  expect(prepareHandoff(evidence, local)).toEqual(prepared);
  expect(buildHandoff(evidence, local)).toEqual(built);
});

it("does not shed a group only partly retained by the checkpoint", async () => {
  const a = await segment("partial-checkpoint-shedding", 0, null, [text("mandatory original fact " + "p".repeat(600)), text("retained portion " + "r".repeat(6000))]);
  const retained = (await a.store.getEntries())[1].message;
  await a.store.appendCompaction({ summary: "Exact fictional checkpoint " + "c".repeat(12000), tokensBefore: 100, retainedTail: [retained] });
  await a.store.beginTurn("complete-suffix-turn");
  await a.store.appendMessage(text("optional suffix " + "s".repeat(4000)), "optional-suffix-id");
  await a.store.endTurn("complete-suffix-turn", "completed");
  await a.store.beginTurn("latest-suffix-turn");
  await a.store.appendMessage(text("required latest " + "l".repeat(4000)), "required-latest-id");
  await a.store.endTurn("latest-suffix-turn", "completed");
  const evidence = view([refreshed(a)]);
  const local = { ...options, budget: createHandoffBudget({ contextWindow: 34000, outputReserve: 1000, inputTokens: 0, hostContext }) };
  const prepared = prepareHandoff(evidence, local);
  expect(prepared.recent).toHaveLength(3);
  // The optional suffix may disappear, but the partially retained group cannot:
  // the original fact must remain verbatim, not be inferred from summary prose.
  expect(buildHandoff(evidence, local)).toMatchObject({ status: "budget_failure" });
});

it("allows shedding a whole group exactly represented by checkpoint retained IDs and content", async () => {
  const a = await segment("retained-checkpoint-shedding", 0, null, [text("exact retained fact " + "r".repeat(6000))]);
  const retained = (await a.store.getEntries())[0].message;
  await a.store.appendCompaction({ summary: "Exact checkpoint " + "c".repeat(8000), tokensBefore: 100, retainedTail: [retained] });
  for (let i = 0; i < 2; i++) {
    await a.store.beginTurn(`retained-suffix-${i}`);
    await a.store.appendMessage(text(`${i}:` + "s".repeat(4000)), `retained-suffix-message-${i}`);
    await a.store.endTurn(`retained-suffix-${i}`, "completed");
  }
  const evidence = view([refreshed(a)]);
  const local = { ...options, budget: createHandoffBudget({ contextWindow: 34000, outputReserve: 1000, inputTokens: 0, hostContext }) };
  expect(prepareHandoff(evidence, local).recent).toHaveLength(3);
  const built = buildHandoff(evidence, local);
  expect(built.status).toBe("ready");
  expect(built.artifact.recent.some((group) => group.messages.some((message) => message.id === "retained-checkpoint-shedding-message-0"))).toBe(false);
  expect(built.artifact.checkpoint.retained).toEqual([renderHandoffMessage(retained)]);
  expect(built.artifact.recent.at(-1).messages[0].id).toBe("retained-suffix-message-1");
});

it("qualifies suffix message identities by journal and never sheds a prefix-only group", async () => {
  const a = await segment("prefix-checkpoint-shedding", 0, null, [text("prefix-only fact " + "p".repeat(6000))]);
  const b = await segment("middle-checkpoint-shedding", 1, a.header.journalId, []);
  await b.store.appendCompaction({ summary: "Exact checkpoint " + "c".repeat(8000), tokensBefore: 100, retainedTail: [] });
  await b.store.beginTurn("middle-suffix");
  await b.store.appendMessage(text("middle suffix " + "s".repeat(4000)), "middle-suffix-message");
  await b.store.endTurn("middle-suffix", "completed");
  const c = await segment("last-checkpoint-shedding", 2, b.header.journalId, []);
  await c.store.beginTurn("last-suffix");
  await c.store.appendMessage(text("last suffix " + "l".repeat(4000)), "prefix-checkpoint-shedding-message-0");
  await c.store.endTurn("last-suffix", "completed");
  const evidence = view([a, refreshed(b), refreshed(c)]);
  const local = { ...options, budget: createHandoffBudget({ contextWindow: 34000, outputReserve: 1000, inputTokens: 0, hostContext }) };
  expect(prepareHandoff(evidence, local).recent).toHaveLength(3);
  const built = buildHandoff(evidence, local);
  expect(built.status).toBe("ready");
  expect(built.artifact.recent.map((group) => group.journalId)).toEqual([a.header.journalId, c.header.journalId]);
  expect(built.artifact.recent.at(-1).messages[0].data[0].text).toContain("last suffix");
});
