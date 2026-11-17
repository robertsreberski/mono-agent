// Pack-withheld, probe-only History A/B from one frozen committed E2 snapshot.
// Observational (`qualification: false`), never the release gate. No source
// replay, no paid summaries; the frozen protocol, questions, keys and scorer
// are read-only inputs selected by registered row id.
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fail, ROOT } from "./continuity-observation-input.mjs";
import { digest, validateSource } from "./continuity-recorded-schema.mjs";
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { E2_AB_REPLAY_ARM, E2_AB_ARM_SURFACES, E2_AB_ARMS, e2AbArm, e2AbSlotArm, historyArguments, historyCallScope, historyConfig, historyServerName, historyToolName } from "./continuity-e2-history.mjs";
import { SOL, protocolDigest, validateProtocol, assertE2ProbeLookupRounds } from "./continuity-e2-protocol.mjs";
import { validateE2Questions, scoreE2 } from "./continuity-e2-score.mjs";
import { createE2Models, estimatedReply, loadE2Estimators, shippingSoul } from "./continuity-e2-models.mjs";
import { requireE2PaidRole } from "./continuity-e2-roles.mjs";
import { validateE2Sizing, estimateE2Reservations } from "./continuity-e2-estimate.mjs";
import { E2_RETRY_POLICY } from "./continuity-e2-retry.mjs";
import { E2_PHASE_DOMAIN, E2_INPUT_LIMITS } from "./continuity-e2-policy.mjs";
export { E2_AB_REPLAY_ARM, E2_AB_ARMS, e2AbSlotArm } from "./continuity-e2-history.mjs";
export const E2_AB_BINDING_SCHEMA = "continuity-e2-history-ab-v1";
export const E2_AB_SIZING_SCHEMA = "continuity-e2-ab-sizing-v1";
export const E2_AB_RUN_SCHEMA = "continuity-e2-ab-run-v1";
export const E2_AB_LOOKUPS_SCHEMA = "continuity-e2-ab-lookups-v1";
export const E2_AB_PROBE_PROMPT = "Use retained conversation evidence to continue safely. Do not perform effects.";
const need = (ok, code = "E2_AB_BINDING_INVALID") => { if (!ok) fail(code); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fields = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const ordinal = n => Number.isSafeInteger(n) && n >= 0;
const sha = s => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const rowId = s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(s);
const same = (a, b) => a !== undefined && b !== undefined && canonicalDigest(a) === canonicalDigest(b);

/** Expected offered surface for one arm, recomputed from the bound build. */
export async function e2AbArmContract(letter) {
  const spec = E2_AB_ARM_SURFACES[e2AbArm(letter)];
  const soul = await shippingSoul(spec.historySurface);
  let description;
  try {
    if (spec.historySurface === "unified") {
      const { historyDescription } = await import(new URL("../../packages/app/dist/request-tools/history.js", import.meta.url).href);
      const { resolveHistoryScopes } = await import(new URL("../../packages/app/dist/request-tools/history-policy.js", import.meta.url).href);
      // The E2 composition offers every scope: said follows continuity, tools/runs are always on.
      description = historyDescription(resolveHistoryScopes({ allowedTools: ["History"] }, { said: true, tools: true, runs: true }), { variant: spec.descriptionVariant });
    } else description = (await import(new URL("../../packages/app/dist/request-tools/conversation-history.js", import.meta.url).href)).CONVERSATION_HISTORY_DESCRIPTION;
  } catch { fail("E2_ESTIMATOR_BUILD_REQUIRED"); }
  need(typeof description === "string" && description.length > 0, "E2_ESTIMATOR_BUILD_REQUIRED");
  return { arm: letter, historySurface: spec.historySurface, ...(spec.descriptionVariant ? { descriptionVariant: spec.descriptionVariant } : {}),
    toolName: historyToolName(spec.historySurface), soul: { rawDigest: soul.rawDigest, normalizedDigest: soul.normalizedDigest },
    description: { sha256: digest(description), bytes: Buffer.byteLength(description) } };
}
export async function assertE2AbArmContracts(historyAb) {
  for (const arm of historyAb.arms) need(same(arm, await e2AbArmContract(arm.arm)));
}
/** Synchronous shape check; arm contracts and the frozen tree are checked separately. */
export function assertE2HistoryAbBinding(historyAb) {
  need(fields(historyAb, ["schema", "frozen", "arms", "rows", "primary"]) && historyAb.schema === E2_AB_BINDING_SCHEMA);
  const f = historyAb.frozen;
  need(fields(f, ["replay", "snapshot", "branch", "checkpoint", "receipt"]) && fields(f.replay, ["path", "sha256"])
    && typeof f.replay.path === "string" && isAbsolute(f.replay.path) && sha(f.replay.sha256)
    && typeof f.snapshot === "string" && isAbsolute(f.snapshot) && [0, 1].includes(f.branch) && ordinal(f.checkpoint) && f.checkpoint < 48
    && fields(f.receipt, ["digest", "files"]) && sha(f.receipt.digest) && Number.isSafeInteger(f.receipt.files) && f.receipt.files > 0);
  need(Array.isArray(historyAb.arms) && historyAb.arms.length > 0 && historyAb.arms.length <= E2_AB_ARMS.length
    && historyAb.arms.every((a, i) => object(a) && E2_AB_ARMS.includes(a.arm) && (i === 0 || E2_AB_ARMS.indexOf(a.arm) > E2_AB_ARMS.indexOf(historyAb.arms[i - 1].arm))));
  need(Array.isArray(historyAb.rows) && historyAb.rows.length > 0 && historyAb.rows.length <= 48 && historyAb.rows.every(rowId) && new Set(historyAb.rows).size === historyAb.rows.length
    && Array.isArray(historyAb.primary) && historyAb.primary.every(id => historyAb.rows.includes(id)) && new Set(historyAb.primary).size === historyAb.primary.length);
  return historyAb;
}
export const e2AbArmLetters = historyAb => historyAb.arms.map(a => a.arm);
/** Rows are bound to the registration; sizing is row-blind and binds only the frozen tree and arms. */
export const e2AbSizingBinding = historyAb => canonicalDigest({ schema: historyAb.schema, frozen: historyAb.frozen, arms: historyAb.arms });

export async function e2AbFrozenRecord(historyAb, bytes) {
  bytes ??= await readFile(historyAb.frozen.replay.path);
  need(digest(bytes) === historyAb.frozen.replay.sha256, "E2_SNAPSHOT_MISMATCH");
  try { return JSON.parse(bytes); } catch { fail("E2_AB_BINDING_INVALID"); }
}
// Resolve the frozen checkpoint against the registered protocol/source and the run's replay.json.
export function e2AbFrozenCheckpoint(record, historyAb, { protocol, source } = {}) {
  assertE2HistoryAbBinding(historyAb);
  const { branch, checkpoint } = historyAb.frozen, row = record?.branches?.[branch], cp = row?.checkpoints?.[checkpoint];
  need(record?.schema === "continuity-e2-replay-v1" && sha(record.sourceDigest) && sha(record.protocolDigest) && row?.branch === branch && cp?.checkpoint === checkpoint
    && same(cp.snapshot, historyAb.frozen.receipt) && ordinal(cp.turn) && ordinal(cp.message)
    && Array.isArray(cp.excludedStepsInHistory) && cp.excludedStepsInHistory.every(ordinal)
    && Array.isArray(cp.excludedCoverageInHistory) && cp.excludedCoverageInHistory.every(ordinal));
  if (source) need(record.sourceDigest === digest(JSON.stringify(source)));
  let global = checkpoint, name, model;
  if (protocol) {
    need(record.protocolDigest === protocolDigest(protocol));
    const registered = protocol.branches[branch], c = registered?.checkpoints?.[checkpoint];
    need(c && c.turn === cp.turn && c.message === cp.message);
    global = protocol.branches.slice(0, branch).reduce((n, b) => n + b.checkpoints.length, 0) + checkpoint; name = c.name;
    // Model in effect at the frozen checkpoint, exactly as the replay derived it.
    let index = 0; model = registered.models[0];
    for (const t of registered.transitions.filter(t => t.turn <= cp.turn)) {
      if (t.kind === "cold_model_switch") model = registered.models[++index];
      if (t.kind === "effort_only_non_boundary") model = { ...model, effort: t.effort };
    }
    need(model?.model === SOL && model.effort === "high", "E2_CHECKPOINT_MODEL_INVALID");
  }
  return { branch, checkpoint, global, name, model, turn: cp.turn, message: cp.message,
    excludedSteps: [...cp.excludedStepsInHistory], excludedCoverage: [...cp.excludedCoverageInHistory] };
}
export async function assertE2AbSnapshot(historyAb) {
  const { treeReceipt } = await import("./continuity-e2-replay.mjs");
  let path; try { path = await realpath(historyAb.frozen.snapshot); } catch { fail("E2_SNAPSHOT_PATH_REFUSED"); }
  const s = await lstat(path);
  need(path === historyAb.frozen.snapshot && s.isDirectory(), "E2_SNAPSHOT_PATH_REFUSED");
  need(same(await treeReceipt(path), historyAb.frozen.receipt), "E2_SNAPSHOT_MISMATCH");
}
/** Content-free builder input: paths, ordinals, row ids and arm letters only. */
export async function buildE2HistoryAbBinding({ replayPath, snapshot, branch, checkpoint, rows, primary = [], arms = E2_AB_ARMS }) {
  need(typeof replayPath === "string" && isAbsolute(replayPath) && typeof snapshot === "string" && isAbsolute(snapshot));
  const bytes = await readFile(replayPath), record = JSON.parse(bytes), cp = record?.branches?.[branch]?.checkpoints?.[checkpoint];
  need(object(cp?.snapshot));
  const historyAb = { schema: E2_AB_BINDING_SCHEMA, frozen: { replay: { path: replayPath, sha256: digest(bytes) }, snapshot, branch, checkpoint,
    receipt: { digest: cp.snapshot.digest, files: cp.snapshot.files } }, arms: [], rows: [...rows], primary: [...primary] };
  for (const arm of arms) historyAb.arms.push(await e2AbArmContract(arm));
  assertE2HistoryAbBinding(historyAb); e2AbFrozenCheckpoint(record, historyAb); await assertE2AbSnapshot(historyAb);
  return historyAb;
}
/** Selected rows, in registered order, all at the frozen checkpoint with a frozen key. */
export function e2AbQuestions(questions, evaluator, historyAb, protocol) {
  validateE2Questions(questions); assertE2HistoryAbBinding(historyAb);
  const name = protocol.branches[historyAb.frozen.branch]?.checkpoints?.[historyAb.frozen.checkpoint]?.name;
  need(typeof name === "string" && Array.isArray(evaluator?.keys));
  return historyAb.rows.map(id => {
    const q = questions.questions.find(q => q.id === id), key = evaluator.keys.find(k => k.id === id);
    need(q?.checkpoint === name && key?.checkpoint === name && Buffer.byteLength(q.prompt) <= E2_INPUT_LIMITS.promptBytes);
    return q;
  });
}
export function e2AbProbeCounts(protocol, historyAb) {
  assertE2ProbeLookupRounds(protocol?.probeLookupRounds); assertE2HistoryAbBinding(historyAb);
  const offset = protocol.branches.slice(0, historyAb.frozen.branch).reduce((n, b) => n + b.checkpoints.length, 0) + historyAb.frozen.checkpoint;
  return protocol.branches.flatMap(b => b.checkpoints).map((_, checkpoint) => ({ checkpoint, questions: checkpoint === offset ? historyAb.rows.length : 0, lookupRounds: protocol.probeLookupRounds }));
}
export const E2_AB_TOOL_POLICIES = Object.freeze({ summary: Object.freeze([]), replayFinal: Object.freeze([]),
  abReplay: Object.freeze(Object.fromEntries(E2_AB_ARMS.map(arm => [arm, Object.freeze([historyToolName(E2_AB_ARM_SURFACES[arm].historySurface)])]))) });

// ---- Sizing normalization, cap estimate and schedule ------------------------------
function abRow(row, checkpoint) {
  requireE2PaidRole(row); validateE2Sizing(row.size);
  need(["probe", "continuation"].includes(row.paidRole) && row.model === SOL && ordinal(row.maxOutputTokens) && row.maxOutputTokens > 0, "E2_ESTIMATE_INVALID");
  return { checkpoint, role: row.role, paidRole: row.paidRole, model: row.model, maxOutputTokens: row.maxOutputTokens, size: row.size };
}
/** One faux draw: per arm, exactly two probes and 2R continuations at the frozen checkpoint. */
export function normalizeE2AbSizing(protocol, record, historyAb) {
  assertE2HistoryAbBinding(historyAb);
  const R = assertE2ProbeLookupRounds(protocol?.probeLookupRounds), checkpoint = e2AbProbeCounts(protocol, historyAb).find(c => c.questions > 0).checkpoint;
  need(record?.schema === E2_AB_SIZING_SCHEMA && record.replayArm === E2_AB_REPLAY_ARM && record.qualification === false && record.semanticQualification === false
    && record.usage === "estimated-not-measured" && record.protocolDigest === protocolDigest(protocol) && sha(record.sourceDigest)
    && record.bindingSha256 === e2AbSizingBinding(historyAb) && record.probeLookupRounds === R
    && Array.isArray(record.arms) && record.arms.map(a => a?.arm).join() === e2AbArmLetters(historyAb).join(), "E2_ESTIMATE_INVALID");
  const arms = new Map();
  for (const [i, arm] of record.arms.entries()) {
    const { requestSizing, probes, withheldPacks, ...contract } = arm;
    need(same(contract, historyAb.arms[i]) && ordinal(withheldPacks) && Array.isArray(requestSizing) && requestSizing.length === 2 * (R + 1)
      && Array.isArray(probes) && probes.length === 2 && probes.every(p => p.requests === R + 1), "E2_ESTIMATE_INVALID");
    const rows = requestSizing.map(row => abRow(row, checkpoint));
    need(rows.filter(r => r.paidRole === "probe").length === 2 && rows.filter(r => r.paidRole === "continuation").length === 2 * R, "E2_ESTIMATE_INVALID");
    arms.set(arm.arm, rows);
  }
  return { checkpoint, arms };
}
// Every draw is an alternative: fund the maximum count at the largest observed size per arm/role.
function fundedArmRequests(protocol, historyAb, records) {
  need(Array.isArray(records) && records.length > 0 && records.length <= E2_INPUT_LIMITS.sizingFiles, "E2_ESTIMATE_INVALID");
  const normalized = records.map(r => normalizeE2AbSizing(protocol, r, historyAb));
  need(records.every(r => r.sourceDigest === records[0].sourceDigest), "E2_ESTIMATE_INVALID");
  return e2AbArmLetters(historyAb).map(arm => {
    const bound = new Map();
    for (const n of normalized) {
      const groups = new Map();
      for (const row of n.arms.get(arm)) { const key = `${row.paidRole}:${row.model}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
      for (const [key, group] of groups) {
        const prior = bound.get(key), largest = group.reduce((a, b) => a.size.maximum >= b.size.maximum ? a : b);
        bound.set(key, { count: Math.max(prior?.count ?? 0, group.length), row: prior?.row.size.maximum > largest.size.maximum ? prior.row : largest });
      }
    }
    // Two faux repeats stand for the two registered repeats of every selected row.
    return { arm, requests: [...bound.values()].flatMap(({ count, row }) => Array.from({ length: count * historyAb.rows.length }, () => row)) };
  });
}
/** Minimum cap = no-cache aggregate + largest single reservation; retries are separate exposure. */
export function estimateE2HistoryAb({ protocol, roles, historyAb, records, catalog }) {
  const funded = fundedArmRequests(protocol, historyAb, records);
  need(Array.isArray(roles) && roles.length === 2 && roles.every(r => ["probe", "continuation"].includes(r?.role) && r.model === SOL)
    && new Set(roles.map(r => r.role)).size === 2, "E2_ESTIMATE_INVALID");
  const all = estimateE2Reservations({ roles, requests: funded.flatMap(a => a.requests), catalog });
  const arms = funded.map(({ arm, requests }) => {
    const e = estimateE2Reservations({ roles, requests, catalog });
    return { arm, requests: e.totals.requests, noCacheUnits: e.totals.noCacheUnits, centralUnits: e.totals.centralUnits, largestReservationUnits: e.largestReservationUnits };
  });
  return { schema: "continuity-e2-ab-cap-estimate-v1", replayArm: E2_AB_REPLAY_ARM, qualification: false, semanticQualification: false, authorization: false,
    scope: "provided-ab-sizing-and-bound-rows-only", rows: historyAb.rows.length, arms, fundedSchedule: all,
    minimumCapUnits: all.forecastNoCacheMinimumCapUnits, minimumCapRule: "no-cache-aggregate-plus-largest-reservation",
    forecastMinimumCapUnits: all.forecastMinimumCapUnits, forecastNoCacheMinimumCapUnits: all.forecastNoCacheMinimumCapUnits,
    largestReservationUnits: all.largestReservationUnits, worstCaseCapUnits: all.worstCaseCapUnits,
    retryExposure: { policy: E2_RETRY_POLICY, maximumAdditionalRequests: E2_RETRY_POLICY.maxPerRun,
      maximumAdditionalUnits: (BigInt(all.largestReservationUnits) * BigInt(E2_RETRY_POLICY.maxPerRun)).toString(), includedInMinimum: false } };
}
/** One registration, one paid run: one replay-kind slot per registered arm, in A, B, C order. */
export function e2AbPhaseSchedule(protocol, historyAb, records) {
  const funded = fundedArmRequests(protocol, historyAb, records), checkpoint = e2AbProbeCounts(protocol, historyAb).find(c => c.questions > 0).checkpoint;
  const phases = funded.map(({ arm, requests }) => ({ kind: "replay", arm: e2AbSlotArm(arm), variant: "registered", phase: "whole",
    budgets: ["continuation", "probe"].map(paidRole => ({ checkpoint, paidRole, model: SOL, maxRequests: requests.filter(r => r.paidRole === paidRole).length })) }));
  need(phases.length > 0 && phases.length <= E2_INPUT_LIMITS.phases && phases.every(p => p.budgets.every(b => b.maxRequests > 0)), "e2_registration_invalid");
  return phases.map((p, index) => ({ ...p, index, slotId: canonicalDigest([E2_PHASE_DOMAIN, index, p]), eligible: true,
    roleId: "e2-validation-phase", code: "E2", suite: "e2-validation", traceId: String(index), probeId: String(index) }));
}
/** Pure registration assembly; the parent supplies bound artifacts, cap and deadlines. */
export function buildE2HistoryAbRegistration({ code, build, catalog, source, protocol, probes, keys, roles, sizing, historyAb, protocolValue, records }) {
  return { code, build, catalog, protocol, source, probes, keys, roles, schedule: e2AbPhaseSchedule(protocolValue, historyAb, records),
    toolPolicies: structuredClone(E2_AB_TOOL_POLICIES), sizing, probeCounts: e2AbProbeCounts(protocolValue, historyAb), replayArm: E2_AB_REPLAY_ARM, historyAb: historyAb };
}

// ---- Probe-only execution ----------------------------------------------------------
function lookupCounter() {
  const counts = { said: 0, tools: 0, runs: 0 };
  return { counts, reset() { counts.said = counts.tools = counts.runs = 0; },
    observe(event) {
      if (event?.type !== "assistant") return;
      for (const part of event.message?.content ?? []) if (part?.type === "tool_use") {
        const scope = historyCallScope(part.name, part.input) ?? (typeof part.name === "string" && part.name.endsWith("__ConversationHistory") ? "said" : undefined);
        if (scope) counts[scope]++;
      }
    } };
}
/**
 * One arm at one frozen checkpoint. `summary: "faux"` is offline sizing (two
 * generic repeats with scripted lookups); `"real"` runs every registered row twice
 * through the guarded paid adapter. The snapshot is restored before every probe.
 */
export async function runE2HistoryAb({ source, protocol, historyAb, frozen, arm, output, summary = "faux", paidAdapter, questions, evaluator, modules, onContext = () => {}, probeReceipts = true }) {
  const real = summary === "real";
  if (!["faux", "real"].includes(summary) || real !== (paidAdapter !== undefined) || real && (modules !== undefined || !questions || !evaluator)) fail("E2_MODELS_SEAM_REFUSED");
  const { assertE2PhaseAdapter } = await import("./continuity-e2-runtime.mjs");
  if (real) assertE2PhaseAdapter(paidAdapter);
  protocol = validateProtocol(protocol, source); assertE2HistoryAbBinding(historyAb);
  const contract = historyAb.arms.find(a => a.arm === arm); need(contract);
  need(same(contract, await e2AbArmContract(arm)));
  const point = e2AbFrozenCheckpoint(frozen, historyAb, { protocol, source }), branch = protocol.branches[point.branch];
  const rows = real ? e2AbQuestions(questions, evaluator, historyAb, protocol) : null;
  if (real) await paidAdapter.assertHistoryAb({ arm, output, historyAb, source, protocol, questions, evaluator, frozen });
  const R = protocol.probeLookupRounds, requestCount = R + 1, surface = contract.historySurface, toolName = contract.toolName, server = historyServerName(surface);
  const [{ restoreCheckpoint, e2ProbeMeasurement, privateModes }, { openHarness, productionModules }, { createE2ProbeReceipts }, { writeE2Progress, writeE2ProgressGap }] = await Promise.all([
    import("./continuity-e2-replay.mjs"), import("./continuity-runner.mjs"), import("./continuity-e2-probe-receipts.mjs"), import("./continuity-e2-progress.mjs")]);
  const estimators = await loadE2Estimators(), soul = await shippingSoul(surface);
  need(soul.rawDigest === contract.soul.rawDigest && soul.normalizedDigest === contract.soul.normalizedDigest, "E2_SOUL_MISMATCH");
  modules ??= await productionModules(ROOT);
  await mkdir(output, { mode: 0o700 });
  const work = join(output, `branch-${point.branch}`, "work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const retrieval = createE2ProbeReceipts({ output, enabled: probeReceipts, ...(paidAdapter?.probeReceiptBinding?.() ?? { slotId: "offline-ab-sizing" }), noteProgressGap: () => paidAdapter?.noteProgressGap() });
  const probe = e2ProbeMeasurement(surface), lookups = lookupCounter();
  let opened, prompt, probeRequests = 0;
  const route = createE2Models({ pi: modules.pi, estimators, models: [{ model: SOL }], limits: branch.limits, summary: real ? "real" : "faux-short", soul, paidAdapter,
    probeLookupRounds: R, replayArm: E2_AB_REPLAY_ARM, historySurface: surface, abArm: arm, abDescriptionSha256: contract.description.sha256,
    sourceContext(context) {
      // The filtered request: the current prompt (after the host envelope) is still last.
      const users = context.messages.filter(m => m.role === "user"), last = users.at(-1);
      const lastText = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
      if (!(lastText === prompt || lastText.endsWith(`\n</host_turn_context>\n\n${prompt}`))) fail("E2_AB_PACK_PRESENT");
      retrieval.observeRequest(context);
      if (++probeRequests > branch.limits.probeRequests) fail("E2_PROBE_REQUEST_LIMIT");
      probe.observe(context, estimators);
      const offered = context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? []);
      if (probe.requests > requestCount || (probe.requests === requestCount ? offered.length !== 0 : offered.length !== 1 || offered[0].name !== toolName)) fail("E2_PROBE_TOOLS_REFUSED");
      onContext({ arm, probe: true, context });
    },
    async sourceReply(context) {
      const offered = context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? []), lookup = probe.requests <= R;
      const body = lookup ? [modules.pi.fauxToolCall(offered[0].name, historyArguments(surface, { action: "search", query: "retained", limit: 1 }), { id: `e2-ab-history-${probe.requests}` })]
        : "Faux A/B probe continuation; semantic correctness is not evaluated.";
      return estimatedReply(modules.pi, body, context, estimators, { stopReason: lookup ? "toolUse" : "stop" });
    } });
  const onEvent = event => {
    if (event.type === "context_compaction" && event.status === "running") fail("E2_PROBE_SUMMARY_FORBIDDEN");
    route.observe(event);
  };
  const onHostEvent = event => { retrieval.observe(event); lookups.observe(event); };
  const open = async () => {
    opened = await openHarness({ modules, work, authPath: real ? paidAdapter.credentialPath() : join(output, "absent-auth.json"), model: point.model.model, effort: point.model.effort,
      clock: { value: new Date("2042-03-01T09:00:00Z") }, tools: false, e2: paidAdapter, ...(contract.descriptionVariant ? { historyDescriptionVariant: contract.descriptionVariant } : {}),
      configPatch: { runtime: { retry: { primaryAttempts: 1 }, fallbacks: [], compaction: { enabled: true }, session: { continuity: { enabled: true, ledgerEnabled: false, upkeep: { enabled: false } } } },
        tools: { ...historyConfig(surface), allowedTools: [toolName] }, providers: { piNative: { transport: "sse", piMaxRetries: 0 } } },
      onHistoryWarning: () => fail("E2_HISTORY_DEGRADED"),
      hostOptions: { runtimeOptionsForRequest: () => ({ runtimeOptions: { model: modules.host.parseMonoRuntimeModelReference(point.model.model), effort: point.model.effort } }) },
      route: async options => {
        if (options.piResolvedModel || options.piResolvedModels) fail("E2_MODELS_SEAM_REFUSED");
        return { piModelsDecorator: route.decorator, observers: [...(options.observers ?? []), { name: "e2.ab.lifecycle", recordEvent: onEvent }],
          allowedTools: [toolName], skills: [], mcpServers: { [server]: options.mcpServers?.[server] } };
      } });
  };
  const items = real ? rows.flatMap(q => [1, 2].map(repeat => ({ q, repeat, itemOrdinal: historyAb.rows.indexOf(q.id) + 1 }))) : [1, 2].map(repeat => ({ q: null, repeat, itemOrdinal: 1 }));
  const report = { schema: real ? E2_AB_RUN_SCHEMA : E2_AB_SIZING_SCHEMA, replayArm: E2_AB_REPLAY_ARM, qualification: false, semanticQualification: false, usage: "estimated-not-measured",
    ...contract, sourceDigest: digest(JSON.stringify(source)), protocolDigest: protocolDigest(protocol), bindingSha256: e2AbSizingBinding(historyAb),
    probeLookupRounds: R, frozen: { replaySha256: historyAb.frozen.replay.sha256, receipt: historyAb.frozen.receipt, branch: point.branch, checkpoint: point.checkpoint }, checkpoint: point.global, probes: [] };
  const answers = { schema: "continuity-e2-answers-v1", answers: [] }, observed = { schema: E2_AB_LOOKUPS_SCHEMA, arm, lookups: [] };
  try {
    for (const item of items) {
      await restoreCheckpoint(work, historyAb.frozen.snapshot, historyAb.frozen.receipt);
      probe.reset(); lookups.reset(); prompt = real ? item.q.prompt : E2_AB_PROBE_PROMPT;
      retrieval.begin({ branch: point.branch, checkpoint: point.global, repeat: item.repeat, itemOrdinal: item.itemOrdinal, arm });
      route.setPosition({ branch: point.branch, turn: point.turn, message: point.message, model: point.model.model, probe: true });
      await open();
      let response;
      try {
        response = await opened.harness.run({ conversationId: source.conversationId, userMessage: prompt, metadata: { source: "web", web: { model: point.model.model, effort: point.model.effort } },
          onEvent: onHostEvent, abortSignal: AbortSignal.timeout(branch.limits.timeoutMs) });
      } finally { await retrieval.flush(); }
      await paidAdapter?.flush(); route.assertSettled();
      const text = response.text ?? response.content;
      if (response.failure || !probe.firstContext || !real && probe.requests !== requestCount || real && typeof text !== "string") fail(real ? "E2_REPLAY_FAILED" : "E2_PROBE_FAILED");
      if (real) {
        const answer = { id: item.q.id, repeat: item.repeat, text, witness: probe.witness, excludedSteps: point.excludedSteps, excludedCoverage: point.excludedCoverage };
        try { await writeE2Progress(output, answers.answers.length + 1, await paidAdapter.answerBinding(), answer); }
        catch { paidAdapter.noteProgressGap(); try { await writeE2ProgressGap(output, paidAdapter.report().progressGap); } catch { /* Final report carries the gap count. */ } }
        answers.answers.push(answer); observed.lookups.push({ id: item.q.id, repeat: item.repeat, ...lookups.counts });
      }
      report.probes.push({ repeat: item.repeat, ...(real ? { itemOrdinal: item.itemOrdinal } : {}), requests: probe.requests, initialContext: probe.firstContext, lookups: { ...lookups.counts } });
      await opened.close(); opened = null;
    }
    const routed = route.report();
    Object.assign(report, { requestSizing: routed.requestSizing, probeRequests: routed.probeRequests, withheldPacks: routed.withheldPacks });
    if (real) {
      const keys = { schema: evaluator.schema, keys: historyAb.rows.map(id => evaluator.keys.find(k => k.id === id)) };
      for (const [name, value] of [["answers.json", answers], ["lookups.json", observed], ["score.json", scoreE2(answers, keys)]])
        await writeFile(join(output, name), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
      report.progressGap = paidAdapter.report().progressGap;
      await writeFile(join(output, "history-ab.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    } else if (retrieval.progressGap()) report.progressGap = retrieval.progressGap();
    await privateModes(output);
    return report;
  } finally { await opened?.close(); }
}
/** Offline faux sizing of every registered arm from the frozen snapshot. Writes `sizing.json`. */
export async function runE2HistoryAbSizing({ source, protocol, historyAb, frozen, output, modules, onContext }) {
  validateSource(source); assertE2HistoryAbBinding(historyAb); await assertE2AbArmContracts(historyAb); await assertE2AbSnapshot(historyAb);
  const { e2SizingIdentity, assertE2SizingIdentity } = await import("./continuity-e2-sizing-identity.mjs");
  const sizingIdentity = await e2SizingIdentity();
  await mkdir(output, { mode: 0o700 });
  try {
    const arms = [];
    for (const { arm } of historyAb.arms) {
      const r = await runE2HistoryAb({ source, protocol, historyAb, frozen, arm, output: join(output, e2AbSlotArm(arm)), summary: "faux", modules, onContext });
      const { schema: _s, replayArm: _r, qualification: _q, semanticQualification: _sq, usage: _u, sourceDigest: _sd, protocolDigest: _pd, bindingSha256: _b, probeLookupRounds: _l,
        frozen: _f, checkpoint: _c, probeRequests: _p, progressGap: _g, ...rest } = r;
      arms.push({ ...rest, probes: r.probes.map(({ lookups: _lookups, ...p }) => p) });
    }
    assertE2SizingIdentity(sizingIdentity, await e2SizingIdentity());
    const report = { schema: E2_AB_SIZING_SCHEMA, replayArm: E2_AB_REPLAY_ARM, qualification: false, semanticQualification: false, usage: "estimated-not-measured",
      sizingIdentity, sourceDigest: digest(JSON.stringify(source)), protocolDigest: protocolDigest(validateProtocol(protocol, source)), bindingSha256: e2AbSizingBinding(historyAb),
      probeLookupRounds: protocol.probeLookupRounds, checkpoint: e2AbProbeCounts(protocol, historyAb).find(c => c.questions > 0).checkpoint, arms };
    await writeFile(join(output, "sizing.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    return report;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
