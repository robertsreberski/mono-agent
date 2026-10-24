import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { requestRetryPolicy } from "../../execution/pi/request-retry.js";
import { generateEngineTurnResponse } from "../../execution/pi/run.js";
import { createRequestObserver } from "../../providers/pi/request-attempt.js";
import { recordTransportErrorForTests, resetTransportErrorProbeForTests } from "../../providers/pi/transport-errors.js";

const routes = ["anthropic", "openai", "openai-codex"] as const;
type Route = typeof routes[number];
const encoder = new TextEncoder();
const access = ["fictional", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64"), "fictional"].join(".");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTransportErrorProbeForTests(); });

function response(route: Route, partial = false): Response {
  const events = route === "anthropic" ? [
    { type: "message_start", message: { id: "fictional", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: partial ? "Fictional partial" : "Fictional answer" } },
    { type: "content_block_stop", index: 0 },
    ...(!partial ? [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }] : []),
  ] : [
    { type: "response.created", response: { id: "fictional", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "fictional-message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: partial ? "Fictional partial" : "Fictional answer" },
    ...(!partial ? [{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "fictional-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fictional answer", annotations: [] }] } },
      { type: "response.completed", response: { id: "fictional", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }] : []),
  ];
  const bytes = encoder.encode(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (sent) {
      if (partial) controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("Fictional transport failure"), { code: "ECONNRESET" }) }));
      else controller.close();
    } else { sent = true; controller.enqueue(bytes); }
  } }), { headers: { "content-type": "text/event-stream" } });
}

async function run(route: Route, fetch: typeof globalThis.fetch, overrides = {}) {
  vi.stubGlobal("fetch", fetch);
  const models = builtinModels({ credentials: { read: async () => route === "openai-codex"
    ? { type: "oauth", access, refresh: "fictional-unused", expires: Date.now() + 3_600_000 }
    : { type: "api_key", key: "sk-fictional-unused-key" } } as never,
    authContext: { env: () => undefined } as never });
  const model = route === "anthropic" ? getBuiltinModel("anthropic", "claude-haiku-5-5")!
    : route === "openai" ? getBuiltinModel("openai", "gpt-6.1-sol")! : getBuiltinModel("openai-codex", "gpt-6.1-sol")!;
  const requests: Array<SimpleStreamOptions | undefined> = [];
  const stream = models.streamSimple.bind(models);
  vi.spyOn(models, "streamSimple").mockImplementation((model, context, options) => {
    requests.push(options); return stream(model, context, options);
  });
  const result = await generateEngineTurnResponse("Fictional instructions", {
    model: { provider: route, model: model.id, reference: `${route}:${model.id}` },
    piResolvedModel: model, piResolvedModels: models, effort: "none", allowedTools: [], compaction: { enabled: false },
    piTransport: "sse", piMaxRetries: 2, piRequestRetryBudgetMs: 5000, maxRetryDelayMs: 10,
    messages: [{ role: "user", content: "Fictional request" }], ...overrides,
  });
  return { result, requests };
}

it.each(routes)("recovers a real %s pre-header outage without a surviving cause", async (route) => {
  const fetch = vi.fn(async () => { if (fetch.mock.calls.length < 4) throw new TypeError("fetch failed"); return response(route); });
  const { result, requests } = await run(route, fetch);
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional answer");
  expect(fetch).toHaveBeenCalledTimes(4); expect(requests).toHaveLength(4);
  expect(requests.every((options) => options?.maxRetries === 0 && typeof options.fetch === "function")).toBe(true);
  expect(result.events.filter((event: any) => event.type === "runtime_warning" && event.warning_kind === "provider_request_retry")[0]?.message).toContain("before its response started");
});

it.each(routes)("recovers a real %s body failure after streamed text", async (route) => {
  const fetch = vi.fn(async () => response(route, fetch.mock.calls.length < 4));
  const { result } = await run(route, fetch);
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional answer"); expect(fetch).toHaveBeenCalledTimes(4);
  expect(result.events.filter((event: any) => event.type === "runtime_warning" && event.warning_kind === "provider_request_retry")[0]?.message).toContain("after its response started");
});

it.each(["pre-header", "body"])("survives a multi-second %s outage on the real adapter", async (phase) => {
  let outageStarted: number | undefined;
  const fetch = vi.fn(async () => {
    outageStarted ??= Date.now();
    const unavailable = Date.now() - outageStarted < 2200;
    if (phase === "pre-header" && unavailable) throw new TypeError("fetch failed");
    return response("anthropic", unavailable);
  });
  const { result } = await run("anthropic", fetch, { maxRetryDelayMs: 1000, piRequestRetryBudgetMs: 10_000 });
  expect(result.error).toBeNull(); expect(Date.now() - outageStarted!).toBeGreaterThanOrEqual(2200);
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(4);
}, 15_000);

it.each(routes)("keeps %s throttling short and honors retry headers", async (route) => {
  const fetch = vi.fn(async () => Response.json({ error: { message: "Fictional throttle", type: "rate_limit_error" } }, { status: 429, headers: { "retry-after-ms": "0" } }));
  const { result, requests } = await run(route, fetch);
  expect(result.error).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(3); expect(requests).toHaveLength(1);
  expect(result.error).toContain("attempts=1 http_sends=3"); expect(result.error).toContain("exhausted=non_retryable");
});

it.each(routes)("honors %s excessive server delay and x-should-retry veto in both policies", async (route) => {
  for (const status of [429, 503]) {
    const fetch = vi.fn(async () => Response.json({ error: { message: "Fictional refusal" } }, { status, headers: { "x-should-retry": "false", "retry-after": "20" } }));
    await run(route, fetch); expect(fetch).toHaveBeenCalledOnce();
  }
  const fetch = vi.fn(async () => Response.json({ error: { message: "Fictional throttle" } }, { status: 429, headers: { "retry-after": "20" } }));
  const { result } = await run(route, fetch);
  expect(fetch).toHaveBeenCalledOnce(); expect(result.error).toContain("exhausted=delay_limit");
});

it.each(routes)("never retries %s terminal HTTP failures or quota even with header opt-in", async (route) => {
  for (const [status, message] of [[400, "validation failed"], [401, "unauthorized"], [403, "forbidden"], [429, "insufficient_quota"], [503, "context_length_exceeded"], [503, "safety policy"]] as const) {
    const fetch = vi.fn(async () => Response.json({ error: { message } }, { status, headers: { "x-should-retry": "true", "retry-after-ms": "0" } }));
    const { result } = await run(route, fetch); expect(result.error).toBeTruthy(); expect(fetch).toHaveBeenCalledOnce();
  }
});

it.each(routes)("reports bounded attributed %s exhaustion diagnostics", async (route) => {
  recordTransportErrorForTests("EPIPE");
  const fetch = vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Fictional failure"), { code: "UND_ERR_SOCKET" }) }); });
  const { result } = await run(route, fetch, { piRequestRetryBudgetMs: 40 });
  expect(result.error).toMatch(/\[provider_retry phase=pre-response http=pre-response attempts=\d+ http_sends=\d+ elapsed_ms=\d+ cause=UND_ERR_SOCKET exhausted=budget\]/);
  expect(result.error?.split("[provider_retry ")[1]?.length).toBeLessThan(230);
  expect(result.error).not.toContain("cause=EPIPE"); expect(result.failureKind).toBe("provider_unavailable");
});

it("reports post-response body phase and cause, without inventing unknown causes", async () => {
  const body = await run("openai", vi.fn(async () => response("openai", true)), { piRequestRetryBudgetMs: 30 });
  expect(body.result.error).toContain("phase=post-response http=post-response"); expect(body.result.error).toContain("cause=ECONNRESET");
  recordTransportErrorForTests("EPIPE");
  const opaque = await run("anthropic", vi.fn(async () => { throw new TypeError("fetch failed"); }), { piRequestRetryBudgetMs: 1 });
  expect(opaque.result.error).toContain("cause=unknown");
});

it.each(["outage", "short"])("cancels promptly in %s backoff", async (kind) => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    if (kind === "outage") throw new TypeError("fetch failed");
    setTimeout(() => controller.abort(), 20);
    return Response.json({ error: { message: "Fictional throttle" } }, { status: 429, headers: { "retry-after": "1" } });
  });
  const started = Date.now();
  const { result } = await run("anthropic", fetch, { maxRetryDelayMs: 60_000, abortSignal: controller.signal,
    onEvent: (event: any) => { if (event.warning_kind === "provider_request_retry") controller.abort(); } });
  expect(result.cancelled).toBe(true); expect(fetch).toHaveBeenCalledOnce(); expect(Date.now() - started).toBeLessThan(2000);
});

it.each([undefined, 0])("leaves parent/legacy adapter options unchanged (budget=%s)", async (piRequestRetryBudgetMs) => {
  const fetch = vi.fn(async () => Response.json({ error: { message: "Fictional overload" } }, { status: 503, headers: { "retry-after-ms": "0" } }));
  const { requests } = await run("openai", fetch, { piRequestRetryBudgetMs });
  expect(fetch).toHaveBeenCalledTimes(3); expect(requests).toHaveLength(1);
  expect(requests[0]?.maxRetries).toBe(2); expect(requests[0]).not.toHaveProperty("fetch");
});

it("keeps explicit zero single-shot and does not install a fetch wrapper", async () => {
  const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
  const { requests, result } = await run("anthropic", fetch, { piMaxRetries: 0 });
  expect(fetch).toHaveBeenCalledOnce(); expect(requests[0]?.maxRetries).toBe(0); expect(requests[0]).not.toHaveProperty("fetch");
  expect(result.error).not.toContain("[provider_retry");
});

it("never buffers a successful body and propagates cancellation with metadata", async () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(encoder.encode("fictional")));
  const cancel = vi.fn();
  const original = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: { "x-fictional": "yes" }, statusText: "Fictional OK" });
  const observer = createRequestObserver({ maxRetries: 2, maxRetryDelayMs: 100, fetch: vi.fn(async () => original) });
  const wrapped = await observer.fetch("https://fictional.invalid");
  expect(pull).not.toHaveBeenCalled(); expect(wrapped.statusText).toBe(original.statusText); expect(wrapped.headers.get("x-fictional")).toBe("yes");
  const reader = wrapped.body!.getReader(); await reader.read(); expect(pull).toHaveBeenCalledOnce(); await reader.cancel(); expect(cancel).toHaveBeenCalledOnce();
});

it.each(["stream", "form"])("does not short-retry a non-replayable %s request body", async (kind) => {
  const refusal = Response.json({ error: { message: "Fictional throttle" } }, { status: 429 });
  const fetch = vi.fn(async () => refusal);
  const observer = createRequestObserver({ maxRetries: 2, maxRetryDelayMs: 100, fetch });
  const body = kind === "stream" ? new ReadableStream() : new FormData();
  expect(await observer.fetch("https://fictional.invalid", { body, method: "POST" })).toBe(refusal);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["string", "bytes", "request"])("short-retries replayable %s bodies without replaying effects", async (kind) => {
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    bodies.push(input instanceof Request ? await input.text() : typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array));
    return Response.json({ error: { message: "Fictional throttle" } }, { status: 429, headers: { "retry-after-ms": "0" } });
  });
  const observer = createRequestObserver({ maxRetries: 2, maxRetryDelayMs: 100, fetch });
  const url = "https://fictional.invalid";
  await observer.fetch(kind === "request" ? new Request(url, { method: "POST", body: "fictional" }) : url,
    kind === "request" ? undefined : { method: "POST", body: kind === "bytes" ? encoder.encode("fictional") : "fictional" });
  expect(bodies).toEqual(["fictional", "fictional", "fictional"]);
});


it("recovers real built-in Codex websocket loss after its first event through a longer SSE outage", async () => {
  const sockets: Array<unknown> = [];
  class FictionalSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send() { setTimeout(() => {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.created", response: { id: "fictional", status: "in_progress", output: [] } }) }));
      setTimeout(() => this.dispatchEvent(new Event("error")), 0);
    }, 0); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal("WebSocket", FictionalSocket);
  const fetch = vi.fn(async () => { if (fetch.mock.calls.length < 5) throw new TypeError("fetch failed"); return response("openai-codex"); });
  const { result, requests } = await run("openai-codex", fetch, { piTransport: "auto" });
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional answer");
  expect(sockets).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(5); expect(requests).toHaveLength(6);
  expect(result.events.filter((event: any) => event.warning_kind === "provider_request_retry")[0]?.message).toContain("after its response started");
});

it("shares its budget across generation phases and separately bounds attempts", async () => {
  let clock = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
  const profile = requestRetryPolicy({ maxRetries: 2, maxRetryDelayMs: 60_000, providerCheck: false, retryBudgetMs: 120_000 });
  const policy = profile.createRequest!();
  policy.beforeAttempt();
  await expect(policy.fetch("https://fictional.invalid")).rejects.toThrow("fetch failed");
  expect(policy.shouldRetry({ errorMessage: "Connection error." }, { responseStarted: false })).toBe(true);
  expect(policy.retryDelay(1)).toBeGreaterThanOrEqual(750);
  clock = 119_000;
  expect(policy.retryDelay(10)).toBe(999);
  clock = 120_001;
  policy.beforeAttempt();
  expect(policy.shouldRetry({ errorMessage: "WebSocket error" }, { responseStarted: true })).toBe(true);
  expect(policy.retryDelay(2)).toBeNull(); expect(policy.canStartAttempt()).toBe(false);
});

it("enforces the independent 16-additional-attempt safety ceiling", async () => {
  const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
  const { result } = await run("anthropic", fetch, { piRequestRetryBudgetMs: 120_000, maxRetryDelayMs: 1 });
  expect(fetch).toHaveBeenCalledTimes(17); expect(result.error).toContain("attempts=17 http_sends=17"); expect(result.error).toContain("exhausted=attempt_limit");
});

it("attributes simultaneous fetch and body failures only to their own requests", async () => {
  const pipe = createRequestObserver({ maxRetries: 2, maxRetryDelayMs: 100, fetch: vi.fn(async () => {
    await Promise.resolve(); throw Object.assign(new Error("Fictional failure"), { code: "EPIPE" });
  }) });
  const reset = createRequestObserver({ maxRetries: 2, maxRetryDelayMs: 100, fetch: vi.fn(async () => new Response(new ReadableStream({ pull(controller) {
    controller.error(Object.assign(new Error("Fictional failure"), { code: "ECONNRESET" }));
  } }, { highWaterMark: 0 }))) });
  const results = await Promise.allSettled([pipe.fetch("https://fictional.invalid"), reset.fetch("https://fictional.invalid").then((res) => res.text())]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(pipe.snapshot().cause).toBe("EPIPE"); expect(reset.snapshot().cause).toBe("ECONNRESET");
  const opaque = createRequestObserver({ maxRetries: 0, maxRetryDelayMs: 100, fetch: vi.fn(async () => { throw Object.assign(new Error("Fictional failure"), { code: "https://fictional.invalid/private" }); }) });
  await expect(opaque.fetch("https://fictional.invalid")).rejects.toThrow(); expect(opaque.snapshot().cause).toBeNull();
});


it("does not turn SDK-flattened invalid fetch arguments into an outage", async () => {
  const fetch = vi.fn(async () => { throw new TypeError("Invalid URL argument"); });
  const { result } = await run("openai", fetch);
  expect(fetch).toHaveBeenCalledOnce(); expect(result.error).toContain("exhausted=non_retryable");
});
