import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AcpClientError,
  authenticateAcpProfile,
  connectAcpProfile,
  deleteAcpSession,
  encodeAcpProviderSessionId,
  listAcpSessions,
  logoutAcpProfile,
  probeAcpProfile,
  validateAcpProviderSessionId,
} from "../../ai/providers/acp-client.js";
import { encodeAcpSessionCursor } from "../../ai/providers/acp-session-tokens.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-agent.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "agent-runtime-acp-client-"));
const TOKEN_KEY = Buffer.alloc(32, 0x31);
const OTHER_TOKEN_KEY = Buffer.alloc(32, 0x32);
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
  return {
    resolveAcpProfile: vi.fn(async () => descriptor),
    acpSessionTokenKey: TOKEN_KEY,
  };
}

describe("ACP provider session ids", () => {
  it("validates authenticated acp:v2 handles without exposing the raw id", () => {
    const encoded = encodeAcpProviderSessionId(
      "personal-agent",
      "session:/with unicode/Ł",
      TOKEN_KEY,
    );
    expect(encoded).toMatch(/^acp:v2:personal-agent:[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("session:/with unicode/Ł");
    expect(validateAcpProviderSessionId(encoded, "personal-agent", TOKEN_KEY)).toBe(encoded);
    expect(() => validateAcpProviderSessionId(encoded, "another-agent", TOKEN_KEY))
      .toThrow(AcpClientError);
  });

  it.each([
    "acp:v1:bad profile:c2Vzc2lvbg",
    "acp:v1:profile:c2Vzc2lvbg==",
    "acp:v2:profile:c2Vzc2lvbg",
    "session",
  ])("rejects non-canonical composite id %s", (value) => {
    expect(() => validateAcpProviderSessionId(value, "profile", TOKEN_KEY)).toThrow(AcpClientError);
  });
});

describe("ACP v1 client lifecycle", () => {
  it("requires a token key before resolving profiles for handle-bearing connections", async () => {
    const resolveAcpProfile = vi.fn(async () => profile());

    await expect(connectAcpProfile("personal-agent", { resolveAcpProfile }))
      .rejects.toMatchObject({ code: "invalid_token_key" });
    expect(resolveAcpProfile).not.toHaveBeenCalled();
  });

  it("rejects relative profile commands before spawning", async () => {
    await expect(connectAcpProfile("invalid", host(profile("normal", { command: "node" }))))
      .rejects.toMatchObject({ code: "invalid_profile" });
  });

  it("does not prepare or spawn after cancellation during profile resolution", async () => {
    let resolveDescriptor;
    const resolveAcpProfile = vi.fn(() => new Promise((resolve) => { resolveDescriptor = resolve; }));
    const prepareCommand = vi.fn();
    const controller = new AbortController();
    const connection = connectAcpProfile("cancelled-resolve", {
      resolveAcpProfile,
      acpSessionTokenKey: TOKEN_KEY,
      signal: controller.signal,
      sandbox: { prepareCommand },
    });
    await vi.waitFor(() => expect(resolveAcpProfile).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel during resolve"));
    resolveDescriptor(profile());

    await expect(connection).rejects.toMatchObject({ code: "cancelled" });
    expect(prepareCommand).not.toHaveBeenCalled();
  });

  it("cleans prepared resources without spawning after cancellation during sandbox preparation", async () => {
    let resolvePrepared;
    const cleanup = vi.fn(async () => {});
    const prepareCommand = vi.fn(() => new Promise((resolve) => { resolvePrepared = resolve; }));
    const controller = new AbortController();
    const connection = connectAcpProfile("cancelled-prepare", {
      ...host(profile()),
      signal: controller.signal,
      sandbox: { prepareCommand },
    });
    await vi.waitFor(() => expect(prepareCommand).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel during prepare"));
    resolvePrepared({
      command: join(root, "must-not-spawn"),
      args: [],
      cwd: root,
      env: {},
      cleanup,
    });

    await expect(connection).rejects.toMatchObject({ code: "cancelled" });
    expect(cleanup).toHaveBeenCalledOnce();
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
    const sessionUpdate = vi.fn();
    const readTextFile = vi.fn(() => ({ content: "callback content" }));
    const writeTextFile = vi.fn(() => ({}));
    const createTerminal = vi.fn(() => ({ terminalId: "terminal-1" }));
    const terminalOutput = vi.fn(() => ({ output: "done", truncated: false }));
    const waitForTerminalExit = vi.fn(() => ({ exitCode: 0 }));
    const killTerminal = vi.fn(() => ({}));
    const releaseTerminal = vi.fn(() => ({}));
    const elicitationComplete = vi.fn();
    const descriptor = profile("normal", {
      env: {
        FAKE_ACP_MODE: "normal",
        FAKE_ACP_EXIT_FILE: exitFile,
        FAKE_ACP_PROMPT_FILE: promptFile,
      },
      capabilityPolicy: {
        sessionConfig: { boolean: true },
        elicitation: { form: true },
        filesystem: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientCallbacks: {
        requestPermission,
        createElicitation,
        sessionUpdate,
        readTextFile,
        writeTextFile,
        createTerminal,
        terminalOutput,
        waitForTerminalExit,
        killTerminal,
        releaseTerminal,
        elicitationComplete,
      },
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
        { type: "text", text: "permission and elicit privacy-copy all-client-callbacks please" },
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
      expect(updates[0].update.rawInput).toEqual(expect.objectContaining({ permission: "cancelled" }));
      expect(requestPermission).toHaveBeenCalledOnce();
      expect(requestPermission.mock.calls[0][0]).toEqual(expect.objectContaining({
        options: expect.any(Array),
      }));
      expect(requestPermission.mock.calls[0][0]).not.toHaveProperty("providerSessionId");
      expect(requestPermission.mock.calls[0][0]).not.toHaveProperty("sessionId");
      expect(requestPermission.mock.calls[0][0]).not.toHaveProperty("_meta");
      expect(requestPermission.mock.calls[0][1].requestId).toMatch(/^acp-request:personal-agent:/);
      expect(requestPermission.mock.calls[0][1].providerSessionId)
        .toMatch(/^acp:v2:personal-agent:/);
      expect(createElicitation).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "form",
          message: "Need fake input",
        }),
        expect.objectContaining({
          profileId: "personal-agent",
          operation: "elicitation",
          requestId: expect.stringMatching(/^acp-request:personal-agent:/),
          providerSessionId: expect.stringMatching(/^acp:v2:personal-agent:/),
        }),
      );
      expect(sessionUpdate).toHaveBeenCalled();
      expect(sessionUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({
        update: expect.any(Object),
      }));
      expect(sessionUpdate.mock.calls[0][0]).not.toHaveProperty("providerSessionId");
      expect(sessionUpdate.mock.calls[0][1].providerSessionId)
        .toMatch(/^acp:v2:personal-agent:/);
      expect(writeTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/tmp/[redacted]", content: "callback content" }),
        expect.objectContaining({
          operation: "write_text_file",
          providerSessionId: expect.stringMatching(/^acp:v2:personal-agent:/),
          requestId: expect.stringMatching(/^acp-request:personal-agent:/),
        }),
      );
      expect(readTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/tmp/[redacted]" }),
        expect.objectContaining({ operation: "read_text_file" }),
      );
      expect(createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ command: "echo-[redacted]", args: ["[redacted]"] }),
        expect.objectContaining({ operation: "terminal_create" }),
      );
      for (const callback of [terminalOutput, waitForTerminalExit, killTerminal, releaseTerminal]) {
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({ terminalId: "terminal-1" }),
          expect.objectContaining({
            providerSessionId: expect.stringMatching(/^acp:v2:personal-agent:/),
            requestId: expect.stringMatching(/^acp-request:personal-agent:/),
          }),
        );
      }
      expect(elicitationComplete).toHaveBeenCalledWith(
        { elicitationId: "elicitation-1" },
        expect.objectContaining({ operation: "elicitation_complete" }),
      );
      expect(elicitationComplete.mock.calls[0][1]).not.toHaveProperty("providerSessionId");
      const allProfileCallbacks = [
        requestPermission,
        createElicitation,
        sessionUpdate,
        readTextFile,
        writeTextFile,
        createTerminal,
        terminalOutput,
        waitForTerminalExit,
        killTerminal,
        releaseTerminal,
        elicitationComplete,
      ];
      for (const callback of allProfileCallbacks) {
        for (const [payload] of callback.mock.calls) {
          expect(payload).not.toHaveProperty("sessionId");
          expect(payload).not.toHaveProperty("_meta");
        }
      }
      expect(JSON.stringify({
        callbacks: allProfileCallbacks.map((callback) => callback.mock.calls),
      })).not.toContain("session-1");
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
    const providerSessionId = encodeAcpProviderSessionId("personal-agent", "session-1", TOKEN_KEY);
    await expect(deleteAcpSession(providerSessionId, options)).resolves.toEqual({
      profileId: "personal-agent",
      providerSessionId,
      deleted: true,
    });
  });

  it.each([
    {
      label: "URL components",
      prompt: "diagnostic-url-echo",
      elicitation: { url: true },
      response: { action: "accept" },
      secrets: [
        "https://acp-log-user:acp-log-password@example.invalid/callback"
          + "?token=acp-log-query-secret#acp-log-fragment-secret",
        "acp-log-user",
        "acp-log-password",
        "acp-log-query-secret",
        "acp-log-fragment-secret",
      ],
    },
    {
      label: "accepted form values",
      prompt: "diagnostic-form-echo",
      elicitation: { form: true },
      response: { action: "accept", content: { credential: "acp-log-form-secret" } },
      secrets: ["acp-log-form-secret"],
    },
  ])("keeps hostile $label echoes out of SDK diagnostics", async ({
    prompt,
    elicitation,
    response,
    secrets,
  }) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onAcpInteractionRequest = vi.fn(() => response);
    const descriptor = profile("normal", {
      capabilityPolicy: {
        sessionConfig: { boolean: true },
        elicitation,
      },
    });
    let connection;
    try {
      connection = await connectAcpProfile("diagnostic-safety", {
        ...host(descriptor),
        onAcpInteractionRequest,
      });
      const session = await connection.newSession({ cwd: root, mcpServers: [] });
      await expect(connection.prompt(session.sessionId, [{ type: "text", text: prompt }]))
        .resolves.toMatchObject({ stopReason: "end_turn" });
      await vi.waitFor(() => {
        expect(error.mock.calls).toContainEqual(["Error handling notification"]);
      });

      const diagnostics = JSON.stringify(error.mock.calls);
      for (const secret of secrets) expect(diagnostics).not.toContain(secret);
      expect(onAcpInteractionRequest).toHaveBeenCalledOnce();
    } finally {
      await connection?.close();
      error.mockRestore();
    }
  });

  it("keeps listed protocol session ids, metadata copies, and cursors behind opaque handles", async () => {
    const options = host(profile("privacy-list"));
    const first = await listAcpSessions("personal-agent", {}, options);

    expect(first.sessions).toEqual([expect.objectContaining({
      providerSessionId: expect.stringMatching(/^acp:v2:personal-agent:/),
      cwd: "/tmp/[redacted]",
      title: "First [redacted]",
    })]);
    expect(first.sessions[0]).not.toHaveProperty("sessionId");
    expect(first.sessions[0]).not.toHaveProperty("_meta");
    expect(first.nextCursor).toMatch(/^acp-cursor:v2:personal-agent:/);
    expect(JSON.stringify(first)).not.toContain("raw-private-session-1");
    expect(JSON.stringify(first)).not.toContain("raw-private-cursor-1");

    const second = await listAcpSessions("personal-agent", { cursor: first.nextCursor }, options);
    expect(second.sessions).toEqual([expect.objectContaining({
      providerSessionId: expect.stringMatching(/^acp:v2:personal-agent:/),
      cwd: "/tmp/[redacted]",
      title: "Second [redacted]",
    })]);
    expect(second.nextCursor).toBeNull();
    expect(JSON.stringify(second)).not.toContain("raw-private-session-2");
  });

  it("rejects raw, malformed, and cross-profile list cursors before spawning", async () => {
    const resolveAcpProfile = vi.fn(async () => profile("privacy-list"));
    for (const cursor of [
      "raw-private-cursor-1",
      encodeAcpSessionCursor("other-agent", "next", TOKEN_KEY),
      "acp-cursor:v1:personal-agent:bmV4dA==",
    ]) {
      await expect(listAcpSessions("personal-agent", { cursor }, {
        resolveAcpProfile,
        acpSessionTokenKey: TOKEN_KEY,
      }))
        .rejects.toMatchObject({ code: "invalid_cursor" });
    }
    expect(resolveAcpProfile).not.toHaveBeenCalled();
  });

  it("rejects wrong-key and legacy session handles before delete spawns", async () => {
    const resolveAcpProfile = vi.fn(async () => profile());
    const providerSessionId = encodeAcpProviderSessionId(
      "personal-agent",
      "session-1",
      TOKEN_KEY,
    );
    const legacy = `acp:v1:personal-agent:${Buffer.from("session-1").toString("base64url")}`;

    await expect(deleteAcpSession(providerSessionId, {
      resolveAcpProfile,
      acpSessionTokenKey: OTHER_TOKEN_KEY,
    })).rejects.toMatchObject({ code: "invalid_session_id" });
    await expect(deleteAcpSession(legacy, {
      resolveAcpProfile,
      acpSessionTokenKey: TOKEN_KEY,
    })).rejects.toMatchObject({ code: "invalid_session_id" });
    expect(resolveAcpProfile).not.toHaveBeenCalled();
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
