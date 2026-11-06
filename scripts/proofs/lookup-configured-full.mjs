// Explicit off-lane proof: never collected by the default *.test.mjs pattern.
import fs from "node:fs/promises";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fullConfiguredFixture } from "./fixtures/lookup-configured-fixture.mjs";
import { lookupDependencyWitness } from "../lib/continuity-proof-tooling.mjs";
const ROOT = await fs.realpath(fileURLToPath(new URL("../../", import.meta.url)));
const sha = data => createHash("sha256").update(data).digest("hex");
const git = args => execFileSync("git", ["-C", ROOT, ...args], {encoding: "utf8", env: {...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"}}).trim();
const json = async path => JSON.parse(await fs.readFile(path, "utf8"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function binding() {
  assert.equal(git(["status", "--porcelain=v1"]), "", "proof requires a clean committed source");
  const files = git(["ls-files", "-z", "--", "scripts"]).split("\0").filter(path => /\.(?:mjs|json|md)$/u.test(path));
  const scripts = await Promise.all(files.map(async path => [path, sha(await fs.readFile(join(ROOT, path)))]));
  return {sourceHead: git(["rev-parse", "HEAD"]), sourceTree: git(["rev-parse", "HEAD^{tree}"]), node: process.version, platform: process.platform, arch: process.arch, executableSha256: sha(await fs.readFile(process.execPath)), scripts};
}
const verify = process.argv.indexOf("--verify-evidence");
if (verify !== -1) {
  const evidence = await json(process.argv[verify + 1]); assert.deepEqual(evidence.binding, await binding(), "proof evidence invalidated by current tree/runtime");
  assert.deepEqual(evidence.dependencyWitness, await lookupDependencyWitness(ROOT), "installed dependency metadata changed");
  for (const row of evidence.dependenciesLoaded) {
    if (row.sha256 === null) await assert.rejects(fs.access(row.path), {code: row.absentCode ?? "ENOENT"});
    else assert.equal(sha(await fs.readFile(row.path)), row.sha256, `changed dependency: ${row.path}`);
  }
  console.log("lookup configured proof binding matches");
} else {
  if (process.env.LOOKUP_CONFIGURED_PROOF !== "full") throw Error("LOOKUP_CONFIGURED_PROOF=full is required; this proof never silently skips");
  assert.equal(process.version, "v24.18.0"); assert.equal(process.platform, "darwin", "approved subprocess policy is Darwin-specific");
  const sourceBinding = await binding(), depsBefore = await lookupDependencyWitness(ROOT);
  const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
  const cases = selected ? [selected] : ["rounds", "cap", "limit", "sdk", "empty", "tier", "kill", "late"];
  assert.ok(cases.every(name => ["smoke", "rounds", "cap", "limit", "sdk", "empty", "tier", "kill", "late"].includes(name)), "unknown proof case");
  const output = resolve(process.env.LOOKUP_PROOF_OUTPUT ?? join(ROOT, ".worklab-tmp/lookup-configured-full.json"));
  assert.ok(output.startsWith(join(ROOT, ".worklab-tmp/")), "evidence must remain in the owned ignored directory");
  const base = process.env.LOOKUP_PROOF_FIXTURE ? await fs.realpath(process.env.LOOKUP_PROOF_FIXTURE) : await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-configured-proof-")));
  let fixture, settingsPath = join(base, "fixture.json");
  if (process.env.LOOKUP_PROOF_FIXTURE) {fixture = await json(settingsPath); assert.deepEqual(fixture.sourceBinding, sourceBinding, "stale registered fixture");}
  else {fixture = await fullConfiguredFixture(ROOT, base); fixture.sourceBinding = sourceBinding; await fs.writeFile(settingsPath, JSON.stringify(fixture), {mode: 0o600});}
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[key] = fixture.home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1";
  const results = [], witnesses = [], dependenciesLoaded = new Map();
  let delivered = false;
  await fs.writeFile(`${output}.checkpoint`, JSON.stringify({base, sourceBinding, status: "fixture-built"}));
  const identity = await import(pathToFileURL(join(fixture.repo, "scripts/lib/continuity-process-identity.mjs")).href);
  const controller = await import(pathToFileURL(join(fixture.repo, "scripts/lib/continuity-lookup-controller.mjs")).href);
  const retained = await import(pathToFileURL(join(fixture.repo, "scripts/lib/continuity-lookup-preparation.mjs")).href);
  try {
    for (const name of cases) {
      const id = `${name}-${Date.now()}`, outputRoot = join(base, id), evidence = join(base, `${id}-witnesses`), home = join(base, `${id}-home`), resultPath = join(base, `${id}-result.json`), configPath = join(base, `${id}-config.json`);
      await fs.mkdir(outputRoot, {mode: 0o700}); await fs.mkdir(evidence); await fs.mkdir(home);
      await fs.writeFile(configPath, JSON.stringify({...fixture, case: name, outputRoot, result: resultPath}), {mode: 0o600});
      const policy = {mode: "configured", role: "controller", root: ROOT, home: await fs.realpath(userInfo().homedir), testHome: home, ownedRoot: base, evidence, outputRoot, codeRoots: [fixture.repo, fixture.pack], forkPaths: [fixture.repo, fixture.pack].flatMap(root => ["continuity-lookup-preparation-child.mjs", "continuity-lookup-pilot-child.mjs"].map(file => join(root, "scripts/lib", file)))};
      const preload = new URL("./fixtures/lookup-configured-preload.mjs", import.meta.url); preload.searchParams.set("policy", Buffer.from(JSON.stringify(policy)).toString("base64url"));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "CI", "CONTINUITY_DEBUG"].includes(key)));
      Object.assign(env, {HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"});
      const child = fork(fileURLToPath(new URL("./fixtures/lookup-configured-driver.mjs", import.meta.url)), [configPath], {cwd: fixture.repo, execArgv: ["--import", preload.href], env, stdio: ["ignore", "ignore", "pipe", "ipc"]});
      const stderr = []; child.stderr.on("data", bytes => stderr.push(bytes));
      const startedAt = Date.now(), exit = new Promise(resolve => child.once("close", (code, signal) => resolve({code, signal})));
      const watchdog = setTimeout(() => {child.kill("SIGKILL");}, name === "late" ? 2100000 : 360000);
      let outcome;
      try {outcome = await exit;} finally {clearTimeout(watchdog);}
      const errorLog = join(base, `${id}-stderr.log`); await fs.writeFile(errorLog, Buffer.concat(stderr));
      assert.equal(outcome.signal, name === "kill" ? "SIGKILL" : null, `case ${name} signal; inspect ${errorLog}`);
      if (name !== "kill") assert.equal(outcome.code, 0, `case ${name} exit; inspect ${errorLog}`);
      const value = await json(resultPath), statePath = join(outputRoot, "lookup-pilot-controller.json");
      if (name === "kill") {
        const before = sha(await fs.readFile(statePath)), state = await json(statePath), prior = state.slots.filter(s => s.worker).length;
        value.reconciliation = await controller.reconcileLookupPilot(outputRoot); assert.equal(sha(await fs.readFile(statePath)), before, "reconciliation wrote state");
        assert.equal(value.reconciliation.authorizedSpend, false); assert.ok(value.reconciliation.cost.totalUSD >= 3.92);
        assert.equal((await json(statePath)).slots.filter(s => s.worker).length, prior);
        // Cleanup is deliberately separate from read-only production reconciliation.
        const deadline = Date.now() + 120000;
        for (const slot of state.slots) for (const proc of [slot.preparation, slot.worker].filter(Boolean)) {
          while (identity.lookupProcessStartIdentity(proc.pid) === proc.startIdentity && Date.now() < deadline) await delay(100);
          if (identity.lookupProcessStartIdentity(proc.pid) === proc.startIdentity) {
            const group = identity.lookupProcessGroupSnapshot(proc.pid);
            assert.ok(group.some(p => p.pid === proc.pid && p.startIdentity === proc.startIdentity.replace(/\s+/gu, " ")));
            process.kill(-proc.pid, "SIGKILL");
          }
        }
        value.state = await json(statePath); value.cleanupMs = Date.now() - value.controllerKilledAt;
        value.finalReconciliation = await controller.reconcileLookupPilot(outputRoot); assert.equal(value.finalReconciliation.unreconciledGroups, 0);
        assert.equal(sha(await fs.readFile(statePath)), before);
      }
      const state = value.state;
      for (let i = 0; i < state.schedule.length; i++) if (["native", "native-soul"].includes(state.schedule[i].roleId)) {
        assert.equal(state.schedule[i].eligible, false); assert.equal(state.slots[i].preparation ?? null, null); assert.equal(state.slots[i].worker, null); assert.equal(state.slots[i].holds.length, 0);
        await assert.rejects(fs.access(join(outputRoot, "work", state.schedule[i].slotId)), {code: "ENOENT"});
      }
      assert.ok(value.arrivals.length > 0, "full configured path made no provider arrival");
      if (["smoke", "rounds"].includes(name)) assert.ok(state.slots.filter(s => s.worker).every(s => s.terminal === "wrong" && s.holds.every(h => h.settlement?.kind === "settled")));
      const keys = new Set(value.arrivals.map(a => a.slotId));
      for (const key of keys) {
        const arrivals = value.arrivals.filter(a => a.slotId === key);
        if (name === "rounds") {assert.equal(arrivals.length, 3); assert.ok(arrivals[2].priorToolOutputs >= 2);}
        if (["cap", "sdk", "empty", "tier", "late", "kill", "smoke"].includes(name)) assert.equal(arrivals.length, 1);
        if (name === "limit") assert.equal(arrivals.length, 10);
      }
      if (name === "cap") assert.ok(state.slots.some(s => s.guardRefusal === "not_admitted_cap"));
      if (name === "empty") assert.ok(state.slots.some(s => s.terminal === "pilot_empty_final_output"));
      if (name === "tier") assert.equal(state.stop, "lookup_unknown_tier");
      if (name === "late") {
        assert.equal(fixture.pilot.descriptor.deadlines.deadlineMs, 600000); assert.equal(value.lateAvailable, 1); assert.equal(value.lateAcceptedSettles, 0); assert.equal(state.stop, "lookup_worker_timeout");
        assert.equal(value.providerTerminalDelivered, 0); assert.ok(value.providerLateAvailableAt >= value.outerCompletedAt); assert.ok(value.arrivals[0].at < value.providerLateAvailableAt);
      }
      assert.ok(value.partials.every(p => p.qualityMeasured === false && p.authorizedSpend === false && p.cost.totalUSD >= 3.92));
      const rows = [];
      for (const file of await fs.readdir(evidence)) if (/^home-\d+-\d+\.json$/u.test(file)) {
        const witness = await json(join(evidence, file)); assert.equal(witness.processCanaries, 9); assert.deepEqual(witness.unexpected, []); assert.deepEqual(witness.denied, []); assert.deepEqual(witness.nonModuleReads, []);
        assert.equal(witness.globalFetchCalls, 0); assert.deepEqual(witness.git, ["/dev/null", "1"]); assert.ok(witness.databases.every(path => path.startsWith(base + "/")));
        if (["preparation", "probe"].includes(witness.role)) {assert.ok(witness.globalFetchSentinel); assert.ok(witness.xdg.every(path => path === witness.home));}
        for (const loaded of witness.loaded) {
          const path = fileURLToPath(loaded.url); if (path.startsWith(ROOT + "/node_modules/")) {assert.equal(sha(await fs.readFile(path)), loaded.sha256); dependenciesLoaded.set(path, {path, sha256: loaded.sha256});}
          if (path.startsWith(ROOT + "/packages/") && path.includes("/dist/")) throw Error("proof_loaded_unregistered_workspace_runtime");
        }
        for (const file of witness.codeReads) if (/\.(?:js|mjs|cjs|json|node)$/u.test(file)) {
          const path = join(ROOT, file); if (path.startsWith(ROOT + "/node_modules/")) {
            try {if ((await fs.lstat(path)).isFile()) dependenciesLoaded.set(path, {path, sha256: sha(await fs.readFile(path))});}
            catch (error) {if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; dependenciesLoaded.set(path, {path, sha256: null, absentCode: error.code});}
          }
        }
        rows.push(witness);
      }
      const main = rows.find(w => w.pid === child.pid && w.threadId === 0); assert.ok(main);
      const metrics = [];
      for (const [index, slot] of state.slots.entries()) if (slot.worker) {
        const preparation = rows.find(w => w.pid === slot.preparation.pid && w.threadId === 0), probe = rows.find(w => w.pid === slot.worker.pid && w.threadId === 0);
        assert.ok(preparation && probe, "missing per-process canary evidence");
        assert.ok(preparation.events.some(e => e.phase === "buildCheckpoint")); assert.ok(!probe.events.some(e => e.phase === "buildCheckpoint"));
        assert.equal(main.forks.filter(f => f.slotId === slot.slotId && f.role === "probe").length, 1);
        const forkRecord = main.forks.find(f => f.slotId === slot.slotId && f.role === "probe");
        assert.ok(forkRecord.preparation.exited); assert.equal(forkRecord.preparation.treeDigest, slot.preparation.treeDigest);
        assert.ok(probe.events.some(e => e.phase === "installTree" && e.path.startsWith(forkRecord.work)), "restore did not target original work root");
        assert.equal(preparation.httpCalls.filter(r => r.method === "tools/call").length, 64);
        const nativeSessions = [];
        for (const file of await fs.readdir(join(forkRecord.work, "../snapshot/sessions/journals"))) {
          const bytes = await fs.readFile(join(forkRecord.work, "../snapshot/sessions/journals", file)), rows = bytes.toString().trim().split("\n").map(line => JSON.parse(line)), header = rows[0];
          assert.equal(rows.filter(row => row.kind === "turn_start" && row.payload.identitySource === "host").length, 80);
          assert.equal(header.cwd, forkRecord.work);
          assert.ok(probe.events.some(event => event.nativeHeader?.id === header.id && event.nativeHeader.journalId === header.journalId && event.nativeHeader.cwd === header.cwd && event.nativeHeader.sha256 === sha(bytes)));
          nativeSessions.push({id: header.id, journalId: header.journalId, restoredAtOriginalRoot: true, hostReplayTurns: 80});
        }
        assert.ok(preparation.databases.some(path => path.includes("/checkpoint/lease-home/") && probe.databases.includes(path)), "leftover physical lease-home was not reused");
        const disk = await retained.lookupRetainedBytes(join(outputRoot, "work", slot.slotId));
        const observedOuterMs = value.outerCompletedAt == null ? null : value.outerCompletedAt - forkRecord.at;
        if (name === "late") {assert.ok(observedOuterMs >= 600000 && observedOuterMs < 630000); assert.ok(value.report.cost.totalUSD >= 3.92);}
        metrics.push({nativeSessions, observedOuterMs, probeDiskGrowthBytes: disk.workBytes - disk.snapshotBytes, slotId: slot.slotId, role: state.schedule[index].roleId, probeWallMs: probe.elapsedMs, peakRSSBytes: probe.peakRSSBytes, rssExactAtExit: !["late", "kill"].includes(name), retained: await retained.lookupRetainedBytes(join(outputRoot, "work", slot.slotId)), preparationToolCalls: preparation.httpCalls.filter(r => r.method === "tools/call").length});
      }
      const projected = structuredClone(value);
      for (const slot of projected.state.slots) if (slot.cacheKey) {slot.cacheAssignmentDigest = sha(slot.cacheKey); slot.cacheKey = "REDACTED";}
      witnesses.push(...rows); results.push({...projected, metrics, wallMs: Date.now() - startedAt});
      await fs.writeFile(`${output}.checkpoint`, JSON.stringify({base, sourceBinding, completed: results.map(r => r.case)}));
    }
    assert.deepEqual(await binding(), sourceBinding); assert.deepEqual(await lookupDependencyWitness(ROOT), depsBefore);
    const report = {schema: "lookup-configured-full-proof-v1", complete: !selected, ci: Object.hasOwn(process.env, "CI"), binding: sourceBinding, dependencyWitness: depsBefore, results, witnesses, dependenciesLoaded: [...dependenciesLoaded.values()], fixtureBuilds: fixture.commands, nativeTopology: "ineligible; no native dispatch; no admitted native proof", limits: ["JS API canary, not OS/native-I/O sandbox", "SQLite connection paths checked; SQL ATTACH/native loader not sandboxed", "kill-case RSS is last observed process high-water mark", "faux data/feasibility/provider usage, not evaluation or real authorization"]};
    await fs.writeFile(output, JSON.stringify(report), {mode: 0o600}); delivered = true; console.log(JSON.stringify({complete: report.complete, cases, output, base}));
  } catch (error) {
    await fs.writeFile(output, JSON.stringify({schema: "lookup-configured-full-proof-v1", complete: false, binding: sourceBinding, dependencyWitness: depsBefore, fixtureBase: base, results, witnesses, dependenciesLoaded: [...dependenciesLoaded.values()], failure: error.message}), {mode: 0o600});
    throw error;
  } finally {
    assert.deepEqual(await lookupDependencyWitness(ROOT), depsBefore);
    // Debug retains a source-bound fixture for investigation; full delivery cleans it.
    if (delivered && !selected && !process.env.LOOKUP_PROOF_KEEP) await fs.rm(base, {recursive: true, force: true});
  }
}
