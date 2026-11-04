// Test-only inherited egress denial and precise durable-write crash injection.
import { Socket } from "node:net";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, basename } from "node:path";
let canaries = 0, unexpected = 0, checking = true;
const directory = process.env.LOOKUP_FIXTURE_WITNESSES;
const record = () => fs.writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({ canaries, unexpected }), { mode: 0o600 });
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
        && (fault.calls === undefined || JSON.stringify(data.calls) === JSON.stringify(fault.calls));
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
syncBuiltinESMExports();

if (probe && fault?.action?.startsWith("swap-")) process.on("message", a => {
  if (!a.pilot) return;
  const kind = fault.action.slice(5);
  if (kind === "plan") a.plan.confirmation = "fictional-tamper";
  if (kind === "build") a.roleRequest.build.outputSha256 = "0".repeat(64);
  if (kind === "role") a.roleRequest.binding.arm = "fictional-tamper";
  if (kind === "pid") a.index++;
  if (kind === "epoch") a.epoch = "fictional-stale";
  if (kind === "debug") process.env.CONTINUITY_DEBUG = "";
  if (kind === "marker") fs.unlinkSync(join(a.outputRoot, "authorization-consumed.json"));
});
if (probe && fault?.action?.startsWith("wire-")) {
  const send = process.send.bind(process); let changed = false;
  process.send = (m, ...args) => {
    if (!changed && m.version === "lookup-faux-ipc-v1" && (fault.action !== "wire-digest" || m.op === "consume")) {
      changed = true;
      if (fault.action === "wire-stale") m.epoch = "fictional-stale";
      if (fault.action === "wire-order") m.seq++;
      if (fault.action === "wire-digest") m.payload.bodyDigest = "0".repeat(64);
      if (fault.action === "wire-duplicate") send(m);
    }
    return send(m, ...args);
  };
}
