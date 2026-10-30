import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rescore, validateOverlay } from "../continuity-rescore.mjs";

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "continuity-rescore-")); dirs.push(dir);
  const units = join(dir, "units"), answers = join(dir, "answers");
  await mkdir(units); await mkdir(answers);
  const key = [{ id: "p01", category: "superseded_current", score: { kind: "value", accept: ["blue green"], superseded: ["red"] } }];
  const trial = { traceId: "bakery", probeId: "p01", answer: "blue-green", arm: "native", score: { pass: false, outcome: "wrong", abstained: false, falseAbstention: false } };
  const unit = join(units, "a.json"), answer = join(answers, "bakery.json");
  await writeFile(unit, JSON.stringify({ trials: [trial] })); await writeFile(answer, JSON.stringify(key));
  return { dir, units, answers, unit, answer, scorerVersion: "v2", output: join(dir, "report.json") };
}

it("compares archived verdicts deterministically and hashes untouched inputs", async () => {
  const f = await fixture(), before = await readFile(f.unit);
  const a = await rescore(f), b = await rescore({ ...f, output: join(f.dir, "second.json") });
  expect(a).toEqual(b);
  expect(await readFile(f.unit)).toEqual(before);
  expect(a.summary).toEqual({ trials: 1, changed: 1, byArm: [{ arm: "native", direction: "fail_to_pass", n: 1 }], byCategory: [{ category: "superseded_current", direction: "fail_to_pass", n: 1 }] });
  expect(a.inputs).toHaveLength(2);
  expect(a.scorerSources).toHaveLength(3);
  expect(a.inputs.every(row => /^[a-f0-9]{64}$/u.test(row.sha256))).toBe(true);
  const v1 = await rescore({ ...f, units: join(f.units, "*.json"), scorerVersion: "v1", output: join(f.dir, "v1.json") });
  expect(v1.summary.changed).toBe(0);
});

it("validates and hashes external key patches without editing frozen keys", async () => {
  const f = await fixture(), original = await readFile(f.answer), overlay = join(f.dir, "overlay.json");
  await writeFile(overlay, JSON.stringify({ schema: "continuity-key-overlay-v1", patches: [{ traceId: "bakery", probeId: "p01", score: { aliases: { accept: ["teal"] } } }] }));
  const result = await rescore({ ...f, overlay });
  expect(result.overlaySha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(await readFile(f.answer)).toEqual(original);
  await expect(rescore({ ...f, overlay, scorerVersion: "v1", output: join(f.dir, "invalid.json") })).rejects.toThrow("v2_fields_require_version");
  await writeFile(overlay, JSON.stringify({ schema: "continuity-key-overlay-v1", patches: [{ traceId: "bakery", probeId: "p99", score: { accept: ["teal"] } }] }));
  await expect(rescore({ ...f, overlay, output: join(f.dir, "unused.json") })).rejects.toThrow("unused_overlay_patch");
});

it("rejects malformed, duplicate and unknown patches and unsafe output targets", async () => {
  const f = await fixture();
  for (const value of [{}, { schema: "continuity-key-overlay-v1", patches: [{ traceId: "../escape", probeId: "p01", score: {} }] }, { schema: "continuity-key-overlay-v1", patches: [{ traceId: "bakery", probeId: "p01", score: { invented: true } }] }]) expect(() => validateOverlay(value)).toThrow();
  const patch = { traceId: "bakery", probeId: "p01", score: { accept: ["teal"] } };
  expect(() => validateOverlay({ schema: "continuity-key-overlay-v1", patches: [patch, patch] })).toThrow("duplicate_overlay_patch");
  await expect(rescore({ ...f, output: f.unit })).rejects.toThrow("output_overwrites_input");
  await expect(rescore({ ...f, output: join(f.answers, "new.json") })).rejects.toThrow("output_overwrites_input");
  const link = join(f.dir, "alias.json"); await symlink(f.answer, link);
  await expect(rescore({ ...f, output: link })).rejects.toThrow();
  await expect(rescore({ ...f, scorerVersion: "v3" })).rejects.toThrow("invalid_scorer_version");
});

it("exercises the offline executable flags without provider access", async () => {
  const f = await fixture();
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../continuity-rescore.mjs", import.meta.url)), "--units", f.units, "--answers", f.answers, "--scorer-version", "v2", "--output", f.output], { encoding: "utf8" });
  expect(run.stderr).toBe(""); expect(run.status).toBe(0);
  expect(JSON.parse(await readFile(f.output, "utf8")).summary.changed).toBe(1);
});

it("keeps CLI pass-to-fail counts zero for authored regex compatibility cases", async () => {
  const f = await fixture();
  const cases = [
    { answer: "Catalogued crates with spare tassels.", score: { kind: "next_action", proxyAll: [["catalog"], ["crate"], ["spare.*(?:ribbon|tassel)"]], rubric: "Catalogue the crates and spare ribbons or tassels." } },
    { answer: "Cobalt and amber", score: { kind: "value", accept: ["(?=[\\s\\S]*\\bcobalt\\b)(?=[\\s\\S]*\\bamber\\b)"], superseded: ["silver"] } },
    { answer: "The label must include the batch code; the lot origin stays private.", score: { kind: "constraint_recall", requireAll: [["label.*include.*batch"], ["origin.*private"]] } },
    { answer: "Do not discard the return slip; reconcile it by Tuesday.", score: { kind: "next_action", proxyAll: [["discard"], ["return slip"], ["Tuesday"]], rubric: "Keep the return slip, do not discard it, and reconcile it by Tuesday." } },
  ];
  const keys = cases.map((row, i) => ({ id: `p0${i + 1}`, score: row.score }));
  await writeFile(f.answer, JSON.stringify(keys));
  await writeFile(f.unit, JSON.stringify({ trials: cases.map((row, i) => ({ traceId: "bakery", probeId: keys[i].id, answer: row.answer, score: { pass: true, outcome: "correct", abstained: false, falseAbstention: false } })) }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../continuity-rescore.mjs", import.meta.url)), "--units", f.units, "--answers", f.answers, "--scorer-version", "v2", "--output", f.output], { encoding: "utf8" });
  expect(run.stderr).toBe(""); expect(run.status).toBe(0);
  const report = JSON.parse(await readFile(f.output, "utf8"));
  expect(report.trials.filter(row => row.old.pass && !row.new.pass)).toHaveLength(0);
  expect(report.summary.changed).toBe(0);
});
