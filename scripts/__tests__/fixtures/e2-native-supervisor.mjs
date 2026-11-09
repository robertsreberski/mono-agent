// Test supervisor uses the genuine E2 kernel; source/build attestation is a declared preload seam.
import { readFile, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { guardedController } from "../../lib/continuity-guarded-controller.mjs";
import { guardedReport } from "../../lib/continuity-guarded-report.mjs";
import { lookupProcessStartIdentity } from "../../lib/continuity-process-identity.mjs";
import { e2SlotRequest, e2RoleRequest } from "../../lib/continuity-e2-runtime.mjs";
import { E2_AUTHORIZATION_SCHEMA } from "../../lib/continuity-e2-policy.mjs";
const profile = JSON.parse(await readFile(process.argv[2], "utf8")), pilot = JSON.parse(await readFile(profile.args.registrationPath, "utf8"));
const controller = guardedController("e2-validation"), outputRoot = profile.args.outputRoot, authorization = { schema: E2_AUTHORIZATION_SCHEMA, ...profile.args };
delete authorization.outputRoot;
const options = { real: true, pilot, authorization, outputRoot };
// Keep preparation failures visible in this private fixture instead of a public projection.
await (await import("../../lib/continuity-guarded-protocols.mjs")).guardedProtocol("e2-validation").hooks.prepareController(options).catch(async error => {
  await writeFile(profile.result, JSON.stringify({ error: error.code ?? error.name, stage: "preparation" }), { mode: 0o600 }); process.exit(1);
});
let journal, child, report, caught, reuse = null;
try {
  if (profile.production) report = await controller.runLookupPilot(options);
  else {
    journal = await controller.createLookupPilotController(options);
    child = fork(join(profile.root, "scripts/__tests__/fixtures/e2-native-sdk-child.mjs"), [process.argv[2]], { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { HOME: profile.home, PATH: "/usr/bin:/bin", LANG: "C", NODE_NO_WARNINGS: "1" } });
    let chain = Promise.resolve(), done;
    child.stderr.resume();
    child.on("message", message => { chain = chain.then(async () => {
      const state = journal.snapshot(), slot = state.schedule[0];
      if (message.type === "loaded") {
        await journal.assign(0, { pid: child.pid, startIdentity: lookupProcessStartIdentity(child.pid) });
        const { binding, plan } = e2SlotRequest(pilot, slot);
        child.send({ pilot, authorization, outputRoot, runId: state.runId, epoch: state.epoch, slotId: slot.slotId, slot, index: 0,
          timeoutMs: 10000, cacheKey: journal.snapshot().slots[0].cacheKey, roleRequest: e2RoleRequest(pilot, binding), plan });
      } else if (message.type === "ready") { await journal.ready(0); child.send({ type: "go", epoch: state.epoch, slotId: slot.slotId }); }
      else if (message.type === "done") { done = message; child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId }); }
      else child.send(await journal.message(0, child, message));
    }).catch(error => { void journal.stop("e2_worker_lost"); child.kill("SIGKILL"); throw error; }); void chain.catch(() => {}); });
    await once(child, "close"); await chain; caught = done?.caught;
    if (!done) await journal.stop("e2_worker_lost");
    await journal.finish(0, done?.terminal ?? "lost", done?.score ?? null, done?.refusalCode ?? null);
    if (!journal.snapshot().stop) await journal.stop("completed");
    const state = journal.snapshot(), reports = guardedReport("e2-validation"); report = reports.aggregateRun(state, [reports.slotReceipt(state, 0)]);
    journal.release(); journal = null;
  }
  if (profile.reuse) {
    try { const second = await controller.createLookupPilotController(options); second.release(); reuse = "unexpected_success"; }
    catch (error) { reuse = error.code; }
  }
  const reconciled = await controller.reconcileLookupPilot(outputRoot);
  await writeFile(profile.result, JSON.stringify({ report, reuse, reconciled, caught }), { mode: 0o600 });
} catch (error) {
  await writeFile(profile.result, JSON.stringify({ error: error.code ?? error.name }), { mode: 0o600 }); process.exitCode = 1;
} finally { journal?.release(); if (child?.connected) child.disconnect(); }
