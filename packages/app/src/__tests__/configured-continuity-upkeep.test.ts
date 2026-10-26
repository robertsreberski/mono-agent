import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createPiOAuthApiKeyResolver } from "@mono-agent/turn";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createConfiguredConversationHarness } from "../composition/configured-agent.js";
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.unstubAllGlobals(); });

it.each(["continuous", "per-message", "isolated", "failure"])("uses configured base extraction and explicit host eligibility (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "configured-upkeep-")); close.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "IDENTITY.md"), "Historical evidence is not fresh authorization.");
  const answer = fauxProvider({ provider: "faux", api: "openai-responses", models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const extraction = fauxProvider({ provider: "faux", api: "openai-responses", models: [{ id: "base" }], tokensPerSecond: 1_000_000 });
  const answerModels = createModels(), extractionModels = createModels(); answerModels.setProvider(answer.provider); extractionModels.setProvider(extraction.provider);
  let calls = 0;
  extraction.setResponses([context => {
    calls++; const prompt = JSON.stringify(context);
    expect(prompt).toContain("Never send without confirmation.");
    return fauxAssistantMessage(JSON.stringify({ entries: [{ kind: "constraint", value: "Keep the original approval rule.", status: "active", sources: ["s0"] }], covered: ["s0"] }));
  }]);
  const json = { runtime: { model: "faux:base", session: { mode: mode === "per-message" ? "per-message" : "continuous", root: "native",
    isolateProactive: true, continuity: { upkeep: { enabled: true } } } }, providers: { faux: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1" } },
    context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: [] }, artifacts: { dir: "artifacts" } };
  const config = resolveJsonMonoAgentConfig({ json, cwd: root });
  const runtime = createMonoRuntime({ workspace: root }); close.push(() => runtime.disposeAllSessions!());
  const harness = await createConfiguredConversationHarness({ config, cwd: root, runtime,
    runtimeOptions: { piResolvedModels: extractionModels }, runtimeOptionsForRequest: ({ request }) => {
      const web = request.metadata?.web as { readonly model?: string } | undefined;
      const model = web?.model === "faux:other" ? "other" : "base";
      return { runtimeOptions: { model: { provider: "faux", model, reference: `faux:${model}` }, piResolvedModel: answer.getModel(model), piResolvedModels: answerModels, compaction: { enabled: false } } };
    } }); close.push(() => harness.dispose!());
  answer.setResponses([() => fauxAssistantMessage("Fictional first answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Never send without confirmation.", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal });
  const events: Record<string, unknown>[] = []; let outgoing = "";
  answer.setResponses([context => { outgoing = JSON.stringify(context); return mode === "failure" ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid_request_error: fictional failure" }) : fauxAssistantMessage("Fictional second answer."); }]);
  const result = await harness.run({ conversationId: "web:fictional", userMessage: "CURRENT-INPUT", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal,
    metadata: mode === "isolated" ? { cron: { jobId: "fictional" } } : { source: "web", web: { model: "faux:other" } }, onEvent: event => events.push(event) });
  if (mode === "per-message" || mode === "isolated") {
    expect(calls).toBe(0); expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "skipped", reason: mode === "isolated" ? "isolated" : "per_message" }));
  } else {
    expect(calls).toBe(1);
    const receipt = events.filter(event => event.type === "continuity_upkeep"); expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ model: "faux:base", status: "valid", generationId: expect.any(String) });
    expect(outgoing).toContain("### Continuity ledger");
    expect(outgoing.split("CURRENT-INPUT")).toHaveLength(2);
  }
  if (mode === "failure") expect(result.failure).toBeDefined(); else expect(result.failure).toBeUndefined();
}, 20000);

it.each([false, true])("binds configured OAuth and custom pricing without injected upkeep models (explicit resolver=%s)", async explicit => {
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
    authenticated = new Headers(options.headers).get("authorization") === `Bearer ${explicit ? explicitToken : token}`;
    const frames = [{ type: "response.created", response: { id: "fictional-response" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "fictional-output", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: value },
      { type: "response.completed", response: { id: "fictional-response", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 150, total_tokens: 250 } } }];
    return new Response(frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fetch);
  const answer = fauxProvider({ provider: "openai-codex", api: "openai-responses", models: [{ id: "gpt-6-luna" }, { id: "gpt-5.5" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(answer.provider);
  const pricing = vi.fn(() => ({ priced: true, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, source: "fictional" }));
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: { runtime: { model: "openai-codex:gpt-6-luna", session: { mode: "continuous", root: "native", continuity: { upkeep: { enabled: true } } } }, providers: { piAuthPath: authPath }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: [] }, artifacts: { dir: "artifacts" } } });
  const runtime = createMonoRuntime({ workspace: root }); close.push(() => runtime.disposeAllSessions!());
  const harness = await createConfiguredConversationHarness({ config, cwd: root, runtime, runtimeOptions: { resolveCustomPricing: pricing, ...(explicit ? { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: explicitPath }) } : {}) }, runtimeOptionsForRequest: ({ request }) => {
    const id = request.metadata?.web ? "gpt-5.5" : "gpt-6-luna";
    return { runtimeOptions: { model: { provider: "openai-codex", model: id, reference: `openai-codex:${id}` }, piResolvedModel: answer.getModel(id), piResolvedModels: models, compaction: { enabled: false } } };
  } }); close.push(() => harness.dispose!());
  answer.setResponses([() => fauxAssistantMessage("Fictional answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Never send without confirmation.", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal });
  const events: Record<string, unknown>[] = [];
  answer.setResponses([() => fauxAssistantMessage("Fictional answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Current.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: "openai-codex:gpt-5.5" } }, abortSignal: new AbortController().signal, onEvent: event => events.push(event) });
  expect(fetch).toHaveBeenCalledTimes(1); expect(authenticated).toBe(true); expect(pricing).toHaveBeenCalled();
  expect(Number(events.find(event => event.type === "continuity_upkeep")?.costUsd)).toBeCloseTo(0.0004, 8);
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "valid", providerInvoked: true, generationId: expect.any(String) }));
}, 20000);
