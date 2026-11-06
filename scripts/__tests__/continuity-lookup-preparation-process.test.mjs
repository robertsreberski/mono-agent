import { beforeAll, afterEach, expect, it } from "vitest";
import { fork } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pilotSuite, runOptions } from "./fixtures/lookup-pilot-process.mjs";
import { ROOT } from "../lib/continuity-lookup-roles.mjs";
const suite = pilotSuite(), children = [];
beforeAll(async () => { const parent = join(suite.fixture.base, "node_modules/@modelcontextprotocol"); await fs.mkdir(parent, { recursive: true }); await fs.symlink(join(ROOT, "node_modules/@modelcontextprotocol/sdk"), join(parent, "sdk")); });
afterEach(async () => { for (const c of children.splice(0)) { if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL"); await c.exit; } });
async function run(fault) {
  const f = suite.fixture, options = await runOptions(f, [], fault === "hang" ? 1500 : fault === "lease-home" ? 120000 : 15000);
  if (fault === "lease-home") {
    const spaced = `${options.outputRoot} with space`; await fs.rename(options.outputRoot, spaced);
    options.outputRoot = options.authorization.outputRoot = spaced;
    options.pilot = structuredClone(options.pilot); options.pilot.descriptor.deadlines.runDeadlineMs = 180000;
    options.authorization.pilotSha256 = (await import("../lib/continuity-dataset.mjs")).digest(options.pilot);
  }
  // Consumption requires an otherwise empty root; evidence belongs alongside it.
  const settingsPath = `${options.outputRoot}-settings.json`, witnessRoot = `${options.outputRoot}-witnesses`;
  await fs.mkdir(witnessRoot, { mode: 0o700 });
  await fs.writeFile(settingsPath, JSON.stringify({ runtimeRoot: ROOT, witnesses: witnessRoot, fault, forbiddenCredential: `${settingsPath}-forbidden.json`, gateOpen: fault === "gate-open", fullReplay: fault === "lease-home" }), { mode: 0o600 });
  const env = { ...process.env, HOME: f.home, XDG_CACHE_HOME: f.home, XDG_CONFIG_HOME: f.home, XDG_DATA_HOME: f.home, XDG_STATE_HOME: f.home,
    LOOKUP_BOUNDARY_SETTINGS: settingsPath, OPENAI_API_KEY: "FICTIONAL-MUST-NOT-REACH-PREPARATION", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }; delete env.NODE_OPTIONS;
  const child = fork(fileURLToPath(new URL("./fixtures/lookup-preparation-driver.mjs", import.meta.url)), [], { cwd: f.repo, env,
    execArgv: ["--import", fileURLToPath(new URL("./fixtures/lookup-preparation-preload.mjs", import.meta.url))], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", b => { stderr += b; });
  const exit = new Promise(resolve => child.once("close", resolve)); children.push({ child, exit });
  let received = false;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error(`fixture_deadline ${stderr.slice(-1000)}`)); }, fault === "lease-home" ? options.pilot.descriptor.deadlines.runDeadlineMs + 30000 : 45000);
    child.on("message", m => { if (m.loaded) child.send({ repo: f.repo, options }); else { received = true; clearTimeout(timer); resolve(m); } });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); if (!received) reject(Error("fixture_closed_without_result")); });
  });
  await exit;
  const allEvidence = await Promise.all((await fs.readdir(witnessRoot)).map(async file => JSON.parse(await fs.readFile(join(witnessRoot, file)))));
  const evidence = allEvidence.filter(e => e.isMainThread);
  for (const row of allEvidence) { expect(row.credentialDenied).toBe(1); expect(row.unexpected).toBe(0); expect(row.denied).toBe(2); expect(row.ci).toBe(Object.hasOwn(process.env, "CI")); }
  if (!["listener-error", "verifier-close"].includes(fault)) expect(result.failed, stderr).toBeUndefined(); return { ...result, evidence, options, driver: child.pid };
}
it("journals an exited preparation before a fresh verifier restores; only preparation builds", async () => {
  const r = await run(), p = r.state.slots[0].preparation;
  expect(r.reply, JSON.stringify(r.evidence)).toMatchObject({ verified: true, conversation: true });
  expect(p).toMatchObject({ exited: true }); expect(p.treeDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(p.pid).not.toBe(r.reply.pid); expect(p.pid).not.toBe(r.driver);
  expect(r.state.slots[0].holds).toEqual([]);
  const preparation = r.evidence.find(e => e.pid === p.pid), probe = r.evidence.find(e => e.pid === r.reply.pid);
  expect(preparation).toMatchObject({ preparing: true, credentialKeys: [], builds: 1, verify: Object.hasOwn(process.env, "CI") ? "paid_mode_refused_in_ci" : "lookup_pilot_capability_invalid", mint: Object.hasOwn(process.env, "CI") ? "paid_mode_refused_in_ci" : "lookup_pilot_capability_invalid" });
  expect(probe.builds).toBe(0); expect(r.evidence).toHaveLength(3);
}, 60000);
it("refuses a digest changed between preparation exit and verifier launch", async () => {
  const r = await run("tamper"); expect(r.reply).toMatchObject({ refused: "lookup_preparation_invalid" }); expect(r.state.slots[0]).toMatchObject({ terminal: "unadmitted", holds: [] });
}, 60000);
it.each([["crash", "lookup_preparation_invalid"], ["hang", "lookup_preparation_timeout"]])("ends preparation %s as an unadmitted zero-hold slot", async (fault, stop) => {
  const r = await run(fault); expect(r.state.stop).toBe(stop); expect(r.state.slots[0]).toMatchObject({ terminal: "unadmitted", holds: [], worker: null });
  expect(r.reply).toBeUndefined(); expect(r.evidence.every(e => e.builds === 0)).toBe(true);
  if (fault === "hang") expect(r.pending).toEqual({ unreconciledGroups: 1, reconciliation: true, unchanged: true });
}, 60000);

it.each(["production-tamper", "production-restore"])("production probe reports sticky preparation failure for %s without holds", async fault => {
  const r = await run(fault);
  expect(r.reply).toEqual({ refused: "lookup_preparation_invalid" }); expect(r.state.stop).toBe("lookup_preparation_invalid");
  expect(r.state.slots[0]).toMatchObject({ holds: [], terminal: "unadmitted" });
}, 60000);
it("cannot mint/verify from the assigned preparation even with the entry gate mocked open", async () => {
  const r = await run("gate-open"), prep = r.evidence.find(e => e.preparing);
  expect(prep).toMatchObject({ gateOpen: true, fauxMint: "lookup_ipc_invalid", fauxVerify: "lookup_ipc_invalid" });
  expect(r.state.slots[0].holds).toEqual([]);
}, 60000);

it("production probe reacquires preparation's leftover lease-home without inheriting its owner", async () => {
  const r = await run("lease-home"), prep = r.evidence.find(e => e.preparing), probe = r.evidence.find(e => e.pid === r.reply.pid);
  expect(r.reply, JSON.stringify(r.evidence)).toMatchObject({ verified: true }); expect(prep.leftoverOwner).toBe(prep.pid);
  expect(Object.values(probe.snapshotReads).length).toBeGreaterThan(0); expect(Object.values(probe.snapshotReads).every(n => n === 2)).toBe(true);
  expect(probe.leaseOwners, JSON.stringify(r.evidence)).toEqual([probe.pid]); expect(probe.pid).not.toBe(prep.pid);
}, 240000);

it("preparation child reports its fixed failure before exiting with status one", async () => {
  const r = await run("prepare-failure"), prep = r.evidence.find(e => e.preparing);
  expect(prep).toMatchObject({lastSent: "preparation-failed", exitCode: 1});
  expect(r.state).toMatchObject({stop: "lookup_preparation_invalid"}); expect(r.state.slots[0]).toMatchObject({holds: [], worker: null});
}, 60000);

it.each([["listener-error", "fixture_listener_error"], ["verifier-close", "fixture_closed_without_result"]])("driver settles %s without a dangling child promise", async (fault, code) => {
  expect((await run(fault)).failed).toBe(code);
}, 60000);
it("process-test rejects close when no driver result arrived", async () => {
  await expect(run("driver-close")).rejects.toThrow("fixture_closed_without_result");
}, 60000);
