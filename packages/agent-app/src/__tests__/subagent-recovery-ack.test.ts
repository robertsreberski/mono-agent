import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
// @ts-expect-error Private kernel tool boundary.
import { createAgentSendTool } from "../../../agent-runtime/src/agent/tools/agent-send-tool.js";
// @ts-expect-error Real native engine; only provider transport is fake.
import { generatePiNativeResponse } from "../../../agent-runtime/src/ai/providers/pi-native.js";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
import { acquireContinuationStoreLock } from "../continuation-store-fs.js";
import type { SubagentOwnerIdentity } from "../subagent-registry-ownership.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const spec = { id: "helper", name: "helper", systemPrompt: "Review", definition: { name: "helper", description: "Review", systemPrompt: "Review" } };
async function fixture(continuity: "retained" | "lost" | "unknown" = "retained") {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.recovery-ack-")); roots.push(root);
  let allowed = true; let retireFailure: Error | undefined;
  const registry = createSubagentInstanceRegistry({ root, retireSession: async () => { if (retireFailure) throw retireFailure; },
    ownerForReservation: (jobId) => ({ jobId, storeRoot: root }), authorizeRecovery: async () => allowed,
    resolveOwner: async (identity) => ({ state: "released", identity, sequence: 7, continuity, reason: "timeout" }),
  });
  const handle = await registry.open("conversation"); const created = await handle.create(spec);
  const jobId = randomUUID(); await handle.reserve(spec.id, jobId); await handle.begin(spec.id, jobId);
  const identity: SubagentOwnerIdentity = { storeRoot: root, jobId, conversationId: "conversation", instanceId: spec.id, instanceIncarnation: created.incarnation!, turnToken: jobId };
  await handle.publishOwned("confirm", { identity, sequence: 7, disposition: { status: "timeout", reason: "timeout", continuity }, released: true });
  return { root, handle, registry, identity, deny: () => { allowed = false; }, failRetirement: (error: Error) => { retireFailure = error; }, file: resolve(subagentConversationRoot(root, "conversation"), "instances.json") };
}
it.each(["detached", "foreground", "registry", "read", "write", "parse"])("G11: real Pi AgentSend private-state failure cannot disclose paths or consume acknowledgement (%s)", async (mode) => {
  const detached = mode !== "foreground";
  const f = await fixture(); const owner = createMonoRuntime();
  if (!detached) { await f.handle.close(spec.id); await f.handle.create(spec); }
  const key = "cafe".repeat(16); const disk = JSON.parse(await readFile(f.file, "utf8")); disk[0].recoveryBinding.key = key;
  await writeFile(f.file, JSON.stringify(disk));
  const inspection = await f.handle.inspect(spec.id);
  const request = { id: spec.id, ...(detached ? { ack: inspection.ack! } : {}), message: "verified; continue", background: detached };
  const run = vi.fn(); const startInternal = vi.fn();
  const subagents = { instances: f.handle, run, backgroundSubagentController: { startInternal } };
  const directory = subagentConversationRoot(f.root, "conversation");
  const lock = ["read", "write"].includes(mode) ? undefined
    : await acquireContinuationStoreLock(mode === "registry" ? resolve(directory, "registry-lock") : resolve(directory, "turn-locks", spec.id));
  const backup = `${f.file}.g11-backup`;
  if (mode === "read") { await rename(f.file, backup); await mkdir(f.file); }
  if (mode === "write") await chmod(directory, 0o500);
  if (mode === "parse") await writeFile(f.file, `{\"${key}\":\"${f.root}\"`);
  try {
    const piPath = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
    const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(piPath);
    const model = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" };
    const faux = fauxProvider({ provider: model.provider, models: [{ id: model.model }], tokensPerSecond: undefined });
    const models = createModels(); models.setProvider(faux.provider); let input: any;
    faux.setResponses([fauxAssistantMessage([fauxToolCall("AgentSend", request)]),
      (value: any) => { input = value; return fauxAssistantMessage([fauxText("No continuation was started.")]); }]);
    const result = await generatePiNativeResponse("Use AgentSend once, do not retry refusal.", { model, cwd: f.root,
      sessionId: "privacy-parent", sessionKeepAlive: true, piSessionsRoot: resolve(f.root, "parent-sessions"),
      messages: [{ role: "user", content: "Attempt the explicit acknowledgement once." }], allowedTools: ["Agent", "AgentSend"], subagents,
      piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
    expect(result.error).toBeFalsy(); expect(input).toBeDefined();
    const toolMessage = input.messages.find((message: any) => message.role === "toolResult");
    expect(toolMessage?.isError).toBe(true);
    expect(JSON.stringify(input)).not.toContain(f.root); expect(JSON.stringify(input)).not.toContain(key);
    expect(JSON.stringify(toolMessage)).toContain("subagent_owner_unavailable");
    expect(run).not.toHaveBeenCalled(); expect(startInternal).not.toHaveBeenCalled();
  } finally {
    if (mode === "write") await chmod(directory, 0o700);
    if (mode === "read") { await rm(f.file, { recursive: true }); await rename(backup, f.file); }
    if (mode === "parse") await writeFile(f.file, JSON.stringify(disk));
    await lock?.release(); await owner.disposeAllSessions?.();
  }
  expect(JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding.consumed).toBeUndefined();
  if (detached) {
    const retry = mode === "parse" ? await f.handle.inspect(spec.id) : undefined;
    await expect(f.handle.reserve(spec.id, randomUUID(), { ack: retry?.ack ?? request.ack!, message: request.message, background: true })).resolves.toMatchObject({ status: "queued" });
  }
  else { await f.handle.begin(spec.id); await f.handle.finish(spec.id, { status: "ok" }); }
}, 10_000);

it("G11: abandoned foreground lock I/O failure is path-free at the real Pi AgentSend boundary", async () => {
  const f = await fixture(); const disk = JSON.parse(await readFile(f.file, "utf8")); const key = "dead".repeat(16);
  disk[0].status = "running"; disk[0].activeTurn = { token: randomUUID(), kind: "foreground", settlementPending: true };
  disk[0].recoveryBinding.key = key; delete disk[0].recovery; delete disk[0].ownerReceipt; delete disk[0].ownerLink; delete disk[0].reservation;
  await writeFile(f.file, JSON.stringify(disk));
  const turnLocks = resolve(subagentConversationRoot(f.root, "conversation"), "turn-locks"); await mkdir(turnLocks, { recursive: true });
  await rm(resolve(turnLocks, spec.id), { recursive: true, force: true }); await writeFile(resolve(turnLocks, spec.id), "not-a-directory");
  const run = vi.fn(); const startInternal = vi.fn(); const owner = createMonoRuntime(); let input: any;
  try {
    const piPath = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
    const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(piPath);
    const model = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" };
    const faux = fauxProvider({ provider: model.provider, models: [{ id: model.model }], tokensPerSecond: undefined }); const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("AgentSend", { id: spec.id, inspect: true })]),
      (value: any) => { input = value; return fauxAssistantMessage([fauxText("Unavailable.")]); }]);
    const result = await generatePiNativeResponse("Inspect once.", { model, cwd: f.root, sessionId: "abandoned-privacy", sessionKeepAlive: true,
      piSessionsRoot: resolve(f.root, "parent-sessions"), messages: [{ role: "user", content: "Inspect." }], allowedTools: ["Agent", "AgentSend"],
      subagents: { instances: f.handle, run, backgroundSubagentController: { startInternal } }, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
    expect(result.error).toBeFalsy(); expect(JSON.stringify(input)).not.toContain(f.root); expect(JSON.stringify(input)).not.toContain(key);
    expect(JSON.stringify(input)).toContain("subagent_owner_unavailable"); expect(run).not.toHaveBeenCalled(); expect(startInternal).not.toHaveBeenCalled();
  } finally { await owner.disposeAllSessions?.(); }
}, 10_000);

it("G11: required session retirement failure is path-free at the real Pi Agent boundary", async () => {
  const f = await fixture(); await f.handle.close(spec.id); const key = "face".repeat(16); f.failRetirement(new Error(`cleanup ${f.root}/${key}`));
  const run = vi.fn(); const owner = createMonoRuntime(); let input: any;
  try {
    const piPath = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
    const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(piPath);
    const model = { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" };
    const faux = fauxProvider({ provider: model.provider, models: [{ id: model.model }], tokensPerSecond: undefined }); const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("Agent", { name: "helper", persist: true, id: spec.id, prompt: "Continue once." })]),
      (value: any) => { input = value; return fauxAssistantMessage([fauxText("Unavailable.")]); }]);
    const result = await generatePiNativeResponse("Create once.", { model, cwd: f.root, sessionId: "retirement-privacy", sessionKeepAlive: true,
      piSessionsRoot: resolve(f.root, "parent-sessions"), messages: [{ role: "user", content: "Create." }], allowedTools: ["Agent", "AgentSend"],
      subagents: { instances: f.handle, definitions: [spec.definition], run }, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
    expect(result.error).toBeFalsy(); expect(JSON.stringify(input)).toContain("subagent_owner_unavailable");
    expect(JSON.stringify(input)).not.toContain(f.root); expect(JSON.stringify(input)).not.toContain(key); expect(run).not.toHaveBeenCalled();
  } finally { await owner.disposeAllSessions?.(); }
}, 10_000);
function requestWithoutId({ id: _id, ...request }: { id: string; ack: string; message: string; background: boolean }) { return request; }

it("G09: actual AgentSend rejects foreign-conversation and replaced-incarnation tokens without consuming or admitting", async () => {
  const f = await fixture(); const original = await f.handle.inspect(spec.id);
  const request = { id: spec.id, ack: original.ack!, message: "verified new instructions", background: true };
  const run = vi.fn(); const startInternal = vi.fn();
  const tool = (instances: typeof f.handle) => createAgentSendTool({ instances, run, backgroundSubagentController: { startInternal } });
  const foreign = await f.registry.open("foreign-conversation");
  const settle = async (handle: typeof f.handle, conversationId: string) => {
    const record = (await handle.get(spec.id))!; const token = randomUUID(); await handle.reserve(spec.id, token); await handle.begin(spec.id, token);
    await handle.publishOwned("confirm", { identity: { ...f.identity, conversationId, instanceIncarnation: record.incarnation!, jobId: token, turnToken: token },
      sequence: 7, disposition: { status: "timeout", reason: "timeout", continuity: "retained" }, released: true });
    return handle.inspect(spec.id);
  };
  await foreign.create(spec); const foreignInspection = await settle(foreign, "foreign-conversation");
  const foreignFile = resolve(subagentConversationRoot(f.root, "foreign-conversation"), "instances.json");
  const foreignBefore = JSON.parse(await readFile(foreignFile, "utf8"))[0].recoveryBinding;
  expect((await tool(foreign).execute("foreign", request)).details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_ack_stale" } });
  expect(JSON.parse(await readFile(foreignFile, "utf8"))[0].recoveryBinding).toEqual(foreignBefore);
  await expect(foreign.checkAcknowledgement(spec.id, { ...requestWithoutId(request), ack: foreignInspection.ack! })).resolves.toBeUndefined();
  await expect(f.handle.checkAcknowledgement(spec.id, requestWithoutId(request))).resolves.toBeUndefined();
  await f.handle.close(spec.id); const replacement = await f.handle.create(spec);
  expect(replacement.incarnation).not.toBe(f.identity.instanceIncarnation);
  const current = await settle(f.handle, "conversation"); const before = JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding;
  expect((await tool(f.handle).execute("replaced", request)).details).toMatchObject({ executed: false, recovery: { code: "subagent_recovery_ack_stale" } });
  expect(JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding).toEqual(before);
  await expect(f.handle.checkAcknowledgement(spec.id, { ...requestWithoutId(request), ack: current.ack! })).resolves.toBeUndefined();
  expect(run).not.toHaveBeenCalled(); expect(startInternal).not.toHaveBeenCalled();
});

it("G09: current/previous consumption markers compact; the third-oldest token stays stale through actual AgentSend", async () => {
  const f = await fixture(); const requests: { ack: string; message: string; background: boolean }[] = [];
  for (let index = 0; index < 3; index++) {
    const inspected = await f.handle.inspect(spec.id); const request = { ack: inspected.ack!, message: `verified continuation ${index}`, background: true }; requests.push(request);
    const token = randomUUID(); await f.handle.reserve(spec.id, token, request); await f.handle.begin(spec.id, token);
    await f.handle.publishOwned("confirm", { identity: { ...f.identity, jobId: token, turnToken: token }, sequence: 7,
      disposition: { status: "timeout", reason: "timeout", continuity: "retained" }, released: true });
  }
  const current = await f.handle.inspect(spec.id); const before = JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding;
  expect(before.consumed.token).toBe(requests[2]!.ack); expect(before.previous.token).toBe(requests[1]!.ack);
  expect(JSON.stringify(before)).not.toContain(requests[0]!.ack);
  const run = vi.fn(); const startInternal = vi.fn(); const send = createAgentSendTool({ instances: f.handle, run, backgroundSubagentController: { startInternal } });
  for (const [index, request] of requests.entries()) {
    expect((await send.execute(`old-${index}`, { id: spec.id, ...request })).details).toMatchObject({ executed: false,
      recovery: { code: index === 0 ? "subagent_recovery_ack_stale" : "subagent_recovery_already_consumed" } });
  }
  expect(JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding).toEqual(before);
  await expect(f.handle.checkAcknowledgement(spec.id, { ack: current.ack!, message: "still valid", background: true })).resolves.toBeUndefined();
  expect(run).not.toHaveBeenCalled(); expect(startInternal).not.toHaveBeenCalled();
});

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
it("does not consume a valid acknowledgement while the real turn lock is busy", async () => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id);
  const request = { ack: inspection.ack!, message: "next", background: true };
  const lock = await acquireContinuationStoreLock(resolve(subagentConversationRoot(f.root, "conversation"), "turn-locks", spec.id));
  try {
    await expect(f.handle.reserve(spec.id, randomUUID(), request)).rejects.toMatchObject({ code: "subagent_owner_unavailable" });
    expect(JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding.consumed).toBeUndefined();
  } finally { await lock.release(); }
  await expect(f.handle.reserve(spec.id, randomUUID(), request)).resolves.toMatchObject({ status: "queued" });
});
it("rejects a retained profile change after inspection before consuming the token", async () => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id);
  const disk = JSON.parse(await readFile(f.file, "utf8")); disk[0].systemPrompt = disk[0].definition.systemPrompt = "Different retained profile";
  await writeFile(f.file, JSON.stringify(disk));
  await expect(f.handle.reserve(spec.id, randomUUID(), { ack: inspection.ack!, message: "next", background: true })).rejects.toMatchObject({ code: "subagent_recovery_ack_stale" });
  expect(JSON.parse(await readFile(f.file, "utf8"))[0].recoveryBinding.consumed).toBeUndefined();
});
it.each([{ background: false }, { description: "changed purpose" }])("rejects conflicting consumed request semantics %j without another reservation", async (change) => {
  const f = await fixture(); const inspection = await f.handle.inspect(spec.id);
  const request = { ack: inspection.ack!, message: "next", background: true };
  const turnToken = randomUUID(); await f.handle.reserve(spec.id, turnToken, request);
  await expect(f.handle.checkAcknowledgement(spec.id, { ...request, ...change })).rejects.toMatchObject({ code: "subagent_recovery_ack_conflict" });
  expect(JSON.parse(await readFile(f.file, "utf8"))[0].activeTurn.token).toBe(turnToken);
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
