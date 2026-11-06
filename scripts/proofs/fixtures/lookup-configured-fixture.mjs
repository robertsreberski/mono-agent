import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import child from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { syntheticContext, fixtureGit, fixtureCommit, fixtureLookupPolicy } from "../../__tests__/fixtures/holdout-synthetic.mjs";
import { sha256 } from "../../lib/continuity-lookup.mjs";

export const OFFLINE_FLAGS = ["--config.verify-deps-before-run=false", "--config.manage-package-manager-versions=false", "--config.offline=true"];
// Only execution flags are added. Every production build/verification command runs;
// no output, source, module resolution or result is substituted.
export async function withOfflineBuilds(fn, commands) {
  const original = child.execFileSync;
  child.execFileSync = function (file, args, options) {
    if (file === "pnpm") { args = [...OFFLINE_FLAGS, ...args]; commands.push({file, args}); }
    return original.call(this, file, args, options);
  };
  syncBuiltinESMExports();
  try {return await fn();} finally {child.execFileSync = original; syncBuiltinESMExports();}
}
async function linkDependencies(source, target) {
  await fs.mkdir(join(target, "node_modules"));
  for (const name of await fs.readdir(join(source, "node_modules"))) {
    if (name === "@mono-agent" || name === ".modules.yaml" || name === ".pnpm-workspace-state-v1.json" || name === ".cache" || name.startsWith(".vite")) continue;
    await fs.symlink(join(source, "node_modules", name), join(target, "node_modules", name));
  }
  const packages = new Map();
  for (const tier of ["packages", "extras"]) for (const name of await fs.readdir(join(target, tier))) {
    const path = join(target, tier, name);
    try {packages.set(JSON.parse(await fs.readFile(join(path, "package.json"))).name, path);} catch (error) {if (error.code !== "ENOENT") throw error;}
  }
  for (const [name, path] of packages) {
    if (name.startsWith("@mono-agent/")) {const link = join(target, "node_modules", name); await fs.mkdir(dirname(link), {recursive: true}); await fs.symlink(path, link);}
    const original = join(source, path.slice(target.length + 1)), metadata = JSON.parse(await fs.readFile(join(path, "package.json")));
    await fs.mkdir(join(path, "node_modules"));
    for (const dep of Object.keys({...metadata.dependencies, ...metadata.devDependencies, ...metadata.optionalDependencies})) {
      const destination = join(path, "node_modules", dep); await fs.mkdir(dirname(destination), {recursive: true});
      let resolved = packages.get(dep);
      if (!resolved) try {resolved = await fs.realpath(join(original, "node_modules", dep));} catch (error) {if (error.code !== "ENOENT") throw error; continue;}
      await fs.symlink(resolved, destination);
    }
  }
}
export async function fullConfiguredFixture(root, base) {
  const previous = {...process.env}, home = join(base, "build-home"), commands = [];
  await fs.mkdir(home);
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_") || /(?:_API_KEY|_TOKEN)$/u.test(key)) delete process.env[key];
  Object.assign(process.env, {HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", COREPACK_ENABLE_NETWORK: "0"});
  try {
    const f = await syntheticContext(base, {families: 4, conversationsPerFamily: 1, conversationsPerCorpus: 2, shards: 2, perCorpusPerShard: 1}, {isolatedDependencies: true});
    // Retain the complete registered frozen data, replace ONLY the synthetic code
    // repository with the actual tracked source and genuine closure builds.
    await fs.rm(f.repo, {recursive: true});
    const archive = execFileSync("git", ["-C", root, "archive", "HEAD"], {maxBuffer: 256 * 1024 * 1024});
    const pack = join(base, "rpack");
    for (const path of [f.repo, pack]) {
      await fs.mkdir(path, {mode: 0o700});
      execFileSync("/usr/bin/tar", ["-xf", "-", "-C", path], {input: archive, maxBuffer: 1024 * 1024});
    }
    const render = "packages/conversation/src/continuity/render-fit.ts", implementation = "packages/conversation/src/continuity/pack.ts";
    const original = await fs.readFile(join(f.repo, render), "utf8");
    if (!/^export const PACK_RETRIEVAL_GUIDANCE = .*;$/mu.test(original)) throw Error("proof_guidance_baseline_changed");
    await fs.writeFile(join(f.repo, render), original.replace(/^export const PACK_RETRIEVAL_GUIDANCE = .*;\n/mu, ""));
    const source = await fs.readFile(join(f.repo, implementation), "utf8");
    if (!source.includes('const guidance = conversationHistoryAvailable ? PACK_RETRIEVAL_GUIDANCE : "";')) throw Error("proof_guidance_baseline_changed");
    await fs.writeFile(join(f.repo, implementation), source.replace(", PACK_RETRIEVAL_GUIDANCE }", " }").replace("conversationHistoryAvailable = false): ContinuityPack", "_conversationHistoryAvailable = false): ContinuityPack").replace('const guidance = conversationHistoryAvailable ? PACK_RETRIEVAL_GUIDANCE : "";', 'const guidance = "";'));
    for (const path of [f.repo, pack]) {await linkDependencies(root, path); fixtureGit(path, ["init", "-q"]); fixtureCommit(path);}
    const checkouts = Object.fromEntries([["R0", f.repo], ["Rpack", pack]].map(([id, path]) => [id, {path, revision: fixtureGit(path, ["rev-parse", "HEAD"]).trim()}]));
    const load = name => import(pathToFileURL(join(f.repo, "scripts/lib", `continuity-lookup-${name}.mjs`)).href);
    const roles = await load("roles"), module = await load("pilot");
    const {codes, protocol} = await withOfflineBuilds(() => roles.prepareLookupCodes(checkouts), commands);
    const options = {checkouts, suites: ["holdout"], lookupSource: {manifestPath: f.context.options.manifestPath, manifestSha256: f.context.options.manifestSha256, statisticalSpecPath: f.context.options.statisticalSpecPath}, reader: "openai-codex:gpt-6.1-sol", readerEffort: "high", selectionSeed: 42, perGroup: 1, probeLimit: 1, outputLimit: {source: "catalog_max", tokens: 128000}};
    const workload = await roles.lookupWorkload({...options, inputRoots: [f.repo, pack]});
    // Arithmetic-only faux feasibility, never a real feasibility measurement or grant.
    const policy = await fixtureLookupPolicy({source: workload.corpora[0].source, selection: workload.corpora[0].traces, lookupSelection: workload.lookupSelection, reader: workload.reader, codes, protocol, eligibleRoles: ["pack"]});
    const dataset = await import(pathToFileURL(join(f.repo, "scripts/lib/continuity-dataset.mjs")).href);
    const lookup = await import(pathToFileURL(join(f.repo, "scripts/lib/continuity-lookup.mjs")).href);
    const loaded = await dataset.loadTraces({suite: "holdout", lookupSource: options.lookupSource, selectionSeed: 42, perGroup: 1, inputRoots: [f.repo, pack]});
    for (const path of policy.budget.paths) {const trace = loaded.traces.find(t => t.id === path.traceId); path.sourceSha256 = lookup.sourceAnnotation(trace, trace.probes.find(p => p.id === path.probeId)).sourceSha256;}
    const policyPath = join(f.inputs, "lookup-policy.json"); await fs.writeFile(policyPath, JSON.stringify(policy));
    const pilot = await withOfflineBuilds(() => module.registerLookupPilot({...options, policyPath, policySha256: sha256(JSON.stringify(policy)), capUSD: 100, scheduleSeed: 13, runDeadlineMs: 1800000}), commands);
    return {base, repo: f.repo, pack, home, pilot, commands};
  } finally {for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);}
}
