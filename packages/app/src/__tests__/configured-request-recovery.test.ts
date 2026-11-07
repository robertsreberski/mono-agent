import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { AgentResponder } from "@mono-agent/contracts";
import { createMonoRuntime } from "@mono-agent/turn/host";
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

async function fixture(route: Route, phase: "pre-response" | "post-response", piNative?: { piMaxRetries?: number; requestRetryBudgetMs?: number }) {
  const root = await mkdtemp(join(tmpdir(), "configured-request-recovery-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fictional.txt"), identityPath = join(root, "IDENTITY.md");
  await writeFile(file, "Fictional contents"); await writeFile(identityPath, "Fictional instructions");
  const model = route === "anthropic" ? getBuiltinModel("anthropic", "claude-haiku-5-5")! : getBuiltinModel("openai-codex", "gpt-6.1-sol")!;
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
    runtime: { model: `${route}:${model.id}`, workspace: root, session: { mode: "continuous", rollover: "none" } },
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
    if (fetch.mock.calls.length === 2) {
      if (phase === "pre-response") throw new TypeError("fetch failed");
      return stream(route, "partial", file);
    }
    return stream(route, "answer", file);
  });
  vi.stubGlobal("fetch", fetch);
  const requests = vi.spyOn(models, "streamSimple");
  const runtime = createMonoRuntime({ workspace: root }); cleanup.push(() => runtime.disposeAllSessions!());
  let toolRuns = 0;
  const run = runtime.run.bind(runtime);
  const runs = vi.spyOn(runtime, "run").mockImplementation((prompt, options) => run(prompt, { ...options,
    onEvent: (event) => {
      const message = event.message as { content?: Array<{ type: string }> } | undefined;
      if (event.type === "assistant" && message?.content?.some((block) => block.type === "tool_use")) toolRuns++;
      options.onEvent?.(event);
    },
  }));
  const responder = await createConfiguredAgentResponderForApp({ config, cwd: root, runtime,
    runtimeOptions: { piResolvedModels: models, piResolvedModel: model, piTransport: "sse", maxRetryDelayMs: 1, compaction: { enabled: false } } }, {});
  cleanup.push(() => (responder as AgentResponder & { dispose(): Promise<void> }).dispose());
  const respond = () => responder.respond({ conversationId: "test:fictional-conversation", text: "Read the fictional file, then answer.", abortSignal: new AbortController().signal }, { append: async () => {} });
  return { respond, bodies, fetch, requests, runs, toolRuns: () => toolRuns };
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
