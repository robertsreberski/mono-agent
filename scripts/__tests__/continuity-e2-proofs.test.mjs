import { it, expect, afterEach, vi } from "vitest";
import { mkdtemp, chmod, rm, readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import dgram from "node:dgram";
import dns, { lookup as dnsLookup } from "node:dns";
import dnsPromises from "node:dns/promises";
import subprocess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runE2Proofs, PROOF_CHILD, PROOF_ARMS, proofHistoryWarningClass, runProofPhase } from "../lib/continuity-e2-proofs.mjs";
import { assertProofEvidence, proofRefusalCode } from "../lib/continuity-e2-checks.mjs";
import { proofEnvironment, installProofIsolation } from "../lib/continuity-e2-isolation.mjs";
import { startProofTools, CANARY, FOREIGN, FACT, NEXT_ACTION } from "../lib/continuity-e2-tools.mjs";
import { E2_PROOF_PRESSURE_ARMS, armById } from "../lib/continuity-arms.mjs";
import { installProcessGuard } from "./fixtures/continuity-recorded/process-guard.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { diagnosticRecord, errorDiagnostic } from "../lib/continuity-e2-diagnostics.mjs";
import { main, parseE2Args, USAGE } from "../continuity-e2.mjs";
const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.restoreAllMocks(); syncBuiltinESMExports(); }, 60_000);
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "continuity-proof-fictional-")); await chmod(dir, 0o700); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; }
function processGuard() {
  const native = subprocess.spawn, hits = [], refusals = [];
  cleanups.push(installProcessGuard({ hit: s => hits.push(s), refuse: () => refusals.push("process") }));
  const guarded = subprocess.spawn;
  subprocess.spawn = (executable, args, options) => {
    const permitted = executable === process.execPath && args.length === 3 && args[0] === PROOF_CHILD && ["seed", "resume"].includes(args[1])
      && options.cwd === ROOT && options.shell === false && options.stdio === "ignore" && !options.detached
      && Object.keys(options).sort().join() === "cwd,env,shell,stdio"
      && Object.keys(options.env).every(k => ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP", "PATH", "LANG", "LC_ALL", "NODE_NO_WARNINGS"].includes(k));
    if (!permitted) return guarded(executable, args, options);
    hits.push("proof-fixture"); return native(executable, args, options);
  };
  // Restore before the underlying ownership-only guard restores native functions.
  cleanups.push(() => { subprocess.spawn = guarded; syncBuiltinESMExports(); }); syncBuiltinESMExports();
  return { hits, refusals };
}
async function modes(path) { const s = await lstat(path); expect(s.mode & 0o777).toBe(s.isDirectory() ? 0o700 : 0o600); if (s.isDirectory()) for (const n of await readdir(path)) await modes(join(path, n)); }

it("runs every configured faux proof, actual restart fixtures, observed idle eviction and shipping-ceiling compactions", async () => {
  const dir = await scratch(), guard = processGuard(), contexts = [];
  const result = await runE2Proofs({ output: join(dir, "run"), onContext: c => contexts.push(c) });
  expect(result.map(r => r.report.arm)).toEqual(PROOF_ARMS);
  expect(result.find(r => r.report.arm === "pressure").report.variants.map(v => v.variant)).toEqual(["ceiling", "restart"]);
  for (const { report, sizing } of result) {
    expect(report.semanticQualification).toBe(false);
    for (const v of report.variants) {
      expect(Object.values(v.assertions).every(x => x === true)).toBe(true);
      expect(v.lookup).toMatchObject({ initiallyPresent: false, sourceReturned: true });
      expect(v.lookup.verifiedRecords).toBeGreaterThan(0);
      if (report.arm === "cancel") expect(v).toMatchObject({ newProcess: true, forwarded: true, sentinelOffered: true });
      if (report.arm === "idle") expect(v.idle).toMatchObject({ observed: true, reason: "idle_timeout", timeoutMs: 1200 });
      if (report.arm === "pressure") expect(v.compactions.some(c => c.trigger === "proactive" && c.durable && c.policy.triggerTokens === 200_000)).toBe(true);
    }
    for (const v of sizing.variants) {
      expect(v.requests.length).toBeGreaterThan(28);
      for (const row of v.requests) {
        expect(["setup-scripted", "summary", "continuation", "probe"]).toContain(row.role);
        expect(row.size.maximum).toBe(Math.max(row.size.serializedBytesOver3, row.size.engineFullRequest));
        expect(row.maxOutputTokens).toBeGreaterThan(0);
        expect(row.model).toMatch(/^openai-codex:gpt-6/u);
      }
      expect(v.requests.filter(r => r.role === "probe")).toHaveLength(2);
      if (report.arm === "cancel") {
        expect(v.requests.filter(r => r.role === "setup-scripted")).toHaveLength(31);
        expect(v.requests.filter(r => r.role === "continuation")).toHaveLength(4);
      }
    }
    for (const raw of [JSON.stringify(report), JSON.stringify(sizing), await readFile(join(dir, "run", `${report.arm}-sizing.json`), "utf8")]) {
      for (const value of [CANARY, FOREIGN, FACT, NEXT_ACTION, dir, ROOT, "proof-evidence", "chr1_"]) expect(raw).not.toContain(value);
    }
  }
  expect(contexts.some(c => c.role === "continuation")).toBe(true);
  expect(guard.hits.filter(s => s === "proof-fixture")).toHaveLength(4); expect(guard.refusals).toEqual([]);
  await modes(join(dir, "run"));
}, 240_000);

it("refuses a genuinely repeated sentinel after a new-process resume", async () => {
  const dir = await scratch(); processGuard();
  await expect(runE2Proofs({ output: join(dir, "run"), arm: "cancel", fault: "repeat" })).rejects.toThrow("E2_PROOF_SENTINEL_REPEATED");
}, 90_000);
it("refuses a same-process resume before the wall-clock eviction", async () => {
  const dir = await scratch(); processGuard();
  await expect(runE2Proofs({ output: join(dir, "run"), arm: "idle", fault: "early-idle" })).rejects.toThrow("E2_PROOF_IDLE_NOT_EVICTED");
}, 90_000);
it("refuses an actual switch without a continuity pack", async () => {
  const dir = await scratch(); processGuard();
  await expect(runE2Proofs({ output: join(dir, "run"), arm: "switch", fault: "pack" })).rejects.toThrow("E2_PROOF_PACK_MISSING");
}, 90_000);
it.each(PROOF_ARMS)("refuses a canary leak in the %s arm", async arm => {
  const dir = await scratch(); processGuard();
  await expect(runE2Proofs({ output: join(dir, "run"), arm, fault: "leak" })).rejects.toThrow("E2_PROOF_LEAK");
}, 90_000);
it("rejects lowered-threshold, manual-only and non-durable compaction receipts", () => {
  const evidence = { arm: "pressure", pressureArm: E2_PROOF_PRESSURE_ARMS[0], initialAbsent: true, recovered: true, correct: true, safe: true, sentinel: { completed: true, repeated: false } };
  for (const c of [[], [{ trigger: "manual", durable: true, requests: 1, policy: { triggerTokens: 200_000 } }], [{ trigger: "proactive", durable: true, requests: 1, policy: { triggerTokens: 6400 } }], [{ trigger: "proactive", durable: false, requests: 1, policy: { triggerTokens: 200_000 } }]]) expect(() => assertProofEvidence({ ...evidence, compactions: c })).toThrow("E2_PROOF_CEILING_MISSING");
  const good = [{ trigger: "proactive", durable: true, requests: 1, policy: { triggerTokens: 200_000 } }];
  expect(assertProofEvidence({ ...evidence, compactions: good }).durableShippingCeilingCompaction).toBe(true);
  for (const modify of [m => m.expect.setupCompactions = 2, m => m.pressure[0].min = 200_001]) {
    const metadata = structuredClone(E2_PROOF_PRESSURE_ARMS[0]); modify(metadata);
    expect(() => assertProofEvidence({ ...evidence, pressureArm: metadata, compactions: good })).toThrow("E2_PROOF_CEILING_MISSING");
  }
  expect(armById("restart-switch-compact").probeConfig.runtime.compaction.triggerRatio).toBe(0.2);
  for (const a of E2_PROOF_PRESSURE_ARMS) { expect(a.sessionConfig.runtime.session.continuity.packEnabled).toBe(true); expect(a.probeConfig.runtime?.compaction).toBeUndefined(); }
});
it("blocks external sockets/fetch/WebSockets and restores the hermetic environment", async () => {
  const dir = await scratch(), before = process.env.HOME, restore = installProofIsolation(await proofEnvironment(dir));
  try {
    expect(process.env.HOME).toBe(join(dir, "home"));
    const socket = new Socket(); cleanups.push(() => socket.destroy());
    expect(() => socket.connect({ host: "203.0.113.1", port: 443 })).toThrow("E2_PROOF_EGRESS_REFUSED");
    for (const args of [[{ host: "127.0.0.1", path: "/Users/example/proof.sock" }], [{ host: "127.0.0.1", socketPath: "/Users/example/proof.sock" }], ["/Users/example/proof.sock", "127.0.0.1"], [[{ host: "127.0.0.1", path: "/Users/example/proof.sock" }]]]) expect(() => socket.connect(...args)).toThrow("E2_PROOF_EGRESS_REFUSED");
    expect(() => fetch("https://example.com")).toThrow("E2_PROOF_EGRESS_REFUSED");
    expect(() => new WebSocket("wss://example.com")).toThrow("E2_PROOF_EGRESS_REFUSED");
  } finally { restore(); }
  expect(process.env.HOME).toBe(before);
});
it("requires complete paid proof authority before touching paths and retains the bounded faux CLI", async () => {
  const err = [], out = [], io = { stdout: s => out.push(s), stderr: s => err.push(s) };
  expect(await main(["proofs", "--real", "--output", "fictional-path-canary"], io)).toBe(1);
  expect(err).toEqual([USAGE + "\n"]); expect(out).toEqual([]);
  // Hosted CI sets CI, which refuses paid mode first; pin both orders explicitly.
  vi.stubEnv("CI", "1");
  try { await expect(runE2Proofs({ real: true })).rejects.toThrow("paid_mode_refused_in_ci"); } finally { vi.unstubAllEnvs(); }
  vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  try { await expect(runE2Proofs({ real: true })).rejects.toThrow("e2_registration_invalid"); } finally { vi.unstubAllEnvs(); }
  expect(parseE2Args(["proofs", "--output", "new", "--arm", "idle"])).toEqual({ command: "proofs", output: "new", arm: "idle" });
  for (const args of [["proofs"], ["proofs", "--output", "new", "--arm", "unknown"], ["proofs", "--output", "new", "--threshold", "6400"]]) expect(() => parseE2Args(args)).toThrow("E2_ARGUMENTS_INVALID");
});

it("exercises the public faux CLI, counts-only output, private files and exclusive diagnostics", async () => {
  const dir = await scratch(), output = join(dir, "run"), diagnostic = join(dir, "refusal.json"), out = [], err = [];
  const io = { stdout: s => out.push(s), stderr: s => err.push(s) }; processGuard();
  expect(await main(["proofs", "--arm", "switch", "--output", output, "--diagnostics", diagnostic], io)).toBe(0);
  expect(err).toEqual([]); expect(JSON.parse(out[0])).toMatchObject({ arms: 1, variants: 1 });
  expect(JSON.parse(out[0]).requests).toBeGreaterThan(28);
  await expect(lstat(diagnostic)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await main(["proofs", "--output", output], io)).toBe(1); expect(err.at(-1)).toBe("EEXIST\n");
  await expect(main(["proofs", "--output", join(ROOT, "forbidden-proof-output")], io)).resolves.toBe(1);
  expect(err.at(-1)).toBe("RECORDED_OUTPUT_REFUSED\n");
  const module = await import("../lib/continuity-e2-proofs.mjs");
  vi.spyOn(module, "runE2Proofs").mockRejectedValue(Object.assign(new Error(`${CANARY} ${dir}`), { code: "E2_PROOF_LEAK" }));
  expect(await main(["proofs", "--output", join(dir, "unused"), "--diagnostics", diagnostic], io)).toBe(1);
  expect(err.at(-1)).toBe("E2_PROOF_LEAK\n");
  const raw = await readFile(diagnostic, "utf8"), record = JSON.parse(raw);
  expect(record.errorCode).toBe("E2_PROOF_LEAK"); expect(raw).not.toContain(CANARY); expect(raw).not.toContain(dir);
  expect(proofRefusalCode(`E2_PROOF_${CANARY}`)).toBe(null);
  expect(await main(["proofs", "--output", join(dir, "other"), "--diagnostics", diagnostic], io)).toBe(1);
  expect(err.at(-1)).toBe("EEXIST\n"); expect(await readFile(diagnostic, "utf8")).toBe(raw);
}, 60_000);

it("blocks UDP constructors and callback/promise DNS families, including Resolver instances, and restores every method", async () => {
  const dir = await scratch(), udp = dgram.createSocket, socket = dgram.Socket;
  const targets = [[dns, false], [new dns.Resolver(), false], [dnsPromises, true], [new dnsPromises.Resolver(), true]];
  const methods = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse"];
  const originals = targets.map(([t]) => Object.fromEntries(methods.filter(k => typeof t[k] === "function").map(k => [k, t[k]])));
  const restore = installProofIsolation(await proofEnvironment(dir));
  try {
    expect(() => dgram.createSocket("udp4")).toThrow("E2_PROOF_EGRESS_REFUSED");
    expect(() => new dgram.Socket("udp6")).toThrow("E2_PROOF_EGRESS_REFUSED");
    expect(dnsLookup).toBe(dns.lookup);
    for (const [target, promise] of targets) {
      let checked = 0;
      for (const name of methods.filter(k => typeof target[k] === "function")) {
        checked++;
        for (const host of ["example.com", "203.0.113.1", "localhost"]) {
          if (promise) await expect(target[name](host)).rejects.toThrow("E2_PROOF_EGRESS_REFUSED");
          else expect(() => target[name](host, () => { throw Error("callback must not run"); })).toThrow("E2_PROOF_EGRESS_REFUSED");
        }
      }
      expect(checked).toBeGreaterThan(10);
    }
    expect(await dnsPromises.lookup("127.0.0.1")).toEqual({ address: "127.0.0.1", family: 4 });
    expect(await dnsPromises.lookup("::1", { all: true })).toEqual([{ address: "::1", family: 6 }]);
    expect(await dnsPromises.resolve4("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(await dnsPromises.resolve("::1", "AAAA")).toEqual(["::1"]);
    await expect(dnsPromises.reverse("127.0.0.1")).rejects.toThrow("E2_PROOF_EGRESS_REFUSED");
    await new Promise((resolve, reject) => dnsLookup("127.0.0.1", (error, address, family) => { try { expect(error).toBe(null); expect([address, family]).toEqual(["127.0.0.1", 4]); resolve(); } catch (e) { reject(e); } }));
  } finally { restore(); }
  expect(dgram.createSocket).toBe(udp); expect(dgram.Socket).toBe(socket);
  targets.forEach(([target], i) => { for (const [name, method] of Object.entries(originals[i])) expect(target[name]).toBe(method); });
  expect(dnsLookup).toBe(dns.lookup);
});
it("lets the MCP transport handle non-POST methods without parsing an empty JSON body", async () => {
  const dir = await scratch(), restore = installProofIsolation(await proofEnvironment(dir)); let tools;
  try {
    tools = await startProofTools(dir);
    for (const [method, status] of [["GET", 406], ["OPTIONS", 405], ["DELETE", 200]]) {
      const response = await fetch(tools.url, { method, headers: { accept: "application/json" }, signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(status); await response.body?.cancel();
    }
  } finally { try { await tools?.close(); } finally { restore(); } }
});
it.each(["E2_PROOF_TOOL_REFUSED", "E2_BOUNDARY_MISMATCH"])("preserves %s in CLI and private diagnostics", async code => {
  const dir = await scratch(), module = await import("../lib/continuity-e2-proofs.mjs"), out = [], err = [], diagnostic = join(dir, "diagnostic.json");
  expect(proofRefusalCode(code)).toBe(code);
  expect(diagnosticRecord(errorDiagnostic(Object.assign(new Error(CANARY), { code }))).errorCode).toBe(code);
  vi.spyOn(module, "runE2Proofs").mockRejectedValue(Object.assign(new Error(CANARY), { code }));
  expect(await main(["proofs", "--output", join(dir, "output"), "--diagnostics", diagnostic], { stdout: s => out.push(s), stderr: s => err.push(s) })).toBe(1);
  expect(out).toEqual([]); expect(err).toEqual([`${code}\n`]);
  const raw = await readFile(diagnostic, "utf8"); expect(JSON.parse(raw).errorCode).toBe(code); expect(raw).not.toContain(CANARY);
});

it("classifies history warnings without retaining their variable or private text", () => {
  const privateTail = "Fictional private data /home/example/private-state";
  for (const [message, expected] of [
    ["ConversationHistory endpoint could not start; " + privateTail, "endpoint_unavailable"],
    ["Tool lifecycle persistence failed (history_persistence_timeout); " + privateTail, "lifecycle_timeout"],
    ["Tool lifecycle persistence failed (fictional_secret); " + privateTail, "lifecycle_failed"],
    ["Tool history writer acquisition failed (history_persistence_timeout); " + privateTail, "writer_acquisition_timeout"],
    ["Continuity is degraded (sidecar_unavailable); " + privateTail, "continuity_sidecar_unavailable"],
    ["Continuity is degraded (capture_bounds); " + privateTail, "continuity_capture_bounds"],
    ["Continuity is degraded (capture_quota); " + privateTail, "continuity_capture_quota"],
    ["Continuity coverage gap: " + privateTail, "preparation_abandoned"],
    ["Upkeep accounting degraded: " + privateTail, "accounting_degraded"],
    [privateTail, "unknown"], [undefined, "unknown"],
  ]) expect(proofHistoryWarningClass(message)).toBe(expected);
});

it("preserves the degraded-history refusal and writes only fixed classes privately", async () => {
  const dir = await scratch(), base = join(dir, "warning"), runner = await import("../lib/continuity-runner.mjs");
  const original = runner.productionModules, privateText = "Fictional private text /home/example/private-state";
  vi.spyOn(runner, "productionModules").mockImplementation(async (...args) => {
    const modules = await original(...args);
    return { ...modules, app: { ...modules.app, createConfiguredConversationHarness: async options => {
      options.onToolHistoryWarning("ConversationHistory endpoint could not start; " + privateText);
      return modules.app.createConfiguredConversationHarness(options);
    } } };
  });
  const restore = installProofIsolation(await proofEnvironment(dir));
  try {
    await expect(runProofPhase({ base, arm: "switch" })).rejects.toMatchObject({ code: "E2_HISTORY_DEGRADED",
      historyWarnings: { arm: "switch", variant: "ceiling", phase: "whole", warnings: [{ mode: "setup-scripted", kind: "endpoint_unavailable" }] } });
    const file = join(base, "whole-history-warnings.json"), raw = await readFile(file, "utf8");
    expect(JSON.parse(raw).warnings).toEqual([{ mode: "setup-scripted", kind: "endpoint_unavailable" }]);
    expect(raw).not.toContain(privateText); expect(raw).not.toContain(dir); expect((await lstat(file)).mode & 0o777).toBe(0o600);
  } finally { restore(); }
}, 60_000);
