import { afterEach, describe, expect, it, vi } from "vitest";

import { generateCodexAppResponse } from "../../ai/providers/codex-app.js";
import { disposeAllProviderSessions, disposeProviderSession } from "../../ai/runtime/sessions.js";

// Fake app-server client driven through options.codexClientFactory: records
// every request, emits notifications through the onNotification callback the
// bridge hands it, and lets tests resolve `closed` to simulate process exit.
function stubClientFactory({ threadId = "thread-1", turnText = "hello" } = {}) {
  const clients = [];
  // Consumed (shift) per turn/start: "auto" (default), "manual", "fail".
  const turnPlan = [];
  const factory = vi.fn(({ onNotification }) => {
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
  it("forwards the direct Terra model unchanged to the Codex app-server", async () => {
    const factory = stubClientFactory({ threadId: "thread-terra" });
    const terra = { sdk: "codex", model: "gpt-5.6-terra", reference: "codex:gpt-5.6-terra" };

    const result = await generateCodexAppResponse("SYS", runOptions(factory, { model: terra }));

    expect(result.error).toBeNull();
    const client = factory.clients[0];
    expect(client.requests.find((request) => request.method === "thread/start")?.params.model).toBe("gpt-5.6-terra");
    expect(client.requests.find((request) => request.method === "turn/start")?.params.model).toBe("gpt-5.6-terra");
    expect(result.model).toBe("codex:gpt-5.6-terra");
  });

  it.each([
    ["default (unset)", undefined, "on-request", "workspace-write", null],
    ["default", "default", "on-request", "workspace-write", null],
    ["plan", "plan", "on-request", "read-only", null],
    ["acceptEdits", "acceptEdits", "on-request", "workspace-write", null],
    ["bypassPermissions", "bypassPermissions", "never", "danger-full-access", { type: "dangerFullAccess" }],
  ])("maps %s permission mode into supported app-server payload policy", async (
    _label,
    permissionMode,
    approvalPolicy,
    sandbox,
    sandboxPolicy,
  ) => {
    const factory = stubClientFactory({ threadId: `thread-${_label}` });
    const result = await generateCodexAppResponse("SYS", runOptions(factory, { permissionMode }));
    expect(result.error).toBeNull();

    const client = factory.clients[0];
    const threadStart = client.requests.find((r) => r.method === "thread/start");
    const turnStart = client.requests.find((r) => r.method === "turn/start");

    expect(threadStart?.params.approvalPolicy).toBe(approvalPolicy);
    expect(threadStart?.params.sandbox).toBe(sandbox);
    expect(turnStart?.params.approvalPolicy).toBe(approvalPolicy);
    expect(turnStart?.params.sandboxPolicy).toEqual(sandboxPolicy);
    expect(threadStart?.params.approvalPolicy).not.toBe("on-failure");
    expect(turnStart?.params.approvalPolicy).not.toBe("on-failure");
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
