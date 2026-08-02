import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../runtime.js";
import { decodeAcpProviderSessionId } from "../../ai/providers/acp-client.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-agent.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "agent-runtime-acp-bridge-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function descriptor(mode = "normal", overrides = {}) {
  return {
    command: process.execPath,
    args: [fixture],
    env: { FAKE_ACP_MODE: mode },
    configurationOwner: "client",
    workspaceOwner: "agent",
    workspacePath: root,
    mcpOwner: "agent",
    sessionConfig: { modeId: "ask", configOptions: { model: "fast" } },
    process: {
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      shutdownGraceMs: 100,
      killGraceMs: 500,
      maxLineBytes: 1024 * 1024,
    },
    ...overrides,
  };
}

function runOptions(resolveAcpProfile, overrides = {}) {
  return {
    model: { sdk: "acp", model: "personal-agent", reference: "acp:personal-agent" },
    executionMode: "acp",
    cwd: root,
    messages: [{ role: "user", content: "hello" }],
    abortSignal: new AbortController().signal,
    resolveAcpProfile,
    ...overrides,
  };
}

describe("ACP runtime bridge", () => {
  it("prepares the owned bridge with the host sandbox and effective policy", async () => {
    const configuredPolicy = { mode: "native", root };
    const sandbox = {
      mergePolicies: vi.fn((configured, request) => request || configured),
      prepareCommand: vi.fn(async ({ command, policy, engine }) => ({
        ...command,
        args: command.args || [],
        sandboxed: true,
        policy,
        engine,
      })),
      networkAllowsUrl: vi.fn(() => false),
    };
    const result = await createRuntime({ sandbox, sandboxPolicy: configuredPolicy }).run(
      "System",
      runOptions(async () => descriptor()),
    );

    expect(result.error).toBeNull();
    expect(sandbox.mergePolicies).toHaveBeenCalledWith(configuredPolicy, undefined);
    expect(sandbox.prepareCommand).toHaveBeenCalledWith(expect.objectContaining({
      policy: configuredPolicy,
      command: expect.objectContaining({ command: process.execPath }),
    }));
  });

  it("runs from a per-call profile resolver, preserves resource links, and normalizes typed updates", async () => {
    const resolveAcpProfile = vi.fn(async () => descriptor());
    const interaction = vi.fn(() => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const streamed = [];
    process.env.ACP_SHOULD_NOT_LEAK = "parent-secret";
    let result;
    try {
      result = await createRuntime().run("You are the configured agent.", runOptions(resolveAcpProfile, {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "permission and resource" },
            { type: "resource_link", uri: "file:///tmp/runtime-context.txt", name: "runtime context" },
          ],
        }],
        onAcpInteractionRequest: interaction,
        onEvent: (event) => streamed.push(event),
      }));
    } finally {
      delete process.env.ACP_SHOULD_NOT_LEAK;
    }

    expect(result.error).toBeNull();
    expect(result.failureKind).toBeNull();
    expect(result.text).toBe("saw file:///tmp/runtime-context.txt");
    expect(result.thinking).toBe("thinking");
    expect(result.sdk).toBe("acp");
    expect(result.usage).toEqual({ total_tokens: 12, context_window: 1000, cost: null });
    expect(result.providerSessionId).toMatch(/^acp:v1:personal-agent:/);
    expect(decodeAcpProviderSessionId(result.providerSessionId)).toEqual({
      profileId: "personal-agent",
      sessionId: "session-1",
    });
    expect(result.diagnostics).toMatchObject({
      acp_profile_id: "personal-agent",
      acp_stop_reason: "end_turn",
      acp_mode_applied: true,
      acp_config_options_applied: ["model"],
    });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "acp_session_update" }),
      expect.objectContaining({ type: "assistant" }),
      expect.objectContaining({ type: "user" }),
      expect.objectContaining({ type: "context_usage" }),
    ]));
    expect(streamed).toHaveLength(result.events.length);
    expect(interaction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "permission", profileId: "personal-agent" }),
      expect.objectContaining({ profileId: "personal-agent", operation: "permission" }),
    );
    expect(resolveAcpProfile).toHaveBeenCalledWith(
      "personal-agent",
      expect.objectContaining({ operation: "run", profileId: "personal-agent" }),
    );
  });

  it("capability-gates and resumes the decoded provider session on a fresh stdio bridge", async () => {
    const resolveAcpProfile = async () => descriptor();
    const first = await createRuntime().run("System", runOptions(resolveAcpProfile));
    const second = await createRuntime().run("System", runOptions(resolveAcpProfile, {
      providerSessionId: first.providerSessionId,
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "continue" },
      ],
    }));

    expect(second.error).toBeNull();
    expect(second.providerSessionId).toBe(first.providerSessionId);
    expect(second.diagnostics.acp_resume_method).toBe("resume");
    expect(second.capabilitiesUsed.session_resume).toBe(true);
  });

  it("falls back to a fresh session for auto recovery when the agent cannot load or resume", async () => {
    const first = await createRuntime().run("System", runOptions(async () => descriptor()));
    const recovered = await createRuntime().run("System", runOptions(
      async () => descriptor("no-resume"),
      {
        providerSessionId: first.providerSessionId,
        messages: [{ role: "user", content: "recovered from durable host history" }],
      },
    ));

    expect(recovered.error).toBeNull();
    expect(recovered.cancelled).toBe(false);
    expect(recovered.diagnostics.acp_resume_method).toBe("new_fallback");
    expect(recovered.capabilitiesUsed.session_resume).toBe(false);
    expect(recovered.capabilitiesUsed.session_load).toBe(false);
  });

  it.each(["resume", "load"])(
    "keeps an explicit %s recovery policy capability-gated",
    async (resumeStrategy) => {
      const first = await createRuntime().run("System", runOptions(async () => descriptor()));
      const recovered = await createRuntime().run("System", runOptions(
        async () => descriptor("no-resume", { sessionConfig: { resumeStrategy } }),
        { providerSessionId: first.providerSessionId },
      ));

      expect(recovered.failureKind).toBe("provider_protocol");
      expect(recovered.errorDetails).toMatchObject({ acp_error_code: "capability_missing" });
    },
  );

  it("sends session/cancel, returns promptly, and reaps the owned child on abort", async () => {
    const exitFile = join(root, "abort-exit.txt");
    const promptFile = join(root, "abort-prompt.json");
    const controller = new AbortController();
    const started = Date.now();
    const pending = createRuntime().run("System", runOptions(async () => descriptor("normal", {
      env: {
        FAKE_ACP_MODE: "normal",
        FAKE_ACP_EXIT_FILE: exitFile,
        FAKE_ACP_PROMPT_FILE: promptFile,
      },
    }), {
      messages: [{ role: "user", content: "hang" }],
      abortSignal: controller.signal,
    }));
    await vi.waitUntil(() => existsSync(promptFile), { timeout: 1_000, interval: 10 });
    controller.abort(new Error("cancel test"));
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.failureKind).toBeNull();
    expect(result.error).toBeNull();
    expect(result.text).toBe("cancelled tail");
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "acp_session_update",
      update: expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
    }));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(existsSync(exitFile)).toBe(true);
  });

  it.each(["malformed", "oversize", "unterminated"])(
    "classifies a %s peer as provider_protocol without exposing stderr",
    async (mode) => {
      const result = await createRuntime().run("System", runOptions(async () => descriptor(mode, {
        process: {
          ...descriptor().process,
          maxLineBytes: mode === "oversize" ? 1024 : 1024 * 1024,
        },
      })));
      expect(result.failureKind).toBe("provider_protocol");
      expect(result.cancelled).toBe(false);
      expect(result.errorDetails).toEqual(expect.objectContaining({ acp_error_code: "protocol" }));
      expect(JSON.stringify(result)).not.toContain("FAKE_ACP");
    },
  );
});
