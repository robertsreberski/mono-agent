import assert from "node:assert/strict";
import { dependencyLeafSnapshot } from "../../__tests__/fixtures/lookup-leaf-witness.mjs";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { withOfflineBuilds, OFFLINE_FLAGS } from "../../__tests__/fixtures/lookup-offline-builds.mjs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { syntheticContext, fixtureGit, fixtureCommit, fixtureLookupPolicy } from "../../__tests__/fixtures/holdout-synthetic.mjs";
import { sha256 } from "../../lib/continuity-lookup.mjs";

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
export const configuredDependencyRoots = root => [join(root, "node_modules"), join(root, "packages/web/webapp/node_modules")];
export async function fullConfiguredFixture(root, base) {
  const leaves = configuredDependencyRoots(root), leafBefore = await dependencyLeafSnapshot(leaves);
  const previous = {...process.env}, home = join(base, "build-home"), commands = [];
  await fs.mkdir(home);
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_") || /(?:_API_KEY|_TOKEN)$/u.test(key)) delete process.env[key];
  Object.assign(process.env, {HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", COREPACK_ENABLE_NETWORK: "0"});
  let setupError, setupFailed = false;
  try {
    const f = await syntheticContext(base, {families: 4, conversationsPerFamily: 1, conversationsPerCorpus: 2, shards: 2, perCorpusPerShard: 1}, {isolatedDependencies: false});
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
    for (const path of [f.repo, pack]) {
      // The real app closure includes web. Its explicit install step is not
      // permitted in a shared-dependency proof; retain the actual build only.
      const manifestPath = join(path, "packages/web/package.json"), manifest = JSON.parse(await fs.readFile(manifestPath));
      const install = "pnpm --dir webapp install --frozen-lockfile && ";
      assert.ok(manifest.scripts.build.startsWith(install));
      manifest.scripts.build = manifest.scripts.build.slice(install.length).replaceAll("pnpm ", `pnpm ${OFFLINE_FLAGS.join(" ")} `);
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      await fs.writeFile(join(path, ".npmrc"), "offline=true\nverify-deps-before-run=false\nmanage-package-manager-versions=false\n");
      // APFS copy-on-write clone: nested bundler caches and install metadata
      // are private, and relative dependency symlinks keep the original layout.
      execFileSync("/bin/cp", ["-cR", join(root, "packages/web/webapp/node_modules"), join(path, "packages/web/webapp/node_modules")]);
      assert.ok((await fs.readFile(join(path, "packages/web/webapp/node_modules/.pnpm/lock.yaml"))).equals(await fs.readFile(join(path, "packages/web/webapp/pnpm-lock.yaml"))), "cloned webapp dependency lock mismatch");
      await linkDependencies(root, path); fixtureGit(path, ["init", "-q"]); fixtureCommit(path);
    }
    const checkouts = Object.fromEntries([["R0", f.repo], ["Rpack", pack]].map(([id, path]) => [id, {path, revision: fixtureGit(path, ["rev-parse", "HEAD"]).trim()}]));
    const load = name => import(pathToFileURL(join(f.repo, "scripts/lib", `continuity-lookup-${name}.mjs`)).href);
    const roles = await load("roles"), module = await load("pilot");
    const {codes, protocol} = await withOfflineBuilds(() => roles.prepareLookupCodes(checkouts), commands);
    const options = {checkouts, suites: ["holdout"], lookupSource: {manifestPath: f.context.options.manifestPath, manifestSha256: f.context.options.manifestSha256, statisticalSpecPath: f.context.options.statisticalSpecPath}, reader: "openai-codex:gpt-6.1-sol", readerEffort: "high", selectionSeed: 42, perGroup: 1, probeLimit: 1, outputLimit: {source: "catalog_max", tokens: 128000}};
    const workload = await roles.lookupWorkload({...options, inputRoots: [f.repo, pack]});
    // Arithmetic-only faux feasibility, never a real feasibility measurement or grant.
    const policy = await fixtureLookupPolicy({source: workload.corpora[0].source, selection: workload.corpora[0].traces, lookupSelection: workload.lookupSelection, reader: workload.reader, codes, protocol, eligibleRoles: ["pack", "pack-only"]});
    const dataset = await import(pathToFileURL(join(f.repo, "scripts/lib/continuity-dataset.mjs")).href);
    const lookup = await import(pathToFileURL(join(f.repo, "scripts/lib/continuity-lookup.mjs")).href);
    const loaded = await dataset.loadTraces({suite: "holdout", lookupSource: options.lookupSource, selectionSeed: 42, perGroup: 1, inputRoots: [f.repo, pack]});
    for (const path of policy.budget.paths) {const trace = loaded.traces.find(t => t.id === path.traceId); path.sourceSha256 = lookup.sourceAnnotation(trace, trace.probes.find(p => p.id === path.probeId)).sourceSha256;}
    const policyPath = join(f.inputs, "lookup-policy.json"); await fs.writeFile(policyPath, JSON.stringify(policy));
    const register = (policyPath, policy) => withOfflineBuilds(() => module.registerLookupPilot({...options, policyPath, policySha256: sha256(JSON.stringify(policy)), capUSD: 100, scheduleSeed: 13, runDeadlineMs: 1800000}), commands);
    const pilot = await register(policyPath, policy);
    const roundsPolicy = structuredClone(policy);
    for (const path of roundsPolicy.budget.paths) if (["soul-only", "shipping"].includes(path.role)) {
      path.admissionCap = 400000000;
      path.initialAdmission = lookup.referenceFeasibility({calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true}, roundsPolicy.budget, path);
      path.feasibility = lookup.externalPathFeasibility(path, roundsPolicy.budget);
    }
    const roundsPath = join(f.inputs, "lookup-rounds-policy.json"); await fs.writeFile(roundsPath, JSON.stringify(roundsPolicy));
    const roundsPilot = await register(roundsPath, roundsPolicy);
    assert.deepEqual(await dependencyLeafSnapshot(leaves), leafBefore, "fixture build mutated shared dependency leaves");
    return {base, repo: f.repo, pack, home, pilot, roundsPilot, commands, webBuild: {installBypassed: true, nestedDependencies: "private APFS clone", flags: OFFLINE_FLAGS}, dependencyLeaves: {count: leafBefore.length, unchanged: true}};
  } catch (error) {setupFailed = true; setupError = error; throw error;} finally {
    try {assert.deepEqual(await dependencyLeafSnapshot(leaves), leafBefore, "fixture build mutated shared dependency leaves");}
    catch (error) {if (setupFailed) error.cause = setupError; throw error;}
    finally {for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);}
  }
}
