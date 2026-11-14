import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import type { RuntimeRunOptions } from "@mono-agent/turn/host/types";
import { estimateTokens } from "../../engine/compaction-kit/compaction.js";
import { estimateFixedOverheadTokens, resolveAgentCompactionPolicy } from "../../agent/compaction.js";
import { toAgentMessages } from "../../providers/pi/messages.js";

// Fictional, provider-free. The fixed 16k cold handover ceiling is always
// lowered by real destination headroom; the formula itself is unchanged.
const SYSTEM = "Fictional system.";
const CEILING = 16_000;
type Compaction = NonNullable<RuntimeRunOptions["compaction"]>;
interface Scenario { window?: number; outputTokens?: number; compaction: Compaction; history?: string; evidence?: (maxTokens: number) => string | undefined }

async function seed({ window = 128_000, outputTokens = 4096, compaction, history = "Fictional prior request.", evidence }: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "pack-ceiling-"));
  const runtime = createMonoRuntime({ workspace: root });
  try {
    const provider = fauxProvider({ models: [{ id: "fixture", contextWindow: window, maxTokens: outputTokens }], tokensPerSecond: 1_000_000 });
    const models = createModels(); models.setProvider(provider.provider);
    const model = provider.getModel("fixture")!;
    const messages = [{ role: "user" as const, content: history }, { role: "assistant" as const, content: "Fictional prior reply." }, { role: "user" as const, content: "Current fictional input." }];
    // Independent recomputation of the unchanged formula from its exported parts.
    const policy = resolveAgentCompactionPolicy({ compaction }, { contextWindow: Number(compaction.contextWindowOverride) || window });
    const effectiveWindow = Math.min(policy.contextWindow, Number(compaction.contextWindowOverride) || window);
    const fixed = estimateFixedOverheadTokens({ systemPrompt: SYSTEM, tools: [] }).fixedOverheadTokens;
    const input = toAgentMessages(messages, model).reduce((sum: number, message: unknown) => sum + Number(estimateTokens(message as never)), 0);
    const headroom = Math.floor(Math.min(effectiveWindow, policy.triggerTokens) - fixed - input - (Math.max(4096, outputTokens) + 4096));
    const expected = Math.max(0, Math.min(CEILING, headroom));
    const requests: unknown[] = [], events: { type?: string; error_code?: string }[] = [];
    let offered = -1, sentEvidence: string | undefined;
    provider.setResponses([context => { requests.push(structuredClone(context)); return fauxAssistantMessage("Fictional answer."); }]);
    const result = await runtime.run(SYSTEM, { model: { provider: "faux", model: "fixture", reference: "faux:fixture" },
      abortSignal: new AbortController().signal, piResolvedModel: model, piResolvedModels: models, effort: "none", allowedTools: [], mcpServers: {},
      messages, compaction, onEvent: event => events.push(event as never),
      coldContext: async ({ maxTokens }) => {
        offered = maxTokens; sentEvidence = evidence?.(maxTokens);
        return { messages: sentEvidence === undefined ? [] : [{ role: "user", content: sentEvidence }] };
      } });
    expect(result.failureKind).toBeFalsy(); expect(requests).toHaveLength(1);
    const omitted = events.some(event => event.type === "runtime_warning" && event.error_code === "headroom");
    return { offered, expected: expected < 500 ? 0 : expected, headroom, model, sent: sentEvidence, delivered: sentEvidence !== undefined && JSON.stringify(requests[0]).includes(JSON.stringify(sentEvidence).slice(1, -1)), omitted };
  } finally { await runtime.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
}
const enabled: Compaction = { enabled: true, keepRecentTokens: 4000, summaryMaxTokens: 1000, minSavingsTokens: 0 };
/** Text whose converted estimate is exactly `tokens` for the same model. */
function evidenceOf(tokens: number, model: unknown) {
  const estimate = (text: string) => Number(estimateTokens(toAgentMessages([{ role: "user", content: text }], model)[0]));
  let text = "Fictional pack 🦊 Ż \"quoted\". ".repeat(Math.max(1, Math.floor(tokens / 12)));
  while (estimate(text) < tokens) text += "x";
  while (estimate(text) > tokens) text = text.slice(0, -1);
  expect(estimate(text)).toBe(tokens);
  return text;
}

it("offers the fixed 16k ceiling, not the former 8k, when destination headroom is ample", async () => {
  const run = await seed({ compaction: enabled });
  expect(run.headroom).toBeGreaterThan(CEILING); expect(run.offered).toBe(CEILING); expect(run.expected).toBe(CEILING);
});

it.each([
  ["maxInputTokens trigger override", { window: 128_000, outputTokens: 12_000, compaction: { ...enabled, maxInputTokens: 32_000 } }],
  ["contextWindowOverride", { window: 128_000, compaction: { ...enabled, contextWindowOverride: 40_000 } }],
  ["small destination window", { window: 36_000, compaction: enabled }],
] as const)("keeps the unchanged headroom clamp below 16k under a %s", async (_name, scenario) => {
  const run = await seed(scenario);
  expect(run.headroom).toBeLessThan(CEILING); expect(run.headroom).toBeGreaterThanOrEqual(500);
  expect(run.offered).toBe(run.expected); expect(run.offered).toBe(run.headroom);
});

it("clamps near-trigger history between the old and new ceilings, and zeroes it below 500 tokens", async () => {
  // Grow the replayed history until headroom lands strictly between 8k and 16k.
  const between = await seed({ compaction: { ...enabled, maxInputTokens: 32_000 }, history: "x".repeat(4 * 10_000) });
  expect(between.headroom).toBeGreaterThan(8000); expect(between.headroom).toBeLessThan(CEILING);
  expect(between.offered).toBe(between.headroom);
  const near = await seed({ compaction: { ...enabled, maxInputTokens: 32_000 }, history: "x".repeat(4 * 23_500) });
  expect(near.headroom).toBeLessThan(500); expect(near.offered).toBe(0);
});

it("persists converted evidence exactly at the offered allowance and rejects it one token above", async () => {
  const model = (await seed({ compaction: enabled })).model;
  const fits = await seed({ compaction: enabled, evidence: maxTokens => evidenceOf(maxTokens, model) });
  expect(fits.offered).toBe(CEILING); expect(fits.delivered).toBe(true); expect(fits.omitted).toBe(false);
  const over = await seed({ compaction: enabled, evidence: maxTokens => evidenceOf(maxTokens + 1, model) });
  expect(over.offered).toBe(CEILING); expect(over.delivered).toBe(false); expect(over.omitted).toBe(true);
  // Headroom-limited destinations reject against their own smaller allowance.
  const limited = { window: 128_000, outputTokens: 12_000, compaction: { ...enabled, maxInputTokens: 32_000 } };
  const limitedOver = await seed({ ...limited, evidence: maxTokens => evidenceOf(maxTokens + 1, model) });
  expect(limitedOver.offered).toBeLessThan(CEILING); expect(limitedOver.delivered).toBe(false); expect(limitedOver.omitted).toBe(true);
}, 30_000);
