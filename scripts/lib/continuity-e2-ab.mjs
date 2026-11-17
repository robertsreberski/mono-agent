// Pack-withheld, probe-only History A/B from one frozen committed E2 snapshot.
// Observational (`qualification: false`), never the release gate. No source
// replay, no paid summaries; the frozen protocol, questions, keys and scorer
// are read-only inputs selected by registered row id.
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail, ROOT } from "./continuity-observation-input.mjs";
import { digest, validateSource } from "./continuity-recorded-schema.mjs";
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { E2_AB_REPLAY_ARM, E2_AB_ARM_SURFACES, E2_AB_ARMS, e2AbArm, e2AbSlotArm, historyArguments, historyConfig, historyServerName, historyToolName } from "./continuity-e2-history.mjs";
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
    const { requestSizing, probes, withheldPacks, relocation: _relocation, history: _history, ...contract } = arm;
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

// ---- Relocated restore --------------------------------------------------------------
// The frozen tree pins its own absolute work root: the sidecar's `artifact_root`
// (the shipping writer refuses any other root), artifact references, run
// summaries and session headers. A restore at a new root rewrites exactly those
// path pointers on the COPY, proves no decoded value anywhere still names the old
// root, and never touches the frozen snapshot. Anything it cannot relocate is refused.
const TOOL_OUTPUT_SUFFIX = "/artifacts/tool-output";
const TOOL_HISTORY_DATABASE = join("history", "tool-history", "tool-lifecycles.sqlite");
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const relocationRefused = () => fail("E2_AB_RELOCATION_REFUSED");
async function treeFiles(root, prefix = "") {
  const files = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? join(prefix, name) : name, s = await lstat(join(root, relative));
    if (s.isSymbolicLink() || !s.isFile() && !s.isDirectory()) relocationRefused();
    if (s.isDirectory()) files.push(...await treeFiles(root, relative)); else files.push(relative);
  }
  return files;
}
const remapPath = (value, from, to) => typeof value === "string" ? value === from ? to : value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value
  : Array.isArray(value) ? value.map(v => remapPath(v, from, to))
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapPath(v, from, to)])) : value;
// One JSON string token (keys included) in a valid JSON text; outside strings JSON has no quotes.
const JSON_STRING_TOKEN = /"(?:[^"\\]|\\.)*"/gsu;
const JSON_ESCAPES = Object.freeze({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" });
// One layer of JSON string escapes (`\/`, `\u002f`, `\\`, ...), left to right.
const unescapeJSON = s => s.includes("\\") ? s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/gsu, (_, hex, c) => hex ? String.fromCharCode(parseInt(hex, 16)) : JSON_ESCAPES[c] ?? c) : s;
// One layer of percent-encoding (`%2F`), UTF-8 where valid, byte-wise otherwise.
const percentDecode = s => s.includes("%") ? s.replace(/(?:%[0-9a-fA-F]{2})+/gu, m => {
  try { return decodeURIComponent(m); } catch { return m.replace(/%([0-9a-fA-F]{2})/gu, (_, h) => String.fromCharCode(parseInt(h, 16))); }
}) : s;
const DECODE_DEPTH = 4;
/**
 * True when `text` names `from` literally or under any nesting (up to four
 * layers) of the encodings a path survives in: JSON string escapes (including
 * JSON nested in JSON strings) and percent-encoding.
 */
export function e2AbCarriesRoot(text, from) {
  const seen = new Set([text]);
  let frontier = [text];
  for (let depth = 0; depth <= DECODE_DEPTH && frontier.length; depth++) {
    if (frontier.some(v => v.includes(from))) return true;
    const next = [];
    for (const v of frontier) for (const d of [unescapeJSON(v), percentDecode(v)]) if (!seen.has(d)) { seen.add(d); next.push(d); }
    frontier = next;
  }
  return false;
}
const jsonValues = (name, text) => name.endsWith(".jsonl") ? text.split("\n").filter(line => line.length).map(line => JSON.parse(line)) : [JSON.parse(text)];
// Every decoded string of a parsed JSON value, keys included.
function* jsonStrings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* jsonStrings(v);
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) { yield k; yield* jsonStrings(v); }
}
/**
 * Parse a JSON/JSONL carrier and remap every whole-path string whose DECODED
 * value names the old root, whatever its escapes; any other decoded occurrence
 * (a partial path, a nested encoding, a key) refuses. Bytes outside rewritten
 * string tokens are kept. The rewrite is proved against a pure path remap of
 * the parsed values. Returns the new text, or undefined when nothing changed
 * (including an unparsable file, which the decoded scan then judges).
 */
function relocateJSON(name, text, from, to) {
  let before; try { before = jsonValues(name, text); } catch { return undefined; }
  let changed = false;
  const next = text.replace(JSON_STRING_TOKEN, token => {
    const value = JSON.parse(token);
    if (!value.includes(from)) { if (e2AbCarriesRoot(value, from)) relocationRefused(); return token; }
    if (value !== from && !value.startsWith(`${from}/`)) relocationRefused();
    changed = true;
    return JSON.stringify(remapPath(value, from, to));
  });
  if (!changed) return undefined;
  let after; try { after = jsonValues(name, next); } catch { relocationRefused(); }
  if (JSON.stringify(remapPath(before, from, to)) !== JSON.stringify(after)) relocationRefused();
  return next;
}
// Every stored value of every table (shadow tables of virtual tables included) and the schema text.
function sqliteCarriesRoot(path, from) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = db.prepare("SELECT type, name, sql FROM sqlite_master").all();
    for (const { name, sql, type } of tables) {
      if (typeof sql === "string" && e2AbCarriesRoot(sql, from)) return true;
      if (type !== "table" || /^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(sql ?? "")) continue;
      for (const row of db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).iterate())
        for (const value of Object.values(row)) {
          const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
          if (text !== undefined && e2AbCarriesRoot(text, from)) return true;
        }
    }
    return false;
  } catch (error) { if (error?.code === "E2_AB_RELOCATION_REFUSED") throw error; return relocationRefused(); }
  finally { db?.close(); }
}
/**
 * Proof over the whole copy: no file's bytes, no decoded text view, no parsed
 * JSON/JSONL string or key, and no SQLite table value or schema names the old
 * root. Anything undecodable that might carry it refuses.
 */
export async function assertE2AbRootAbsent(root, from) {
  const needle = Buffer.from(from);
  for (const name of await treeFiles(root)) {
    const bytes = await readFile(join(root, name));
    if (bytes.includes(needle)) relocationRefused();
    if (bytes.length >= SQLITE_HEADER.length && bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) { if (sqliteCarriesRoot(join(root, name), from)) relocationRefused(); continue; }
    const text = bytes.toString("utf8");
    if (e2AbCarriesRoot(text, from)) relocationRefused();
    if (/\.jsonl?$/u.test(name)) {
      let values; try { values = jsonValues(name, text); } catch { continue; }
      for (const value of values) for (const s of jsonStrings(value)) if (e2AbCarriesRoot(s, from)) relocationRefused();
    }
  }
}
/**
 * Relocate a restored copy of the frozen tree to `work` (its realpath). Returns
 * content-free counts; refuses unless every old-root pointer was rewritten.
 */
export async function relocateE2AbWork(work) {
  const to = await realpath(work), database = join(to, TOOL_HISTORY_DATABASE);
  let s; try { s = await lstat(database); } catch { relocationRefused(); }
  if (!s.isFile()) relocationRefused();
  const result = { relocated: false, metadata: 0, artifactRefs: 0, files: 0 };
  let from, db;
  try {
    db = new DatabaseSync(database);
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") relocationRefused();
    const root = db.prepare("SELECT value FROM metadata WHERE key='artifact_root'").get()?.value;
    if (typeof root !== "string" || !root.endsWith(TOOL_OUTPUT_SUFFIX)) relocationRefused();
    from = root.slice(0, -TOOL_OUTPUT_SUFFIX.length);
    // Absolute, normalized, JSON-literal-safe, unrelated to the new root by prefix and absent from it.
    if (!isAbsolute(from) || resolve(from) !== from || JSON.stringify(from) !== `"${from}"` || from !== to && (`${to}/`.startsWith(`${from}/`) || `${from}/`.startsWith(`${to}/`) || to.includes(from))) relocationRefused();
    if (from === to) return result;
    const refs = db.prepare("SELECT host_path FROM artifact_refs").all();
    if (refs.some(r => typeof r.host_path !== "string" || !r.host_path.startsWith(`${from}/`))) relocationRefused();
    // Zero freed cell bytes so the old root cannot survive in the file image.
    db.prepare("PRAGMA secure_delete=ON").run(); db.prepare("BEGIN IMMEDIATE").run();
    try {
      result.metadata = Number(db.prepare("UPDATE metadata SET value=? WHERE key='artifact_root' AND value=?").run(`${to}${TOOL_OUTPUT_SUFFIX}`, root).changes);
      result.artifactRefs = Number(db.prepare("UPDATE artifact_refs SET host_path=? || substr(host_path, ?) WHERE substr(host_path, 1, ?)=?").run(to, from.length + 1, from.length + 1, `${from}/`).changes);
      db.prepare("COMMIT").run();
    } catch (error) { db.prepare("ROLLBACK").run(); throw error; }
    if (result.metadata !== 1 || result.artifactRefs !== refs.length || db.prepare("SELECT value FROM metadata WHERE key='artifact_root'").get()?.value !== `${to}${TOOL_OUTPUT_SUFFIX}`
      || db.prepare("SELECT host_path FROM artifact_refs").all().some(r => !r.host_path.startsWith(`${to}/`))) relocationRefused();
  } finally { db?.close(); }
  // Every JSON/JSONL carrier is parsed and its decoded strings remapped or refused, whatever the raw bytes show.
  for (const name of (await treeFiles(to)).filter(n => /\.jsonl?$/u.test(n))) {
    const path = join(to, name), bytes = await readFile(path), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) continue; // Not UTF-8 text: the decoded scan below judges it.
    const next = relocateJSON(name, text, from, to);
    if (next !== undefined) { await writeFile(path, next); result.files++; }
  }
  // Proof: no file, decoded value or SQLite table value anywhere in the copy still names the old root.
  await assertE2AbRootAbsent(to, from);
  // Session headers name the new workspace exactly.
  for (const name of (await treeFiles(to)).filter(n => /^sessions\/journals\/[^/]+\.jsonl$/u.test(n))) {
    const first = (await readFile(join(to, name), "utf8")).split("\n", 1)[0];
    let header; try { header = JSON.parse(first); } catch { relocationRefused(); }
    if (header?.cwd !== undefined && header.cwd !== to) relocationRefused();
  }
  result.relocated = true;
  return result;
}

// ---- History health latch ---------------------------------------------------------
// Production History is fail-open (warnings only) and warning dispatch swallows
// callback exceptions, so a throwing callback cannot stop a run. Latch genuine
// store and infrastructure unavailability here; the run refuses before each
// request and after each probe. A model's own lookup mistake (a typo'd or
// missing record, a bad cursor, query or scope) is recorded and scored, never latched.
//
// Every History store/endpoint warning latches: writer acquisition failure
// (including `history_artifact_root_mismatch`), `sidecar_unavailable` and the
// other continuity/persistence warnings, and the endpoint failing to start.
// They come from the store and the composition, never from model arguments;
// the parenthesized shipping code only labels the report.
const HISTORY_WARNING_CODE = /\(([a-z][a-z0-9_]{0,63})\)/u;
// The explicit shipping result code for a store that cannot be read: the
// catch-all of the said (ConversationHistory), tools (SessionHistory) and runs
// (RunHistory) handlers and of the unified History server's dispatch.
export const E2_AB_STORE_UNAVAILABLE_CODES = Object.freeze(["history_unavailable"]);
const LOOKUP_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
// The shipping handler's own structured result: MCP structuredContent as the
// turn records it, else the JSON envelope in the model-facing text.
function historyResultBody(part) {
  const structured = part?.raw_result?.details?.raw?.structuredContent;
  if (object(structured)) return structured;
  const text = typeof part?.content === "string" ? part.content : (Array.isArray(part?.content) ? part.content : []).filter(b => b?.type === "text").map(b => b.text).join("\n");
  const joined = text.replace(/\n?\[continued section \d+ of \d+\]\n/gu, ""), start = joined.search(/^\s*\{\s*"(?:action|status|error)"\s*:/mu);
  try { const body = start < 0 ? undefined : JSON.parse(joined.slice(start)); return object(body) ? body : undefined; } catch { return undefined; }
}
/**
 * Classify one History result: `{ latch }` for store unavailability by explicit
 * code or the reader's own `available: false` search flag; `{ lookup }` for a
 * model-correctable lookup outcome; otherwise null. Content-free.
 */
export function e2AbHistoryResultClass(body) {
  if (!object(body)) return null;
  const code = object(body.error) && typeof body.error.code === "string" ? body.error.code : undefined;
  if (code !== undefined && E2_AB_STORE_UNAVAILABLE_CODES.includes(code)) return { latch: code };
  // The said reader found no readable continuity store (no database, no schema, or a pending purge).
  if (body.action === "search" && body.available === false) return { latch: "history_store_unavailable" };
  if (code !== undefined) return { lookup: LOOKUP_CODE.test(code) ? code : "lookup_error" };
  // A said get for an absent record. In-band it matches an unreadable store; the
  // store itself is re-checked after every result (see `observe`).
  if (body.action === "get" && body.status === "unavailable") return { lookup: "record_unavailable" };
  return null;
}
export function e2AbHistoryHealth({ toolName, verifyStore = () => {} } = {}) {
  const codes = {}, lookupErrors = {}, calls = new Set();
  const note = code => { codes[code] = (codes[code] ?? 0) + 1; };
  const own = name => toolName === undefined || name === toolName || typeof name === "string" && name.endsWith(`__${toolName}`);
  return {
    warn(message) { const text = String(message); note(text.match(HISTORY_WARNING_CODE)?.[1] ?? (/endpoint could not start/u.test(text) ? "history_endpoint_unavailable" : "history_warning")); },
    note,
    // Offered History results: latch store unavailability, count lookup mistakes, and re-check the store after each result.
    observe(event) {
      for (const part of event?.message?.content ?? []) {
        if (event.type === "assistant" && part?.type === "tool_use" && own(part.name)) calls.add(part.id);
        if (event.type !== "user" || part?.type !== "tool_result" || toolName !== undefined && !calls.has(part.tool_use_id)) continue;
        calls.delete(part.tool_use_id);
        const result = e2AbHistoryResultClass(historyResultBody(part));
        if (result?.latch) note(result.latch);
        else if (result?.lookup) lookupErrors[result.lookup] = (lookupErrors[result.lookup] ?? 0) + 1;
        // A reader that cannot open the store, whatever the result said, latches before the next request.
        try { verifyStore(); } catch { note("history_reader_unavailable"); }
      }
    },
    get degraded() { return Object.keys(codes).length > 0; },
    assert() { if (Object.keys(codes).length) fail("E2_HISTORY_DEGRADED"); },
    report: () => ({ warnings: Object.values(codes).reduce((n, v) => n + v, 0), codes: { ...codes }, lookupErrors: { ...lookupErrors } }),
  };
}
const CONTINUITY_FAILURES = ["writeFailures", "recoveryFailures", "maintenanceFailures", "idempotencyConflicts"];
function historyStats(modules, work) {
  let stats; try { stats = new modules.conversation.ToolHistoryReader(join(work, "history")).stats(); } catch { fail("E2_HISTORY_DEGRADED"); }
  const c = stats?.continuity;
  if (!c || c.degraded === true || !Number.isSafeInteger(c.records) || c.records <= 0 || CONTINUITY_FAILURES.some(k => !Number.isSafeInteger(stats[k]))) fail("E2_HISTORY_DEGRADED");
  return { records: c.records, ...Object.fromEntries(CONTINUITY_FAILURES.map(k => [k, stats[k]])) };
}
/**
 * Before any request: the relocated store holds retained evidence, and the
 * shipping writer opens it with the run's own artifact root (the exact check that
 * otherwise fails as `history_artifact_root_mismatch` mid-run, silently).
 */
export async function e2AbHistoryPreflight(modules, work, health) {
  const before = historyStats(modules, work);
  let handle;
  try { handle = await modules.conversation.acquireToolHistoryWriter({ root: join(work, "history"), artifactRoot: join(work, "artifacts", "tool-output"), continuityEnabled: true, onWarning: m => health.warn(m) }); }
  catch (error) { health.note([error?.code, error?.name].find(v => typeof v === "string" && /^history_[a-z0-9_]{1,64}$/u.test(v)) ?? "history_writer_unavailable"); }
  finally { await handle?.release(); }
  health.assert();
  const after = historyStats(modules, work);
  if (JSON.stringify(after) !== JSON.stringify(before)) fail("E2_HISTORY_DEGRADED");
  return after;
}
/** After a probe: no new store failures and continuity still healthy. */
function assertHistoryUndegraded(modules, work, baseline, health) {
  health.assert();
  const after = historyStats(modules, work);
  if (CONTINUITY_FAILURES.some(k => after[k] > baseline[k])) fail("E2_HISTORY_DEGRADED");
}

// ---- Probe-only execution ----------------------------------------------------------
/**
 * One arm at one frozen checkpoint. `summary: "faux"` is offline sizing (two
 * generic repeats with scripted lookups); `"real"` runs every registered row twice
 * through the guarded paid adapter. The snapshot is restored before every probe.
 */
export async function runE2HistoryAb({ source, protocol, historyAb, frozen, arm, output, summary = "faux", paidAdapter, questions, evaluator, modules, onContext = () => {}, probeReceipts = true }) {
  const real = summary === "real";
  // Paid rows require their lookup receipts: scoring derives lookups from them alone.
  if (!["faux", "real"].includes(summary) || real !== (paidAdapter !== undefined) || real && (modules !== undefined || !questions || !evaluator || probeReceipts !== true)) fail("E2_MODELS_SEAM_REFUSED");
  const { assertE2PhaseAdapter } = await import("./continuity-e2-runtime.mjs");
  if (real) assertE2PhaseAdapter(paidAdapter);
  protocol = validateProtocol(protocol, source); assertE2HistoryAbBinding(historyAb);
  const contract = historyAb.arms.find(a => a.arm === arm); need(contract);
  need(same(contract, await e2AbArmContract(arm)));
  const point = e2AbFrozenCheckpoint(frozen, historyAb, { protocol, source }), branch = protocol.branches[point.branch];
  const rows = real ? e2AbQuestions(questions, evaluator, historyAb, protocol) : null;
  if (real) await paidAdapter.assertHistoryAb({ arm, output, historyAb, source, protocol, questions, evaluator, frozen });
  const R = protocol.probeLookupRounds, requestCount = R + 1, surface = contract.historySurface, toolName = contract.toolName, server = historyServerName(surface);
  const [{ restoreCheckpoint, treeReceipt, e2ProbeMeasurement, privateModes }, { openHarness, productionModules }, { createE2ProbeReceipts }, { writeE2Progress, writeE2ProgressGap }] = await Promise.all([
    import("./continuity-e2-replay.mjs"), import("./continuity-runner.mjs"), import("./continuity-e2-probe-receipts.mjs"), import("./continuity-e2-progress.mjs")]);
  const estimators = await loadE2Estimators(), soul = await shippingSoul(surface);
  need(soul.rawDigest === contract.soul.rawDigest && soul.normalizedDigest === contract.soul.normalizedDigest, "E2_SOUL_MISMATCH");
  modules ??= await productionModules(ROOT);
  await mkdir(output, { mode: 0o700 });
  const work = join(output, `branch-${point.branch}`, "work");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const retrieval = createE2ProbeReceipts({ output, enabled: probeReceipts, allScopes: true, ...(paidAdapter?.probeReceiptBinding?.() ?? { slotId: "offline-ab-sizing" }), noteProgressGap: () => paidAdapter?.noteProgressGap() });
  const probe = e2ProbeMeasurement(surface), health = e2AbHistoryHealth({ toolName, verifyStore: () => historyStats(modules, work) });
  let opened, prompt, probeRequests = 0;
  const route = createE2Models({ pi: modules.pi, estimators, models: [{ model: SOL }], limits: branch.limits, summary: real ? "real" : "faux-short", soul, paidAdapter,
    probeLookupRounds: R, replayArm: E2_AB_REPLAY_ARM, historySurface: surface, abArm: arm, abDescriptionSha256: contract.description.sha256,
    sourceContext(context) {
      // A latched History degradation refuses before this request is sized, guarded or sent.
      health.assert();
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
  const onHostEvent = event => { retrieval.observe(event); health.observe(event); };
  const open = async () => {
    opened = await openHarness({ modules, work, authPath: real ? paidAdapter.credentialPath() : join(output, "absent-auth.json"), model: point.model.model, effort: point.model.effort,
      clock: { value: new Date("2042-03-01T09:00:00Z") }, tools: false, e2: paidAdapter, ...(contract.descriptionVariant ? { historyDescriptionVariant: contract.descriptionVariant } : {}),
      configPatch: { runtime: { retry: { primaryAttempts: 1 }, fallbacks: [], compaction: { enabled: true }, session: { continuity: { enabled: true, ledgerEnabled: false, upkeep: { enabled: false } } } },
        tools: { ...historyConfig(surface), allowedTools: [toolName] }, providers: { piNative: { transport: "sse", piMaxRetries: 0 } } },
      onHistoryWarning: message => health.warn(message),
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
  const answers = { schema: "continuity-e2-answers-v1", answers: [] };
  let relocated;
  try {
    for (const item of items) {
      // Verified restore of the frozen bytes, then a validated relocation of the copy.
      await restoreCheckpoint(work, historyAb.frozen.snapshot, historyAb.frozen.receipt);
      const moved = await relocateE2AbWork(work), movedReceipt = await treeReceipt(work);
      if (relocated === undefined) relocated = { ...moved, receipt: movedReceipt };
      else if (!same({ ...moved, receipt: movedReceipt }, relocated)) fail("E2_SNAPSHOT_MISMATCH");
      const baseline = await e2AbHistoryPreflight(modules, work, health);
      probe.reset(); prompt = real ? item.q.prompt : E2_AB_PROBE_PROMPT;
      retrieval.begin({ branch: point.branch, checkpoint: point.global, repeat: item.repeat, itemOrdinal: item.itemOrdinal, arm, ...(real ? { rowId: item.q.id } : {}) });
      route.setPosition({ branch: point.branch, turn: point.turn, message: point.message, model: point.model.model, probe: true });
      await open();
      let response;
      try {
        response = await opened.harness.run({ conversationId: source.conversationId, userMessage: prompt, metadata: { source: "web", web: { model: point.model.model, effort: point.model.effort } },
          onEvent: onHostEvent, abortSignal: AbortSignal.timeout(branch.limits.timeoutMs) });
      } finally { retrieval.settle(); await retrieval.flush(); }
      await paidAdapter?.flush(); route.assertSettled();
      // Degradation latched at any point of the probe voids it, whatever the model saw.
      assertHistoryUndegraded(modules, work, baseline, health);
      const text = response.text ?? response.content;
      if (response.failure || !probe.firstContext || !real && probe.requests !== requestCount || real && typeof text !== "string") fail(real ? "E2_REPLAY_FAILED" : "E2_PROBE_FAILED");
      if (real) {
        const answer = { id: item.q.id, repeat: item.repeat, text, witness: probe.witness, excludedSteps: point.excludedSteps, excludedCoverage: point.excludedCoverage };
        try { await writeE2Progress(output, answers.answers.length + 1, await paidAdapter.answerBinding(), answer); }
        catch { paidAdapter.noteProgressGap(); try { await writeE2ProgressGap(output, paidAdapter.report().progressGap); } catch { /* Final report carries the gap count. */ } }
        answers.answers.push(answer);
      }
      report.probes.push({ repeat: item.repeat, ...(real ? { itemOrdinal: item.itemOrdinal } : {}), requests: probe.requests, initialContext: probe.firstContext, continuityRecords: baseline.records });
      await opened.close(); opened = null;
    }
    const routed = route.report();
    Object.assign(report, { requestSizing: routed.requestSizing, probeRequests: routed.probeRequests, withheldPacks: routed.withheldPacks, relocation: relocated, history: health.report() });
    if (real) {
      const keys = { schema: evaluator.schema, keys: historyAb.rows.map(id => evaluator.keys.find(k => k.id === id)) };
      // Lookups are never counted here: scoring derives them from the probe receipts.
      for (const [name, value] of [["answers.json", answers], ["score.json", scoreE2(answers, keys)]])
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
      arms.push(rest);
    }
    assertE2SizingIdentity(sizingIdentity, await e2SizingIdentity());
    const report = { schema: E2_AB_SIZING_SCHEMA, replayArm: E2_AB_REPLAY_ARM, qualification: false, semanticQualification: false, usage: "estimated-not-measured",
      sizingIdentity, sourceDigest: digest(JSON.stringify(source)), protocolDigest: protocolDigest(validateProtocol(protocol, source)), bindingSha256: e2AbSizingBinding(historyAb),
      probeLookupRounds: protocol.probeLookupRounds, checkpoint: e2AbProbeCounts(protocol, historyAb).find(c => c.questions > 0).checkpoint, arms };
    await writeFile(join(output, "sizing.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    return report;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
