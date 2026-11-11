// E2 registration policy only. No authorization creation, consumption, model calls or builds.
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { digest as hash, validateSource } from "./continuity-recorded-schema.mjs";
import { digest } from "./continuity-dataset.mjs";
import { ROOT } from "./continuity-observation-input.mjs";
import { validateProtocol, assertE2ProbeLookupRounds } from "./continuity-e2-protocol.mjs";
import { validateE2Questions, scoreE2 } from "./continuity-e2-score.mjs";
import { SHIPPING_SOUL_RAW, SHIPPING_SOUL_NORMALIZED, shippingSoul } from "./continuity-e2-models.mjs";
import { loadE2Catalog } from "./continuity-e2-pricing.mjs";
import { estimateE2SizingSet, normalizeE2Sizing } from "./continuity-e2-sizing.mjs";
import { requireE2PaidRole } from "./continuity-e2-roles.mjs";
import { E2_REGISTRATION_SCHEMA, E2_PLAN_SCHEMA, E2_ASSUMPTIONS, E2_DEADLINE_LIMITS, E2_PHASE_DOMAIN, E2_INPUT_LIMITS } from "./continuity-e2-policy.mjs";
import { E2_RETRY_POLICY } from "./continuity-e2-retry.mjs";
import { LOOKUP_PILOT_PROTOCOL_FILES } from "./continuity-lookup-roles.mjs";
import { BUILD_POLICY, sourceState, verifyRealBuild } from "./memory-e2e-build.mjs";
export const E2_PROTOCOL_FILES = Object.freeze([...new Set([...LOOKUP_PILOT_PROTOCOL_FILES,
  "scripts/continuity-e2.mjs", "pnpm-lock.yaml", "package.json",
  "scripts/lib/continuity-e2-checks.mjs", "scripts/lib/continuity-e2-diagnostics.mjs", "scripts/lib/continuity-e2-estimate.mjs",
  "scripts/lib/continuity-e2-fixture.mjs", "scripts/lib/continuity-e2-isolation.mjs", "scripts/lib/continuity-e2-models.mjs",
  "scripts/lib/continuity-e2-policy.mjs", "scripts/lib/continuity-e2-pricing.mjs", "scripts/lib/continuity-e2-proofs.mjs",
  "scripts/lib/continuity-e2-protocol.mjs", "scripts/lib/continuity-e2-replay.mjs", "scripts/lib/continuity-e2-roles.mjs",
  "scripts/lib/continuity-e2-routes.mjs", "scripts/lib/continuity-e2-score.mjs", "scripts/lib/continuity-e2-sizing.mjs",
  "scripts/lib/continuity-e2-tools.mjs", "scripts/lib/continuity-e2-registration.mjs", "scripts/lib/continuity-e2-authorization.mjs",
  "scripts/lib/continuity-e2-guarded-protocol.mjs", "scripts/lib/continuity-e2-lineage.mjs",
  "scripts/lib/continuity-e2-runtime.mjs",
  "scripts/lib/continuity-e2-paid-models.mjs",
  "scripts/lib/continuity-e2-cause.mjs", "scripts/lib/continuity-e2-retry.mjs", "scripts/lib/continuity-e2-progress.mjs",
  "scripts/lib/continuity-e2-phase-child.mjs",
  "scripts/lib/continuity-e2-paid-entry.mjs",
])].sort());
const need = ok => { if (!ok) throw Object.assign(Error("e2_registration_invalid"), { code: "e2_registration_invalid" }); };
const fields = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...names].sort().join();
const integer = n => Number.isSafeInteger(n) && n >= 0;
const sha = s => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
export const e2CapUnits = value => { need(typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/u.test(value)); return BigInt(value); };
export function validateE2Deadlines(d) {
  if (!(fields(d, ["requestDeadlineMs", "phaseDeadlineMs", "childWatchdogMs", "runDeadlineMs"]) && Object.values(d).every(n => integer(n) && n > 0)
    && d.requestDeadlineMs <= E2_DEADLINE_LIMITS.requestMs && d.phaseDeadlineMs >= d.requestDeadlineMs && d.phaseDeadlineMs <= E2_DEADLINE_LIMITS.phaseMs
    && d.childWatchdogMs >= d.requestDeadlineMs && d.childWatchdogMs <= d.phaseDeadlineMs && d.childWatchdogMs <= E2_DEADLINE_LIMITS.childWatchdogMs
    && d.runDeadlineMs >= d.phaseDeadlineMs && d.runDeadlineMs <= E2_DEADLINE_LIMITS.runMs))
    throw Object.assign(Error("e2_deadlines_invalid"), { code: "e2_deadlines_invalid" });
}
export async function e2CodeDigest(root = ROOT) {
  need(root === ROOT && await realpath(root) === root);
  return digest(await Promise.all(E2_PROTOCOL_FILES.map(async file => { const path = join(root, file); need(await realpath(path) === path); return [file, hash(await readFile(path))]; })));
}
export async function verifyE2Code(code, build) {
  need(fields(code, ["path", "revision", "sha256"]) && code.path === ROOT && /^[a-f0-9]{40}$/u.test(code.revision) && sha(code.sha256));
  const before = sourceState(ROOT); need(!before.dirty && before.head === code.revision);
  need(fields(build, ["policy", "sourceHead", "command", "packages", "outputRoots", "outputSha256", "node"])
    && build.policy === BUILD_POLICY && build.sourceHead === code.revision && sha(build.outputSha256) && build.node === process.version
    && same(build.command, ["pnpm", "--filter", "@mono-agent/app...", "run", "build"])
    && Array.isArray(build.packages) && build.packages.includes("packages/app") && new Set(build.packages).size === build.packages.length
    && build.packages.every(p => /^(packages|extras)\/[a-z0-9-]+$/u.test(p)) && same(build.outputRoots, build.packages.map(p => `${p}/dist`)));
  await verifyRealBuild(ROOT, build); need(await e2CodeDigest(ROOT) === code.sha256);
  const after = sourceState(ROOT); need(!after.dirty && after.head === before.head);
}
export function e2ProbeCounts(protocol, questions, evaluator, source) {
  assertE2ProbeLookupRounds(protocol?.probeLookupRounds);
  validateE2Questions(questions);
  need(fields(evaluator, ["schema", "keys"]) && evaluator.schema === "continuity-recorded-evaluator-keys-v1" && Array.isArray(evaluator.keys) && evaluator.keys.length === questions.questions.length);
  if (evaluator.keys.length) scoreE2({ schema: "continuity-e2-answers-v1", answers: [] }, evaluator);
  const checkpoints = protocol.branches.flatMap(b => b.checkpoints), counts = checkpoints.map((_, checkpoint) => ({ checkpoint, questions: 0, lookupRounds: protocol.probeLookupRounds }));
  const ids = new Set();
  for (const q of questions.questions) {
    need(Buffer.byteLength(q.prompt) <= E2_INPUT_LIMITS.promptBytes);
    const matches = checkpoints.flatMap((c, i) => c.name === q.checkpoint ? [i] : []), key = evaluator.keys.find(k => k.id === q.id);
    need(matches.length === 1 && key?.checkpoint === q.checkpoint && !ids.has(q.id)); ids.add(q.id);
    need(key.dependsOnSteps.every(n => n < source.steps.length) && (key.dependsOnCoverage ?? []).every(n => n < source.coverage.length));
    counts[matches[0]].questions++;
  }
  return counts;
}
export function e2PhaseSchedule(protocol, records, probeCounts) {
  const phases = [], replays = [], proofs = [], seen = new Set();
  let offset = records.some(r => r.schema === "continuity-e2-sizing-v1") ? protocol.branches.reduce((n, b) => n + b.checkpoints.length, 0) : 0;
  for (const record of records) {
    const n = normalizeE2Sizing(protocol, record, record.schema === "continuity-e2-sizing-v1" ? 0 : offset);
    if (n.kind === "replay") { need(!seen.has(n.scenario)); seen.add(n.scenario); replays.push(n.requests); }
    else { need(!seen.has(n.arm)); seen.add(n.arm); proofs.push({ record, normalized: n }); offset += n.checkpoints; }
  }
  const budgets = rows => {
    const values = new Map();
    for (const row of rows) if (row.paidRole !== null) {
      const id = digest([row.checkpoint, row.paidRole, row.model]);
      if (!values.has(id)) values.set(id, { checkpoint: row.checkpoint, paidRole: row.paidRole, model: row.model, maxRequests: 0 });
      values.get(id).maxRequests++;
    }
    return [...values.values()].sort((a, b) => a.checkpoint - b.checkpoint || a.paidRole.localeCompare(b.paidRole) || a.model.localeCompare(b.model));
  };
  if (replays.length) {
    need(probeCounts.length === protocol.branches.reduce((n, b) => n + b.checkpoints.length, 0));
    const max = new Map();
    for (const rows of replays) for (const b of budgets(rows)) {
      const count = ["probe", "continuation"].includes(b.paidRole) ? b.maxRequests * probeCounts[b.checkpoint].questions : b.maxRequests;
      const id = digest([b.checkpoint, b.paidRole, b.model]); max.set(id, { ...b, maxRequests: Math.max(max.get(id)?.maxRequests ?? 0, count) });
    }
    phases.push({ kind: "replay", arm: "replay", variant: "registered", phase: "whole", budgets: [...max.values()].filter(b => b.maxRequests) });
  }
  for (const { record, normalized } of proofs.sort((a, b) => ["switch", "cancel", "idle", "pressure"].indexOf(a.record.arm) - ["switch", "cancel", "idle", "pressure"].indexOf(b.record.arm))) {
    let cursor = 0;
    for (const variant of record.variants) {
      const restarted = record.arm === "cancel" || record.arm === "pressure" && variant.variant === "restart";
      const allowed = restarted ? ["seed", "resume"] : ["whole"], perPhase = new Map(allowed.map(p => [p, []]));
      for (const raw of variant.requests) {
        requireE2PaidRole(raw);
        if (!Object.hasOwn(raw, "phase")) throw Object.assign(Error("E2_SIZING_PHASE_REQUIRED"), { code: "E2_SIZING_PHASE_REQUIRED" });
        need(allowed.includes(raw.phase)); perPhase.get(raw.phase).push(normalized.requests[cursor++]);
      }
      for (const phase of allowed) phases.push({ kind: "proof", arm: record.arm, variant: variant.variant, phase, budgets: budgets(perPhase.get(phase)) });
    }
  }
  need(phases.length > 0 && phases.length <= E2_INPUT_LIMITS.phases);
  return phases.map((p, index) => ({ ...p, index, slotId: digest([E2_PHASE_DOMAIN, index, p]), eligible: true,
    roleId: "e2-validation-phase", code: "E2", suite: "e2-validation", traceId: String(index), probeId: String(index) }));
}
export const E2_TOOL_POLICIES = Object.freeze({ summary: Object.freeze([]), replay: Object.freeze(["ConversationHistory"]), replayFinal: Object.freeze([]), proof: Object.freeze(["ConversationHistory"]), cancelContinuation: Object.freeze(["ConversationHistory", "ProofSentinel"]) });
export async function validateE2Registration(pilot, { safeRead, safeDirectory }) {
  try {
    need(fields(pilot, ["schema", "registration", "descriptor"]) && pilot.schema === E2_REGISTRATION_SCHEMA);
    const r = pilot.registration, d = pilot.descriptor;
    if (d?.schema !== E2_PLAN_SCHEMA) throw Object.assign(Error("e2_deadlines_invalid"), { code: "e2_deadlines_invalid" });
    validateE2Deadlines(d.deadlines);
    need(fields(r, ["code", "build", "catalog", "protocol", "source", "probes", "keys", "soul", "roles", "schedule", "toolPolicies", "sizing", "probeCounts"])
      && fields(d, ["schema", "assumptions", "capUnits", "deadlines", "retryPolicy"]) && d.schema === E2_PLAN_SCHEMA && same(d.assumptions, E2_ASSUMPTIONS) && same(d.retryPolicy, E2_RETRY_POLICY));
    e2CapUnits(d.capUnits); validateE2Deadlines(d.deadlines);
    await safeDirectory(ROOT, "e2_registration_invalid"); await verifyE2Code(r.code, r.build);
    need(same(r.catalog, await loadE2Catalog()) && same(r.soul, { rawDigest: SHIPPING_SOUL_RAW, normalizedDigest: SHIPPING_SOUL_NORMALIZED }));
    const soul = await shippingSoul(); need(soul.rawDigest === r.soul.rawDigest && soul.normalizedDigest === r.soul.normalizedDigest);
    const paths = new Set();
    const json = async (binding, maxBytes = E2_INPUT_LIMITS.artifactBytes) => {
      need(fields(binding, ["path", "sha256"]) && typeof binding.path === "string" && sha(binding.sha256) && !paths.has(binding.path)); paths.add(binding.path);
      const raw = await safeRead(binding.path, "e2_registration_invalid", maxBytes); need(hash(raw) === binding.sha256);
      return JSON.parse(raw);
    };
    const source = await json(r.source, E2_INPUT_LIMITS.sourceBytes); validateSource(source);
    const protocol = validateProtocol(await json(r.protocol), source), questions = await json(r.probes), evaluator = await json(r.keys);
    const probeCounts = e2ProbeCounts(protocol, questions, evaluator, source); need(same(r.probeCounts, probeCounts) && same(r.toolPolicies, E2_TOOL_POLICIES));
    need(Array.isArray(r.sizing) && r.sizing.length > 0 && r.sizing.length <= E2_INPUT_LIMITS.sizingFiles);
    const records = []; for (const binding of r.sizing) records.push(await json(binding));
    for (const record of records) if (record.schema === "continuity-e2-sizing-v1") need(record.sourceDigest === hash(JSON.stringify(source)) && same(record.soul, r.soul));
    if (records.some(record => record.schema === "continuity-e2-sizing-v1")) need(questions.questions.length > 0);
    const estimate = estimateE2SizingSet({ protocol, roles: r.roles, records, catalog: r.catalog, probeCounts });
    validateE2ReplayLimits(protocol, records);
    need(same(r.schedule, e2PhaseSchedule(protocol, records, probeCounts)));
    const replay = r.schedule.find(p => p.kind === "replay");
    if (replay) {
      let offset = 0;
      for (const branch of protocol.branches) {
        const budgets = replay.budgets.filter(b => b.checkpoint >= offset && b.checkpoint < offset + branch.checkpoints.length);
        need(budgets.filter(b => ["probe", "continuation"].includes(b.paidRole)).reduce((n, b) => n + b.maxRequests, 0) <= branch.limits.probeRequests
          && budgets.filter(b => b.paidRole === "summary").reduce((n, b) => n + b.maxRequests, 0) <= branch.limits.summaryRequests);
        offset += branch.checkpoints.length;
      }
    }
    need(e2CapUnits(d.capUnits) >= BigInt(estimate.forecastMinimumCapUnits));
    return { protocol, questions, source, estimate };
  } catch (error) {
    if (["e2_deadlines_invalid", "E2_OUTPUT_LIMIT_UNENFORCED", "E2_SIZING_PAID_ROLE_REQUIRED", "E2_SIZING_PHASE_REQUIRED"].includes(error?.code)) throw error;
    throw Object.assign(Error("e2_registration_invalid"), { code: "e2_registration_invalid" });
  }
}

export function validateE2ReplayLimits(protocol, records) {
  for (const record of records.filter(r => r.schema === "continuity-e2-sizing-v1")) {
    for (const [index, branch] of record.branches.entries()) {
      const limits = protocol.branches[index].limits, rows = branch.requestSizing, compactions = branch.compactions ?? [];
      need(rows.filter(r => r.paidRole === null).length <= limits.sourceRequests);
      // A replay record sizes two complete probes per checkpoint, regardless of
      // how many real questions will be expanded later. Do not accept an R=1
      // row set relabelled with an R=3 protocol digest.
      const registered = protocol.branches[index];
      need(rows.filter(row => ["probe", "continuation"].includes(row.paidRole)).length === registered.checkpoints.length * 2 * (protocol.probeLookupRounds + 1));
      for (const [checkpoint] of registered.checkpoints.entries()) {
        const probes = rows.filter(row => ["probe", "continuation"].includes(row.paidRole)
          && registered.checkpoints.findIndex(c => c.turn >= row.turn) === checkpoint);
        need(probes.filter(row => row.paidRole === "probe").length === 2
          && probes.filter(row => row.paidRole === "continuation").length === 2 * protocol.probeLookupRounds);
      }
      need(Array.isArray(compactions) && compactions.length <= limits.compactions
        && compactions.every(c => Number.isSafeInteger(c.requests) && c.requests > 0 && c.requests <= limits.summaryRequestsPerCompaction)
        && compactions.reduce((n, c) => n + c.requests, 0) === rows.filter(r => r.paidRole === "summary").length);
    }
  }
}
