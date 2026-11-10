// Shared guarded-run mechanics; historical authority names remain visible to the exact inventory.
import { fork } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, lstat, readdir, open } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { digest } from "./continuity-dataset.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
import { externalDirectory } from "./continuity-holdout-files.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive } from "./continuity-holdout-controller.mjs";
import { lookupProcessStartIdentity, lookupProcessGroupSnapshot } from "./continuity-process-identity.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedLease } from "./continuity-guarded-lease.mjs";
import { guardedSnapshot } from "./continuity-guarded-snapshot.mjs";
import { guardedChildEnvironment } from "./continuity-guarded-child-environment.mjs";
import { guardedAuthorization } from "./continuity-guarded-authorization.mjs";
import { guardedReport } from "./continuity-guarded-report.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";

const instances = new Map();
export function guardedController(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const { statePath: pilotStatePath, sameRun: samePilot, runHash: pilotHash, runId: pilotId, requireFaux: requireFauxPilot } = guardedState(protocolId);
  const deadlinePolicy = protocol.execution?.deadlines;
  const phaseDeadlineAt = (pilot, slot) => deadlinePolicy ? deadlinePolicy.phaseAt(pilot.descriptor.deadlines, slot) : slot.startedAt + pilot.descriptor.deadlines.deadlineMs;
  const requestDeadlineAt = (pilot, hold) => deadlinePolicy ? deadlinePolicy.requestAt(pilot.descriptor.deadlines, hold) : Infinity;
  const LOOKUP_REAL_CONTROLLER = protocol.policy.REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER = protocol.policy.FAUX_CONTROLLER, LOOKUP_PILOT_IPC = protocol.policy.PILOT_IPC;
  const LOOKUP_PREFLIGHT = protocol.policy.PREFLIGHT, LOOKUP_PRE_SEND_REFUSALS = protocol.policy.PRE_SEND_REFUSALS, LOOKUP_GUARD_POLICY_REFUSALS = protocol.policy.GUARD_POLICY_REFUSALS, LOOKUP_SLOT_TERMINALS = protocol.policy.SLOT_TERMINALS, LOOKUP_PILOT_STOPS = protocol.policy.PILOT_STOPS, LOOKUP_GUARD_STOPS = protocol.policy.GUARD_STOPS, LOOKUP_INTEGRITY_STOPS = protocol.policy.INTEGRITY_STOPS;
  const readPilotPrivate = async (...args) => (await protocol.hooks.controllerBindings()).readPrivate(...args);
  const { accountRun: accountLookupPilot, money: lookupMoney, stopReason: lookupPilotStopReason, settleHold: settleLookupHold, priceUsage: priceLookupUsage, need: pilotNeed, fixedCode: fixedPilotCode } = guardedAccounting(protocolId);
  const acquireLookupPilotLease = async (...args) => (await protocol.hooks.controllerBindings()).acquireLease(...args);
  const assertLookupPilotLease = async (...args) => (await protocol.hooks.controllerBindings()).assertLease(...args);
  const { lookupPreflightDigest, lookupPreparationDigest } = guardedSnapshot(protocolId);
  const { childImports: lookupChildImports } = guardedChildEnvironment(protocolId);
  const lookupChildEnvironment = async (...args) => (await protocol.hooks.controllerBindings()).childEnvironment(...args);
  const { aggregateRun: aggregateLookupPilot, slotReceipt: lookupPilotReceipt } = guardedReport(protocolId);
  const { cacheAssignment: assertLookupCacheAssignment, cacheIssuer: issueLookupCacheKey, watchdog: lookupPilotWatchdog, validTimeout: validLookupPilotTimeout } = protocol.hooks;
  async function syncDirectory(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await file.sync(); } finally { await file.close(); }
  }
  async function fauxConsume(authorization, pilot, root, identity, lease) {
    await assertLookupPilotLease(lease, root, identity.controller);
    pilotNeed(Object.keys(authorization).filter(k => k !== "fixtureEndpoint").sort().join() === "authorizationId,outputRoot,pilotSha256,scenarios,schema,timeoutMs"
      && Array.isArray(authorization.scenarios) && authorization.scenarios.every(s => ["settled", "two_rounds", "wrong", "empty", "empty_two_rounds", "lost", "own_abort_after_send", "integrity_stop", "auth", "quota", "input_refusal", "request_limit"].includes(s))
      && pilotId(authorization.authorizationId) && authorization.outputRoot === root && authorization.pilotSha256 === digest(pilot)
      && validLookupPilotTimeout(authorization.timeoutMs, pilot.descriptor.deadlines.childWatchdogMs),
    protocol.codes.pilot_faux_required);
    pilotNeed((await readdir(root)).every(n => n === "controller-lock.sqlite"), protocol.codes.pilot_resume_forbidden);
    const parent = join(dirname(root), protocol.fauxRegistry);
    await mkdir(parent, { mode: 0o700, recursive: true });
    const info = await lstat(parent);
    pilotNeed(info.isDirectory() && info.uid === userInfo().uid && (info.mode & 0o077) === 0, protocol.codes.receipt_invalid);
    await syncDirectory(dirname(parent));
    const entry = join(parent, createHash("sha256").update(protocol.fauxDomain + authorization.authorizationId).digest("hex"));
    try { await mkdir(entry, { mode: 0o700 }); } catch { pilotNeed(false, protocol.codes.authorization_already_consumed); }
    await syncDirectory(parent);
    const claim = { schema: protocol.schemas.fauxConsumption, authorizationId: authorization.authorizationId, ...identity, outputRoot: root, binding: digest(pilot) };
    await durable(join(root, "authorization-consumed.json"), claim, true);
    await durable(join(entry, "claim.json"), claim, true);
  }
  function slotTerminal(slot, claimed = "lost") {
    if (!slot.holds.length) return "unadmitted";
    let terminal = slot.terminal ?? (slot.admissionRefusal ? "refused_pre_send" : claimed);
    if (terminal === "own_abort_after_send" && !slot.holds.at(-1).consumed) terminal = "lost";
    return slot.holds.some(h => !h.settlement) && !["own_abort_after_send", "integrity_stop"].includes(terminal) ? "lost" : terminal;
  }
  async function initializeLookupPilot(options = {}) {
    try { options = structuredClone(options); } catch { pilotNeed(false, protocol.codes.pilot_faux_required); }
    const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    freeze(options);
    const { pilot, authorization, outputRoot, real, authorizationHandle, schedule } = await protocol.hooks.prepareController(options);
    const auth = { consumeAuthorization: async (...args) => (await protocol.hooks.controllerBindings()).consumeAuthorization(...args) };
    const controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
    pilotNeed(typeof controller.startIdentity === "string" && controller.startIdentity.length > 0, protocol.codes.ipc_invalid);
    const lease = await acquireLookupPilotLease(outputRoot), identity = { runId: randomUUID(), controllerEpoch: randomUUID(), controller };
    let state, failed = false, tail = Promise.resolve();
    const path = pilotStatePath(outputRoot), cap = protocol.execution ? protocol.execution.cap(pilot) : lookupMoney(pilot.descriptor.capUSD), reserve = protocol.execution ? 0n : lookupMoney(pilot.descriptor.rmaxUSD);
    const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
    const save = async () => {
      pilotNeed(!failed, protocol.codes.persist_failed);
      state.revision++;
      try {
        await durable(path, state); pilotNeed(samePilot(await readPilotPrivate(path), state), protocol.codes.persist_failed);
        for (const i of new Set([state.cursor, state.cursor - 1])) if (state.slots[i] && (state.slots[i].preparation || state.slots[i].worker || state.slots[i].terminal)) {
          const receipt = lookupPilotReceipt(state, i), receiptPath = join(outputRoot, "slots", `${receipt.slotId}.json`);
          await durable(receiptPath, receipt); pilotNeed(samePilot(await readPilotPrivate(receiptPath), receipt), protocol.codes.persist_failed);
        }
      }
      catch { failed = true; pilotNeed(false, protocol.codes.persist_failed); }
    };
    const check = async () => {
      pilotNeed(!failed, protocol.codes.persist_failed);
      try {
        await assertLookupPilotLease(lease, outputRoot, state.controller);
        pilotNeed(samePilot(await readPilotPrivate(path), state), protocol.codes.persist_failed);
      } catch { failed = true; pilotNeed(false, protocol.codes.persist_failed); }
    };
    const expired = (slot, now = Date.now()) => {
      if (now >= state.deadlineAt) return protocol.codes.run_deadline;
      if (now >= phaseDeadlineAt(pilot, slot)) return protocol.codes.worker_timeout;
      const hold = slot.holds.at(-1);
      return hold && !hold.settlement && now >= requestDeadlineAt(pilot, hold) ? protocol.codes.worker_timeout : null;
    };
    const stop = code => {
      // Unreconciled containment is an absorbing safety escalation, never a reopening.
      if (code === protocol.codes.unreconciled_processes) { state.stop = code; if (state.slots[state.cursor]) state.slots[state.cursor].unreconciled = true; }
      else state.stop ??= fixedPilotCode(code);
      for (const slot of state.slots) for (const hold of slot.holds) if (!hold.consumed && !hold.settlement) hold.revoked = true;
    };
    try {
      if (real) await auth.consumeAuthorization(authorizationHandle, identity, lease);
      else await fauxConsume(authorization, pilot, outputRoot, identity, lease);
      state = { schema: real ? LOOKUP_REAL_CONTROLLER : LOOKUP_FAUX_CONTROLLER, ...(real ? { recovery: false } : {}), ...(!real ? { fauxEndpoint: authorization.fixtureEndpoint ?? null } : {}), binding: digest(pilot), runId: identity.runId, epoch: identity.controllerEpoch,
        controller: identity.controller, ...(protocol.execution ? { capUnits: cap.toString() } : { capUSD: pilot.descriptor.capUSD, rmaxUSD: pilot.descriptor.rmaxUSD }), revision: 0, deadlineAt: Date.now() + pilot.descriptor.deadlines.runDeadlineMs,
        schedule, scheduleSha256: digest(schedule), cursor: 0, stop: null,
        cacheKeysUnique: true, ...protocol.hooks.publicState(pilot),
        slots: schedule.map(slot => ({ slotId: slot.slotId, holds: [], terminal: null, worker: null, cacheKey: issueLookupCacheKey(identity.runId), startedAt: null, nextMessage: 0, lastAck: null, score: null })) };
      assertLookupCacheAssignment(state, { index: 0, cacheKey: state.slots[0].cacheKey });
      await mkdir(join(outputRoot, "slots"), { mode: 0o700 });
      if (protocol.execution) await mkdir(join(outputRoot, protocol.policy.SUMMARY_RESULTS_DIRECTORY), { mode: 0o700 });
      await save();
    } catch (error) { lease.release(); throw error; }
    const api = {
      pilot, authorization, outputRoot,
      snapshot: () => structuredClone(state),
      async prepare(index) { return runSlot(api, pilot, authorization, outputRoot, index, true); },
      async probe(index) { return runSlot(api, pilot, authorization, outputRoot, index); },
      async assignPreparation(index, worker) { return serial(async () => {
        await check(); const slot = state.slots[index];
        pilotNeed(state.schedule[index]?.eligible, protocol.codes.pilot_slot_ineligible);
        pilotNeed(!state.stop && state.cursor === index && !slot.preparation && !slot.worker && !slot.holds.length
          && worker.pid > 1 && worker.pid !== process.pid && worker.startIdentity && worker.startIdentity === lookupProcessStartIdentity(worker.pid), protocol.codes.preparation_invalid);
        slot.preparation = { schema: protocol.schemas.preparationRecord, pid: worker.pid, startIdentity: worker.startIdentity, exited: false }; await save();
      }); },
      async prepared(index, treeDigest) { return serial(async () => {
        await check(); const slot = state.slots[index], p = slot.preparation;
        pilotNeed(!state.stop && state.cursor === index && p && !p.exited && !slot.worker && !slot.holds.length
          && lookupProcessStartIdentity(p.pid) !== p.startIdentity && !groupAlive(p.pid) && pilotHash(treeDigest), protocol.codes.preparation_invalid);
        slot.preparation = { ...p, treeDigest, exited: true }; await save();
      }); },
      release: () => lease.release(),
      async assign(index, worker) { return serial(async () => {
        await check(); pilotNeed(state.schedule[index]?.eligible, protocol.codes.pilot_slot_ineligible);
        pilotNeed(!state.stop && state.cursor === index && !state.slots[index].worker, protocol.codes.ipc_invalid);
        pilotNeed(worker.pid > 1 && worker.pid !== process.pid && typeof worker.startIdentity === "string" && worker.startIdentity.length > 0 && worker.startIdentity === lookupProcessStartIdentity(worker.pid), protocol.codes.ipc_invalid);
        state.slots[index].worker = { pid: worker.pid, startIdentity: worker.startIdentity }; state.slots[index].startedAt = Date.now(); await save();
      }); },
      async recordMembers(index, members, preparation = false) { return serial(async () => {
        await check(); const target = preparation ? state.slots[index].preparation : state.slots[index], worker = preparation ? target : target.worker;
        pilotNeed(worker && members.every(m => m.pid > 1 && m.pid !== worker.pid && m.pgid === worker.pid && typeof m.startIdentity === "string" && m.startIdentity.length > 0), protocol.codes.ipc_invalid);
        target.members = [...new Map([...(target.members ?? []), ...members].map(m => [`${m.pid}:${m.startIdentity}`, m])).values()]; await save();
      }); },
      async ready(index) { return serial(async () => {
        await check(); pilotNeed(state.schema === LOOKUP_REAL_CONTROLLER && state.cursor === index && state.slots[index].worker, protocol.codes.ipc_invalid);
        state.slots[index].ready = true; await save();
      }); },
      async message(index, worker, message) { return serial(async () => {
        await check();
        const slot = state.slots[index]; let deadlineFailure = null;
        try {
          pilotNeed(index === state.cursor && slot.worker?.pid === worker.pid && lookupProcessStartIdentity(worker.pid) === slot.worker.startIdentity
            && message?.version === LOOKUP_PILOT_IPC && message.epoch === state.epoch && message.slotId === slot.slotId
            && message.seq === slot.nextMessage && protocol.policy.PERMIT_CONTRACT.methods.includes(message.op), protocol.codes.ipc_invalid);
          if (deadlinePolicy) { deadlineFailure = expired(slot); pilotNeed(!deadlineFailure, deadlineFailure); }
          const p = message.payload; let result = {};
          if (message.op === "admit") {
            pilotNeed(state.schedule[index]?.eligible, protocol.codes.pilot_slot_ineligible);
            const specific = protocol.execution?.admission(pilot, state.schedule[index], slot, p);
            const lineage = protocol.execution ? await protocol.execution.beforeAdmission(outputRoot, slot.slotId, slot, p, readPilotPrivate, state, pilot) : null;
            if (specific && lineage) Object.assign(specific.metadata, lineage);
            pilotNeed(p && (specific || Object.keys(p).sort().join() === "payloadDigest,requestId,rmax,round,slotId") && p.slotId === slot.slotId
              && typeof p.requestId === "string" && p.requestId === `${state.runId}:${p.round}` && pilotHash(p.payloadDigest)
              && p.round === slot.holds.length + 1 && p.round <= protocol.requestLimit && (specific || p.rmax === pilot.descriptor.rmaxUSD)
              && !slot.terminal && slot.holds.every(h => h.settlement), protocol.codes.permit_invalid);
            const nextReserve = specific?.reserve ?? reserve;
            if (Date.now() >= state.deadlineAt) stop(protocol.codes.run_deadline);
            else if (Date.now() >= phaseDeadlineAt(pilot, slot)) stop(protocol.codes.worker_timeout);
            const reason = lookupPilotStopReason(accountLookupPilot(state.slots), cap, nextReserve);
            if (reason) stop(reason);
            if (state.stop) { slot.admissionRefusal = state.stop; result = { refused: true, code: state.stop === "budget_admission" ? "not_admitted_cap" : protocol.codes.stopped }; }
            else {
              const permitId = randomUUID();
              slot.holds.push({ permitId, requestId: p.requestId, payloadDigest: p.payloadDigest, round: p.round,
                ...specific?.metadata, ...(deadlinePolicy ? { admittedAt: Date.now() } : {}), reservedUnits: nextReserve.toString(), consumed: false, revoked: false, settlement: null });
              result = { epoch: state.epoch, permitId };
            }
          } else if (protocol.execution && message.op === "compaction") {
            pilotNeed(!state.stop, protocol.codes.stopped);
            await protocol.execution.compaction(outputRoot, slot.slotId, state.schedule[index], slot, p, readPilotPrivate, state, pilot);
          } else if (message.op === "stop") {
            pilotNeed(p && Object.keys(p).join() === "code" && LOOKUP_GUARD_STOPS.includes(p.code), protocol.codes.ipc_invalid);
            if ((LOOKUP_INTEGRITY_STOPS.includes(p.code) || p.code === protocol.codes.account_mismatch) && slot.holds.length) slot.terminal = "integrity_stop"; stop(p.code);
          }
          else {
            const hold = slot.holds.find(h => h.permitId === p?.permit?.permitId);
            pilotNeed(hold && p.permit.epoch === state.epoch && !hold.settlement, protocol.codes.permit_invalid);
            if (message.op === "consume") {
              pilotNeed(!state.stop && !hold.revoked && !hold.consumed && p.bodyDigest === hold.payloadDigest && Date.now() < Math.min(state.deadlineAt, phaseDeadlineAt(pilot, slot), requestDeadlineAt(pilot, hold)), protocol.codes.permit_invalid);
              hold.consumed = true;
            } else if (protocol.execution?.verifyBody && message.op === "verifyBody") {
              pilotNeed(!state.stop && !hold.revoked && hold.consumed && slot.holds.at(-1) === hold && !hold.summaryPresence, protocol.codes.permit_invalid);
              try { await protocol.execution.verifyBody(outputRoot, hold, state, index, p); }
              catch (error) { slot.terminal = "integrity_stop"; stop(error.code); result = { refused: true, code: fixedPilotCode(error.code) }; }
            } else {
              try {
                if (real && protocol.execution?.verifyBody && hold.consumed && ["settled", "own_abort_after_send"].includes(p.outcome?.kind))
                  pilotNeed(hold.summaryPresence, protocol.codes.summary_receipt_invalid);
                Object.assign(hold, settleLookupHold(hold, p.outcome, p.rawUsage, p.tier));
              }
              catch (error) {
                // A bad claim must not discard independently computable partial spend.
                if (p.rawUsage !== null) try {
                  const priced = priceLookupUsage(p.rawUsage, p.tier, hold);
                  hold.settlement = { kind: "integrity_stop", code: fixedPilotCode(error.code), rawUsage: priced.rawUsage, tier: priced.tier, knownUnits: priced.units };
                } catch {}
                slot.terminal = "integrity_stop"; throw error;
              }
              if (p.outcome.kind === "integrity_stop") { slot.terminal = "integrity_stop"; stop(p.outcome.code); }
              else if (["lost", "own_abort_after_send"].includes(p.outcome.kind) && slot.terminal !== "integrity_stop") slot.terminal = p.outcome.kind;
              const breach = p.rawUsage?.input_tokens > (protocol.execution ? hold.inputMax : pilot.descriptor.assumptions.inputMax) ? protocol.codes.input_envelope_violated
                : p.rawUsage?.output_tokens > (protocol.execution ? hold.outputMax : pilot.descriptor.assumptions.outputMax) ? protocol.codes.output_envelope_violated
                : BigInt(hold.settlement.knownUnits) > BigInt(hold.reservedUnits) ? protocol.codes.hold_exceeded : null;
              if (breach) { slot.terminal = "integrity_stop"; hold.settlement.kind = "integrity_stop"; hold.settlement.code ??= breach; stop(breach); }
              if (protocol.execution) try { await protocol.execution.verifySettlement(outputRoot, slot.slotId, hold, p.evidence, readPilotPrivate); }
              catch (error) { hold.settlement.kind = "integrity_stop"; hold.settlement.code = fixedPilotCode(error.code); throw error; }
            }
          }
          slot.nextMessage++;
          const ack = { type: "ack", version: LOOKUP_PILOT_IPC, epoch: state.epoch, slotId: slot.slotId, seq: message.seq,
            revision: state.revision + 1, ok: true, result };
          slot.lastAck = ack; await save(); return structuredClone(ack);
        } catch (error) {
          if (deadlineFailure) {
            // Expiry is not malformed IPC. Keep every unsettled reservation and
            // refuse late consume/settle without upgrading it to an integrity stop.
            stop(deadlineFailure); slot.terminal = slotTerminal(slot, "lost"); await save();
            throw Object.assign(new Error(deadlineFailure), { code: deadlineFailure });
          }
          if (protocol.execution && message?.op === "admit" && protocol.policy.ADMISSION_REFUSALS.includes(error.code)) {
            // Capacity/schedule refusals stop admission without reclassifying prior settled work.
            slot.admissionRefusal = error.code; stop(error.code); slot.nextMessage++;
            const ack = { type: "ack", version: LOOKUP_PILOT_IPC, epoch: state.epoch, slotId: slot.slotId, seq: message.seq,
              revision: state.revision + 1, ok: true, result: { refused: true, code: error.code } };
            slot.lastAck = ack; await save(); return structuredClone(ack);
          }
          if (slot.holds.length) slot.terminal = "integrity_stop";
          stop(error.code); await save(); throw Object.assign(new Error(fixedPilotCode(error.code)), { code: fixedPilotCode(error.code) });
        }
      }); },
      async finish(index, terminal, score = null, refusalCode = null) { return serial(async () => {
        await check(); pilotNeed(state.schedule[index]?.eligible, protocol.codes.pilot_slot_ineligible);
        const slot = state.slots[index];
        if (deadlinePolicy && slot) {
          const code = expired(slot); if (code) { stop(code); terminal = "lost"; score = null; }
        }
        if (!slot || state.cursor !== index || !LOOKUP_SLOT_TERMINALS.includes(terminal) || terminal === "unadmitted" || terminal === "skipped"
          || terminal === "refused_pre_send" && !slot?.admissionRefusal && ![...LOOKUP_PRE_SEND_REFUSALS, ...LOOKUP_GUARD_POLICY_REFUSALS].includes(refusalCode) || ![null, 0, 1].includes(score) || refusalCode !== null && ![...LOOKUP_PRE_SEND_REFUSALS, ...LOOKUP_GUARD_POLICY_REFUSALS].includes(refusalCode)) {
          if (slot?.holds.length) slot.terminal = "integrity_stop";
          stop(protocol.codes.ipc_invalid); await save(); pilotNeed(false, protocol.codes.ipc_invalid);
        }
        if (terminal === "refused_pre_send" && refusalCode) slot.guardRefusal = refusalCode;
        if (terminal === "refused_pre_send" && protocol.execution && protocol.policy.ADMISSION_REFUSALS.includes(refusalCode)) {
          // A child may reject its estimate before sending an admit message.
          slot.admissionRefusal ??= refusalCode; stop(refusalCode);
        }
        if (terminal === "refused_pre_send" && LOOKUP_GUARD_POLICY_REFUSALS.includes(refusalCode)) {
          stop(refusalCode); if (slot.holds.length) terminal = "integrity_stop";
        }
        // Account substitution is a safety violation, not a provider-loss observation.
        // Keep the retained settlement contract unchanged while projecting the slot correctly.
        if (state.stop === protocol.codes.account_mismatch && slot.holds.length) slot.terminal = "integrity_stop";
        slot.terminal = slotTerminal(slot, terminal);
        slot.score = ["completed", "wrong"].includes(slot.terminal) ? score : null;
        state.cursor++; const reason = lookupPilotStopReason(accountLookupPilot(state.slots), cap);
        if (reason) stop(reason);
        await save();
      }); },
      async stop(code) { return serial(async () => { await check(); stop(code); await save(); }); },
      async skip(index) { return serial(async () => {
        await check(); pilotNeed(state.cursor === index && !state.schedule[index].eligible, protocol.codes.receipt_invalid);
        state.slots[index].terminal = "skipped"; state.cursor++; await save();
      }); },
    };
    return Object.freeze(api);
  }
  function publicFailure(error) {
    const allowed = [...LOOKUP_PILOT_STOPS, ...(protocol.execution ? [protocol.codes.registration_invalid, protocol.codes.deadlines_invalid] : []), "paid_mode_refused_in_ci", protocol.codes.pilot_real_route_unavailable, protocol.codes.pilot_faux_required, protocol.codes.debug_forbidden, protocol.codes.controller_checkout_mismatch,
      protocol.codes.pilot_no_eligible_slots, protocol.codes.pilot_boundary_required, protocol.codes.authorization_binding_mismatch, protocol.codes.authorization_already_consumed, protocol.codes.authorization_lease_invalid, protocol.codes.pilot_resume_forbidden, protocol.codes.pilot_not_ready];
    pilotNeed(false, allowed.includes(error?.code) ? error.code : protocol.codes.pilot_not_ready);
  }
  async function createLookupPilotController(options) {
    try { return await initializeLookupPilot(options); } catch (error) { publicFailure(error); }
  }
  async function reconcilePilotState(outputRoot) {
    const state = await readPilotPrivate(pilotStatePath(outputRoot));
    pilotNeed([LOOKUP_FAUX_CONTROLLER, LOOKUP_REAL_CONTROLLER].includes(state.schema) && state.scheduleSha256 === digest(state.schedule), protocol.codes.receipt_invalid);
    let live = 0;
    for (const slot of state.slots) {
      const preparationAlive = slot.preparation && !slot.preparation.exited && groupAlive(slot.preparation.pid);
      if (preparationAlive) live++;
      if (slot.worker) {
        const alive = groupAlive(slot.worker.pid); if (alive) live++;
        if (!slot.terminal && (!alive || slot.admissionRefusal)) slot.terminal = slotTerminal(slot);
      } else if (slot.preparation && !preparationAlive && !slot.terminal) slot.terminal = slotTerminal(slot);
    }
    state.stop ??= live ? protocol.codes.unreconciled_processes : protocol.codes.recovery_only;
    // Observation only: a live controller may still be writing this root.
    return { ...aggregateLookupPilot(state, state.slots.flatMap((s, i) => s.preparation || s.worker || s.terminal ? [lookupPilotReceipt(state, i)] : [])), reconciliation: true, unreconciledGroups: live };
  }
  async function reconcileLookupPilot(outputRoot) {
    try { return await reconcilePilotState(outputRoot); } catch (error) { publicFailure(error); }
  }
  async function runSlot(journal, pilot, authorization, root, index, preparation = false) {
    pilotNeed(typeof protocol.children[preparation ? "preparation" : "probe"] === "string", protocol.codes.pilot_real_route_unavailable);
    const state = journal.snapshot(), slot = state.schedule[index];
    // Assignment is persisted after fork; refuse excluded slots before any child setup.
    pilotNeed(slot?.eligible, protocol.codes.pilot_slot_ineligible);
    const { code, binding, plan } = await protocol.hooks.slotRequest(pilot, slot);
    const timeoutMs = lookupPilotWatchdog(authorization, pilot.descriptor.deadlines, state.deadlineAt);
    const preparationHome = join(root, "work", slot.slotId, preparation ? "preparation-home" : "probe-home");
    const env = await lookupChildEnvironment(preparationHome);
    const child = fork(join(code.path, preparation ? protocol.children.preparation : protocol.children.probe), [], {
      cwd: code.path, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: lookupChildImports(), env,
    });
    const owned = { pid: child.pid, startIdentity: lookupProcessStartIdentity(child.pid) };
    child.stderr.resume();
    // Persist even a preparation process that hangs before its loaded handshake.
    const preparationAssigned = preparation ? journal.assignPreparation(index, owned) : null;
    void preparationAssigned?.catch(() => {});
    let closed = false, reconciled = false, done = null, busy = false, failure = null, stage = "loaded", chain = Promise.resolve(), settleTimer, requestTimer, termination, containmentFailed = false, rejectContainment;
    const observedMembers = new Map();
    const stopFailure = () => journal.stop(preparation ? [protocol.codes.worker_timeout, protocol.codes.preparation_timeout].includes(failure) ? protocol.codes.preparation_timeout : protocol.codes.preparation_invalid : failure);
    const containmentFailure = new Promise((_, reject) => { rejectContainment = reject; }); void containmentFailure.catch(() => {});
    const recordProvenMembers = async () => {
      if (child.exitCode !== null || child.signalCode !== null || !owned.startIdentity
        || lookupProcessStartIdentity(owned.pid) !== owned.startIdentity) return;
      const snapshot = lookupProcessGroupSnapshot(owned.pid), identity = owned.startIdentity.replace(/\s+/gu, " ");
      const descendants = snapshot.filter(m => m.pid !== owned.pid && !m.zombie);
      if (descendants.length && snapshot.some(m => m.pid === owned.pid && !m.zombie && m.startIdentity === identity)) {
        for (const m of descendants) observedMembers.set(`${m.pid}:${m.startIdentity}`, m);
        try { await journal.recordMembers(index, descendants, preparation); }
        catch { failure ??= protocol.codes.persist_failed; } // No grant may follow, but containment must remain live.
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
          if (!leaderProven && !descendantProven) { pilotNeed(!groupAlive(owned.pid), protocol.codes.unreconciled_processes); return; }
          try { process.kill(-owned.pid, signal); } catch (error) { if (!groupAlive(owned.pid)) return; throw error; }
          for (let i = 0; i < 20 && groupAlive(owned.pid); i++) await delay(10);
        }
        pilotNeed(!groupAlive(owned.pid), protocol.codes.unreconciled_processes);
      }
      catch {
        containmentFailed = true;
        const error = Object.assign(new Error(protocol.codes.unreconciled_processes), { code: protocol.codes.unreconciled_processes });
        try { await journal.stop(protocol.codes.unreconciled_processes); } catch {}
        finally { rejectContainment(error); }
        throw error;
      }
    })();
    const exited = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
    const armRequestTimer = () => {
      if (!deadlinePolicy || preparation) return;
      clearTimeout(requestTimer);
      const current = journal.snapshot(), active = current.slots[index].holds.at(-1);
      if (current.stop || !active || active.settlement) return;
      const at = requestDeadlineAt(pilot, active);
      requestTimer = setTimeout(() => {
        const fresh = journal.snapshot(), hold = fresh.slots[index].holds.at(-1);
        if (fresh.stop || !hold || hold.permitId !== active.permitId || hold.settlement) return;
        failure ??= Date.now() >= fresh.deadlineAt ? protocol.codes.run_deadline : protocol.codes.worker_timeout;
        void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {});
      }, Math.max(1, at - Date.now()));
    };
    const timer = setTimeout(() => { failure ??= deadlinePolicy && Date.now() >= state.deadlineAt ? protocol.codes.run_deadline : protocol.codes.worker_timeout; void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {}); }, timeoutMs);
    child.on("error", () => { failure ??= protocol.codes.worker_lost; });
    child.on("disconnect", () => { if (!done) { failure ??= protocol.codes.ipc_disconnected; void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {}); } });
    child.on("message", message => {
      if (busy) { failure = protocol.codes.ipc_invalid; void stopFailure().catch(() => {}).then(terminateOwned).catch(() => {}); return; }
      busy = true;
      chain = chain.then(async () => {
        if (stage === "loaded") {
          pilotNeed(message?.type === "loaded", protocol.codes.ipc_invalid);
          if (preparation) await preparationAssigned; else await journal.assign(index, owned);
          stage = "ready";
          child.send({ pilot, runId: state.runId, outputRoot: root, epoch: state.epoch, slotId: slot.slotId, slot, index, timeoutMs,
            cacheKey: journal.snapshot().slots[index].cacheKey, ...(!preparation && state.schema === LOOKUP_REAL_CONTROLLER ? { authorization } : {}), roleRequest: protocol.hooks.roleRequest(pilot, binding, code),
            plan, scenario: authorization.scenarios?.[index] ?? "settled" });
        } else if (preparation && message?.type === "preparation-failed") {
          pilotNeed(message.epoch === state.epoch && message.slotId === slot.slotId && message.code === protocol.codes.preparation_invalid, protocol.codes.ipc_invalid);
          failure = message.code; done = {}; stage = "done"; await stopFailure();
        } else if (!preparation && message?.type === "done" && stage === "ready") {
          pilotNeed(message.epoch === state.epoch && message.slotId === slot.slotId && message.terminal === "refused_pre_send"
            && message.refusalCode === protocol.codes.preparation_invalid, protocol.codes.ipc_invalid);
          done = { terminal: message.terminal, score: null, refusalCode: message.refusalCode }; stage = "done";
          try { await journal.stop(message.refusalCode); } finally { if (child.connected) child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId }); }
        } else if (stage === "ready") {
          pilotNeed(message?.type === "ready" && message.epoch === state.epoch && message.slotId === slot.slotId, protocol.codes.ipc_invalid);
          if (!preparation && state.schema === LOOKUP_REAL_CONTROLLER) await journal.ready(index);
          stage = "running"; child.send({ type: "go", epoch: state.epoch, slotId: slot.slotId });
        } else if (preparation && message?.type === "prepared") {
          pilotNeed(stage === "running" && message.epoch === state.epoch && message.slotId === slot.slotId && pilotHash(message.treeDigest), protocol.codes.preparation_invalid);
          done = { treeDigest: message.treeDigest }; stage = "done";
          try { await recordProvenMembers(); } finally { if (child.connected) child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId }); }
        } else if (!preparation && message?.type === "done") {
          pilotNeed(stage === "running" && message.epoch === state.epoch && message.slotId === slot.slotId && LOOKUP_SLOT_TERMINALS.includes(message.terminal), protocol.codes.receipt_invalid);
          done = { terminal: message.terminal, score: message.score, refusalCode: message.refusalCode ?? null }; stage = "done";
          try {
            await recordProvenMembers();
            if (done.terminal === "refused_pre_send" && LOOKUP_GUARD_POLICY_REFUSALS.includes(done.refusalCode)) await journal.stop(done.refusalCode);
          } finally {
            // Release the child even when the journal is broken; never admit another slot.
            if (child.connected) child.send({ type: "done-ack", epoch: state.epoch, slotId: slot.slotId });
          }
        } else {
          pilotNeed(!preparation && stage === "running", protocol.codes.ipc_invalid);
          const ack = await journal.message(index, child, message); armRequestTimer(); if (child.connected) child.send(ack);
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
        failure = protocol.codes.preparation_invalid; await stopFailure(); await terminateOwned(); await exited;
        await journal.finish(index, "lost"); return false;
      }
      await Promise.race([exited, containmentFailure]); clearTimeout(timer); clearTimeout(settleTimer); clearTimeout(requestTimer); await chain; if (termination) await termination;
      if (groupAlive(child.pid)) { failure ??= protocol.codes.worker_lost; try { await stopFailure(); } finally { await terminateOwned(); } }
      if (groupAlive(child.pid)) { await journal.stop(protocol.codes.unreconciled_processes); pilotNeed(false, protocol.codes.unreconciled_processes); } reconciled = true;
      if (preparation) {
        if (!failure && done?.treeDigest && child.exitCode === 0) {
          try {
            const a = { outputRoot: root, slotId: slot.slotId, slot };
            pilotNeed(await (state.schema === LOOKUP_PREFLIGHT ? lookupPreflightDigest : lookupPreparationDigest)(a) === done.treeDigest, protocol.codes.preparation_invalid);
            await journal.prepared(index, done.treeDigest); return true;
          } catch { failure = protocol.codes.preparation_invalid; }
        }
        failure = failure === protocol.codes.worker_timeout ? protocol.codes.preparation_timeout : protocol.codes.preparation_invalid;
        await stopFailure(); await journal.finish(index, "lost"); return false;
      }
      if (failure) await stopFailure();
      const consumed = journal.snapshot().slots[index].holds.at(-1)?.consumed;
      await journal.finish(index, done?.terminal ?? (failure === protocol.codes.worker_timeout && consumed ? "own_abort_after_send" : "lost"), done?.score ?? null, done?.refusalCode ?? null);
    } finally {
      clearTimeout(timer); clearTimeout(settleTimer); clearTimeout(requestTimer);
      try { if (!reconciled && (!closed || groupAlive(child.pid))) await terminateOwned(); }
      finally { if (child.connected) child.disconnect(); if (containmentFailed) { child.stderr.destroy(); child.unref(); } else await exited; }
    }
  }
  async function runPilotSchedule(options) {
    // A registered kernel is not a runnable phase adapter. Refuse before lease or consumption.
    pilotNeed(typeof protocol.children.probe === "string", protocol.codes.pilot_real_route_unavailable);
    protocol.hooks.beforeSchedule?.(options);
    const journal = await createLookupPilotController(options);
    try {
      const { outputRoot } = journal;
      for (let i = 0; i < journal.snapshot().schedule.length; i++) {
        const state = journal.snapshot(); if (state.stop) break;
        if (Date.now() >= state.deadlineAt) { await journal.stop(protocol.codes.run_deadline); break; }
        if (!state.schedule[i].eligible) { await journal.skip(i); continue; }
        if (protocol.children.preparation !== null && !await journal.prepare(i)) break;
        await journal.probe(i);
      }
      if (!journal.snapshot().stop) await journal.stop("completed");
      const state = journal.snapshot(), receipts = [];
      for (const name of (await readdir(join(outputRoot, "slots"))).sort()) {
        pilotNeed(/^[a-f0-9]{64}\.json$/u.test(name), protocol.codes.receipt_invalid); receipts.push(await readPilotPrivate(join(outputRoot, "slots", name)));
      }
      const report = aggregateLookupPilot(state, receipts); await durable(join(outputRoot, "report.json"), report); return report;
    } finally { journal.release(); }
  }
  async function runLookupPilot(options) {
    try { return await runPilotSchedule(options); } catch (error) { publicFailure(error); }
  }
  async function runLookupPreparationSlot(journal, pilot, root, index) {
    pilotNeed(journal.snapshot().schema === LOOKUP_PREFLIGHT && (await readPilotPrivate(pilotStatePath(root))).schema === LOOKUP_PREFLIGHT, protocol.codes.preparation_invalid);
    const timeoutMs = journal.snapshot().timeoutMs;
    pilotNeed(validLookupPilotTimeout(timeoutMs, pilot.descriptor.deadlines.childWatchdogMs), protocol.codes.preparation_invalid);
    return runSlot(journal, pilot, { timeoutMs }, root, index, true);
  }
  return Object.freeze({ createLookupPilotController, reconcileLookupPilot, runLookupPilot, runLookupPreparationSlot });
}
