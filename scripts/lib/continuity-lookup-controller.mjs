import { LOOKUP_PREFLIGHT, lookupPreflightDigest } from "./continuity-lookup-preparation.mjs";
import { lookupChildEnvironment, lookupChildImports } from "./continuity-lookup-child-environment.mjs";
// Single journal and containment policy; paid entry remains explicitly gated.
import { fork } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, lstat, readdir, open } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";

import { assertLookupPilotArm, lookupPreparationDigest } from "./continuity-lookup-preparation.mjs";
import { armById } from "./continuity-arms.mjs";
import { LOOKUP_PRE_SEND_REFUSALS, LOOKUP_GUARD_POLICY_REFUSALS } from "./continuity-lookup-guard.mjs";
import { assertLookupCacheAssignment, issueLookupCacheKey, lookupPilotWatchdog } from "./continuity-lookup-pilot-runtime.mjs";
import { digest } from "./continuity-dataset.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
import { externalDirectory } from "./continuity-holdout-files.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive } from "./continuity-holdout-controller.mjs";
import { acquireLookupPilotLease, assertLookupPilotLease } from "./continuity-lookup-lease.mjs";
import { lookupProcessStartIdentity, lookupProcessGroupSnapshot } from "./continuity-process-identity.mjs";
import { LOOKUP_FAUX_AUTHORIZATION_DOMAIN, validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { ROOT, verifyRegisteredCheckouts, roleBinding, rolePlan } from "./continuity-lookup-roles.mjs";
import { aggregateLookupPilot, lookupPilotReceipt } from "./continuity-lookup-pilot-report.mjs";
import { accountLookupPilot, lookupMoney, lookupPilotStopReason, settleLookupHold, priceLookupUsage, pilotNeed, fixedPilotCode, LOOKUP_SLOT_TERMINALS, LOOKUP_PILOT_STOPS, LOOKUP_GUARD_STOPS, LOOKUP_INTEGRITY_STOPS } from "./continuity-lookup-pilot-accounting.mjs";
import { LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER, LOOKUP_PILOT_IPC, requireFauxPilot, readPilotPrivate, pilotStatePath, samePilot, pilotHash, pilotId, lookupPilotSchedule } from "./continuity-lookup-pilot-state.mjs";

export { lookupPilotSchedule } from "./continuity-lookup-pilot-state.mjs";
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function fauxConsume(authorization, pilot, root, identity, lease) {
  await assertLookupPilotLease(lease, root, identity.controller);
  pilotNeed(Object.keys(authorization).filter(k => k !== "fixtureEndpoint").sort().join() === "authorizationId,outputRoot,pilotSha256,scenarios,schema,timeoutMs"
    && Array.isArray(authorization.scenarios) && authorization.scenarios.every(s => ["settled", "two_rounds", "wrong", "empty", "empty_two_rounds", "lost", "own_abort_after_send", "integrity_stop", "auth", "quota", "input_refusal", "request_limit"].includes(s))
    && pilotId(authorization.authorizationId) && authorization.outputRoot === root && authorization.pilotSha256 === digest(pilot)
    && Number.isSafeInteger(authorization.timeoutMs) && authorization.timeoutMs > 0 && authorization.timeoutMs <= pilot.descriptor.deadlines.childWatchdogMs,
  "lookup_pilot_faux_required");
  pilotNeed((await readdir(root)).every(n => n === "controller-lock.sqlite"), "lookup_pilot_resume_forbidden");
  const parent = join(dirname(root), ".lookup-faux-consumed-v1");
  await mkdir(parent, { mode: 0o700, recursive: true });
  const info = await lstat(parent);
  pilotNeed(info.isDirectory() && info.uid === userInfo().uid && (info.mode & 0o077) === 0, "lookup_receipt_invalid");
  await syncDirectory(dirname(parent));
  const entry = join(parent, createHash("sha256").update(LOOKUP_FAUX_AUTHORIZATION_DOMAIN + authorization.authorizationId).digest("hex"));
  try { await mkdir(entry, { mode: 0o700 }); } catch { pilotNeed(false, "lookup_authorization_already_consumed"); }
  await syncDirectory(parent);
  const claim = { schema: "lookup-faux-consumption-v1", authorizationId: authorization.authorizationId, ...identity, outputRoot: root, binding: digest(pilot) };
  await durable(join(root, "authorization-consumed.json"), claim, true);
  await durable(join(entry, "claim.json"), claim, true);
}
function slotTerminal(slot, claimed = "lost") {
  if (!slot.holds.length) return "unadmitted";
  let terminal = slot.terminal ?? (slot.admissionRefusal ? "refused_pre_send" : claimed);
  if (terminal === "own_abort_after_send" && !slot.holds.at(-1).consumed) terminal = "lost";
  return slot.holds.some(h => !h.settlement) && !["own_abort_after_send", "integrity_stop"].includes(terminal) ? "lost" : terminal;
}
/** Serialized durable journal, independently testable without dispatch or an injectable send. */
async function initializeLookupPilot(options = {}) {
  // Take the owned snapshot before validation can await or invoke caller accessors again.
  try { options = structuredClone(options); } catch { pilotNeed(false, "lookup_pilot_faux_required"); }
  const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(options);
  const { pilot, authorization, outputRoot } = options;
  const real = authorization?.schema === "continuity-lookup-pilot-authorization-v1";
  if (real) {
    (await import("./continuity-lookup-pilot-entry.mjs")).assertLookupPilotEntry();
    pilotNeed(Object.keys(authorization).sort().join() === "authorizationPath,controllerRoot,credentialPath,registrationPath,registrationSha256,schema", "lookup_authorization_binding_mismatch");
    pilotNeed(!Object.hasOwn(process.env, "CI"), "paid_mode_refused_in_ci");
    pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  }
  else requireFauxPilot(authorization);
  pilotNeed(Object.keys(options).sort().join() === "authorization,outputRoot,pilot", "lookup_pilot_faux_required");
  await validateLookupPilotRegistration(pilot);
  pilotNeed(pilot.registration.codes.R0.path === ROOT, "lookup_controller_checkout_mismatch");
  const auth = real ? await import("./continuity-lookup-authorization.mjs") : null;
  const authorizationHandle = real ? await auth.validateLookupAuthorization({ ...authorization, outputRoot }) : null;
  pilotNeed(!real || auth.lookupAuthorizationBindsPilot(authorizationHandle, pilot), "lookup_authorization_binding_mismatch");

  for (const role of pilot.registration.roles) assertLookupPilotArm(armById(role.arm));
  await verifyRegisteredCheckouts(pilot.registration);
  pilotNeed(await externalDirectory(outputRoot, false, Object.values(pilot.registration.codes).map(c => c.path)) === outputRoot, "lookup_receipt_invalid");
  const controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
  pilotNeed(typeof controller.startIdentity === "string" && controller.startIdentity.length > 0, "lookup_ipc_invalid");
  const lease = await acquireLookupPilotLease(outputRoot), identity = { runId: randomUUID(), controllerEpoch: randomUUID(), controller };
  let state, failed = false, tail = Promise.resolve();
  const path = pilotStatePath(outputRoot), cap = lookupMoney(pilot.descriptor.capUSD), reserve = lookupMoney(pilot.descriptor.rmaxUSD);
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const save = async () => {
    pilotNeed(!failed, "lookup_persist_failed");
    state.revision++;
    try {
      await durable(path, state); pilotNeed(samePilot(await readPilotPrivate(path), state), "lookup_persist_failed");
      for (const i of new Set([state.cursor, state.cursor - 1])) if (state.slots[i] && (state.slots[i].preparation || state.slots[i].worker || state.slots[i].terminal)) {
        const receipt = lookupPilotReceipt(state, i), receiptPath = join(outputRoot, "slots", `${receipt.slotId}.json`);
        await durable(receiptPath, receipt); pilotNeed(samePilot(await readPilotPrivate(receiptPath), receipt), "lookup_persist_failed");
      }
    }
    catch { failed = true; pilotNeed(false, "lookup_persist_failed"); }
  };
  const check = async () => {
    pilotNeed(!failed, "lookup_persist_failed");
    try {
      await assertLookupPilotLease(lease, outputRoot, state.controller);
      pilotNeed(samePilot(await readPilotPrivate(path), state), "lookup_persist_failed");
    } catch { failed = true; pilotNeed(false, "lookup_persist_failed"); }
  };
  const stop = code => {
    // Unreconciled containment is an absorbing safety escalation, never a reopening.
    if (code === "lookup_unreconciled_processes") { state.stop = code; if (state.slots[state.cursor]) state.slots[state.cursor].unreconciled = true; }
    else state.stop ??= fixedPilotCode(code);
    for (const slot of state.slots) for (const hold of slot.holds) if (!hold.consumed && !hold.settlement) hold.revoked = true;
  };
  try {
    if (real) await auth.consumeLookupAuthorization(authorizationHandle, identity, lease);
    else await fauxConsume(authorization, pilot, outputRoot, identity, lease);
    const schedule = lookupPilotSchedule(pilot);
    state = { schema: real ? LOOKUP_REAL_CONTROLLER : LOOKUP_FAUX_CONTROLLER, ...(real ? { recovery: false } : {}), ...(!real ? { fauxEndpoint: authorization.fixtureEndpoint ?? null } : {}), binding: digest(pilot), runId: identity.runId, epoch: identity.controllerEpoch,
      controller: identity.controller, capUSD: pilot.descriptor.capUSD, rmaxUSD: pilot.descriptor.rmaxUSD, revision: 0, deadlineAt: Date.now() + pilot.descriptor.deadlines.runDeadlineMs,
      schedule, scheduleSha256: digest(schedule), cursor: 0, stop: null,
      cacheKeysUnique: true, roleCount: pilot.registration.roles.length, publicSources: Object.fromEntries(pilot.registration.common.corpora.map(c => [c.suite, c.sha256])),
      publicBindings: Object.fromEntries(Object.entries(pilot.registration.codes).map(([id, c]) => [id, {
        revision: c.revision, buildSha256: c.build.outputSha256,
        protocolSha256: pilot.registration.common.protocol.pilotSha256 }])),
      slots: schedule.map(slot => ({ slotId: slot.slotId, holds: [], terminal: null, worker: null, cacheKey: issueLookupCacheKey(identity.runId), startedAt: null, nextMessage: 0, lastAck: null, score: null })) };
    assertLookupCacheAssignment(state, { index: 0, cacheKey: state.slots[0].cacheKey });
    await mkdir(join(outputRoot, "slots"), { mode: 0o700 });
    await save();
  } catch (error) { lease.release(); throw error; }
  const api = {
    pilot, authorization, outputRoot,
    snapshot: () => structuredClone(state),
    async prepare(index) { return runSlot(api, pilot, authorization, outputRoot, index, true); },
    async probe(index) { return runSlot(api, pilot, authorization, outputRoot, index); },
    async assignPreparation(index, worker) { return serial(async () => {
      await check(); const slot = state.slots[index];
      pilotNeed(!state.stop && state.cursor === index && !slot.preparation && !slot.worker && !slot.holds.length
        && worker.pid > 1 && worker.pid !== process.pid && worker.startIdentity && worker.startIdentity === lookupProcessStartIdentity(worker.pid), "lookup_preparation_invalid");
      slot.preparation = { schema: "lookup-preparation-record-v1", pid: worker.pid, startIdentity: worker.startIdentity, exited: false }; await save();
    }); },
    async prepared(index, treeDigest) { return serial(async () => {
      await check(); const slot = state.slots[index], p = slot.preparation;
      pilotNeed(!state.stop && state.cursor === index && p && !p.exited && !slot.worker && !slot.holds.length
        && lookupProcessStartIdentity(p.pid) !== p.startIdentity && !groupAlive(p.pid) && pilotHash(treeDigest), "lookup_preparation_invalid");
      slot.preparation = { ...p, treeDigest, exited: true }; await save();
    }); },
    release: () => lease.release(),
    async assign(index, worker) { return serial(async () => {
      await check(); pilotNeed(!state.stop && state.cursor === index && !state.slots[index].worker, "lookup_ipc_invalid");
      pilotNeed(worker.pid > 1 && worker.pid !== process.pid && typeof worker.startIdentity === "string" && worker.startIdentity.length > 0 && worker.startIdentity === lookupProcessStartIdentity(worker.pid), "lookup_ipc_invalid");
      state.slots[index].worker = { pid: worker.pid, startIdentity: worker.startIdentity }; state.slots[index].startedAt = Date.now(); await save();
    }); },
    async recordMembers(index, members, preparation = false) { return serial(async () => {
      await check(); const target = preparation ? state.slots[index].preparation : state.slots[index], worker = preparation ? target : target.worker;
      pilotNeed(worker && members.every(m => m.pid > 1 && m.pid !== worker.pid && m.pgid === worker.pid && typeof m.startIdentity === "string" && m.startIdentity.length > 0), "lookup_ipc_invalid");
      target.members = [...new Map([...(target.members ?? []), ...members].map(m => [`${m.pid}:${m.startIdentity}`, m])).values()]; await save();
    }); },
    async ready(index) { return serial(async () => {
      await check(); pilotNeed(state.schema === LOOKUP_REAL_CONTROLLER && state.cursor === index && state.slots[index].worker, "lookup_ipc_invalid");
      state.slots[index].ready = true; await save();
    }); },
    async message(index, worker, message) { return serial(async () => {
      await check();
      const slot = state.slots[index];
      try {
        pilotNeed(index === state.cursor && slot.worker?.pid === worker.pid && lookupProcessStartIdentity(worker.pid) === slot.worker.startIdentity
          && message?.version === LOOKUP_PILOT_IPC && message.epoch === state.epoch && message.slotId === slot.slotId
          && message.seq === slot.nextMessage && ["admit", "consume", "settle", "stop"].includes(message.op), "lookup_ipc_invalid");
        const p = message.payload; let result = {};
        if (message.op === "admit") {
          pilotNeed(p && Object.keys(p).sort().join() === "payloadDigest,requestId,rmax,round,slotId" && p.slotId === slot.slotId
            && typeof p.requestId === "string" && p.requestId === `${state.runId}:${p.round}` && pilotHash(p.payloadDigest)
            && p.round === slot.holds.length + 1 && p.round <= 10 && p.rmax === pilot.descriptor.rmaxUSD
            && !slot.terminal && slot.holds.every(h => h.settlement), "lookup_permit_invalid");
          if (Date.now() >= state.deadlineAt) stop("lookup_run_deadline");
          else if (Date.now() >= slot.startedAt + pilot.descriptor.deadlines.deadlineMs) stop("lookup_worker_timeout");
          const reason = lookupPilotStopReason(accountLookupPilot(state.slots), cap, reserve);
          if (reason) stop(reason);
          if (state.stop) { slot.admissionRefusal = state.stop; result = { refused: true, code: state.stop === "budget_admission" ? "not_admitted_cap" : "lookup_stopped" }; }
          else {
            const permitId = randomUUID();
            slot.holds.push({ permitId, requestId: p.requestId, payloadDigest: p.payloadDigest, round: p.round,
              reservedUnits: reserve.toString(), consumed: false, revoked: false, settlement: null });
            result = { epoch: state.epoch, permitId };
          }
        } else if (message.op === "stop") {
          pilotNeed(p && Object.keys(p).join() === "code" && LOOKUP_GUARD_STOPS.includes(p.code), "lookup_ipc_invalid");
          if ((LOOKUP_INTEGRITY_STOPS.includes(p.code) || p.code === "lookup_account_mismatch") && slot.holds.length) slot.terminal = "integrity_stop"; stop(p.code);
        }
        else {
          const hold = slot.holds.find(h => h.permitId === p?.permit?.permitId);
          pilotNeed(hold && p.permit.epoch === state.epoch && !hold.settlement, "lookup_permit_invalid");
          if (message.op === "consume") {
            pilotNeed(!state.stop && !hold.revoked && !hold.consumed && p.bodyDigest === hold.payloadDigest && Date.now() < Math.min(state.deadlineAt, slot.startedAt + pilot.descriptor.deadlines.deadlineMs), "lookup_permit_invalid");
            hold.consumed = true;
          } else {
            try { Object.assign(hold, settleLookupHold(hold, p.outcome, p.rawUsage, p.tier)); }
            catch (error) {
              // A bad claim must not discard independently computable partial spend.
              if (p.rawUsage !== null) try {
                const priced = priceLookupUsage(p.rawUsage, p.tier);
                hold.settlement = { kind: "integrity_stop", code: fixedPilotCode(error.code), rawUsage: priced.rawUsage, tier: priced.tier, knownUnits: priced.units };
              } catch {}
              slot.terminal = "integrity_stop"; throw error;
            }
            if (p.outcome.kind === "integrity_stop") { slot.terminal = "integrity_stop"; stop(p.outcome.code); }
            else if (["lost", "own_abort_after_send"].includes(p.outcome.kind) && slot.terminal !== "integrity_stop") slot.terminal = p.outcome.kind;
            const breach = p.rawUsage?.input_tokens > pilot.descriptor.assumptions.inputMax ? "lookup_input_envelope_violated"
              : p.rawUsage?.output_tokens > pilot.descriptor.assumptions.outputMax ? "lookup_output_envelope_violated"
              : BigInt(hold.settlement.knownUnits) > reserve ? "lookup_hold_exceeded" : null;
            if (breach) { slot.terminal = "integrity_stop"; hold.settlement.kind = "integrity_stop"; hold.settlement.code ??= breach; stop(breach); }
          }
        }
        slot.nextMessage++;
        const ack = { type: "ack", version: LOOKUP_PILOT_IPC, epoch: state.epoch, slotId: slot.slotId, seq: message.seq,
          revision: state.revision + 1, ok: true, result };
        slot.lastAck = ack; await save(); return structuredClone(ack);
      } catch (error) {
        if (slot.holds.length) slot.terminal = "integrity_stop";
        stop(error.code); await save(); throw Object.assign(new Error(fixedPilotCode(error.code)), { code: fixedPilotCode(error.code) });
      }
    }); },
    async finish(index, terminal, score = null, refusalCode = null) { return serial(async () => {
      await check(); const slot = state.slots[index];
      if (!slot || state.cursor !== index || !LOOKUP_SLOT_TERMINALS.includes(terminal) || terminal === "unadmitted" || terminal === "skipped"
        || terminal === "refused_pre_send" && !slot?.admissionRefusal && ![...LOOKUP_PRE_SEND_REFUSALS, ...LOOKUP_GUARD_POLICY_REFUSALS].includes(refusalCode) || ![null, 0, 1].includes(score) || refusalCode !== null && ![...LOOKUP_PRE_SEND_REFUSALS, ...LOOKUP_GUARD_POLICY_REFUSALS].includes(refusalCode)) {
        if (slot?.holds.length) slot.terminal = "integrity_stop";
        stop("lookup_ipc_invalid"); await save(); pilotNeed(false, "lookup_ipc_invalid");
      }
      if (terminal === "refused_pre_send" && refusalCode) slot.guardRefusal = refusalCode;
      if (terminal === "refused_pre_send" && LOOKUP_GUARD_POLICY_REFUSALS.includes(refusalCode)) {
        stop(refusalCode); if (slot.holds.length) terminal = "integrity_stop";
      }
      // Account substitution is a safety violation, not a provider-loss observation.
      // Keep the retained settlement contract unchanged while projecting the slot correctly.
      if (state.stop === "lookup_account_mismatch" && slot.holds.length) slot.terminal = "integrity_stop";
      slot.terminal = slotTerminal(slot, terminal);
      slot.score = ["completed", "wrong"].includes(slot.terminal) ? score : null;
      state.cursor++; const reason = lookupPilotStopReason(accountLookupPilot(state.slots), cap);
      if (reason) stop(reason);
      await save();
    }); },
    async stop(code) { return serial(async () => { await check(); stop(code); await save(); }); },
    async skip(index) { return serial(async () => {
      await check(); pilotNeed(state.cursor === index && !state.schedule[index].eligible, "lookup_receipt_invalid");
      state.slots[index].terminal = "skipped"; state.cursor++; await save();
    }); },
  };
  return Object.freeze(api);
}
function publicFailure(error) {
  const allowed = [...LOOKUP_PILOT_STOPS, "paid_mode_refused_in_ci", "lookup_pilot_real_route_unavailable", "lookup_pilot_faux_required", "lookup_debug_forbidden", "lookup_controller_checkout_mismatch",
    "lookup_pilot_boundary_required", "lookup_authorization_binding_mismatch", "lookup_authorization_already_consumed", "lookup_authorization_lease_invalid", "lookup_pilot_resume_forbidden", "lookup_pilot_not_ready"];
  pilotNeed(false, allowed.includes(error?.code) ? error.code : "lookup_pilot_not_ready");
}
export async function createLookupPilotController(options) {
  try { return await initializeLookupPilot(options); } catch (error) { publicFailure(error); }
}
/** Reconciliation never acquires a new writer lease, dispatches or signals an old group. */
async function reconcilePilotState(outputRoot) {
  const state = await readPilotPrivate(pilotStatePath(outputRoot));
  pilotNeed([LOOKUP_FAUX_CONTROLLER, LOOKUP_REAL_CONTROLLER].includes(state.schema) && state.scheduleSha256 === digest(state.schedule), "lookup_receipt_invalid");
  let live = 0;
  for (const slot of state.slots) {
    const preparationAlive = slot.preparation && !slot.preparation.exited && groupAlive(slot.preparation.pid);
    if (preparationAlive) live++;
    if (slot.worker) {
      const alive = groupAlive(slot.worker.pid); if (alive) live++;
      if (!slot.terminal && (!alive || slot.admissionRefusal)) slot.terminal = slotTerminal(slot);
    } else if (slot.preparation && !preparationAlive && !slot.terminal) slot.terminal = slotTerminal(slot);
  }
  state.stop ??= live ? "lookup_unreconciled_processes" : "lookup_recovery_only";
  // Observation only: a live controller may still be writing this root.
  return { ...aggregateLookupPilot(state, state.slots.flatMap((s, i) => s.preparation || s.worker || s.terminal ? [lookupPilotReceipt(state, i)] : [])), reconciliation: true, unreconciledGroups: live };
}
export async function reconcileLookupPilot(outputRoot) {
  try { return await reconcilePilotState(outputRoot); } catch (error) { publicFailure(error); }
}
async function runSlot(journal, pilot, authorization, root, index, preparation = false) {
  const state = journal.snapshot(), slot = state.schedule[index], code = pilot.registration.codes[slot.code];
  const role = pilot.registration.roles.find(r => r.id === slot.roleId), corpus = pilot.registration.common.corpora.find(c => c.suite === slot.suite);
  const binding = roleBinding(pilot.registration, role, corpus), plan = await rolePlan(pilot.registration.common, binding);
  const timeoutMs = lookupPilotWatchdog(authorization, pilot.descriptor.deadlines, state.deadlineAt);
  const preparationHome = join(root, "work", slot.slotId, preparation ? "preparation-home" : "probe-home");
  const env = await lookupChildEnvironment(preparationHome);
  const child = fork(join(code.path, preparation ? "scripts/lib/continuity-lookup-preparation-child.mjs" : "scripts/lib/continuity-lookup-pilot-child.mjs"), [], {
    cwd: code.path, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: lookupChildImports(), env,
  });
  const owned = { pid: child.pid, startIdentity: lookupProcessStartIdentity(child.pid) };
  child.stderr.resume();
  // Persist even a preparation process that hangs before its loaded handshake.
  const preparationAssigned = preparation ? journal.assignPreparation(index, owned) : null;
  void preparationAssigned?.catch(() => {});
  let closed = false, reconciled = false, done = null, busy = false, failure = null, stage = "loaded", chain = Promise.resolve(), settleTimer, termination, containmentFailed = false, rejectContainment;
  const observedMembers = new Map();
  const stopFailure = () => journal.stop(preparation ? ["lookup_worker_timeout", "lookup_preparation_timeout"].includes(failure) ? "lookup_preparation_timeout" : "lookup_preparation_invalid" : failure);
  const containmentFailure = new Promise((_, reject) => { rejectContainment = reject; }); void containmentFailure.catch(() => {});
  const recordProvenMembers = async () => {
    if (child.exitCode !== null || child.signalCode !== null || !owned.startIdentity
      || lookupProcessStartIdentity(owned.pid) !== owned.startIdentity) return;
    const snapshot = lookupProcessGroupSnapshot(owned.pid), identity = owned.startIdentity.replace(/\s+/gu, " ");
    const descendants = snapshot.filter(m => m.pid !== owned.pid && !m.zombie);
    if (descendants.length && snapshot.some(m => m.pid === owned.pid && !m.zombie && m.startIdentity === identity)) {
      for (const m of descendants) observedMembers.set(`${m.pid}:${m.startIdentity}`, m);
      try { await journal.recordMembers(index, descendants, preparation); }
      catch { failure ??= "lookup_persist_failed"; } // No grant may follow, but containment must remain live.
    }
  };
  const terminateOwned = () => reconciled ? Promise.resolve() : termination ??= (async function containOwned() {
    try {
      // Persist while the leader still pins the group, including timeout/disconnect.
      // Every signal below still requires a separate fresh, post-persistence proof.
      await recordProvenMembers();
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        if (!groupAlive(owned.pid)) return;
        const memberRecord = preparation ? journal.snapshot().slots[index].preparation : journal.snapshot().slots[index];
        const members = [...(memberRecord?.members ?? []), ...observedMembers.values()];
        const leaderIdentity = child.exitCode === null && child.signalCode === null && owned.startIdentity
          && lookupProcessStartIdentity(owned.pid) === owned.startIdentity;
        // No journal clone, await or identity subprocess between this fresh proof and signalling.
        const currentMembers = lookupProcessGroupSnapshot(owned.pid);
        const leaderProven = leaderIdentity && currentMembers.some(now => now.pid === owned.pid && !now.zombie && now.startIdentity === owned.startIdentity.replace(/\s+/gu, " "));
        const descendantProven = !leaderProven && members.length && currentMembers.some(now => !now.zombie && members.some(old => old.pid === now.pid && old.pgid === now.pgid && old.startIdentity === now.startIdentity));
        if (!leaderProven && !descendantProven) { pilotNeed(!groupAlive(owned.pid), "lookup_unreconciled_processes"); return; }
        try { process.kill(-owned.pid, signal); } catch (error) { if (!groupAlive(owned.pid)) return; throw error; }
        for (let i = 0; i < 20 && groupAlive(owned.pid); i++) await delay(10);
      }
      pilotNeed(!groupAlive(owned.pid), "lookup_unreconciled_processes");
    }
    catch {
      containmentFailed = true;
      const error = Object.assign(new Error("lookup_unreconciled_processes"), { code: "lookup_unreconciled_processes" });
      try { await journal.stop("lookup_unreconciled_processes"); } catch {}
      finally { rejectContainment(error); }
      throw error;
    }
  })();
  const exited = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
  const timer = setTimeout(() => { failure ??= "lookup_worker_timeout"; void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {}); }, timeoutMs);
  child.on("error", () => { failure ??= "lookup_worker_lost"; });
  child.on("disconnect", () => { if (!done) { failure ??= "lookup_ipc_disconnected"; void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {}); } });
  child.on("message", message => {
    if (busy) { failure = "lookup_ipc_invalid"; void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {}); return; }
    busy = true;
    chain = chain.then(async () => {
      if (stage === "loaded") {
        pilotNeed(message?.type === "loaded", "lookup_ipc_invalid");
        if (preparation) await preparationAssigned; else await journal.assign(index, owned);
        stage = "ready";
        child.send({ pilot, runId: state.runId, outputRoot: root, epoch: state.epoch, slotId: slot.slotId, slot, index, timeoutMs,
          cacheKey: journal.snapshot().slots[index].cacheKey, ...(!preparation && state.schema === LOOKUP_REAL_CONTROLLER ? { authorization } : {}), roleRequest: { schema: "lookup-role-request-v1", binding, common: pilot.registration.common, build: code.build },
          plan, scenario: authorization.scenarios?.[index] ?? "settled" });
      } else if (preparation && message?.type === "preparation-failed") {
        pilotNeed(message.epoch === state.epoch && message.slotId === slot.slotId && message.code === "lookup_preparation_invalid", "lookup_ipc_invalid");
        failure = message.code; done = {}; stage = "done"; await stopFailure();
      } else if (!preparation && message?.type === "done" && stage === "ready") {
        pilotNeed(message.epoch === state.epoch && message.slotId === slot.slotId && message.terminal === "refused_pre_send"
          && message.refusalCode === "lookup_preparation_invalid", "lookup_ipc_invalid");
        done = { terminal: message.terminal, score: null, refusalCode: message.refusalCode }; stage = "done";
        try { await journal.stop(message.refusalCode); } finally { if (child.connected) child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId }); }
      } else if (stage === "ready") {
        pilotNeed(message?.type === "ready" && message.epoch === state.epoch && message.slotId === slot.slotId, "lookup_ipc_invalid");
        if (!preparation && state.schema === LOOKUP_REAL_CONTROLLER) await journal.ready(index);
        stage = "running"; child.send({ type: "go", epoch: state.epoch, slotId: slot.slotId });
      } else if (preparation && message?.type === "prepared") {
        pilotNeed(stage === "running" && message.epoch === state.epoch && message.slotId === slot.slotId && pilotHash(message.treeDigest), "lookup_preparation_invalid");
        done = { treeDigest: message.treeDigest }; stage = "done";
        try { await recordProvenMembers(); } finally { if (child.connected) child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId }); }
      } else if (!preparation && message?.type === "done") {
        pilotNeed(stage === "running" && message.epoch === state.epoch && message.slotId === slot.slotId && LOOKUP_SLOT_TERMINALS.includes(message.terminal), "lookup_receipt_invalid");
        done = { terminal: message.terminal, score: message.score, refusalCode: message.refusalCode ?? null }; stage = "done";
        try {
          await recordProvenMembers();
          if (done.terminal === "refused_pre_send" && LOOKUP_GUARD_POLICY_REFUSALS.includes(done.refusalCode)) await journal.stop(done.refusalCode);
        } finally {
          // Release the child even when the journal is broken; never admit another slot.
          if (child.connected) child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId });
        }
      } else {
        pilotNeed(!preparation && stage === "running", "lookup_ipc_invalid");
        const ack = await journal.message(index, child, message); if (child.connected) child.send(ack);
        // Settle-then-contain: permit known usage to arrive, but never leave a stopped group alive until the watchdog.
        if (message.op === "stop" && !settleTimer) settleTimer = setTimeout(() => { void chain.then(() => terminateOwned()).catch(() => {}); }, 250);
      }
    }).catch(async error => {
      failure ??= fixedPilotCode(error.code); await stopFailure().catch(() => {});
      await terminateOwned().catch(() => {});
    }).finally(() => { busy = false; });
  });
  try {
    if (preparation) try { await preparationAssigned; } catch {
      failure = "lookup_preparation_invalid"; await stopFailure(); await terminateOwned(); await exited;
      await journal.finish(index, "lost"); return false;
    }
    await Promise.race([exited, containmentFailure]); clearTimeout(timer); clearTimeout(settleTimer); await chain; if (termination) await termination;
    if (groupAlive(child.pid)) { failure ??= "lookup_worker_lost"; try { await stopFailure(); } finally { await terminateOwned(); } }
    if (groupAlive(child.pid)) { await journal.stop("lookup_unreconciled_processes"); pilotNeed(false, "lookup_unreconciled_processes"); } reconciled = true;
    if (preparation) {
      if (!failure && done?.treeDigest && child.exitCode === 0) {
        try {
          const a = { outputRoot: root, slotId: slot.slotId, slot };
          pilotNeed(await (state.schema === LOOKUP_PREFLIGHT ? lookupPreflightDigest : lookupPreparationDigest)(a) === done.treeDigest, "lookup_preparation_invalid");
          await journal.prepared(index, done.treeDigest); return true;
        } catch { failure = "lookup_preparation_invalid"; }
      }
      failure = failure === "lookup_worker_timeout" ? "lookup_preparation_timeout" : "lookup_preparation_invalid";
      await stopFailure(); await journal.finish(index, "lost"); return false;
    }
    if (failure) await stopFailure();
    const consumed = journal.snapshot().slots[index].holds.at(-1)?.consumed;
    await journal.finish(index, done?.terminal ?? (failure === "lookup_worker_timeout" && consumed ? "own_abort_after_send" : "lost"), done?.score ?? null, done?.refusalCode ?? null);
  } finally {
    clearTimeout(timer); clearTimeout(settleTimer);
    try { if (!reconciled && (!closed || groupAlive(child.pid))) await terminateOwned(); }
    finally { if (child.connected) child.disconnect(); if (containmentFailed) { child.stderr.destroy(); child.unref(); } else await exited; }
  }
}
async function runPilotSchedule(options) {
  const journal = await createLookupPilotController(options);
  try {
    const { outputRoot } = journal;
    for (let i = 0; i < journal.snapshot().schedule.length; i++) {
      const state = journal.snapshot(); if (state.stop) break;
      if (Date.now() >= state.deadlineAt) { await journal.stop("lookup_run_deadline"); break; }
      if (!state.schedule[i].eligible) { await journal.skip(i); continue; }
      if (!await journal.prepare(i)) break;
      await journal.probe(i);
    }
    if (!journal.snapshot().stop) await journal.stop("completed");
    const state = journal.snapshot(), receipts = [];
    for (const name of (await readdir(join(outputRoot, "slots"))).sort()) {
      pilotNeed(/^[a-f0-9]{64}\.json$/u.test(name), "lookup_receipt_invalid"); receipts.push(await readPilotPrivate(join(outputRoot, "slots", name)));
    }
    const report = aggregateLookupPilot(state, receipts); await durable(join(outputRoot, "report.json"), report); return report;
  } finally { journal.release(); }
}

export async function runLookupPilot(options) {
  try { return await runPilotSchedule(options); } catch (error) { publicFailure(error); }
}

/** Non-authorizing preparation parent; never initializes a paid/faux journal. */
export async function runLookupPreparationSlot(journal, pilot, root, index) {
  pilotNeed(journal.snapshot().schema === LOOKUP_PREFLIGHT && (await readPilotPrivate(pilotStatePath(root))).schema === LOOKUP_PREFLIGHT, "lookup_preparation_invalid");
  return runSlot(journal, pilot, { timeoutMs: pilot.descriptor.deadlines.childWatchdogMs }, root, index, true);
}
