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

it.each([1, 2, 3, 4, 5, 6, 8])("reconciles only after real SIGKILL before/after state revision %s", async revision => {
  const f = suite.fixture, c = await loadPilot(f, "controller");
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f);
    // The fault configuration is outside the bound output, which must initially be unused.
    const config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "lookup-pilot-controller.json"), revision, phase }), { mode: 0o600 });
    const process = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(process.reply).rejects.toMatchObject({code: "fixture_reply_missing"});
    expect((await process.exit).signal).toBe("SIGKILL");
    const path = join(options.outputRoot, "lookup-pilot-controller.json");
    try {
      const state = JSON.parse(await fs.readFile(path)); expect(state.revision).toBe(phase === "after" ? revision : revision - 1);
      const report = await c.reconcileLookupPilot(options.outputRoot); expect(report.reconciliation).toBe(true);
      await expect(c.createLookupPilotController(options)).rejects.toThrow();
    } catch (e) { if (revision !== 1 || phase !== "before" || e.code !== "ENOENT") throw e; }
  }
});

it.each(["authorization-consumed.json", "claim.json"])("burns authorization across before/after %s persistence crashes", async name => {
  const f = suite.fixture;
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f), key = createHash("sha256").update(LOOKUP_FAUX_AUTHORIZATION_DOMAIN + options.authorization.authorizationId).digest("hex");
    const path = name === "claim.json" ? join(f.base, ".lookup-faux-consumed-v1", key, name) : join(options.outputRoot, name);
    const config = join(f.base, `${options.authorization.authorizationId}.fault.json`); await fs.writeFile(config, JSON.stringify({ path, phase }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"}); expect((await p.exit).signal).toBe("SIGKILL");
    expect((await fs.lstat(join(f.base, ".lookup-faux-consumed-v1", key))).isDirectory()).toBe(true);
  }
});

it.each([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]])("keeps a conservative journal across before/after partial receipt persistence %j", async (admitted, consumed, settled) => {
  const f = suite.fixture, c = await loadPilot(f, "controller"), first = c.lookupPilotSchedule(f.pilot)[0];
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "slots", `${first.slotId}.json`), phase, calls: { admitted, consumed, settled } }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"}); expect((await p.exit).signal).toBe("SIGKILL");
    const report = await c.reconcileLookupPilot(options.outputRoot);
    if (admitted) expect(report.cost.totalUSD).toBe(3.92);
    else expect(report.counts.admitted).toBe(0);
  }
});

it("reconciles before/after final report persistence without resuming", async () => {
  const f = suite.fixture, c = await loadPilot(f, "controller");
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f), path = join(options.outputRoot, "report.json"), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path, phase }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"}); expect((await p.exit).signal).toBe("SIGKILL");
    if (phase === "after") expect(JSON.parse(await fs.readFile(path)).stop).toBe("budget_admission");
    else await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await c.reconcileLookupPilot(options.outputRoot)).cost.totalUSD).toBe(3.92);
  }
});

it("preserves terminal journal status across before/after completed receipt persistence", async () => {
  const f = suite.fixture, c = await loadPilot(f, "controller"), first = c.lookupPilotSchedule(f.pilot)[0];
  for (const phase of ["before", "after"]) {
    const options = await runOptions(f, ["settled"]), path = join(options.outputRoot, "slots", `${first.slotId}.json`), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
    await fs.writeFile(config, JSON.stringify({ path, phase, calls: { admitted: 1, consumed: 1, settled: 1 }, terminal: "completed" }), { mode: 0o600 });
    const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"}); expect((await p.exit).signal).toBe("SIGKILL");
    expect(JSON.parse(await fs.readFile(path)).terminal).toBe(phase === "after" ? "completed" : null);
    expect((await c.reconcileLookupPilot(options.outputRoot)).counts.completed).toBe(1);
  }
});

it.each([["two_rounds", "refused_pre_send"], ["lost", "unadmitted"]])("reconciles a crash after %s admission refusal consistently with live classification", async (scenario, terminal) => {
  const f = suite.fixture, options = await runOptions(f, [scenario]), config = join(f.base, `refusal-crash-${scenario}.json`);
  await fs.writeFile(config, JSON.stringify({ path: join(options.outputRoot, "lookup-pilot-controller.json"), admissionRefusal: true, phase: "after" }), { mode: 0o600 });
  const p = await suite.spawn({ options }, { LOOKUP_FIXTURE_FAULT: config }); await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"}); expect((await p.exit).signal).toBe("SIGKILL");
  const c = await loadPilot(f, "controller"), report = await c.reconcileLookupPilot(options.outputRoot);
  expect(report.receipts.at(-1)).toMatchObject({ terminal, terminalCode: "budget_admission" });
  expect(report.counts).toMatchObject({ admitted: 1, incomplete: 1, invalid: 0, unadmitted: terminal === "unadmitted" ? 1 : 0 });
});

it("retains the original early driver rejection for a delayed reply consumer", async () => {
  const f = suite.fixture, options = await runOptions(f), config = join(f.base, `${options.authorization.authorizationId}.fault.json`);
  await fs.writeFile(config, JSON.stringify({path: join(options.outputRoot, "lookup-pilot-controller.json"), revision: 1, phase: "before"}), {mode: 0o600});
  const p = await suite.spawn({options}, {LOOKUP_FIXTURE_FAULT: config});
  expect((await p.exit).signal).toBe("SIGKILL");
  // Let Node's unhandled-rejection checkpoint run before attaching the consumer.
  await new Promise(resolve => setImmediate(resolve));
  await expect(p.reply).rejects.toMatchObject({code: "fixture_reply_missing"});
});
