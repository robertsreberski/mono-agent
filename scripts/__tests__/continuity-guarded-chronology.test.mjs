// Real durable journals and owned idle fixture processes; all inference is scripted in memory.
import { expect } from "vitest";
import { readFile, mkdir, unlink, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { pilotSuite, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
const suite = pilotSuite({ scoped: true }), it = suite.test;
const load = (f, name) => import(/* @vite-ignore */ pathToFileURL(join(f.repo, "scripts/lib", `continuity-guarded-${name}.mjs`)).href);
async function kernel(id, capUSD = 3.92) {
  const f = suite.fixture, options = await runOptions(f);
  options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD;
  if (id === "fictional") {
    const sha = "a".repeat(64);
    options.pilot = { descriptor: options.pilot.descriptor, schedule: [0, 1].map(n => ({ slotId: digest(["fictional", n]), roleId: "fictional-reader", code: "fiction", suite: "fictional", traceId: "source", probeId: String(n), eligible: true })), publicState: { roleCount: 1, publicSources: { fictional: sha }, publicBindings: { fiction: { revision: "b".repeat(40), buildSha256: sha, protocolSha256: sha } } } };
    options.authorization.schema = "fictional-faux-authorization-v1";
  }
  options.authorization.pilotSha256 = digest(options.pilot);
  const protocol = (await load(f, "protocols")).guardedProtocol(id);
  const core = (await load(f, "controller")).guardedController(id);
  const journal = await core.createLookupPilotController(options); suite.cleanup(() => journal.release());
  const idle = await suite.spawn({ mode: "idle" }), worker = await idle.reply;
  await journal.assign(0, worker);
  return { f, id, protocol, core, journal, worker, idle, options, seq: 0 };
}
async function exchange(k, op, payload) {
  const state = k.journal.snapshot(), slotId = state.slots[state.cursor].slotId;
  return k.journal.message(state.cursor, k.worker, { version: k.protocol.policy.PILOT_IPC, epoch: state.epoch, slotId, seq: k.seq++, op, payload });
}
const disk = k => readFile(join(k.options.outputRoot, k.protocol.journal)).then(JSON.parse);
async function admit(k) {
  const state = k.journal.snapshot();
  return (await exchange(k, "admit", { requestId: `${state.runId}:1`, slotId: state.slots[state.cursor].slotId, round: 1, payloadDigest: "a".repeat(64), rmax: 3.92 })).result;
}
async function wrapped(k, { double = false, rejection = false, gate } = {}) {
  const models = (await load(k.f, "models")).guardedModels(k.id), timeline = [];
  const permit = { testOnly: true,
    async admit(request) { const ack = await exchange(k, "admit", request); expect((await disk(k)).slots[0].holds[0].consumed).toBe(false); timeline.push("reservation-ack"); return ack.result; },
    async consume(grant, bodyDigest) { await exchange(k, "consume", { permit: grant, bodyDigest }); expect((await disk(k)).slots[0].holds[0].consumed).toBe(true); timeline.push("consume-ack"); },
    async settle(grant, outcome, rawUsage, tier) { await exchange(k, "settle", { permit: grant, outcome, rawUsage, tier }); timeline.push("settlement-ack"); },
    stop: code => k.journal.stop(code),
  };
  const contract = { ...k.protocol.policy.GUARD_CONTRACT, runId: k.journal.snapshot().runId, slotId: k.journal.snapshot().slots[0].slotId };
  const model = { provider: contract.provider, id: contract.model, api: contract.api, baseUrl: contract.baseUrl };
  let sends = 0;
  const send = async () => { expect((await disk(k)).slots[0].holds[0].consumed).toBe(true); timeline.push("send"); sends++; if (rejection) throw Error("fictional_send_rejected"); return new Response(""); };
  const underlying = { streamSimple(_model, _context, options) {
    const result = (async () => {
      const payload = await options.onPayload({ model: contract.model, store: false, stream: true, reasoning: { effort: contract.effort }, input: [{ role: "user", content: "Fictional request." }] }, model);
      if (gate) await gate;
      await options.fetch(`${contract.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(payload) });
      if (double) await options.fetch(`${contract.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(payload) });
      await options.onProviderStreamEvent({ type: "response.completed", response: { service_tier: "default", usage: { input_tokens: 1, output_tokens: 1 } } }, model);
      return { stopReason: "stop", content: [{ type: "text", text: "Fictional answer." }] };
    })();
    return { result: () => result, async *[Symbol.asyncIterator]() { yield { type: "done", message: await result }; } };
  } };
  const proxy = models.guardedLookupModels(underlying, { contract, permit, send });
  return { call: () => proxy.streamSimple(model, {}, { reasoning: contract.effort, transport: "sse", maxRetries: 0 }).result(), timeline, sends: () => sends };
}
for (const id of ["lookup-pilot", "fictional"]) {
  it(`${id}: reserves durably, serializes one live request and consumes before the sole send`, async () => {
    const k = await kernel(id); let release; const gate = new Promise(resolve => { release = resolve; });
    const stream = await wrapped(k, { gate }), result = stream.call();
    expect(() => stream.call()).toThrow(k.protocol.codes.concurrent_request);
    release(); await result;
    expect(stream.timeline).toEqual(["reservation-ack", "consume-ack", "send", "settlement-ack"]);
    expect(stream.sends()).toBe(1);
    expect((await disk(k)).slots[0].holds[0]).toMatchObject({ reservedUnits: "78400000", consumed: true, settlement: { kind: "settled", knownUnits: "240" } });
  });
  it(`${id}: refuses a second send, persists a sticky integrity stop and never retries`, async () => {
    const k = await kernel(id), stream = await wrapped(k, { double: true });
    await expect(stream.call()).rejects.toThrow(k.protocol.codes.permit_invalid);
    expect(stream.sends()).toBe(1); expect(() => stream.call()).toThrow(k.protocol.codes.stopped);
    expect((await disk(k)).stop).toBe(k.protocol.codes.permit_invalid);
    await k.journal.stop("completed"); expect((await disk(k)).stop).toBe(k.protocol.codes.permit_invalid);
  });
  it(`${id}: a rejected send is single-shot and carries the full lost liability into cap admission`, async () => {
    const k = await kernel(id), stream = await wrapped(k, { rejection: true });
    await expect(stream.call()).rejects.toThrow("fictional_send_rejected");
    expect(stream.sends()).toBe(1); expect(() => stream.call()).toThrow(k.protocol.codes.slot_terminal);
    expect((await disk(k)).slots[0].holds[0].settlement).toMatchObject({ kind: "lost", knownUnits: "0" });
    await k.journal.finish(0, "lost"); k.seq = 0; await k.journal.assign(1, k.worker);
    expect(await admit(k)).toEqual({ refused: true, code: "not_admitted_cap" });
    expect((await disk(k)).stop).toBe("budget_admission");
    const spend = (await load(k.f, "accounting")).guardedAccounting(id).accountRun(k.journal.snapshot().slots);
    expect(spend).toMatchObject({ totalUnits: "78400000", retainedUnits: "78400000", activeUnits: "0", knownPartialUnits: "0" });
  });
  it(`${id}: writes both exclusive consumption markers and never consumes the same id into another root`, async () => {
    const k = await kernel(id), marker = JSON.parse(await readFile(join(k.options.outputRoot, "authorization-consumed.json")));
    const key = createHash("sha256").update(k.protocol.fauxDomain + k.options.authorization.authorizationId).digest("hex");
    const registry = join(dirname(k.options.outputRoot), k.protocol.fauxRegistry, key);
    expect(await readdir(registry)).toEqual(["claim.json"]);
    expect(JSON.parse(await readFile(join(registry, "claim.json")))).toEqual(marker);
    expect(marker).toMatchObject({ schema: k.protocol.schemas.fauxConsumption, runId: k.journal.snapshot().runId, outputRoot: k.options.outputRoot });
    const outputRoot = join(dirname(k.options.outputRoot), randomUUID()); await mkdir(outputRoot, { mode: 0o700 });
    const replay = { ...k.options, outputRoot, authorization: { ...k.options.authorization, outputRoot } };
    await expect(k.core.createLookupPilotController(replay)).rejects.toThrow(k.protocol.codes.authorization_already_consumed);
    expect(await readdir(outputRoot)).not.toContain("authorization-consumed.json");
  });
  it(`${id}: reconciliation is read-only recovery, never repairs a missing marker or resends`, async () => {
    const k = await kernel(id), permit = await admit(k);
    await exchange(k, "consume", { permit, bodyDigest: "a".repeat(64) });
    await new Promise(resolve => { k.idle.child.once("exit", resolve); k.idle.child.kill("SIGTERM"); });
    await unlink(join(k.options.outputRoot, "authorization-consumed.json"));
    const before = await readFile(join(k.options.outputRoot, k.protocol.journal));
    const recovered = await k.core.reconcileLookupPilot(k.options.outputRoot);
    expect(recovered).toMatchObject({ reconciliation: true, unreconciledGroups: 0, stop: k.protocol.codes.recovery_only, cost: { totalUSD: 3.92 } });
    expect(await readFile(join(k.options.outputRoot, k.protocol.journal))).toEqual(before);
    expect(await readdir(k.options.outputRoot)).not.toContain("authorization-consumed.json");
    k.journal.release(); await expect(k.core.createLookupPilotController(k.options)).rejects.toThrow(k.protocol.codes.authorization_lease_invalid);
  });
}
