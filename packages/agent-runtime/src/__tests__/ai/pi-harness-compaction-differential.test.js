import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "../../ai/providers/pi-native/harness/compaction-kit/compaction.js";
import { PI_CONTEXT } from "../../ai/providers/pi-native/harness/context.js";

// Captured before the pin bump using the published 0.99.2 helpers, not generated
// from the implementation under test. The deterministic provider is synthetic.
const baseline = JSON.parse(readFileSync(new URL("./fixtures/pi-harness/compaction-baseline.json", import.meta.url), "utf8"));
describe("owned compaction kit vs 0.99.2 baseline", () => {
  it("preserves summary input, retained tail, tokensBefore and billed usage", async () => {
    const prepared = prepareCompaction(baseline.pathEntries, baseline.settings);
    expect(prepared.ok).toBe(true);
    const requests = [];
    const models = { completeSimple: async (_model, context, options) => {
      requests.push({ context: { ...context, messages: context.messages.map(({ timestamp, ...m }) => m) },
        options: { maxTokens: options.maxTokens, cacheRetention: options.cacheRetention } });
      return { ...baseline.pathEntries[1].message, content: [{ type: "text", text: "Fictional deterministic summary." }] };
    } };
    const result = await compact(prepared.value, models,
      { id: "fixture-model", provider: "faux", maxTokens: 4096, reasoning: false },
      "Keep queue details.", "off", undefined, undefined, PI_CONTEXT);
    expect(requests).toEqual(baseline.requests);
    expect(result).toEqual(baseline.result);
  });
});

it("matches baseline-main manual split-turn compaction through the complete runtime", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createModels, fauxAssistantMessage, fauxProvider, fauxText } = await import("@earendil-works/pi-ai");
  const { generatePiNativeResponse } = await import("../../ai/providers/pi-native.js");
  const { disposeProviderSession } = await import("../../ai/runtime/sessions.js");
  const { JsonlSessionRepo } = await import("../../ai/providers/pi-native/harness/session-store.js");
  const baseline = JSON.parse(readFileSync(new URL("./fixtures/pi-harness/runtime-compaction-baseline.json", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "mono-pi-runtime-diff-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "differential-model", contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const history = [];
  for (let i = 0; i < 8; i++) {
    history.push({ role: "user", content: `Fictional request ${i}: ${"x".repeat(4000)}` });
    history.push({ role: "assistant", content: `Fictional answer ${i}: ${"y".repeat(8000)}` });
  }
  const requests = [];
  const respond = (context, options) => {
    requests.push({ context, options: { maxTokens: options.maxTokens, cacheRetention: options.cacheRetention } });
    return fauxAssistantMessage([fauxText("Fictional deterministic summary.")]);
  };
  faux.setResponses([respond, respond]);
  const clean = (value) => JSON.parse(JSON.stringify(value, (k, v) => k === "timestamp" ? undefined
    : k === "api" && String(v).startsWith("faux:") ? "faux:fixture-api" : v));
  let result, raw;
  try {
    result = await generatePiNativeResponse("Fictional system.", {
      model: { provider: "faux", model: "differential-model", reference: "faux:differential-model" },
      piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", allowedTools: [], messages: history,
      manualCompaction: true, sessionKeepAlive: true, piSessionsRoot: root,
      compaction: { keepRecentTokens: 4000, summaryMaxTokens: 2000, compactionMinSavingsTokens: 0 },
    });
    expect(result.manualCompaction?.status).toBe("succeeded");
    const repo = new JsonlSessionRepo({ sessionsRoot: root }); raw = await repo.open((await repo.list())[0]);
    const entry = (await raw.getEntries()).find((e) => e.type === "compaction");
    expect(clean({ requests, compaction: { summary: entry.summary, retainedTail: entry.retainedTail, tokensBefore: entry.tokensBefore, usage: entry.usage },
      status: result.manualCompaction.status, error: result.error })).toEqual((({ source, ...rest }) => rest)(baseline));
  } finally {
    await raw?.close();
    if (result?.providerSessionId) await disposeProviderSession(result.providerSessionId);
    await rm(root, { recursive: true, force: true });
  }
});
