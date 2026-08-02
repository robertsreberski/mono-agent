import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      close: vi.fn(async () => { resolveClosed(new Error("codex app-server closed")); }),
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

function nonSettlingLiveInput() {
  const iterator = {
    next: vi.fn(() => new Promise(() => {})),
    return: vi.fn(() => new Promise(() => {})),
  };
  return {
    liveInput: {
      [Symbol.asyncIterator]: () => iterator,
    },
    iterator,
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
    ["omitted", undefined, ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"]],
    ["disabled", false, ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"]],
    ["enabled", true, ["app-server", "--listen", "stdio://"]],
  ])("uses the expected project-document loading args when codexLoadProjectDocs is %s", async (
    _label,
    codexLoadProjectDocs,
    expectedArgs,
  ) => {
    const factory = stubClientFactory({ threadId: `thread-project-docs-${_label}` });

    const result = await generateCodexAppResponse("SYS", runOptions(factory, { codexLoadProjectDocs }));

    expect(result.error).toBeNull();
    expect(factory.mock.calls[0]?.[0]?.args).toEqual(expectedArgs);
  });

  it("lets explicit codexAppServerArgs override codexLoadProjectDocs", async () => {
    const factory = stubClientFactory({ threadId: "thread-explicit-app-server-args" });
    const explicitArgs = ["custom-app-server", "--flag"];

    const result = await generateCodexAppResponse("SYS", runOptions(factory, {
      codexLoadProjectDocs: true,
      codexAppServerArgs: explicitArgs,
    }));

    expect(result.error).toBeNull();
    expect(factory.mock.calls[0]?.[0]?.args).toBe(explicitArgs);
  });

  it("clamps effort max to xhigh across the app-server thread and turn payloads", async () => {
    const factory = stubClientFactory({ threadId: "thread-effort" });

    const result = await generateCodexAppResponse("SYS", runOptions(factory, { effort: "max" }));

    expect(result.error).toBeNull();
    const client = factory.clients[0];
    const threadStart = client.requests.find((request) => request.method === "thread/start");
    const turnStart = client.requests.find((request) => request.method === "turn/start");
    expect(threadStart?.params.config?.model_reasoning_effort).toBe("xhigh");
    expect(threadStart?.params.config?.model_reasoning_summary).toBe("auto");
    expect(turnStart?.params.effort).toBe("xhigh");
    expect(turnStart?.params.summary).toBe("auto");
  });

  it("passes effort xhigh through unchanged to the app-server", async () => {
    const factory = stubClientFactory({ threadId: "thread-effort-xhigh" });

    const result = await generateCodexAppResponse("SYS", runOptions(factory, { effort: "xhigh" }));

    expect(result.error).toBeNull();
    const turnStart = factory.clients[0].requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params.effort).toBe("xhigh");
  });

  it("passes effort ultra through unchanged to the app-server", async () => {
    const factory = stubClientFactory({ threadId: "thread-effort-ultra" });

    const result = await generateCodexAppResponse("SYS", runOptions(factory, { effort: "ultra" }));

    expect(result.error).toBeNull();
    const client = factory.clients[0];
    const threadStart = client.requests.find((request) => request.method === "thread/start");
    const turnStart = client.requests.find((request) => request.method === "turn/start");
    expect(threadStart?.params.config?.model_reasoning_effort).toBe("ultra");
    expect(turnStart?.params.effort).toBe("ultra");
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

  it('accepts a wildcard mixed with named tools as an effective allow-all policy', async () => {
    const factory = stubClientFactory({ threadId: "thread-mixed-wildcard" });

    const result = await generateCodexAppResponse("SYS", runOptions(factory, {
      allowedTools: ["*", "Read"],
      disallowedTools: [],
    }));

    expect(result).toMatchObject({
      error: null,
      failureKind: null,
      text: "hello",
    });
    expect(result.diagnostics?.codex_error_code).not.toBe("codex_tool_policy_unsupported");
    expect(factory).toHaveBeenCalledTimes(1);
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

  it("auto-approves MCP tool-call elicitations for runtime-configured Codex servers", async () => {
    const factory = stubClientFactory({ threadId: "thread-configured-mcp-approval" });
    factory.turnPlan.push("manual");
    const emitted = [];
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      permissionMode: "plan",
      mcpServers: {
        worklab: { command: "worklab-mcp" },
      },
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());

    const approval = factory.clients[0].serverRequest("mcpServer/elicitation/request", {
      threadId: "thread-configured-mcp-approval",
      turnId: "turn-1",
      serverName: "worklab",
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call" },
      message: 'Allow the worklab MCP server to run tool "journal_append"?',
      requestedSchema: { type: "object", properties: {} },
    });
    expect(approval).toEqual({ action: "accept", content: {}, _meta: null });

    factory.clients[0].finishTurn({ text: "done" });
    await expect(pending).resolves.toMatchObject({
      text: "done",
      error: null,
      failureKind: null,
    });
    expect(emitted).not.toContainEqual(expect.objectContaining({
      warning_kind: "codex_server_request_unsupported",
    }));
  });

  it.each([
    [
      "an unconfigured Codex server",
      { worklab: { command: "worklab-mcp" } },
      {
        serverName: "global-server",
        mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call" },
        message: 'Allow the global-server MCP server to run tool "write"?',
        requestedSchema: { type: "object", properties: {} },
      },
    ],
    [
      "a server definition Codex did not receive",
      { worklab: {} },
      {
        serverName: "worklab",
        mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call" },
        message: 'Allow the worklab MCP server to run tool "journal_append"?',
        requestedSchema: { type: "object", properties: {} },
      },
    ],
    [
      "a genuine downstream MCP elicitation",
      { worklab: { command: "worklab-mcp" } },
      {
        serverName: "worklab",
        mode: "form",
        _meta: null,
        message: "Which journal should receive this note?",
        requestedSchema: {
          type: "object",
          properties: { journal: { type: "string" } },
          required: ["journal"],
        },
      },
    ],
  ])("keeps failing closed for %s", async (_label, mcpServers, requestParams) => {
    const factory = stubClientFactory({ threadId: "thread-rejected-mcp-approval" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      permissionMode: "plan",
      mcpServers,
    }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());

    expect(() => factory.clients[0].serverRequest(
      "mcpServer/elicitation/request",
      {
        threadId: "thread-rejected-mcp-approval",
        turnId: "turn-1",
        ...requestParams,
      },
    )).toThrow("Unsupported Codex app-server request");

    await expect(pending).resolves.toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: {
        codex_error_code: "codex_server_request_unsupported",
        codex_server_request_method: "mcpServer/elicitation/request",
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
      onServerRequest: () => ({ action: "accept", content: {}, _meta: null }),
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({
        serverResult: { action: "accept", content: {}, _meta: null },
      });
    } finally {
      await client.close();
    }
  });

  it("bounds and redacts JSON-RPC errors including the retained responseError", async () => {
    const secret = "fixture-rpc-sensitive-value-1234567890";
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          id: message.id,
          error: {
            code: -32000,
            message: "RPC rejected credential " + process.env.MCP_OPAQUE,
            data: { echo: process.env.MCP_OPAQUE, detail: "x".repeat(32 * 1024) },
          },
        }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      env: { MCP_OPAQUE: secret },
      // The server echoes only the payload, not the complete configured header.
      redactionValues: [`Bearer ${secret}`],
    });
    try {
      const error = await client.request("probe", {}).then(
        () => null,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("RPC rejected credential [REDACTED]");
      expect(error.message).not.toContain(secret);
      expect(error.responseError).toMatchObject({ code: -32000, diagnostic_truncated: true });
      expect(JSON.stringify(error.responseError)).not.toContain(secret);
      expect(Buffer.byteLength(JSON.stringify(error.responseError))).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await client.close();
    }
  });

  it("redacts unknown values under sensitive JSON-RPC payload field names", async () => {
    const fieldSecret = "fixture-field-only-sensitive-value-1234567890";
    const privateKeySecret = "fixture-private-key-sensitive-value-0987654321";
    const apiKeySecret = "fixture-apikey-sensitive-value-1029384756";
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          id: message.id,
          error: {
            code: -32001,
            message: "RPC field validation failed",
            data: {
              nested: {
                accessToken: ${JSON.stringify(fieldSecret)},
                privateKey: ${JSON.stringify(privateKeySecret)},
                APIKEY: ${JSON.stringify(apiKeySecret)},
              },
            },
          },
        }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({ command: process.execPath, args: ["-e", childSource] });
    try {
      const error = await client.request("probe", {}).then(
        () => null,
        (reason) => reason,
      );
      expect(error.message).toBe("RPC field validation failed");
      expect(JSON.stringify(error.responseError)).not.toContain(fieldSecret);
      expect(JSON.stringify(error.responseError)).not.toContain(privateKeySecret);
      expect(JSON.stringify(error.responseError)).not.toContain(apiKeySecret);
      expect(error.responseError.data.nested.accessToken).toBe("[REDACTED]");
      expect(error.responseError.data.nested.privateKey).toBe("[REDACTED]");
      expect(error.responseError.data.nested.APIKEY).toBe("[REDACTED]");
    } finally {
      await client.close();
    }
  });

  it("bounds and redacts malformed app-server stdout before warning delivery", async () => {
    const secret = "fixture-stdout-sensitive-value-1234567890";
    const segmentedEnvSecret = "fixture-segmented-env-sensitive-value-1234567890";
    const compactApiKeySecret = "fixture-compact-apikey-sensitive-value-1234567890";
    const rawPrivateKeySecret = "fixture-raw-private-key-value-1234567890";
    const notifications = [];
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(
          "not-json " + process.env.MCP_OPAQUE +
          " " + process.env.MY_SECRET_VALUE +
          " " + process.env.OPENAI_APIKEY +
          " privateKey=${rawPrivateKeySecret} " + "x".repeat(32 * 1024) + "\\n"
        );
        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      env: {
        MCP_OPAQUE: secret,
        MY_SECRET_VALUE: segmentedEnvSecret,
        OPENAI_APIKEY: compactApiKeySecret,
      },
      redactionValues: [secret],
      onNotification: (notification) => notifications.push(notification),
    });
    try {
      await expect(client.request("probe", {})).resolves.toEqual({ ok: true });
      expect(notifications).toHaveLength(1);
      const message = notifications[0].params.message;
      expect(message).toContain("Malformed Codex app-server output: not-json [REDACTED]");
      expect(message).toContain("[truncated");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(segmentedEnvSecret);
      expect(message).not.toContain(compactApiKeySecret);
      expect(message).not.toContain(rawPrivateKeySecret);
      expect(message).toContain("privateKey=[REDACTED]");
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await client.close();
    }
  });

  it("redacts opaque MCP env and header values from events, warnings, and failed turns", async () => {
    const envSecret = "fixture-mcp-env-sensitive-value-1234567890";
    const headerSecret = "fixture-mcp-header-sensitive-value-0987654321";
    const fieldSecret = "fixture-mcp-field-sensitive-value-1122334455";
    const factory = stubClientFactory({ threadId: "thread-mcp-redaction" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      mcpServers: {
        custom: {
          command: "custom-mcp",
          env: { CUSTOM_CONTEXT: envSecret },
          headers: { Authorization: `Bearer ${headerSecret}` },
        },
      },
    }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];
    client.notify("item/completed", {
      item: {
        id: "mcp-call-1",
        type: "mcpToolCall",
        server: "custom",
        tool: "echo",
        arguments: { input: "safe" },
        result: { content: `echo ${envSecret}` },
        error: `header echo ${headerSecret}`,
        status: "failed",
      },
    });
    client.notify("warning", {
      message: `MCP warning ${envSecret} ${headerSecret} ${"x".repeat(32 * 1024)}`,
    });
    client.notify("item/completed", {
      item: {
        id: "mcp-call-2",
        type: "mcpToolCall",
        server: "custom",
        tool: "field-echo",
        arguments: {},
        result: { content: { accessToken: fieldSecret } },
        status: "completed",
      },
    });
    client.notify("turn/completed", {
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: `MCP turn failed with ${envSecret} and ${headerSecret}` },
      },
    });

    const result = await pending;
    const serialized = JSON.stringify(result);
    expect(factory.mock.calls[0][0].redactionValues).toEqual(expect.arrayContaining([
      envSecret,
      headerSecret,
    ]));
    expect(serialized).not.toContain(envSecret);
    expect(serialized).not.toContain(headerSecret);
    expect(serialized).not.toContain(fieldSecret);
    expect(result.error).toBe("MCP turn failed with [REDACTED] and [REDACTED]");
    const warning = result.events.find((event) => event.warning_kind === "warning");
    expect(warning.message).toContain("MCP warning [REDACTED] [REDACTED]");
    expect(warning.message).toContain("[truncated");
    expect(Buffer.byteLength(warning.message)).toBeLessThanOrEqual(8 * 1024);
    const mcpEvent = result.events.find((event) => JSON.stringify(event).includes("mcp-call-1"));
    expect(JSON.stringify(mcpEvent)).toContain("[REDACTED]");
    const fieldEvent = result.events.find((event) => JSON.stringify(event).includes("mcp-call-2"));
    expect(JSON.stringify(fieldEvent)).toContain('"accessToken":"[REDACTED]"');
  });

  it("redacts and bounds MCP credentials in final provider catch results", async () => {
    const secret = "fixture-final-catch-sensitive-value-1234567890";
    const urlPassword = "fixture-url-password/1234567890";
    const querySecret = "fixture-query-sensitive-value/1234567890";
    const mcpCliSecret = "fixture-mcp-cli-sensitive-value-1234567890";
    const codexCliSecret = "fixture-codex-cli-sensitive-value-1234567890";
    const inlineUrlPassword = "fixture-inline-url-password-1234567890";
    const inlineQuerySecret = "fixture-inline-query-sensitive-value-1234567890";
    const inlineHeaderSecret = "fixture-inline-header-sensitive-value-1234567890";
    const basicPassword = "fixture-basic-password-sensitive-value-1234567890";
    const basicPayload = Buffer.from(`fixture-basic-user:${basicPassword}`, "utf8").toString("base64");
    const rawPrivateKeySecret = "fixture-unregistered-private-key-value-1234567890";
    const factory = vi.fn(({ redactionValues }) => {
      let resolveClosed;
      const closed = new Promise((resolve) => { resolveClosed = resolve; });
      return {
        closed,
        request: vi.fn(async () => {
          throw Object.assign(
            new Error(
              `Initialization failed with ${secret} ${urlPassword} ${querySecret} ` +
              `${mcpCliSecret} ${codexCliSecret} ${inlineUrlPassword} ${inlineQuerySecret} ` +
              `${inlineHeaderSecret} ${basicPassword} privateKey=${rawPrivateKeySecret} ${"x".repeat(32 * 1024)}`,
            ),
            { code: `PROVIDER_${secret}` },
          );
        }),
        close: vi.fn(async () => resolveClosed(new Error("codex app-server closed"))),
        redactionValues,
      };
    });

    const result = await generateCodexAppResponse("SYS", runOptions(factory, {
      codexAppServerArgs: ["app-server", "--api-key", codexCliSecret],
      mcpServers: {
        custom: { command: "custom-mcp", env: { CUSTOM_CONTEXT: secret } },
        remote: {
          url: `https://fixture-user:${encodeURIComponent(urlPassword)}@mcp.invalid/rpc?access_token=${encodeURIComponent(querySecret)}`,
          headers: { "Proxy-Authorization": `Basic ${basicPayload}` },
        },
        local: {
          command: "local-mcp",
          args: [
            `--token=${mcpCliSecret}`,
            `--endpoint=https://inline-user:${encodeURIComponent(inlineUrlPassword)}@mcp.invalid/rpc?sig=${encodeURIComponent(inlineQuerySecret)}`,
            `--header=Authorization: Bearer ${inlineHeaderSecret}`,
          ],
        },
      },
    }));

    expect(factory.mock.calls[0][0].redactionValues).toEqual(expect.arrayContaining([
      secret,
      urlPassword,
      querySecret,
      mcpCliSecret,
      codexCliSecret,
      inlineUrlPassword,
      inlineQuerySecret,
      inlineHeaderSecret,
      basicPassword,
    ]));
    for (const sensitiveValue of [
      secret,
      urlPassword,
      querySecret,
      mcpCliSecret,
      codexCliSecret,
      inlineUrlPassword,
      inlineQuerySecret,
      inlineHeaderSecret,
      basicPassword,
    ]) {
      expect(JSON.stringify(result)).not.toContain(sensitiveValue);
    }
    expect(JSON.stringify(result)).not.toContain(rawPrivateKeySecret);
    expect(result.error).toContain("privateKey=[REDACTED]");
    expect(result.error).toContain("Initialization failed with [REDACTED]");
    expect(result.error).toContain("[truncated");
    expect(Buffer.byteLength(result.error)).toBeLessThanOrEqual(8 * 1024);
    expect(result.diagnostics.codex_error_code).toBe("PROVIDER_[REDACTED]");
  });

  it("bounds and redacts app-server stderr before it reaches errors", async () => {
    const secret = "fixture-sensitive-value-1234567890";
    const basicCredential = Buffer.from(["fixture-user", "fixture-password"].join(":"), "utf8").toString("base64");
    const plainJsonCredential = "remaining-plain-json-secret-24680";
    const escapedJsonCredential = "remaining-escaped-json-secret-13579";
    const plainJson = `{"token":"prefix\\"${plainJsonCredential}"}`;
    const escapedJson = `{"token":"prefix\\"${escapedJsonCredential}"}`
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    const boundarySuffix = secret.slice(-12);
    const diagnosticSuffix =
      `\nOPENAI_API_KEY=${secret}\n` +
      `Authorization: Basic ${basicCredential}\n` +
      `${plainJson}\n` +
      `${escapedJson}\n`;
    const paddingBytes = (8 * 1024) - Buffer.byteLength(boundarySuffix) - Buffer.byteLength(diagnosticSuffix);
    const childSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", () => {
        process.stderr.write("x".repeat(64 * 1024));
        process.stderr.write(process.env.OPENAI_API_KEY);
        process.stderr.write("z".repeat(${paddingBytes}));
        process.stderr.write(${JSON.stringify(diagnosticSuffix)}, () => process.exit(7));
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      env: { OPENAI_API_KEY: secret },
      shutdownGraceMs: 25,
      killGraceMs: 250,
    });
    try {
      const error = await client.request("probe", {}).then(
        () => null,
        (reason) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(boundarySuffix);
      expect(error.message).not.toContain(basicCredential);
      expect(error.message).not.toContain(plainJsonCredential);
      expect(error.message).not.toContain(escapedJsonCredential);
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual((8 * 1024) + 128);

      const closedError = await client.closed;
      expect(closedError.message).not.toContain(secret);
      expect(Buffer.byteLength(closedError.message)).toBeLessThanOrEqual((8 * 1024) + 128);
    } finally {
      await client.close();
    }
  });

  it.skipIf(process.platform === "win32")("escalates to SIGKILL and fully settles one idempotent close promise", async () => {
    const childSource = `
      const readline = require("node:readline");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      shutdownGraceMs: 25,
      killGraceMs: 500,
    });
    const pid = client.child.pid;
    if (typeof pid !== "number") throw new Error("fixture child did not start");
    try {
      await expect(client.request("ready", {})).resolves.toEqual({ ready: true });
      const firstClose = client.close();
      const secondClose = client.close();
      expect(secondClose).toBe(firstClose);
      await firstClose;

      expect(client.child.signalCode).toBe("SIGKILL");
      expect(client.child.listenerCount("error")).toBe(0);
      expect(client.child.listenerCount("close")).toBe(0);
      expect(client.child.stderr.listenerCount("data")).toBe(0);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(client.closed).resolves.toMatchObject({ message: "codex app-server closed" });
    } finally {
      await client.close();
    }
  });

  it.skipIf(process.platform === "win32")("does not treat a failed SIGTERM as process exit", async () => {
    const childSource = `
      const readline = require("node:readline");
      setInterval(() => {}, 1_000);
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + "\\n");
      });
    `;
    const client = createCodexAppServerClient({
      command: process.execPath,
      args: ["-e", childSource],
      shutdownGraceMs: 25,
      killGraceMs: 500,
    });
    const originalKill = client.child.kill.bind(client.child);
    const signals = [];
    client.child.kill = vi.fn((signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        queueMicrotask(() => client.child.emit(
          "error",
          Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
        ));
        return false;
      }
      return originalKill(signal);
    });
    try {
      await expect(client.request("ready", {})).resolves.toEqual({ ready: true });
      await client.close();

      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(client.child.signalCode).toBe("SIGKILL");
      expect(client.child.listenerCount("error")).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("awaits asynchronous client teardown before returning a disposable run", async () => {
    const factory = stubClientFactory({ threadId: "thread-async-close" });
    factory.turnPlan.push("manual");
    let releaseClose = () => {};
    const closeGate = new Promise((resolve) => { releaseClose = resolve; });
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];
    client.close = vi.fn(async () => {
      await closeGate;
      client.resolveClosed(new Error("codex app-server closed"));
    });

    client.finishTurn();
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
    let returned = false;
    void pending.then(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);

    releaseClose();
    const result = await pending;
    expect(result.error).toBeNull();
    expect(returned).toBe(true);
  });

  it("acknowledges live input only after turn/steer accepts it", async () => {
    const factory = stubClientFactory({ threadId: "thread-live-input" });
    factory.turnPlan.push("manual");
    const emitted = [];
    let releaseInput = () => {};
    const inputReady = new Promise((resolve) => { releaseInput = resolve; });
    const acknowledge = vi.fn();
    const reject = vi.fn();
    const liveInput = (async function* () {
      await inputReady;
      yield { body: "Use the stricter constraint", id: "live-1", acknowledge, reject };
    })();

    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      liveInput,
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    releaseInput();
    await vi.waitFor(() => expect(
      factory.clients[0]?.requests.some((request) => request.method === "turn/steer"),
    ).toBe(true));
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    const steer = factory.clients[0]?.requests.find((request) => request.method === "turn/steer");
    expect(steer?.params).toMatchObject({
      threadId: "thread-live-input",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: expect.stringContaining("Use the stricter constraint") }],
    });

    factory.clients[0]?.finishTurn();
    await expect(pending).resolves.toMatchObject({ error: null, text: "hello" });
    expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
  });

  it("preserves accepted steering when the acknowledge callback throws", async () => {
    const factory = stubClientFactory({ threadId: "thread-live-input-ack-throws" });
    factory.turnPlan.push("manual");
    const emitted = [];
    const acknowledge = vi.fn(() => {
      throw new Error(`acknowledge hook failed ${"x".repeat(4 * 1024)}`);
    });
    const reject = vi.fn();
    const liveInput = (async function* () {
      yield { body: "Keep the accepted steering", id: "live-ack-throws", acknowledge, reject };
    })();

    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      liveInput,
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => expect(
      factory.clients[0]?.requests.some((request) => request.method === "turn/steer"),
    ).toBe(true));
    factory.clients[0].finishTurn();
    const result = await pending;

    expect(result).toMatchObject({ error: null, failureKind: null, text: "hello" });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    const warning = emitted.find((event) => event.warning_kind === "live_input_callback_failed");
    expect(warning?.message).toContain("Live-input acknowledge callback failed");
    expect(Buffer.byteLength(warning?.message || "")).toBeLessThanOrEqual(1_024);
    expect(emitted.some((event) => event.warning_kind === "live_input_rejected")).toBe(false);
    expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
  });

  it("preserves native steering rejection when the reject callback throws", async () => {
    const factory = stubClientFactory({ threadId: "thread-live-input-reject-throws" });
    factory.turnPlan.push("manual");
    let releaseInput = () => {};
    const inputReady = new Promise((resolve) => { releaseInput = resolve; });
    const emitted = [];
    const acknowledge = vi.fn();
    const reject = vi.fn(() => {
      throw new Error("reject hook failed");
    });
    const liveInput = (async function* () {
      await inputReady;
      yield { body: "This steer will be rejected", id: "live-reject-throws", acknowledge, reject };
    })();

    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      liveInput,
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];
    const nativeError = new Error("native turn/steer rejected");
    client.request.mockImplementation(async (method, params) => {
      client.requests.push({ method, params });
      if (method === "turn/steer") throw nativeError;
      return {};
    });
    releaseInput();
    await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    client.finishTurn();
    const result = await pending;

    expect(result).toMatchObject({ error: null, failureKind: null, text: "hello" });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(nativeError);
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "live_input_rejected",
      message: "native turn/steer rejected",
    }));
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "live_input_callback_failed",
      message: expect.stringContaining("Live-input reject callback failed"),
    }));
    expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
  });

  it("settles transport failure while live-input next and return never settle", async () => {
    const factory = stubClientFactory({ threadId: "thread-live-input-close" });
    factory.turnPlan.push("manual");
    const emitted = [];
    const { liveInput, iterator } = nonSettlingLiveInput();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      liveInput,
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => {
      expect(factory.clients[0]?.finishTurn).toBeTruthy();
      expect(iterator.next).toHaveBeenCalledTimes(1);
    });

    factory.clients[0].resolveClosed(new Error("codex app-server exited before completion"));
    const result = await pending;

    expect(result).toMatchObject({
      failureKind: "provider_unavailable",
      diagnostics: { codex_error_code: "codex_app_server_closed" },
    });
    expect(result.error).toContain("codex app-server exited before completion");
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
  });

  it("settles when a real app-server exits with non-settling live input", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "mono-agent-codex-app-exit-"));
    const fixturePath = join(fixtureDirectory, "fake-app-server.cjs");
    const fixtureSource = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (message, callback) => {
        process.stdout.write(JSON.stringify(message) + "\\n", callback);
      };
      rl.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          send({ id: message.id, result: {} });
          return;
        }
        if (message.method === "thread/start") {
          send({ id: message.id, result: { thread: { id: "thread-real-exit" } } });
          return;
        }
        if (message.method === "turn/start") {
          send({ id: message.id, result: { turn: { id: "turn-real-exit" } } }, () => {
            setTimeout(() => process.exit(17), 10);
          });
          return;
        }
        send({ id: message.id, result: {} });
      });
    `;
    await writeFile(fixturePath, fixtureSource, "utf8");
    const emitted = [];
    const { liveInput, iterator } = nonSettlingLiveInput();
    const startedAt = Date.now();
    try {
      const result = await generateCodexAppResponse("SYS", runOptions(null, {
        codexClientFactory: undefined,
        codexAppServerCommand: process.execPath,
        codexAppServerArgs: [fixturePath],
        liveInput,
        onEvent: (event) => emitted.push(event),
      }));

      expect(result).toMatchObject({
        failureKind: "provider_unavailable",
        diagnostics: { codex_error_code: "codex_app_server_closed" },
      });
      expect(result.error).toContain("codex app-server exited");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(iterator.next).toHaveBeenCalledTimes(1);
      expect(iterator.return).toHaveBeenCalledTimes(1);
      expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("stops non-settling live input when an active resumed turn is aborted", async () => {
    const factory = stubClientFactory({ threadId: "thread-live-input-abort" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    factory.turnPlan.push("manual");
    const controller = new AbortController();
    const emitted = [];
    const { liveInput, iterator } = nonSettlingLiveInput();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      sessionId: "thread-live-input-abort",
      abortSignal: controller.signal,
      liveInput,
      onEvent: (event) => emitted.push(event),
    }));
    const client = factory.clients[0];
    await vi.waitFor(() => {
      expect(client.finishTurn).toBeTruthy();
      expect(iterator.next).toHaveBeenCalledTimes(1);
    });

    controller.abort();
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(client.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
    expect(client.close).not.toHaveBeenCalled();
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
  });

  it("stops live input once when abort follows premature transport close", async () => {
    const factory = stubClientFactory({ threadId: "thread-live-input-close-abort" });
    factory.turnPlan.push("manual");
    const controller = new AbortController();
    const emitted = [];
    const { liveInput, iterator } = nonSettlingLiveInput();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      abortSignal: controller.signal,
      liveInput,
      onEvent: (event) => emitted.push(event),
    }));
    const client = factory.clients[0];
    await vi.waitFor(() => {
      expect(client.finishTurn).toBeTruthy();
      expect(iterator.next).toHaveBeenCalledTimes(1);
    });

    client.resolveClosed(new Error("codex app-server transport died"));
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      cancelled: true,
      failureKind: "provider_unavailable",
      diagnostics: { codex_error_code: "codex_app_server_closed" },
    });
    expect(result.error).toContain("codex app-server transport died");
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(emitted.some((event) => event.warning_kind === "live_input_failed")).toBe(false);
  });

  it("keeps current collabToolCall child output isolated until the root turn completes", async () => {
    const factory = stubClientFactory({ threadId: "thread-parent-current" });
    factory.turnPlan.push("manual");
    const emitted = [];
    let settled = false;
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      onEvent: (event) => emitted.push(event),
    }));
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("item/started", {
      threadId: "thread-parent-current",
      turnId: "turn-1",
      item: {
        id: "spawn-current",
        type: "collabToolCall",
        tool: "spawn_agent",
        status: "inProgress",
        senderThreadId: "thread-parent-current",
        prompt: "Inspect the child surface",
      },
    });
    client.notify("item/completed", {
      threadId: "thread-parent-current",
      turnId: "turn-1",
      item: {
        id: "spawn-current",
        type: "collabToolCall",
        tool: "spawn_agent",
        status: "completed",
        senderThreadId: "thread-parent-current",
        newThreadId: "thread-child-current",
        prompt: "Inspect the child surface",
        agentStatus: { status: "running" },
      },
    });
    client.notify("turn/started", {
      threadId: "thread-child-current",
      turn: { id: "turn-child-current", status: "inProgress" },
    });
    client.notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      itemId: "reason-child",
      delta: "checking",
    });
    client.notify("item/started", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: { id: "cmd-child", type: "commandExecution", command: "pwd", status: "inProgress" },
    });
    client.notify("item/completed", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: {
        id: "cmd-child",
        type: "commandExecution",
        command: "pwd",
        status: "completed",
        aggregatedOutput: "/workspace\n",
        exitCode: 0,
        durationMs: 4,
      },
    });
    client.notify("item/started", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: { id: "file-child", type: "fileChange", changes: [], status: "inProgress" },
    });
    client.notify("item/completed", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: { id: "file-child", type: "fileChange", changes: [], status: "completed" },
    });
    client.notify("item/started", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: {
        id: "mcp-child",
        type: "mcpToolCall",
        server: "docs",
        tool: "lookup",
        arguments: { id: "one" },
        status: "inProgress",
      },
    });
    client.notify("item/completed", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: {
        id: "mcp-child",
        type: "mcpToolCall",
        server: "docs",
        tool: "lookup",
        arguments: { id: "one" },
        result: { content: [{ type: "text", text: "found" }] },
        status: "completed",
      },
    });
    client.notify("item/started", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: {
        id: "dynamic-child",
        type: "dynamicToolCall",
        namespace: "tickets",
        tool: "lookup",
        arguments: { id: "ABC" },
        status: "inProgress",
      },
    });
    client.notify("item/completed", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: {
        id: "dynamic-child",
        type: "dynamicToolCall",
        namespace: "tickets",
        tool: "lookup",
        contentItems: [{ type: "inputText", text: "open" }],
        success: true,
        status: "completed",
      },
    });
    client.notify("item/completed", {
      threadId: "thread-child-current",
      turnId: "turn-child-current",
      item: { id: "msg-child", type: "agentMessage", text: "CHILD_DONE" },
    });
    client.notify("turn/completed", {
      threadId: "thread-child-current",
      turn: { id: "turn-child-current", status: "completed" },
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    client.finishTurn({ text: "PARENT_DONE" });
    const result = await pending;

    expect(result).toMatchObject({ text: "PARENT_DONE", error: null, failureKind: null });
    expect(result.events).not.toContainEqual(expect.objectContaining({
      type: "assistant",
      message: { content: [{ type: "text", text: "CHILD_DONE" }] },
    }));
    const activity = emitted.filter((event) => event.type === "subagent_activity");
    expect(activity.map((event) => event.phase)).toEqual([
      "agent_started",
      "message",
      "started",
      "completed",
      "started",
      "completed",
      "started",
      "completed",
      "started",
      "completed",
      "message",
      "agent_completed",
    ]);
    expect(activity.every((event) => event.subagent.id === "spawn-current")).toBe(true);
    expect(activity.slice(1).every((event) => event.subagent.nativeId === "thread-child-current")).toBe(true);
    expect(activity.find((event) => event.phase === "agent_completed")).toMatchObject({
      id: "agent:spawn-current",
      isError: false,
      content: "CHILD_DONE",
    });
    expect(activity.find((event) => event.id.includes("cmd-child") && event.phase === "started")).toMatchObject({
      name: "codex▸command_execution",
      arguments: { command: "pwd" },
    });
    expect(activity.find((event) => event.id.includes("file-child") && event.phase === "completed")).toMatchObject({
      name: "codex▸file_change",
      isError: false,
    });
    expect(activity.find((event) => event.id.includes("mcp-child") && event.phase === "started")).toMatchObject({
      name: "codex▸mcp__docs__lookup",
      arguments: { id: "one" },
    });
  });

  it.each([
    [
      "legacy collabAgentToolCall",
      (client) => {
        client.notify("item/started", {
          threadId: "thread-parent-schema",
          turnId: "turn-1",
          item: {
            id: "spawn-schema",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-parent-schema",
            receiverThreadIds: [],
          },
        });
        client.notify("item/completed", {
          threadId: "thread-parent-schema",
          turnId: "turn-1",
          item: {
            id: "spawn-schema",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "thread-parent-schema",
            receiverThreadIds: ["thread-child-schema"],
            agentsStates: { "thread-child-schema": { status: "running" } },
          },
        });
      },
      undefined,
    ],
    [
      "local subAgentActivity",
      (client) => {
        const params = {
          threadId: "thread-parent-schema",
          turnId: "turn-1",
          item: {
            id: "spawn-schema",
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: "thread-child-schema",
            agentPath: "/root/research",
          },
        };
        client.notify("item/started", params);
        client.notify("item/completed", params);
      },
      "/root/research",
    ],
  ])("normalizes %s into the canonical spawn group", async (_label, emitSpawn, agentPath) => {
    const factory = stubClientFactory({ threadId: "thread-parent-schema" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    emitSpawn(client);
    client.notify("item/completed", {
      threadId: "thread-child-schema",
      turnId: "turn-child-schema",
      item: { id: "msg-child-schema", type: "agentMessage", text: "schema child" },
    });
    client.notify("turn/completed", {
      threadId: "thread-child-schema",
      turn: { id: "turn-child-schema", status: "completed" },
    });
    client.finishTurn({ text: "PARENT_DONE" });
    const result = await pending;

    const activity = result.events.filter((event) => event.type === "subagent_activity");
    expect(activity.filter((event) => event.phase === "agent_started")).toHaveLength(1);
    expect(activity.at(-1)).toMatchObject({
      phase: "agent_completed",
      subagent: {
        id: "spawn-schema",
        nativeId: "thread-child-schema",
        ...(agentPath === undefined ? {} : { name: "research", label: agentPath, agentPath }),
      },
    });
    expect(result.text).toBe("PARENT_DONE");
  });

  it("keeps nested Codex descendants in the initiating root spawn group", async () => {
    const factory = stubClientFactory({ threadId: "thread-parent-nested" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("item/completed", {
      threadId: "thread-parent-nested",
      turnId: "turn-1",
      item: {
        id: "spawn-root",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "thread-child",
        agentPath: "/root/research",
      },
    });
    client.notify("item/completed", {
      threadId: "thread-child",
      turnId: "turn-child",
      item: {
        id: "spawn-nested",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "thread-grandchild",
        agentPath: "/root/research/audit",
      },
    });
    client.notify("item/started", {
      threadId: "thread-grandchild",
      turnId: "turn-grandchild",
      item: { id: "nested-read", type: "commandExecution", command: "git diff", status: "inProgress" },
    });
    client.notify("item/completed", {
      threadId: "thread-grandchild",
      turnId: "turn-grandchild",
      item: {
        id: "nested-read",
        type: "commandExecution",
        command: "git diff",
        status: "completed",
        aggregatedOutput: "clean",
        exitCode: 0,
      },
    });
    client.notify("turn/completed", {
      threadId: "thread-grandchild",
      turn: { id: "turn-grandchild", status: "completed" },
    });
    client.notify("item/completed", {
      threadId: "thread-child",
      turnId: "turn-child",
      item: { id: "msg-child", type: "agentMessage", text: "nested complete" },
    });
    client.notify("turn/completed", {
      threadId: "thread-child",
      turn: { id: "turn-child", status: "completed" },
    });
    client.finishTurn({ text: "PARENT_DONE" });
    const result = await pending;

    const nestedTool = result.events.find((event) => event.type === "subagent_activity"
      && event.id.includes("nested-read") && event.phase === "started");
    expect(nestedTool).toMatchObject({
      subagent: {
        id: "spawn-root",
        nativeId: "thread-grandchild",
        name: "audit",
        label: "/root/research/audit",
        agentPath: "/root/research/audit",
      },
    });
    expect(result.events.filter((event) => event.type === "subagent_activity" && event.phase === "agent_completed"))
      .toHaveLength(1);
    expect(result.text).toBe("PARENT_DONE");
  });

  it("keeps root live-input steering pinned when a child turn starts", async () => {
    const factory = stubClientFactory({ threadId: "thread-parent-steer" });
    factory.turnPlan.push("manual");
    let releaseInput = () => {};
    const inputReady = new Promise((resolve) => { releaseInput = resolve; });
    const liveInput = (async function* () {
      await inputReady;
      yield { body: "steer the parent only" };
    })();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, { liveInput }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("item/completed", {
      threadId: "thread-parent-steer",
      turnId: "turn-1",
      item: {
        id: "spawn-steer",
        type: "collabToolCall",
        tool: "spawn_agent",
        status: "completed",
        senderThreadId: "thread-parent-steer",
        newThreadId: "thread-child-steer",
      },
    });
    client.notify("turn/started", {
      threadId: "thread-child-steer",
      turn: { id: "turn-child-steer", status: "inProgress" },
    });
    releaseInput();
    await vi.waitFor(() => expect(
      client.requests.some((request) => request.method === "turn/steer"),
    ).toBe(true));
    expect(client.requests.find((request) => request.method === "turn/steer")?.params).toMatchObject({
      threadId: "thread-parent-steer",
      expectedTurnId: "turn-1",
    });

    client.notify("turn/completed", {
      threadId: "thread-child-steer",
      turn: { id: "turn-child-steer", status: "completed" },
    });
    client.finishTurn({ text: "PARENT_DONE" });
    await expect(pending).resolves.toMatchObject({ text: "PARENT_DONE", error: null });
  });

  it("reports child failure without failing or completing the root turn", async () => {
    const factory = stubClientFactory({ threadId: "thread-parent-child-failure" });
    factory.turnPlan.push("manual");
    let settled = false;
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("item/completed", {
      threadId: "thread-parent-child-failure",
      turnId: "turn-1",
      item: {
        id: "spawn-failed-child",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-parent-child-failure",
        receiverThreadIds: ["thread-failed-child"],
      },
    });
    client.notify("turn/completed", {
      threadId: "thread-failed-child",
      turn: {
        id: "turn-failed-child",
        status: "failed",
        error: { message: "child failed safely" },
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    client.finishTurn({ text: "PARENT_DONE" });
    const result = await pending;
    expect(result).toMatchObject({ text: "PARENT_DONE", error: null, failureKind: null });
    expect(result.events.find((event) => event.type === "subagent_activity" && event.phase === "agent_completed"))
      .toMatchObject({ isError: true, content: "child failed safely" });
  });

  it("closes an active Codex subagent group when the parent is aborted", async () => {
    const factory = stubClientFactory({ threadId: "thread-parent-subagent-abort" });
    factory.turnPlan.push("manual");
    const controller = new AbortController();
    const pending = generateCodexAppResponse("SYS", runOptions(factory, { abortSignal: controller.signal }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("item/completed", {
      threadId: "thread-parent-subagent-abort",
      turnId: "turn-1",
      item: {
        id: "spawn-aborted",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "thread-child-aborted",
        agentPath: "/root/aborted",
      },
    });
    controller.abort();
    const result = await pending;

    expect(result.cancelled).toBe(true);
    const terminal = result.events.filter((event) => event.type === "subagent_activity"
      && event.phase === "agent_completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      isError: true,
      content: "Parent Codex turn was cancelled before the subagent completed.",
    });
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

  it("emits exact last-request context usage and records the model Codex actually used", async () => {
    const factory = stubClientFactory({ threadId: "thread-context-usage" });
    factory.turnPlan.push("manual");
    const emitted = [];
    const pending = generateCodexAppResponse("SYS", runOptions(factory, {
      onEvent: (event) => emitted.push(event),
    }));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("model/rerouted", {
      fromModel: "gpt-5.1-codex",
      toModel: "gpt-5.2-codex",
    });
    client.notify("thread/tokenUsage/updated", {
      threadId: "thread-context-usage",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 99_999,
          inputTokens: 90_000,
          cachedInputTokens: 80_000,
          outputTokens: 9_999,
          reasoningOutputTokens: 5_000,
        },
        last: {
          totalTokens: 925,
          inputTokens: 800,
          cachedInputTokens: 300,
          outputTokens: 125,
          reasoningOutputTokens: 75,
        },
        modelContextWindow: 372_000,
      },
    });
    client.finishTurn();
    await pending;

    expect(emitted.filter((event) => event.type === "context_usage")).toEqual([
      expect.objectContaining({
        sdk: "codex",
        model: "codex:gpt-5.2-codex",
        measurementId: "turn-1",
        contextWindow: 372_000,
        tokens: {
          input: 500,
          cachedInput: 300,
          output: 125,
          reasoning: 75,
          total: 925,
        },
      }),
    ]);
  });

  it("normalizes one Codex compaction lifecycle and ignores the deprecated duplicate", async () => {
    const factory = stubClientFactory({ threadId: "thread-compaction" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];
    const common = { threadId: "thread-compaction", turnId: "turn-1" };

    client.notify("item/started", {
      ...common,
      item: { id: "compact-1", type: "contextCompaction" },
    });
    client.notify("thread/compacted", common);
    client.notify("item/completed", {
      ...common,
      item: { id: "compact-1", type: "contextCompaction" },
    });
    client.finishTurn();
    const result = await pending;

    const events = result.events.filter((event) => event.type === "context_compaction");
    expect(events).toEqual([
      expect.objectContaining({
        operationId: "codex:compact-1",
        status: "running",
        sdk: "codex",
        trigger: "automatic",
      }),
      expect.objectContaining({
        operationId: "codex:compact-1",
        status: "succeeded",
        sdk: "codex",
        trigger: "automatic",
      }),
    ]);
  });

  it("closes a dangling Codex compaction as failed when the turn terminates", async () => {
    const factory = stubClientFactory({ threadId: "thread-compaction-failed" });
    factory.turnPlan.push("manual");
    const pending = generateCodexAppResponse("SYS", runOptions(factory));
    await vi.waitFor(() => expect(factory.clients[0]?.finishTurn).toBeTruthy());
    const client = factory.clients[0];

    client.notify("item/started", {
      threadId: "thread-compaction-failed",
      turnId: "turn-1",
      item: { id: "compact-failed", type: "contextCompaction" },
    });
    client.finishTurn({ status: "failed", text: "" });
    const result = await pending;

    const events = result.events.filter((event) => event.type === "context_compaction");
    expect(events.map(({ status }) => status)).toEqual(["running", "failed"]);
    expect(events[1]).toMatchObject({
      operationId: events[0].operationId,
      reason: "incomplete",
    });
  });

  it("disposeProviderSession (runtime disposeSession surface) closes the live client", async () => {
    const factory = stubClientFactory({ threadId: "thread-dispose" });
    await generateCodexAppResponse("SYS", runOptions(factory, { sessionKeepAlive: true }));

    const client = factory.clients[0];
    const originalClose = client.close;
    let releaseClose = () => {};
    const closeGate = new Promise((resolve) => { releaseClose = resolve; });
    client.close = vi.fn(async () => {
      await closeGate;
      await originalClose();
    });
    const pendingDispose = disposeProviderSession("thread-dispose");
    await vi.waitFor(() => expect(client.close).toHaveBeenCalledTimes(1));
    let disposeReturned = false;
    void pendingDispose.then(() => { disposeReturned = true; });
    await Promise.resolve();
    expect(disposeReturned).toBe(false);

    releaseClose();
    const disposed = await pendingDispose;
    expect(disposed).toBe(true);
    expect(disposeReturned).toBe(true);

    const resumed = await generateCodexAppResponse("SYS", runOptions(factory, { sessionId: "thread-dispose" }));
    expect(resumed.failureKind).toBe("session_not_found");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
