import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson, sourceOnly } from "../lib/continuity-dataset.mjs";
import { generateHoldout, generateHoldoutTrace, loadHoldoutSpec, selectHoldoutCases, validateHoldoutSpec } from "../lib/continuity-holdout-generator.mjs";
import { checkHoldoutOverlap, overlapMatcher, overlapSources, validateAllowlist } from "../lib/continuity-holdout-overlap.mjs";
import { wordRuns, literals } from "../lib/continuity-overlap-text.mjs";
import { externalDirectory, jsonBytes, CHECKOUT } from "../lib/continuity-holdout-files.mjs";
import { freezeHoldout, verifyHoldout } from "../continuity-holdout-freeze.mjs";

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "holdout-fixture-")); dirs.push(dir); return dir; }
const seeds = { ordinary: 12345, distractor: 98765 };
const emptyAllowlist = { schema: "holdout-overlap-allowlist-v1", entries: [] };

// Tiny, unmistakably synthetic templates expanded mechanically ONLY to exercise
// minimum schema counts. These are not narrative content or a holdout seed pool.
function fixtureCase(n) {
  const id = `fixture-case-${n}`, early = `FXEARLY-${n}-ABC`, middle = `FXMIDDLE-${n}-ABC`, head = `FXHEAD-${n}-ABC`, secret = `FXSECRET-${n}-ABC`;
  const tool = (bytes, facts = [], mid = []) => ({ operation: "read", args: {}, bytes, head: facts, middle: mid, tail: [] });
  const event = (at, extra = {}) => ({ at, owner: `Fixture source ${n} at ${at}.`, assistant: "Fixture acknowledgement.", ...extra });
  const probe = (category, score, i, evidence) => ({ category, score, question: `Fixture inquiry ${n} number ${i}?`, abstainOption: ![5, 15].includes(i), evidence });
  return { id, title: "Fixture title", owner: "{{person}}", bindings: {}, turnCount: 96, toolCount: 72, sessions: 8, midpoint: 47,
    events: [event(0), event(1, { tool: tool(8192, [early]), interruption: "Fixture interruption alpha." }),
      event(3, { tool: tool(8192, [secret]), interruption: "Fixture interruption beta." }),
      event(10, { owner: `Fixture previous VALUE-OLD-${n}; now VALUE-NEW-${n}.` }),
      event(20, { tool: tool(40960, [], [middle]) }), event(30, { tool: tool(24576, [head]) }),
      event(40), event(55, { owner: `Fixture next ACTION-${n} by DEADLINE-${n}.` }), event(60)],
    features: { correction: [10], deliberation: [40], decision: [55], outstanding: [55], fulfilled: [60], distractor: [60] },
    unstated: ["Fixture absent alpha", "Fixture absent beta"],
    probes: [
      ...[early, middle, head].map((value, i) => ({ ...probe("tool_identifier", { kind: "identifier", accept: [value] }, i + 1, [[1], [20], [30]][i]), source: [1, 20, 30][i], placement: ["early", "middle", "head"][i] })),
      probe("active_constraint", { kind: "constraint_recall", requireAll: [["FixtureAllowed"]] }, 4, [0]),
      probe("active_constraint", { kind: "constraint_task", forbidden: ["FixtureForbidden"] }, 5, [0]),
      ...[6, 7].map(i => probe("superseded_current", { kind: "value", accept: [`VALUE-NEW-${n}`], superseded: [`VALUE-OLD-${n}`] }, i, [10])),
      ...[8, 9, 10, 11].map(i => probe(i < 10 ? "commitment_status" : "artifact_status", { kind: "choice", options: ["PENDING", "COMPLETE"], expected: "PENDING" }, i, [40])),
      probe("next_action", { kind: "next_action", proxyAll: [[`ACTION-${n}`], [`DEADLINE-${n}`]], rubric: `Fixture-only semantic key for case ${n}, action and deadline.` }, 12, [55]),
      probe("abstention", { kind: "abstain" }, 13, []), probe("abstention", { kind: "abstain" }, 14, []),
      probe("redaction", { kind: "redaction", secret }, 15, [3]),
    ] };
}
function fixtureSpec() {
  return { schema: "fictional-conversations-v1", fictional: true,
    provenance: { authorId: "fixture-author", createdAt: "2040-01-01T00:00:00.000Z", independent: true, references: [], exposures: [],
      declaration: "Fixture declaration only: wholly fictional synthetic test content, not an evaluation corpus." },
    families: Array.from({ length: 16 }, (_, i) => ({ id: `fixture-family-${String(i).padStart(2, "0")}`, group: i < 8 ? "ordinary" : "distractor", count: 16,
      entities: { person: "Fixture Person" }, vocabulary: { word: "Fixtureword" },
      templates: { owner: ["Fixture owner alpha.", "Fixture owner beta."], assistant: ["Fixture reply alpha.", "Fixture reply beta."], toolBody: ["Fixture filler alpha.", "Fixture filler beta."] },
      cases: Array.from({ length: 16 }, (_, j) => fixtureCase(i * 16 + j + 100)) })) };
}
async function writeSpec(dir, spec) {
  await mkdir(dir, { recursive: true });
  const families = [];
  for (const f of spec.families) { const file = `${f.id}.json`; await writeFile(join(dir, file), jsonBytes(f)); families.push({ id: f.id, group: f.group, count: f.count, file }); }
  await writeFile(join(dir, "index.json"), jsonBytes({ ...spec, families }));
}

describe("holdout author schema", () => {
  it("loads directory families in ID order and schema CLI does not render or compare text", async () => {
    const dir = await scratch(), spec = fixtureSpec(); spec.families.reverse();
    await writeSpec(dir, spec);
    const loaded = await loadHoldoutSpec(dir);
    expect(loaded.families.map(f => f.id)).toEqual([...loaded.families.map(f => f.id)].sort());
    // Schema-only intentionally accepts evidence text needing later leakage review.
    spec.families[0].cases[0].events[0].owner = spec.families[0].cases[0].probes[0].question;
    await writeSpec(dir, spec);
    const cli = spawnSync(process.execPath, [new URL("../holdout-validate.mjs", import.meta.url).pathname, "--spec-dir", dir, "--schema-only"], { encoding: "utf8" });
    expect(cli.status, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).scope).toBe("schema-only");
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8")); index.families[0].file = "../escape.json";
    await writeFile(join(dir, "index.json"), jsonBytes(index));
    await expect(loadHoldoutSpec(dir)).rejects.toThrow("invalid_spec_filename");
  });
  it.each([
    ["provenance", s => { s.provenance.independent = false; }],
    ["fictional", s => { s.fictional = false; }],
    ["exposure", s => { s.provenance.exposures.push("fixture exposure"); }],
    ["identity", s => { s.families[0].cases[1].id = s.families[0].cases[0].id; }],
    ["reskin", s => { s.families[0].cases[1].events = structuredClone(s.families[0].cases[0].events); }],
    ["coverage", s => { s.families[0].cases[0].probes.pop(); }],
    ["key", s => { s.families[0].cases[0].events[0].score = { kind: "abstain" }; }],
    ["evidence", s => { s.families[0].cases[0].probes[0].source = 79; }],
    ["slot", s => { s.families[0].templates.owner[0] = "{{missing}}"; }],
    ["mixture", s => { s.families[0].count = 15; }],
    ["score", s => { s.families[0].cases[0].probes[5].score.accept = ["["]; }],
    ["history length", s => { s.families[0].cases[0].turnCount = 79; }],
    ["result size", s => { s.families[0].cases[0].events[1].tool.bytes = 1024; }],
    ["steer count", s => { delete s.families[0].cases[0].events[1].interruption; }],
  ])("rejects malformed %s", (_, mutate) => { const spec = fixtureSpec(); mutate(spec); expect(() => validateHoldoutSpec(spec)).toThrow(); });
  it("rejects family mismatch and symlink inputs", async () => {
    const dir = await scratch(), spec = fixtureSpec(); await writeSpec(dir, spec);
    const path = join(dir, `${spec.families[0].id}.json`);
    await writeFile(path, jsonBytes({ ...spec.families[0], count: 1 }));
    await expect(loadHoldoutSpec(dir)).rejects.toThrow("family_index_mismatch");
    await rm(path); await symlink(join(dir, `${spec.families[1].id}.json`), path);
    await expect(loadHoldoutSpec(dir)).rejects.toThrow("invalid_spec_file");
  });
});

describe("deterministic holdout rendering", () => {
  it("samples 256 disjoint identities with fixed mixture and category/pressure coverage", () => {
    const spec = fixtureSpec(), rows = selectHoldoutCases(spec, seeds), groups = { ordinary: 0, distractor: 0 };
    expect(rows).toHaveLength(256); expect(new Set(rows.map(r => r.item.id)).size).toBe(256);
    const first = rows[0];
    expect(canonicalJson(generateHoldoutTrace(first.family, first.item, first.seed))).toBe(canonicalJson(generateHoldoutTrace(first.family, first.item, first.seed)));
    expect(selectHoldoutCases({ ...spec, families: [...spec.families].reverse() }, seeds).map(r => [r.item.id, r.seed])).toEqual(rows.map(r => [r.item.id, r.seed]));
    expect(selectHoldoutCases(spec, { ordinary: 23456, distractor: 87654 }).map(r => r.item.id)).not.toEqual(rows.map(r => r.item.id));
    for (const trace of generateHoldout(spec, seeds)) {
      groups[trace.generated.group]++;
      expect(trace.probes).toHaveLength(15); expect(new Set(trace.probes.map(p => p.category)).size).toBe(8);
      expect(JSON.stringify(sourceOnly(trace))).not.toContain("rubric");
      expect(trace.turns.flatMap(t => t.steps.filter(s => s.call))).toHaveLength(72);
    }
    expect(groups).toEqual({ ordinary: 128, distractor: 128 });
  }, 120000);
  it("preserves UTF-8 result byte budgets and rejects impossible pressure", () => {
    const family = fixtureSpec().families[0], item = family.cases[0];
    family.templates.toolBody = ["Fixture αβ filler.", "Fixture δγ filler."];
    const trace = generateHoldoutTrace(family, item, 123);
    const calls = trace.turns.flatMap(t => t.steps.filter(s => s.call));
    expect(calls.every(s => Buffer.byteLength(s.call.result) >= 8192 && Buffer.byteLength(s.call.result) <= 65536)).toBe(true);
    expect(calls.filter(s => Buffer.byteLength(s.call.result) > 16384).length).toBeGreaterThanOrEqual(3);
    item.events[0].owner = "Fixture huge source. ".repeat(100000);
    expect(() => generateHoldoutTrace(family, item, 123)).toThrow("pressure_budget_impossible");
  });
  it.each(["question", "rubric", "visible_identifier", "args_identifier", "question_identifier", "question_value", "unstated", "repeated_early", "middle_placement"])("rejects %s leakage or invalid placement", kind => {
    const family = fixtureSpec().families[0], item = family.cases[0];
    if (kind === "question") item.events[0].owner = item.probes[0].question;
    if (kind === "rubric") item.events[0].owner = item.probes[11].score.rubric;
    if (kind === "visible_identifier") item.events[0].assistant += item.probes[0].score.accept[0];
    if (kind === "args_identifier") item.events[1].tool.args = { query: item.probes[0].score.accept[0] };
    if (kind === "question_identifier") item.probes[0].question += item.probes[0].score.accept[0];
    if (kind === "question_value") item.probes[5].question += item.probes[5].score.accept[0];
    if (kind === "unstated") item.events[0].owner += item.unstated[0];
    if (kind === "repeated_early") item.events[4].tool.head.push(item.probes[0].score.accept[0]);
    if (kind === "middle_placement") { const tool = item.events[4].tool; tool.head = tool.middle; tool.middle = []; }
    expect(() => generateHoldoutTrace(family, item, 123)).toThrow();
  });
});

describe("lexical independence", () => {
  it("catches planted dev and prompt strings, joined template spans and both gram modes", async () => {
    const sources = await overlapSources(), matcher = overlapMatcher(sources, emptyAllowlist);
    for (const source of sources.slice(0, 2)) {
      const planted = literals(source.text).find(s => wordRuns(s, 7, false).length > 0);
      expect(planted).toBeTruthy(); matcher.add(planted, "fixture planted phrase");
    }
    const result = matcher.result(); expect(result.pass).toBe(false);
    expect(new Set(result.overlaps.flatMap(r => r.sources))).toContain(sources[0].name);
    expect(new Set(result.overlaps.flatMap(r => r.sources))).toContain(sources[1].name);
    expect(new Set(result.overlaps.map(r => r.mode))).toEqual(new Set(["raw7", "content3"]));
    const joined = overlapMatcher([{ name: "fixture", text: "`alpha ${one} of beta ${two} gamma`" }], emptyAllowlist);
    joined.add("alpha beta gamma", "fixture"); expect(joined.result().pass).toBe(false);
  });
  it("honours narrowly justified frozen exceptions and excludes keys/tool names", () => {
    const allow = { schema: emptyAllowlist.schema, entries: [{ mode: "content3", phrase: "alpha beta gamma", justification: "Fixture-only generic-language exception justification." }] };
    const matcher = overlapMatcher([{ name: "fixture", text: '"alpha of beta gamma"; "mail_search";' }], allow);
    matcher.add("mail_search", "fixture tool"); matcher.add("independent unique placeholder", "fixture clean");
    expect(matcher.result().overlaps).toEqual([]);
    matcher.add("alpha beta gamma", "fixture allowed"); expect(matcher.result().pass).toBe(true);
    expect(matcher.result().overlaps[0].allowed).toBe(true);
    expect(() => validateAllowlist({ ...allow, entries: [{ ...allow.entries[0], justification: "short" }] })).toThrow();
  });
});

it("freezes external canonical bytes and detects artifact, manifest, allowlist and tooling mutation", async () => {
  const dir = await scratch(), specDir = join(dir, "spec"), spec = fixtureSpec(); await writeSpec(specDir, spec);
  const loaded = await loadHoldoutSpec(specDir);
  let report = await checkHoldoutOverlap(loaded, seeds, emptyAllowlist);
  // Any shared generic fixture language is an explicit test-only exception, never a real allowlist.
  const allowlist = { schema: emptyAllowlist.schema, entries: report.overlaps.map(({ mode, phrase }) => ({ mode, phrase, justification: "Synthetic fixture generic-language exception for this unit test only." })) };
  report = await checkHoldoutOverlap(loaded, seeds, allowlist);
  expect(report.pass).toBe(true);
  const paths = { seedsPath: join(dir, "seeds.json"), overlapPath: join(dir, "overlap.json"), rubricPath: join(dir, "rubric"), protocolPath: join(dir, "protocol"), allowlistPath: join(dir, "allowlist.json") };
  for (const [path, data] of [[paths.seedsPath, jsonBytes(seeds)], [paths.overlapPath, jsonBytes(report)], [paths.rubricPath, "Fixture rubric"], [paths.protocolPath, "Fixture protocol"], [paths.allowlistPath, jsonBytes(allowlist)]]) await writeFile(path, data);
  const outputDir = join(dir, "frozen");
  const frozen = await freezeHoldout({ specDir, outputDir, ...paths });
  expect(frozen.conversations).toBe(256);
  expect((await verifyHoldout(outputDir, frozen.manifestSha256)).pass).toBe(true);
  for (const name of ["spec.json", "seeds.json", "selection.json", "allowlist.json", "overlap.json", "rubric", "protocol", "tooling/scripts/lib/continuity-holdout-generator.mjs",
    `conversations/${(await readdir(join(outputDir, "conversations")))[0]}`, `answers/${(await readdir(join(outputDir, "answers")))[0]}`, "manifest.json", "manifest.sha256"]) {
    const path = join(outputDir, name), original = await readFile(path); await writeFile(path, Buffer.concat([original, Buffer.from(" ")]));
    await expect(verifyHoldout(outputDir, frozen.manifestSha256)).rejects.toThrow(); await writeFile(path, original);
  }
  await writeFile(join(outputDir, "unexpected"), "Fixture extra"); await expect(verifyHoldout(outputDir, frozen.manifestSha256)).rejects.toThrow("unexpected_frozen_file");
  await rm(join(outputDir, "unexpected"));
  await writeFile(paths.overlapPath, jsonBytes({ ...report, pass: false }));
  await expect(freezeHoldout({ specDir, outputDir: join(dir, "stale"), ...paths })).rejects.toThrow("overlap_report_not_passing_or_stale");
  await expect(externalDirectory(resolve(CHECKOUT, ".worklab-tmp/forbidden-output"), true)).rejects.toThrow("output_must_be_outside_checkout");
  await symlink(CHECKOUT, join(dir, "checkout-link"));
  await expect(externalDirectory(join(dir, "checkout-link", "new-output"), true)).rejects.toThrow("output_must_be_outside_checkout");
}, 180000);
