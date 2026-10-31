import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createPiOAuthApiKeyResolver } from "@mono-agent/turn";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { ToolHistoryReader } from "@mono-agent/conversation";
import { DatabaseSync } from "node:sqlite";
import { createRequestModelOverrideRuntimeExtension } from "../composition/request-model-override.js";
import { createConfiguredConversationHarness } from "../composition/configured-agent.js";
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.unstubAllGlobals(); });

it.each(["continuous", "per-message", "isolated", "failure", "cancelled", "override", "wake", "invalid", "embedding", "unavailable"])("uses effective primary extraction and explicit host eligibility (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "configured-upkeep-")); close.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "IDENTITY.md"), "Historical evidence is not fresh authorization.");
  const answer = fauxProvider({ provider: "faux", api: "openai-responses", models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const extraction = fauxProvider({ provider: "faux", api: "openai-responses", models: [{ id: "base" }, { id: "other" }, { id: "small" }], tokensPerSecond: 1_000_000 });
  const answerModels = createModels(), extractionModels = createModels(); answerModels.setProvider(answer.provider); extractionModels.setProvider(extraction.provider);
  let authorized = false;
  if (mode === "unavailable") {
    const getAuth = extractionModels.getAuth.bind(extractionModels);
    vi.spyOn(extractionModels, "getAuth").mockImplementation((model, options) => model.id === "other" && !authorized ? Promise.resolve(undefined) : getAuth(model, options));
  }
  let calls = 0, currentRunId = ""; const extractorModel = mode === "override" ? "faux:small" : ["wake", "invalid"].includes(mode) ? "faux:base" : "faux:other";
  extraction.setResponses([(context, _options, _state, selected) => {
    expect(`faux:${selected.id}`).toBe(extractorModel);
    // Q1: production provider dispatch sees its own already-written running origin.
    const origin = JSON.parse(readFileSync(join(root, "artifacts", `${currentRunId}.summary.json`), "utf8"));
    expect(origin).toMatchObject({ runId: currentRunId, conversationId: "web:fictional", status: "running" });
    calls++; const prompt = JSON.stringify(context);
    expect(prompt).toContain("Never send without confirmation.");
    return fauxAssistantMessage(JSON.stringify({ entries: [{ kind: "constraint", value: "Keep the original approval rule.", status: "active", sources: ["s0"] }], covered: ["s0"] }));
  }]);
  const json = { runtime: { model: "faux:base", context1MModels: { "faux:base": false }, session: { mode: mode === "per-message" ? "per-message" : "continuous", root: "native",
    isolateProactive: mode !== "wake", continuity: { upkeep: { enabled: true, ...(mode === "override" ? { extractionModel: "faux:small" } : {}) } } } }, providers: { faux: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1" } },
    context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: [] }, artifacts: { dir: "artifacts" } };
  const config = resolveJsonMonoAgentConfig({ json, cwd: root });
  const runtime = createMonoRuntime({ workspace: root }); close.push(() => runtime.disposeAllSessions!());
  const upkeepFlags: unknown[] = [];
  const prepareUpkeep = runtime.prepareContinuityUpkeep!.bind(runtime);
  runtime.prepareContinuityUpkeep = (input, settings) => {
    upkeepFlags.push(input.context1MModels);
    return prepareUpkeep(input, settings);
  };
  const harness = await createConfiguredConversationHarness({ config, cwd: root, runtime, ...(mode === "embedding" ? { model: { provider: "faux", model: "other", reference: "faux:other" } } : {}),
    runtimeOptions: { piResolvedModels: extractionModels }, runtimeOptionsForRequest: async ({ request, runId }) => {
      currentRunId = runId;
      const web = request.metadata?.web as { readonly model?: string } | undefined;
      const model = web?.model === "faux:other" || mode === "embedding" && !web ? "other" : "base";
      const validated = mode === "invalid" ? await createRequestModelOverrideRuntimeExtension({ baseModel: config.runtime.model })({ request }) : undefined;
      return { runtimeOptions: { model: { provider: "faux", model, reference: `faux:${model}` }, ...validated?.runtimeOptions, piResolvedModel: answer.getModel(model), piResolvedModels: answerModels, compaction: { enabled: false } } };
    } }); close.push(() => harness.dispose!());
  answer.setResponses([() => fauxAssistantMessage("Fictional first answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Never send without confirmation.", captureSpeakerKind: "human-turn", metadata: ["wake", "invalid"].includes(mode) ? { source: "web", web: { model: "faux:other" } } : mode === "embedding" ? { source: "web", web: { model: "faux:base" } } : {}, abortSignal: new AbortController().signal });
  const events: Record<string, unknown>[] = []; let outgoing = ""; const controller = new AbortController();
  answer.setResponses([context => { outgoing = JSON.stringify(context); if (mode === "cancelled") controller.abort("fictional cancellation"); return mode === "failure" ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid_request_error: fictional failure" }) : fauxAssistantMessage("Fictional second answer."); }]);
  const result = await harness.run({ conversationId: "web:fictional", userMessage: "CURRENT-INPUT", captureSpeakerKind: "human-turn", abortSignal: controller.signal,
    metadata: mode === "wake" ? { source: "cron", cron: { jobId: "fictional-wake" } } : mode === "invalid" ? { source: "web", web: { model: "not-a-model" } } : mode === "embedding" ? {} : mode === "isolated" ? { cron: { jobId: "fictional" } } : { source: "web", web: { model: "faux:other" } }, onEvent: event => events.push(event) });
  if (!["per-message", "isolated"].includes(mode)) expect(upkeepFlags.at(-1)).toEqual(config.runtime.context1MModels);
  if (mode === "unavailable") {
    expect(calls).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(outgoing).toContain("### Conversation continuity pack");
    expect(outgoing).toContain("Never send without confirmation.");
    expect(result.metadata.summary?.upkeepAccounting ?? []).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", reason: "model_unavailable", status: "skipped", providerInvoked: false }));
    expect(events.some(event => event.type === "continuity_upkeep_dispatch")).toBe(false);
    // Move away without source extraction, then return across a cold boundary
    // to the SAME previously unauthorized model, now with valid auth.
    const authSpy = vi.spyOn(extractionModels, "getAuth");
    authSpy.mockResolvedValueOnce(undefined);
    answer.setResponses([() => fauxAssistantMessage("Fictional intervening answer.")]);
    await harness.run({ conversationId: "web:fictional", userMessage: "Intervening turn.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: "faux:base" } }, abortSignal: new AbortController().signal });
    authorized = true;
    answer.setResponses([() => fauxAssistantMessage("Fictional authorized answer.")]);
    const recovered: Record<string, unknown>[] = [];
    await harness.run({ conversationId: "web:fictional", userMessage: "Later authorized turn.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: "faux:other" } }, abortSignal: new AbortController().signal, onEvent: e => recovered.push(e) });
    expect(calls).toBe(1);
    expect(recovered).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", model: "faux:other", status: "valid" }));
  } else if (mode === "per-message" || mode === "isolated") {
    expect(calls).toBe(0); expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "skipped", reason: mode === "isolated" ? "isolated" : "per_message" }));
  } else {
    expect(calls).toBe(1);
    const receipt = events.filter(event => event.type === "continuity_upkeep"); expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ model: extractorModel, status: "valid", generationId: expect.any(String) });
    expect(result.metadata.summary?.upkeepAccounting).toHaveLength(1);
    expect(result.metadata.summary?.upkeepAccounting?.[0]).toMatchObject({ phase: "result", model: extractorModel, operationId: receipt[0]!.operationId });
    expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep_dispatch", accounting: expect.objectContaining({ phase: "dispatch", runId: result.metadata.runId }) }));
    expect(outgoing).toContain("### Continuity ledger");
    expect(outgoing.split("CURRENT-INPUT")).toHaveLength(2);
  }
  if (["failure", "cancelled"].includes(mode)) expect(result.failure).toBeDefined(); else expect(result.failure).toBeUndefined();
  if (mode === "continuous") {
    const nativeEvents: Record<string, unknown>[] = []; answer.setResponses([() => fauxAssistantMessage("Fictional resumed answer.")]);
    await harness.run({ conversationId: "web:fictional", userMessage: "Continue.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: "faux:other" } }, abortSignal: new AbortController().signal, onEvent: event => nativeEvents.push(event) });
    expect(calls).toBe(1); expect(nativeEvents.some(event => event.type === "continuity_upkeep_dispatch")).toBe(false);
  }
}, 20000);

it.each([[false, false, false, false, false], [true, false, false, false, false], [true, true, false, false, false], [false, false, true, false, false], [false, false, true, true, false], [false, false, false, false, true]])("switches to Codex with OAuth/pricing (explicit=%s, strict=%s, routed=%s, nested=%s, requestOnly=%s)", async (explicit, strict, routed, nested, requestOnly) => {
  const root = await mkdtemp(join(tmpdir(), "configured-upkeep-auth-")); close.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "IDENTITY.md"), "Historical evidence is not fresh approval.");
  const token = `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64url")}.fictional`;
  const authPath = join(root, "fictional-auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "fictional", expires: 4_200_000_000_000 } }), { mode: 0o600 });
  const explicitPath = join(root, "fictional-explicit-auth.json");
  const explicitToken = `explicit.${token.split(".")[1]}.fictional`;
  await writeFile(explicitPath, JSON.stringify({ "openai-codex": { type: "oauth", access: explicitToken, refresh: "fictional", expires: 4_200_000_000_000 } }), { mode: 0o600 });
  const value = JSON.stringify({ entries: [{ kind: "constraint", value: "Require confirmation.", status: "active", sources: ["s0"] }], covered: ["s0"] });
  let authenticated = false;
  const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
    authenticated = new Headers(options.headers).get("authorization") === `Bearer ${explicit || routed || requestOnly ? explicitToken : token}`;
    const frames = [{ type: "response.created", response: { id: "fictional-response" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "fictional-output", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: value },
      { type: "response.completed", response: { id: "fictional-response", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 150, total_tokens: 250 } } }];
    return new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fetch);
  const answer = fauxProvider({ provider: "openai-codex", api: "openai-responses", models: [{ id: "gpt-5.5" }], tokensPerSecond: 1_000_000 });
  const local = fauxProvider({ provider: "private", api: "openai-responses", models: [{ id: "base" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(answer.provider); models.setProvider(local.provider);
  const pricing = vi.fn(() => ({ priced: true, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, source: "fictional" }));
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: { runtime: { model: "private:base", session: { mode: "continuous", root: "native", continuity: { upkeep: { enabled: true, requireRequestCap: strict } } } }, providers: { private: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1" }, piAuthPath: authPath }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: [] }, artifacts: { dir: "artifacts" } } });
  const runtime = createMonoRuntime({ workspace: root }); close.push(() => runtime.disposeAllSessions!());
  const child = nested ? createMonoRuntime({ workspace: root, resolvePiApiKey: createPiOAuthApiKeyResolver({ path: explicitPath }), resolveCustomPricing: pricing }) : undefined;
  if (child) close.push(() => child.disposeAllSessions!());
  const cloud = routed ? createMonoRuntime({ workspace: root,
    fallbackChain: [{ model: { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" } }],
    resolvePiApiKey: nested ? async () => undefined : createPiOAuthApiKeyResolver({ path: explicitPath }),
    resolveAttempt: () => child ? { runtime: child } : { options: { resolveCustomPricing: pricing } },
  }) : undefined;
  if (cloud) close.push(() => cloud.disposeAllSessions!());
  const harness = await createConfiguredConversationHarness({ config, cwd: root, runtime,
    ...(cloud ? { runtimeForModel: () => cloud } : {}),
    runtimeOptions: { ...(routed || requestOnly ? {} : { resolveCustomPricing: pricing }), ...(explicit ? { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: explicitPath }) } : {}) }, runtimeOptionsForRequest: ({ request }) => {
    const selected = request.metadata?.web ? { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" } : { provider: "private", model: "base", reference: "private:base" };
    return { runtimeOptions: { ...(requestOnly ? { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: explicitPath }), resolveCustomPricing: pricing } : {}), model: selected, piResolvedModel: selected.provider === "private" ? local.getModel() : answer.getModel(), piResolvedModels: models, compaction: { enabled: false } } };
  } }); close.push(() => harness.dispose!());
  local.setResponses([() => fauxAssistantMessage("Fictional answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Never send without confirmation.", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal });
  const events: Record<string, unknown>[] = [];
  answer.setResponses([() => fauxAssistantMessage("Fictional answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Current.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: "openai-codex:gpt-5.5" } }, abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
  if (strict) {
    expect(fetch).not.toHaveBeenCalled();
    const db = new DatabaseSync(new ToolHistoryReader(join(root, "history")).databasePath); close.push(async () => { db.close(); });
    expect(db.prepare("SELECT * FROM continuity_upkeep_operations").all()).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "skipped", reason: "model_unavailable", providerInvoked: false }));
    return;
  }
  expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0]![0])).toContain("chatgpt.com"); expect(authenticated).toBe(true); expect(pricing).toHaveBeenCalled();
  expect(Number(events.find(event => event.type === "continuity_upkeep")?.costUsd)).toBeCloseTo(0.0004, 8);
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "valid", providerInvoked: true, generationId: expect.any(String) }));
}, 20000);

it("switches cloud to local using the selected endpoint and credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "configured-upkeep-local-")); close.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "IDENTITY.md"), "Historical evidence is not fresh approval.");
  const value = JSON.stringify({ entries: [{ kind: "constraint", value: "Require confirmation.", status: "active", sources: ["s0"] }], covered: ["s0"] });
  const fetch = vi.fn(async (url: unknown, options: RequestInit) => {
    expect(String(url)).toBe("http://127.0.0.1:1/v1/chat/completions");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer fictional-local-key");
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "base", stream: true, max_tokens: 4096 });
    const frames = [
      { id: "fictional", choices: [{ index: 0, delta: { role: "assistant", content: value }, finish_reason: null }] },
      { id: "fictional", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } },
    ];
    return new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fetch);
  const cloud = fauxProvider({ provider: "openai", api: "openai-responses", models: [{ id: "gpt-4o-mini" }], tokensPerSecond: 1_000_000 });
  const local = fauxProvider({ provider: "private", api: "openai-responses", models: [{ id: "base" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(cloud.provider); models.setProvider(local.provider);
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: { runtime: { model: "openai:gpt-4o-mini", session: { mode: "continuous", root: "native", continuity: { upkeep: { enabled: true } } } },
    providers: { private: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fictional-local-key" } }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: [] }, artifacts: { dir: "artifacts" } } });
  const runtime = createMonoRuntime({ workspace: root }); close.push(() => runtime.disposeAllSessions!());
  const harness = await createConfiguredConversationHarness({ config, cwd: root, runtime, runtimeOptionsForRequest: ({ request }) => {
    const selected = request.metadata?.web ? { provider: "private", model: "base", reference: "private:base" } : { provider: "openai", model: "gpt-4o-mini", reference: "openai:gpt-4o-mini" };
    return { runtimeOptions: { model: selected, piResolvedModel: selected.provider === "private" ? local.getModel() : cloud.getModel(), piResolvedModels: models, compaction: { enabled: false } } };
  } }); close.push(() => harness.dispose!());
  cloud.setResponses([fauxAssistantMessage("Fictional first answer.")]);
  await harness.run({ conversationId: "fictional", userMessage: "Never send without confirmation.", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal });
  local.setResponses([fauxAssistantMessage("Fictional local answer.")]);
  const events: Record<string, unknown>[] = [];
  const result = await harness.run({ conversationId: "fictional", userMessage: "Current.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: "private:base" } }, abortSignal: new AbortController().signal, onEvent: e => events.push(e) });
  expect(result.failure).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", model: "private:base", status: "valid", providerInvoked: true }));
  expect(result.metadata.summary?.upkeepAccounting?.[0]?.model).toBe("private:base");
}, 20000);
