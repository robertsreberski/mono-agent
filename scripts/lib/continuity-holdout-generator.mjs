import { V2_FIELDS } from "./continuity-score-v2.mjs";
import { STATISTICAL_SPEC, validateStatisticalSpec } from "./continuity-holdout-statistics.mjs";
// Benchmark-only: no narrative imports, provider calls, or product preparation.
import { readFile, realpath, lstat } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { canonicalJson, digest, sourceOnly, validateTrace } from "./continuity-dataset.mjs";
import { externalDirectory } from "./continuity-holdout-files.mjs";
import { validateProbeScore, compactIdentifier } from "./continuity-score.mjs";

export const HOLDOUT_VERSION = "holdout-generator-v1";
const ID = /^[a-z][a-z0-9-]{1,39}$/u;
const SLOT = /^[a-z][a-z0-9_]*$/u;
const OPERATIONS = { read: "doc_read", search: "mail_search", write: "doc_write", send: "mail_send" };
const ALLOCATION = [
  ["tool_identifier", "identifier"], ["tool_identifier", "identifier"], ["tool_identifier", "identifier"],
  ["active_constraint", "constraint_recall"], ["active_constraint", "constraint_task"],
  ["superseded_current", "value"], ["superseded_current", "value"],
  ["commitment_status", "choice"], ["commitment_status", "choice"],
  ["artifact_status", "choice"], ["artifact_status", "choice"], ["next_action", "next_action"],
  ["abstention", "abstain"], ["abstention", "abstain"], ["redaction", "redaction"],
];
const SCORE_FIELDS = { identifier: ["accept", "reject"], constraint_recall: ["requireAll"], constraint_task: ["forbidden"],
  value: ["accept", "superseded"], choice: ["options", "expected"], next_action: ["proxyAll", "rubric"], abstain: [], redaction: ["secret"] };
const fail = (message) => { throw new Error(message); };
const need = (condition, message) => { if (!condition) fail(message); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function keys(value, allowed, required = allowed) {
  need(object(value) && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), "invalid_fields");
}
const text = (v) => need(typeof v === "string" && v.trim().length > 0, "invalid_text");
const integer = (v, min, max) => need(Number.isSafeInteger(v) && v >= min && v <= max, "invalid_integer");
function strings(value, min = 0) { need(Array.isArray(value) && value.length >= min, "invalid_strings"); value.forEach(text); }
function slots(value) { need(object(value), "invalid_slots"); for (const [key, v] of Object.entries(value)) { need(SLOT.test(key) && key !== "sample_id", "invalid_slot"); text(v); need(!v.includes("{{"), "recursive_slot"); } }
function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}
function substitute(value, bindings) {
  return mapStrings(value, s => {
    const result = s.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gu, (_, key) => {
      need(Object.hasOwn(bindings, key), "unknown_slot"); return bindings[key];
    });
    need(!result.includes("{{") && !result.includes("}}"), "malformed_slot"); return result;
  });
}
function bindingsFor(family, item) { return { ...family.entities, ...family.vocabulary, ...item.bindings, sample_id: item.id }; }

/** Directory loading is data-only. No overlap sources or rendering are consulted. */
export async function loadHoldoutSpec(directory, statisticalSpec = STATISTICAL_SPEC) {
  const dir = await realpath(await externalDirectory(directory));
  const read = async name => {
    need(typeof name === "string" && /^[a-zA-Z0-9_-]+\.json$/u.test(name) && basename(name) === name, "invalid_spec_filename");
    const path = resolve(dir, name);
    need((await lstat(path)).isFile() && dirname(await realpath(path)) === dir, "invalid_spec_file");
    return JSON.parse(await readFile(path, "utf8"));
  };
  const index = await read("index.json");
  keys(index, ["schema", "fictional", "provenance", "families"]);
  need(Array.isArray(index.families), "invalid_families");
  const files = new Set(["index.json"]);
  const families = [];
  for (const row of index.families) {
    keys(row, ["id", "group", "count", "file"]);
    need(!files.has(row.file), "duplicate_family_file"); files.add(row.file);
    const family = await read(row.file);
    need(["id", "group", "count"].every(k => family[k] === row[k]), "family_index_mismatch");
    families.push(family);
  }
  const spec = { ...index, families: families.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  validateHoldoutSpec(spec, statisticalSpec);
  return spec;
}

// JSON "\\b" is a regex boundary, but JSON "\b" decodes to a backspace.
// Check every authored value/key before regex compilation or other schema checks.
function validateAuthoredStrings(value, field = "spec", caseId = null) {
  const forbidden = /[\u0000-\u0008\u000b-\u001f]/u;
  const reject = location => fail(`invalid_authored_control:case=${JSON.stringify(caseId)}:field=${JSON.stringify(location)}`);
  if (typeof value === "string") { if (forbidden.test(value)) reject(field); }
  else if (Array.isArray(value)) value.forEach((item, index) => validateAuthoredStrings(item, `${field}[${index}]`, caseId));
  else if (value && typeof value === "object") {
    if (/\.cases\[\d+\]$/u.test(field)) caseId = value.id ?? null;
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.test(key)) reject(`${field}.[key]`);
      validateAuthoredStrings(item, `${field}.${key}`, caseId);
    }
  }
}

/** Strict schema/provenance validation only; no history generation or hidden comparison. */
export function validateHoldoutSpec(spec, statisticalSpec = STATISTICAL_SPEC) {
  validateStatisticalSpec(statisticalSpec);
  const d = statisticalSpec.design;
  validateAuthoredStrings(spec);
  keys(spec, ["schema", "fictional", "provenance", "families"]);
  need(spec.schema === "fictional-conversations-v1" && spec.fictional === true, "fictional_spec_required");
  const p = spec.provenance;
  keys(p, ["authorId", "createdAt", "independent", "references", "exposures", "declaration"]);
  need(ID.test(p.authorId) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(p.createdAt)
    && new Date(p.createdAt).toISOString() === p.createdAt && p.independent === true
    && Array.isArray(p.references) && p.references.length === 0 && Array.isArray(p.exposures) && p.exposures.length === 0
    && typeof p.declaration === "string" && p.declaration.length >= 40, "invalid_provenance");
  need(Array.isArray(spec.families) && spec.families.length >= d.families, "insufficient_families");
  const ids = new Set(), cases = new Set(), structures = new Set(), counts = { ordinary: 0, distractor: 0 };
  for (const family of spec.families) {
    keys(family, ["id", "group", "count", "entities", "vocabulary", "templates", "cases"]);
    need(ID.test(family.id) && !ids.has(family.id), "duplicate_family_identity"); ids.add(family.id);
    need(Object.hasOwn(counts, family.group), "invalid_group");
    integer(family.count, 1, d.conversationsPerCorpus); counts[family.group] += family.count;
    slots(family.entities); slots(family.vocabulary);
    need(Object.keys(family.entities).every(k => !Object.hasOwn(family.vocabulary, k)), "duplicate_slot");
    keys(family.templates, ["owner", "assistant", "toolBody"]);
    for (const [key, value] of Object.entries(family.templates)) strings(value, key === "toolBody" ? 8 : 2);
    need(Array.isArray(family.cases) && family.cases.length >= family.count, "insufficient_cases");
    for (const item of family.cases) {
      keys(item, ["id", "title", "owner", "bindings", "turnCount", "toolCount", "sessions", "midpoint", "events", "probes", "features", "unstated"]);
      need(ID.test(item.id) && !cases.has(item.id), "duplicate_case_identity"); cases.add(item.id);
      text(item.title); text(item.owner); slots(item.bindings);
      need(Object.keys(item.bindings).every(k => Object.hasOwn(family.entities, k) || Object.hasOwn(family.vocabulary, k)), "unknown_binding");
      const bindings = bindingsFor(family, item);
      substitute(family.templates, bindings);
      const rendered = substitute(item, bindings);
      integer(item.turnCount, 80, 120); integer(item.toolCount, 64, Math.min(96, item.turnCount - 2));
      integer(item.sessions, 7, 10); integer(item.midpoint, 1, item.turnCount - 6);
      need(Array.isArray(item.events) && item.events.length > 0, "invalid_events");
      const events = new Map(); let tools = 0, interruptions = 0;
      for (const event of rendered.events) {
        keys(event, ["at", "owner", "assistant", "tool", "aside", "interruption"], ["at", "owner", "assistant"]);
        integer(event.at, 0, item.turnCount - 1); need(!events.has(event.at), "duplicate_event_index"); events.set(event.at, event);
        text(event.owner); text(event.assistant);
        if (event.tool) {
          need(event.at !== item.midpoint, "midpoint_has_tool"); tools++;
          keys(event.tool, ["operation", "args", "bytes", "head", "middle", "tail"]);
          need(Object.hasOwn(OPERATIONS, event.tool.operation) && object(event.tool.args), "invalid_operation");
          Object.values(event.tool.args).forEach(text); integer(event.tool.bytes, 8192, 65536);
          for (const k of ["head", "middle", "tail"]) strings(event.tool[k]);
        }
        for (const k of ["aside", "interruption"]) if (event[k] !== undefined) { need(!!event.tool, "interruption_needs_tool"); text(event[k]); }
        if (event.interruption) interruptions++;
      }
      need(tools <= item.toolCount && interruptions >= 2, "invalid_event_tool_count");
      // Exclude IDs, bindings and background templates: reskinned authored events are not new cases.
      const structure = digest([...item.events].sort((a, b) => a.at - b.at));
      need(!structures.has(structure), "duplicate_case_structure"); structures.add(structure);
      keys(item.features, ["correction", "deliberation", "decision", "outstanding", "fulfilled", "distractor"]);
      for (const [k, indices] of Object.entries(item.features)) {
        need(Array.isArray(indices) && (k === "distractor" && family.group === "ordinary" || indices.length > 0)
          && new Set(indices).size === indices.length && indices.every(i => events.has(i)), "invalid_feature_evidence");
      }
      strings(rendered.unstated, 2); need(rendered.unstated.length === 2, "invalid_unstated");
      need(Array.isArray(rendered.probes) && rendered.probes.length === 15, "invalid_probe_allocation");
      rendered.probes.forEach((probe, i) => {
        keys(probe, ["category", "question", "format", "abstainOption", "score", "evidence", "source", "placement"],
          ["category", "question", "abstainOption", "score", "evidence"]);
        const [category, kind] = ALLOCATION[i];
        need(probe.category === category && probe.score?.kind === kind && probe.abstainOption === ![4, 14].includes(i), "invalid_probe_allocation");
        text(probe.question); need(probe.question.length >= 10, "invalid_question"); if (probe.format !== undefined) text(probe.format);
        const fields = SCORE_FIELDS[kind]; keys(probe.score, ["kind", ...fields, ...(probe.score.version === "v2" ? V2_FIELDS : ["version"])], ["kind", ...fields.filter(k => k !== "reject")]);
        try { validateProbeScore(probe); } catch { fail("invalid_probe_score"); }
        if (i === 2) need(Array.isArray(probe.score.reject) && probe.score.reject.length > 0, "missing_identifier_decoy");
        if (kind === "identifier") need((probe.score.reject ?? []).every(v => !probe.score.accept.some(a => compactIdentifier(a) === compactIdentifier(v))), "identifier_decoy_conflict");
        if (kind === "choice") need(new Set(probe.score.options).size === probe.score.options.length, "duplicate_choice");
        need(Array.isArray(probe.evidence) && probe.evidence.every(index => events.has(index))
          && (kind === "abstain" ? probe.evidence.length === 0 : probe.evidence.length > 0), "invalid_probe_evidence");
        if (i < 3) need(events.get(probe.source)?.tool && probe.evidence.includes(probe.source)
          && probe.placement === ["early", "middle", "head"][i], "invalid_identifier_provenance");
        else need(probe.source === undefined && probe.placement === undefined, "unexpected_identifier_provenance");
      });
    }
  }
  need(counts.ordinary === d.conversationsPerCorpus && counts.distractor === d.conversationsPerCorpus
    && ["ordinary", "distractor"].every(g => spec.families.filter(f => f.group === g).length >= d.families / d.corpora.length), "invalid_family_mixture");
  return true;
}

function random(seed) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function shuffle(values, next) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function seedNumber(seed) { integer(seed, 1, 0xffffffff); return seed; }

/** Independent per-group selection and per-case rendering seeds; fixed quotas, no replacement. */
export function selectHoldoutCases(spec, seeds, statisticalSpec = STATISTICAL_SPEC) {
  validateHoldoutSpec(spec, statisticalSpec); keys(seeds, ["ordinary", "distractor"]);
  seedNumber(seeds.ordinary); seedNumber(seeds.distractor); need(seeds.ordinary !== seeds.distractor, "distinct_group_seeds_required");
  const rows = [];
  for (const group of ["ordinary", "distractor"]) {
    const next = random(seeds[group]);
    for (const family of [...spec.families].filter(f => f.group === group).sort((a, b) => a.id < b.id ? -1 : 1)) {
      const pool = [...family.cases].sort((a, b) => a.id < b.id ? -1 : 1);
      for (const item of shuffle(pool, next).slice(0, family.count)) rows.push({ family, item, seed: 1 + Math.floor(next() * 0xfffffffe) });
    }
  }
  return rows;
}

// Fill a byte range with whole UTF-8 code points; authored evidence is never truncated.
function fill(bytes, nextUnit) {
  need(bytes >= 0, "result_facts_do_not_fit");
  const parts = [];
  while (bytes > 0) {
    const unit = nextUnit() + "\n", size = Buffer.byteLength(unit);
    if (size <= bytes) { parts.push(unit); bytes -= size; continue; }
    let tail = "", used = 0;
    for (const char of unit) { const size = Buffer.byteLength(char); if (used + size > bytes) break; tail += char; used += size; }
    parts.push(tail, " ".repeat(bytes - used)); bytes = 0;
  }
  return parts.join("");
}
function resultBody(tool, nextUnit) {
  const head = tool.head.join("\n") + "\n", middle = tool.middle.join("\n") + "\n", tail = "\n" + tool.tail.join("\n");
  const half = Math.floor(tool.bytes / 2);
  return head + fill(half - Buffer.byteLength(head), nextUnit) + middle
    + fill(tool.bytes - half - Buffer.byteLength(middle + tail), nextUnit) + tail;
}
const turnId = i => `t${String(i + 1).padStart(3, "0")}`;

/** Render one selected case. Content comes exclusively from the supplied family/case. */
export function generateHoldoutTrace(family, item, seed) {
  seedNumber(seed);
  const next = random(seed), bindings = bindingsFor(family, item);
  const c = substitute(item, bindings), templates = substitute(family.templates, bindings);
  const pick = values => values[Math.floor(next() * values.length)];
  const events = new Map(c.events.map(e => [e.at, e]));
  const raw = Array.from({ length: c.turnCount }, (_, i) => events.get(i) ?? { at: i, owner: pick(templates.owner), assistant: pick(templates.assistant) });
  const authored = raw.filter(e => e.tool).length;
  const candidates = shuffle(raw.filter(e => !e.tool && !events.has(e.at) && e.at !== c.midpoint), next);
  need(candidates.length >= c.toolCount - authored, "insufficient_background_turns");
  candidates.slice(0, c.toolCount - authored).forEach(e => { e.tool = { operation: "read", args: {}, bytes: 0, head: [], middle: [], tail: [] }; });
  const calls = raw.filter(e => e.tool);
  const background = calls.filter(e => e.tool.bytes === 0);
  // Authored placements are immutable; supply oversized background results if necessary.
  const ranges = [[20480, 40960], [24576, 49152], [24576, 49152]];
  const used = new Set();
  for (const [min, max] of ranges) {
    const match = calls.find(e => !used.has(e) && e.tool.bytes >= min && e.tool.bytes <= max);
    if (match) used.add(match);
    else { const e = background.find(e => e.tool.bytes === 0); need(!!e, "missing_oversized_capacity"); e.tool.bytes = min; used.add(e); }
  }
  const plainBytes = raw.reduce((n, e) => n + [e.owner, e.assistant, e.aside ?? "", e.interruption ?? ""].reduce((s, v) => s + Buffer.byteLength(v), 0), 0);
  const target = 220000, budget = (target - 6000 - 345 * c.turnCount) * 4 - plainBytes;
  const automatic = background.filter(e => e.tool.bytes === 0);
  const fixedBytes = calls.reduce((n, e) => n + e.tool.bytes, 0);
  const remainder = Math.max(automatic.length * 8192, Math.min(automatic.length * 65536, budget - fixedBytes));
  const estimate = Math.ceil((fixedBytes + remainder + plainBytes) / 4) + 6000 + 345 * c.turnCount;
  need(estimate >= 214000 && estimate <= 228000, "pressure_budget_impossible");
  automatic.forEach((e, i) => { e.tool.bytes = Math.floor(remainder / automatic.length) + (i < remainder % automatic.length ? 1 : 0); });
  const epoch = Date.UTC(2040, 0, 1);
  const turns = raw.map((e, i) => ({
    id: turnId(i), at: new Date(epoch + Math.floor(i * c.sessions / c.turnCount) * 86400000 + i * 60000).toISOString(), user: e.owner,
    steps: [...(e.tool ? [{ ...(e.aside ? { say: e.aside } : {}), call: { tool: OPERATIONS[e.tool.operation], args: e.tool.args,
      result: resultBody(e.tool, () => substitute(pick(family.templates.toolBody), bindings)) }, ...(e.interruption ? { steer: e.interruption } : {}) }] : []), { reply: e.assistant }],
  }));
  const trace = { id: c.id, title: c.title, fictional: true, family: "long", owner: { displayName: c.owner },
    generated: { generator: HOLDOUT_VERSION, seed, scenario: family.id, group: family.group },
    midCheckpoint: turnId(c.midpoint), probeAt: new Date(epoch + (c.sessions + 1) * 86400000).toISOString(), turns,
    probes: c.probes.map((p, i) => ({ id: `p${String(i + 1).padStart(2, "0")}`, category: p.category, question: p.question,
      ...(p.format ? { format: p.format } : {}), abstainOption: p.abstainOption, score: p.score,
      evidence: p.evidence.map(turnId), ...(i < 3 ? { sourceTurn: turnId(p.source), pressure: ["outside_window_and_projection", "middle_of_long_result", "head_of_oversized_result"][i] } : {}) })) };
  validateTrace(trace);
  const sourceStrings = [];
  mapStrings(sourceOnly(trace), s => { sourceStrings.push(s); return s; });
  const source = sourceStrings.join("\n");
  need(!c.unstated.some(s => source.includes(s)), "unstated_evidence_leakage");
  for (const probe of trace.probes) {
    const prompt = probe.question + " " + (probe.format ?? "");
    need(!source.includes(probe.question) && !source.includes(canonicalJson(probe.score))
      && !(probe.score.rubric && (source.includes(probe.score.rubric) || prompt.includes(probe.score.rubric)))
      && !(probe.score.kind === "value" && probe.score.accept.some(p => new RegExp(p, "iu").test(prompt))), "answer_key_leakage");
    if (["identifier", "redaction"].includes(probe.score.kind)) {
      const values = probe.score.kind === "identifier" ? probe.score.accept : [probe.score.secret];
      const question = compactIdentifier(probe.question + (probe.format ?? ""));
      const args = compactIdentifier(canonicalJson(turns.flatMap(t => t.steps.filter(s => s.call).map(s => s.call.args))));
      for (const value of values) need(!question.includes(compactIdentifier(value)) && !args.includes(compactIdentifier(value)), "answer_key_leakage");
      if (probe.score.kind === "redaction") need(probe.evidence.some(id => turns.find(t => t.id === id)?.steps.some(s => s.call
        && compactIdentifier(s.call.result).includes(compactIdentifier(probe.score.secret)))), "secret_evidence_mismatch");
    }
  }
  for (let i = 0; i < 3; i++) {
    const probe = trace.probes[i], tool = turns[c.probes[i].source].steps.find(s => s.call)?.call;
    for (const value of probe.score.accept) {
      const location = tool?.result.indexOf(value) ?? -1;
      need(location >= 0, "identifier_source_mismatch");
      const offset = Buffer.byteLength(tool.result.slice(0, location));
      if (i === 1) need(offset > 16384 && Math.abs(offset - Buffer.byteLength(tool.result) / 2) < 2048, "identifier_not_in_middle");
      if (i === 2) need(offset < 2048 && Buffer.byteLength(tool.result) > 16384, "identifier_not_in_head");
      const compact = compactIdentifier(value), result = compactIdentifier(tool.result);
      need(result.indexOf(compact) === result.lastIndexOf(compact) && turns.every((t, index) => index === c.probes[i].source
        || !compactIdentifier(canonicalJson(t)).includes(compact)), "identifier_repeated");
    }
  }
  const decoyHistory = compactIdentifier(canonicalJson(turns.filter((_, i) => i !== c.probes[2].source)));
  need(trace.probes[2].score.reject.every(value => decoyHistory.includes(compactIdentifier(value))), "identifier_decoy_missing");
  return trace;
}

/** Streaming keeps a full registered-design freeze from retaining all long results in memory. */
export function* generateHoldout(spec, seeds, statisticalSpec = STATISTICAL_SPEC) {
  for (const { family, item, seed } of selectHoldoutCases(spec, seeds, statisticalSpec)) yield generateHoldoutTrace(family, item, seed);
}
