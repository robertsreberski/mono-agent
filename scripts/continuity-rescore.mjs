#!/usr/bin/env node
// Offline archival comparison only: never updates archived scores or registration.
import { createHash } from "node:crypto";
import { glob, readFile, writeFile, stat, realpath } from "node:fs/promises";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreAnswer, validateProbeScore } from "./lib/continuity-score.mjs";
import { V2_FIELDS } from "./lib/continuity-score-v2.mjs";

const FIELDS = { identifier: ["accept", "reject"], value: ["accept", "superseded"], choice: ["options", "expected"], constraint_recall: ["requireAll"], constraint_task: ["forbidden"], next_action: ["proxyAll", "rubric"], abstain: [], redaction: ["secret"] };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (ok, code) => { if (!ok) throw new Error(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/u.test(value);
const strictScore = score => {
  need(object(score) && FIELDS[score.kind] && Object.keys(score).every(k => ["kind", ...FIELDS[score.kind], ...V2_FIELDS].includes(k)), "invalid_score_fields");
  validateProbeScore({ score });
};

export function validateOverlay(value) {
  need(object(value) && Object.keys(value).every(k => ["schema", "patches"].includes(k)) && value.schema === "continuity-key-overlay-v1" && Array.isArray(value.patches), "invalid_overlay");
  const seen = new Set();
  for (const row of value.patches) {
    need(object(row) && Object.keys(row).every(k => ["traceId", "probeId", "score"].includes(k)) && identity(row.traceId) && identity(row.probeId) && object(row.score), "invalid_overlay_patch");
    const key = `${row.traceId}/${row.probeId}`;
    need(!seen.has(key), "duplicate_overlay_patch"); seen.add(key);
    need(Object.keys(row.score).length > 0 && Object.keys(row.score).every(k => V2_FIELDS.includes(k)), "invalid_overlay_score");
  }
  return value;
}

export async function rescore({ units, answers, overlay, scorerVersion, output }) {
  need(["v1", "v2"].includes(scorerVersion), "invalid_scorer_version");
  need(typeof units === "string" && typeof answers === "string" && typeof output === "string", "missing_rescore_input");
  const inputs = new Map();
  const read = async path => {
    const canonical = await realpath(path), bytes = await readFile(canonical);
    inputs.set(canonical, hash(bytes));
    return JSON.parse(bytes.toString("utf8"));
  };
  const answersDir = await realpath(answers);
  const unitDir = await stat(units).then(s => s.isDirectory() ? realpath(units) : null).catch(() => null);
  const pattern = unitDir ? join(unitDir, "**/*.json") : units;
  const paths = [];
  for await (const path of glob(pattern)) if ((await stat(path)).isFile()) paths.push(await realpath(path));
  paths.sort();
  need(paths.length > 0 && new Set(paths).size === paths.length, "invalid_unit_files");
  const patches = overlay ? validateOverlay(await read(overlay)).patches : [];
  const patchMap = new Map(patches.map(p => [`${p.traceId}/${p.probeId}`, p.score]));
  const used = new Set(), keys = new Map(), rows = [];
  for (const path of paths) {
    const unit = await read(path);
    need(Array.isArray(unit.trials), "invalid_unit_trials");
    for (const [index, trial] of unit.trials.entries()) {
      need(identity(trial.traceId) && identity(trial.probeId) && typeof trial.answer === "string" && object(trial.score) && typeof trial.score.pass === "boolean" && typeof trial.score.outcome === "string", "invalid_archived_trial");
      if (!keys.has(trial.traceId)) {
        const keyPath = await realpath(join(answersDir, `${trial.traceId}.json`));
        need(dirname(keyPath) === answersDir, "answer_path_escape");
        const probes = await read(keyPath);
        need(Array.isArray(probes) && new Set(probes.map(p => p.id)).size === probes.length, "invalid_answer_keys");
        probes.forEach(p => strictScore(p.score));
        keys.set(trial.traceId, probes);
      }
      const probe = keys.get(trial.traceId).find(p => p.id === trial.probeId);
      need(probe, "missing_answer_key");
      const id = `${trial.traceId}/${trial.probeId}`, patch = patchMap.get(id);
      if (patch) {
        need(patch.version === undefined || patch.version === scorerVersion, "overlay_version_mismatch");
        used.add(id);
      }
      const score = { ...probe.score, ...patch, version: scorerVersion };
      // v1 comparisons cannot silently ignore v2-only overlay fields.
      strictScore(score);
      const next = scoreAnswer({ ...probe, score }, trial.answer);
      rows.push({ unit: path, index, traceId: trial.traceId, probeId: trial.probeId, repeat: trial.repeat ?? null, arm: trial.arm ?? unit.arm ?? "unknown", category: trial.category ?? probe.category ?? "unknown", old: trial.score, new: next });
    }
  }
  need(used.size === patches.length, "unused_overlay_patch");
  const changes = rows.filter(r => r.old.pass !== r.new.pass || r.old.outcome !== r.new.outcome);
  const table = field => {
    const counts = new Map();
    for (const row of changes) {
      const direction = row.old.pass === row.new.pass ? "outcome_only" : row.new.pass ? "fail_to_pass" : "pass_to_fail";
      const id = `${row[field]}\0${direction}`;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, n]) => { const [value, direction] = key.split("\0"); return { [field]: value, direction, n }; });
  };
  const scorerSources = await Promise.all(["./lib/continuity-score.mjs", "./lib/continuity-score-v2.mjs", "./continuity-rescore.mjs"].map(async name => ({ file: name, sha256: hash(await readFile(new URL(name, import.meta.url))) })));
  const report = { schema: "continuity-rescore-v1", scorerVersion, certification: "development-only; historical decisions unchanged", scorerSources, inputs: [...inputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, sha256]) => ({ file, sha256 })), overlaySha256: overlay ? inputs.get(await realpath(overlay)) : null, summary: { trials: rows.length, changed: changes.length, byArm: table("arm"), byCategory: table("category") }, trials: rows };
  const target = resolve(await realpath(dirname(resolve(output))), resolve(output).split(sep).at(-1));
  need(!inputs.has(target) && !target.startsWith(answersDir + sep) && !(unitDir && target.startsWith(unitDir + sep)) && !paths.some(path => target.startsWith(dirname(path) + sep)), "output_overwrites_input");
  // Exclusive creation prevents symlink aliases and accidental report overwrite.
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}

async function main(args) {
  const names = { "--units": "units", "--answers": "answers", "--overlay": "overlay", "--scorer-version": "scorerVersion", "--output": "output" };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    need(key && args[i + 1] && !Object.hasOwn(options, key), "invalid_rescore_arguments");
    options[key] = args[i + 1];
  }
  await rescore(options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
