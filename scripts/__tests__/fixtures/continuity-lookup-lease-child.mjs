// Test-only real-process lease witness. No credentials, authorization issuer or dispatch.
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let egressAttempts = 0, heldLease;
const deny = () => { egressAttempts++; throw new Error("test_egress_denied"); };
Socket.prototype.connect = deny;
globalThis.fetch = async () => deny();
globalThis.WebSocket = class { constructor() { deny(); } };
try { await globalThis.fetch("https://fictional-egress.invalid"); } catch {}
const egressDenied = egressAttempts === 1;
egressAttempts = 0;

process.once("message", async input => {
  try {
    const load = name => import(pathToFileURL(join(input.moduleRoot, "scripts/lib", `${name}.mjs`)).href);
    const { lookupProcessStartIdentity } = await load("continuity-process-identity");
    const controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
    let value;
    if (input.mode === "hold") {
      const { acquireLookupPilotLease } = await load("continuity-lookup-lease");
      heldLease = await acquireLookupPilotLease(input.outputRoot);
      process.on("message", () => {}); // Keep the attached controller alive until the parent kills it.
      value = { controller };
    } else if (input.mode === "read") {
      const { readLookupPilotLease } = await load("continuity-lookup-lease");
      value = { binding: await readLookupPilotLease(input.outputRoot, input.controller) };
    } else if (input.mode === "probe") {
      const db = new DatabaseSync(join(input.outputRoot, "controller-lock.sqlite"));
      try {
        let busy = false;
        try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
        catch (error) { if ((error.errcode & 0xff) !== 5) throw error; busy = true; }
        value = { busy };
      } finally { db.close(); }
    } else if (input.mode === "identity") value = { controller };
    else throw new Error("invalid_test_mode");
    process.send({ ok: true, ...value, egressDenied, egressAttempts }, () => { if (!heldLease) process.disconnect(); });
  } catch (error) {
    heldLease?.release();
    process.send({ ok: false, code: error.code ?? "lease_child_failed", egressDenied, egressAttempts }, () => process.disconnect());
  }
});
process.send({ ready: true });
