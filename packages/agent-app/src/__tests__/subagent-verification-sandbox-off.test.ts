import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSandboxPolicy } from "@mono-agent/runtime-adapter";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
import { createSubagentRecoveryAccess } from "../subagent-recovery-access.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const spec = { id: "helper", name: "helper", systemPrompt: "Review", definition: { name: "helper", description: "Review", systemPrompt: "Review" } };

async function fixture(options: { engine?: "absent" | "unavailable"; service?: boolean; privateRoots?: readonly string[] } = {}) {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.verification-sandbox-off-")); roots.push(root);
  const parent = resolve(root, "workspace"); const workdir = resolve(parent, "work");
  await mkdir(resolve(workdir, ".git"), { recursive: true });
  const runProbe = vi.fn(async (): Promise<never> => { throw new Error("observation probe must not run without a sandbox"); });
  const access: Record<string, unknown> = { workspace: parent, readableRoots: [] as string[] };
  if (options.engine === "unavailable") {
    access.sandboxPolicy = createSandboxPolicy({ root: parent, mode: "native" });
    access.sandboxEngine = { id: "srt" as const, isAvailable: async () => false };
    access.runProbe = runProbe;
  }
  let verification: unknown;
  const service = {
    settings: { stateDir: root },
    inspectSubagentRecovery: async () => ({ verification }),
    recordSubagentObservation: async () => {},
  } as unknown as ProcessJobsServiceHandle;
  const ports = createSubagentRecoveryAccess({
    ...(options.service ? { service } : {}),
    privateRoots: async () => options.privateRoots ?? [],
    hostAccess: () => access,
  });
  const retireSession = vi.fn(async () => undefined);
  const registry = createSubagentInstanceRegistry({ root, retireSession, ...ports,
    ownerForReservation: (jobId) => ({ jobId, storeRoot: root }) });
  const handle = await registry.open("conversation");
  const file = resolve(subagentConversationRoot(root, "conversation"), "instances.json");
  const disk = async () => JSON.parse(await readFile(file, "utf8"));
  const rewrite = async (mutate: (records: any[]) => void) => {
    const records = await disk(); mutate(records); await writeFile(file, JSON.stringify(records));
  };
  return { root, parent, workdir, access, runProbe, ports, service, retireSession, registry, handle, file, disk, rewrite,
    noteVerification: (target: unknown) => { verification = target; } };
}

it.each(["absent", "unavailable"] as const)("closes a verification-bearing instance with no usable sandbox engine (%s)", async (engine) => {
  const f = await fixture({ engine });
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  await expect(f.handle.close(created.id, f.access)).resolves.toMatchObject({ status: "closed" });
  expect(f.retireSession).toHaveBeenCalled();
  expect(f.runProbe).not.toHaveBeenCalled();
});

it.each(["absent", "unavailable"] as const)("continues a verification-bearing instance with an ack and no usable sandbox engine (%s)", async (engine) => {
  const f = await fixture({ engine });
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  const turnToken = randomUUID();
  await f.rewrite((records) => {
    records[0].recovery = { turnToken, sequence: 1, reason: "timeout", continuity: "retained" };
  });
  const inspection = await f.handle.inspect(created.id, f.access);
  expect(inspection.ack).toBeTypeOf("string");
  const token = randomUUID();
  await expect(f.handle.reserve(created.id, token,
    { ack: inspection.ack!, message: "Verified independently; continue.", background: true }, f.access))
    .resolves.toMatchObject({ status: "queued", activeTurn: { token } });
  expect(f.runProbe).not.toHaveBeenCalled();
});

it("inspects honestly when observation is unavailable: no verification contract, no disclosed facts", async () => {
  const f = await fixture({ service: true });
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  const turnToken = randomUUID(); const jobId = randomUUID();
  const target = (await f.disk())[0].verificationTarget;
  f.noteVerification(target);
  await f.rewrite((records) => {
    records[0].recovery = { turnToken, sequence: 1, reason: "timeout", continuity: "retained" };
    records[0].ownerReceipt = { jobId, storeRoot: f.root, turnToken, sequence: 1, finalized: true, acknowledged: true };
  });
  const inspection = await f.handle.inspect(created.id, f.access);
  expect(inspection).toMatchObject({ status: "observation_unavailable", parentVerificationRequired: false });
  expect(inspection.ack).toBeUndefined();
  expect(inspection.facts).toMatchObject({ status: "observation_unavailable" });
  expect(inspection.facts).not.toHaveProperty("observation");
  expect(JSON.stringify(inspection)).not.toContain(f.workdir);
  expect(f.runProbe).not.toHaveBeenCalled();
});

it("reports a certified timeout resumable despite an observation gap, without bypassing policy", async () => {
  const f = await fixture({ service: true });
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  const turnToken = randomUUID(); const jobId = randomUUID();
  f.noteVerification((await f.disk())[0].verificationTarget);
  await f.rewrite((records) => {
    records[0].recovery = { turnToken, sequence: 1, reason: "timeout", continuity: "retained", certifiedTimeout: true };
    records[0].ownerReceipt = { jobId, storeRoot: f.root, turnToken, sequence: 1, finalized: true, acknowledged: true };
  });
  expect(await f.handle.inspect(created.id, f.access)).toMatchObject({ status: "ready", resumable: true,
    parentVerificationRequired: false, facts: { status: "observation_unavailable" } });
  const denied = await createSubagentInstanceRegistry({ root: f.root, retireSession: async () => {},
    ...createSubagentRecoveryAccess({ service: f.service, privateRoots: async () => [f.workdir], hostAccess: () => f.access }) }).open("conversation");
  await expect(denied.begin(created.id, undefined, undefined, f.access)).rejects.toMatchObject({ code: "subagent_recovery_policy_denied" });
  expect((await f.handle.get(created.id))?.recovery).toMatchObject({ certifiedTimeout: true });
  const resumed = await f.handle.begin(created.id, undefined, undefined, f.access);
  expect(resumed.recovery).toBeUndefined();
  await f.handle.finish(created.id, { status: "ok" });
  expect(f.runProbe).not.toHaveBeenCalled();
});

it("withholds verification observations without a working sandbox, and still denies a denied target", async () => {
  const f = await fixture({ engine: "unavailable" });
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  const target = (await f.disk())[0].verificationTarget;
  const subject = { conversationId: "conversation", instanceId: created.id, verification: target };
  await expect(f.ports.observeRecovery(subject, f.access)).resolves.toEqual({ status: "observation_unavailable" });
  const denied = createSubagentRecoveryAccess({ privateRoots: async () => [f.workdir], hostAccess: () => f.access });
  await expect(denied.observeRecovery(subject, f.access)).resolves.toEqual({ status: "observation_policy_denied" });
  expect(f.runProbe).not.toHaveBeenCalled();
});

it("still denies ack continuation for a policy-denied verification target", async () => {
  const f = await fixture();
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  const turnToken = randomUUID();
  await f.rewrite((records) => {
    records[0].recovery = { turnToken, sequence: 1, reason: "timeout", continuity: "retained" };
  });
  const inspection = await f.handle.inspect(created.id, f.access);
  expect(inspection.ack).toBeTypeOf("string");
  const denied = createSubagentInstanceRegistry({ root: f.root, retireSession: async () => {},
    ...createSubagentRecoveryAccess({ privateRoots: async () => [f.workdir], hostAccess: () => f.access }),
    ownerForReservation: (jobId) => ({ jobId, storeRoot: f.root }) });
  const deniedHandle = await denied.open("conversation");
  await expect(deniedHandle.reserve(created.id, randomUUID(),
    { ack: inspection.ack!, message: "next", background: true }, f.access))
    .rejects.toMatchObject({ code: "subagent_recovery_policy_denied" });
});

it("still refuses to close a busy verification-bearing instance", async () => {
  const f = await fixture();
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  await f.handle.begin(created.id);
  await expect(f.handle.close(created.id, f.access)).rejects.toThrow(/busy/u);
  await f.handle.finish(created.id, { status: "ok" });
  await expect(f.handle.close(created.id, f.access)).resolves.toMatchObject({ status: "closed" });
});

it("lets a successful managed turn self-close a verification-bearing instance without a sandbox", async () => {
  const f = await fixture();
  const created = await f.handle.create({ ...spec, verification: { workdir: f.workdir } }, f.access);
  const token = randomUUID();
  await f.handle.reserve(created.id, token);
  await f.handle.begin(created.id, token);
  await f.handle.publishOwned("confirm", { identity: { storeRoot: f.root, jobId: token, conversationId: "conversation",
    instanceId: created.id, instanceIncarnation: created.incarnation!, turnToken: token },
    sequence: 1, disposition: { status: "ok", continuity: "retained", closeAfterSuccess: true },
    released: true, outcome: { status: "ok" } });
  expect((await f.handle.get(created.id))?.status).toBe("closed");
});
