import { STATISTICAL_SPEC } from "./continuity-holdout-statistics.mjs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { grams, wordRuns, literals } from "./continuity-overlap-text.mjs";
import { generateHoldout } from "./continuity-holdout-generator.mjs";
import { digest } from "./continuity-dataset.mjs";
import { probePrompt } from "./continuity-score.mjs";
import { TOOL_NAMES } from "./continuity-tools.mjs";
import { CHECKOUT, sha256 } from "./continuity-holdout-files.mjs";

const SOURCE_PATHS = ["scripts/lib/continuity-generator.mjs", "packages/conversation/src/continuity/ledger.ts", "packages/conversation/src/continuity/ranking.ts"];
const modes = { raw7: text => wordRuns(text, 7, false), content3: text => grams(text) };
const strings = value => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
export async function overlapSources() {
  const code = await Promise.all(SOURCE_PATHS.map(async name => ({ name, text: await readFile(resolve(CHECKOUT, name), "utf8") })));
  const directory = "scripts/fixtures/continuity";
  const fixtures = await Promise.all((await readdir(resolve(CHECKOUT, directory))).filter(name => name.endsWith(".json")).sort().map(async name => {
    const text = await readFile(resolve(CHECKOUT, directory, name), "utf8");
    return { name: `${directory}/${name}`, text, values: strings(JSON.parse(text)) };
  }));
  return [...code, ...fixtures];
}
export function validateAllowlist(allowlist) {
  if (allowlist?.schema !== "holdout-overlap-allowlist-v1" || !Array.isArray(allowlist.entries)
    || Object.keys(allowlist).some(k => !["schema", "entries"].includes(k))) throw new Error("invalid_allowlist");
  const seen = new Set();
  for (const entry of allowlist.entries) {
    if (!entry || Object.keys(entry).sort().join(",") !== "justification,mode,phrase" || !Object.hasOwn(modes, entry.mode)
      || typeof entry.phrase !== "string" || modes[entry.mode](entry.phrase).length !== 1 || modes[entry.mode](entry.phrase)[0] !== entry.phrase
      || typeof entry.justification !== "string" || entry.justification.trim().length < 20 || seen.has(`${entry.mode}:${entry.phrase}`)) throw new Error("invalid_allowlist_entry");
    seen.add(`${entry.mode}:${entry.phrase}`);
  }
  return true;
}

/** All string values in narrative fields, never schema keys, operation names or tool names. */
export function specNarratives(spec) {
  return spec.families.flatMap(f => [
    ...strings(f.entities), ...strings(f.vocabulary), ...strings(f.templates),
    ...f.cases.flatMap(c => [...strings(c.bindings), c.title, c.owner, ...c.events.flatMap(e => [e.owner, e.assistant, e.aside, e.interruption,
      ...strings(e.tool?.args), ...strings(e.tool?.head), ...strings(e.tool?.middle), ...strings(e.tool?.tail)]),
    ...c.probes.flatMap(p => [p.question, p.format, ...strings(p.score).filter(v => v !== p.score.kind)])]),
  ]).filter(v => typeof v === "string" && !TOOL_NAMES.includes(v));
}
export function traceNarratives(trace) {
  return [trace.title, trace.owner.displayName, ...trace.turns.flatMap(t => [t.user, ...t.steps.flatMap(s => [s.reply, s.say, s.steer, s.call?.result, ...strings(s.call?.args)])])
    .filter(v => typeof v === "string"), ...trace.probes.map(probePrompt)];
}

/** Pure matcher seam also exercises planted negative controls without rendering a real corpus. */
export function overlapMatcher(sources, allowlist) {
  validateAllowlist(allowlist);
  const exceptions = new Map(allowlist.entries.map(e => [`${e.mode}:${e.phrase}`, e]));
  const indexes = Object.fromEntries(Object.keys(modes).map(mode => [mode, new Map()]));
  for (const source of sources) for (const literal of (source.values ?? literals(source.text)).filter(v => !TOOL_NAMES.includes(v))) {
    for (const [mode, tokenize] of Object.entries(modes)) for (const phrase of tokenize(literal)) {
      if (!indexes[mode].has(phrase)) indexes[mode].set(phrase, new Set()); indexes[mode].get(phrase).add(source.name);
    }
  }
  const findings = new Map(), seenTexts = new Set();
  return {
    add(text, location) {
      if (seenTexts.has(text)) return; seenTexts.add(text);
      for (const [mode, tokenize] of Object.entries(modes)) for (const phrase of new Set(tokenize(text))) {
        const matches = indexes[mode].get(phrase); if (!matches) continue;
        const key = `${mode}:${phrase}`;
        if (!findings.has(key)) findings.set(key, { mode, phrase, sources: [...matches].sort(), firstLocation: location,
          allowed: exceptions.has(key), ...(exceptions.has(key) ? { justification: exceptions.get(key).justification } : {}) });
      }
    },
    result() {
      const overlaps = [...findings.values()].sort((a, b) => `${a.mode}:${a.phrase}` < `${b.mode}:${b.phrase}` ? -1 : 1);
      return { pass: overlaps.every(e => e.allowed), overlaps, comparedUniqueTexts: seenTexts.size };
    },
  };
}

export async function checkHoldoutOverlap(spec, seeds, allowlist, statisticalSpec = STATISTICAL_SPEC) {
  const sources = await overlapSources(), matcher = overlapMatcher(sources, allowlist);
  specNarratives(spec).forEach((s, i) => matcher.add(s, `spec:${i}`));
  const conversations = [];
  for (const trace of generateHoldout(spec, seeds, statisticalSpec)) {
    conversations.push({ id: trace.id, sha256: digest(trace) });
    traceNarratives(trace).forEach((s, i) => matcher.add(s, `${trace.id}:${i}`));
  }
  return { schema: "holdout-overlap-report-v1", specSha256: digest(spec), statisticalSpecSha256: digest(statisticalSpec), seedsSha256: digest(seeds), allowlistSha256: digest(allowlist),
    sources: sources.map(s => ({ name: s.name, sha256: sha256(s.text) })), conversations, ...matcher.result(),
    limitation: "Lexical disjointness does not establish conceptual independence; independent provenance and semantic review remain required." };
}
