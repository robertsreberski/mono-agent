import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { fork, execFileSync } from "node:child_process";
import { lookupPreparationStats, LOOKUP_TREE_LIMITS } from "../lib/continuity-lookup-preparation.mjs";
import { lookupChildEnvironment, lookupChildImports } from "../lib/continuity-lookup-child-environment.mjs";
import { pilotProcessFixture, loadPilot } from "./fixtures/lookup-pilot-process.mjs";
const roots = [], children = [];
const temp = async () => { const p = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-preflight-test-"))); await fs.chmod(p, 0o700); roots.push(p); return p; };
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock("../lib/continuity-lookup-pilot-entry.mjs");
  for (const {child, exit} of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; }
  for (const p of roots.splice(0)) await fs.rm(p, {recursive: true, force: true});
});
it("counts sparse boundary-sized files without reading them and reports only rejection classes", async () => {
  const root = await temp();
  for (let i = 0; i < 8; i++) { const p = join(root, `fictional-${i}`); await fs.writeFile(p, "", {mode: 0o600}); await fs.truncate(p, LOOKUP_TREE_LIMITS.fileBytes); }
  expect(await lookupPreparationStats(root)).toEqual({fileCount: 8, totalBytes: LOOKUP_TREE_LIMITS.totalBytes, largestFileBytes: LOOKUP_TREE_LIMITS.fileBytes, rejectedEntries: []});
  await fs.truncate(join(root, "fictional-0"), LOOKUP_TREE_LIMITS.fileBytes + 1);
  await fs.link(join(root, "fictional-1"), join(root, "fictional-hardlink"));
  await fs.symlink(join(root, "fictional-1"), join(root, "fictional-symlink"));
  await fs.chmod(join(root, "fictional-2"), 0o622);
  const stats = await lookupPreparationStats(root), kinds = stats.rejectedEntries.map(e => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(["file_limit", "total_limit", "hard_link", "symbolic_link", "writable_mode"]));
  expect(JSON.stringify(stats)).not.toContain(root); expect(JSON.stringify(stats)).not.toContain("fictional-");
});
it("allowlists both child environments and carries only explicit import arguments", async () => {
  const home = await temp(), argv = process.execArgv;
  vi.stubEnv("OPENAI_API_KEY", "FICTIONAL-DENIED"); vi.stubEnv("NODE_OPTIONS", "FICTIONAL-DENIED"); vi.stubEnv("CI", ""); vi.stubEnv("CONTINUITY_DEBUG", "");
  const env = await lookupChildEnvironment(home);
  expect(env).toMatchObject({HOME: home, CI: "", CONTINUITY_DEBUG: ""}); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined();
  try { process.execArgv = ["--inspect", "--import", "fictional-preload", "--import=fictional-second", "--import", "./fictional preload.mjs", "--import=../fictional-second.mjs", "--loader", "fictional-forbidden"];
    expect(lookupChildImports()).toEqual(["--import", "fictional-preload", "--import=fictional-second", "--import", pathToFileURL(join(process.cwd(), "fictional preload.mjs")).href, "--import=" + pathToFileURL(join(process.cwd(), "..", "fictional-second.mjs")).href]);
  } finally { process.execArgv = argv; }
});
it("faux mint cannot accept a preflight state even with the real entry gate mocked open", async () => {
  const root = await temp(); await fs.writeFile(join(root, "lookup-pilot-controller.json"), JSON.stringify({schema: "lookup-preflight-controller-v1"}), {mode: 0o600});
  vi.resetModules(); vi.doMock("../lib/continuity-lookup-pilot-entry.mjs", () => ({assertLookupPilotEntry() {}}));
  const fetch = vi.fn(() => { throw Error("test_egress_denied"); }); vi.stubGlobal("fetch", fetch);
  const { createLookupFauxSend } = await import("../lib/continuity-lookup-faux-capability.mjs");
  await expect(createLookupFauxSend({outputRoot: root}, {})).rejects.toThrow("lookup_pilot_faux_required"); expect(fetch).not.toHaveBeenCalled();
});
it("runs full configured preparation for every scheduled slot, exits despite lingering handles and grants nothing", async () => {
  const f = await pilotProcessFixture({configured: true}); roots.push(f.base);
  const witnesses = join(f.base, "preflight-witnesses"), settings = join(f.base, "preflight-settings.json"); await fs.mkdir(witnesses, {mode: 0o700});
  await fs.writeFile(settings, JSON.stringify({runtimeRoot: f.repo, witnesses, configured: true, linger: true}), {mode: 0o600});
  const checkoutStatus = () => [f.repo, f.pack].map(root => execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {encoding: "utf8"}));
  expect(checkoutStatus()).toEqual(["", ""]);
  const before = await fs.readdir(f.base), preload = fileURLToPath(new URL("./fixtures/lookup-preparation-preload.mjs", import.meta.url));
  const env = {...await lookupChildEnvironment(f.home), LOOKUP_BOUNDARY_SETTINGS: settings};
  const child = fork(fileURLToPath(new URL("./fixtures/lookup-preflight-driver.mjs", import.meta.url)), [], {cwd: f.repo, env, execArgv: ["--import", preload], stdio: ["ignore", "ignore", "pipe", "ipc"]});
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; }); const exit = new Promise(resolve => child.once("close", resolve)); children.push({child, exit});
  const reply = await new Promise((resolve, reject) => {
    let received = false; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("fixture_deadline")); }, f.pilot.descriptor.deadlines.runDeadlineMs + 60000);
    child.on("message", m => { if (m.loaded) child.send({repo: f.repo, pilot: f.pilot}); else { received = true; clearTimeout(timer); resolve(m); } });
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", () => { clearTimeout(timer); if (!received) reject(Error(`fixture_closed_without_result ${stderr.slice(-1000)}`)); });
  });
  await exit;
  expect(reply.failed, stderr).toBeUndefined(); expect(reply.result.feasible, JSON.stringify(reply.result)).toBe(true);
  const scheduled = (await loadPilot(f, "pilot-state")).lookupPilotSchedule(f.pilot);
  expect(reply.result.slots.map(s => s.slotId)).toEqual(scheduled.map(s => s.slotId));
  const rows = reply.result.slots; expect(rows).toHaveLength(scheduled.length); expect(rows.length).toBeGreaterThan(0);
  expect(rows.some(s => s.eligible === false)).toBe(true);
  for (const row of rows) { expect(row.fileCount).toBeGreaterThan(0); expect(row.totalBytes).toBeGreaterThan(0); expect(row.rejectedEntries).toEqual([]); expect(row.durationMs).toBeLessThanOrEqual(row.watchdogMs); }
  const evidence = await Promise.all((await fs.readdir(witnesses)).map(async file => JSON.parse(await fs.readFile(join(witnesses, file)))));
  const preparers = evidence.filter(e => e.preparing && e.isMainThread);
  expect(preparers).toHaveLength(rows.length);
  expect(evidence.filter(e => e.isMainThread && !e.preparing)).toHaveLength(1);
  expect(preparers.every(e => e.ppid === child.pid)).toBe(true);
  for (const e of preparers) { expect(e).toMatchObject({builds: 1, lingering: true, lastSent: "prepared", exitCode: 0, unexpected: 0}); expect(e.turns).toBe(e.registeredTurns); expect(e.turns).toBeGreaterThan(1); }
  expect(evidence.every(e => e.unexpected === 0 && e.denied === 2)).toBe(true);
  // No output or consumption markers appeared alongside the registered roots.
  expect(await fs.readdir(f.base)).toEqual(before);
  expect(checkoutStatus()).toEqual(["", ""]);
  expect(reply.result.timing).toMatchObject({runDeadlineMs: f.pilot.descriptor.deadlines.runDeadlineMs, probeTimeExcluded: true});
  expect(reply.result.timing.restoreMs).toBeGreaterThan(0);
}, 1080000);

it("keeps counting siblings after an unreadable metadata entry", async () => {
  const root = await temp(), bad = join(root, "b-unreadable");
  for (const name of ["a-before", "b-unreadable", "c-after"]) await fs.writeFile(join(root, name), "fictional", {mode: 0o600});
  const original = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(path => path === bad ? Promise.reject(Object.assign(Error("fictional"), {code: "EACCES"})) : original(path)); syncBuiltinESMExports();
  expect(await lookupPreparationStats(root)).toEqual({fileCount: 2, totalBytes: 18, largestFileBytes: 9, rejectedEntries: [{kind: "unreadable_entry", count: 1}]});
});
it("loads a relative explicit import from a different child checkout cwd", async () => {
  const parent = await temp(), child = await temp();
  await fs.writeFile(join(parent, "fictional preload.mjs"), "globalThis.fictionalPreload = true;", {mode: 0o600});
  const proc = {...process, cwd: () => parent, execArgv: ["--import=./fictional%20preload.mjs?owned=1"]}; vi.stubGlobal("process", proc);
  const forwarded = lookupChildImports();
  expect(forwarded).toEqual(["--import=" + pathToFileURL(join(parent, "fictional preload.mjs")).href + "?owned=1"]);
  const env = await lookupChildEnvironment(child);
  expect(() => execFileSync(proc.execPath, [...forwarded, "--input-type=module", "-e", "if (!globalThis.fictionalPreload) throw Error('not_loaded')"], {cwd: child, env})).not.toThrow();
});
