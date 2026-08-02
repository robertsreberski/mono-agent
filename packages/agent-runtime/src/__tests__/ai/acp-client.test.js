import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AcpClientError,
  authenticateAcpProfile,
  connectAcpProfile,
  decodeAcpProviderSessionId,
  deleteAcpSession,
  encodeAcpProviderSessionId,
  listAcpSessions,
  logoutAcpProfile,
  probeAcpProfile,
} from "../../ai/providers/acp-client.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-agent.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "agent-runtime-acp-client-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function profile(mode = "normal", overrides = {}) {
  return {
    command: process.execPath,
    args: [fixture],
    env: { FAKE_ACP_MODE: mode },
    workspaceOwner: "agent",
    workspacePath: root,
    mcpOwner: "agent",
    configurationOwner: "client",
    capabilityPolicy: { sessionConfig: { boolean: true } },
    process: {
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownGraceMs: 100,
      killGraceMs: 500,
      maxLineBytes: 1024 * 1024,
    },
    ...overrides,
  };
}

function host(descriptor) {
  return { resolveAcpProfile: vi.fn(async () => descriptor) };
}

describe("ACP provider session ids", () => {
  it("round-trips the exact canonical acp:v1 composite encoding", () => {
    const encoded = encodeAcpProviderSessionId("personal-agent", "session:/with unicode/Ł");
    expect(encoded).toMatch(/^acp:v1:personal-agent:[A-Za-z0-9_-]+$/);
    expect(decodeAcpProviderSessionId(encoded)).toEqual({
      profileId: "personal-agent",
      sessionId: "session:/with unicode/Ł",
    });
  });

  it.each([
    "acp:v1:bad profile:c2Vzc2lvbg",
    "acp:v1:profile:c2Vzc2lvbg==",
    "acp:v2:profile:c2Vzc2lvbg",
    "session",
  ])("rejects non-canonical composite id %s", (value) => {
    expect(() => decodeAcpProviderSessionId(value)).toThrow(AcpClientError);
  });
});

describe("ACP v1 client lifecycle", () => {
  it("rejects relative profile commands before spawning", async () => {
    await expect(connectAcpProfile("invalid", host(profile("normal", { command: "node" }))))
      .rejects.toMatchObject({ code: "invalid_profile" });
  });

  it("initializes, preserves resource links, validates permission choices, streams typed updates, and cleans up", async () => {
    const exitFile = join(root, "happy-exit.txt");
    const promptFile = join(root, "happy-prompt.json");
    const requestPermission = vi.fn(() => ({
      outcome: { outcome: "selected", optionId: "not-offered" },
    }));
    const createElicitation = vi.fn(() => ({
      action: "accept",
      content: { answer: "yes" },
    }));
    const descriptor = profile("normal", {
      env: {
        FAKE_ACP_MODE: "normal",
        FAKE_ACP_EXIT_FILE: exitFile,
        FAKE_ACP_PROMPT_FILE: promptFile,
      },
      capabilityPolicy: {
        sessionConfig: { boolean: true },
        elicitation: { form: true },
      },
      clientCallbacks: { requestPermission, createElicitation },
    });
    const connection = await connectAcpProfile("personal-agent", host(descriptor));
    const updates = [];
    try {
      expect(connection.initializeResult).toMatchObject({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      });
      const session = await connection.newSession({ cwd: root, mcpServers: [] });
      const response = await connection.prompt(session.sessionId, [
        { type: "text", text: "permission and elicit please" },
        { type: "resource_link", uri: "file:///tmp/context.txt", name: "context" },
      ], { onUpdate: (notification) => updates.push(notification) });

      expect(response).toMatchObject({ stopReason: "end_turn" });
      expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual([
        "tool_call",
        "tool_call_update",
        "agent_thought_chunk",
        "agent_message_chunk",
        "usage_update",
      ]);
      expect(updates[0].update.rawInput).toEqual({ permission: "cancelled" });
      expect(requestPermission).toHaveBeenCalledOnce();
      expect(createElicitation).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "form", message: "Need fake input" }),
        expect.objectContaining({ profileId: "personal-agent", operation: "elicitation" }),
      );
      expect(JSON.parse(readFileSync(promptFile, "utf8"))).toContainEqual(expect.objectContaining({
        type: "resource_link",
        uri: "file:///tmp/context.txt",
      }));
    } finally {
      await connection.close();
    }
    expect(existsSync(exitFile)).toBe(true);
  });

  it("supports capability-gated probe/auth/logout/list/delete management operations", async () => {
    const options = host(profile());
    await expect(probeAcpProfile("personal-agent", options)).resolves.toMatchObject({
      profileId: "personal-agent",
      protocolVersion: 1,
      authMethods: [{ id: "fake-login", name: "Fake login", type: "agent" }],
    });
    await expect(authenticateAcpProfile("personal-agent", "fake-login", options)).resolves.toEqual({
      profileId: "personal-agent",
      methodId: "fake-login",
      authenticated: true,
    });
    await expect(logoutAcpProfile("personal-agent", options)).resolves.toEqual({
      profileId: "personal-agent",
      loggedOut: true,
    });
    await expect(listAcpSessions("personal-agent", {}, options)).resolves.toMatchObject({
      profileId: "personal-agent",
      sessions: [],
      nextCursor: null,
    });
    const providerSessionId = encodeAcpProviderSessionId("personal-agent", "session-1");
    await expect(deleteAcpSession(providerSessionId, options)).resolves.toEqual({
      profileId: "personal-agent",
      providerSessionId,
      deleted: true,
    });
  });

  it("returns invalid_request for malformed session path inputs", async () => {
    const connection = await connectAcpProfile("personal-agent", host(profile()));
    try {
      const requests = [
        () => connection.newSession({ cwd: 42, mcpServers: [] }),
        () => connection.loadSession({ sessionId: "session-1", cwd: {}, mcpServers: [] }),
        () => connection.resumeSession({ sessionId: "session-1", cwd: root, additionalDirectories: [42], mcpServers: [] }),
        () => connection.listSessions(null),
        () => connection.listSessions({ cwd: 42 }),
      ];
      for (const request of requests) {
        await expect(request()).rejects.toMatchObject({
          name: "AcpClientError",
          code: "invalid_request",
          details: { code: "invalid_request" },
        });
      }
    } finally {
      await connection.close();
    }
  });

  it("accepts a valid inbound JSON-RPC frame above the old 10 MiB scanner ceiling", async () => {
    const descriptor = profile("large-frame", {
      process: {
        ...profile().process,
        startupTimeoutMs: 5_000,
        maxLineBytes: 16 * 1024 * 1024,
      },
    });
    const connection = await connectAcpProfile("large-frame", host(descriptor));
    try {
      expect(connection.initializeResult.agentInfo.title.length).toBe(11 * 1024 * 1024);
    } finally {
      await connection.close();
    }
  }, 15_000);

  it.each([
    ["malformed", {}, "protocol"],
    ["oversize", { process: { ...profile().process, maxLineBytes: 1024 } }, "protocol"],
    ["unterminated", {}, "protocol"],
    ["silent", { process: { ...profile().process, startupTimeoutMs: 40 } }, "timeout"],
  ])("fails closed on %s peers and returns bounded error metadata", async (mode, overrides, code) => {
    await expect(connectAcpProfile("broken", host(profile(mode, overrides))))
      .rejects.toMatchObject({ code });
  });
});
