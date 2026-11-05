import { lookupAuthorizationArtifact } from "./fixtures/lookup-authorization-artifact.mjs";
import { expect } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pilotSuite, loadPilot, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_FAUX_AUTHORIZATION_DOMAIN } from "../lib/continuity-lookup-pilot.mjs";

const suite = pilotSuite({scoped: true}), it = suite.test;
async function kernel(capUSD = 100) {
  const f = suite.fixture, options = await runOptions(f);
  options.pilot = structuredClone(options.pilot); options.pilot.descriptor.capUSD = capUSD; options.authorization.pilotSha256 = digest(options.pilot);
  const c = await loadPilot(f, "controller"), journal = await c.createLookupPilotController(options); suite.cleanup(() => journal.release());
  const idle = await suite.spawn({ mode: "idle" }), worker = await idle.reply;
  await journal.assign(0, worker);
  return { journal, worker, options, seq: 0 };
}
const hash = "a".repeat(64);
async function message(k, op, payload, overrides = {}) {
  const s = k.journal.snapshot();
  return k.journal.message(s.cursor, k.worker, { version: "lookup-pilot-ipc-v1", epoch: s.epoch, slotId: s.slots[s.cursor].slotId, seq: k.seq++, op, payload, ...overrides });
}
async function admit(k, round = 1) {
  const s = k.journal.snapshot(); return (await message(k, "admit", { requestId: `${s.runId}:${round}`, slotId: s.slots[s.cursor].slotId, round, payloadDigest: hash, rmax: 3.92 })).result;
}
// Sequential cases: parallelism is supplied by Vitest files, never by a queue.

it("persists holds, one-time consumption, raw settlement and independent partial receipts before ACK", async () => {
  const k = await kernel(), permit = await admit(k), path = join(k.options.outputRoot, "lookup-pilot-controller.json");
  let disk = JSON.parse(await fs.readFile(path)); expect(disk.slots[0].holds[0].consumed).toBe(false);
  await message(k, "consume", { permit, bodyDigest: hash }); disk = JSON.parse(await fs.readFile(path)); expect(disk.slots[0].holds[0].consumed).toBe(true);
  await message(k, "settle", { permit, outcome: { kind: "settled", cost: .0003 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" });
  disk = JSON.parse(await fs.readFile(path)); expect(disk.slots[0].holds[0].settlement).toMatchObject({ kind: "settled", knownUnits: "6000" });
  const receipt = JSON.parse(await fs.readFile(join(k.options.outputRoot, "slots", `${disk.slots[0].slotId}.json`)));
  expect(receipt.calls).toEqual({ admitted: 1, consumed: 1, settled: 1 }); expect(disk.slots[0].terminal).toBeNull();
});

it("admits cap equality and persists a sticky cap refusal without readmission", async () => {
  const k = await kernel(3.92), permit = await admit(k);
  await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "lost" }, rawUsage: null, tier: null });
  await k.journal.finish(0, "lost"); k.seq = 0; await k.journal.assign(1, k.worker);
  expect(await admit(k)).toEqual({ refused: true, code: "not_admitted_cap" }); expect(k.journal.snapshot().stop).toBe("budget_admission");
});

it("accepts a priced integrity settlement after stop, without reopening admission", async () => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "stop", { code: "lookup_auth_failure" });
  await message(k, "settle", { permit, outcome: { kind: "integrity_stop", code: "lookup_output_envelope_violated" },
    rawUsage: { input_tokens: 272000, output_tokens: 1000000 }, tier: null });
  const s = k.journal.snapshot(); expect(s.stop).toBe("lookup_auth_failure"); expect(BigInt(s.slots[0].holds[0].settlement.knownUnits)).toBeGreaterThan(78400000n);
});

it("serializes a stop/grant race and rejects consumption after the stop", async () => {
  const k = await kernel(), grant = admit(k), stopped = k.journal.stop("lookup_quota_exhausted");
  const permit = await grant; await stopped;
  expect(k.journal.snapshot().slots[0].holds[0].revoked).toBe(true);
  await expect(message(k, "consume", { permit, bodyDigest: hash })).rejects.toThrow("lookup_permit_invalid");
});

it("retains independently priced partial usage even when the settlement claim lies", async () => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await expect(message(k, "settle", { permit, outcome: { kind: "settled", cost: 0 }, rawUsage: { input_tokens: 272000, output_tokens: 1000000 }, tier: null })).rejects.toThrow("lookup_hold_exceeded");
  expect(BigInt(k.journal.snapshot().slots[0].holds[0].settlement.knownUnits)).toBeGreaterThan(78400000n);
});

it("enforces the registered absolute run deadline before admission", async () => {
  const f = suite.fixture, options = await runOptions(f); options.pilot = structuredClone(options.pilot);
  options.pilot.descriptor.deadlines.runDeadlineMs = 1; options.authorization.pilotSha256 = digest(options.pilot);
  const c = await loadPilot(f, "controller"), journal = await c.createLookupPilotController(options); suite.cleanup(() => journal.release());
  const idle = await suite.spawn({ mode: "idle" }), worker = await idle.reply; await journal.assign(0, worker);
  const k = { journal, worker, options, seq: 0 }; expect(await admit(k)).toEqual({ refused: true, code: "lookup_stopped" });
  expect(journal.snapshot().stop).toBe("lookup_run_deadline");
});

it("derives a zero-hold refusal as unadmitted despite a worker lost claim", async () => {
  const k = await kernel(3.92), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "lost" }, rawUsage: null, tier: null }); await k.journal.finish(0, "lost");
  k.seq = 0; await k.journal.assign(1, k.worker); expect(await admit(k)).toMatchObject({ refused: true }); await k.journal.finish(1, "lost");
  expect(k.journal.snapshot().slots[1]).toMatchObject({ terminal: "unadmitted", admissionRefusal: "budget_admission" });
});

it.each(["settled", "lost", "own_abort_after_send"])("makes a non-null integrity code on %s a sticky protocol stop", async kind => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await expect(message(k, "settle", { permit, outcome: { kind, code: "lookup_payload_repeated" }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" })).rejects.toThrow("lookup_ipc_invalid");
  const s = k.journal.snapshot(); expect(s.stop).toBe("lookup_ipc_invalid"); expect(s.slots[0].holds[0].settlement).toMatchObject({ kind: "integrity_stop", knownUnits: "6000" });
  await k.journal.finish(0, "lost"); expect(k.journal.snapshot().slots[0].terminal).toBe("integrity_stop");
});

it("makes a valid integrity settlement sticky independently of a later stop message", async () => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "integrity_stop", code: "lookup_payload_repeated" }, rawUsage: null, tier: null });
  expect(k.journal.snapshot().stop).toBe("lookup_payload_repeated");
});

it.each(["lookup_auth_failure", "lookup_quota_exhausted", "lookup_account_mismatch"])("preserves %s across a retained-hold settlement and generic lost finish", async code => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "stop", { code });
  const path = join(k.options.outputRoot, "lookup-pilot-controller.json"); expect(JSON.parse(await fs.readFile(path)).stop).toBe(code);
  if (code === "lookup_account_mismatch") expect(JSON.parse(await fs.readFile(path)).slots[0].terminal).toBe("integrity_stop");
  await message(k, "settle", { permit, outcome: { kind: "lost" }, rawUsage: null, tier: null }); await k.journal.finish(0, "lost");
  expect(k.journal.snapshot().stop).toBe(code);
  expect(k.journal.snapshot().slots[0].terminal).toBe(code === "lookup_account_mismatch" ? "integrity_stop" : "lost");
  const receipt = JSON.parse(await fs.readFile(join(k.options.outputRoot, "slots", `${k.journal.snapshot().slots[0].slotId}.json`)));
  expect(receipt.costs.retainedUSD).toBe(3.92); expect(receipt.holds[0].retained).toBe(true);
});

it.each(["pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified"])("records %s as invalid rather than provider loss", async terminal => {
  const k = await kernel(), permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "settled", cost: .0003 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" });
  await k.journal.finish(0, terminal);
  const state = k.journal.snapshot(), { accountLookupPilot } = await loadPilot(suite.fixture, "pilot-accounting");
  expect(state.slots[0].terminal).toBe(terminal); expect(accountLookupPilot(state.slots)).toMatchObject({ invalid: 1, consecutiveProviderLosses: 0 });
  const receipt = JSON.parse(await fs.readFile(join(k.options.outputRoot, "slots", `${state.slots[0].slotId}.json`)));
  expect(receipt).toMatchObject({ terminal, terminalCode: terminal, score: null, costs: { completeUSD: .0003, retainedUSD: 0 } });
});

it("uses a frozen bound pilot for admission and settlement after caller mutation", async () => {
  const k = await kernel(), original = structuredClone(k.journal.pilot);
  k.options.pilot.descriptor.rmaxUSD = 0; k.options.pilot.descriptor.assumptions.inputMax = 0;
  k.options.pilot.registration.codes.R0.path = "/fictional/changed";
  expect(k.journal.pilot).toEqual(original); expect(Object.isFrozen(k.journal.pilot.descriptor.assumptions)).toBe(true);
  const permit = await admit(k); await message(k, "consume", { permit, bodyDigest: hash });
  await message(k, "settle", { permit, outcome: { kind: "settled", cost: .0003 }, rawUsage: { input_tokens: 100, output_tokens: 10 }, tier: "default" });
  expect(k.journal.snapshot().stop).toBeNull(); expect(k.journal.snapshot().slots[0].holds[0].settlement.kind).toBe("settled");
});
