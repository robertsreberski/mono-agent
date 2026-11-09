import { it, expect, afterEach, vi } from "vitest";
import { mkdtemp, chmod, rm, readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import subprocess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runE2Proofs, PROOF_CHILD, PROOF_ARMS } from "../lib/continuity-e2-proofs.mjs";
import { assertProofEvidence, proofRefusalCode } from "../lib/continuity-e2-checks.mjs";
import { proofEnvironment, installProofIsolation } from "../lib/continuity-e2-isolation.mjs";
import { CANARY, FOREIGN, FACT, NEXT_ACTION } from "../lib/continuity-e2-tools.mjs";
import { E2_PROOF_PRESSURE_ARMS, armById } from "../lib/continuity-arms.mjs";
import { installProcessGuard } from "./fixtures/continuity-recorded/process-guard.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { main, parseE2Args } from "../continuity-e2.mjs";
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
  const evidence = { arm: "pressure", initialAbsent: true, recovered: true, correct: true, safe: true, sentinel: { completed: true, repeated: false } };
  for (const c of [[], [{ trigger: "manual", durable: true, requests: 1, policy: { triggerTokens: 200_000 } }], [{ trigger: "proactive", durable: true, requests: 1, policy: { triggerTokens: 6400 } }], [{ trigger: "proactive", durable: false, requests: 1, policy: { triggerTokens: 200_000 } }]]) expect(() => assertProofEvidence({ ...evidence, compactions: c })).toThrow("E2_PROOF_CEILING_MISSING");
  expect(armById("restart-switch-compact").probeConfig.runtime.compaction.triggerRatio).toBe(0.2);
  for (const a of E2_PROOF_PRESSURE_ARMS) { expect(a.sessionConfig.runtime.session.continuity.packEnabled).toBe(true); expect(a.probeConfig.runtime?.compaction).toBeUndefined(); }
});
it("blocks external sockets/fetch/WebSockets and restores the hermetic environment", async () => {
  const dir = await scratch(), before = process.env.HOME, restore = installProofIsolation(await proofEnvironment(dir));
  try {
    expect(process.env.HOME).toBe(join(dir, "home"));
    const socket = new Socket(); cleanups.push(() => socket.destroy());
    expect(() => socket.connect({ host: "203.0.113.1", port: 443 })).toThrow("E2_PROOF_EGRESS_REFUSED");
    expect(() => fetch("https://example.com")).toThrow("E2_PROOF_EGRESS_REFUSED");
    expect(() => new WebSocket("wss://example.com")).toThrow("E2_PROOF_EGRESS_REFUSED");
  } finally { restore(); }
  expect(process.env.HOME).toBe(before);
});
it("refuses paid proof entry before touching any path and parses only the bounded faux CLI", async () => {
  const err = [], out = [], io = { stdout: s => out.push(s), stderr: s => err.push(s) };
  expect(await main(["proofs", "--real", "--output", "fictional-path-canary"], io)).toBe(1);
  expect(err).toEqual(["E2_PAID_ENTRY_UNAVAILABLE\n"]); expect(out).toEqual([]);
  await expect(runE2Proofs({ real: true })).rejects.toThrow("E2_PAID_ENTRY_UNAVAILABLE");
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
