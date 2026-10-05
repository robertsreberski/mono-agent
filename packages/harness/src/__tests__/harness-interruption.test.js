import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { MemorySessionRepo } from "../session-store.js";
import { repairInterruptedSession, NativeSuspendedError } from "../interruption.js";
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

it("leaves provider-deferred suspension distinct and never fabricates interrupted completion", async () => {
  const store = await new MemorySessionRepo().create(); await store.beginTurn("deferred-turn"); await store.openOperation("deferred-op", {});
  await store.appendMessage({ role: "assistant", content: [], stopReason: "deferred", deferred: { id: "deferred", provider: "faux" }, timestamp: 1 });
  const seq = store.seq; await expect(repairInterruptedSession(store)).rejects.toBeInstanceOf(NativeSuspendedError);
  expect(store.seq).toBe(seq); expect(await store.getOpenOperations()).toHaveLength(1); expect(await store.getTurn("deferred-turn")).toBeNull(); await store.close();
});
