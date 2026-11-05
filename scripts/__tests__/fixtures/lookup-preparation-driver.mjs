import { setTimeout as delay } from "node:timers/promises";
import { fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const settings = JSON.parse(await readFile(process.env.LOOKUP_BOUNDARY_SETTINGS));
process.once("message", async ({ repo, options }) => {
  let journal;
  try {
    const load = name => import(pathToFileURL(join(repo, "scripts/lib", `continuity-${name}.mjs`)).href);
    const controller = await load("lookup-controller"), roles = await load("lookup-roles");
    journal = await controller.createLookupPilotController(options);
    const preparation = journal.prepare(0); let pending;
    if (settings.fault === "hang") {
      const path = join(options.outputRoot, "lookup-pilot-controller.json");
      for (let i = 0; i < 100 && !JSON.parse(await readFile(path)).slots[0].preparation; i++) await delay(5);
      const before = await readFile(path);
      const report = await controller.reconcileLookupPilot(options.outputRoot);
      pending = { unreconciledGroups: report.unreconciledGroups, reconciliation: report.reconciliation, unchanged: before.equals(await readFile(path)) };
    }
    const ok = await preparation, state = journal.snapshot();
    if (!ok) { process.send({ state, pending }, () => process.disconnect()); return; }
    const slot = state.schedule[0], pilot = journal.pilot, role = pilot.registration.roles.find(r => r.id === slot.roleId), corpus = pilot.registration.common.corpora.find(c => c.suite === slot.suite);
    const binding = roles.roleBinding(pilot.registration, role, corpus), plan = await roles.rolePlan(pilot.registration.common, binding);
    const a = { outputRoot: options.outputRoot, epoch: state.epoch, runId: state.runId, index: 0, slotId: slot.slotId, slot, pilot,
      roleRequest: { binding, common: pilot.registration.common, build: pilot.registration.codes[slot.code].build }, plan };
    if (settings.fault === "tamper") {
      const p = join(options.outputRoot, "work", slot.slotId, "checkpoint", "preparation.json");
      const manifest = JSON.parse(await readFile(p)); manifest.conversationId = "fictional-tamper"; await writeFile(p, JSON.stringify(manifest));
    }
    const child = fork(fileURLToPath(new URL("./lookup-preparation-verifier.mjs", import.meta.url)), [], { cwd: repo,
      env: process.env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] }); child.stderr.resume();
    const reply = await new Promise((resolve, reject) => {
      child.on("error", reject); child.on("message", async m => {
        if (m.loaded) { const { lookupProcessStartIdentity } = await load("process-identity"); await journal.assign(0, { pid: child.pid, startIdentity: lookupProcessStartIdentity(child.pid) }); child.send(a); }
        else resolve(m);
      });
    });
    await new Promise(resolve => child.once("close", resolve));
    if (reply.refused) { await journal.stop("lookup_preparation_invalid"); await journal.finish(0, "lost"); }
    process.send({ state: journal.snapshot(), reply }, () => process.disconnect());
  } catch (error) { process.send({ failed: error.code ?? error.message }, () => process.disconnect()); }
  finally { journal?.release(); }
});
process.send({ loaded: true });
