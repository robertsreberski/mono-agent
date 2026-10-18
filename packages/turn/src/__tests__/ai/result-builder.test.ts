import { expect, expectTypeOf, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { generateEngineTurnResponse } from "../../execution/pi/run.js";
import { createMetricsObserver } from "../../telemetry/observer.js";
import { estimateCost } from "../../telemetry/cost.js";
import { buildSuccessResult, emitUsageCostEvents, withSubagentUsage } from "../../execution/pi/result-builder.js";

const own = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 };
const child = { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 2 };

it.each([
  { name: "unpriced alone", reported: 0, estimate: null, delegated: 0, total: null, known: undefined },
  { name: "unpriced with priced child", reported: 0, estimate: null, delegated: 2, total: null, known: 2 },
  { name: "priced with unknown child", reported: 3, estimate: 5, delegated: null, total: null, known: 3 },
  { name: "provider price", reported: 3, estimate: 5, delegated: 2, total: 5, known: undefined },
  { name: "estimated price", reported: 0, estimate: 5, delegated: 2, total: 7, known: undefined },
  { name: "known zero price", reported: 0, estimate: 0, delegated: 0, total: 0, known: undefined },
])("preserves complete and unknown accounting: $name", ({ reported, estimate, delegated, total, known }) => {
  const usage = withSubagentUsage({ ...own, cost: reported }, { ...child, costUsd: delegated }, estimate);
  expect(usage).toMatchObject({ input: 10, output: 7, cost: total });
  expect(usage.knownCostUsd).toBe(known);
  const events: Array<{ type: string; cumulativeUsd?: unknown; knownCostUsd?: number }> = [];
  emitUsageCostEvents({ onEvent: (event) => events.push(event), reference: "faux:fictional", usage, estimatedCost: estimate,
    start: Date.now(), externalAbort: false });
  expect(events.find((event) => event.type === "cost_accumulated"))
    .toMatchObject({ cumulativeUsd: total });
  expect(events.find((event) => event.type === "cost_accumulated")?.knownCostUsd).toBe(known);
  const result = buildSuccessResult({ finalText: "Synthetic reply", finalThinking: "", events, usage, estimatedCost: estimate,
    start: Date.now(), turnCount: 1, runAssistantCount: 1, resolved: { provider: "faux", model: "fictional" }, options: {},
    externalAbort: false, errorMessage: null, errorDetails: null, diagnostics: {}, maxTurnsHit: false,
    providerSessionId: "fictional-session", runtimeWarnings: [], capabilitiesUsed: {}, structuredResult: undefined });
  expect(result.usage.cost_usd).toBe(total);
  expect(result.usage.known_cost_usd).toBe(known);
  expectTypeOf(result.failureKind).toEqualTypeOf<string | null>();
  expect(own.cost).toBe(0);
  expect(child.costUsd).toBe(2);
});

it("retains known descendants through an unknown inclusive child", () => {
  const middle = withSubagentUsage(own, child, null);
  const parent = withSubagentUsage({ ...own, cost: 3 }, { ...child, costUsd: middle.cost, ...(middle.knownCostUsd === undefined ? {} : { knownCostUsd: middle.knownCostUsd }) }, 4);
  expect(parent).toMatchObject({ cost: null, knownCostUsd: 5 });
  expect(withSubagentUsage(own, { ...child, costUsd: 0 }, Number.NaN).cost).toBeNull();
});

it("keeps an unpriced provider failure before usage numeric in the result, events and observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthetic-zero-usage-"));
  const faux = fauxProvider({ models: [{ id: "synthetic-unpriced", contextWindow: 100000, maxTokens: 4096 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const observer = createMetricsObserver();
  const events: Array<{ type: string; cumulativeUsd?: unknown }> = [];
  const failure = vi.spyOn(faux.provider, "streamSimple").mockImplementation(() => { throw new Error("Synthetic provider failure before usage"); });
  try {
    const result = await generateEngineTurnResponse("Synthetic rules", {
      model: { provider: "faux", model: "synthetic-unpriced", reference: "faux:synthetic-unpriced" },
      piResolvedModel: faux.getModel(), piResolvedModels: models, cwd: root, allowedTools: [],
      messages: [{ role: "user", content: "Synthetic input" }], compaction: { enabled: false }, piMaxRetries: 0,
      onEvent(event: { type: string; cumulativeUsd?: unknown }) { events.push(event); observer.recordEvent(event); },
    });
    expect(estimateCost({ model: "faux:synthetic-unpriced" })).toBeNull();
    expect(failure).toHaveBeenCalled();
    expect(result.error).toBeTruthy();
    expect(result.usage).toMatchObject({ cost_usd: 0, input_tokens: null, output_tokens: null });
    expect(result.usage).not.toHaveProperty("known_cost_usd");
    const costs = events.filter((event) => event.type === "cost_accumulated");
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((event) => event.cumulativeUsd === 0)).toBe(true);
    expect(observer.snapshot().cost).toEqual({ cumulativeUsd: 0 });
  } finally {
    failure.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
