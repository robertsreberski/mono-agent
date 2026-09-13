import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../continuation-store-fs.js";
import { SUBAGENT_REGISTRY_MAX_BYTES, SUBAGENT_TERMINAL_MAX_COUNT, createSubagentInstanceRegistry, subagentConversationRoot, subagentInstanceSessionId } from "../subagent-instances.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const spec = { name: "critic", systemPrompt: "Review", definition: { name: "critic", description: "Reviews", systemPrompt: "Review" } };
async function setup(options = {}) {
  const root = await mkdtemp(resolve(process.cwd(), ".subagent-test-"));
  roots.push(root);
  const retireSession = vi.fn(async () => undefined);
  const registry = createSubagentInstanceRegistry({ root, retireSession, ...options });
  return { root, retireSession, registry, handle: await registry.open("conversation") };
}
describe("persistent subagent registry", () => {
  it("persists records, accumulates turns and usage, and retires closed sessions", async () => {
    const { handle, root, retireSession } = await setup();
    const created = await handle.create(spec);
    expect(created.id).toBe("critic-1");
    expect(created.sessionId).toBe(subagentInstanceSessionId("conversation", created.id));
    await handle.begin(created.id);
    const finished = await handle.finish(created.id, { status: "ok", usage: { input: 4, costUsd: .1 }, answerHead: "x".repeat(400) });
    expect(finished).toMatchObject({ status: "idle", turns: 1, usage: { input: 4, costUsd: .1 } });
    expect(finished.lastAnswerHead).toHaveLength(300);
    const restarted = await createSubagentInstanceRegistry({ root, retireSession }).open("conversation");
    expect(await restarted.get(created.id)).toEqual(finished);
    await restarted.close(created.id);
    expect(retireSession).toHaveBeenCalledWith(created.sessionId, created.sessionsRoot);
    expect((await handle.get(created.id))?.status).toBe("closed");
  });
  it("enforces capacity, duplicate ids, maxTurns, and concurrent turn exclusion across handles", async () => {
    const { registry, handle } = await setup({ maxPerConversation: 1, maxTurns: 1 });
    await expect(handle.create({ ...spec, id: "../bad" })).rejects.toThrow(/id must/u);
    const record = await handle.create({ ...spec, id: "one" });
    await expect(handle.create(spec)).rejects.toThrow(/maxPerConversation.*Live ids: one/u);
    await handle.begin(record.id);
    const other = await registry.open("conversation");
    expect((await other.get(record.id))?.status).toBe("running");
    await expect(other.begin(record.id)).rejects.toThrow(/busy/u);
    await expect(other.close(record.id)).rejects.toThrow(/busy/u);
    await handle.finish(record.id, { status: "ok" });
    await expect(handle.begin(record.id)).rejects.toThrow(/maxTurns/u);
    await handle.close(record.id);
    expect((await handle.create({ ...spec, id: record.id })).turns).toBe(0);
  });
  it("isolates conversations and rejects duplicate live ids", async () => {
    const { registry, handle } = await setup();
    const first = await handle.create({ ...spec, id: "same" });
    await expect(handle.create({ ...spec, id: "same" })).rejects.toThrow(/Duplicate.*Live ids: same/u);
    const other = await registry.open("other");
    expect(await other.list()).toEqual([]);
    expect((await other.create({ ...spec, id: "same" })).sessionId).not.toBe(first.sessionId);
  });
  it("recovers an orphaned running record and expires idle records without expiring active turns", async () => {
    let now = 100_000;
    const { root, retireSession, handle } = await setup({ now: () => now, idleTtlMs: 60_000 });
    const record = await handle.create(spec);
    const file = resolve(subagentConversationRoot(root, "conversation"), "instances.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    records[0].status = "running";
    await writeFile(file, JSON.stringify(records));
    expect(await handle.get(record.id)).toMatchObject({ status: "idle", lastStatus: "interrupted" });
    await handle.begin(record.id);
    now += 100_000;
    expect((await handle.get(record.id))?.status).toBe("running");
    await handle.finish(record.id, { status: "failed" });
    now += 60_001;
    expect((await handle.get(record.id))?.status).toBe("expired");
    expect(retireSession).toHaveBeenCalled();
    await expect(handle.begin(record.id)).rejects.toThrow(/expired/u);
    now += 86_400_001;
    expect(await handle.list()).toEqual([]);
  });
  it("recovers a built registry after process exit and excludes a competing process during an active turn", async () => {
    const { root, handle } = await setup();
    await handle.create({ ...spec, id: "process-test" });
    const moduleUrl = new URL("../../dist/subagent-instances.js", import.meta.url).href;
    const child = (operation: string) => execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createSubagentInstanceRegistry } from ${JSON.stringify(moduleUrl)};
      const registry = createSubagentInstanceRegistry({ root: ${JSON.stringify(root)}, retireSession: async () => {} });
      const handle = await registry.open("conversation");
      ${operation}
      process.exit(0);
    `], { cwd: root, encoding: "utf8", timeout: 10_000 });
    child('await handle.begin("process-test");');
    expect(await handle.get("process-test")).toMatchObject({ status: "idle", lastStatus: "interrupted" });
    await handle.begin("process-test");
    expect(child('try { await handle.begin("process-test"); throw new Error("unexpected acquisition"); } catch (error) { if (!error.message.includes("busy")) throw error; console.log("busy"); }')).toContain("busy");
    await handle.finish("process-test", { status: "ok" });
  });

  it.each([1, 2])("releases a finishing turn when registry publication %i fails", async (failureWrite) => {
    let failAt = 0;
    const { root, retireSession, handle } = await setup({ writeRegistry: async (...args: Parameters<typeof writeJsonAtomic>) => {
      if (failAt > 0 && --failAt === 0) throw new Error("injected disk full");
      await writeJsonAtomic(...args);
    } });
    const record = await handle.create(spec);
    await handle.begin(record.id);
    failAt = failureWrite;
    await expect(handle.finish(record.id, { status: "ok" })).rejects.toThrow("injected disk full");
    const reopened = await createSubagentInstanceRegistry({ root, retireSession }).open("conversation");
    expect(await reopened.get(record.id)).toMatchObject({ status: "idle", lastStatus: "interrupted" });
    await reopened.begin(record.id);
    await reopened.finish(record.id, { status: "ok" });
  });

  it("bounds same-day terminal churn and prunes by bytes before writing", async () => {
    const { handle, root } = await setup();
    for (let n = 0; n < SUBAGENT_TERMINAL_MAX_COUNT + 3; n++) {
      const record = await handle.create({ ...spec, id: `churn-${n}` });
      await handle.close(record.id);
    }
    expect(await handle.list()).toHaveLength(SUBAGENT_TERMINAL_MAX_COUNT);
    const large = "x".repeat(4 * 1024 * 1024);
    const one = await handle.create({ ...spec, id: "large-one", systemPrompt: large, definition: { ...spec.definition, systemPrompt: large } });
    await handle.close(one.id);
    const two = await handle.create({ ...spec, id: "large-two", systemPrompt: large, definition: { ...spec.definition, systemPrompt: large } });
    const bytes = await readFile(resolve(subagentConversationRoot(root, "conversation"), "instances.json"));
    expect(bytes.byteLength).toBeLessThanOrEqual(SUBAGENT_REGISTRY_MAX_BYTES);
    expect(await handle.get(two.id)).toMatchObject({ status: "idle" });
    const oversized = "x".repeat(SUBAGENT_REGISTRY_MAX_BYTES);
    await expect(handle.create({ ...spec, id: "oversized", systemPrompt: oversized, definition: { ...spec.definition, systemPrompt: oversized } })).rejects.toThrow(/16 MiB/u);
    expect(await handle.get(two.id)).toMatchObject({ status: "idle" });
  }, 30_000);

  it.each([
    { pendingQuestion: { question: "" } }, { pendingQuestion: { question: "x".repeat(2001) } },
    { pendingQuestion: { question: "q", extra: true } }, { pendingQuestion: { question: "q", options: ["a", "a"] } },
    { pendingQuestion: { question: "q", options: [" a", "b"] } }, { status: "awaiting_reply" },
    { usage: [] }, { usage: { input: "oops", output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } },
    { usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } },
    { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: "free" } },
    { status: ["idle"] }, { createdAt: -1 }, { updatedAt: "now" }, { lastStatus: "invented" },
    { lastAnswerHead: "x".repeat(301) }, { extra: true }, { name: "mismatch" },
    { definition: { ...spec.definition, model: { provider: "openai", model: "a", reference: "openai:b" } } },
    { definition: { ...spec.definition, effort: ["high"] } },
    { definition: { ...spec.definition, allowedTools: [42] } },
    { definition: { ...spec.definition, allowedTools: ["AgentSend"] } },
    { definition: { ...spec.definition, disallowedTools: {} } },
    { definition: { ...spec.definition, mcpServerNames: [{ command: "stale" }] } },
    { definition: { ...spec.definition, mcpServers: { stale: { command: "old" } } } },
    { definition: { ...spec.definition, timeoutMs: -1 } },
    { definition: { ...spec.definition, systemPrompt: "changed" } },
  ])("rejects malformed durable fields before mutation: %j", async (patch) => {
    const { root, handle } = await setup();
    const record = await handle.create(spec);
    const file = resolve(subagentConversationRoot(root, "conversation"), "instances.json");
    const malformed = JSON.stringify([{ ...record, ...patch }]);
    await writeFile(file, malformed);
    await expect(handle.list()).rejects.toThrow(/Invalid/u);
    expect(await readFile(file, "utf8")).toBe(malformed);
  });

  it("fails closed on corrupt registry data", async () => {
    const { root, handle } = await setup();
    await writeFile(resolve(subagentConversationRoot(root, "conversation"), "instances.json"), '{}');
    await expect(handle.list()).rejects.toThrow(/Invalid/u);
  });
});

describe("awaiting child questions", () => {
  const question = { question: "Which?", options: ["A", "B"] };
  it("persists before finish, retains failures, replaces questions, and clears a successful reply", async () => {
    const { handle, root, retireSession } = await setup();
    const { id } = await handle.create(spec);
    await handle.begin(id);
    await handle.markAwaiting(id, question);
    const disk = JSON.parse(await readFile(resolve(subagentConversationRoot(root, "conversation"), "instances.json"), "utf8"));
    expect(disk[0]).toMatchObject({ status: "running", pendingQuestion: question });
    await handle.finish(id, { status: "awaiting_reply", question });
    const reopened = await createSubagentInstanceRegistry({ root, retireSession }).open("conversation");
    expect(await reopened.get(id)).toMatchObject({ status: "awaiting_reply", pendingQuestion: question });
    for (const status of ["failed", "busy", "timeout", "cancelled", "empty"]) {
      await reopened.begin(id);
      await reopened.finish(id, { status });
      expect(await reopened.get(id)).toMatchObject({ status: "awaiting_reply", pendingQuestion: question, lastStatus: status });
    }
    await reopened.begin(id);
    const replacement = { question: "Another?" };
    await reopened.markAwaiting(id, replacement);
    await reopened.finish(id, { status: "awaiting_reply", question: replacement });
    expect((await reopened.get(id))?.pendingQuestion).toEqual(replacement);
    await reopened.begin(id);
    await reopened.finish(id, { status: "ok" });
    expect(await reopened.get(id)).toMatchObject({ status: "idle" });
    expect((await reopened.get(id))?.pendingQuestion).toBeUndefined();
  });
  it("recovers a real process exit after durable question publication", async () => {
    const { handle, root } = await setup();
    const { id } = await handle.create(spec);
    const moduleUrl = new URL("../../dist/subagent-instances.js", import.meta.url).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createSubagentInstanceRegistry } from ${JSON.stringify(moduleUrl)};
      const handle = await createSubagentInstanceRegistry({ root: ${JSON.stringify(root)}, retireSession: async () => {} }).open("conversation");
      await handle.begin(${JSON.stringify(id)});
      await handle.markAwaiting(${JSON.stringify(id)}, ${JSON.stringify(question)});
      process.exit(0);
    `], { cwd: root, timeout: 10000 });
    expect(await handle.get(id)).toMatchObject({ status: "awaiting_reply", pendingQuestion: question, lastStatus: "interrupted" });
    await handle.close(id);
    expect((await handle.get(id))?.pendingQuestion).toBeUndefined();
  });
  it("counts awaiting instances toward capacity and expires them without interrupting a reply", async () => {
    let now = 100000;
    const { handle } = await setup({ maxPerConversation: 1, idleTtlMs: 60000, now: () => now });
    const { id } = await handle.create(spec);
    await handle.begin(id); await handle.markAwaiting(id, question); await handle.finish(id, { status: "awaiting_reply", question });
    await expect(handle.create(spec)).rejects.toThrow(/maxPerConversation/);
    await handle.begin(id); now += 60001;
    expect((await handle.get(id))?.status).toBe("running");
    await handle.finish(id, { status: "failed" }); now += 60001;
    expect(await handle.get(id)).toMatchObject({ status: "expired" });
    expect((await handle.get(id))?.pendingQuestion).toBeUndefined();
  });
});
