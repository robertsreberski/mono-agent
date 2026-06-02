import { describe, expect, it, vi } from "vitest";

import {
  CodexAppRuntimeError,
  createCodexAppRuntime,
} from "../runtime.js";
import type { CodexClientFactoryInput } from "../runtime.js";
import type { JsonRpcClient, JsonRpcRequest } from "../json-rpc-client.js";
import { normalizeCodexItemEvent, normalizeCodexItemType } from "../codex-events.js";
import { translateMcpServersForCodex } from "../translations.js";

describe("createCodexAppRuntime", () => {
  it("initializes the app-server before starting a thread and accepts nested thread ids", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let initialized = false;
    const factory = stubClient((input) => async (request) => {
      calls.push({
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
      });
      if (request.method === "initialize") {
        initialized = true;
        expect(request.params).toMatchObject({
          clientInfo: {
            name: "worklab-ai-codex-app-runtime",
            version: "0.1.0",
          },
        });
        return { userAgent: "codex-app-server-test" };
      }
      if (request.method === "thread/start") {
        expect(initialized).toBe(true);
        return { thread: { id: "th_1" } };
      }
      if (request.method === "turn/start") {
        expect(request.params?.threadId).toBe("th_1");
        const requestInput = request.params?.input;
        expect(Array.isArray(requestInput) ? requestInput[0]?.type : undefined).toBe("text");
        expect(Array.isArray(requestInput) ? requestInput[0]?.text : undefined).toContain("system");
        expect(Array.isArray(requestInput) ? requestInput[0]?.text : undefined).toContain("Hi");
        input.onNotification("turn/started", { turn: { id: "t1" } });
        input.onNotification("item/completed", { item: { id: "i1", type: "agentMessage", text: "ok" } });
        input.onNotification("turn/completed", { turn: { id: "t1" } });
        return {};
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory, threadStartAttempts: 1 });

    const result = await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.text).toBe("ok");
    expect(result.providerSessionId).toBe("th_1");
    expect(calls.map((call) => call.method)).toEqual(["initialize", "thread/start", "turn/start"]);
  });

  it("includes host context in the turn input so app-server turns see identity and skills", async () => {
    let turnInputText = "";
    const factory = stubClient((input) => async (request) => {
      if (request.method === "thread/start") {
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        const requestInput = request.params?.input;
        if (Array.isArray(requestInput) && requestInput[0]?.type === "text") {
          turnInputText = String(requestInput[0].text ?? "");
        }
        input.onNotification("turn/started", { turnId: "t1" });
        input.onNotification("item/completed", { item: { id: "i1", type: "agentMessage", text: "ok" } });
        input.onNotification("turn/completed", {});
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    await runtime.run("host identity and selected skill instructions", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(turnInputText).toContain("host identity and selected skill instructions");
    expect(turnInputText).toContain("Hi");
  });

  it("buffers agent message deltas per itemId and emits a single assistant event on item/completed", async () => {
    const factory = stubClient(({ onNotification }) => async (request) => {
      if (request.method === "thread/start") {
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        onNotification("turn/started", { turnId: "t1" });
        onNotification("item/agentMessage/delta", { itemId: "i1", delta: "Hello " });
        onNotification("item/agentMessage/delta", { itemId: "i1", delta: "world." });
        onNotification("item/completed", { item: { id: "i1", type: "agentMessage", text: "Hello world." } });
        onNotification("turn/completed", { usage: { input_tokens: 5, output_tokens: 3 } });
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    const result = await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.text).toBe("Hello world.");
    const assistantEvents = (result.events ?? []).filter((event) => event.type === "assistant");
    expect(assistantEvents).toHaveLength(1);
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  it("emits reasoning deltas immediately as thinking events", async () => {
    const factory = stubClient(({ onNotification }) => async (request) => {
      if (request.method === "thread/start") {
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        onNotification("turn/started", { turnId: "t1" });
        onNotification("item/reasoning/summaryTextDelta", { delta: "step 1" });
        onNotification("item/reasoning/textDelta", { delta: "step 2" });
        onNotification("turn/completed", {});
      }
      return {};
    });
    const events: Array<Record<string, unknown>> = [];
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    const thinkingEvents = events.filter((event) =>
      event.type === "assistant" &&
      Array.isArray((event as { message?: { content?: Array<{ type?: string }> } }).message?.content) &&
      ((event as { message: { content: Array<{ type?: string }> } }).message.content[0]?.type) === "thinking",
    );
    expect(thinkingEvents).toHaveLength(2);
  });

  it("surfaces warning/error/configWarning notifications as runtime_warning events without halting", async () => {
    const factory = stubClient(({ onNotification }) => async (request) => {
      if (request.method === "thread/start") {
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        onNotification("turn/started", { turnId: "t1" });
        onNotification("warning", { message: "things are weird" });
        onNotification("configWarning", { message: "config drift" });
        onNotification("error", { message: "minor error" });
        onNotification("item/completed", { item: { id: "i1", type: "agentMessage", text: "fine" } });
        onNotification("turn/completed", {});
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    const result = await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.text).toBe("fine");
    const warnings = (result.events ?? []).filter((event) => event.type === "runtime_warning");
    expect(warnings).toHaveLength(3);
  });

  it("surfaces failed turn completion as a runtime error", async () => {
    const factory = stubClient(({ onNotification }) => async (request) => {
      if (request.method === "thread/start") {
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        onNotification("turn/started", { turn: { id: "t1" } });
        onNotification("turn/completed", {
          turn: {
            id: "t1",
            status: "failed",
            error: { message: "auth failed" },
          },
        });
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    const result = await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.failureKind).toBe("runtime_error");
    expect(result.error).toBe("auth failed");
    expect(result.text).toBeUndefined();
  });

  it("sends turn/interrupt when abortSignal aborts during a turn", async () => {
    const captured: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const factory = stubClient(({ onNotification }) => async (request) => {
      captured.push({
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
      });
      if (request.method === "thread/start") {
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        // Trigger abort after turn/start is acknowledged
        setTimeout(() => controller.abort(), 0);
        // Don't emit turn/completed; abort will end the wait
        onNotification("turn/started", { turn: { id: "t_xyz" } });
        return {};
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    const result = await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    const interruptCalls = captured.filter((entry) => entry.method === "turn/interrupt");
    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0]?.params).toMatchObject({ threadId: "th_1", turnId: "t_xyz" });
  });

  it("forwards mcp servers in thread/start params", async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const factory = stubClient(({ onNotification }) => async (request) => {
      if (request.method === "thread/start") {
        receivedParams = request.params;
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        onNotification("turn/started", { turnId: "t1" });
        onNotification("turn/completed", {});
        return {};
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      mcpServers: {
        github: { type: "http", url: "http://localhost:8000" },
        local: { command: "node" },
      },
    });

    expect(receivedParams?.mcp_servers).toEqual({
      github: { enabled: true, required: false, url: "http://localhost:8000" },
      local: { enabled: true, required: false, command: "node" },
    });
  });

  it("preserves host Codex auth home and disables project docs by default", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/Users/example/.codex";
    let receivedInput: CodexClientFactoryInput | undefined;
    const factory = stubClient((input) => {
      receivedInput = input;
      return async (request) => {
        if (request.method === "thread/start") {
          return { threadId: "th_1" };
        }
        if (request.method === "turn/start") {
          input.onNotification("turn/started", { turnId: "t1" });
          input.onNotification("turn/completed", {});
        }
        return {};
      };
    });

    try {
      const runtime = createCodexAppRuntime({ clientFactory: factory });
      await runtime.run("system", {
        model: { sdk: "codex", model: "gpt-5.5" },
        messages: [{ role: "user", content: "Hi" }],
        abortSignal: new AbortController().signal,
      });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }

    expect(receivedInput?.env.CODEX_HOME).toBe("/Users/example/.codex");
    expect(receivedInput?.args).toContain("-c");
    expect(receivedInput?.args).toContain("project_doc_max_bytes=0");
  });

  it("keeps explicit host-provided Codex env and API key values", async () => {
    let receivedInput: CodexClientFactoryInput | undefined;
    const factory = stubClient((input) => {
      receivedInput = input;
      return async (request) => {
        if (request.method === "thread/start") {
          return { threadId: "th_1" };
        }
        if (request.method === "turn/start") {
          input.onNotification("turn/started", { turnId: "t1" });
          input.onNotification("turn/completed", {});
        }
        return {};
      };
    });
    const runtime = createCodexAppRuntime({
      clientFactory: factory,
      apiKey: "test-api-key",
      apiKeyEnv: "TEST_OPENAI_API_KEY",
      codexHome: "/tmp/host-provided-codex-home",
      env: { MONO_AGENT_TEST_ENV: "kept" },
    });

    await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(receivedInput?.env.CODEX_HOME).toBe("/tmp/host-provided-codex-home");
    expect(receivedInput?.env.TEST_OPENAI_API_KEY).toBe("test-api-key");
    expect(receivedInput?.env.MONO_AGENT_TEST_ENV).toBe("kept");
  });

  it("sends only host-provided instructions and MCP config to thread/start", async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const factory = stubClient(({ onNotification }) => async (request) => {
      if (request.method === "thread/start") {
        receivedParams = request.params;
        return { threadId: "th_1" };
      }
      if (request.method === "turn/start") {
        onNotification("turn/started", { turnId: "t1" });
        onNotification("turn/completed", {});
      }
      return {};
    });
    const runtime = createCodexAppRuntime({ clientFactory: factory });

    await runtime.run("provided system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
      mcpServers: {
        provided: { command: "node", args: ["server.js"] },
      },
    });

    expect(receivedParams).toMatchObject({
      model: "gpt-5.5",
      instructions: "provided system",
      mcp_servers: {
        provided: { enabled: true, required: false, command: "node", args: ["server.js"] },
      },
    });
    expect(receivedParams).not.toHaveProperty("skills");
    expect(receivedParams).not.toHaveProperty("mcpServers");
  });

  it("includes diagnostics with thread start attempts and stderr tail", async () => {
    const factory = stubClient(() => async () => undefined, "stderr line 1\nstderr line 2");
    const runtime = createCodexAppRuntime({
      clientFactory: factory,
      threadStartAttempts: 1,
    });

    const result = await runtime.run("system", {
      model: { sdk: "codex", model: "gpt-5.5" },
      messages: [{ role: "user", content: "Hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(result.diagnostics).toBeDefined();
    const diag = result.diagnostics as Record<string, unknown>;
    expect(diag.codex_thread_start_attempts).toBe(1);
    expect(diag.stderr_tail).toBe("stderr line 1\nstderr line 2");
  });

  it("rejects empty system prompt", async () => {
    const runtime = createCodexAppRuntime({ clientFactory: stubClient(() => async () => undefined) });
    await expect(
      runtime.run("", {
        model: { sdk: "codex", model: "gpt-5.5" },
        messages: [{ role: "user", content: "Hi" }],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CodexAppRuntimeError);
  });
});

describe("codex-events port", () => {
  it("normalizeCodexItemType maps known types", () => {
    expect(normalizeCodexItemType("commandExecution")).toBe("command_execution");
    expect(normalizeCodexItemType("mcpToolCall")).toBe("mcp_tool_call");
    expect(normalizeCodexItemType("fileChange")).toBe("file_change");
    expect(normalizeCodexItemType("agentMessage")).toBe("agent_message");
    expect(normalizeCodexItemType("unknown")).toBe("unknown");
    expect(normalizeCodexItemType(undefined)).toBe("");
  });

  it("normalizeCodexItemEvent emits tool_use on item.started and tool_result on item.completed for mcpToolCall", () => {
    const started = normalizeCodexItemEvent({
      type: "item.started",
      item: { id: "mcp_1", type: "mcpToolCall", server: "github", tool: "list_repos", arguments: { org: "x" } },
    });
    expect(started).not.toBeNull();
    expect(started?.type).toBe("assistant");

    const completed = normalizeCodexItemEvent({
      type: "item.completed",
      item: {
        id: "mcp_1",
        type: "mcpToolCall",
        server: "github",
        tool: "list_repos",
        result: { content: "ok" },
      },
    });
    expect(completed?.type).toBe("user");
  });

  it("normalizeCodexItemEvent returns null for unsupported notifications", () => {
    expect(normalizeCodexItemEvent({ type: "something_else", item: { type: "x" } })).toBeNull();
    expect(normalizeCodexItemEvent(undefined)).toBeNull();
  });
});

describe("translations", () => {
  it("translateMcpServersForCodex skips malformed names and unknown shapes", () => {
    expect(
      translateMcpServersForCodex({
        ok: { command: "node", args: ["s.js"] },
        also_ok: { url: "http://x" },
        "bad name": { command: "node" },
        weird: { foo: "bar" },
      }),
    ).toEqual({
      ok: { enabled: true, required: false, command: "node", args: ["s.js"] },
      also_ok: { enabled: true, required: false, url: "http://x" },
    });
  });
});

interface StubBehavior {
  (input: CodexClientFactoryInput): (request: JsonRpcRequest) => Promise<unknown>;
}

function stubClient(behavior: StubBehavior, stderr = ""): (input: CodexClientFactoryInput) => JsonRpcClient {
  return (input) => {
    const handler = behavior(input);
    const client: JsonRpcClient = {
      request: vi.fn(async (request: JsonRpcRequest) => {
        const result = await handler(request);
        return result;
      }) as JsonRpcClient["request"],
      close: vi.fn(async () => undefined),
      stderrTail: () => stderr,
    };
    return client;
  };
}
