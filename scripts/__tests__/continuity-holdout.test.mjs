import { fixtureSpec, writeSpec, fixtureGit, fixtureCommit, toolingRepository } from "./fixtures/holdout-synthetic.mjs";
import { STATISTICAL_SPEC } from "../lib/continuity-holdout-statistics.mjs";
import { constants } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, cp, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalJson, sourceOnly } from "../lib/continuity-dataset.mjs";
import { generateHoldout, generateHoldoutTrace, loadHoldoutSpec, selectHoldoutCases, validateHoldoutSpec } from "../lib/continuity-holdout-generator.mjs";
import { checkHoldoutOverlap, overlapMatcher, overlapSources, traceNarratives, validateAllowlist } from "../lib/continuity-holdout-overlap.mjs";
import { wordRuns, literals } from "../lib/continuity-overlap-text.mjs";
import { externalDirectory, readJson, externalFile, jsonBytes, CHECKOUT } from "../lib/continuity-holdout-files.mjs";

const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "holdout-fixture-")); dirs.push(dir); return dir; }
const seeds = { ordinary: 12345, distractor: 98765 };
const emptyAllowlist = { schema: "holdout-overlap-allowlist-v1", entries: [] };

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
    ["provenance", "invalid_provenance", s => { s.provenance.independent = false; }],
    ["fictional", "fictional_spec_required", s => { s.fictional = false; }],
    ["exposure", "invalid_provenance", s => { s.provenance.exposures.push("fixture exposure"); }],
    ["identity", "duplicate_case_identity", s => { s.families[0].cases[1].id = s.families[0].cases[0].id; }],
    ["reskin", "duplicate_case_structure", s => { s.families[0].cases[1].events = structuredClone(s.families[0].cases[0].events); }],
    ["coverage", "invalid_probe_allocation", s => { s.families[0].cases[0].probes.pop(); }],
    ["key", "invalid_fields", s => { s.families[0].cases[0].events[0].score = { kind: "abstain" }; }],
    ["evidence", "invalid_identifier_provenance", s => { s.families[0].cases[0].probes[0].source = 79; }],
    ["slot", "unknown_slot", s => { s.families[0].templates.owner[0] = "{{missing}}"; }],
    ["mixture", "invalid_family_mixture", s => { s.families[0].count = 15; }],
    ["score", "invalid_probe_score", s => { s.families[0].cases[0].probes[5].score.accept = ["["]; }],
    ["history length", "invalid_integer", s => { s.families[0].cases[0].turnCount = 79; }],
    ["result size", "invalid_integer", s => { s.families[0].cases[0].events[1].tool.bytes = 1024; }],
    ["steer count", "invalid_event_tool_count", s => { delete s.families[0].cases[0].events[1].interruption; }],
    ["filler variety", "invalid_strings", s => { s.families[0].templates.toolBody.pop(); }],
    ["required decoy", "missing_identifier_decoy", s => { delete s.families[0].cases[0].probes[2].score.reject; }],
    ["conflicting decoy", "identifier_decoy_conflict", s => { const p = s.families[0].cases[0].probes[2]; p.score.reject = p.score.accept; }],
  ])("rejects malformed %s", (_, code, mutate) => { const spec = fixtureSpec(); mutate(spec); expect(() => validateHoldoutSpec(spec)).toThrowError(new Error(code)); });
  it("rejects family mismatch and symlink inputs", async () => {
    const dir = await scratch(), spec = fixtureSpec(); await writeSpec(dir, spec);
    const path = join(dir, `${spec.families[0].id}.json`);
    await writeFile(path, jsonBytes({ ...spec.families[0], count: 1 }));
    await expect(loadHoldoutSpec(dir)).rejects.toThrow("family_index_mismatch");
    await rm(path); await symlink(join(dir, `${spec.families[1].id}.json`), path);
    await expect(loadHoldoutSpec(dir)).rejects.toThrow("invalid_spec_file");
  });
});

it("rejects checkout-resident inputs and symlinked input parents", async () => {
  const code = new Error("path_must_be_outside_checkout"), dir = await scratch();
  await expect(loadHoldoutSpec(resolve(CHECKOUT, ".worklab-tmp/private-spec"))).rejects.toThrowError(code);
  await expect(readJson(resolve(CHECKOUT, "package.json"))).rejects.toThrowError(code);
  await expect(externalFile(resolve(CHECKOUT, "CHANGELOG.md"))).rejects.toThrowError(code);
  await symlink(CHECKOUT, join(dir, "checkout"));
  await expect(readJson(join(dir, "checkout/package.json"))).rejects.toThrowError(code);
  await symlink(resolve(CHECKOUT, "package.json"), join(dir, "linked.json"));
  await expect(readJson(join(dir, "linked.json"))).rejects.toThrowError(code);
});

describe("deterministic holdout rendering", () => {
  it("samples 512 disjoint identities with fixed mixture and category/pressure coverage", () => {
    const spec = fixtureSpec(), rows = selectHoldoutCases(spec, seeds), groups = { ordinary: 0, distractor: 0 };
    expect(rows).toHaveLength(512); expect(new Set(rows.map(r => r.item.id)).size).toBe(512);
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
    expect(groups).toEqual({ ordinary: 256, distractor: 256 });
  }, 120000);
  it("preserves UTF-8 result byte budgets and rejects impossible pressure", () => {
    const family = fixtureSpec().families[0], item = family.cases[0];
    family.templates.toolBody = Array.from({ length: 8 }, (_, i) => `Fixture αβ ${i} ` + "synthetic filler ".repeat(20 + i * 3));
    const trace = generateHoldoutTrace(family, item, 123);
    const calls = trace.turns.flatMap(t => t.steps.filter(s => s.call));
    const units = calls[0].call.result.split("\n").filter(s => s.startsWith("Fixture αβ"));
    expect(new Set(units).size).toBeGreaterThanOrEqual(2);
    expect(new Set(units).size / units.length).toBeGreaterThanOrEqual(0.25);
    expect(calls.every(s => Buffer.byteLength(s.call.result) >= 8192 && Buffer.byteLength(s.call.result) <= 65536)).toBe(true);
    expect(calls.filter(s => Buffer.byteLength(s.call.result) > 16384).length).toBeGreaterThanOrEqual(3);
    item.events[0].owner = "Fixture huge source. ".repeat(100000);
    expect(() => generateHoldoutTrace(family, item, 123)).toThrow("pressure_budget_impossible");
  });
  it.each([
    ["question", "answer_key_leakage"], ["rubric", "answer_key_leakage"], ["visible_identifier", "identifier_not_tool_only"],
    ["args_identifier", "answer_key_leakage"], ["question_identifier", "answer_key_leakage"], ["question_value", "answer_key_leakage"],
    ["unstated", "unstated_evidence_leakage"], ["repeated_early", "identifier_repeated"], ["repeated_middle", "identifier_repeated"],
    ["repeated_head", "identifier_repeated"], ["repeated_same_result", "identifier_repeated"],
    ["missing_decoy", "identifier_decoy_missing"], ["middle_placement", "identifier_not_in_middle"],
  ])("rejects %s leakage or invalid placement", (kind, code) => {
    const family = fixtureSpec().families[0], item = family.cases[0];
    if (kind === "question") item.events[0].owner = item.probes[0].question;
    if (kind === "rubric") item.events[0].owner = item.probes[11].score.rubric;
    if (kind === "visible_identifier") item.events[0].assistant += item.probes[0].score.accept[0];
    if (kind === "args_identifier") item.events[1].tool.args = { query: item.probes[0].score.accept[0] };
    if (kind === "question_identifier") item.probes[0].question += item.probes[0].score.accept[0];
    if (kind === "question_value") item.probes[5].question += item.probes[5].score.accept[0];
    if (kind === "unstated") item.events[0].owner += item.unstated[0];
    if (kind === "repeated_early") item.events[4].tool.head.push(item.probes[0].score.accept[0]);
    if (kind === "repeated_middle") item.events[5].tool.tail.push(item.probes[1].score.accept[0]);
    if (kind === "repeated_head") item.events[4].tool.head.push(item.probes[2].score.accept[0]);
    if (kind === "repeated_same_result") item.events[5].tool.tail.push(item.probes[2].score.accept[0]);
    if (kind === "missing_decoy") item.events[6].owner = "Fixture no obsolete value.";
    if (kind === "middle_placement") { const tool = item.events[4].tool; tool.head = tool.middle; tool.middle = []; }
    expect(() => generateHoldoutTrace(family, item, 123)).toThrowError(new RegExp(`^${code}(?::|$)`, "u"));
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
  it("covers original dev-suite values and rendered title/owner, never JSON keys", async () => {
    const sources = await overlapSources(), original = sources.find(s => s.name.startsWith("scripts/fixtures/continuity/"));
    expect(original).toBeTruthy();
    const planted = original.values.find(value => wordRuns(value, 7, false).length > 0);
    const matcher = overlapMatcher(sources, emptyAllowlist); matcher.add(planted, "fixture original phrase");
    expect(matcher.result().overlaps.some(hit => hit.sources.includes(original.name))).toBe(true);
    const control = overlapMatcher([{ name: "fixture.json", text: '{"alpha beta gamma":"different fixture value"}', values: ["different fixture value"] }], emptyAllowlist);
    control.add("alpha beta gamma", "fixture key"); expect(control.result().pass).toBe(true);
    const rendered = traceNarratives({ title: "alpha beta gamma", owner: { displayName: "delta epsilon zeta" }, turns: [], probes: [] });
    const names = overlapMatcher([{ name: "fixture", text: '\"alpha beta gamma\"; \"delta epsilon zeta\";' }], emptyAllowlist);
    rendered.forEach((value, i) => names.add(value, `fixture:${i}`));
    expect(names.result().overlaps.map(hit => hit.phrase)).toEqual(["alpha beta gamma", "delta epsilon zeta"]);
  });
  it("honours narrowly justified frozen exceptions and excludes keys/tool names", () => {
    const allow = { schema: emptyAllowlist.schema, entries: [{ mode: "content3", phrase: "alpha beta gamma", justification: "Fixture-only generic-language exception justification." }] };
    const matcher = overlapMatcher([{ name: "fixture", text: '"alpha of beta gamma"; "mail_search";' }], allow);
    matcher.add("mail_search", "fixture tool"); matcher.add("independent unique placeholder", "fixture clean");
    expect(matcher.result().overlaps).toEqual([]);
    matcher.add("alpha beta gamma", "fixture allowed"); expect(matcher.result().pass).toBe(true);
    expect(matcher.result().overlaps[0].allowed).toBe(true);
    expect(() => validateAllowlist({ ...allow, entries: [{ ...allow.entries[0], justification: "short" }] })).toThrowError(new Error("invalid_allowlist_entry"));
  });
});

it("rejects group totals that differ from registered design E", () => {
  const spec = fixtureSpec(); spec.families[0].count--;
  expect(() => validateHoldoutSpec(spec)).toThrowError(new Error("invalid_family_mixture"));
});

it.each(Array.from({ length: 32 }, (_, i) => i).filter(i => ![9, 10].includes(i)))("rejects authored C0 code %i with case and pattern field", code => {
  const spec = fixtureSpec(), item = spec.families[0].cases[0];
  item.probes[4].score.forbidden[0] = String.fromCharCode(code) + "Synthetic";
  expect(() => validateHoldoutSpec(spec)).toThrowError(new Error(`invalid_authored_control:case="${item.id}":field="spec.families[0].cases[0].probes[4].score.forbidden[0]"`));
});
it("rejects a JSON backspace pattern through the schema-only CLI, but permits escaped regex boundaries/newlines/tabs", async () => {
  const dir = await scratch(), spec = fixtureSpec(), item = spec.families[0].cases[0];
  item.probes[4].score.forbidden[0] = "\u0008Synthetic\u0008";
  await writeSpec(dir, spec);
  const cli = spawnSync(process.execPath, [resolve(CHECKOUT, "scripts/holdout-validate.mjs"), "--spec-dir", dir, "--schema-only"], { encoding: "utf8", timeout: 10000 });
  expect(cli.status).toBe(1); expect(cli.stderr).toContain("invalid_authored_control");
  expect(cli.stderr).toContain(item.id); expect(cli.stderr).toContain("probes[4].score.forbidden[0]");
  item.probes[4].score.forbidden[0] = "\\bSynthetic\\b";
  item.title += "\n\tSynthetic";
  expect(validateHoldoutSpec(spec)).toBe(true);
  expect(new RegExp(item.probes[4].score.forbidden[0]).test("Synthetic")).toBe(true);
  spec.families[0].templates.toolBody[0] += "\u0008";
  expect(() => validateHoldoutSpec(spec)).toThrow("spec.families[0].templates.toolBody[0]");
});

it("freezes external canonical bytes and detects artifact, manifest, allowlist and tooling mutation", async () => {
  // Smallest valid explicitly bound synthetic design; full E inventory/selection
  // and 512-conversation registration are tested separately, never mocked here.
  const statisticalSpec = { ...STATISTICAL_SPEC, design: { ...STATISTICAL_SPEC.design,
    families: 2, conversationsPerFamily: 2, conversationsPerCorpus: 2, shards: 2, perCorpusPerShard: 1 } };
  const dir = await scratch(), specDir = join(dir, "spec"), spec = fixtureSpec(statisticalSpec);
  for (const family of spec.families) for (const item of family.cases) Object.assign(item, { turnCount: 80, toolCount: 64, sessions: 7 });
  // Large obvious synthetic units keep byte pressure and fresh seeded draws,
  // but avoid excessive tiny substitutions and long-word n-gram allocation.
  for (const family of spec.families) family.templates.toolBody = Array.from({ length: 8 }, (_, i) => `Synthetic filler ${i} ${"0123456789".repeat(409)}`);
  await writeSpec(specDir, spec);
  const repo = join(dir, "tooling"), { freezeHoldout, verifyHoldout } = await toolingRepository(repo);
  const loaded = await loadHoldoutSpec(specDir, statisticalSpec);
  let report = await checkHoldoutOverlap(loaded, seeds, emptyAllowlist, statisticalSpec);
  // Any shared generic fixture language is an explicit test-only exception, never a real allowlist.
  const allowlist = { schema: emptyAllowlist.schema, entries: report.overlaps.map(({ mode, phrase }) => ({ mode, phrase, justification: "Synthetic fixture generic-language exception for this unit test only." })) };
  if (report.overlaps.length) report = await checkHoldoutOverlap(loaded, seeds, allowlist, statisticalSpec);
  expect(report.pass).toBe(true);
  const inputs = join(dir, "inputs"); await mkdir(inputs);
  const paths = { seedsPath: join(inputs, "seeds.json"), overlapPath: join(inputs, "overlap.json"), rubricPath: join(inputs, "rubric"), protocolPath: join(inputs, "protocol"), allowlistPath: join(inputs, "allowlist.json") };
  for (const [path, data] of [[paths.seedsPath, jsonBytes(seeds)], [paths.overlapPath, jsonBytes(report)], [paths.rubricPath, "Fixture rubric"], [paths.protocolPath, "Fixture protocol"], [paths.allowlistPath, jsonBytes(allowlist)]]) await writeFile(path, data);
  await mkdir(join(dir, "outputs"));
  const outputDir = join(dir, "outputs/frozen");
  await writeFile(join(repo, "untracked"), "Fixture dirt");
  await expect(freezeHoldout({ specDir, outputDir, statisticalSpec, ...paths })).rejects.toThrowError(new Error("dirty_tooling_tree"));
  await rm(join(repo, "untracked"));
  const boundSource = join(repo, "scripts/lib/continuity-runner.mjs"), cleanBytes = await readFile(boundSource);
  await writeFile(boundSource, Buffer.concat([cleanBytes, Buffer.from("\n// Fixture dirty tracked file.\n")]));
  await expect(freezeHoldout({ specDir, outputDir, statisticalSpec, ...paths })).rejects.toThrowError(new Error("dirty_tooling_tree"));
  await writeFile(boundSource, cleanBytes);
  const frozen = await freezeHoldout({ specDir, outputDir, statisticalSpec, ...paths });
  const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
  expect(manifest.runtime.node).toBe(process.version);
  expect(manifest.runtime.lockfileSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(manifest.runtime.typescript).toMatch(/^\d+\.\d+\.\d+/u);
  for (const name of ["dataset", "score", "runner", "arms", "probe-child", "tools"]) expect(manifest.files[`tooling/scripts/lib/continuity-${name}.mjs`]).toBeTruthy();
  // Registration/loader integration uses this real frozen synthetic corpus and clean fixture Git tree.
  const registrationModule = await import(/* @vite-ignore */ pathToFileURL(join(repo, "scripts/lib/continuity-holdout-registration.mjs")).href);
  const datasetModule = await import(/* @vite-ignore */ pathToFileURL(join(repo, "scripts/lib/continuity-dataset.mjs")).href);
  const specPath = join(inputs, "statistics.json");
  await writeFile(specPath, jsonBytes(statisticalSpec));
  const profile = { reader: "fixture:reader", extractionModel: "fixture:extractor", alternate: "fixture:alternate", judge: null };
  const revision = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
  const registered = await registrationModule.registerFrozenHoldout({ manifestPath: join(outputDir, "manifest.json"), manifestSha256: frozen.manifestSha256,
    statisticalSpecPath: specPath, seed: 1234, models: registrationModule.holdoutModels(profile), codeRevision: revision });
  const cliRegistrationDir = join(dir, "outputs/registration-cli");
  const registrationCli = spawnSync(process.execPath, [await realpath(join(repo, "scripts/continuity-holdout-register.mjs")),
    "--corpus-manifest", join(outputDir, "manifest.json"), "--manifest-sha256", frozen.manifestSha256,
    "--statistical-spec", specPath, "--seed", "1234", "--reader", profile.reader,
    "--extractor", profile.extractionModel, "--alternate", profile.alternate, "--output", cliRegistrationDir], { encoding: "utf8", timeout: 10000 });
  expect(registrationCli.status, registrationCli.stderr).toBe(0);
  expect(JSON.parse(registrationCli.stdout).shards).toBe(2);
  expect(JSON.parse(await readFile(join(cliRegistrationDir, "registration.json"), "utf8")).shards).toHaveLength(2);
  const registrationPath = join(inputs, "registration.json"), registrationBytes = jsonBytes(registered);
  await writeFile(registrationPath, registrationBytes);
  const { sha256: fixtureSha256 } = await import(/* @vite-ignore */ pathToFileURL(join(repo, "scripts/lib/continuity-holdout-files.mjs")).href);
  const options = { suite: "holdout", manifestPath: join(outputDir, "manifest.json"), manifestSha256: frozen.manifestSha256,
    registrationPath, registrationSha256: fixtureSha256(registrationBytes), statisticalSpecPath: specPath, shard: 1, profile, codeRevision: revision,
    repeats: 2, arms: ["native", "cold-rebuild", "continuity-pack-cold", "continuity-ledger-cold"], probeLimit: null };
  const loadedShard = await datasetModule.loadTraces(options);
  expect(loadedShard.traces).toHaveLength(2);
  expect(loadedShard.traces.filter(t => t.corpus === "holdout-hard")).toHaveLength(1);
  expect(loadedShard.holdout.conversations).toHaveLength(4);
  expect(loadedShard.traces.filter(t => t.corpus === "holdout-hard-distractors")).toHaveLength(1);
  await expect(datasetModule.loadTraces({ ...options, shard: 3 })).rejects.toThrow("invalid_shard");
  const shardPlan = datasetModule.makePlan({ ...loadedShard, suite: "holdout", profile, repeats: 2, codeRevision: revision });
  expect(shardPlan.workload.probeTurns).toBe(2 * 4 * 2 * 15);
  const cli = await import(/* @vite-ignore */ pathToFileURL(join(repo, "scripts/continuity-benchmark.mjs")).href);
  const cliArgs = ["--suite", "holdout", "--corpus-manifest", options.manifestPath, "--manifest-sha256", options.manifestSha256,
    "--registration", registrationPath, "--registration-sha256", options.registrationSha256, "--statistical-spec", specPath, "--shard", "1",
    "--reader", profile.reader, "--extraction-model", profile.extractionModel, "--alternate", profile.alternate, "--no-judge"];
  let dispatches = 0, dry;
  const blocked = { env: {}, stdout: text => { dry = JSON.parse(text); }, modulesLoader: () => { dispatches++; throw new Error("fixture_dispatch_forbidden"); } };
  expect(await cli.main([...cliArgs, "--dry-run"], blocked)).toBe(0);
  expect(dry.workload.probeTurns).toBe(240); expect(dry.holdout.shard).toBe(1);
  await expect(cli.main([...cliArgs, "--real", "--confirm-plan", "wrong"], blocked)).rejects.toThrow("real_mode_requires_confirmed_plan");
  await expect(cli.main([...cliArgs, "--real", "--confirm-plan", dry.confirmation], blocked)).rejects.toThrow("holdout_measurement_requires_real_models");
  expect(dispatches).toBe(0);
  const aggregateOutput = join(dir, "outputs/aggregate");
  expect(await cli.main([...cliArgs, "--aggregate-only", "--output", aggregateOutput], blocked)).toBe(1);
  const aggregateResult = JSON.parse(await readFile(join(aggregateOutput, "results.json"), "utf8"));
  expect(aggregateResult.summary.holdout.plannedAnswersPerArm).toBe(120);
  expect(aggregateResult.summary.holdout.decision.status).toBe("inconclusive");
  expect(aggregateResult.summary.holdout.decision.reasons).toEqual(["not_a_measurement"]);
  expect(await readFile(join(aggregateOutput, "summary.md"), "utf8")).toContain("Decision: **inconclusive**");
  expect(dispatches).toBe(0);

  await expect(datasetModule.loadTraces({ ...options, registrationSha256: "a".repeat(64) })).rejects.toThrow("registration_hash_mismatch");
  await expect(datasetModule.loadTraces({ ...options, profile: { ...profile, extractionModel: "fixture:changed" } })).rejects.toThrow("registration_binding_mismatch");
  await expect(datasetModule.loadTraces({ ...options, repeats: 1 })).rejects.toThrow("invalid_registered_workload");
  const originalSpec = await readFile(specPath); await writeFile(specPath, Buffer.concat([originalSpec, Buffer.from(" ")]));
  await expect(datasetModule.loadTraces(options)).rejects.toThrow("registration_binding_mismatch");
  await writeFile(specPath, originalSpec);
  expect(frozen.conversations).toBe(4);
  expect((await verifyHoldout(outputDir, frozen.manifestSha256)).pass).toBe(true);
  let mutation = 0;
  const copyFrozen = async () => { const target = join(dir, `outputs/mutation-${mutation++}`); await cp(outputDir, target, { recursive: true, mode: constants.COPYFILE_FICLONE }); return target; };
  for (const name of ["spec.json", "seeds.json", "selection.json", "allowlist.json", "overlap.json", "rubric", "protocol", "tooling/scripts/lib/continuity-holdout-generator.mjs",
    `conversations/${(await readdir(join(outputDir, "conversations")))[0]}`, `answers/${(await readdir(join(outputDir, "answers")))[0]}`, "manifest.json", "manifest.sha256"]) {
    const copy = await copyFrozen(), path = join(copy, name); await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]));
    const code = name.startsWith("manifest.") ? "manifest_hash_mismatch" : `frozen_file_mutated:${name}`;
    await expect(verifyHoldout(copy, frozen.manifestSha256)).rejects.toThrowError(new Error(code));
  }
  const extraCopy = await copyFrozen();
  await writeFile(join(extraCopy, "unexpected"), "Fixture extra"); await expect(verifyHoldout(extraCopy, frozen.manifestSha256)).rejects.toThrow("unexpected_frozen_file");
  await writeFile(join(repo, "untracked"), "Fixture dirt");
  await expect(verifyHoldout(outputDir, frozen.manifestSha256)).rejects.toThrowError(new Error("dirty_tooling_tree"));
  await rm(join(repo, "untracked"));
  await writeFile(join(repo, "unrelated.txt"), "Fixture unrelated change"); fixtureCommit(repo);
  expect((await verifyHoldout(outputDir, frozen.manifestSha256)).pass).toBe(true);
  const bound = join(repo, "scripts/lib/continuity-runner.mjs"), originalBound = await readFile(bound);
  await writeFile(bound, Buffer.concat([originalBound, Buffer.from("\n// Fixture mutation.\n")])); fixtureCommit(repo);
  await expect(verifyHoldout(outputDir, frozen.manifestSha256)).rejects.toThrowError(new Error("current_tooling_mutated"));
  await writeFile(bound, originalBound); fixtureCommit(repo);
  expect((await verifyHoldout(outputDir, frozen.manifestSha256)).pass).toBe(true);
  await writeFile(paths.overlapPath, jsonBytes({ ...report, pass: false }));
  await expect(freezeHoldout({ specDir, outputDir: join(dir, "outputs/stale"), statisticalSpec, ...paths })).rejects.toThrow("overlap_report_not_passing_or_stale");
  await expect(externalDirectory(resolve(CHECKOUT, ".worklab-tmp/forbidden-output"), true)).rejects.toThrow("path_must_be_outside_checkout");
  await symlink(CHECKOUT, join(dir, "checkout-link"));
  await expect(externalDirectory(join(dir, "checkout-link", "new-output"), true)).rejects.toThrow("path_must_be_outside_checkout");
}, 180000);
