import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { startMonoAgentApp } from "../app.js";
import type { ChannelDriver } from "../channels.js";
import {
  SELF_CAPABILITIES_MCP_SERVER_NAME,
  applySelfCron,
  applySelfSkill,
  createSelfCapabilitiesRuntimeExtension,
  proposeSelfCron,
  proposeSelfSkill,
  readSelfCapabilitiesReloadToken,
  resolveSelfCapabilitiesSettings,
  selfCapabilityConfirmationToken,
  selfCapabilitiesFieldGroup,
  selfCapabilitiesMcpEnv,
  selfCapabilitiesSettingsFromEnv,
} from "../self-capabilities.js";
import type { SelfCapabilitiesSettings } from "../self-capabilities.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-self-capabilities-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\nTest agent.\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("self capability authoring", () => {
  it("creates a skill, activates it in JSON config, writes audit, and requests reload", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });
    const now = () => new Date("2026-06-16T10:00:00.000Z");

    const result = await applySelfSkill(settings, {
      name: "Daily Reflection",
      description: "Reflect on recent conversations and update local context.",
      instructions: "Review the newest conversation and append durable observations.",
    }, { now });

    expect(result).toMatchObject({
      kind: "skill",
      id: "daily-reflection",
      action: "created",
      reloadRequired: true,
    });
    const skill = await readFile(join(dir, "skills", "daily-reflection", "SKILL.md"), "utf8");
    expect(skill).toContain("Reflect on recent conversations");
    expect(skill).toContain("## Instructions");

    const config = await readJson(configPath);
    expect(config.context).toMatchObject({
      identityPath: "./IDENTITY.md",
      skillsRoot: "./skills",
      selectedSkills: ["daily-reflection"],
    });
    expect(await readFile(result.auditPath, "utf8")).toContain("daily-reflection");
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).not.toBe("");
  });

  it("keeps write tools guarded behind apply mode", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "propose" } }));
    const settings = await settingsFromConfig(configPath, { mode: "propose" });

    const proposal = await proposeSelfSkill(settings, {
      name: "Research Notes",
      description: "Collect source-grounded notes before answering.",
      instructions: "Search local project notes first and cite the exact files used.",
    });
    expect(proposal.action).toBe("proposed");
    expect(proposal.reloadRequired).toBe(false);
    expect(proposal.proposalId).toMatch(/research-notes/u);
    expect(proposal.proposalPath).toBe(join(dir, ".mono-agent", "self-capabilities", "proposals", `${proposal.proposalId}.json`));
    expect(proposal.preview).toContain("Collect source-grounded notes");
    const savedProposal = await readJson(proposal.proposalPath!);
    expect(savedProposal).toMatchObject({
      kind: "skill",
      id: "research-notes",
      proposalId: proposal.proposalId,
      reloadRequired: false,
    });
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).toBe("");

    await expect(applySelfSkill(settings, {
      name: "Research Notes",
      description: "Collect source-grounded notes before answering.",
      instructions: "Search local project notes first and cite the exact files used.",
    })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(readFile(join(dir, "skills", "research-notes", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies persisted skill proposals by id and links audit/reload records", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });
    const proposal = await proposeSelfSkill(settings, {
      name: "Follow Up",
      description: "Track promised follow-ups after conversations.",
      instructions: "Review the latest turn and capture any promised follow-up.",
    }, { now: () => new Date("2026-06-16T10:00:00.000Z") });

    expect(proposal.proposalId).toMatch(/^2026-06-16t10-00-00-000z-skill-follow-up-[a-f0-9]{12}$/u);
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).toBe("");

    const result = await applySelfSkill(settings, {
      proposalId: proposal.proposalId!,
    }, { now: () => new Date("2026-06-16T10:01:00.000Z") });

    expect(result).toMatchObject({
      kind: "skill",
      id: "follow-up",
      action: "created",
      proposalId: proposal.proposalId,
      proposalPath: proposal.proposalPath,
      reloadRequired: true,
    });
    expect(await readFile(join(dir, "skills", "follow-up", "SKILL.md"), "utf8")).toContain("Track promised follow-ups");
    const audit = await readJson(result.auditPath);
    expect(audit).toMatchObject({
      kind: "skill",
      id: "follow-up",
      proposalId: proposal.proposalId,
      proposalPath: proposal.proposalPath,
    });
    const reloadLog = await readFile(join(settings.auditDir, "reload-requests.jsonl"), "utf8");
    expect(reloadLog).toContain(`"proposalId":"${proposal.proposalId}"`);
  });

  it("applies persisted cron proposals by id", async () => {
    const configPath = await writeConfig(baseConfig({
      selfCapabilities: { enabled: true, mode: "apply", cronDir: "./custom-cron" },
    }));
    const settings = await settingsFromConfig(configPath, { mode: "apply", cronDir: join(dir, "custom-cron") });
    const proposal = await proposeSelfCron(settings, {
      id: "Daily Digest",
      expression: "0 8 * * *",
      timezone: "Europe/Rome",
      prompt: "Prepare the daily digest.",
    }, { now: () => new Date("2026-06-16T10:00:00.000Z") });

    expect(proposal).toMatchObject({
      kind: "cron",
      id: "daily-digest",
      reloadRequired: false,
    });
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).toBe("");

    const result = await applySelfCron(settings, {
      proposalId: proposal.proposalId!,
    }, { now: () => new Date("2026-06-16T10:01:00.000Z") });

    expect(result).toMatchObject({
      kind: "cron",
      id: "daily-digest",
      proposalId: proposal.proposalId,
      proposalPath: proposal.proposalPath,
    });
    const job = await readFile(join(dir, "custom-cron", "daily-digest.md"), "utf8");
    expect(job).toContain("expression: 0 8 * * *");
    expect(job).toContain("Prepare the daily digest.");
    expect((await readJson(result.auditPath)).proposalId).toBe(proposal.proposalId);
  });

  it("rejects malformed, missing, wrong-kind, and tampered proposal ids before writing", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });
    const cronProposal = await proposeSelfCron(settings, {
      id: "Daily Digest",
      expression: "0 8 * * *",
      prompt: "Prepare the daily digest.",
    });

    await expect(applySelfSkill(settings, { proposalId: "../daily-digest" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(applySelfSkill(settings, { proposalId: "2026-missing-skill" })).rejects.toMatchObject({ code: "not_found" });
    await expect(applySelfSkill(settings, { proposalId: cronProposal.proposalId! })).rejects.toMatchObject({ code: "invalid_input" });

    const skillProposal = await proposeSelfSkill(settings, {
      name: "Research Notes",
      description: "Collect source-grounded notes before answering.",
      instructions: "Search local project notes first and cite the exact files used.",
    });
    const savedProposal = await readJson(skillProposal.proposalPath!);
    const tampered = {
      ...savedProposal,
      input: {
        ...(savedProposal.input as Record<string, unknown>),
        instructions: "A changed instruction should not apply under the same proposal id.",
      },
    };
    await writeFile(skillProposal.proposalPath!, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await expect(applySelfSkill(settings, { proposalId: skillProposal.proposalId! })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readFile(join(dir, "skills", "research-notes", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).toBe("");
  });

  it("rejects applying saved proposals when current write targets drift", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });
    const proposal = await proposeSelfSkill(settings, {
      name: "Research Notes",
      description: "Collect source-grounded notes before answering.",
      instructions: "Search local project notes first and cite the exact files used.",
    });

    const driftedSettings = { ...settings, skillsRoot: join(dir, "other-skills") };
    await expect(applySelfSkill(driftedSettings, { proposalId: proposal.proposalId! })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readFile(join(dir, "other-skills", "research-notes", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).toBe("");
  });

  it("keeps same-millisecond proposal collision ids applyable", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });
    const input = {
      name: "Research Notes",
      description: "Collect source-grounded notes before answering.",
      instructions: "Search local project notes first and cite the exact files used.",
    };
    const now = () => new Date("2026-06-16T10:00:00.000Z");

    const first = await proposeSelfSkill(settings, input, { now });
    const second = await proposeSelfSkill(settings, input, { now });

    expect(first.proposalId).not.toBe(second.proposalId);
    expect(second.proposalId).toMatch(/-2-[a-f0-9]{12}$/u);
    const result = await applySelfSkill(settings, { proposalId: second.proposalId! }, {
      now: () => new Date("2026-06-16T10:01:00.000Z"),
    });
    expect(result.proposalId).toBe(second.proposalId);
    expect(await readFile(join(dir, "skills", "research-notes", "SKILL.md"), "utf8")).toContain("Collect source-grounded notes");
  });

  it("creates markdown cron jobs and validates the schedule before writing", async () => {
    const configPath = await writeConfig(baseConfig({
      selfCapabilities: { enabled: true, mode: "apply", cronDir: "./custom-cron" },
    }));
    const settings = await settingsFromConfig(configPath, { mode: "apply", cronDir: join(dir, "custom-cron") });

    const result = await applySelfCron(settings, {
      id: "Daily Digest",
      expression: "0 8 * * *",
      timezone: "Europe/Rome",
      prompt: "Prepare the daily digest.",
    }, { now: () => new Date("2026-06-16T10:00:00.000Z") });

    expect(result.files).toEqual([join(dir, "custom-cron", "daily-digest.md")]);
    const job = await readFile(join(dir, "custom-cron", "daily-digest.md"), "utf8");
    expect(job).toContain("expression: 0 8 * * *");
    expect(job).toContain("Prepare the daily digest.");
    expect((await readJson(configPath)).cron).toEqual({ dir: "./custom-cron" });

    await expect(applySelfCron(settings, {
      id: "Broken",
      expression: "0 8 * *",
      prompt: "Broken.",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readFile(join(dir, "custom-cron", "broken.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses global env roots before JSON self-capability roots", async () => {
    const configPath = await writeConfig(baseConfig({
      selfCapabilities: {
        enabled: true,
        mode: "apply",
        skillsRoot: "./json-skills",
        cronDir: "./json-cron",
      },
      cron: { dir: "./cron-json" },
    }));

    const settings = await resolveSelfCapabilitiesSettings(
      {
        env: {
          MONO_AGENT_SKILLS_ROOT: "./env-skills",
          MONO_AGENT_CRON_DIR: "./env-cron",
          MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN: "confirm-me",
        },
        cwd: dir,
        configPath,
      },
      coreConfig({ skillsRoot: join(dir, "env-skills") }),
    );

    expect(settings.skillsRoot).toBe(join(dir, "env-skills"));
    expect(settings.cronDir).toBe(join(dir, "env-cron"));
    expect(settings.confirmationToken).toBe("confirm-me");
    expect(selfCapabilitiesMcpEnv(settings).MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN).toBe("confirm-me");
    expect(selfCapabilityConfirmationToken(settings, "proposal-1")).toMatch(/^[a-f0-9]{64}$/u);
    expect(selfCapabilityConfirmationToken(settings, "proposal-1")).not.toBe("confirm-me");
  });

  it("rejects newline injection in cron frontmatter scalars", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });

    await expect(applySelfCron(settings, {
      id: "Injected",
      expression: "0 8 * * *",
      timezone: "UTC\nexpression: * * * * *",
      prompt: "Should not write.",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readFile(join(dir, "cron", "injected.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked write roots before creating files", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dir, "skills"), "dir");
    const settings = await settingsFromConfig(configPath, { mode: "apply" });

    await expect(applySelfSkill(settings, {
      name: "Escaping Skill",
      description: "Attempt to write through a symlink.",
      instructions: "This should fail before writing.",
    })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(readFile(join(outside, "escaping-skill", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked audit folders before creating capability files", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const outside = join(dir, "outside-audit");
    await mkdir(outside, { recursive: true });
    await mkdir(join(dir, ".mono-agent", "self-capabilities"), { recursive: true });
    await symlink(outside, join(dir, ".mono-agent", "self-capabilities", "audit"), "dir");
    const settings = await settingsFromConfig(configPath, { mode: "apply" });

    await expect(applySelfSkill(settings, {
      name: "Audit Escape",
      description: "Attempt to write through a symlinked audit folder.",
      instructions: "This should fail before writing the skill.",
    })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(readFile(join(dir, "skills", "audit-escape", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readSelfCapabilitiesReloadToken(settings.auditDir)).toBe("");
  });

  it("reports cron env overrides and rejects direct MCP env paths outside the agent folder", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply", cronDirEnvOverride: true });

    const proposal = await proposeSelfCron(settings, {
      id: "Env Cron",
      expression: "0 9 * * *",
      prompt: "Check whether env overrides still apply.",
    });
    expect(proposal.warnings).toContain("MONO_AGENT_CRON_DIR is set; it will override cron.dir in JSON.");

    expect(() => selfCapabilitiesSettingsFromEnv({
      MONO_AGENT_SELF_CAPABILITIES_CWD: dir,
      MONO_AGENT_SELF_CAPABILITIES_CONFIG_PATH: join(dir, "mono-agent.config.json"),
      MONO_AGENT_SELF_CAPABILITIES_MODE: "apply",
      MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT: join(dir, "skills"),
      MONO_AGENT_SELF_CAPABILITIES_CRON_DIR: "../cron",
      MONO_AGENT_SELF_CAPABILITIES_AUDIT_DIR: join(dir, ".mono-agent", "self-capabilities"),
    })).toThrowError(expect.objectContaining({ code: "invalid_config" }));
  });

  it("notifies the app reload extension when a self-capability write occurs during the run", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const settings = await settingsFromConfig(configPath, { mode: "apply" });
    const reloads: string[] = [];
    const extensionFactory = createSelfCapabilitiesRuntimeExtension(settings, (token) => {
      reloads.push(token);
    });
    const extension = await extensionFactory();
    const server = extension.runtimeOptions.mcpServers[SELF_CAPABILITIES_MCP_SERVER_NAME] as { env: Record<string, string> };
    const mcpSettings = selfCapabilitiesSettingsFromEnv(server.env);

    const proposal = await proposeSelfSkill(mcpSettings, {
      name: "Follow Up",
      description: "Track promised follow-ups after conversations.",
      instructions: "Review the latest turn and capture any promised follow-up.",
    }, { now: () => new Date("2026-06-16T10:00:00.000Z") });
    await applySelfSkill(mcpSettings, {
      proposalId: proposal.proposalId!,
    }, { now: () => new Date("2026-06-16T10:01:00.000Z") });
    await extension.cleanup();

    expect(reloads).toHaveLength(1);
    expect(extension.runtimeOptions.mcpServers[SELF_CAPABILITIES_MCP_SERVER_NAME]).toMatchObject({
      type: "stdio",
      command: process.execPath,
    });
  });

  it("ignores reload records without the current request nonce", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "propose" } }));
    const settings = await settingsFromConfig(configPath, { mode: "propose" });
    const reloads: string[] = [];
    const extensionFactory = createSelfCapabilitiesRuntimeExtension(settings, (token) => {
      reloads.push(token);
    });
    const extension = await extensionFactory();

    await mkdir(join(dir, ".mono-agent", "self-capabilities"), { recursive: true });
    await writeFile(
      join(dir, ".mono-agent", "self-capabilities", "reload-requests.jsonl"),
      `${JSON.stringify({ kind: "skill", id: "x", proposalId: "proposal-x", reloadNonce: "wrong-nonce" })}\n`,
      { flag: "a" },
    );
    await extension.cleanup();

    expect(reloads).toEqual([]);
  });

  it("injects the self-capability MCP server into app-served runtime requests only when enabled", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "propose" } }));
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    let responder: AgentResponder | undefined;
    const driver: ChannelDriver = {
      id: "webhook",
      label: "Test",
      async loadConfig() {
        return { enabled: true };
      },
      isConfigError() {
        return false;
      },
      async start(input) {
        responder = input.responder;
        return { summary: {}, stop: async () => undefined };
      },
    };

    const app = await startMonoAgentApp({
      cwd: dir,
      configPath,
      env: {},
      operatorConsole: false,
      drivers: [driver],
      runtime: fake.runtime,
    });
    await responder?.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => undefined },
    );

    const server = fake.calls[0]?.options.mcpServers?.[SELF_CAPABILITIES_MCP_SERVER_NAME] as Record<string, unknown> | undefined;
    expect(server).toMatchObject({ type: "stdio", command: process.execPath, cwd: dir });
    expect(server?.env).toMatchObject({
      MONO_AGENT_SELF_CAPABILITIES_MODE: "propose",
      MONO_AGENT_SELF_CAPABILITIES_CONFIG_PATH: configPath,
    });
    await app.stop();
  });

  it("does not enforce self-capability local path rules when the feature is disabled", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-app-outside-config-"));
    try {
      const configPath = join(outside, "mono-agent.config.json");
      await writeFile(configPath, `${JSON.stringify(baseConfig({ selfCapabilities: { enabled: false } }), null, 2)}\n`, "utf8");
      const fake = createFakeRuntime(async () => ({ text: "ok" }));
      const driver: ChannelDriver = {
        id: "webhook",
        label: "Test",
        async loadConfig() {
          return { enabled: true };
        },
        isConfigError() {
          return false;
        },
        async start() {
          return { summary: {}, stop: async () => undefined };
        },
      };

      const app = await startMonoAgentApp({
        cwd: dir,
        configPath,
        env: {},
        operatorConsole: false,
        drivers: [driver],
        runtime: fake.runtime,
      });
      expect(app.channelStatus("webhook").kind).toBe("running");
      await app.stop();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("schedules self-capability reload only after responder.respond settles", async () => {
    const configPath = await writeConfig(baseConfig({ selfCapabilities: { enabled: true, mode: "apply" } }));
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    const applyReasons: string[] = [];
    let responder: AgentResponder | undefined;
    const driver: ChannelDriver = {
      id: "webhook",
      label: "Test",
      async loadConfig() {
        return { enabled: true };
      },
      isConfigError() {
        return false;
      },
      async start(input) {
        responder = input.responder;
        return { summary: {}, stop: async () => undefined };
      },
    };

    const app = await startMonoAgentApp({
      cwd: dir,
      configPath,
      env: {},
      operatorConsole: false,
      drivers: [driver],
      runtime: fake.runtime,
    });
    const originalApply = app.applyConfigChange.bind(app);
    (app as unknown as { applyConfigChange(reason: string): Promise<unknown> }).applyConfigChange = async (reason: string) => {
      applyReasons.push(reason);
      return { kind: "applied", message: "ok", transports: [] };
    };

    fake.beforeReturn = async () => {
      const server = fake.calls[0]?.options.mcpServers?.[SELF_CAPABILITIES_MCP_SERVER_NAME] as { env?: Record<string, string> } | undefined;
      const reloadNonce = server?.env?.MONO_AGENT_SELF_CAPABILITIES_RELOAD_NONCE;
      expect(reloadNonce).toBeDefined();
      await mkdir(join(dir, ".mono-agent", "self-capabilities"), { recursive: true });
      await writeFile(
        join(dir, ".mono-agent", "self-capabilities", "reload-requests.jsonl"),
        JSON.stringify({ kind: "skill", id: "x", proposalId: "proposal-x", reloadNonce }) + "\n",
        { flag: "a" },
      );
      expect(applyReasons).toEqual([]);
    };

    const response = await responder?.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => undefined },
    );
    expect(response?.text).toBe("ok");
    expect(applyReasons).toEqual([]);
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    expect(applyReasons[0]).toMatch(/^self-capabilities:/u);

    (app as unknown as { applyConfigChange(reason: string): Promise<unknown> }).applyConfigChange = originalApply;
    await app.stop();
  });

  it("registers self-capability settings in the app field groups", () => {
    expect(selfCapabilitiesFieldGroup.fields.map((field) => field.id)).toEqual([
      "selfCapabilities.enabled",
      "selfCapabilities.mode",
      "selfCapabilities.skillsRoot",
      "selfCapabilities.cronDir",
      "selfCapabilities.auditDir",
    ]);
  });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return configPath;
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
    context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: "./artifacts" },
    traceability: { registryDir: "./trace-sources", sourceId: "self-cap-test", sourceLabel: "Self Cap Test" },
    ...extra,
  };
}

async function settingsFromConfig(
  configPath: string,
  overrides: Partial<SelfCapabilitiesSettings> = {},
): Promise<SelfCapabilitiesSettings> {
  const settings = await resolveSelfCapabilitiesSettings(
    { env: {}, cwd: dir, configPath },
    coreConfig(),
  );
  return { ...settings, ...overrides };
}

function coreConfig(input: { readonly skillsRoot?: string } = {}): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" },
      executionMode: "sdk",
      workspace: dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: {
      identityPath: join(dir, "IDENTITY.md"),
      selectedSkills: [],
      ...(input.skillsRoot === undefined ? {} : { skillsRoot: input.skillsRoot }),
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(dir, "artifacts") },
    traceability: { registryDir: join(dir, "trace-sources") },
    providers: {},
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  const fake = {
    calls,
    beforeReturn: undefined as (() => Promise<void>) | undefined,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        const result = await run(prompt, options);
        await fake.beforeReturn?.();
        fake.beforeReturn = undefined;
        return result;
      },
      disposeAllSessions: vi.fn(async () => undefined),
    },
  };
  return fake;
}
