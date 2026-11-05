// Test-only inherited egress denial and precise durable-write crash injection.
import { Socket } from "node:net";
import fs from "node:fs";
import promises from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join, basename } from "node:path";
const startIdentity = pid => { try { return childProcess.execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const evidence = { startIdentity: startIdentity(process.pid), probes: [], descendants: [] };
let canaries = 0, unexpected = 0, checking = true;
const directory = process.env.LOOKUP_FIXTURE_WITNESSES;
const record = () => fs.writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({ canaries, unexpected, ci: process.env.CI ?? null, home: process.env.HOME, xdg: [process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_STATE_HOME], git: [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM], ...evidence }), { mode: 0o600 });
const deny = () => { if (checking) canaries++; else { unexpected++; record(); } throw new Error("fixture_egress_denied"); };
Socket.prototype.connect = deny; globalThis.fetch = async () => deny(); globalThis.WebSocket = class { constructor() { deny(); } };
try { await fetch("fictional-invalid-url"); } catch {}
try { Socket.prototype.connect.call({}, undefined); } catch {}
try { new WebSocket("fictional-invalid-url"); } catch {}
checking = false; record();
const fault = process.env.LOOKUP_FIXTURE_FAULT ? JSON.parse(fs.readFileSync(process.env.LOOKUP_FIXTURE_FAULT, "utf8")) : null;
const driver = process.argv[1]?.endsWith("lookup-pilot-driver.mjs"), probe = process.argv[1]?.endsWith("continuity-lookup-pilot-child.mjs");
// Alter only caller inputs in the real child; the guard itself is loaded unchanged.
if (probe && ["guard-model-switch", "guard-cache-key", "guard-after-hold"].includes(fault?.action)) registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith("/lookup-pilot-mechanics.mjs")) return loaded;
  const marker = fault.action === "guard-after-hold" ? "const result = await guarded.streamSimple" : "const guarded = guardedLookupModels";
  const injection = fault.action === "guard-cache-key" ? "delete contract.promptCacheKey;"
    : `${fault.action === "guard-after-hold" ? "if (round === 1) " : ""}resolvedSafety.config.runtime.session.modelSwitch = { enabled: true };`;
  const source = String(loaded.source); if (!source.includes(marker)) throw Error("fixture_guard_injection_missing");
  evidence.guardFaultInjected = true; record(); return { ...loaded, source: source.replace(marker, `${injection}\n    ${marker}`) };
} });
for (const method of ["rename", "link"]) {
  const original = promises[method];
  promises[method] = async (source, destination, ...args) => {
    if (driver && (fault?.action?.startsWith("persist-descendant") || fault?.action === "sticky-descendant-timeout") && basename(destination) === "lookup-pilot-controller.json"
      && (() => { const state = JSON.parse(fs.readFileSync(source, "utf8")); return state.slots.some(s => s.members?.length) || fault.action === "sticky-descendant-timeout" && state.stop === "lookup_worker_timeout"; })()) {
      evidence.memberPersistFailed = true; record(); throw Error("fictional_member_persist_failure");
    }
    let match = false;
    if (driver && fault && destination === fault.path) {
      const data = JSON.parse(fs.readFileSync(source, "utf8"));
      match = (fault.revision === undefined || data.revision === fault.revision)
        && (!fault.admissionRefusal || data.stop === "budget_admission" && data.slots?.some(s => s.admissionRefusal))
        && (fault.calls === undefined || JSON.stringify(data.calls) === JSON.stringify(fault.calls))
        && (fault.terminal === undefined || data.terminal === fault.terminal);
    }
    if (match && fault.action === "skip") { await promises.unlink(source); return; }
    if (match && fault.phase === "before") process.kill(process.pid, "SIGKILL");
    const value = await original(source, destination, ...args);
    if (match && fault.phase === "after") process.kill(process.pid, "SIGKILL");
    return value;
  };
}
if (probe && ["arrival", "arrival-persist", "arrival-receipt"].includes(fault?.action)) {
  const original = promises.open; let consumedReads = 0;
  promises.open = async (...args) => {
    const file = await original(...args);
    if (basename(args[0]) === "lookup-pilot-controller.json") {
      const read = file.readFile.bind(file);
      file.readFile = async (...options) => {
        const bytes = await read(...options), state = JSON.parse(bytes.toString());
        if (state.slots.some(s => s.lastAck?.result && s.holds.at(-1)?.consumed) && ++consumedReads === 2) {
          if (fault.action === "arrival") process.kill(process.ppid, "SIGKILL");
          else throw Object.assign(new Error("fictional_arrival_failure"), { code: fault.action === "arrival-persist" ? "lookup_persist_failed" : "lookup_receipt_invalid" });
        }
        return bytes;
      };
    }
    return file;
  };
}

// Intercept the incoming delivery, including real controller -> child acknowledgements.
let assignment, changedAck = false, foreignControllerStart, faultScenarios = [], queuedSettle, graceCallback;
const testFaultScenarios = ["die", "hang", "disconnect", "descendant"];
const deliverBoundary = () => {
  if (!queuedSettle || !graceCallback) return;
  const deliver = queuedSettle; queuedSettle = null;
  evidence.settleDeliveredBeforeGrace = true; record();
  deliver(); graceCallback(); graceCallback = null;
};
const schedule = globalThis.setTimeout;
if (driver && fault?.action === "settle-at-grace") globalThis.setTimeout = (callback, ms, ...args) => schedule(ms === 250 ? () => { graceCallback = () => callback(...args); deliverBoundary(); } : callback, ms, ...args);
const emit = process.emit.bind(process);
process.emit = (event, ...args) => {
  const a = args[0];
  if (driver && event === "message" && a?.options?.authorization?.scenarios) {
    controllerOutputRoot = a.options.outputRoot;
    faultScenarios = [...a.options.authorization.scenarios];
    a.options.authorization.scenarios = faultScenarios.map(s => testFaultScenarios.includes(s) ? "settled" : s);
  }
  if (probe && event === "message") {
    if (a?.pilot) {
      assignment = a;
      const kind = fault?.action?.startsWith("swap-") ? fault.action.slice(5) : null;
      if (kind === "cache") a.cacheKey = "foreign-cache-key";
      if (kind === "plan") a.plan.confirmation = "fictional-tamper";
      if (kind === "build" || kind === "role-build") a.roleRequest.build.outputSha256 = "0".repeat(64);
      if (kind === "role") a.roleRequest.binding.arm = "fictional-tamper";
      if (kind === "role-id") a.roleRequest.binding.id = "fictional-other-role";
      if (kind === "registration") a.roleRequest.binding.registrationSha256 = "0".repeat(64);
      if (kind === "descriptor") a.pilot.descriptor.deadlines.runDeadlineMs--;
      if (kind === "pid") a.index++;
      if (kind === "foreign-ppid") {
        foreignControllerStart = JSON.parse(fs.readFileSync(join(a.outputRoot, "lookup-pilot-controller.json"))).controller.startIdentity;
        Object.defineProperty(process, "ppid", { configurable: true, value: fault.foreignPid });
      }
      if (kind === "ppid") Object.defineProperty(process, "ppid", { configurable: true, value: 1 });
      if (kind === "epoch") a.epoch = "fictional-stale";
      if (kind === "debug") process.env.CONTINUITY_DEBUG = "";
      if (kind === "marker") fs.unlinkSync(join(a.outputRoot, "authorization-consumed.json"));
    }
    if (a?.type === "go") {
      if (fault?.action === "close-idle") {
        process.removeAllListeners("message"); process.on("message", () => {});
        void (async () => {
          const { createLookupPilotIPC } = await import(new URL("./continuity-lookup-ipc.mjs", pathToFileURL(process.argv[1])));
          const source = await createLookupPilotIPC(assignment), admission = { requestId: `${assignment.runId}:1`, slotId: assignment.slotId, round: 1, payloadDigest: "a".repeat(64), rmax: 3.92 };
          const permit = await source.admit(admission); source.close(); evidence.closeCodes = [];
          for (const call of [() => source.admit({ ...admission, round: 2, requestId: `${assignment.runId}:2` }), () => source.consume(permit, "a".repeat(64)), () => source.settle(permit, { kind: "lost" }, null, null), () => source.stop("lookup_auth_failure")]) {
            evidence.closeCodes.push(await Promise.race([Promise.resolve().then(call).then(() => "unexpected-success", e => e.code), new Promise(resolve => schedule(resolve, 100, "hung"))]));
          }
          record(); process.send({ type: "done", epoch: assignment.epoch, slotId: assignment.slotId, terminal: "lost", score: null }, () => process.disconnect());
        })(); return true;
      }
      if (fault?.action?.startsWith("descendant-timeout") || fault?.action === "descendant-disconnect" || ["persist-descendant-timeout", "persist-descendant-unproven", "sticky-descendant-timeout"].includes(fault?.action)) {
        // Keep the leader until controller SIGTERM, but never send done. The
        // descendant is ready to ignore TERM before disconnect/timeout can fire.
        const descendant = childProcess.spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.send({type:'descendant-ready'});setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
        setInterval(() => {}, 1000);
        descendant.once("message", m => {
          if (m?.type !== "descendant-ready") throw Error("fixture_descendant_not_ready");
          evidence.descendants.push({ pid: descendant.pid, startIdentity: startIdentity(descendant.pid) }); evidence.descendantWithoutDone = true; record();
          descendant.disconnect(); descendant.unref();
          if (fault.action === "descendant-disconnect") process.disconnect();
        });
        return true;
      }
      if (assignment.scenario === "die") process.kill(process.pid, "SIGKILL");
      if (assignment.scenario === "hang") return true; // Keep the actual IPC child alive, withholding go.
      if (assignment.scenario === "disconnect") { process.disconnect(); return true; }
    }
    if (a?.type === "ack" && !changedAck && fault?.action?.startsWith("ack-tamper")) {
      changedAck = true; evidence.tamperedAck = true; record();
      if (fault.action === "ack-tamper-permit") a.result.permitId = "fictional-wrong-permit";
      else a.revision++;
    }
  }
  return emit(event, ...args);
};
let probePid, controllerOutputRoot;
const fork = childProcess.fork;
childProcess.fork = (...args) => {
  const options = args[2];
  args[2] = { ...options, execArgv: ["--import", new URL(import.meta.url).pathname],
    env: { ...options.env, LOOKUP_FIXTURE_WITNESSES: directory, ...(process.env.LOOKUP_FIXTURE_FAULT ? { LOOKUP_FIXTURE_FAULT: process.env.LOOKUP_FIXTURE_FAULT } : {}) } };
  const child = fork(...args);
  if (args[0].endsWith("continuity-lookup-pilot-child.mjs")) {
    probePid = child.pid; evidence.probes.push({ pid: child.pid, startIdentity: startIdentity(child.pid) }); record(); const send = child.send.bind(child), deliver = child.emit.bind(child);
    child.emit = (event, ...rest) => {
      if (event === "message" && rest[0]?.op === "settle" && fault?.action === "settle-at-grace") {
        queuedSettle = () => deliver(event, ...rest); deliverBoundary(); return true;
      }
      return deliver(event, ...rest);
    };
    child.send = (a, ...rest) => { if (a.pilot && testFaultScenarios.includes(faultScenarios[a.index])) a.scenario = faultScenarios[a.index]; return send(a, ...rest); };
  }
  return child;
};
const exec = childProcess.execFileSync;
childProcess.execFileSync = (command, args, ...rest) => {
  if (probe && fault?.action === "swap-foreign-ppid" && command === "/bin/ps" && args[1] === String(fault.foreignPid)) {
    evidence.foreignIdentityProvided = true; record(); return foreignControllerStart;
  }
  if (probe && ["swap-parent-start", "swap-null-parent-start"].includes(fault?.action) && command === "/bin/ps" && args[1] === String(process.ppid)
    && new Error().stack.split("\n")[3]?.includes("at verifyLookupPilotParent")) {
    evidence.swappedParentStart = true; record(); return fault.action === "swap-parent-start" ? "fictional-start-identity" : "";
  }
  if (driver && fault?.action === "identity-before-exit" && command === "/bin/ps" && args[1] === String(probePid) && new Error().stack.includes("containOwned")) {
    // Fixture owns this exact PID: make the leader disappear after the live-group snapshot.
    process.kill(probePid, "SIGKILL");
    for (let i = 0; i < 20; i++) { try { if (exec("ps", ["-p", String(probePid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z")) break; } catch { break; } }
    evidence.leaderExitedAtCheck = true; record(); return "";
  }
  if (driver && fault?.action?.startsWith("identity-before-") && command === "/bin/ps" && args[1] === String(probePid) && new Error().stack.includes("containOwned")
    && (fault.action === "identity-before-term" || evidence.signals?.includes("SIGTERM"))) { evidence.identityRefused = true; record(); return fault.action === "identity-before-gone" ? "" : "fictional-reused-start"; }
  if (driver && (fault?.action === "descendant-unproven" || ["descendant-timeout-unproven", "persist-descendant-unproven"].includes(fault?.action) && evidence.signals?.includes("SIGTERM")) && command === "/bin/ps" && args.includes("-axo") && new Error().stack.includes("containOwned")) { evidence.descendantUnproven = true; record(); return ""; }
  if (driver && fault?.action === "null-controller-start" && command === "/bin/ps") return "";
  if (driver && fault?.action === "terminate-fail" && command === "ps" && args.includes("-axo") && probePid) return `${probePid} ${probePid} S\n`;
  return exec(command, args, ...rest);
};
if (probe) {
  const send = process.send.bind(process); let changed = false;
  process.send = (m, ...args) => {
    if (m.op === "settle" && fault?.action === "settle-at-grace") { m.payload.rawUsage = { input_tokens: 100, output_tokens: 10 }; m.payload.tier = "default"; }
    if (m.type === "done" && fault?.action === "forge-terminal") m.terminal = fault.terminal;
    if (m.op === "stop") { evidence.stopSentAt = Date.now(); record(); }
    if (m.type === "done" && (fault?.action === "stop-hang" || fault?.action?.startsWith("identity-before-"))) return true;
    if (m.type === "done" && assignment?.scenario === "descendant") {
      const descendant = childProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", env: process.env });
      evidence.descendants.push({ pid: descendant.pid, startIdentity: startIdentity(descendant.pid) }); record(); descendant.unref();
      evidence.descendantNoDelay = true; record();
    }
    if (!changed && fault?.action?.startsWith("wire-") && m.version === "lookup-pilot-ipc-v1" && (fault.action !== "wire-digest" || m.op === "consume")) {
      changed = true;
      if (fault.action === "wire-stale") m.epoch = "fictional-stale";
      if (fault.action === "wire-order") m.seq++;
      if (fault.action === "wire-digest") m.payload.bodyDigest = "0".repeat(64);
      if (fault.action === "wire-duplicate") send(m);
    }
    return send(m, ...args);
  };
  if (fault?.action === "stop-hang" || fault?.action?.startsWith("identity-before-")) process.on("message", () => {});
  if (fault?.action?.startsWith("identity-before-")) { setInterval(() => {}, 1000); process.on("SIGTERM", () => {}); }
  if (fault?.action === "stop-hang") process.on("SIGTERM", () => { evidence.terminatedAt = Date.now(); record(); process.exit(0); });
}
if (driver && fault?.action === "settle-at-grace") {
  const open = promises.open; let delayed = false;
  promises.open = async (...args) => {
    const file = await open(...args);
    if (!delayed && evidence.settleDeliveredBeforeGrace && basename(args[0]) === "lookup-pilot-controller.json") {
      delayed = true; const read = file.readFile.bind(file);
      file.readFile = async (...rest) => { evidence.settleCheckPending = true; record(); await new Promise(resolve => schedule(resolve, 80)); return read(...rest); };
    }
    return file;
  };
}
if (driver) {
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (pid < 0 && signal !== 0) {
      (evidence.signals ??= []).push(signal);
      const state = JSON.parse(fs.readFileSync(join(controllerOutputRoot, "lookup-pilot-controller.json")));
      (evidence.stopAtSignals ??= []).push(state.stop);
      (evidence.membersAtSignals ??= []).push(state.slots.find(s => s.worker?.pid === probePid)?.members ?? []);
      if (signal === "SIGKILL") { try { evidence.leaderExitedBeforeKill = exec("ps", ["-p", String(probePid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z"); } catch { evidence.leaderExitedBeforeKill = true; } }
      record();
      if (fault?.action === "identity-before-signal-exit") {
        kill(probePid, "SIGKILL");
        for (let i = 0; i < 20; i++) { try { if (exec("ps", ["-p", String(probePid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z")) break; } catch { break; } }
        evidence.signalRacedExit = true; record(); throw Object.assign(new Error("fictional_signal_race"), { code: "EPERM" });
      }
    }
    return kill(pid, signal);
  };
}
// Pause a real child after its grant, before consume is ever sent (or after consume ACK).
if (probe && ["timeout-before-consume", "timeout-after-consume", "close-idle"].includes(fault?.action)) {
  const originalEmit = process.emit.bind(process);
  process.emit = (event, ...args) => {
    const m = args[0];
    if (event === "message" && m?.type === "ack" && ((fault.action === "timeout-before-consume" && m.result?.permitId) || (fault.action === "timeout-after-consume" && m.seq === 1))) {
      evidence.timeoutBoundary = fault.action; record(); return true;
    }
    return originalEmit(event, ...args);
  };
}
syncBuiltinESMExports();

// Old tests prove journal/IPC fault mechanics only, not configured preparation/replay.
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith("/continuity-lookup-pilot-probe.mjs")) return { ...loaded,
    source: `export { runLookupConfiguredProbe } from ${JSON.stringify(new URL("./lookup-pilot-mechanics.mjs", import.meta.url).href)};` };
  if (!url.endsWith("/continuity-runner.mjs")) return loaded;
  return { ...loaded, source: String(loaded.source).replace("export async function productionModules(", "async function unusedMechanicsModules(").replace("export async function buildCheckpoint(", "async function unusedMechanicsCheckpoint(") + `
    export async function productionModules() { return {}; }
    export async function buildCheckpoint({ dir, trace }) {
      const work = join(dir, "work"), snapshot = join(dir, "snapshot");
      await mkdir(work, { recursive: true }); await mkdir(snapshot, { recursive: true });
      await writeFile(join(snapshot, "fictional.txt"), "Fictional mechanics.", {mode: 0o600});
      return {work, snapshot, record: {conversationId: "fictional-mechanics"}};
    }` };
} });
