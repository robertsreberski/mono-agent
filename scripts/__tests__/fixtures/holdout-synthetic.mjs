import { STATISTICAL_SPEC } from "../../lib/continuity-holdout-statistics.mjs";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { checkHoldoutOverlap } from "../../lib/continuity-holdout-overlap.mjs";
import { benchmarkFiles, jsonBytes, sha256, CHECKOUT } from "../../lib/continuity-holdout-files.mjs";

// Tiny, unmistakably synthetic templates expanded mechanically ONLY to exercise
// minimum schema counts. These are not narrative content or a holdout seed pool.
function fixtureCase(n) {
  const id = `fixture-case-${n}`, early = `FXEARLY-${n}-ABC`, middle = `FXMIDDLE-${n}-ABC`, head = `FXHEAD-${n}-ABC`, secret = `FXSECRET-${n}-ABC`, decoy = `FXDECOY-${n}-ABC`;
  const tool = (bytes, facts = [], mid = []) => ({ operation: "read", args: {}, bytes, head: facts, middle: mid, tail: [] });
  const event = (at, extra = {}) => ({ at, owner: `Fixture source ${n} at ${at}.`, assistant: "Fixture acknowledgement.", ...extra });
  const probe = (category, score, i, evidence) => ({ category, score, question: `Fixture inquiry ${n} number ${i}?`, abstainOption: ![5, 15].includes(i), evidence });
  return { id, title: "Fixture title", owner: "{{person}}", bindings: {}, turnCount: 96, toolCount: 72, sessions: 8, midpoint: 47,
    events: [event(0), event(1, { tool: tool(8192, [early]), interruption: "Fixture interruption alpha." }),
      event(3, { tool: tool(8192, [secret]), interruption: "Fixture interruption beta." }),
      event(10, { owner: `Fixture previous VALUE-OLD-${n}; now VALUE-NEW-${n}.` }),
      event(20, { tool: tool(40960, [], [middle]) }), event(30, { tool: tool(24576, [head]) }),
      event(40, { owner: `Fixture obsolete ${decoy}.` }), event(55, { owner: `Fixture next ACTION-${n} by DEADLINE-${n}.` }), event(60)],
    features: { correction: [10], deliberation: [40], decision: [55], outstanding: [55], fulfilled: [60], distractor: [60] },
    unstated: ["Fixture absent alpha", "Fixture absent beta"],
    probes: [
      ...[early, middle, head].map((value, i) => ({ ...probe("tool_identifier", { kind: "identifier", accept: [value], ...(i === 2 ? { reject: [decoy] } : {}) }, i + 1, [[1], [20], [30]][i]), source: [1, 20, 30][i], placement: ["early", "middle", "head"][i] })),
      probe("active_constraint", { kind: "constraint_recall", requireAll: [["FixtureAllowed"]] }, 4, [0]),
      probe("active_constraint", { kind: "constraint_task", forbidden: ["FixtureForbidden"] }, 5, [0]),
      ...[6, 7].map(i => probe("superseded_current", { kind: "value", accept: [`VALUE-NEW-${n}`], superseded: [`VALUE-OLD-${n}`] }, i, [10])),
      ...[8, 9, 10, 11].map(i => probe(i < 10 ? "commitment_status" : "artifact_status", { kind: "choice", options: ["PENDING", "COMPLETE"], expected: "PENDING" }, i, [40])),
      probe("next_action", { kind: "next_action", proxyAll: [[`ACTION-${n}`], [`DEADLINE-${n}`]], rubric: `Fixture-only semantic key for case ${n}, action and deadline.` }, 12, [55]),
      probe("abstention", { kind: "abstain" }, 13, []), probe("abstention", { kind: "abstain" }, 14, []),
      probe("redaction", { kind: "redaction", secret }, 15, [3]),
    ] };
}
export function fixtureSpec(statisticalSpec = STATISTICAL_SPEC) {
  const d = statisticalSpec.design;
  return { schema: "fictional-conversations-v1", fictional: true,
    provenance: { authorId: "fixture-author", createdAt: "2040-01-01T00:00:00.000Z", independent: true, references: [], exposures: [],
      declaration: "Fixture declaration only: wholly fictional synthetic test content, not an evaluation corpus." },
    families: Array.from({ length: d.families }, (_, i) => ({ id: `fixture-family-${String(i).padStart(2, "0")}`, group: i < d.families / 2 ? "ordinary" : "distractor", count: d.conversationsPerFamily,
      entities: { person: "Fixture Person" }, vocabulary: { word: "Fixtureword" },
      templates: { owner: ["Fixture owner alpha.", "Fixture owner beta."], assistant: ["Fixture reply alpha.", "Fixture reply beta."], toolBody: Array.from({ length: 8 }, (_, k) => `Fixture filler unit ${String.fromCharCode(97 + k)}.`) },
      cases: Array.from({ length: d.conversationsPerFamily }, (_, j) => fixtureCase(i * d.conversationsPerFamily + j + 100)) })) };
}
export async function writeSpec(dir, spec) {
  await mkdir(dir, { recursive: true });
  const families = [];
  for (const f of spec.families) { const file = `${f.id}.json`; await writeFile(join(dir, file), jsonBytes(f)); families.push({ id: f.id, group: f.group, count: f.count, file }); }
  await writeFile(join(dir, "index.json"), jsonBytes({ ...spec, families }));
}

export function fixtureGit(repo, args) {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" });
}
export function fixtureCommit(repo) { fixtureGit(repo, ["add", "--", "."]); fixtureGit(repo, ["commit", "-qm", "Fixture checkpoint"]); }
export async function toolingRepository(directory, runtime = false) {
  await mkdir(directory);
  for (const name of [...benchmarkFiles(), "pnpm-lock.yaml", "scripts/lib/memory-e2e-build.mjs"]) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), await readFile(resolve(CHECKOUT, name)));
  }
  await writeFile(join(directory, ".gitignore"), "node_modules\npackages/*/dist\npackages/turn/node_modules\n");
  await symlink(resolve(CHECKOUT, "node_modules"), join(directory, "node_modules"));
  if (runtime) {
    for (const name of ["app", "config", "turn", "conversation"]) {
      await mkdir(join(directory, "packages", name), { recursive: true });
      await symlink(resolve(CHECKOUT, "packages", name, "dist"), join(directory, "packages", name, "dist"));
    }
    await symlink(resolve(CHECKOUT, "packages/turn/node_modules"), join(directory, "packages/turn/node_modules"));
  }
  fixtureGit(directory, ["init", "-q"]); fixtureCommit(directory);
  return import(/* @vite-ignore */ pathToFileURL(join(directory, "scripts/continuity-holdout-freeze.mjs")).href);
}


export async function syntheticContext(directory) {
  const repo = join(directory, "tooling"), inputs = join(directory, "inputs"); await mkdir(inputs);
  const freeze = await toolingRepository(repo, true);
  const load = name => import(/* @vite-ignore */ pathToFileURL(join(repo, "scripts/lib", `${name}.mjs`)).href);
  const workflow = await load("continuity-holdout-workflow"); const controller = await load("continuity-holdout-controller"); const proof = await load("continuity-holdout-proof");
  const stats = { ...STATISTICAL_SPEC, design: { ...STATISTICAL_SPEC.design, families: 2, conversationsPerFamily: 2, conversationsPerCorpus: 2, shards: 2, perCorpusPerShard: 1 } };
  const specDir = join(directory, "synthetic-spec"), spec = fixtureSpec(stats), seeds = { ordinary: 12345, distractor: 98765 };
  for (const family of spec.families) {
    family.templates.toolBody = Array.from({ length: 8 }, (_, i) => `Synthetic filler ${i} ${"0123456789".repeat(409)}`);
    for (const item of family.cases) Object.assign(item, { turnCount: 80, toolCount: 64, sessions: 7 });
  }
  await writeSpec(specDir, spec);
  const generator = await load("continuity-holdout-generator");
  const loaded = await generator.loadHoldoutSpec(specDir, stats), empty = { schema: "holdout-overlap-allowlist-v1", entries: [] };
  let overlap = await checkHoldoutOverlap(loaded, seeds, empty, stats);
  const allowlist = { ...empty, entries: overlap.overlaps.map(({ mode, phrase }) => ({ mode, phrase, justification: "Synthetic test-only generic-language exception." })) };
  if (overlap.overlaps.length) overlap = await checkHoldoutOverlap(loaded, seeds, allowlist, stats);
  const paths = {};
  for (const [key, value] of Object.entries({ seeds, overlap, rubric: "Synthetic rubric", protocol: "Synthetic protocol", allowlist })) {
    paths[`${key}Path`] = join(inputs, `${key}.json`); await writeFile(paths[`${key}Path`], jsonBytes(value));
  }
  await mkdir(join(directory, "outputs"));
  const outputDir = join(directory, "outputs/frozen");
  const frozen = await freeze.freezeHoldout({ specDir, outputDir, statisticalSpec: stats, ...paths });
  const registrationModule = await load("continuity-holdout-registration"), statisticalSpecPath = join(inputs, "statistics.json");
  await writeFile(statisticalSpecPath, jsonBytes(stats));
  const registration = await registrationModule.registerFrozenHoldout({ manifestPath: join(outputDir, "manifest.json"), manifestSha256: frozen.manifestSha256,
    statisticalSpecPath, seed: 1234, models: registrationModule.holdoutModels(), codeRevision: fixtureGit(repo, ["rev-parse", "HEAD"]).trim() });
  const registrationPath = join(inputs, "registration.json"); await writeFile(registrationPath, jsonBytes(registration));
  const piAuthPath = join(inputs, "empty-auth.json"); await writeFile(piAuthPath, "{}", { mode: 0o600 }); // NO credentials.
  const context = await workflow.loadContext({ manifestPath: join(outputDir, "manifest.json"), manifestSha256: frozen.manifestSha256,
    registrationPath, registrationSha256: sha256(jsonBytes(registration)), statisticalSpecPath, piAuthPath });
  return { repo, inputs, context, workflow, controller, proof };
}
