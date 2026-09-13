import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
import type { SubagentOwnerIdentity } from "../subagent-registry-ownership.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const spec = { id: "helper", name: "helper", systemPrompt: "Review", definition: { name: "helper", description: "Review", systemPrompt: "Review" } };
async function fixture(continuity: "retained" | "lost" | "unknown" = "retained") {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.recovery-ack-")); roots.push(root);
  let allowed = true;
  const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {},
    ownerForReservation: (jobId) => ({ jobId, storeRoot: root }), authorizeRecovery: async () => allowed,
    resolveOwner: async (identity) => ({ state: "released", identity, sequence: 7, continuity, reason: "timeout" }),
  });
  const handle = await registry.open("conversation"); const created = await handle.create(spec);
  const jobId = randomUUID(); await handle.reserve(spec.id, jobId); await handle.begin(spec.id, jobId);
  const identity: SubagentOwnerIdentity = { storeRoot: root, jobId, conversationId: "conversation", instanceId: spec.id, instanceIncarnation: created.incarnation!, turnToken: jobId };
  await handle.publishOwned("confirm", { identity, sequence: 7, disposition: { status: "timeout", reason: "timeout", continuity }, released: true });
  return { root, handle, registry, identity, deny: () => { allowed = false; }, file: resolve(subagentConversationRoot(root, "conversation"), "instances.json") };
}
it("issues a retained-only token, atomically consumes with reservation, and checks duplicates before busy", async () => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id);
  expect(inspection).toMatchObject({ status: "ready", recovery: { continuity: "retained" } }); expect(inspection.ack).toBeTypeOf("string");
  const request = { ack: inspection.ack!, message: "Verified independently; continue.", background: true };
  const next = randomUUID(); const reserved = await f.handle.reserve(spec.id, next, request);
  expect(reserved).toMatchObject({ status: "queued", activeTurn: { token: next } }); expect(reserved.recovery).toBeUndefined();
  const disk = JSON.parse(await readFile(f.file, "utf8"))[0];
  expect(Buffer.from(disk.recoveryBinding.key, "hex")).toHaveLength(32);
  expect(disk.recoveryBinding.consumed.turnToken).toBe(next);
  expect(JSON.stringify(disk).includes(request.message)).toBe(false);
  expect(JSON.stringify(await f.handle.list()).includes(disk.recoveryBinding.key)).toBe(false);
  expect(reserved).not.toHaveProperty("recoveryBinding");
  await expect(f.handle.reserve(spec.id, randomUUID(), { ...request, close: false })).rejects.toMatchObject({ code: "subagent_recovery_already_consumed" });
  await expect(f.handle.checkAcknowledgement(spec.id, { ...request, message: request.message + " " })).rejects.toMatchObject({ code: "subagent_recovery_ack_conflict" });
  await expect(f.handle.checkAcknowledgement(spec.id, { ...request, close: true })).rejects.toMatchObject({ code: "subagent_recovery_ack_conflict" });
  await expect(f.handle.verifyOwner({ ...f.identity, jobId: next, turnToken: next })).resolves.toEqual({ retained: true });
});
it.each(["lost", "unknown"] as const)("never issues a continuation token for %s continuity", async (continuity) => {
  const f = await fixture(continuity);
  expect((await f.handle.inspect(spec.id)).ack).toBeUndefined();
  await expect(f.handle.begin(spec.id)).rejects.toMatchObject({ code: "subagent_recovery_required" });
  await f.handle.close(spec.id); expect((await f.handle.create(spec)).incarnation).not.toBe(f.identity.instanceIncarnation);
});
it("reauthorizes before inspection and acknowledgement, without exposing private binding material", async () => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id); f.deny();
  expect(await f.handle.inspect(spec.id)).toMatchObject({ status: "observation_policy_denied" });
  await expect(f.handle.reserve(spec.id, randomUUID(), { ack: inspection.ack!, message: "next", background: true })).rejects.toMatchObject({ code: "subagent_recovery_policy_denied" });
  expect((await f.handle.get(spec.id))?.recovery).toBeDefined();
});
it("requires explicit detached acknowledgement and rejects a stale observation without consumption", async () => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id);
  const request = { ack: inspection.ack!, message: "next" };
  await expect(f.handle.begin(spec.id, undefined, request)).rejects.toMatchObject({ code: "subagent_recovery_background_required" });
  const disk = JSON.parse(await readFile(f.file, "utf8")); disk[0].recovery.sequence++;
  await writeFile(f.file, JSON.stringify(disk));
  await expect(f.handle.reserve(spec.id, randomUUID(), { ...request, background: true })).rejects.toMatchObject({ code: "subagent_recovery_ack_stale" });
  expect(JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding.consumed).toBeUndefined();
});
it("reopens persisted consumption without granting a second admission", async () => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id);
  const request = { ack: inspection.ack!, message: "next", background: true };
  await f.handle.reserve(spec.id, randomUUID(), request);
  const reopened = await f.registry.open("conversation");
  await expect(reopened.checkAcknowledgement(spec.id, request)).rejects.toMatchObject({ code: "subagent_recovery_already_consumed" });
});
it("physically kills the owner after consumption but before admission; duplicates never retry missing work", async () => {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.ack-crash-")); roots.push(root);
  const module = new URL("../../dist/subagent-instances.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { randomUUID } from 'node:crypto';
    import { createSubagentInstanceRegistry } from ${JSON.stringify(module)};
    const root = ${JSON.stringify(root)};
    const registry = createSubagentInstanceRegistry({ root, retireSession: async () => {},
      authorizeRecovery: async () => true, ownerForReservation: (jobId) => ({jobId, storeRoot: root}),
      resolveOwner: async (identity) => ({state: 'released', identity, sequence: 7, continuity: 'retained', reason: 'timeout'}) });
    const handle = await registry.open('conversation'); const instance = await handle.create(${JSON.stringify(spec)});
    const old = randomUUID(); await handle.reserve('helper', old); await handle.begin('helper', old);
    const identity = { conversationId: 'conversation', instanceId: 'helper', instanceIncarnation: instance.incarnation, turnToken: old, jobId: old, storeRoot: root };
    await handle.publishOwned('confirm', { identity, sequence: 7, disposition: {status: 'timeout', reason: 'timeout', continuity: 'retained'}, released: true });
    const inspected = await handle.inspect('helper'); const request = {ack: inspected.ack, message: 'parent verified', background: true};
    await handle.reserve('helper', randomUUID(), request);
    setInterval(() => {}, 1000); process.send(request);
  `], { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; child.stderr!.on("data", (data: Buffer) => { errors = (errors + data.toString()).slice(-2048); });
  const exited = once(child, "exit"); const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [request] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Fixture exited before consumption: ${errors}`); })]);
    child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
    const handle = await createSubagentInstanceRegistry({ root, retireSession: async () => {}, authorizeRecovery: async () => true,
      resolveOwner: async () => ({ state: "unavailable" }) }).open("conversation");
    await expect(handle.checkAcknowledgement("helper", request)).rejects.toMatchObject({ code: "subagent_recovery_already_consumed" });
    await expect(handle.reserve("helper", randomUUID(), request)).rejects.toMatchObject({ code: "subagent_recovery_already_consumed" });
    await expect(handle.checkAcknowledgement("helper", { ...request, message: "different" })).rejects.toMatchObject({ code: "subagent_recovery_ack_conflict" });
    await expect(handle.begin("helper")).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    await expect(handle.create({ ...spec, id: "bypass" })).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
  } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}, 15_000);
