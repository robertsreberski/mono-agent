import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexAppServerClient, generateCodexAppResponse } from "../../ai/providers/codex-app.js";
import { disposeAllProviderSessions, disposeProviderSession } from "../../ai/runtime/sessions.js";

// Fake app-server client driven through options.codexClientFactory: records
// every request, emits notifications through the onNotification callback the
// bridge hands it, and lets tests resolve `closed` to simulate process exit.
function stubClientFactory({ threadId = "thread-1", turnText = "hello" } = {}) {
  const clients = [];
  // Consumed (shift) per turn/start: "auto" (default), "manual", "fail".
  const turnPlan = [];
  const factory = vi.fn(({ onNotification, onServerRequest }) => {
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const requests = [];
    let turnCounter = 0;
    const notify = (method, params) => onNotification({ method, params });
    const client = {
      child: null,
      closed,
      requests,
      notify,
      serverRequest: (method, params = {}, id = 9_001) => onServerRequest({ id, method, params }),
      finishTurn: null,
      resolveClosed: (err) => resolveClosed(err || new Error("codex app-server exited 1")),
      close: vi.fn(() => { resolveClosed(new Error("codex app-server closed")); }),
      request: vi.fn(async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: threadId } };
        if (method === "turn/start") {
          turnCounter += 1;
          const turnId = `turn-${turnCounter}`;
          const mode = turnPlan.shift() || "auto";
          const finish = ({ status = "completed", text = turnText } = {}) => {
            if (text) notify("item/completed", { item: { id: `msg-${turnId}`, type: "agentMessage", text } });
            notify("turn/completed", {
              turn: { id: turnId, status, ...(status === "failed" ? { error: { message: "codex turn failed" } } : {}) },
            });
          };
          queueMicrotask(() => {
            notify("turn/started", { turn: { id: turnId } });
            if (mode === "auto") finish();
            else if (mode === "fail") finish({ status: "failed", text: "" });
            else client.finishTurn = finish;
          });
          return { turn: { id: turnId } };
        }
        if (method === "turn/interrupt") {
          queueMicrotask(() => client.finishTurn?.({ status: "interrupted", text: "partial output" }));
          return {};
        }
        return {};
      }),
    };
    clients.push(client);
    return client;
  });
  factory.clients = clients;
  factory.turnPlan = turnPlan;
  return factory;
}

const model = { sdk: "codex", model: "gpt-5.1-codex", reference: "codex:gpt-5.1-codex" };

function runOptions(factory, overrides = {}) {
  return {
    model,
    messages: [{ role: "user", content: "hi" }],
    codexClientFactory: factory,
    ...overrides,
  };
}

afterEach(async () => {
  await disposeAllProviderSessions();
  vi.clearAllMocks();
});

describe("codex-app persistent sessions", () => {
  it.each([
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ])("forwards the direct %s model unchanged to the Codex app-server", async (modelId) => {
    const factory = stubClientFactory({ threadId: `thread-${modelId}` });
    const directModel = { sdk: "codex", model: modelId, reference: `codex:${modelId}` };

    const result = await generateCodexAppResponse("SYS", runOptions(factory, { model: directModel }));

    expect(result.error).toBeNull();
    const client = factory.clients[0];
    expect(client.requests.find((request) => request.method === "thread/start")?.params.model).toBe(modelId);
    expect(client.requests.find((request) => request.method === "turn/start")?.params.model).toBe(modelId);
    expect(result.model).toBe(`codex:${modelId}`);
  });

  it.each([
    ["default (unset)", undefined, "workspace-write", "workspaceWrite"],
    ["default", "default", "workspace-write", "workspaceWrite"],
    ["plan", "plan", "read-only", "readOnly"],
    ["acceptEdits", "acceptEdits", "workspace-write", "workspaceWrite"],
    ["bypassPermissions", "bypassPermissions", "danger-full-access", "dangerFullAccess"],
  ])("maps %s permission mode into supported app-server payload policy", async (
    _label,
    permissionMode,
    sandbox,
    sandboxPolicyType,
  ) => {
    const factory = stubClientFactory({ threadId: `thread-${_label}` });
    const result = await generateCodexAppResponse("SYS", runOptions(factory, {
      permissionMode,
      cwd: "/workspace",
    }));
    expect(result.error).toBeNull();

    const client = factory.clients[0];
    const threadStart = client.requests.find((r) => r.method === "thread/start");
    const turnStart = client.requests.find((r) => r.method === "turn/start");

    expect(threadStart?.params.approvalPolicy).toBe("never");
    expect(threadStart?.params.sandbox).toBe(sandbox);
    expect(turnStart?.params.approvalPolicy).toBe("never");
    expect(turnStart?.params.sandboxPolicy).toMatchObject({ type: sandboxPolicyType });
    if (sandboxPolicyType === "workspaceWrite") {
      expect(turnStart?.params.sandboxPolicy).toMatchObject({
        writableRoots: ["/workspace"],
        networkAccess: false,
      });
    }
    expect(threadStart?.params.approvalPolicy).not.toBe("on-failure");
    expect(turnStart?.params.approvalPolicy).not.toBe("on-failure");
  });

  it("fails closed before starting Codex when a restrictive tool policy cannot be enforced", async () => {
    const factory = stubClientFactory();

    const result = await generateCodexAppResponse("SYS", runOptions(factory, {
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: [],
    }));

    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: { codex_error_code: "codex_tool_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce allowedTools/disallowedTools");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed before starting Codex when a native mono-agent sandbox is supplied", async () => {
    const factory = stubClientFactory();

    const result = await generateCodexAppResponse("SYS", runOptions(factory, {
      sandboxPolicy: {
        mode: "native",
        readableRoots: ["/workspace"],
        writableRoots: ["/workspace"],
        denyWrite: [".env"],
        network: { mode: "localhost" },
      },
    }));

    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: { codex_error_code: "codex_sandbox_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce mono-agent's native srt sandbox scopes");
    expect(result.error).toContain("use a Pi runtime");
    expect(result.error).not.toContain("Pi/Claude");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails an unexpected app-server request immediately instead of hanging the turn", async () => {
    const factory = stubClientFactory({ threadId: "thread-server-request" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());

    expect(() => factory.clients[0].serverRequest("item/commandExecution/requestApproval", {
      threadId: "thread-server-request",
      turnId: "turn-1",
      itemId: "command-1",
    })).toThrow("Unsupported Codex app-server request");

    await expect(pending).resolves.toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: {
        codex_error_code: "codex_server_request_unsupported",
        codex_server_request_method: "item/commandExecution/requestApproval",
      },
    });
  });

  it("writes a JSON-RPC response for inbound app-server requests", async () => {
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      let originalId;
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === 9001 && (message.result !== undefined || message.error !== undefined)) {
          send({ id: originalId, result: { serverResult: message.result, serverError: message.error } });
          return;
        }
        originalId = message.id;
        send({ id: 9001, method: "item/commandExecution/requestApproval", params: {} });
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      onServerRequest: () => ({ decision: "decline" }),
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({
        serverResult: { decision: "decline" },
      });
    } finally {
      client.close();
    }
  });

  it("runs the dedicated no-tool probe read-only and interrupts the first tool action", async () => {
    const factory = stubClientFactory({ threadId: "thread-no-tools" });
    factory.turnPlan.push("manual");
    const emitted = [];

    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      codexNoToolsProbe: true,
      sessionKeepAlive: false,
      nativeSubagents: { mode: "auto" },
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => {
      expect(factory.clients[0]?.finishTurn).toBeTruthy();
    });
    const client = factory.clients[0];
    client.notify("item/started", {
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "pwd",
        status: "inProgress",
      },
    });
    const result = await pending;

    expect(result.cancelled).toBe(false);
    expect(result.failureKind).toBe("tool_policy_violation");
    expect(result.diagnostics).toMatchObject({
      codex_error_code: "codex_no_tools_violation",
      codex_tool_action: "commandExecution",
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "codex_no_tools_violation",
    }));
    const threadStart = client.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: { mcp_servers: {} },
    });
    const turnStart = client.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(client.requests.some((request) => request.method === "collaborationMode/list")).toBe(false);
    expect(client.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
    expect(client.close).toHaveBeenCalled();
  });

  it("keeps the client alive under sessionKeepAlive and resumes with only turn/start", async () => {
    const factory = stubClientFactory({ threadId: "thread-keep" });
    const first = await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));
    expect(first.error).toBeNull();
    expect(first.failureKind).toBeNull();
    expect(first.providerSessionId).toBe("thread-keep");
    expect(factory).toHaveBeenCalledTimes(1);
    const client = factory.clients[0];
    expect(client.requests.map((r) => r.method)).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(client.close).not.toHaveBeenCalled();

    const second = await generateCodexAppResponse("SYS", runOptions(factory, {
      sessionId: "thread-keep",
      messages: [{ role: "user", content: "follow up" }],
    }));
    expect(second.error).toBeNull();
    expect(second.failureKind).toBeNull();
    expect(second.providerSessionId).toBe("thread-keep");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.requests.map((r) => r.method)).toEqual(["initialize", "thread/start", "turn/start", "turn/start"]);
    const resumedTurn = client.requests[3];
    expect(resumedTurn.params.threadId).toBe("thread-keep");
    expect(resumedTurn.params.input).toEqual([{ type: "text", text: "follow up", text_elements: [] }]);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("fails fast with session_not_found instead of starting fresh", async () => {
    const factory = stubClientFactory();
    const result = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "nope" }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.error).toMatch(/not live/);
    expect(result.text).toBeNull();
    expect(result.numTurns).toBe(0);
    expect(result.providerSessionId).toBe("nope");
    expect(result.cancelled).toBe(false);
    expect(result.diagnostics.codex_error_code).toBe("codex_session_not_found");
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns session_busy while the session is executing a turn", async () => {
    const factory = stubClientFactory({ threadId: "thread-busy" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    factory.turnPlan.push("manual");
    const inFlight = generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-busy" }));
    const busy = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-busy" }));
    expect(busy.failureKind).toBe("session_busy");
    expect(busy.providerSessionId).toBe("thread-busy");
    expect(busy.diagnostics.codex_error_code).toBe("codex_session_busy");
    expect(factory).toHaveBeenCalledTimes(1);

    const client = factory.clients[0];
    await vi.waitFor(() => { expect(client.finishTurn).toBeTruthy(); });
    client.finishTurn();
    const first = await inFlight;
    expect(first.error).toBeNull();
    expect(first.failureKind).toBeNull();
  });

  it("interrupts an aborted resumed turn without closing the session", async () => {
    const factory = stubClientFactory({ threadId: "thread-abort" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    factory.turnPlan.push("manual");
    const controller = new AbortController();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      sessionId: "thread-abort",
      abortSignal: controller.signal,
    }));
    const client = factory.clients[0];
    await vi.waitFor(() => { expect(client.finishTurn).toBeTruthy(); });
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(client.requests.some((r) => r.method === "turn/interrupt")).toBe(true);
    expect(client.close).not.toHaveBeenCalled();

    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-abort" }));
    expect(resumed.error).toBeNull();
    expect(resumed.failureKind).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("an aborted resumed turn with no output resolves (no hang) and keeps the session alive", async () => {
    const factory = stubClientFactory({ threadId: "thread-abort-empty" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    const client = factory.clients[0];
    factory.turnPlan.push("manual");
    // Interrupt produces no turn/completed at all: the turn just dies.
    client.request.mockImplementation(async (method, params) => {
      client.requests.push({ method, params });
      if (method === "turn/start") {
        queueMicrotask(() => client.notify("turn/started", { turn: { id: "turn-dead" } }));
        return { turn: { id: "turn-dead" } };
      }
      return {};
    });
    const controller = new AbortController();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      sessionId: "thread-abort-empty",
      abortSignal: controller.signal,
    }));
    await vi.waitFor(() => {
      expect(client.requests.some((r) => r.method === "turn/start" && r.params.threadId === "thread-abort-empty")).toBe(true);
    });
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(client.requests.some((r) => r.method === "turn/interrupt")).toBe(true);
    expect(client.close).not.toHaveBeenCalled();

    // The session survives the empty abort and stays resumable.
    client.request.mockImplementation(async (method, params) => {
      client.requests.push({ method, params });
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.notify("turn/started", { turn: { id: "turn-next" } });
          client.notify("item/completed", { item: { id: "msg-next", type: "agentMessage", text: "back" } });
          client.notify("turn/completed", { turn: { id: "turn-next", status: "completed" } });
        });
        return { turn: { id: "turn-next" } };
      }
      return {};
    });
    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-abort-empty" }));
    expect(resumed.error).toBeNull();
    expect(resumed.text).toBe("back");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("resumed turns carry the full turn parameters (model, effort, outputSchema)", async () => {
    const factory = stubClientFactory({ threadId: "thread-params" });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true, effort: "high", outputSchema: schema }));

    await generateCodexAppResponse("SYS", runOptions(factory, {
      sessionId: "thread-params",
      effort: "high",
      outputSchema: schema,
      messages: [{ role: "user", content: "again" }],
    }));
    const client = factory.clients[0];
    const resumedTurn = client.requests.filter((r) => r.method === "turn/start")[1];
    expect(resumedTurn.params.model).toBe(model.model);
    expect(resumedTurn.params.effort).toBe("high");
    expect(resumedTurn.params.summary).toBe("auto");
    expect(resumedTurn.params.outputSchema).toEqual(schema);
    expect(resumedTurn.params.threadId).toBe("thread-params");
  });

  it("closes the client and registers nothing when the keep-alive turn fails", async () => {
    const factory = stubClientFactory({ threadId: "thread-fail" });
    factory.turnPlan.push("fail");
    const result = await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));
    expect(result.error).toMatch(/codex turn failed/);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(factory.clients[0].close).toHaveBeenCalled();

    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-fail" }));
    expect(resumed.failureKind).toBe("session_not_found");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("evicts the session when the app-server subprocess exits", async () => {
    const factory = stubClientFactory({ threadId: "thread-exit" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    factory.clients[0].resolveClosed();
    await factory.clients[0].closed;
    await Promise.resolve();

    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-exit" }));
    expect(resumed.failureKind).toBe("session_not_found");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("still closes the client after a successful run without sessionKeepAlive", async () => {
    const factory = stubClientFactory({ threadId: "thread-plain" });
    const result = await generateCodexAppResponse("SYS", runOptions(factory));
    expect(result.error).toBeNull();
    expect(result.providerSessionId).toBe("thread-plain");
    expect(factory.clients[0].close).toHaveBeenCalled();

    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-plain" }));
    expect(resumed.failureKind).toBe("session_not_found");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("disposeProviderSession (runtime disposeSession surface) closes the live client", async () => {
    const factory = stubClientFactory({ threadId: "thread-dispose" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    const disposed = await disposeProviderSession("thread-dispose");
    expect(disposed).toBe(true);
    expect(factory.clients[0].close).toHaveBeenCalled();

    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-dispose" }));
    expect(resumed.failureKind).toBe("session_not_found");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
