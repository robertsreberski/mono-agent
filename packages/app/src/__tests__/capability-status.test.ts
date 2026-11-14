import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityCards, aggregateCapabilityStatus, createCapabilityStatusService } from "../setup/capability-status.js";
import { createCapabilityActionsService } from "../setup/capability-actions.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import type { ValidationReport } from "../doctor/doctor-types.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "capability-status-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const report: ValidationReport = {
  sections: [{ id: "memory", label: "Memory", status: "waiting", details: ["private diagnostic must not cross the boundary"] },
    { id: "mcp", label: "MCP", status: "error", details: ["synthetic-secret"] },
    { id: "tools", label: "Tools", status: "waiting", details: [] }],
  ok: false, structurallyValid: false, operationallyReady: false,
};
async function fixture() {
  const configPath = join(root, "mono-agent.config.json");
  await writeFile(join(root, "IDENTITY.md"), "# Fictional Agent\n");
  await writeFile(configPath, JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" } }));
  return { configPath, cwd: root, env: {} };
}

describe("read-only capabilities", () => {
  it("aggregates explicit evidence without turning missing checks into success", () => {
    expect(aggregateCapabilityStatus([])).toBe("waiting");
    expect(aggregateCapabilityStatus([{ id: "a", status: "disabled" }])).toBe("disabled");
    expect(aggregateCapabilityStatus([{ id: "a", status: "waiting" }, { id: "b", status: "error" }])).toBe("error");
    const cards = capabilityCards(report, "journal");
    expect(cards).toHaveLength(9);
    expect(cards[0]?.selectedVariant).toBe("memory:journal");
    expect(cards[0]?.variants?.map((choice) => choice.status)).toEqual(["disabled", "waiting", "disabled"]);
    expect(cards.find((card) => card.id === "tools")?.status).toBe("error");
    expect(cards.find((card) => card.id === "tracing")?.status).toBe("waiting");
    expect(JSON.stringify(cards)).not.toMatch(/private diagnostic|synthetic-secret/);
  });
  it("keeps browser/story fixtures identical to the real catalog-derived guidance", async () => {
    const display = JSON.parse(await readFile(new URL("../../../web/webapp/src/test/capability-snapshot.fixture.json", import.meta.url), "utf8")) as Awaited<ReturnType<ReturnType<typeof createCapabilityStatusService>["read"]>>;
    const sections = new Map(display.cards.flatMap((card) => card.evidence.map((item) => [item.id, { ...item, label: item.id, details: [] }] as const)));
    expect(display.cards).toEqual(capabilityCards({ sections: [...sections.values()], ok: false, structurallyValid: false, operationallyReady: false }, "lite"));
  });
  it("drift-checks generated action metadata against the real app for the paired Lite/no-jobs display", async () => {
    const input = await fixture();
    await writeFile(input.configPath, JSON.stringify({ memory: { mode: "lite", path: "./.mono-agent/memory" } }));
    const actions = await createCapabilityActionsService(input, { loadedState: () => ({ memory: true, cron: false }) }).read();
    const display = JSON.parse(await readFile(new URL("../../../web/webapp/src/test/capability-actions.fixture.json", import.meta.url), "utf8")) as typeof actions;
    expect(display.actions).toEqual(actions.actions);
  });
  it("coalesces checks, caches briefly, and always overrides write permission", async () => {
    const input = await fixture();
    const validate = vi.fn(async () => report);
    let now = Date.now();
    const service = createCapabilityStatusService({ ...input, allowFilesystemWrites: true, liveness: true, subprocessProbes: true }, { validate, now: () => now });
    const [one, two] = await Promise.all([service.read(), service.read()]);
    expect(one).toBe(two);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ allowFilesystemWrites: false, liveness: false, subprocessProbes: false }));
    expect(one.hostPreflight).toBeUndefined();
    await service.read();
    expect(validate).toHaveBeenCalledTimes(1);
    now += 5001;
    await service.read();
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it("negatively caches sanitized failures for five seconds, then recovers", async () => {
    const input = await fixture();
    let now = Date.now();
    const validate = vi.fn().mockRejectedValueOnce(new Error("synthetic-private-path-and-key")).mockResolvedValue(report);
    const service = createCapabilityStatusService(input, { validate, now: () => now });
    for (let i = 0; i < 3; i++) await expect(service.read()).rejects.toThrow("Capability validation unavailable. Run mono-agent validate.");
    expect(validate).toHaveBeenCalledTimes(1);
    now += 5001;
    await expect(service.read()).resolves.toMatchObject({ version: 1 });
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it("bounds callers without starting replacement work when a validator hangs", async () => {
    const validate = vi.fn(() => new Promise<ValidationReport>(() => {}));
    const service = createCapabilityStatusService(await fixture(), { validate, timeoutMs: 10 });
    await expect(service.read()).rejects.toThrow("timed out");
    await expect(service.read()).rejects.toThrow("timed out");
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("rejects edited inputs and projects host evidence only when supplied", async () => {
    const input = await fixture();
    const service = createCapabilityStatusService(input, { validate: async () => {
      await writeFile(input.configPath, "{}"); return report;
    } });
    await expect(service.read()).rejects.toThrow("Capability validation unavailable");
    const projected = await createCapabilityStatusService(await fixture(), {
      validate: async () => report,
      hostPreflight: () => ({ schemaVersion: 1, operation: "host-preflight", checks: [{ id: "runtime.node", status: "ok" }] }),
    }).read();
    expect(projected.hostPreflight?.checks).toEqual([{ id: "runtime.node", status: "ok" }]);
    const loaded = await createCapabilityStatusService({ ...await fixture(), privateRuntimePaths: { identityPath: join(root, "IDENTITY.md") } }, { validate: async () => report }).read();
    expect(loaded.observation).toBe("loaded-snapshot");
    expect(projected.observation).toBe("durable-inputs");
  });
  it("built capability reads make zero network calls or child_process calls, including computer use and native sandbox", async () => {
    const input = await fixture();
    await writeFile(input.configPath, JSON.stringify({
      runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" },
      tools: { allowedTools: ["Read"], computerUse: { backend: "cua-driver", command: process.execPath },
        web: { search: { backend: "searxng", searxng: { endpoint: "http://127.0.0.1:9/search" } } } },
      sandbox: { mode: "native", fallback: "fail-closed" },
    }));
    // Fresh Node import is intentional: promisified execFile and cross-package
    // SRT bindings must capture the spies, not pre-imported uninstrumented builtins.
    const program = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const cp = createRequire(import.meta.url)('node:child_process');
      const calls = {};
      for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
        calls[name] = 0;
        cp[name] = () => { calls[name]++; throw new Error('Unexpected child_process call'); };
      }
      syncBuiltinESMExports();
      let networkCalls = 0;
      globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network probe'); };
      const [moduleUrl, configPath, cwd] = process.argv.slice(1);
      process.env.HOME = cwd; process.env.XDG_CONFIG_HOME = cwd;
      const { createCapabilityStatusService } = await import(moduleUrl);
      const { validateMonoAgentFolder } = await import(new URL('../doctor/doctor.js', moduleUrl));
      const input = { configPath, cwd, env: { PATH: process.env.PATH, HOME: cwd }, allowFilesystemWrites: false, liveness: false, subprocessProbes: false };
      const doctor = await validateMonoAgentFolder(input);
      const service = createCapabilityStatusService({ ...input, subprocessProbes: true });
      const snapshot = await service.read(); await service.read();
      console.log(JSON.stringify({ calls, networkCalls,
        core: doctor.sections.find(s => s.id === 'core').status,
        computer: doctor.sections.find(s => s.id === 'computer-use'),
        sandbox: doctor.sections.find(s => s.id === 'sandbox'),
        tools: snapshot.cards.find(c => c.id === 'tools') }));
    `;
    const moduleUrl = new URL("../../dist/setup/capability-status.js", import.meta.url).href;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", program, moduleUrl, input.configPath, root], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 30_000,
    });
    const proof = JSON.parse(result.stdout);
    expect(proof.core).toBe("ok"); // Not a false zero caused by rejected config.
    expect(proof.networkCalls).toBe(0);
    expect(Object.values(proof.calls)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    for (const section of [proof.computer, proof.sandbox]) {
      expect(section.status).toBe("waiting");
      expect(section.details.join(" ")).toContain("not probed here");
      expect(section.details.join(" ")).toContain("mono-agent validate");
    }
    expect(proof.tools.evidence).toContainEqual({ id: "computer-use", status: "waiting" });
    expect(proof.tools.status).toBe("waiting");
  });
  it("matches real doctor evidence for every card and keeps configured files unchanged", async () => {
    const input = await fixture();
    const before = await readFile(input.configPath);
    const doctor = await validateMonoAgentFolder({ ...input, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
    const snapshot = await createCapabilityStatusService(input).read();
    for (const card of snapshot.cards) {
      for (const evidence of card.evidence) {
        expect(evidence.status).toBe(doctor.sections.find((section) => section.id === evidence.id)?.status);
      }
      expect(card.status).toBe(aggregateCapabilityStatus(card.evidence));
    }
    expect(doctor.sections.find((section) => section.id === "mcp")?.status).toBe("disabled");
    expect(doctor.sections.find((section) => section.id === "observability")?.status).toBe("ok");
    expect(await readFile(input.configPath)).toEqual(before);
  });
});
