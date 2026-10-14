import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { MemorySessionRepo } from "../session-store.js";
import { repairInterruptedSession, recordInterruption } from "../interruption.js";
import { buildHarnessSessionContext } from "../session-context.js";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function notice(child) { return Promise.race([once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`Effect worker exited: ${code}`); })]); }
async function reopen(root) {
  const child = fork(new URL("./fixtures/effect-worker.mjs", import.meta.url), [root, "reopen"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try { const [result] = await notice(child); await once(child, "exit"); return result; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
it("survives SIGKILL after returned outcome sync before envelope placement; repeated process reopen repairs once with zero effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "effect-repair-")); roots.push(root);
  const child = fork(new URL("./fixtures/effect-worker.mjs", import.meta.url), [root, "run"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try { expect((await notice(child))[0]).toEqual({ phase: "returned-outcome-synced" }); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  const directory = join(root, "mono-v2", "journals"); const path = join(directory, (await readdir(directory))[0]); const before = await readFile(path);
  const first = await reopen(root); const after = await readFile(path); const second = await reopen(root);
  expect(after.subarray(0, before.length).equals(before)).toBe(true); expect((await readFile(path)).equals(after)).toBe(true);
  expect(first).toEqual(second); expect(await readFile(join(root, "effect-counter"), "utf8")).toBe("1");
  const outcome = first.context.find((message) => message.role === "toolResult");
  expect(outcome).toMatchObject({ projectionOnly: true, isError: false, content: [{ type: "text", text: "Fictional effect observed." }] });
  expect(first.context.at(-1).content[0].text).toContain("no tool was replayed");
  const records = after.toString("utf8").trim().split("\n").map(JSON.parse).slice(1);
  expect(records.filter((record) => record.kind === "interruption")).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "interrupted" } });
  expect(records.filter((record) => record.kind === "message" && record.payload.message.role === "toolResult")).toEqual([]);
});

it.each(["crashed", "user_interrupted", "skipped", "superseded"])("projects a missing %s result as error evidence without a successful native receipt", async (cause) => {
  const store = await new MemorySessionRepo().create(); await store.beginTurn("fictional-turn"); await store.openOperation("fictional-op", {});
  const id = await store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "Effect", arguments: {} }], stopReason: "toolUse", timestamp: 1 });
  await store.write("tool_call", { callId: "call", name: "Effect", messageId: id, admission: "observed" }, { operationId: "fictional-op" });
  if (cause !== "skipped") { await store.write("tool_call", { callId: "call", name: "Effect", messageId: id, admission: "admitted" }, { operationId: "fictional-op" });
    await store.write("tool_call", { callId: "call", name: "Effect", messageId: id, admission: "started" }, { operationId: "fictional-op" }); }
  await repairInterruptedSession(store, cause); const seq = store.seq;
  const projected = buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() });
  await repairInterruptedSession(store, cause); expect(store.seq).toBe(seq);
  expect(projected).toEqual(buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() }));
  expect(projected.find((message) => message.role === "toolResult")).toMatchObject({ isError: true, projectionOnly: true, interruptionCause: cause });
  if (cause === "crashed") expect(JSON.stringify(projected)).toContain("check whether it took effect");
  expect([...store.validator.calls.values()].every((call) => !call.result)).toBe(true); expect((await store.getTurn("fictional-turn")).payload.status).toBe("interrupted");
  await store.close();
});

it("repairs provider suspension as suspended-not-resumed, with no continuation or successful native receipt", async () => {
  const repo = new MemorySessionRepo(); const store = await repo.create(); await store.beginTurn("deferred-turn"); await store.openOperation("deferred-op", {});
  await store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "deferred-call", name: "Effect", arguments: {} }], stopReason: "deferred", deferred: { id: "deferred", provider: "faux" }, timestamp: 1 });
  // Legacy observed evidence on a non-executable envelope must also be excluded.
  await store.write("tool_call", { callId: "deferred-call", name: "Effect", messageId: store.tip, admission: "observed" }, { operationId: "deferred-op" });
  await repairInterruptedSession(store); const seq = store.seq;
  expect(await store.getOpenOperations()).toEqual([]); expect((await store.getTurn("deferred-turn")).payload.status).toBe("interrupted");
  const context = buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() });
  expect(context.filter((message) => message.role === "toolResult")).toEqual([]);
  expect(context.at(-1)).toMatchObject({ projectionOnly: true, interruptionCause: "suspended_not_resumed" });
  expect(JSON.stringify(context)).toContain("suspended, not resumed");
  await repairInterruptedSession(store); expect(store.seq).toBe(seq); expect([...store.validator.calls.values()].every((call) => !call.result)).toBe(true);
  await store.beginTurn("next-turn"); await store.endTurn("next-turn", "completed"); await store.close();
});

async function startedCall(store, operationId, callId) {
  await store.openOperation(operationId, {});
  const id = await store.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "Effect", arguments: {} }], stopReason: "toolUse", timestamp: 1 });
  for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId, name: "Effect", messageId: id, admission }, { operationId });
}
it("accounts independently for an aborted operation then a crashed started call in the same host turn", async () => {
  const store = await new MemorySessionRepo().create(); await store.beginTurn("same-host-turn", {}, "host");
  await startedCall(store, "first", "same-call-id"); await recordInterruption(store, "same-host-turn", "user_interrupted", ["first"]); await store.closeOperation("first", "aborted");
  await startedCall(store, "second", "same-call-id"); await repairInterruptedSession(store);
  expect(store.interruptions.size).toBe(2); const repairs = await store.getRepairEntries();
  expect(repairs.map((repair) => repair.operationIds)).toEqual([["first"], ["second"]]);
  const context = buildHarnessSessionContext(await store.getEntries(), { repairs }); const results = context.filter((message) => message.role === "toolResult");
  expect(results.map((message) => message.interruptionCause)).toEqual(["user_interrupted", "crashed"]);
  expect(results[1].content[0].text).toContain("check whether it took effect"); const seq = store.seq; await repairInterruptedSession(store); expect(store.seq).toBe(seq); await store.close();
});
it("supplies a conservative cause for a closed started call omitted by older interruption evidence", async () => {
  const store = await new MemorySessionRepo().create(); await store.beginTurn("fallback-turn"); await startedCall(store, "fallback-op", "fallback-call");
  await store.write("interruption", { cause: "user_interrupted", operationIds: ["fallback-op"], calls: [], tipId: store.tip });
  await store.closeOperation("fallback-op", "interrupted"); await store.endTurn("fallback-turn", "interrupted");
  const context = buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() });
  expect(context.find((message) => message.role === "toolResult")).toMatchObject({ interruptionCause: "crashed", projectionOnly: true, isError: true });
  expect(JSON.stringify(context)).toContain("check whether it took effect"); await store.close();
});
it("caches repair payload reads and uses indexed ancestry without rematerializing the branch", async () => {
  const store = await new MemorySessionRepo().create(); let reads = 0;
  const original = store.getEntries.bind(store); store.getEntries = async () => { reads += 1; return original(); };
  expect(await store.getRepairEntries()).toEqual([]); expect(reads).toBe(0);
  await store.beginTurn("cache-turn"); await startedCall(store, "cache-op", "cache-call");
  await store.write("tool_result", { callId: "cache-call", name: "Effect", messageId: null, phase: "returned", message: { role: "toolResult", toolCallId: "cache-call", toolName: "Effect", content: [], isError: false }, outcome: "success" }, { operationId: "cache-op" });
  await repairInterruptedSession(store); let outcomeReads = 0; const getOutcome = store.getReturnedOutcome.bind(store);
  store.getReturnedOutcome = async (...args) => { outcomeReads += 1; return getOutcome(...args); };
  const first = await store.getRepairEntries(); expect(await store.getRepairEntries()).toEqual(first);
  expect(outcomeReads).toBe(1); expect(reads).toBe(0);
  await store.beginTurn("cache-next-turn"); await startedCall(store, "cache-next-op", "cache-next-call");
  await repairInterruptedSession(store);
  const updated = await store.getRepairEntries(); expect(updated).toHaveLength(2);
  expect(updated.flatMap((repair) => repair.calls).map((call) => call.callId)).toEqual(["cache-call", "cache-next-call"]);
  expect(await store.getRepairEntries()).toEqual(updated); expect(outcomeReads).toBe(3); expect(reads).toBe(0);
  await store.moveTo(null); expect(await store.getRepairEntries()).toEqual([]); await store.close();
});

it.each(["error", "aborted", "deferred"])("excludes legacy non-executable %s draft calls from repair and provider-facing projection", async (stopReason) => {
  const { transformMessages } = await import("@earendil-works/pi-ai/api/transform-messages");
  const { fauxProvider } = await import("@earendil-works/pi-ai"); const model = fauxProvider({ provider: "faux", models: [{ id: "draft" }] }).getModel();
  const store = await new MemorySessionRepo().create(); await store.beginTurn("draft-turn"); await store.openOperation("draft-op", {});
  await store.appendMessage({ role: "user", content: "Fictional input." });
  const draft = { role: "assistant", content: [{ type: "toolCall", id: "draft", name: "Effect", arguments: {} }], stopReason, timestamp: 1 };
  const messageId = await store.appendMessage(draft);
  await store.write("tool_call", { callId: "draft", name: "Effect", messageId, admission: "observed" }, { operationId: "draft-op" });
  await repairInterruptedSession(store); const repairs = await store.getRepairEntries(); expect(repairs[0].calls).toEqual([]);
  const projected = transformMessages(buildHarnessSessionContext(await store.getEntries(), { repairs }), model);
  expect(projected.filter((message) => message.role === "toolResult")).toEqual([]); expect(JSON.stringify(projected)).not.toContain('"toolCall"');
  await store.appendCompaction({ summary: "Fictional draft excluded.", retainedTail: [draft, { role: "toolResult", toolName: "Effect", toolCallId: "draft", content: [], isError: true, projectionOnly: true }], tokensBefore: 100 });
  const compacted = transformMessages(buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() }), model);
  expect(compacted.filter((message) => message.role === "toolResult")).toEqual([]); expect(JSON.stringify(compacted)).not.toContain('"toolCall"'); await store.close();
});

it("does not retroactively change an unaccounted old failed transcript when an unrelated interruption appears", async () => {
  const store = await new MemorySessionRepo().create(); await store.beginTurn("old-failed"); await startedCall(store, "old-op", "old-call");
  await store.write("tool_result", { callId: "old-call", name: "Effect", messageId: null, phase: "returned", message: { role: "toolResult", toolCallId: "old-call", toolName: "Effect", content: [{ type: "text", text: "Old fictional outcome" }], isError: false }, outcome: "success" }, { operationId: "old-op" });
  await store.closeOperation("old-op", "failed"); await store.endTurn("old-failed", "failed");
  const earlier = buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() }); expect(earlier.filter((message) => message.role === "toolResult")).toEqual([]);
  await store.beginTurn("later-interrupted"); await store.openOperation("later-op", {}); await store.appendMessage({ role: "user", content: "Later fictional user input." });
  await repairInterruptedSession(store);
  const next = buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() });
  expect(next.slice(0, earlier.length)).toEqual(earlier); expect(next.filter((message) => message.role === "toolResult")).toEqual([]);
  expect(JSON.stringify(next)).not.toContain("Old fictional outcome"); expect(next.at(-1).interruptionCause).toBe("crashed"); await store.close();
});
