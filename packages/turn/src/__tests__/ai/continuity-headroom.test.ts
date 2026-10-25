import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { estimateTokens } from "../../engine/compaction-kit/compaction.js";
import { estimateFixedOverheadTokens } from "../../agent/compaction.js";

it("does not let a cold pack push near-trigger canonical history into a proactive summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "trigger-pack-"));
  const runtime = createMonoRuntime({ workspace: root });
  try {
    const provider = fauxProvider({ models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 1_000_000 });
    const models = createModels(); models.setProvider(provider.provider);
    const system = "Fictional system.", trigger = 32000;
    const fixed = estimateFixedOverheadTokens({ systemPrompt: system, tools: [] }).fixedOverheadTokens;
    const historical = { role: "user" as const, content: "x".repeat(Math.floor((trigger - fixed - 200) * 4)), timestamp: "1970-01-01T00:00:00.000Z" };
    const estimated = estimateTokens({ ...historical, timestamp: 0 });
    expect(estimated + fixed).toBeLessThan(trigger); expect(estimated + fixed).toBeGreaterThan(trigger - 500);
    let calls = 0, offeredBudget = -1;
    const events: unknown[] = [];
    provider.setResponses([() => { calls++; return fauxAssistantMessage("Fictional answer."); }]);
    const result = await runtime.run(system, { model: { provider: "faux", model: "fixture", reference: "faux:fixture" },
      abortSignal: new AbortController().signal, piResolvedModel: provider.getModel("fixture")!, piResolvedModels: models, effort: "none", allowedTools: [], mcpServers: {},
      messages: [historical, { role: "assistant", content: "Fictional prior reply." }, { role: "user", content: "Current input." }],
      compaction: { enabled: true, maxInputTokens: trigger, keepRecentTokens: 4000, summaryMaxTokens: 1000, minSavingsTokens: 0 }, onEvent: event => events.push(event),
      coldContext: async ({ maxTokens }) => { offeredBudget = maxTokens; return { messages: maxTokens < 500 ? [] : [{ role: "user", content: "Historical pack. ".repeat(600) }] }; },
    });
    expect(result.failureKind).toBeFalsy(); expect(offeredBudget).toBe(0); expect(calls).toBe(1);
    expect(events.filter(event => (event as { type?: string }).type === "context_compaction")).toEqual([]);
  } finally { await runtime.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
});

it("refuses a cold-context replay replacement when the native seed has no prior messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "empty-seed-pack-"));
  const runtime = createMonoRuntime({ workspace: root });
  try {
    const provider = fauxProvider({ models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: 1_000_000 });
    const models = createModels(); models.setProvider(provider.provider);
    const requests: unknown[] = [], events: unknown[] = [];
    provider.setResponses([context => { requests.push(structuredClone(context)); return fauxAssistantMessage("Fictional answer."); }]);
    const result = await runtime.run("Fictional system.", { model: { provider: "faux", model: "fixture", reference: "faux:fixture" },
      abortSignal: new AbortController().signal, piResolvedModel: provider.getModel("fixture")!, piResolvedModels: models,
      effort: "none", allowedTools: [], mcpServers: {}, messages: [{ role: "user", content: "CURRENT-INPUT" }],
      compaction: { enabled: true, maxInputTokens: 32000, keepRecentTokens: 4000, summaryMaxTokens: 1000, minSavingsTokens: 0 }, onEvent: event => events.push(event),
      coldContext: async () => ({ messages: [{ role: "user", content: "HISTORICAL-PACK" }],
        replayMessages: [{ role: "user", content: "UNBUDGETED-CANONICAL-SWAP ".repeat(7000) }] }),
    });
    expect(result.failureKind).toBeFalsy(); expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).toContain("HISTORICAL-PACK"); expect(JSON.stringify(requests)).not.toContain("UNBUDGETED-CANONICAL-SWAP");
    expect(events.filter(event => (event as { type?: string }).type === "context_compaction")).toEqual([]);
  } finally { await runtime.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
});
