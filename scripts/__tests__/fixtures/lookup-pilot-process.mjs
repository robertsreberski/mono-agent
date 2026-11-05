import { beforeAll, afterAll, beforeEach, afterEach, expect } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { syntheticContext, fixtureCommit, fixtureLookupPolicy } from "./holdout-synthetic.mjs";
import { dependencySnapshot } from "./lookup-dependency-witness.mjs";
import { lookupProcessStartIdentity } from "../../lib/continuity-process-identity.mjs";
import { ROOT } from "../../lib/continuity-lookup-roles.mjs";
import { digest } from "../../lib/continuity-dataset.mjs";
import { sha256 } from "../../lib/continuity-lookup.mjs";

export const loadPilot = (f, name) => import(/* @vite-ignore */ pathToFileURL(join(f.repo, "scripts/lib", `continuity-lookup-${name}.mjs`)).href);
const metadata = async path => { try { const s = await fs.lstat(path); return [s.ino, s.mtimeMs]; } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const registry = join(userInfo().homedir, ".local/state/mono-agent/lookup-pilot/consumed-v1");
export async function pilotProcessFixture({ configured = false } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-controller-fictional-")));
  await fs.chmod(base, 0o700);
  const env = { ...process.env }, home = join(base, "build-home"); await fs.mkdir(home, { mode: 0o700 });
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  Object.assign(process.env, { HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, COREPACK_ENABLE_NETWORK: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  for (const p of ["npm_config", "pnpm_config"]) Object.assign(process.env, { [`${p}_offline`]: "true", [`${p}_verify_deps_before_run`]: "false", [`${p}_manage_package_manager_versions`]: "false" });
  try {
    const bridge = join(base, "node_modules/@mono-agent"); await fs.mkdir(bridge, { recursive: true });
    for (const name of ["turn", "conversation"]) await fs.symlink(join(ROOT, "packages", name), join(bridge, name));
    await fs.symlink(join(ROOT, "node_modules/typescript"), join(base, "node_modules/typescript"));
    if (configured) {
      const pkg = JSON.parse(await fs.readFile(join(ROOT, "packages/app/package.json")));
      for (const name of Object.keys(pkg.dependencies).filter(n => !n.startsWith("@mono-agent/"))) {
        const destination = join(base, "node_modules", name);
        await fs.mkdir(join(destination, ".."), {recursive: true});
        await fs.symlink(await fs.realpath(join(ROOT, "packages/app/node_modules", name)), destination);
      }
      for (const name of await fs.readdir(join(ROOT, "packages"))) {
        try { await fs.access(join(ROOT, "packages", name, "package.json")); await fs.symlink(join(ROOT, "packages", name), join(bridge, name)); }
        catch (error) { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; }
      }
      const mcp = join(base, "node_modules/@modelcontextprotocol"); await fs.mkdir(mcp, {recursive: true});
      try { await fs.symlink(join(ROOT, "node_modules/@modelcontextprotocol/sdk"), join(mcp, "sdk")); } catch (error) { if (error.code !== "EEXIST") throw error; }
      await fs.cp(join(ROOT, "packages/app/dist"), join(base, "app-runtime"), { recursive: true });
    }
    const f = await syntheticContext(base, { families: 4, conversationsPerFamily: 1, conversationsPerCorpus: 2, shards: 2, perCorpusPerShard: 1 }, { isolatedDependencies: true });
    await fs.chmod(f.repo, 0o700); await fs.rm(join(f.repo, "packages/app/dist"));
    await fs.writeFile(join(f.repo, "package.json"), '{"name":"fictional-controller","private":true}');
    await fs.writeFile(join(f.repo, "pnpm-workspace.yaml"), "packages:\n  - packages/app\n");
    await fs.writeFile(join(f.repo, ".npmrc"), "offline=true\nverify-deps-before-run=false\nmanage-package-manager-versions=false\n");
    await fs.writeFile(join(f.repo, "packages/app/package.json"), JSON.stringify({ name: "@mono-agent/app", private: true, scripts: { build: `node --input-type=module -e "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','export const fictional = true;')"` } }));
    if (configured) {
      // Build-owned physical runtime artifacts at the registered root, no runtime redirection.
      const script = `import {cpSync,mkdirSync} from 'node:fs'; mkdirSync('dist',{recursive:true}); cpSync(${JSON.stringify(join(base, "app-runtime"))},'dist',{recursive:true});`;
      await fs.writeFile(join(f.repo, "packages/app/package.json"), JSON.stringify({ name: "@mono-agent/app", private: true, type: "module", scripts: { build: `node --input-type=module -e ${JSON.stringify(script)}` } }));
    }
    const render = "packages/conversation/src/continuity/render-fit.ts"; await fs.writeFile(join(f.repo, render), "// Fictional no-guidance baseline\n"); fixtureCommit(f.repo);
    const pack = join(base, "rpack"); await fs.cp(f.repo, pack, { recursive: true }); await fs.chmod(pack, 0o700);
    await fs.appendFile(join(pack, render), '\nexport const PACK_RETRIEVAL_GUIDANCE = "Fictional guidance";\n'); fixtureCommit(pack);
    const revision = root => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const checkouts = { R0: { path: f.repo, revision: revision(f.repo) }, Rpack: { path: pack, revision: revision(pack) } };
    const roles = await loadPilot(f, "roles"), pilotModule = await loadPilot(f, "pilot");
    const { codes, protocol } = await roles.prepareLookupCodes(checkouts);
    const options = { checkouts, suites: ["holdout"], lookupSource: { manifestPath: f.context.options.manifestPath, manifestSha256: f.context.options.manifestSha256,
      statisticalSpecPath: f.context.options.statisticalSpecPath }, reader: "openai-codex:gpt-6.1-sol", readerEffort: "high", selectionSeed: 42, perGroup: configured ? 1 : 2, probeLimit: 1,
      outputLimit: { source: "catalog_max", tokens: 128000 } };
    const workload = await roles.lookupWorkload({ ...options, inputRoots: [f.repo, pack] });
    const policy = await fixtureLookupPolicy({ source: workload.corpora[0].source, selection: workload.corpora[0].traces, lookupSelection: workload.lookupSelection, reader: workload.reader, codes, protocol });
    const policyPath = join(f.inputs, "lookup-policy.json"); await fs.writeFile(policyPath, JSON.stringify(policy));
    const pilot = await pilotModule.registerLookupPilot({ ...options, policyPath, policySha256: sha256(await fs.readFile(policyPath)), capUSD: 3.92, scheduleSeed: 13, runDeadlineMs: 60000 });
    return { ...f, base, pack, pilot, home };
  } catch (error) { await fs.rm(base, { recursive: true, force: true }); throw error; }
  finally { for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); }
}
export async function runOptions(f, scenarios = ["lost"], timeoutMs = 5000) {
  const outputRoot = join(f.base, randomUUID()); await fs.mkdir(outputRoot, { mode: 0o700 });
  return { pilot: f.pilot, outputRoot, authorization: { schema: "continuity-lookup-faux-authorization-v1", authorizationId: randomUUID(),
    pilotSha256: digest(f.pilot), outputRoot, scenarios, timeoutMs } };
}
export function pilotSuite() {
  let f, deps, real, testReal; const children = [];
  beforeAll(async () => { deps = await dependencySnapshot(ROOT); real = await metadata(registry); f = await pilotProcessFixture(); }, 120000);
  beforeEach(async () => { testReal = await metadata(registry); });
  afterEach(async () => {
    try { expect(await metadata(registry)).toEqual(testReal); await witnesses(); }
    finally { for (const c of children.splice(0)) {
      const driverWitness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${c.child.pid}.json`)));
      for (const probe of driverWitness.probes) {
        let witness; try { witness = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${probe.pid}.json`))); } catch (e) { if (e.code !== "ENOENT") throw e; }
        for (const owned of [probe, ...(witness?.descendants ?? [])]) if (owned.startIdentity && lookupProcessStartIdentity(owned.pid) === owned.startIdentity) try { process.kill(owned.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      }
      if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL"); await c.exit;
    } }
  });
  afterAll(async () => { try { if (f) await fs.rm(f.base, { recursive: true, force: true }); } finally { expect(await metadata(registry)).toEqual(real); expect(await dependencySnapshot(ROOT)).toEqual(deps); } });
  async function witnesses() {
    for (const c of children) {
      const read = async pid => { const value = JSON.parse(await fs.readFile(join(f.base, "witnesses", `${pid}.json`))); expect(value).toMatchObject({ canaries: 3, unexpected: 0, git: ["/dev/null", "1"] }); expect(value.xdg).toEqual([value.home, value.home, value.home, value.home]); expect(value.home.startsWith(f.base)).toBe(true); return value; };
      const driver = await read(c.child.pid), expected = new Set(driver.probes.map(p => p.pid));
      if (c.outputRoot) try { const state = JSON.parse(await fs.readFile(join(c.outputRoot, "lookup-pilot-controller.json"))); for (const s of state.slots) if (s.worker) expected.add(s.worker.pid); } catch (e) { if (e.code !== "ENOENT") throw e; }
      for (const pid of expected) await read(pid);
    }
  }
  return { get fixture() { return f; },
    async spawn(input, extraEnv = {}) {
      const witnesses = join(f.base, "witnesses"); await fs.mkdir(witnesses, { recursive: true, mode: 0o700 });
      const preload = fileURLToPath(new URL("./lookup-pilot-preload.mjs", import.meta.url));
      const child = fork(fileURLToPath(new URL("./lookup-pilot-driver.mjs", import.meta.url)), [], { cwd: f.repo, execArgv: ["--import", preload],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), HOME: f.home, XDG_CACHE_HOME: f.home, XDG_CONFIG_HOME: f.home, XDG_DATA_HOME: f.home, XDG_STATE_HOME: f.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",  LOOKUP_FIXTURE_WITNESSES: witnesses, ...extraEnv }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      child.stderr.resume(); let result;
      const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fixture_deadline")); }, 20000);
        child.on("message", m => { if (m.ready) child.send({ ...input, repo: f.repo }); else { result = m; clearTimeout(timer); resolve(m); } });
        child.once("exit", () => { clearTimeout(timer); resolve(result); }); child.once("error", reject);
      });
      const record = { child, exit, reply, outputRoot: input.options?.outputRoot }; children.push(record); return record;
    },
    witnesses,
  };
}
