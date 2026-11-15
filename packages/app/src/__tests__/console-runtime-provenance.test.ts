import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/channel-operator";
import type { ChannelsControllerPort } from "../host/app-controller-channels.js";
import type { ChannelStatus } from "../channels/types.js";
import type { ValidateMonoAgentFolderOptions } from "../doctor/options.js";
import type { ValidationReport } from "../doctor/doctor-types.js";

/**
 * The full managed-closure verification re-hashes every installed file. Stand
 * it in with a counted, deliberately slow fake so the tests observe exactly how
 * often console-originated validations would pay for it.
 */
const SYNTHETIC_DETAIL = "Runtime provenance: managed closure synthetic-closure (synthetic fixture).";
const verifyClosure = vi.hoisted(() => vi.fn(async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return "Runtime provenance: managed closure synthetic-closure (synthetic fixture).";
}));
vi.mock("../provenance/runtime-provenance.js", () => ({ runtimeProvenanceDetail: verifyClosure }));

const roots: string[] = [];
beforeEach(() => {
  verifyClosure.mockClear();
  // Every test starts from a fresh process-lifetime memo.
  vi.resetModules();
});
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function agentFolder(): Promise<{ cwd: string; configPath: string; dotenvPath: string; env: Record<string, string | undefined> }> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "console-provenance-"))); roots.push(cwd);
  const configPath = join(cwd, "mono-agent.config.json");
  await writeFile(join(cwd, "IDENTITY.md"), "# Fictional Agent\n");
  await writeFile(configPath, JSON.stringify({
    runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" },
    tools: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
  }));
  return { cwd, configPath, dotenvPath: join(cwd, ".env"), env: {} };
}

describe("memoizeRuntimeProvenanceDetail", () => {
  it("shares one in-flight computation and keeps its result for the process", async () => {
    const { memoizeRuntimeProvenanceDetail } = await import("../provenance/process-runtime-provenance.js");
    let release!: (value: string) => void;
    const compute = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const memo = memoizeRuntimeProvenanceDetail(compute);
    const concurrent = [memo(), memo(), memo()];
    expect(compute).toHaveBeenCalledTimes(1);
    release("detail");
    await expect(Promise.all(concurrent)).resolves.toEqual(["detail", "detail", "detail"]);
    await expect(memo()).resolves.toBe("detail");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not retain a rejected computation", async () => {
    const { memoizeRuntimeProvenanceDetail } = await import("../provenance/process-runtime-provenance.js");
    const compute = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("detail");
    const memo = memoizeRuntimeProvenanceDetail(compute);
    await expect(memo()).rejects.toThrow("transient");
    await expect(memo()).resolves.toBe("detail");
    await expect(memo()).resolves.toBe("detail");
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe("console-originated validation", () => {
  it("verifies the runtime closure at most once across capability reads, an action save and a credential save", async () => {
    const { createCapabilityStatusService } = await import("../setup/capability-status.js");
    const { createCapabilityActionsService } = await import("../setup/capability-actions.js");
    const { createCredentialSetupService } = await import("../setup/credential-setup.js");
    const folder = await agentFolder();
    let now = Date.now();
    const status = createCapabilityStatusService(folder, { now: () => now });
    const actions = createCapabilityActionsService(folder);
    const credentials = createCredentialSetupService(folder);

    // Concurrent first use from every console surface still verifies once.
    const [first] = await Promise.all([status.read(), actions.read(), credentials.read()]);
    for (let read = 0; read < 3; read++) {
      now += 5_001; // Past the 5 s status cache: each read revalidates the folder.
      await status.read();
    }
    const preview = await actions.preview({ action: "memory-lite", process: first.process });
    expect(await actions.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true }))
      .toMatchObject({ changed: true });
    // A console save leaves an Undo backup, so this read revalidates the Undo candidate.
    expect((await actions.read()).actions.find((action) => action.id === "config-undo")).toMatchObject({ reason: "eligible" });
    const view = await credentials.read();
    await expect(credentials.save({
      card: "telegram", process: view.process, fence: view.fence, confirmed: true,
      fields: { bot: ["fictional", "bot", "value"].join("-"), allowedIds: "123" },
    })).resolves.toMatchObject({ outcome: "saved" });

    expect(JSON.parse(await readFile(folder.configPath, "utf8"))).toMatchObject({ memory: { mode: "lite" }, telegram: { enabled: true } });
    expect(verifyClosure).toHaveBeenCalledTimes(1);
  });

  it("hands the memoized detail to validation without changing the report shape", async () => {
    const { createCapabilityStatusService } = await import("../setup/capability-status.js");
    const { validateMonoAgentFolder } = await import("../doctor/doctor.js");
    const seen: ValidateMonoAgentFolderOptions[] = [];
    const reports: ValidationReport[] = [];
    let now = Date.now();
    const service = createCapabilityStatusService(await agentFolder(), {
      now: () => now,
      validate: async (options) => { seen.push(options); const report = await validateMonoAgentFolder(options); reports.push(report); return report; },
    });
    await service.read(); now += 5_001; await service.read();
    expect(seen.map((options) => options.verifiedRuntimeProvenanceDetail)).toEqual([SYNTHETIC_DETAIL, SYNTHETIC_DETAIL]);
    for (const report of reports) {
      expect(report.sections.find((section) => section.id === "runtime-provenance"))
        .toEqual({ id: "runtime-provenance", label: "Runtime provenance", status: "ok", details: [SYNTHETIC_DETAIL] });
    }
    expect(verifyClosure).toHaveBeenCalledTimes(1);
  });

  it("reuses a managed worker's launch-verified detail instead of re-verifying", async () => {
    const { startChannel } = await import("../host/app-controller-channels.js");
    const { createTuiChannelDriver } = await import("../channels/channels.js");
    const folder = await agentFolder();
    let captured: TuiAdapterOptions | undefined;
    const driver = createTuiChannelDriver({
      adapterFactory: async (options): Promise<TuiAdapterStartResult> => {
        captured = options;
        return { url: "http://127.0.0.1:0", baseUrl: "http://127.0.0.1:0/gui", infoUrl: "http://127.0.0.1:0/gui/v1/info", turnsUrl: "http://127.0.0.1:0/gui/v1/turns", host: "127.0.0.1", port: 0, stop: async () => undefined };
      },
      discoverModels: async () => [],
      discoverProviders: async () => [],
    });
    const statuses = new Map<string, ChannelStatus>();
    const controller: ChannelsControllerPort = {
      env: {}, cwd: folder.cwd, configReadPath: folder.configPath, configPath: folder.configPath, dotenvPath: folder.dotenvPath, logger: undefined,
      drivers: [driver], driversById: new Map([[driver.id, driver]]), statuses,
      running: new Map(), channelStartGenerations: new Map(), startsInFlight: new Map(),
      stopped: false, traceabilityStatusValue: {} as never, processJobsService: undefined, processJobsDegradation: undefined,
      verifiedRuntimeProvenanceDetail: "Runtime provenance: managed closure launch-verified (synthetic fixture).",
      setStatus(channelId, channelStatus) { statuses.set(channelId, channelStatus); return channelStatus; },
      rememberSelectedSkills: () => undefined, ensureInteractionBridge: async () => undefined, ensureContinuationService: async () => undefined,
      buildResponder: async () => ({ respond: async () => ({}) }),
      notifyDestination: async () => ({ delivered: false }), listNotifyDestinations: async () => [],
      observabilityContext: async () => ({}), refreshTraceSource: async () => undefined, activeTransports: () => [],
    };
    try {
      await expect(startChannel(controller, driver, "test")).resolves.toMatchObject({ kind: "running" });
      const snapshot = await captured!.capabilitySetup!.read();
      expect(snapshot.cards.length).toBeGreaterThan(0);
      const actions = captured!.capabilityActions!;
      const preview = await actions.preview({ action: "memory-lite", process: (await actions.read()).process });
      await expect(actions.save({ action: preview.action, process: preview.process, expectedVersion: preview.expectedVersion, confirmed: true }))
        .resolves.toMatchObject({ changed: true });
      const credentials = captured!.credentialSetup!;
      const view = await credentials.read();
      await expect(credentials.save({
        card: "openai-api", process: view.process, fence: view.fence, confirmed: true,
        fields: { bearer: ["fictional", "bearer", "value"].join("-") },
      })).resolves.toMatchObject({ outcome: "saved" });
      expect(verifyClosure).not.toHaveBeenCalled();
    } finally {
      await controller.running.get("tui")?.stop();
    }
  });

  it("keeps mono-agent validate verifying freshly on every run", async () => {
    const { runCli } = await import("../cli.js");
    const folder = await agentFolder();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      // The exit code reflects this fixture's readiness, not provenance; the count is the claim.
      await runCli(["validate", "--json", "--config", folder.configPath]);
      await runCli(["validate", "--json", "--config", folder.configPath]);
    } finally { stdout.mockRestore(); }
    expect(verifyClosure).toHaveBeenCalledTimes(2);
  });
});
