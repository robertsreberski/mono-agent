import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { AgentResponder } from "@mono-agent/contracts";
import { createMonoRuntime } from "@mono-agent/turn/host";
import type { RuntimeResult } from "@mono-agent/turn/host/types";
import { createConfiguredAgentRuntimeForApp } from "../composition/configured-runtime.js";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createConfiguredAgentResponderForApp } from "../composition/configured-agent.js";
import { configProviderOptions, configRuntimeFlags } from "../composition/configured-runtime-options.js";

type Route = "anthropic" | "openai-codex";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const token = `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64")}.fictional`;

function stream(route: Route, kind: "tool" | "partial" | "answer", file: string): Response {
  const tool = kind !== "answer";
  const events = route === "anthropic" ? [
    { type: "message_start", message: { id: "fictional", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: kind === "partial" ? "partial-call" : "completed-call", name: "Read", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: file }) } : { type: "text_delta", text: "Fictional answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
    ...(kind === "partial" ? [] : [{ type: "message_stop" }]),
  ] : [
    { type: "response.created", response: { id: "fictional", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: tool
      ? { type: "function_call", id: "fictional-item", call_id: kind === "partial" ? "partial-call" : "completed-call", name: "Read", arguments: "" }
      : { type: "message", id: "fictional-item", role: "assistant", status: "in_progress", content: [] } },
    ...(tool ? [{ type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify({ file_path: file }) }] : [
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Fictional answer" },
    ]),
    { type: "response.output_item.done", output_index: 0, item: tool
      ? { type: "function_call", id: "fictional-item", call_id: kind === "partial" ? "partial-call" : "completed-call", name: "Read", arguments: JSON.stringify({ file_path: file }) }
      : { type: "message", id: "fictional-item", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fictional answer", annotations: [] }] } },
    ...(kind === "partial" ? [] : [{ type: "response.completed", response: { id: "fictional", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]),
  ];
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(bytes); }
    else if (kind === "partial") controller.error(new TypeError("terminated"));
    else controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(route: Route, phase: "pre-response" | "post-response", piNative?: { piMaxRetries?: number; requestRetryBudgetMs?: number },
  behavior: { fallback?: boolean; exhaust?: boolean; abortOnRetry?: boolean; maxRetryDelayMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "configured-request-recovery-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fictional.txt"), identityPath = join(root, "IDENTITY.md");
  await writeFile(file, "Fictional contents"); await writeFile(identityPath, "Fictional instructions");
  const model = route === "anthropic" ? getBuiltinModel("anthropic", "claude-haiku-5-5")! : getBuiltinModel("openai-codex", "gpt-6.1-sol")!;
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
    runtime: { model: `${route}:${model.id}`, workspace: root, session: { mode: "continuous", rollover: "none" },
      ...(behavior.fallback ? { fallbacks: [{ model: route === "anthropic" ? "openai-codex:gpt-6.1-sol" : "anthropic:claude-haiku-5-5" }],
        retry: { primaryAttempts: 2, backoffMs: 0, maxBackoffMs: 0 } } : {}) },
    ...(piNative === undefined ? {} : { providers: { piNative } }),
    context: { identityPath }, tools: { allowedTools: ["Read"] }, artifacts: { dir: join(root, "artifacts") },
  } });
  const models = builtinModels({ credentials: { read: async () => route === "anthropic" ? { type: "api_key", key: "fictional-unused-key" }
    : { type: "oauth", access: token, refresh: "fictional", expires: Date.now() + 3_600_000 } } as never, authContext: { env: () => undefined } as never });
  const bodies: unknown[] = [];
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = init?.body as Uint8Array;
    bodies.push(JSON.parse(new Headers(init?.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(body).toString() : String(body)));
    if (fetch.mock.calls.length === 1) return stream(route, "tool", file);
    if (fetch.mock.calls.length === 2 || behavior.exhaust) {
      if (phase === "pre-response") throw new TypeError("fetch failed");
      return stream(route, "partial", file);
    }
    return stream(route, "answer", file);
  });
  vi.stubGlobal("fetch", fetch);
  const requests = vi.spyOn(models, "streamSimple");
  const runtime = behavior.fallback ? createConfiguredAgentRuntimeForApp(config) : createMonoRuntime({ workspace: root });
  cleanup.push(() => runtime.disposeAllSessions!());
  const controller = new AbortController();
  const results: RuntimeResult[] = [];
  let retries = 0;
  let toolRuns = 0;
  const run = runtime.run.bind(runtime);
  const runs = vi.spyOn(runtime, "run").mockImplementation(async (prompt, options) => {
    const result = await run(prompt, { ...options,
    onEvent: (event) => {
      const message = event.message as { content?: Array<{ type: string }> } | undefined;
      if (event.type === "assistant" && message?.content?.some((block) => block.type === "tool_use")) toolRuns++;
      if (event.type === "runtime_warning" && event.warning_kind === "provider_request_retry") {
        retries++;
        if (behavior.abortOnRetry) controller.abort("Fictional cancellation during recovery");
      }
      options.onEvent?.(event);
    },
    });
    results.push(result);
    return result;
  });
  const responder = await createConfiguredAgentResponderForApp({ config, cwd: root, runtime,
    runtimeOptions: { piResolvedModels: models, piTransport: "sse", maxRetryDelayMs: behavior.maxRetryDelayMs ?? 1, compaction: { enabled: false } } }, {});
  cleanup.push(() => (responder as AgentResponder & { dispose(): Promise<void> }).dispose());
  const respond = () => responder.respond({ conversationId: "test:fictional-conversation", text: "Read the fictional file, then answer.", abortSignal: controller.signal }, { append: async () => {} });
  return { respond, bodies, fetch, requests, runs, results, controller, retries: () => retries, toolRuns: () => toolRuns };
}

it.each(["anthropic", "openai-codex"] as const)("configured %s parent recovers only the failed model request in both phases", async (route) => {
  for (const phase of ["pre-response", "post-response"] as const) {
    const f = await fixture(route, phase);
    const result = await f.respond();
    expect(result.text).toBe("Fictional answer");
    expect(f.toolRuns()).toBe(1); expect(f.runs).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(f.requests).toHaveBeenCalledTimes(3);
    expect(f.bodies[2]).toEqual(f.bodies[1]);
    expect(JSON.stringify(f.bodies[2])).toContain("Fictional contents");
    expect(JSON.stringify(f.bodies[2])).not.toContain("partial-call");
    expect(f.requests.mock.calls.every(([, , options]) => options?.maxRetries === 0 && typeof options.fetch === "function")).toBe(true);
  }
});

it("configured piMaxRetries:0 leaves the failed parent request single-shot after a tool", async () => {
  const f = await fixture("anthropic", "pre-response", { piMaxRetries: 0 });
  await expect(f.respond()).rejects.toThrow();
  expect(f.toolRuns()).toBe(1); expect(f.runs).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.requests.mock.calls[1]?.[2]).not.toHaveProperty("fetch");
});

it("configured requestRetryBudgetMs:0 explicitly restores legacy SDK recovery", async () => {
  const f = await fixture("anthropic", "pre-response", { requestRetryBudgetMs: 0 });
  expect((await f.respond()).text).toBe("Fictional answer");
  expect(f.toolRuns()).toBe(1); expect(f.runs).toHaveBeenCalledOnce();
  expect(f.fetch).toHaveBeenCalledTimes(3); expect(f.requests).toHaveBeenCalledTimes(2);
  expect(f.requests.mock.calls[1]?.[2]?.maxRetries).toBe(2);
  expect(f.requests.mock.calls[1]?.[2]).not.toHaveProperty("fetch");
});

it.each(["anthropic", "openai-codex"] as const)("configured %s fallback chain refuses replay after request recovery exhausts following a tool", async (route) => {
  const f = await fixture(route, "pre-response", { requestRetryBudgetMs: 30 }, {
    fallback: true, exhaust: true, maxRetryDelayMs: 10,
  });
  await expect(f.respond()).rejects.toThrow(/provider_retry.*exhausted=budget/);
  expect(f.toolRuns()).toBe(1); expect(f.runs).toHaveBeenCalledOnce();
  expect(f.retries()).toBeGreaterThan(0);
  // The elapsed budget can expire while sleeping; do not require another send
  // after a scheduled retry or depend on exact wall-clock/jitter timing.
  expect(f.requests.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(f.requests.mock.calls.length).toBeLessThanOrEqual(18);
  expect(f.requests.mock.calls.every(([model]) => model.provider === route)).toBe(true);
  expect(f.results[0]?.failureKind).toBe("provider_unavailable");
  expect(f.results[0]?.failoverHistory).toHaveLength(1);
  expect(f.results[0]?.failoverHistory).toEqual([expect.objectContaining({ model: expect.objectContaining({ provider: route }) })]);
  for (const body of f.bodies.slice(2)) expect(body).toEqual(f.bodies[1]);
});

it.each(["anthropic", "openai-codex"] as const)("configured %s cancellation during recovery stops before another send", async (route) => {
  const f = await fixture(route, "pre-response", undefined, { fallback: true, abortOnRetry: true, maxRetryDelayMs: 60_000 });
  // The responder may project cancellation as a failure; the real runtime's
  // terminal cancellation and exact send counts are the ownership evidence.
  await f.respond().catch(() => undefined);
  expect(f.controller.signal.aborted).toBe(true);
  expect(f.results[0]?.cancelled).toBe(true); expect(f.retries()).toBe(1);
  expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.requests).toHaveBeenCalledTimes(2);
  expect(f.toolRuns()).toBe(1); expect(f.runs).toHaveBeenCalledOnce();
});

it("composes default/empty/explicit parent budgets independently of child budgets", () => {
  for (const piNative of [undefined, {}, { requestRetryBudgetMs: 0 }, { requestRetryBudgetMs: 180_000 }]) {
    const config = resolveJsonMonoAgentConfig({ cwd: "/fictional", json: {
      runtime: { model: "anthropic:claude-haiku-5-5" }, context: { identityPath: "IDENTITY.md" }, ...(piNative === undefined ? {} : { providers: { piNative } }),
      subagents: { providerRetryBudgetMs: 0 },
    } });
    expect(configRuntimeFlags(config)?.piRequestRetryBudgetMs).toBe(piNative?.requestRetryBudgetMs ?? 120_000);
    expect(configProviderOptions(config, { subagent: true }).piRequestRetryBudgetMs).toBe(0);
    const { subagents: _childPolicy, ...withoutChildren } = config;
    expect(configProviderOptions(withoutChildren, { subagent: true }).piRequestRetryBudgetMs).toBe(120_000);
  }
});


it("does not attach an inactive parent retry profile to explicitly single-shot hosts", () => {
  const config = resolveJsonMonoAgentConfig({ cwd: "/fictional", json: {
    runtime: { model: "anthropic:claude-haiku-5-5" }, context: { identityPath: "IDENTITY.md" },
    providers: { piNative: { piMaxRetries: 0, requestRetryBudgetMs: 180_000 } },
  } });
  expect(configRuntimeFlags(config)).toMatchObject({ piMaxRetries: 0 });
  expect(configRuntimeFlags(config)).not.toHaveProperty("piRequestRetryBudgetMs");
  expect(configProviderOptions(config, { subagent: true })).toMatchObject({ piMaxRetries: 0, piRequestRetryBudgetMs: 120_000 });
});
