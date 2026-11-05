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
  const f = suite.fixture, options = await runOptions(f, [], fault === "hang" ? 1500 : 15000);
  // Consumption requires an otherwise empty root; evidence belongs alongside it.
  const settingsPath = `${options.outputRoot}-settings.json`, witnessRoot = `${options.outputRoot}-witnesses`;
  await fs.mkdir(witnessRoot, { mode: 0o700 });
  await fs.writeFile(settingsPath, JSON.stringify({ runtimeRoot: ROOT, witnesses: witnessRoot, fault }), { mode: 0o600 });
  const env = { ...process.env, HOME: f.home, XDG_CACHE_HOME: f.home, XDG_CONFIG_HOME: f.home, XDG_DATA_HOME: f.home, XDG_STATE_HOME: f.home,
    LOOKUP_BOUNDARY_SETTINGS: settingsPath, OPENAI_API_KEY: "FICTIONAL-MUST-NOT-REACH-PREPARATION", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }; delete env.NODE_OPTIONS;
  const child = fork(fileURLToPath(new URL("./fixtures/lookup-preparation-driver.mjs", import.meta.url)), [], { cwd: f.repo, env,
    execArgv: ["--import", fileURLToPath(new URL("./fixtures/lookup-preparation-preload.mjs", import.meta.url))], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", b => { stderr += b; });
  const exit = new Promise(resolve => child.once("close", resolve)); children.push({ child, exit });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error(`fixture_deadline ${stderr.slice(-1000)}`)); }, 45000);
    child.on("message", m => { if (m.loaded) child.send({ repo: f.repo, options }); else { clearTimeout(timer); resolve(m); } });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); });
  });
  await exit;
  const allEvidence = await Promise.all((await fs.readdir(witnessRoot)).map(async file => JSON.parse(await fs.readFile(join(witnessRoot, file)))));
  const evidence = allEvidence.filter(e => e.isMainThread);
  for (const row of allEvidence) { expect(row.denied).toBe(2); expect(row.ci).toBe(Object.hasOwn(process.env, "CI")); }
  expect(result.failed, stderr).toBeUndefined(); return { ...result, evidence, options, driver: child.pid };
}
it("journals an exited preparation before a fresh verifier restores; only preparation builds", async () => {
  const r = await run(), p = r.state.slots[0].preparation;
  expect(r.reply, JSON.stringify(r.evidence)).toMatchObject({ verified: true, conversation: true });
  expect(p).toMatchObject({ exited: true }); expect(p.treeDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(p.pid).not.toBe(r.reply.pid); expect(p.pid).not.toBe(r.driver);
  expect(r.state.slots[0].holds).toEqual([]);
  const preparation = r.evidence.find(e => e.pid === p.pid), probe = r.evidence.find(e => e.pid === r.reply.pid);
  expect(preparation).toMatchObject({ preparing: true, credentialKeys: [], builds: 1, verify: "lookup_pilot_real_route_unavailable", mint: "lookup_pilot_real_route_unavailable" });
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
