// Fast contract checks only; these do not replace the full registered replay proof.
import { expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupChildEnvironment, lookupChildImports } from "../lib/continuity-lookup-child-environment.mjs";
import { lookupPilotWatchdog } from "../lib/continuity-lookup-pilot-runtime.mjs";
import { LOOKUP_PILOT_REAL_ROUTE_ENABLED, assertLookupPilotEntry } from "../lib/continuity-lookup-pilot-entry.mjs";
import { credentialedHomeCanary } from "./fixtures/lookup-credentialed-home.mjs";

it("keeps CI/debug presence and explicit absolute imports while excluding ambient credentials and loaders", async () => {
  const dir = await mkdtemp(join(fs.realpathSync(tmpdir()), "lookup-child-contract-"));
  const argv = process.execArgv;
  try {
    vi.stubEnv("CI", ""); vi.stubEnv("CONTINUITY_DEBUG", "");
    vi.stubEnv("FICTIONAL_API_KEY", "FICTIONAL-NOT-REAL"); vi.stubEnv("NODE_OPTIONS", "--inspect");
    const home = join(dir, "home"), env = await lookupChildEnvironment(home);
    expect(env).toMatchObject({CI: "", CONTINUITY_DEBUG: "", HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home});
    expect(Object.hasOwn(env, "NODE_OPTIONS")).toBe(false); expect(Object.hasOwn(env, "FICTIONAL_API_KEY")).toBe(false);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    process.execArgv = ["--inspect", "--import", "./fictional-egress.mjs", "--import=file:///fictional/worker.mjs"];
    expect(lookupChildImports()).toEqual(["--import", new URL("./fictional-egress.mjs", `file://${process.cwd()}/`).href, "--import=file:///fictional/worker.mjs"]);
  } finally { process.execArgv = argv; vi.unstubAllEnvs(); await rm(dir, {recursive: true, force: true}); }
}, 30000);

it("clips the pilot kill to the latency deadline rather than adding turn or cleanup time", () => {
  const deadlines = {deadlineMs: 600000, childWatchdogMs: 720000};
  expect(lookupPilotWatchdog({}, deadlines, 1800000, 0)).toBe(600000);
  expect(lookupPilotWatchdog({timeoutMs: 120000}, deadlines, 1800000, 0)).toBe(120000);
  expect(lookupPilotWatchdog({}, deadlines, 1800000, 1799000)).toBe(1000);
  expect(() => lookupPilotWatchdog({timeoutMs: 720001}, deadlines, 1800000, 0)).toThrow("lookup_ipc_invalid");
});

it("keeps the real entry closed regardless of the configured-path test coverage", () => {
  expect(LOOKUP_PILOT_REAL_ROUTE_ENABLED).toBe(false);
  expect(() => assertLookupPilotEntry()).toThrow("lookup_pilot_real_route_unavailable");
});

it("audits canonical ROOT code reads, refuses a home-store escape and blocks credential and ROOT writes", async () => {
  const dir = await mkdtemp(join(fs.realpathSync(tmpdir()), "lookup-home-contract-"));
  const home = join(dir, "fictional-home"), root = join(home, "checkout"), credential = join(dir, "credential", "auth.json");
  await mkdir(join(root, "node_modules"), {recursive: true}); await mkdir(join(home, ".pi")); await mkdir(join(dir, "credential"));
  await writeFile(join(home, ".pi", "auth.json"), "FICTIONAL-NOT-REAL"); await writeFile(credential, "FICTIONAL-NOT-REAL");
  const module = join(root, "node_modules", "module.js"), readme = join(root, "README.md");
  await writeFile(module, "export {};\n"); await writeFile(readme, "Fictional code-tree document.");
  await symlink(join(home, ".pi", "auth.json"), join(root, "node_modules", "escape.js"));
  await symlink(home, join(dir, "alias-home"));
  let guard;
  try {
    guard = credentialedHomeCanary({root, home, credential, evidence: dir}); guard.canaries(); guard.constructed();
    expect(() => fs.readFileSync(join(root, "node_modules", "escape.js"))).toThrow("test_real_home_denied");
    expect(() => fs.writeFileSync(join(dir, "alias-home", "missing"), "not permitted")).toThrow("test_real_home_denied");
    expect(() => fs.writeFileSync(module, "not permitted")).toThrow("test_real_home_denied");
    expect(() => fs.renameSync(module, join(root, "renamed.js"))).toThrow("test_real_home_denied");
    expect(() => fs.writeFileSync(credential, "not permitted")).toThrow("test_credential_write_denied");
    expect(fs.readFileSync(module, "utf8")).toBe("export {};\n");
    expect(guard.result().postConstructionReads).toEqual(["node_modules/module.js"]);
    expect(guard.result().nonModuleReads).toEqual([]);
    expect(() => fs.readFileSync(readme)).toThrow("test_root_data_read_denied"); expect(guard.result().nonModuleReads).toEqual(["README.md"]);
    expect(guard.result().credentialWrites).toBe(1);
  } finally { guard?.restore(); await rm(dir, {recursive: true, force: true}); }
}, 30000);
