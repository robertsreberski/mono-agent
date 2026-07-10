import { readdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIGURATION_PROPOSAL_TOOL_NAME,
  createConfigurationProposalServer,
  type AgentConfigurationProposal,
} from "../configuration-proposal-tool.js";
import { initMonoAgentFolder } from "../init.js";
import {
  applyJsonPatch,
  createLocalConfigurationSession,
  isLocalConfigurationRequest,
  LocalConfigurationManager,
} from "../local-configuration.js";
import { readMonoAgentConfigJson, type MonoAgentConfigJson } from "@mono-agent/config";
import { defaultAnswers } from "../wizard/answers.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scaffold(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-local-config-"));
  dirs.push(dir);
  const result = await initMonoAgentFolder({
    dir,
    answers: defaultAnswers({ name: "Local Test", purpose: "Help test local configuration." }),
  });
  return { dir, configPath: result.configPath };
}

function proposal(
  baseVersion: string,
  overrides: Partial<AgentConfigurationProposal> = {},
): AgentConfigurationProposal {
  return {
    schema: "mono-agent.configuration-proposal.v1",
    id: "11111111-2222-4333-8444-555555555555",
    baseVersion,
    rationale: "Use a clearer public name.",
    patch: [{ op: "replace", path: "/agent/name", value: "Clear Local Test" }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("RFC 6902 configuration proposals", () => {
  it("enables the proposal boundary only for an explicitly marked local configuration turn", () => {
    expect(isLocalConfigurationRequest({ tui: { local: true, configuration: true } })).toBe(true);
    expect(isLocalConfigurationRequest({ tui: { local: true } })).toBe(false);
    expect(isLocalConfigurationRequest({ tui: { configuration: true } })).toBe(false);
    expect(isLocalConfigurationRequest({ source: "telegram", tui: { local: false, configuration: true } })).toBe(false);
  });

  it("applies add/remove/replace/copy/move/test without mutating the source", () => {
    const source = { agent: { name: "A" }, tools: { allowedTools: ["Read", "Grep"] } };
    const result = applyJsonPatch(source, [
      { op: "test", path: "/agent/name", value: "A" },
      { op: "replace", path: "/agent/name", value: "B" },
      { op: "add", path: "/tools/allowedTools/-", value: "Glob" },
      { op: "copy", from: "/agent/name", path: "/agent/alias" },
      { op: "move", from: "/agent/alias", path: "/agent/display" },
      { op: "remove", path: "/tools/allowedTools/1" },
    ]);
    expect(result).toMatchObject({ agent: { name: "B", display: "B" }, tools: { allowedTools: ["Read", "Glob"] } });
    expect(source.agent.name).toBe("A");
  });

  it("rejects prototype paths and failed tests", () => {
    expect(() => applyJsonPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }]))
      .toThrow(/Unsafe JSON Pointer/u);
    expect(() => applyJsonPatch({ agent: { name: "A" } }, [{ op: "test", path: "/agent/name", value: "B" }]))
      .toThrow(/test failed/u);
  });
});

describe("local configuration transaction", () => {
  it("builds an OS-owner-local responder and refuses a writable-by-others folder", async () => {
    const { dir, configPath } = await scaffold();
    const session = await createLocalConfigurationSession({ cwd: dir, configPath, env: {}, configure: false });
    expect(session.title).toBe("Local Test");
    expect(session.configuration.initialPrompt).toBeUndefined();
    await session.dispose();

    await chmod(dir, 0o777);
    await expect(createLocalConfigurationSession({ cwd: dir, configPath, env: {}, configure: true }))
      .rejects.toThrow(/group\/world writable/u);
  });

  it("rejects config, Identity, and transaction paths that traverse symlinked parents", async () => {
    const first = await scaffold();
    const externalIdentityDir = await mkdtemp(join(tmpdir(), "mono-agent-external-identity-"));
    dirs.push(externalIdentityDir);
    const identityPath = join(first.dir, "IDENTITY.md");
    const externalIdentityPath = join(externalIdentityDir, "IDENTITY.md");
    const identityBefore = await readFile(identityPath, "utf8");
    await writeFile(externalIdentityPath, identityBefore);
    await symlink(externalIdentityDir, join(first.dir, "linked"), "dir");
    const currentConfig = JSON.parse(await readFile(first.configPath, "utf8")) as MonoAgentConfigJson;
    const config: MonoAgentConfigJson = {
      ...currentConfig,
      context: { ...currentConfig.context, identityPath: "./linked/IDENTITY.md" },
    };
    await writeFile(first.configPath, `${JSON.stringify(config, null, 2)}\n`);

    const manager = await LocalConfigurationManager.create({
      cwd: first.dir,
      configPath: first.configPath,
      env: {},
      configure: true,
    });
    try {
      const version = (await readMonoAgentConfigJson(first.configPath)).version;
      await expect(manager.prepareProposal(proposal(version, { role: "Do not escape the agent." })))
        .rejects.toThrow(/symbolic link|real directory/u);
      expect(await readFile(externalIdentityPath, "utf8")).toBe(identityBefore);
    } finally {
      await manager.dispose();
    }

    const second = await scaffold();
    const externalConfigDir = await mkdtemp(join(tmpdir(), "mono-agent-external-config-"));
    dirs.push(externalConfigDir);
    await writeFile(
      join(externalConfigDir, "mono-agent.config.json"),
      await readFile(second.configPath, "utf8"),
    );
    await symlink(externalConfigDir, join(second.dir, "linked-config"), "dir");
    await expect(LocalConfigurationManager.create({
      cwd: second.dir,
      configPath: join(second.dir, "linked-config", "mono-agent.config.json"),
      env: {},
      configure: true,
    })).rejects.toThrow(/symbolic link|real directory/u);

    const third = await scaffold();
    const externalStateDir = await mkdtemp(join(tmpdir(), "mono-agent-external-state-"));
    dirs.push(externalStateDir);
    await rm(join(third.dir, ".mono-agent"), { recursive: true, force: true });
    await symlink(externalStateDir, join(third.dir, ".mono-agent"), "dir");
    await expect(LocalConfigurationManager.create({
      cwd: third.dir,
      configPath: third.configPath,
      env: {},
      configure: true,
    })).rejects.toThrow(/real directory/u);
  });

  it("validates, applies, retains rollback evidence, and replaces only the Role body", async () => {
    const { dir, configPath } = await scaffold();
    const version = (await readMonoAgentConfigJson(configPath)).version;
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await manager.prepareProposal(proposal(version, {
        role: "Help the operator test configuration safely.",
      }));
      expect(card.details).toContain("replace /agent/name = \"Clear Local Test\"");
      expect(card.details).toContain("replace IDENTITY.md ## Role body");

      const applied = await manager.apply(card.id);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Clear Local Test");
      const identity = await readFile(join(dir, "IDENTITY.md"), "utf8");
      expect(identity).toContain("## Role\n\nHelp the operator test configuration safely.");
      expect(identity).toContain("## Knowledge");
      expect(await readFile(join(applied.rollbackDir, "mono-agent.config.json.before"), "utf8"))
        .toContain('"name": "Local Test"');
      expect(await readFile(join(applied.rollbackDir, "change.json"), "utf8"))
        .toContain(applied.changeId);
    } finally {
      await manager.dispose();
    }
  });

  it("rejects stale, env-shadowed, secret-bearing, and authority-expanding proposals", async () => {
    const { dir, configPath } = await scaffold();
    const scaffolded = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...scaffolded,
      runtime: { ...scaffolded.runtime, model: "pi:openai-codex:gpt-5.5" },
      tools: { ...scaffolded.tools, allowedTools: ["ReadSkill"] },
    }, null, 2)}\n`);
    const first = await readMonoAgentConfigJson(configPath);

    const envManager = await LocalConfigurationManager.create({
      cwd: dir,
      configPath,
      env: { MONO_AGENT_NAME: "Environment Name", OPENAI_API_KEY: "configured-secret" },
      configure: true,
    });
    try {
      await expect(envManager.prepareProposal(proposal(first.version))).rejects.toThrow(/environment overrides/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "secret-proposal",
        patch: [{ op: "add", path: "/memory/embeddings/apiKey", value: "configured-secret" }],
      }))).rejects.toThrow(/Secret-bearing|secret value/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "authority-proposal",
        patch: [{ op: "add", path: "/tools/allowedTools/-", value: "Bash" }],
      }))).rejects.toThrow(/Broader tool authority/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "permission-proposal",
        patch: [{ op: "add", path: "/runtime/permissionMode", value: "bypassPermissions" }],
      }))).rejects.toThrow(/permissionMode/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "route-safety-proposal",
        patch: [{ op: "replace", path: "/runtime/routeSafety", value: "per-route-native" }],
      }))).rejects.toThrow(/routeSafety|guided flow/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "cron-proposal",
        patch: [{
          op: "add",
          path: "/cron",
          value: { jobs: [{ id: "unattended", expression: "* * * * *", prompt: "Run unattended." }] },
        }],
      }))).rejects.toThrow(/cron|guided flow/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "telegram-proposal",
        patch: [{ op: "add", path: "/telegram", value: { enabled: true, allowedUserIds: ["123"] } }],
      }))).rejects.toThrow(/telegram|guided flow/u);
      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "plugin-proposal",
        patch: [{ op: "add", path: "/channels", value: { plugins: [{ package: "example-channel" }] } }],
      }))).rejects.toThrow(/channels|guided flow/u);

      await expect(envManager.prepareProposal(proposal(first.version, {
        id: "permission-tightening",
        patch: [{ op: "add", path: "/runtime/permissionMode", value: "plan" }],
      }))).rejects.toThrow(/permissionMode|guided flow/u);
    } finally {
      await envManager.dispose();
    }

    const staleManager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await staleManager.prepareProposal(proposal(first.version));
      const raw = JSON.parse(await readFile(configPath, "utf8")) as { traceability: Record<string, unknown> };
      raw.traceability.heartbeatMs = 1234;
      await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
      await expect(staleManager.apply(card.id)).rejects.toThrow(/changed after the proposal/u);
    } finally {
      await staleManager.dispose();
    }
  });

  it("preserves config and Role edits made during approval validation", async () => {
    const configRace = await scaffold();
    const configVersion = (await readMonoAgentConfigJson(configRace.configPath)).version;
    const configManager = await LocalConfigurationManager.create({
      cwd: configRace.dir,
      configPath: configRace.configPath,
      env: {},
      configure: true,
    });
    try {
      const card = await configManager.prepareProposal(proposal(configVersion));
      const internals = configManager as unknown as {
        validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void>;
      };
      const validate = internals.validateCandidate.bind(configManager);
      internals.validateCandidate = async (candidate, label) => {
        await validate(candidate, label);
        if (label.endsWith("-approval")) {
          const current = JSON.parse(await readFile(configRace.configPath, "utf8")) as MonoAgentConfigJson;
          const concurrent: MonoAgentConfigJson = { ...current, agent: { name: "CONCURRENT-EDIT" } };
          await writeFile(configRace.configPath, `${JSON.stringify(concurrent, null, 2)}\n`);
        }
      };
      await expect(configManager.apply(card.id)).rejects.toThrow(/changed while the approved change was being prepared/u);
      expect((await readMonoAgentConfigJson(configRace.configPath)).json.agent?.name).toBe("CONCURRENT-EDIT");
    } finally {
      await configManager.dispose();
    }

    const roleRace = await scaffold();
    const rolePath = join(roleRace.dir, "IDENTITY.md");
    const roleVersion = (await readMonoAgentConfigJson(roleRace.configPath)).version;
    const roleManager = await LocalConfigurationManager.create({
      cwd: roleRace.dir,
      configPath: roleRace.configPath,
      env: {},
      configure: true,
    });
    try {
      const card = await roleManager.prepareProposal(proposal(roleVersion, {
        role: "Apply only if the source Role is still current.",
      }));
      const internals = roleManager as unknown as {
        validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void>;
      };
      const validate = internals.validateCandidate.bind(roleManager);
      internals.validateCandidate = async (candidate, label) => {
        await validate(candidate, label);
        if (label.endsWith("-approval")) await writeFile(rolePath, "# CONCURRENT ROLE EDIT\n");
      };
      await expect(roleManager.apply(card.id)).rejects.toThrow(/IDENTITY\.md changed while/u);
      expect(await readFile(rolePath, "utf8")).toBe("# CONCURRENT ROLE EDIT\n");
      expect((await readMonoAgentConfigJson(roleRace.configPath)).json.agent?.name).toBe("Local Test");
    } finally {
      await roleManager.dispose();
    }
  });

  it("preserves an edit made after the atomic temp is staged", async () => {
    const { dir, configPath } = await scaffold();
    const current = await readMonoAgentConfigJson(configPath);
    const concurrent: MonoAgentConfigJson = {
      ...current.json,
      agent: { ...current.json.agent, name: "CONCURRENT-EDIT" },
    };
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    let stop = false;
    let fired = false;
    try {
      const card = await manager.prepareProposal(proposal(current.version));
      const monitor = (async () => {
        while (!stop) {
          if (!fired && readdirSync(dir).some((name) => name.endsWith(".mono-agent-tmp"))) {
            fired = true;
            writeFileSync(configPath, `${JSON.stringify(concurrent, null, 2)}\n`);
          }
          await yieldNow();
        }
      })();

      let outcome: unknown;
      try {
        outcome = await manager.apply(card.id);
      } catch (error) {
        outcome = error;
      } finally {
        stop = true;
        await monitor;
      }
      expect(fired).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("CONCURRENT-EDIT");
    } finally {
      stop = true;
      await manager.dispose();
    }
  });

  it("uses a fail-closed allowlist for paths, endpoints, sandbox, and new schema fields", async () => {
    const { dir, configPath } = await scaffold();
    const external = await mkdtemp(join(tmpdir(), "mono-agent-external-memory-"));
    dirs.push(external);
    await symlink(external, join(dir, "linked-external"), "dir");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...raw,
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        maxBytes: 64_000,
        writeMode: "append-host-summary",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          endpoint: "http://127.0.0.1:9999/v1",
          apiKeyEnv: "TEST_EMBEDDINGS_KEY",
        },
      },
    }, null, 2)}\n`);
    const current = await readMonoAgentConfigJson(configPath);
    const manager = await LocalConfigurationManager.create({
      cwd: dir,
      configPath,
      env: { TEST_EMBEDDINGS_KEY: "synthetic-not-real" },
      configure: true,
    });
    try {
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "memory-path-escape",
        patch: [{ op: "replace", path: "/memory/path", value: "./linked-external" }],
      }))).rejects.toThrow(/memory\/path|Paths/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "public-endpoint-fallback",
        patch: [{ op: "remove", path: "/memory/embeddings/endpoint" }],
      }))).rejects.toThrow(/embeddings\/endpoint|network/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "sandbox-default-widening",
        patch: [{ op: "add", path: "/sandbox", value: { readableRoots: [], writableRoots: [] } }],
      }))).rejects.toThrow(/sandbox|guided flow/u);
      await expect(manager.prepareProposal(proposal(current.version, {
        id: "unknown-future-field",
        patch: [{ op: "add", path: "/futureAuthority", value: true }],
      }))).rejects.toThrow(/futureAuthority|new schema fields/u);
    } finally {
      await manager.dispose();
    }
  });

  it("allows low-risk fields and semantic tool-authority tightening", async () => {
    const { dir, configPath } = await scaffold();
    const current = await readMonoAgentConfigJson(configPath);
    const seeded: MonoAgentConfigJson = {
      ...current.json,
      runtime: { ...current.json.runtime, model: "pi:openai-codex:gpt-5.5" },
      memory: {
        mode: "lite",
        path: ".mono-agent/memory",
        writeMode: "append-host-summary",
      },
      tools: { allowedTools: ["Read", "Grep"], disallowedTools: [] },
    };
    await writeFile(configPath, `${JSON.stringify(seeded, null, 2)}\n`);
    const seededVersion = (await readMonoAgentConfigJson(configPath)).version;
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await manager.prepareProposal(proposal(seededVersion, {
        id: "safe-low-risk-fields",
        patch: [
          { op: "replace", path: "/agent/name", value: "Focused Local Test" },
          { op: "add", path: "/runtime/effort", value: "low" },
          { op: "replace", path: "/context/selectedSkills", value: ["mono-agent-configure"] },
          { op: "add", path: "/memory/maxBytes", value: 32_000 },
          { op: "add", path: "/memory/recallTool", value: { enabled: true } },
          { op: "replace", path: "/tools/allowedTools", value: ["Read"] },
          { op: "replace", path: "/tools/disallowedTools", value: ["Bash"] },
        ],
      }));
      await expect(manager.reject(card.id)).resolves.toMatchObject({ message: expect.stringContaining("Rejected") });
    } finally {
      await manager.dispose();
    }
  });

  it("rejects an Identity parent replaced by an external symlink at the commit boundary", async () => {
    const { dir, configPath } = await scaffold();
    const originalIdentityPath = join(dir, "IDENTITY.md");
    const identityBefore = await readFile(originalIdentityPath, "utf8");
    const identityDir = join(dir, "identity");
    await mkdir(identityDir);
    await writeFile(join(identityDir, "IDENTITY.md"), identityBefore);
    await rm(originalIdentityPath);
    const current = JSON.parse(await readFile(configPath, "utf8")) as MonoAgentConfigJson;
    await writeFile(configPath, `${JSON.stringify({
      ...current,
      context: { ...current.context, identityPath: "./identity/IDENTITY.md" },
    }, null, 2)}\n`);

    const externalParent = await mkdtemp(join(tmpdir(), "mono-agent-identity-race-"));
    dirs.push(externalParent);
    const movedIdentityDir = join(externalParent, "identity");
    const version = (await readMonoAgentConfigJson(configPath)).version;
    const manager = await LocalConfigurationManager.create({ cwd: dir, configPath, env: {}, configure: true });
    try {
      const card = await manager.prepareProposal(proposal(version, {
        role: "This Role must never cross the project boundary.",
      }));
      const internals = manager as unknown as {
        validateCandidate(candidate: MonoAgentConfigJson, label: string): Promise<void>;
      };
      const validate = internals.validateCandidate.bind(manager);
      internals.validateCandidate = async (candidate, label) => {
        await validate(candidate, label);
        if (label.endsWith("-approval")) {
          await rename(identityDir, movedIdentityDir);
          await symlink(movedIdentityDir, identityDir, "dir");
        }
      };

      await expect(manager.apply(card.id)).rejects.toThrow(/real directory|symbolic link/u);
      expect(await readFile(join(movedIdentityDir, "IDENTITY.md"), "utf8")).toBe(identityBefore);
      expect((await readMonoAgentConfigJson(configPath)).json.agent?.name).toBe("Local Test");
    } finally {
      await manager.dispose();
    }
  });
});

describe("ProposeAgentConfiguration MCP tool", () => {
  it("rejects secret-shaped fields before creating a proposal payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-secret-"));
    dirs.push(dir);
    const sinkPath = join(dir, "proposal.json");
    const server = createConfigurationProposalServer({ sinkPath, baseVersion: "base-hash" });
    const client = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === CONFIGURATION_PROPOSAL_TOOL_NAME)?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

      const result = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: {
          rationale: "Put a key in config.",
          patch: [{ op: "add", path: "/memory/embeddings/apiKey", value: "sk-secret-shaped-value" }],
        },
      }) as { isError?: boolean };
      expect(result.isError).toBe(true);
      await expect(readFile(sinkPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("records one non-applying proposal for host validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-proposal-tool-"));
    dirs.push(dir);
    const sinkPath = join(dir, "proposal.json");
    const server = createConfigurationProposalServer({ sinkPath, baseVersion: "base-hash" });
    const client = new Client({ name: "configuration-proposal-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: {
          rationale: "Make the name clearer.",
          patch: [{ op: "replace", path: "/agent/name", value: "Clear" }],
        },
      }) as { structuredContent?: { proposalId?: string } };
      expect(result.structuredContent?.proposalId).toBeTypeOf("string");
      const stored = JSON.parse(await readFile(sinkPath, "utf8")) as AgentConfigurationProposal;
      expect(stored.baseVersion).toBe("base-hash");
      expect(stored.patch).toEqual([{ op: "replace", path: "/agent/name", value: "Clear" }]);

      const duplicate = await client.callTool({
        name: CONFIGURATION_PROPOSAL_TOOL_NAME,
        arguments: { rationale: "Again", patch: [{ op: "remove", path: "/agent/name" }] },
      }) as { isError?: boolean };
      expect(duplicate.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
