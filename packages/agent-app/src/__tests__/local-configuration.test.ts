import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { readMonoAgentConfigJson } from "@mono-agent/config";
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
      .rejects.toThrow(/group\/world-writable/u);
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
