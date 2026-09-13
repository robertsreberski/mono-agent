import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
import type { SubagentOwnerIdentity, SubagentOwnerResolution } from "../subagent-registry-ownership.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const spec = { id: "child", name: "review", systemPrompt: "Review", definition: { name: "review", description: "Review", systemPrompt: "Review" } };
async function crashedLinkedTurn() {
  const root = await mkdtemp(resolve(process.cwd(), ".registry-ownership-")); roots.push(root);
  const storeRoot = resolve(root, "registered-jobs");
  const jobId = randomUUID();
  const moduleUrl = new URL("../../dist/subagent-instances.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createSubagentInstanceRegistry } from ${JSON.stringify(moduleUrl)};
    const handle = await createSubagentInstanceRegistry({ root: ${JSON.stringify(root)}, retireSession: async () => {},
      ownerForReservation: (jobId) => ({ jobId, storeRoot: ${JSON.stringify(storeRoot)} }) }).open("conversation");
    await handle.create(${JSON.stringify(spec)});
    await handle.reserve("child", ${JSON.stringify(jobId)});
    await handle.begin("child", ${JSON.stringify(jobId)});
    process.exit(0);
  `], { cwd: root, timeout: 10_000 });
  const disk = JSON.parse(await readFile(resolve(subagentConversationRoot(root, "conversation"), "instances.json"), "utf8"))[0];
  const identity: SubagentOwnerIdentity = { conversationId: "conversation", instanceId: "child", instanceIncarnation: disk.incarnation,
    turnToken: disk.activeTurn.token, jobId, storeRoot };
  return { root, identity, disk };
}

describe("registry ownership fences independent of process-job service availability", () => {
  it.each(["missing", "held", "unavailable", "throws"])("never unblocks a physically abandoned linked turn with owner %s", async (state) => {
    const { root, identity } = await crashedLinkedTurn();
    const resolver = state === "missing" ? undefined : vi.fn(async (): Promise<SubagentOwnerResolution> => {
      if (state === "throws") throw new Error("private path must not escape");
      return { state: state === "held" ? "held" : "unavailable" };
    });
    const handle = await createSubagentInstanceRegistry({ root, retireSession: async () => {}, ...(resolver ? { resolveOwner: resolver } : {}) }).open("conversation");
    const record = await handle.get("child");
    expect(record).toMatchObject({ status: "running", incarnation: identity.instanceIncarnation, activeTurn: { token: identity.turnToken } });
    expect(JSON.stringify(await handle.list())).not.toContain(identity.storeRoot);
    expect(record).not.toHaveProperty("ownerLink");
    await expect(handle.begin("child")).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(handle.reserve("child", randomUUID())).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(handle.close("child")).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(handle.create({ ...spec, id: "replacement" })).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
  });
  it("requires exact incarnation/turn/root and keeps the failure fence after released proof", async () => {
    const { root, identity } = await crashedLinkedTurn();
    let returnedIdentity: SubagentOwnerIdentity = { ...identity, instanceIncarnation: randomUUID() };
    const resolver = async (): Promise<SubagentOwnerResolution> => ({ state: "released", identity: returnedIdentity,
      sequence: 2, continuity: "unknown", reason: "timeout" });
    const handle = await createSubagentInstanceRegistry({ root, retireSession: async () => {}, ...(resolver ? { resolveOwner: resolver } : {}) }).open("conversation");
    await expect(handle.begin("child")).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    returnedIdentity = identity;
    const released = await handle.get("child");
    expect(released).toMatchObject({ status: "idle", recovery: { turnToken: identity.turnToken, reason: "timeout", continuity: "unknown", sequence: 2 } });
    expect(released).not.toHaveProperty("activeTurn");
    await expect(handle.begin("child")).rejects.toMatchObject({ code: "subagent_recovery_required" });
    await handle.close("child");
    const recreated = await handle.create(spec);
    expect(recreated.incarnation).not.toBe(identity.instanceIncarnation);
    await handle.begin("child");
    await handle.finish("child", { status: "ok" });
    expect((await handle.get("child"))?.recovery).toBeUndefined();
  });
  it("treats an old released certificate as a no-op against a newer active replacement", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".registry-certificate-noop-")); roots.push(root);
    const storeRoot = resolve(root, "jobs"); const oldJob = randomUUID();
    let proof: SubagentOwnerResolution = { state: "unavailable" };
    const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {},
      ownerForReservation: (jobId) => ({ jobId, storeRoot }), resolveOwner: async () => proof });
    const handle = await registry.open("conversation");
    const created = await handle.create(spec); await handle.reserve("child", oldJob); await handle.begin("child", oldJob);
    const identity: SubagentOwnerIdentity = { conversationId: "conversation", instanceId: "child", instanceIncarnation: created.incarnation!,
      turnToken: oldJob, jobId: oldJob, storeRoot };
    const publication = { identity, sequence: 1, disposition: { status: "ok" as const, continuity: "retained" as const }, released: true,
      outcome: { status: "ok" as const } };
    await handle.publishOwned("intent", publication); await handle.publishOwned("confirm", publication);
    proof = { state: "released", identity, sequence: 1, continuity: "retained", receiptRecorded: true };
    await handle.publishOwned("finalize", publication); await handle.publishOwned("acknowledge", publication);
    await handle.close("child"); const replacement = await handle.create(spec); const active = await handle.begin("child");
    expect(replacement.incarnation).not.toBe(identity.instanceIncarnation);
    await expect(handle.publishOwned("acknowledge", publication)).resolves.toBeUndefined();
    expect(await handle.get("child")).toMatchObject({ incarnation: replacement.incarnation, status: "running", activeTurn: active.activeTurn });
    await handle.finish("child", { status: "ok" });
  });
  it("fails creation closed when retained history cannot be indexed, even without a registry record", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".registry-index-")); roots.push(root);
    const index = vi.fn(async () => "unavailable" as const);
    const retireSession = vi.fn(async () => {});
    const handle = await createSubagentInstanceRegistry({ root, retireSession, checkOwnerIndex: index }).open("conversation");
    await expect(handle.create(spec)).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    expect(index).toHaveBeenCalledWith("conversation", []);
    expect(retireSession).not.toHaveBeenCalled();
    expect(await handle.list()).toEqual([]);
  });
  it("persists a minimal foreground loss reason without inventing command ownership", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".registry-foreground-")); roots.push(root);
    const handle = await createSubagentInstanceRegistry({ root, retireSession: async () => {} }).open("conversation");
    await handle.create(spec);
    const active = await handle.begin("child");
    expect(active.activeTurn).toMatchObject({ kind: "foreground", settlementPending: true });
    await handle.finish("child", { status: "failed", failureKind: "session_continuity_lost" });
    expect((await handle.get("child"))?.recovery).toMatchObject({ reason: "session_continuity_lost", continuity: "lost" });
    await expect(handle.begin("child")).rejects.toMatchObject({ code: "subagent_recovery_required" });
    await handle.close("child");
  });
});
