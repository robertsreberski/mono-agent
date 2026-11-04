// Test-only inherited egress denial and precise durable-write crash injection.
import { Socket } from "node:net";
import fs from "node:fs";
import promises from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join, basename } from "node:path";
const evidence = {};
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
for (const method of ["rename", "link"]) {
  const original = promises[method];
  promises[method] = async (source, destination, ...args) => {
    let match = false;
    if (driver && fault && destination === fault.path) {
      const data = JSON.parse(fs.readFileSync(source, "utf8"));
      match = (fault.revision === undefined || data.revision === fault.revision)
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
if (probe && fault?.action === "arrival") {
  const original = promises.open; let consumedReads = 0;
  promises.open = async (...args) => {
    const file = await original(...args);
    if (basename(args[0]) === "lookup-pilot-controller.json") {
      const read = file.readFile.bind(file);
      file.readFile = async (...options) => {
        const bytes = await read(...options), state = JSON.parse(bytes.toString());
        if (state.slots.some(s => s.lastAck?.result && s.holds.at(-1)?.consumed) && ++consumedReads === 2) process.kill(process.ppid, "SIGKILL");
        return bytes;
      };
    }
    return file;
  };
}

// Intercept the incoming delivery, including real controller -> child acknowledgements.
let assignment, changedAck = false;
const emit = process.emit.bind(process);
process.emit = (event, ...args) => {
  const a = args[0];
  if (probe && event === "message") {
    if (a?.pilot) {
      assignment = a;
      const kind = fault?.action?.startsWith("swap-") ? fault.action.slice(5) : null;
      if (kind === "plan") a.plan.confirmation = "fictional-tamper";
      if (kind === "build" || kind === "role-build") a.roleRequest.build.outputSha256 = "0".repeat(64);
      if (kind === "role") a.roleRequest.binding.arm = "fictional-tamper";
      if (kind === "role-id") a.roleRequest.binding.id = "fictional-other-role";
      if (kind === "registration") a.roleRequest.binding.registrationSha256 = "0".repeat(64);
      if (kind === "descriptor") a.pilot.descriptor.deadlines.runDeadlineMs--;
      if (kind === "pid") a.index++;
      if (kind === "ppid") Object.defineProperty(process, "ppid", { configurable: true, value: 1 });
      if (kind === "epoch") a.epoch = "fictional-stale";
      if (kind === "debug") process.env.CONTINUITY_DEBUG = "";
      if (kind === "marker") fs.unlinkSync(join(a.outputRoot, "authorization-consumed.json"));
    }
    if (a?.type === "go") {
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
let probePid;
const fork = childProcess.fork;
childProcess.fork = (...args) => { const child = fork(...args); if (args[0].endsWith("continuity-lookup-pilot-child.mjs")) probePid = child.pid; return child; };
const exec = childProcess.execFileSync;
childProcess.execFileSync = (command, args, ...rest) => {
  if (probe && ["swap-parent-start", "swap-null-parent-start"].includes(fault?.action) && command === "/bin/ps" && args[1] === String(process.ppid)
    && new Error().stack.split("\n")[3]?.includes("at verifyLookupPilotParent")) {
    evidence.swappedParentStart = true; record(); return fault.action === "swap-parent-start" ? "fictional-start-identity" : "";
  }
  if (driver && fault?.action === "null-controller-start" && command === "/bin/ps") return "";
  if (driver && fault?.action === "terminate-fail" && command === "ps" && args.includes("-axo") && probePid) return `${probePid} ${probePid} S\n`;
  return exec(command, args, ...rest);
};
if (probe) {
  const send = process.send.bind(process); let changed = false;
  process.send = (m, ...args) => {
    if (m.op === "stop") { evidence.stopSentAt = Date.now(); record(); }
    if (m.type === "done" && fault?.action === "stop-hang") return true;
    if (m.type === "done" && assignment?.scenario === "descendant") childProcess.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", env: process.env }).unref();
    if (!changed && fault?.action?.startsWith("wire-") && m.version === "lookup-faux-ipc-v1" && (fault.action !== "wire-digest" || m.op === "consume")) {
      changed = true;
      if (fault.action === "wire-stale") m.epoch = "fictional-stale";
      if (fault.action === "wire-order") m.seq++;
      if (fault.action === "wire-digest") m.payload.bodyDigest = "0".repeat(64);
      if (fault.action === "wire-duplicate") send(m);
    }
    return send(m, ...args);
  };
  if (fault?.action === "stop-hang") process.on("message", () => {});
  if (fault?.action === "stop-hang") process.on("SIGTERM", () => { evidence.terminatedAt = Date.now(); record(); process.exit(0); });
}
syncBuiltinESMExports();
