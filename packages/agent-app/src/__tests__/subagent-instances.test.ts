import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentInstanceRegistry, subagentConversationRoot, subagentInstanceSessionId } from "../subagent-instances.js";

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
  it("fails closed on corrupt registry data", async () => {
    const { root, handle } = await setup();
    await writeFile(resolve(subagentConversationRoot(root, "conversation"), "instances.json"), '{}');
    await expect(handle.list()).rejects.toThrow(/Invalid/u);
  });
});
