// Offline-only, separately registered lookup roles. Never a legacy ledger qualification.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, loadTraces, makePlan, DEFAULT_ALTERNATE } from "./continuity-dataset.mjs";
import { LOOKUP_MODE, LOOKUP_ROLE_PROTOCOL, LOOKUP_ROLES, LOOKUP_SOULS, LOOKUP_BUDGET, sha256 } from "./continuity-lookup.mjs";
import { summarizeLookup } from "./continuity-lookup-score.mjs";
import { BUILD_POLICY, prepareRealBuild, verifyRealBuild } from "./memory-e2e-build.mjs";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "");
export const REGISTRATION_SCHEMA = "continuity-lookup-registration-v1";
// Frozen guidance-only file list, not the squash merge's larger plumbing diff.
export const GUIDANCE_FILES = Object.freeze([
  "CHANGELOG.md", "docs/context/assembly.md", "docs/runtime/sessions-concurrency.md", "docs/tools/mcp.md",
  "packages/app/README.md", "packages/app/src/__tests__/conversation-history.test.ts", "packages/conversation/README.md",
  "packages/conversation/src/__tests__/__snapshots__/continuity-selection-contract.test.ts.snap",
  "packages/conversation/src/__tests__/continuity-pack-order.test.ts", "packages/conversation/src/__tests__/continuity-pack-requests.test.ts",
  "packages/conversation/src/__tests__/continuity-pack.test.ts", "packages/conversation/src/__tests__/continuity-selection-contract.test.ts",
  "packages/conversation/src/continuity/pack.ts", "packages/conversation/src/continuity/render-fit.ts",
]);
export const RUNTIME_GUIDANCE_FILES = Object.freeze(["packages/conversation/src/continuity/pack.ts", "packages/conversation/src/continuity/render-fit.ts"]);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const FULL_SHA = /^[a-f0-9]{40}$/u, HASH = /^[a-f0-9]{64}$/u;
export function requireLookup(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, value, flag) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, ...(flag ? { flag } : {}) });

/** Local bytes only. Also exposed by each compatible A1 entrypoint, before any runtime load. */
export async function lookupProtocol(root = ROOT) {
  const hashFiles = async files => digest(await Promise.all(files.map(async path => [path, sha256(await readFile(join(root, path)))])));
  return { version: LOOKUP_ROLE_PROTOCOL, probeMode: LOOKUP_MODE,
    budgetSha256: sha256(await readFile(join(root, "scripts/fixtures/continuity-lookup-budget-v1.json"))),
    lockfileSha256: sha256(await readFile(join(root, "pnpm-lock.yaml"))),
    entrypointSha256: await hashFiles(["scripts/continuity-benchmark.mjs", "scripts/lib/continuity-lookup-roles.mjs", "scripts/lib/continuity-dataset.mjs", "scripts/lib/continuity-generator.mjs"]),
    readerSha256: await hashFiles(["scripts/lib/continuity-lookup.mjs", "scripts/lib/continuity-runner.mjs", "scripts/lib/continuity-probe-child.mjs", "scripts/lib/continuity-arms.mjs", "scripts/lib/continuity-tools.mjs"]),
    scorerSha256: await hashFiles(["scripts/lib/continuity-score.mjs", "scripts/lib/continuity-lookup-score.mjs"]),
    souls: Object.fromEntries(await Promise.all(Object.entries(LOOKUP_SOULS).map(async ([id, binding]) => {
      const bytes = await readFile(join(root, "scripts/fixtures", binding.file));
      requireLookup(sha256(bytes) === binding.rawSha256, "lookup_soul_digest_mismatch");
      return [id, binding];
    }))) };
}

export async function lookupWorkload({ suites = ["original", "hard", "hard-distractors"], traceIds = null, repeats = 1, probeLimit = null,
  reader = DEFAULT_ALTERNATE, readerEffort = "low" } = {}) {
  requireLookup(Array.isArray(suites) && suites.length > 0 && new Set(suites).size === suites.length
    && suites.every(s => ["original", "hard", "hard-distractors"].includes(s)), "lookup_invalid_suites");
  requireLookup(traceIds === null || Array.isArray(traceIds) && traceIds.length > 0 && new Set(traceIds).size === traceIds.length, "lookup_invalid_trace_selection");
  requireLookup(["none", "minimal", "low", "medium", "high"].includes(readerEffort), "invalid_effort");
  const corpora = [], found = new Set();
  for (const suite of suites) {
    const loaded = await loadTraces({ suite });
    // Validate settings with the unchanged A1 planner, before constructing any registration.
    const plan = makePlan({ ...loaded, probeMode: LOOKUP_MODE, repeats, probeLimit,
      profile: readerProfile(reader, readerEffort) });
    const traces = plan.corpus.traces.filter(trace => traceIds === null || traceIds.includes(trace.id));
    requireLookup(traces.length > 0, "lookup_trace_scope_empty");
    traces.forEach(trace => found.add(trace.id));
    corpora.push({ suite, sha256: loaded.sha256, traces });
  }
  requireLookup(traceIds === null || traceIds.every(id => found.has(id)), "unknown_trace");
  return { corpora, repeats, probeLimit, reader: { model: reader, effort: readerEffort } };
}
function readerProfile(model, effort) {
  return { reader: model, readerEffort: effort, alternate: model === "openai-codex:gpt-6-luna" ? DEFAULT_ALTERNATE : "openai-codex:gpt-6-luna", judge: null };
}

/** Compare complete Git trees by path/mode/type/blob, including independent local repositories. */
export function guidanceDiff(r0, rpack) {
  const tree = path => new Map(execFileSync("git", ["-C", path, "ls-tree", "-rz", "--full-tree", "HEAD"], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }).split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t"); return [row.slice(tab + 1), row.slice(0, tab)];
  }));
  const a = tree(r0), b = tree(rpack);
  const files = [...new Set([...a.keys(), ...b.keys()])].filter(path => a.get(path) !== b.get(path)).sort();
  requireLookup(files.some(path => RUNTIME_GUIDANCE_FILES.includes(path)) && files.every(path => GUIDANCE_FILES.includes(path)), "lookup_rpack_diff_out_of_scope");
  const render = RUNTIME_GUIDANCE_FILES[1];
  const hasGuidance = (root, entries) => entries.has(render)
    && /^export\s+const\s+PACK_RETRIEVAL_GUIDANCE\s*=/mu.test(git(root, ["show", `HEAD:${render}`]));
  requireLookup(!hasGuidance(r0, a) && hasGuidance(rpack, b), "lookup_rpack_direction_invalid");
  return files;
}
async function checkout(path, revision) {
  requireLookup(isAbsolute(path ?? "") && FULL_SHA.test(revision ?? ""), "lookup_invalid_checkout_binding");
  const root = await realpath(path);
  requireLookup(await realpath(git(root, ["rev-parse", "--show-toplevel"])) === root, "lookup_checkout_not_root");
  const head = git(root, ["rev-parse", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]).length > 0;
  requireLookup(head === revision && !dirty, "lookup_checkout_revision_or_dirt_mismatch");
  const flags = git(root, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
  requireLookup(flags.every(row => !/^[a-zS]/u.test(row)), "lookup_checkout_index_flags_unsafe");
  return root;
}
function buildBinding(build, revision) {
  requireLookup(build?.policy === BUILD_POLICY && build.sourceHead === revision && HASH.test(build.outputSha256 ?? "")
    && build.node === process.version && same(build.command, ["pnpm", "--filter", "@mono-agent/app...", "run", "build"])
    && Array.isArray(build.packages) && build.packages.includes("packages/app") && new Set(build.packages).size === build.packages.length
    && build.packages.every(path => /^(packages|extras)\/[a-z0-9-]+$/u.test(path))
    && same(build.outputRoots, build.packages.map(path => `${path}/dist`)), "lookup_build_binding_mismatch");
}
function advertisedProtocol(root) {
  try {
    const result = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/continuity-benchmark.mjs"), "--lookup-protocol"],
      { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    requireLookup(result.version === LOOKUP_ROLE_PROTOCOL, "lookup_checkout_protocol_incompatible"); return result;
  } catch { requireLookup(false, "lookup_checkout_protocol_incompatible"); }
}
async function verifyBuild(root, build) {
  try { await checkout(root, build.sourceHead); await verifyRealBuild(root, build); }
  catch (error) { requireLookup(false, error.message === "build_output_changed" ? "lookup_build_output_changed" : "lookup_build_source_or_output_invalid"); }
}
async function compatibleProtocol(path, expected) {
  requireLookup(same(advertisedProtocol(path), expected), "lookup_checkout_protocol_incompatible");
  // Independently hash the supplied checkout too; do not trust a self-reported descriptor alone.
  try { requireLookup(same(await lookupProtocol(path), expected), "lookup_checkout_protocol_incompatible"); }
  catch { requireLookup(false, "lookup_checkout_protocol_incompatible"); }
}
export async function registerLookup({ checkouts, ...options }) {
  const protocol = await lookupProtocol(), workload = await lookupWorkload(options), codes = {};
  for (const id of ["R0", "Rpack"]) {
    const supplied = checkouts?.[id], path = await checkout(supplied?.path, supplied?.revision);
    await compatibleProtocol(path, protocol);
    codes[id] = { path, revision: supplied.revision };
  }
  const diffFiles = guidanceDiff(codes.R0.path, codes.Rpack.path);
  for (const code of Object.values(codes)) code.build = await prepareRealBuild(code.path, code.revision);
  // Recheck source and output hashes after BOTH builds; preparation may not change either checkout.
  for (const code of Object.values(codes)) await verifyBuild(code.path, code.build);
  const roles = LOOKUP_ROLES.map(def => ({ id: def.id, arm: def.arm, code: def.code, revision: codes[def.code].revision,
    buildHash: codes[def.code].build.outputSha256, soul: LOOKUP_SOULS[def.soul] }));
  return { schema: REGISTRATION_SCHEMA, purpose: "offline-mechanics-only-not-ledger-qualification", common: { protocol, ...workload }, codes, diffFiles, roles };
}
export async function validateRegistration(registration) {
  const r = registration;
  requireLookup(r?.schema === REGISTRATION_SCHEMA, "incompatible_lookup_registration");
  requireLookup(same(r.common?.protocol, await lookupProtocol()), "lookup_registration_protocol_mismatch");
  const expected = await lookupWorkload({ suites: r.common.corpora?.map(c => c.suite), traceIds: [...new Set(r.common.corpora?.flatMap(c => c.traces.map(t => t.id)))],
    repeats: r.common.repeats, probeLimit: r.common.probeLimit, reader: r.common.reader?.model, readerEffort: r.common.reader?.effort });
  requireLookup(same(r.common, { protocol: r.common.protocol, ...expected }), "lookup_registration_workload_mismatch");
  requireLookup(r.codes && same(Object.keys(r.codes).sort(), ["R0", "Rpack"]) && r.diffFiles?.some(file => RUNTIME_GUIDANCE_FILES.includes(file))
    && r.diffFiles.every(file => GUIDANCE_FILES.includes(file)) && new Set(r.diffFiles).size === r.diffFiles.length, "lookup_rpack_diff_out_of_scope");
  for (const code of Object.values(r.codes)) {
    requireLookup(isAbsolute(code.path ?? "") && FULL_SHA.test(code.revision ?? ""), "lookup_invalid_checkout_binding");
    buildBinding(code.build, code.revision);
  }
  requireLookup(same(r.roles, LOOKUP_ROLES.map(def => ({ id: def.id, arm: def.arm, code: def.code, revision: r.codes[def.code].revision,
    buildHash: r.codes[def.code].build.outputSha256, soul: LOOKUP_SOULS[def.soul] }))), "lookup_role_binding_mismatch");
  return r;
}
export async function readRegistration(path, hash) {
  requireLookup(HASH.test(hash ?? ""), "lookup_registration_hash_required");
  const bytes = await readFile(path);
  requireLookup(sha256(bytes) === hash, "lookup_registration_hash_mismatch");
  return validateRegistration(JSON.parse(bytes));
}
export function roleBinding(registration, role, corpus) {
  return { protocol: LOOKUP_ROLE_PROTOCOL, ...role, registrationSha256: digest(registration), commonSha256: digest(registration.common),
    scope: { suite: corpus.suite, traces: corpus.traces.map(trace => trace.id) } };
}
export async function rolePlan(common, binding) {
  const loaded = await loadTraces({ suite: binding.scope.suite });
  return makePlan({ ...loaded, codeRevision: binding.revision, probeMode: LOOKUP_MODE, lookupRole: binding, arms: [binding.arm],
    repeats: common.repeats, probeLimit: common.probeLimit, profile: readerProfile(common.reader.model, common.reader.effort) });
}
/** Called by the A1 entrypoint BEFORE runtime dispatch and again before issuing a receipt. */
export async function verifyRoleRequest(root, request, plan) {
  requireLookup(request?.schema === "lookup-role-request-v1" && same(plan.lookup?.role, request.binding), "lookup_role_request_mismatch");
  const role = request.binding;
  requireLookup(same(request.common?.protocol, await lookupProtocol(root)) && digest(request.common) === role.commonSha256, "lookup_role_common_mismatch");
  requireLookup(same(plan, await rolePlan(request.common, role)), "lookup_role_plan_mismatch");
  const corpus = request.common.corpora.find(row => row.suite === plan.suite);
  requireLookup(corpus?.sha256 === plan.corpus.sha256 && same(corpus.traces, plan.corpus.traces), "lookup_role_scope_mismatch");
  buildBinding(request.build, role.revision);
  requireLookup(role.buildHash === request.build.outputSha256, "lookup_build_binding_mismatch");
  await checkout(root, role.revision);
  await verifyBuild(root, request.build);
}
async function jsonFiles(dir) {
  try { return (await readdir(dir)).filter(name => name.endsWith(".json")).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
export async function roleUnitHashes(output) {
  return [...new Set(await Promise.all((await jsonFiles(join(output, "units"))).map(async name => sha256(await readFile(join(output, "units", name))))))].sort();
}
export function roleReceipt(request, plan, unitHashes = []) {
  return { schema: "lookup-role-receipt-v1", binding: request.binding, planConfirmation: plan.confirmation, build: request.build, unitHashes };
}
export function assertRoleReceipt(results, request, plan) {
  const hashes = results?.lookupReceipt?.unitHashes;
  requireLookup(Array.isArray(hashes) && hashes.every(hash => typeof hash === "string" && HASH.test(hash)) && new Set(hashes).size === hashes.length
    && results?.executionKind === "offline" && results.qualityMeasured === false && same(results.plan, plan)
    && same(results.lookupReceipt, roleReceipt(request, plan, hashes)), "lookup_role_receipt_mismatch");
}
export async function verifyRegisteredCheckouts(registration) {
  await validateRegistration(registration);
  for (const code of Object.values(registration.codes)) {
    await checkout(code.path, code.revision);
    await compatibleProtocol(code.path, registration.common.protocol);
    await verifyBuild(code.path, code.build);
  }
  requireLookup(same(guidanceDiff(registration.codes.R0.path, registration.codes.Rpack.path), registration.diffFiles), "lookup_rpack_diff_out_of_scope");
}

export function runLookupRoleChild(root, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts/continuity-benchmark.mjs"), ...args], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    // Do not retain runtime stderr (may contain tool content). Only a stable exit code crosses this seam.
    child.stderr.resume();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(Object.assign(new Error("lookup_role_spawn_failed"), { code: "lookup_role_spawn_failed" })); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}
export async function runLookupRoles(registration, output, { onProgress = () => {}, dispatch = runLookupRoleChild } = {}) {
  await verifyRegisteredCheckouts(registration);
  requireLookup(isAbsolute(output), "lookup_output_must_be_absolute");
  // Never reuse another run's state or silently resume/rebind outputs.
  await mkdir(output, { mode: 0o700 });
  await save(join(output, "registration.json"), registration);
  const launches = [];
  for (const role of registration.roles) for (const corpus of registration.common.corpora) {
    const code = registration.codes[role.code], binding = roleBinding(registration, role, corpus);
    const request = { schema: "lookup-role-request-v1", binding, build: code.build, common: registration.common };
    const parent = join(output, role.id); await mkdir(parent, { recursive: true, mode: 0o700 });
    const requestPath = join(parent, `${corpus.suite}-request.json`), dir = join(parent, corpus.suite);
    await save(requestPath, request);
    onProgress(`${role.id}/${corpus.suite}`);
    const args = ["--probe-mode", LOOKUP_MODE, "--lookup-role", requestPath, "--suite", corpus.suite, "--arms", role.arm,
      "--reader", registration.common.reader.model, "--alternate", readerProfile(registration.common.reader.model).alternate,
      "--reader-effort", registration.common.reader.effort, "--no-judge", "--repeats", String(registration.common.repeats), "--concurrency", "1", "--output", dir,
      ...(registration.common.probeLimit === null ? [] : ["--probe-limit", String(registration.common.probeLimit)])];
    const plan = await rolePlan(registration.common, binding);
    const outcome = await dispatch(code.path, args, plan.limits.maxLiveTurns * plan.lookup.childWatchdogMs + 300000);
    const received = await readRoleResult(dir, request, plan);
    let reason = received.reason;
    if (received.results) {
      try { await verifyBuild(code.path, code.build); }
      catch (error) { if (!error.code?.startsWith("lookup_build_")) throw error; reason = error.code; }
    }
    launches.push({ role: role.id, suite: corpus.suite, exitCode: outcome.code, timedOut: outcome.timedOut,
      receiptVerified: received.results !== null, reason,
      resultsSha256: received.results ? sha256(received.bytes) : null });
    await save(join(output, "launches.json"), { schema: "lookup-role-launches-v1", registrationSha256: digest(registration), launches });
  }
  // Partial runs preserve already verified snapshots. Every usable role was independently
  // checked above; a later missing receipt must not discard earlier roles or suppress later ones.
  if (launches.every(row => row.reason === null)) await verifyRegisteredCheckouts(registration);
  return aggregateRoleFiles(registration, output);
}

async function readRoleResult(dir, request, plan) {
  let bytes;
  try { bytes = await readFile(join(dir, "results.json")); }
  catch (error) { if (error.code === "ENOENT") return { results: null, reason: "lookup_role_results_missing" }; throw error; }
  const results = JSON.parse(bytes);
  if (results?.lookupReceipt == null) return { results: null, reason: "lookup_role_receipt_missing" };
  // A present but invalid receipt is never downgraded into an ordinary missing role.
  assertRoleReceipt(results, request, plan);
  return { results, bytes, reason: null };
}
/** Receipts, not filenames or latest checkouts, determine which observations may be joined. */
export async function aggregateRoleFiles(registration, output) {
  await validateRegistration(registration);
  const observations = [], availability = [];
  let launches = [];
  try {
    const journal = await json(join(output, "launches.json"));
    requireLookup(journal.schema === "lookup-role-launches-v1" && journal.registrationSha256 === digest(registration) && Array.isArray(journal.launches), "lookup_role_launch_binding_mismatch");
    launches = journal.launches;
    requireLookup(new Set(launches.map(row => `${row.role}/${row.suite}`)).size === launches.length
      && launches.every(row => registration.roles.some(role => role.id === row.role) && registration.common.corpora.some(c => c.suite === row.suite)
        && (row.exitCode === null || Number.isSafeInteger(row.exitCode)) && typeof row.timedOut === "boolean" && typeof row.receiptVerified === "boolean"
        && (row.reason === null || typeof row.reason === "string" && /^lookup_[a-z_]+$/u.test(row.reason))
        && (row.resultsSha256 === null || typeof row.resultsSha256 === "string" && HASH.test(row.resultsSha256))), "lookup_role_launch_binding_mismatch");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const role of registration.roles) for (const corpus of registration.common.corpora) {
    const dir = join(output, role.id, corpus.suite);
    const binding = roleBinding(registration, role, corpus), plan = await rolePlan(registration.common, binding);
    const request = { binding, build: registration.codes[role.code].build };
    const received = await readRoleResult(dir, request, plan);
    const launch = launches.find(row => row.role === role.id && row.suite === corpus.suite);
    const reason = received.reason ?? launch?.reason ?? null;
    availability.push({ role: role.id, suite: corpus.suite, reason });
    if (!received.results) continue;
    if (launch?.receiptVerified) requireLookup(launch.resultsSha256 === sha256(received.bytes), "lookup_role_launch_receipt_mismatch");
    if (reason) continue;
    const results = received.results;
    for (const name of await jsonFiles(join(dir, "units"))) {
      const bytes = await readFile(join(dir, "units", name)), unit = JSON.parse(bytes);
      requireLookup(unit.confirmation === plan.confirmation && unit.executionKind === "offline" && unit.arm === role.arm
        && unit.manifest?.codeRevision === role.revision && unit.manifest.dirty === false && unit.manifest.buildPolicy === BUILD_POLICY
        && same(unit.manifest.lookupRole, binding) && Array.isArray(unit.trials), "lookup_role_unit_receipt_mismatch");
      requireLookup(results.lookupReceipt.unitHashes.includes(sha256(bytes)), "lookup_role_unit_digest_mismatch");
      for (const trial of unit.trials) {
        requireLookup(trial.arm === unit.arm && trial.traceId === unit.traceId && trial.repeat === unit.repeat, "lookup_role_unit_identity_mismatch");
        observations.push({ ...trial, role: role.id, suite: corpus.suite });
      }
    }
  }
  const result = await aggregateLookupRoles(registration, observations, { availability, launches });
  await save(join(output, "results.json"), result);
  await writeFile(join(output, "summary.md"), renderRoleMarkdown(result), { mode: 0o600 });
  return result;
}

export async function aggregateLookupRoles(registration, observations, { availability = [], launches = [] } = {}) {
  await validateRegistration(registration);
  const slots = [], roles = {};
  for (const role of registration.roles) {
    const all = [];
    for (const corpus of registration.common.corpora) {
      const binding = roleBinding(registration, role, corpus), plan = await rolePlan(registration.common, binding);
      const trials = observations.filter(row => row.role === role.id && row.suite === corpus.suite);
      const summary = summarizeLookup(trials, plan);
      slots.push(...summary.slots.map(slot => ({ ...slot, role: role.id, suite: corpus.suite,
        ...(slot.status === "missing" ? { missingReason: availability.find(row => row.role === role.id && row.suite === corpus.suite)?.reason ?? "lookup_role_observation_missing" } : {}), occurrences: trials.filter(row => row.traceId === slot.traceId && row.probeId === slot.probeId && row.repeat === slot.repeat).length })));
      // Prefix trace identity so equal IDs in different suites cannot collide.
      all.push(...trials.map(trial => ({ ...trial, traceId: `${corpus.suite}/${trial.traceId}` })));
    }
    const plan = { arms: [{ id: role.arm }], repeats: registration.common.repeats,
      corpus: { traces: registration.common.corpora.flatMap(c => c.traces.map(t => ({ ...t, id: `${c.suite}/${t.id}` }))) },
      lookup: { budget: { paths: LOOKUP_BUDGET.paths.flatMap(path => registration.common.corpora.map(c => ({ ...path, traceId: `${c.suite}/${path.traceId}` }))) } } };
    roles[role.id] = summarizeLookup(all, plan).arms[role.arm];
  }
  requireLookup(observations.every(row => slots.some(slot => slot.role === row.role && slot.suite === row.suite && slot.arm === row.arm
    && slot.traceId === row.traceId && slot.probeId === row.probeId && slot.repeat === row.repeat)), "lookup_unplanned_observation");
  return { schema: "continuity-lookup-comparison-v1", registrationSha256: digest(registration), executionKind: "offline", qualityMeasured: false,
    purpose: "Descriptive mechanics only; not significance, power, qualification or treatment benefit", roles, slots, availability, launches,
    coverage: { planned: slots.length, completed: slots.filter(s => s.status === "completed").length, missing: slots.filter(s => s.status === "missing").length,
      duplicate: slots.filter(s => s.status === "duplicate").length, observations: observations.length }, contrasts: contrasts(slots) };
}
function contrasts(slots) {
  const key = s => JSON.stringify([s.suite, s.traceId, s.probeId, s.repeat]);
  return [["pack-only", "pack"], ["soul-only", "pack"], ["shipping", "pack"], ["native-soul", "native"], ["native", "pack"]].map(([target, baseline]) => {
    const base = new Map(slots.filter(s => s.role === baseline).map(s => [key(s), s]));
    const pairs = slots.filter(s => s.role === target).map(a => [a, base.get(key(a))]);
    const completed = s => s?.status === "completed" && s.exactAccuracy !== null && s.budgetFeasibility !== "budget-infeasible";
    const failed = s => s?.status === "failed" && s.budgetFeasibility === "feasible";
    const counts = predicate => {
      const comparable = pairs.filter(([a, b]) => predicate(a) && predicate(b));
      const correct = s => completed(s) && s.exactAccuracy === true;
      const targetOnly = comparable.filter(([a, b]) => correct(a) && !correct(b)).length;
      const baselineOnly = comparable.filter(([a, b]) => !correct(a) && correct(b)).length;
      return { n: comparable.length, bothCorrect: comparable.filter(([a, b]) => correct(a) && correct(b)).length, targetOnly, baselineOnly,
        bothIncorrect: comparable.filter(([a, b]) => !correct(a) && !correct(b)).length,
        delta: comparable.length ? (targetOnly - baselineOnly) / comparable.length : null };
    };
    return { target, baseline, planned: pairs.length, completedExact: counts(completed), exactWithFailures: counts(s => completed(s) || failed(s)),
      targetFailedFeasible: pairs.filter(([a]) => failed(a)).length, baselineFailedFeasible: pairs.filter(([, b]) => failed(b)).length };
  });
}
export function renderRoleMarkdown(result) {
  return `# Offline lookup roles\n\n${result.purpose}. No provider calls or spending authorization.\n\nCoverage: ${result.coverage.completed}/${result.coverage.planned}; missing ${result.coverage.missing}; duplicate ${result.coverage.duplicate}.\n\n${result.availability.filter(row => row.reason).map(row => `- ${row.role}/${row.suite}: ${row.reason}`).join("\n")}\n${result.launches.filter(row => row.exitCode !== 0 || row.timedOut).map(row => `- Child ${row.role}/${row.suite}: exit ${row.exitCode}, timed out ${row.timedOut}, receipt verified ${row.receiptVerified}.`).join("\n")}\n\n| Role | Completed exact correct/n | Exact with failures correct/n | Failed feasible |\n|---|---:|---:|---:|\n${Object.entries(result.roles).map(([id, row]) => `| ${id} | ${row.exact.correct}/${row.exact.n} | ${row.exactWithFailures.correct}/${row.exactWithFailures.n} | ${row.failedFeasible} |`).join("\n")}\n\nPaired counts (not significance or power):\n\n| Target vs baseline | Planned | Completed exact pairs | Including failed feasible | Target-only correct | Baseline-only correct |\n|---|---:|---:|---:|---:|---:|\n${result.contrasts.map(row => `| ${row.target} vs ${row.baseline} | ${row.planned} | ${row.completedExact.n} | ${row.exactWithFailures.n} | ${row.exactWithFailures.targetOnly} | ${row.exactWithFailures.baselineOnly} |`).join("\n")}\n`;
}
