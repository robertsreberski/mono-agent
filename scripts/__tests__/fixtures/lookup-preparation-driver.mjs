import { setTimeout as delay } from "node:timers/promises";
import { fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const settings = JSON.parse(await readFile(process.env.LOOKUP_BOUNDARY_SETTINGS));
process.once("message", async ({ repo, options }) => {
  let journal, provider;
  try {
    const load = name => import(pathToFileURL(join(repo, "scripts/lib", `continuity-${name}.mjs`)).href);
    const controller = await load("lookup-controller"), roles = await load("lookup-roles");
    if (settings.fault === "lease-home") {
      provider = await (await import("./lookup-loopback-response.mjs")).loopbackResponse();
      options.authorization.fixtureEndpoint = `http://127.0.0.1:${provider.address().port}/codex/responses`;
      settings.allowedPorts = [provider.address().port]; settings.leaveLease = true;
      await writeFile(process.env.LOOKUP_BOUNDARY_SETTINGS, JSON.stringify(settings));
    }
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
    const a = { outputRoot: options.outputRoot, epoch: state.epoch, runId: state.runId, index: 0, cacheKey: state.slots[0].cacheKey, timeoutMs: options.authorization.timeoutMs, slotId: slot.slotId, slot, pilot,
      roleRequest: { schema: "lookup-role-request-v1", binding, common: pilot.registration.common, build: pilot.registration.codes[slot.code].build }, plan };
    if (["tamper", "production-tamper"].includes(settings.fault)) {
      const p = join(options.outputRoot, "work", slot.slotId, "checkpoint", "preparation.json");
      const manifest = JSON.parse(await readFile(p)); manifest.conversationId = "fictional-tamper"; await writeFile(p, JSON.stringify(manifest));
    }
    const production = settings.fault?.startsWith("production-") || settings.fault === "lease-home";
    if (settings.fault === "production-restore") await (await import("node:fs/promises")).chmod(join(options.outputRoot, "work", slot.slotId, "checkpoint"), 0o500);
    if (settings.fault === "lease-home") {
      const coordinator = await import(pathToFileURL(join(settings.runtimeRoot, "packages/app/dist/durable-state/agent-root-coordinator.js")));
      const work = (await load("lookup-pilot-runtime")).lookupPilotWork(a);
      const owner = JSON.parse(await readFile(join(coordinator.agentRootLeasePath(work, join(dirname(work), "lease-home")), "owner.json")));
      if (owner.pid !== state.slots[0].preparation.pid) throw Error("fixture_stale_owner_missing");
    }
    if (production) {
      try { await journal.probe(0); } finally {
        if (settings.fault === "production-restore") await (await import("node:fs/promises")).chmod(join(options.outputRoot, "work", slot.slotId, "checkpoint"), 0o700);
      }
      const current = journal.snapshot(), result = current.slots[0];
      const reply = current.stop === "lookup_preparation_invalid" ? {refused: current.stop} : {verified: true, conversation: true, pid: result.worker.pid};
      process.send({state: current, reply}, () => process.disconnect()); return;
    }
    const {lookupProcessStartIdentity} = await load("process-identity");
    const child = fork(fileURLToPath(new URL("./lookup-preparation-verifier.mjs", import.meta.url)), [], { cwd: repo, detached: true,
      env: await (await load("lookup-child-environment")).lookupChildEnvironment(join(options.outputRoot, "work", slot.slotId, "probe-home")), execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] }); child.stderr.resume();
    const childExit = new Promise(resolve => child.once("close", resolve));
    const ownedStart = lookupProcessStartIdentity(child.pid);
    try {
    const reply = await new Promise((resolve, reject) => {
      child.once("close", () => reject(Error("fixture_closed_without_result"))); child.on("error", reject); child.on("message", m => { void (async () => {
        if (m.loaded || m.type === "loaded") { const { lookupProcessStartIdentity } = await load("process-identity"); await journal.assign(0, { pid: child.pid, startIdentity: lookupProcessStartIdentity(child.pid) }); child.send(a); }
        else if (m.verified || m.refused) resolve(m);
        else reject(Error("fixture_message_invalid"));
      })().catch(reject); });
    });
    await childExit;
    if (settings.fault === "production-restore") await (await import("node:fs/promises")).chmod(join(options.outputRoot, "work", slot.slotId, "checkpoint"), 0o700);
    if (reply.refused) { await journal.stop("lookup_preparation_invalid"); await journal.finish(0, "lost"); }
    process.send({ state: journal.snapshot(), reply }, () => process.disconnect());
    } finally {
      if (child.exitCode === null && child.signalCode === null && ownedStart && lookupProcessStartIdentity(child.pid) === ownedStart) child.kill("SIGKILL");
      await childExit;
    }
  } catch (error) { process.send({ failed: error.code ?? error.message }, () => process.disconnect()); }
  finally {
    if (settings.fault === "production-restore" && journal) await (await import("node:fs/promises")).chmod(join(options.outputRoot, "work", journal.snapshot().schedule[0].slotId, "checkpoint"), 0o700).catch(() => {});
    journal?.release(); if (provider) { provider.closeAllConnections(); provider.close(); } }
});
process.send({ loaded: true });
