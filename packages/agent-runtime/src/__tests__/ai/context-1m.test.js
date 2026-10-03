import { describe, expect, it, vi } from "vitest";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { CONTEXT_1M_TOKENS, supportsPiContext1M, withContext1MModels } from "../../ai/context-1m.js";
import { resolvePiRuntimeModel } from "../../ai/providers/pi-models.js";
import { createModels, fauxProvider, fauxText, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";
import { shouldCompact } from "@earendil-works/pi-agent-core";
import { effectiveContextWindow, resolveLiveCompactionPolicy, piCompactionSettings } from "../../ai/providers/pi-native/compaction-driver.js";

const reference = "openai-codex:gpt-6.1-sol";
const resolved = { provider: "openai-codex", model: "gpt-6.1-sol", reference };

describe("GPT 1M context policy", () => {
  it("fails closed outside the inferred built-in long-input catalog", () => {
    expect(supportsPiContext1M(reference)).toBe(true);
    expect(supportsPiContext1M("openai:gpt-6.1-sol")).toBe(true);
    for (const ref of ["openai-codex:gpt-5.3-codex-spark", "openai-codex:unknown", "anthropic:claude-opus-4-6", "openai:gpt-4.1", " openai:gpt-6.1-sol", "gpt-6.1-sol"]) {
      expect(supportsPiContext1M(ref)).toBe(false);
    }
  });

  it("resolves ON/OFF/ON without changing catalog metadata or pricing", () => {
    const upstream = getBuiltinModel(resolved.provider, resolved.model);
    const before = structuredClone(upstream);
    for (const enabled of [true, false, true]) {
      const { model } = resolvePiRuntimeModel(resolved, { context1MModels: { [reference]: enabled } });
      expect(model.contextWindow).toBe(enabled ? CONTEXT_1M_TOKENS : 272_000);
      expect(model.cost).toEqual(before.cost);
      expect(model.maxTokens).toBe(before.maxTokens);
      if (enabled) expect(model).not.toBe(upstream);
    }
    expect(upstream).toEqual(before);
  });

  it("agrees at collection lookup and dispatch without leaking to another route", () => {
    const model = getBuiltinModel(resolved.provider, resolved.model);
    const other = getBuiltinModel("openai", "gpt-6.1-sol");
    const complete = vi.fn((selected) => selected.contextWindow);
    const collection = { getModel: () => model, complete, otherMethod() { return this; } };
    const wrapped = withContext1MModels(collection, { [reference]: true });
    expect(wrapped.getModel().contextWindow).toBe(CONTEXT_1M_TOKENS);
    expect(wrapped.complete(model)).toBe(CONTEXT_1M_TOKENS);
    expect(wrapped.complete(other)).toBe(272_000);
    expect(wrapped.otherMethod()).toBe(collection);
    expect(model.contextWindow).toBe(272_000);
  });

  it("composes the declared window with global correction", () => {
    const runtime = resolvePiRuntimeModel(resolved, { context1MModels: { [reference]: true } });
    const harness = { getModel: () => runtime.model };
    expect(effectiveContextWindow(harness, runtime, resolved)).toBe(CONTEXT_1M_TOKENS);
    expect(effectiveContextWindow(harness, runtime, resolved, 500_000)).toBe(500_000);
    expect(effectiveContextWindow(harness, runtime, resolved, 1_200_000)).toBe(1_200_000);
  });
});


describe("native Pi 1M context", () => {
  it("rebinds a resumed lane ON/OFF/ON and reports matching live usage", async () => {
    const faux = fauxProvider({ provider: resolved.provider, models: [{ id: resolved.model, contextWindow: 272_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const dispatched = [];
    faux.setResponses([true, false, true].map(() => (_context, _options, _state, model) => {
      dispatched.push(model.contextWindow);
      return fauxAssistantMessage(fauxText("synthetic answer"));
    }));
    let sessionId;
    try {
      for (const context1M of [true, false, true]) {
        const events = [];
        const result = await generatePiNativeResponse("synthetic instructions", {
          model: resolved, piResolvedModel: faux.getModel(), piResolvedModels: models,
          context1MModels: { [reference]: context1M }, effort: "none", allowedTools: [],
          sessionKeepAlive: true, ...(sessionId ? { sessionId } : {}),
          messages: [{ role: "user", content: "synthetic question" }], onEvent: (event) => events.push(event),
        });
        expect(result.error).toBeNull();
        sessionId = result.sessionId;
        expect(events.find((event) => event.type === "context_usage")?.contextWindow).toBe(context1M ? CONTEXT_1M_TOKENS : 272_000);
      }
      expect(dispatched).toEqual([CONTEXT_1M_TOKENS, 272_000, CONTEXT_1M_TOKENS]);
      expect(faux.getModel().contextWindow).toBe(272_000);
    } finally { if (sessionId) await disposeProviderSession(sessionId); }
  });

  it("uses the same proactive and checkpoint threshold at 1M", () => {
    const runtime = resolvePiRuntimeModel(resolved, { context1MModels: { [reference]: true } });
    const policy = resolveLiveCompactionPolicy({ harness: { getModel: () => runtime.model }, runtime, resolved });
    expect(policy.contextWindow).toBe(CONTEXT_1M_TOKENS);
    expect(policy.triggerTokens).toBe(900_000);
    const checkpoint = piCompactionSettings(policy);
    expect(shouldCompact(policy.triggerTokens - 1, policy.contextWindow, checkpoint)).toBe(false);
    expect(shouldCompact(policy.triggerTokens, policy.contextWindow, checkpoint)).toBe(true);
  });
});
