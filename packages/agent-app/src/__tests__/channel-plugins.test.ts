import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMonoAgentApp } from "../app.js";
import { collectChannelConfigViews } from "../channel-config-view.js";
import { resolveChannelDrivers } from "../channels.js";
import type { ChannelDriver } from "../channels.js";
import { validateMonoAgentFolder } from "../doctor.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-channel-plugins-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify(json, null, 2), "utf8");
  return configPath;
}

function baseConfig(): Record<string, unknown> {
  return {
    runtime: { model: "pi:openai-codex:gpt-5.5" },
    context: { identityPath: "./IDENTITY.md" },
    tools: { allowedTools: [], disallowedTools: [] },
    traceability: { registryDir: "./trace-sources", sourceId: "plugin-test" },
    tui: { enabled: false },
    live: { enabled: false },
  };
}

function sectionById(report: Awaited<ReturnType<typeof validateMonoAgentFolder>>, id: string) {
  const section = report.sections.find((candidate) => candidate.id === id);
  expect(section, `section ${id}`).toBeDefined();
  return section!;
}

describe("channel plugins", () => {
  it("loads an explicit workspace plugin for validate, config view, and start status", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      channels: {
        plugins: [
          {
            package: "@mono-agent/a2a-adapter",
            id: "a2a-extra",
            label: "A2A Extra",
            config: { provider: { enabled: false } },
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const validation = sectionById(report, "channel:a2a-extra");
    expect(validation).toMatchObject({
      label: "A2A Extra",
      status: "disabled",
      details: ["A2A provider is disabled."],
    });

    const drivers = await resolveChannelDrivers({ env: {}, cwd: dir, configPath });
    const views = await collectChannelConfigViews(drivers, { env: {}, cwd: dir, configPath });
    const view = views.find((section) => section.id === "a2a-extra");
    expect(view?.label).toBe("A2A Extra");
    expect(view?.fields.some((field) => field.id === "a2a.provider.enabled")).toBe(true);

    const app = await startMonoAgentApp({ cwd: dir, env: {} });
    expect(app.channelStatus("a2a-extra")).toEqual({
      kind: "disabled",
      reason: "A2A provider is disabled.",
    });
    await app.stop();
  });

  it("reports a missing plugin package as waiting instead of crashing validate or start", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      channels: {
        plugins: [
          {
            package: "@mono-agent/not-installed-channel-plugin",
            id: "missing-plugin",
            label: "Missing Plugin",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const validation = sectionById(report, "channel:missing-plugin");
    expect(validation.status).toBe("waiting");
    expect(validation.details.join("\n")).toContain("Cannot load channel plugin @mono-agent/not-installed-channel-plugin");

    const app = await startMonoAgentApp({ cwd: dir, env: {} });
    expect(app.channelStatus("missing-plugin").kind).toBe("waiting_for_config");
    await app.stop();
  });

  it("reports a malformed plugin export as waiting instead of crashing validate", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      channels: {
        plugins: [
          {
            package: "@mono-agent/agent-contracts",
            id: "bad-plugin",
            label: "Bad Plugin",
          },
        ],
      },
    });

    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    const validation = sectionById(report, "channel:bad-plugin");
    expect(validation.status).toBe("waiting");
    expect(validation.details.join("\n")).toContain("must export createChannelDriver(options)");
  });

  it("delegates legacy top-level A2A config through the external package seam", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      a2a: { provider: { enabled: false } },
    });

    const drivers = await resolveChannelDrivers({ env: {}, cwd: dir, configPath });
    const views = await collectChannelConfigViews(drivers, { env: {}, cwd: dir, configPath });
    const a2a = views.find((section) => section.id === "a2a");

    expect(a2a?.fields.some((field) => field.id === "a2a.provider.enabled")).toBe(true);
    const report = await validateMonoAgentFolder({ env: {}, cwd: dir, configPath, liveness: false });
    expect(sectionById(report, "channel:a2a").status).toBe("disabled");
  });

  it("respects an explicit drivers override without appending config plugins", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      channels: {
        plugins: [
          {
            package: "@mono-agent/not-installed-channel-plugin",
            id: "missing-plugin",
          },
        ],
      },
    });
    const driver: ChannelDriver = {
      id: "only",
      label: "Only",
      async loadConfig() {
        return {};
      },
      isConfigError() {
        return false;
      },
      disabledReason() {
        return "Only is disabled.";
      },
      async start() {
        return { summary: {}, stop: async () => undefined };
      },
    };

    const report = await validateMonoAgentFolder({
      env: {},
      cwd: dir,
      configPath,
      liveness: false,
      drivers: [driver],
    });
    expect(report.sections.some((section) => section.id === "channel:missing-plugin")).toBe(false);
    expect(sectionById(report, "channel:only").status).toBe("disabled");

    const app = await startMonoAgentApp({ cwd: dir, env: {}, drivers: [driver] });
    expect([...app.channelStatuses().keys()]).toEqual(["only"]);
    expect(app.channelStatus("missing-plugin")).toEqual({
      kind: "disabled",
      reason: "Channel missing-plugin is not registered with this app.",
    });
    await app.stop();
  });
});
