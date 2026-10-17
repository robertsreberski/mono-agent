import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelDriver } from "../channels/types.js";
import type { ValidationSection, ValidationStatus } from "../doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "../doctor/options.js";

const state = vi.hoisted(() => ({
  calls: [] as string[],
  denied: undefined as string | undefined,
  coreFailure: false,
  section(id: string): ValidationSection {
    this.calls.push(id);
    return {
      id,
      label: `Label ${id}`,
      status: this.denied === id ? "error" : "ok",
      details: [`First ${id}.`, `Second ${id}.`],
    };
  },
}));

vi.mock("../composition/app-config.js", () => ({
  loadAppCoreConfig: async () => {
    if (state.coreFailure) throw new Error("Core access denied.");
    return { runtime: { session: { root: "unused" } }, artifacts: { dir: "/fixture/artifacts" }, tools: { allowedTools: [], disallowedTools: [] } };
  },
  isAppCoreConfigError: () => true,
}));
vi.mock("../conversation-admin/sessions-root.js", () => ({ assertSupportedSessionsRoot: async () => undefined }));
vi.mock("@mono-agent/config", async (original) => ({
  ...await original<typeof import("@mono-agent/config")>(),
  readMonoAgentConfigJson: async () => ({ json: {} }),
  buildMonoAgentConfigView: () => [],
  redactMonoAgentConfig: () => ({}),
  findJsonSecretConfigWarnings: () => ["Config warning."],
  findRemovedConfigWarnings: () => [],
}));
vi.mock("@mono-agent/contracts", async (original) => ({
  ...await original<typeof import("@mono-agent/contracts")>(),
  readSettingsJson: async () => ({ duplicateKeyPaths: ["runtime.model"] }),
}));
vi.mock("../channel-config-view.js", () => ({ collectChannelConfigViews: async () => [] }));
vi.mock("../doctor/cross-checks.js", () => ({
  collectStaticTriggerCredentialRefs: async () => [],
  applyRequestModelOverrideCompatibilityChecks: async () => { state.calls.push("model-cross-check"); },
  applyToolChannelCrossChecks: () => { state.calls.push("tool-cross-check"); },
}));
vi.mock("../doctor/runtime.js", () => ({
  runtimeProvenanceSection: async () => state.section("runtime-provenance"),
  runtimeSection: () => state.section("runtime"),
}));
vi.mock("../doctor/credentials.js", () => ({ credentialsSection: async () => state.section("credentials") }));
vi.mock("../doctor/context.js", () => ({ contextSection: async () => state.section("context") }));
vi.mock("../doctor/memory.js", () => ({ memorySection: vi.fn(async () => state.section("memory")) }));
vi.mock("../doctor/tools.js", () => ({ toolsSection: async () => state.section("tools") }));
vi.mock("../host/computer-use.js", () => ({ computerUseSection: async () => state.section("computer-use") }));
vi.mock("../doctor-session-history.js", () => ({ sessionToolHistorySection: async () => state.section("session-history") }));
vi.mock("../doctor/web-tools.js", () => ({ webToolsSection: vi.fn(async () => state.section("web-tools")) }));
vi.mock("../continuation-config.js", () => ({
  loadContinuationSettings: async () => { state.calls.push("continuations"); throw new Error("Continuation access denied."); },
}));
vi.mock("../process-jobs-config.js", async (original) => ({
  ...await original<typeof import("../process-jobs-config.js")>(),
  loadProcessJobsSettings: async () => { state.calls.push("process-jobs"); throw new Error("Job access denied."); },
}));
vi.mock("../doctor/sandbox.js", () => ({ sandboxSection: async () => state.section("sandbox") }));
vi.mock("../doctor-runs.js", () => ({ runsSection: async () => state.section("runs") }));
vi.mock("../doctor/launchd-logs.js", () => ({ launchdLogsSection: async () => state.section("launchd-logs") }));
vi.mock("../doctor/channels.js", () => ({ channelSection: async () => state.section("channel:fixture") }));

import { validateMonoAgentFolder } from "../doctor.js";
import { memorySection } from "../doctor/memory.js";
import { webToolsSection } from "../doctor/web-tools.js";

const drivers: readonly ChannelDriver[] = [{
  id: "fixture",
  label: "Fixture",
  loadConfig: async () => ({}),
  isConfigError: (_error): _error is Error => false,
  start: async () => { throw new Error("Validation must not start a channel."); },
}];
const input = { cwd: "/fixture", configPath: "/fixture/config.json", env: {}, drivers, liveness: false, allowFilesystemWrites: false };
const ordered = [
  "runtime-provenance", "runtime", "credentials", "context", "memory", "tools", "computer-use",
  "session-history", "web-tools", "continuations", "process-jobs", "sandbox", "runs", "launchd-logs", "channel:fixture",
];

beforeEach(() => {
  vi.clearAllMocks();
  state.calls = [];
  state.denied = undefined;
  state.coreFailure = false;
});

function expectedSection(id: string): ValidationSection {
  if (id === "continuations") return {
    id, label: "Durable continuations", status: "error", details: ["Continuation configuration is invalid: Continuation access denied."],
  };
  if (id === "process-jobs") return {
    id, label: "Background process jobs", status: "error", details: ["Process-job configuration is invalid: Job access denied."],
  };
  return {
    id, label: `Label ${id}`, status: state.denied === id ? "error" : "ok", details: [`First ${id}.`, `Second ${id}.`],
  };
}

describe("doctor section aggregation contract", () => {
  it("defaults liveness and filesystem writes to true only when omitted", async () => {
    await validateMonoAgentFolder({ cwd: input.cwd, configPath: input.configPath, env: input.env, drivers });
    expect(vi.mocked(memorySection).mock.calls[0]?.slice(3)).toEqual([true, true]);
    expect(vi.mocked(webToolsSection).mock.calls[0]?.[2]).toBe(true);

    await validateMonoAgentFolder(input);
    expect(vi.mocked(memorySection).mock.calls[1]?.slice(3)).toEqual([false, false]);
    expect(vi.mocked(webToolsSection).mock.calls[1]?.[2]).toBe(false);
  });

  it("retains complete section output, duplicate/warning order and final cross-check order", async () => {
    const report = await validateMonoAgentFolder(input);
    expect(report).toEqual({
      sections: [
        { id: "core", label: "Core config", status: "error", details: ["Loaded /fixture/config.json.", "Duplicate JSON key: runtime.model (last value wins at runtime)."] },
        expectedSection("runtime-provenance"),
        { id: "secret-placement", label: "Config warnings", status: "waiting", details: ["Config warning."] },
        ...ordered.slice(1).map(expectedSection),
      ],
      structurallyValid: false,
      operationallyReady: false,
      ok: false,
    });
    expect(state.calls).toEqual([...ordered, "model-cross-check", "tool-cross-check"]);
  });

  it.each(["credentials", "tools", "web-tools", "context", "memory", "sandbox", "channel:fixture", "runs"])(
    "retains the exact mocked error %s section without dropping or reordering later checks",
    async (id) => {
      state.denied = id;
      const report = await validateMonoAgentFolder({ ...input, ignoreDuplicateKeys: true });
      expect(report.sections.slice(3)).toEqual(ordered.slice(1).map(expectedSection));
      expect(report.sections.find((section) => section.id === id)).toEqual(expectedSection(id));
      expect(state.calls).toEqual([...ordered, "model-cross-check", "tool-cross-check"]);
    },
  );

  it("continues provenance, runs, logs and channels after core access fails", async () => {
    state.coreFailure = true;
    const report = await validateMonoAgentFolder({ ...input, ignoreDuplicateKeys: true });
    expect(report).toEqual({
      sections: [
        { id: "core", label: "Core config", status: "error", details: ["Core access denied."] },
        ...["runtime-provenance", "runs", "launchd-logs", "channel:fixture"].map(expectedSection),
      ],
      structurallyValid: false,
      operationallyReady: false,
      ok: false,
    });
    expect(state.calls).toEqual(["runtime-provenance", "runs", "launchd-logs", "channel:fixture"]);
  });
});

// The published report still exposes readonly sections, details and status unions.
function reportTypes(section: ValidationSection, options: ValidateMonoAgentFolderOptions): void {
  // @ts-expect-error validation options stay readonly
  options.liveness = false;
  // @ts-expect-error credential proof refs stay readonly
  options.verifiedCredentialModelRefs?.push("not allowed");
  // @ts-expect-error explicit undefined is not a valid optional flag value
  const invalid: ValidateMonoAgentFolderOptions = { ...options, liveness: undefined };
  void invalid;
  // @ts-expect-error section details are readonly
  section.details.push("not allowed");
  // @ts-expect-error status is not an arbitrary string
  const status: ValidationStatus = "denied";
  void status;
}
void reportTypes;
