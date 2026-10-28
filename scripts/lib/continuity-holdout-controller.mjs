import { DatabaseSync } from "node:sqlite";
import { fork, execFileSync } from "node:child_process";
import { mkdir, open, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { preparationDisposition, preparationUsage } from "./continuity-runner.mjs";
import { digest } from "./continuity-dataset.mjs";
import { externalDirectory, readJson, regularFile, externalFile, sha256, assertCleanTree } from "./continuity-holdout-files.mjs";
import { assertRealHoldoutModels } from "./continuity-holdout-registration.mjs";
import { need, finite, durable, archiveChunk, verifyArchive, chunkUnits, benchmarkArgs, invalidUnit } from "./continuity-holdout-workflow.mjs";

export function authFailure(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => ["failure", "failureKind", "admissionStop", "reason"].includes(key)
    && typeof item === "string" && /provider_auth|usage_limit|unauthorized|invalid_api_key|authentication_error|auth_failed/iu.test(item)
    || item && typeof item === "object" && authFailure(item));
}
export const CONTROLLER_STOPS = ["completed", "auth_failure", "unpriced_reservation", "invalid_unit_rate", "budget_admission", "chunk_deadline", "unreconciled_running_chunks", "dispatch_failure", "archive_verification", "invalid_unit_material"];
export { invalidUnit };
function addUsage(usage, reserve, totals) {
  if (Array.isArray(usage?.components) && usage.components.length > 0) { for (const part of usage.components) addUsage(part, reserve, totals); return; }
  if (!usage?.calls) return;
  const unknown = Math.max(usage.unknownCostCalls ?? 0, usage.unknownTokenCalls ?? 0, usage.conservativeCalls ?? 0,
    [usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd].every(finite) ? 0 : usage.calls);
  if (unknown) {
    totals.unknownCalls += unknown;
    const known = usage.reportedCost?.knownCostUsd;
    if (finite(known)) totals.knownUSD += known;
    if (finite(reserve)) totals.unknownUSD += unknown * reserve; else totals.unpriced++;
  } else totals.knownUSD += usage.estimatedCostUsd;
}
export function accountUnits(units, bundle) {
  const result = { knownUSD: 0, unknownUSD: 0, unknownCalls: 0, unpriced: 0, invalidUnits: 0, authFailure: false, degradedStages: 0 };
  const reader = bundle.prices[bundle.plan.reader.model], upkeep = bundle.prices[bundle.plan.upkeep.model];
  const reserve = reader && bundle.readerLimits ? (bundle.readerLimits.input * reader.reserveInput + bundle.readerLimits.output * reader.reserveOutput) / 1e6 : null;
  for (const unit of units) {
    result.invalidUnits += Number(invalidUnit(unit, bundle.plan)); result.authFailure ||= authFailure(unit);
    const steps = unit.checkpoint?.upkeep?.preparations ?? [];
    for (const step of steps) {
      const usage = preparationUsage(step.receipt, step.journal?.budget === "bootstrap" ? 128000 : 64000, upkeep);
      const unknownReserve = upkeep ? ((step.journal?.budget === "bootstrap" ? 128000 : 64000) * upkeep.input + 4096 * upkeep.output) / 1e6 : null;
      addUsage(usage, unknownReserve, result); result.degradedStages += Number(preparationDisposition(step.receipt) === "degraded");
    }
    for (const trial of unit.trials) if (trial.status !== "not_started") addUsage({ ...trial.usage, calls: trial.usage?.calls || 1 }, reserve, result);
  }
  return result;
}
export function spendOf(chunks, unitsPerChunk) {
  const totals = { knownUSD: 0, unknownUSD: 0, lostUSD: 0, activeUSD: 0, unknownCalls: 0, unpriced: 0, invalidUnits: 0, admittedUnits: chunks.length * unitsPerChunk, authFailure: false };
  for (const chunk of chunks) {
    const a = chunk.accounting;
    for (const key of ["knownUSD", "unknownUSD", "unknownCalls", "unpriced", "invalidUnits"]) totals[key] += a?.[key] ?? 0;
    totals.authFailure ||= a?.authFailure ?? false;
    if (chunk.state === "running") totals.activeUSD += chunk.reservationUsd;
    else if (chunk.state !== "finished") {
      totals.lostUSD += chunk.reservationUsd; // Full hold can deliberately overlap reported partial usage.
      totals.invalidUnits += Math.max(0, unitsPerChunk - (chunk.unitFiles ?? 0));
    }
  }
  totals.totalUSD = totals.knownUSD + totals.unknownUSD + totals.lostUSD + totals.activeUSD;
  return totals;
}
export function stopReason(spend, ceiling, nextReservation = 0) {
  if (spend.authFailure) return "auth_failure";
  if (spend.unpriced) return "unpriced_reservation";
  if (spend.invalidUnits * 10 > spend.admittedUnits) return "invalid_unit_rate";
  if (spend.totalUSD + nextReservation > ceiling) return "budget_admission";
  return null;
}

/** A private POSIX session, never an inherited/shared process group. No unref. */
function groups() {
  return execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).trim().split("\n").map(s => s.trim().split(/\s+/u));
}
export const groupAlive = pid => groups().some(([p, pg, stat]) => Number(pg) === pid && !stat.startsWith("Z") && Number(p) !== process.pid);
export async function terminateGroup(pid) {
  need(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, "unsafe_child_group");
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try { process.kill(-pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
    for (let i = 0; i < 20 && groupAlive(pid); i++) await delay(10);
    if (!groupAlive(pid)) return;
  }
  need(!groupAlive(pid), "unreconciled_running_chunks");
}
function startIdentity(pid) {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
async function lease(root) {
  const path = join(root, "controller-lock.sqlite");
  try { const f = await open(path, "wx", 0o600); await f.close(); } catch (e) { if (e.code !== "EEXIST") throw e; }
  await regularFile(path);
  const db = new DatabaseSync(path);
  try { db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease (id INTEGER); BEGIN IMMEDIATE"); }
  catch { db.close(); throw new Error("controller_locked"); }
  return () => { db.exec("ROLLBACK"); db.close(); };
}
export async function authorize(bundle, path, root) {
  const bytes = await externalFile(path), record = JSON.parse(bytes.toString("utf8"));
  need(record.planDigest === bundle.plan.confirmation && record.ceilingUSD === bundle.ceilingUSD
    && record.authPathFingerprint === bundle.plan.piAuthFingerprint && /^[a-f0-9]{64}$/u.test(record.authPathFingerprint ?? "")
    && typeof record.approver === "string" && record.approver.trim().length > 0 && !/[\u0000-\u001f]/u.test(record.approver)
    && typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)), "authorization_mismatch");
  const claim = { authorizationSha256: sha256(bytes), outputRootSha256: sha256(root) }, claimPath = `${path}.claim`;
  try { await durable(claimPath, claim, true); }
  catch (e) { if (e.code !== "EEXIST") throw e; need(digest(await readJson(claimPath)) === digest(claim), "authorization_already_claimed"); }
  return claim.authorizationSha256;
}

/** Inspect live journals, not model answers or quality gates. Busy reads retain the active hold. */
export async function liveAccounting(root, traceId, bundle) {
  const result = { knownUSD: 0, unknownUSD: 0, unknownCalls: 0, unpriced: 0, invalidUnits: 0, authFailure: false, replacedReserveUSD: 0 };
  for (let repeat = 1; repeat <= bundle.plan.repeats; repeat++) {
    const path = join(root, "work", `cp-${traceId}_ledger-continuity-ledger-cold-r${repeat}`, "work/history/tool-history/tool-lifecycles.sqlite");
    let db;
    try {
      need((await lstat(path)).isFile(), "live_nonregular_journal"); db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare("SELECT reservation,outcome,state FROM continuity_upkeep_operations").all(); let bad = rows.filter(r => !["reserved", "released"].includes(r.state)).length > 3, bootstraps = 0;
      for (const row of rows) {
        if (["reserved", "released"].includes(row.state)) continue;
        const reservation = JSON.parse(row.reservation), receipt = row.outcome ? JSON.parse(row.outcome) : { status: "uncertain", reason: "dispatch_or_outcome_unacknowledged" };
        if (reservation.budget === "bootstrap") bootstraps++;
        bad ||= bootstraps > 1 || !["bootstrap", "incremental"].includes(reservation.budget);
        result.authFailure ||= authFailure(receipt); bad ||= preparationDisposition(receipt) === "integrity";
        const price = bundle.prices[bundle.plan.upkeep.model], input = reservation.budget === "bootstrap" ? 128000 : 64000;
        if (price) result.replacedReserveUSD += (input * price.input + 4096 * price.output) / 1e6;
        addUsage(preparationUsage(receipt, input, price), price ? (input * price.input + 4096 * price.output) / 1e6 : null, result);
      }
      result.invalidUnits += Number(bad);
    } catch (error) {
      if (error.code !== "ENOENT" && !String(error.code).startsWith("ERR_SQLITE")) throw error;
    } finally { db?.close(); }
  }
  return result;
}

async function dispatch({ argv, onReady, poll, deadlineMs, workerURL, env }) {
  const child = fork(workerURL ?? new URL("../continuity-holdout/worker.mjs", import.meta.url), [], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...env, NODE_OPTIONS: "" }, execArgv: [],
  });
  let closed = false, reason = null;
  const exit = new Promise(resolveExit => child.once("close", (code, signal) => { closed = true; resolveExit({ code, signal }); }));
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("child_start_deadline")), 10000);
      child.once("message", message => { clearTimeout(timeout); message?.ready === true ? resolveReady() : reject(new Error("child_handshake")); });
      child.once("error", e => { clearTimeout(timeout); reject(e); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("child_early_exit")); });
    });
    await onReady(child.pid, startIdentity(child.pid)); // Durable PID+reservation before the start token.
    const started = new Promise((resolveStarted, reject) => {
      const timeout = setTimeout(() => reject(new Error("child_start_deadline")), 10000);
      child.once("message", message => { clearTimeout(timeout); message?.started === true ? resolveStarted() : reject(new Error("child_handshake")); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("child_early_exit")); });
    });
    child.send({ argv }); await started;
    const deadline = Date.now() + deadlineMs;
    while (!closed) {
      reason = Date.now() >= deadline ? "chunk_deadline" : await poll();
      if (reason) { await terminateGroup(child.pid); break; }
      await Promise.race([exit, delay(50)]);
    }
    const status = await exit;
    if (groupAlive(child.pid)) { reason ??= "unreconciled_running_chunks"; await terminateGroup(child.pid); }
    return { ...status, reason };
  } finally {
    if (child.pid && (!closed || groupAlive(child.pid))) await terminateGroup(child.pid);
    if (child.connected) child.disconnect(); await exit;
  }
}
export async function runController(context, { shard, output, authorizationPath, deadlineMs = 1500000, concurrency = 4, workerURL, env = process.env }) {
  need(process.platform !== "win32", "posix_controller_required");
  need(!Object.hasOwn(env, "CI"), "paid_mode_refused_in_ci");
  need(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 8, "invalid_controller_limits");
  need(typeof authorizationPath === "string", "authorization_required");
  const bundle = context.plans.find(p => p.plan.holdout.shard === shard); need(bundle, "invalid_shard");
  assertRealHoldoutModels(bundle.plan.holdout.models); assertCleanTree();
  output = await externalDirectory(output, true);
  const unlock = await lease(output), path = join(output, "controller.json"), expectedUnits = bundle.plan.repeats * bundle.plan.arms.length;
  let state;
  try {
    const authorizationSha256 = await authorize(bundle, authorizationPath, output);
    try { state = await readJson(path); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (state) need(state.schema === "holdout-controller-v1" && state.shard === shard && Array.isArray(state.chunks)
      && state.chunks.length <= bundle.chunks.length && state.chunks.every((c, i) => c.traceId === bundle.chunks[i].traceId && c.reservationUsd === bundle.chunks[i].reservationUsd)
      && state.binding === digest(bundle) && state.authorizationSha256 === authorizationSha256, "controller_binding_mismatch");
    else {
      const existing = await readdir(output); need(existing.every(n => n.startsWith("controller-lock.sqlite")), "nonempty_controller_output");
      state = { schema: "holdout-controller-v1", shard, binding: digest(bundle), authorizationSha256,
        accounting: "catalog accounting, not an invoice; Codex stream_abort cannot guarantee containment", deadlineMs, concurrency, chunks: [], stop: null };
    }
    const save = async () => { state.spend = spendOf(state.chunks, expectedUnits); await durable(path, state); };
    const stop = async reason => { state.stop = { reason, reconciled: true }; await save(); };
    for (const [index, chunk] of state.chunks.entries()) if (chunk.state === "running") {
      if (chunk.pid && groupAlive(chunk.pid)) {
        // A new controller has no live child handle: even a matching ps timestamp
        // is not authority to signal a potentially reused PID/session.
        state.stop = { reason: "unreconciled_running_chunks", reconciled: false }; await save(); throw new Error("unreconciled_running_chunks");
      }
      chunk.state = "lost";
      const directory = join(output, "chunks", String(index + 1));
      let units;
      try { units = await chunkUnits(directory, bundle.plan, chunk.traceId); }
      catch { units = []; chunk.integrityError = "invalid_unit_material"; }
      chunk.unitFiles = units.length; chunk.accounting = accountUnits(units, bundle);
      try {
        try { chunk.archiveSha256 = sha256(await regularFile(join(directory, "archive.json"))); await verifyArchive(directory, chunk.archiveSha256); }
        catch (e) { if (e.code !== "ENOENT") throw e; chunk.archiveSha256 = await archiveChunk(directory); }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      await stop(chunk.integrityError ?? "unreconciled_running_chunks");
    }
    for (const [index, chunk] of state.chunks.entries()) if (chunk.archiveSha256) {
      try {
        const directory = join(output, "chunks", String(index + 1)); await verifyArchive(directory, chunk.archiveSha256);
        const units = chunk.integrityError ? [] : await chunkUnits(directory, bundle.plan, chunk.traceId), accounting = accountUnits(units, bundle);
        const matches = digest(accounting) === digest(chunk.accounting) && units.length === chunk.unitFiles;
        chunk.accounting = accounting; chunk.unitFiles = units.length; need(matches, "accounting_mismatch");
      } catch { chunk.state = "failed"; await stop("archive_verification"); return state; }
    }
    if (state.stop) { await save(); return state; } // No automatic readmission, even after restart.
    if (!context.plans.every(p => p.admissible)) { await stop(context.plans.some(p => !p.priced || p.estimate.status === "unknown_price") ? "unpriced_reservation" : "budget_admission"); return state; }
    for (let index = state.chunks.length; index < bundle.chunks.length; index++) {
      const next = bundle.chunks[index], before = spendOf(state.chunks, expectedUnits);
      const reason = stopReason(before, bundle.ceilingUSD, next.reservationUsd);
      if (reason) { await stop(reason); return state; }
      const directory = join(output, "chunks", String(index + 1)); await mkdir(directory, { recursive: true, mode: 0o700 });
      need((await readdir(directory)).length === 0, "existing_chunk_no_retry");
      const chunk = { ...next, state: "running", pid: null }; state.chunks.push(chunk); await save();
      let outcome;
      try {
        outcome = await dispatch({ deadlineMs, workerURL, env, argv: [...benchmarkArgs(context, shard), "--real", "--confirm-plan", bundle.plan.confirmation,
          "--pi-auth-path", context.options.piAuthPath, "--output", directory, "--trace", chunk.traceId, "--concurrency", String(concurrency), "--keep-work", "--capture-upkeep-output"],
          onReady: async (pid, identity) => { need(identity, "child_identity_missing"); chunk.pid = pid; chunk.processIdentity = identity; await save(); },
          poll: async () => {
            const live = await liveAccounting(directory, chunk.traceId, bundle);
            const spend = { ...before, admittedUnits: before.admittedUnits + expectedUnits, invalidUnits: before.invalidUnits + live.invalidUnits,
              authFailure: before.authFailure || live.authFailure, unpriced: before.unpriced + live.unpriced,
              totalUSD: before.totalUSD + Math.max(next.reservationUsd, next.reservationUsd + live.knownUSD + live.unknownUSD - live.replacedReserveUSD) };
            return stopReason(spend, bundle.ceilingUSD);
          } });
      } catch (error) {
        if (error.message === "unreconciled_running_chunks") { state.stop = { reason: error.message, reconciled: false }; await save(); throw error; }
        outcome = { code: null, reason: error.message === "child_start_deadline" ? "chunk_deadline" : "dispatch_failure" };
      }
      let units;
      try { units = await chunkUnits(directory, bundle.plan, chunk.traceId); }
      catch { units = []; chunk.integrityError = "invalid_unit_material"; }
      chunk.unitFiles = units.length; chunk.accounting = accountUnits(units, bundle);
      chunk.state = outcome.reason ? "killed" : [0, 1].includes(outcome.code) && units.length === expectedUnits && units.every(u => !invalidUnit(u, bundle.plan)) ? "finished" : "failed";
      chunk.exitCode = outcome.code; chunk.stopReason = outcome.reason;
      try { chunk.archiveSha256 = await archiveChunk(directory); await verifyArchive(directory, chunk.archiveSha256); }
      catch { chunk.state = "failed"; outcome.reason = "archive_verification"; }
      await save();
      const after = chunk.integrityError ?? outcome.reason ?? stopReason(state.spend, bundle.ceilingUSD);
      if (after) { await stop(after); return state; }
    }
    await stop("completed"); return state;
  } finally { unlock(); }
}
