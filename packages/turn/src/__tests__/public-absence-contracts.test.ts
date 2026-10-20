import { expect, expectTypeOf, it } from "vitest";
import { createMetricsObserver, createPiOAuthApiKeyResolver, createRouterRuntime, createRuntime } from "@mono-agent/turn";
import { classifyFailure, fileChangeSummary, normalizePricing, statsForCompletedChange, retryableProviderFailureInfo } from "@mono-agent/turn/ai";
import { buildTranscriptTailSnapshot } from "@mono-agent/turn/agent";
import { MemorySessionRepo, estimateContextTokens } from "@mono-agent/turn/engine";
import { createSessionRegistry, normalizeDurableSessionsRoot } from "@mono-agent/turn/engine/sessions.js";
import { createToolContext, normalizeBackgroundBashTimeoutMs, normalizeBackgroundTimeoutMs, updateToolContext } from "@mono-agent/turn/tools";

it("exposes absence through the published entries instead of promising a value", async () => {
  expect(retryableProviderFailureInfo({ errorText: null, stderrTail: null, failureKind: undefined })).toMatchObject({ retryable: false });
  expect(classifyFailure({ errorText: null, stderrTail: undefined })).toBe("spawn");
  const pricing = normalizePricing({ input: 1 });
  expect(pricing).toHaveProperty("source", undefined);
  expectTypeOf<NonNullable<typeof pricing>["source"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf(createMetricsObserver().snapshot().cache.hitRatio).toEqualTypeOf<number | null>();
  expect(createMetricsObserver().snapshot().cache.hitRatio).toBeNull();
  expect(statsForCompletedChange({}, undefined, undefined)).toBeNull();
  expect(fileChangeSummary([])).toBeNull();
  expect(buildTranscriptTailSnapshot(undefined)).toBeNull();
  expect(normalizeDurableSessionsRoot(undefined)).toBeNull();
  expectTypeOf(normalizeDurableSessionsRoot(undefined)).toEqualTypeOf<string | null>();
  expectTypeOf(normalizeBackgroundTimeoutMs(undefined)).toEqualTypeOf<number | undefined>();
  expectTypeOf(normalizeBackgroundBashTimeoutMs(undefined)).toEqualTypeOf<number | undefined>();
  expect(normalizeBackgroundTimeoutMs(undefined)).toBeUndefined();
  expect(normalizeBackgroundBashTimeoutMs(undefined)).toBeUndefined();
  expectTypeOf(estimateContextTokens([]).lastUsageIndex).toEqualTypeOf<number | null>();
  expect(estimateContextTokens([]).lastUsageIndex).toBeNull();

  const repo = new MemorySessionRepo();
  const store = await repo.create({ id: "absence-contract" });
  try {
    expectTypeOf(store.tip).toEqualTypeOf<string | null>();
    expectTypeOf(await store.getLeafId()).toEqualTypeOf<string | null>();
    expect(store.tip).toBeNull();
    expect(store.repairCache).toBeNull();
    await store.beginTurn("fictional-turn");
    await store.endTurn("fictional-turn", "completed");
  } finally {
    await repo.close();
  }
});

it("supports explicit resets and default TTLs without weakening exact optional checking", async () => {
  const context = createToolContext({ workspace: "/fictional", runId: "fictional-run" });
  updateToolContext(context, { workspace: undefined, toolEnvironment: undefined });
  expect(Object.hasOwn(context, "workspace")).toBe(true);
  expect(context.workspace).toBeUndefined();
  expect(context.runId).toBe("fictional-run");
  const registry = createSessionRegistry({ idleTimeoutMs: undefined });
  registry.set("fictional", {}, { idleTimeoutMs: undefined });
  registry.touch("fictional", { idleTimeoutMs: undefined });
  await registry.disposeAll();
  const resolver = createPiOAuthApiKeyResolver();
  expect(await resolver.readCredential("fictional")).toBeUndefined();
  expect(await resolver.modifyCredential("fictional", async () => undefined)).toBeUndefined();
  await resolver.deleteCredential("fictional");
});

// Compile-only: never dispatch a provider request from a declaration test.
function checkStrictConsumers() {
  // @ts-expect-error no cache signal means a nullable ratio
  const ratio: number = createMetricsObserver().snapshot().cache.hitRatio;
  // @ts-expect-error no file change means no summary
  const summary: object = fileChangeSummary([]);
  // @ts-expect-error no completed turn means no snapshot
  const snapshot: object = buildTranscriptTailSnapshot([]);
  const router = createRouterRuntime();
  void router.run("Fictional prompt");
  void router.run("Fictional prompt", {});
  // @ts-expect-error direct runtimes still require a selected model
  void createRuntime().run("Fictional prompt", {});
  void [ratio, summary, snapshot];
}
void checkStrictConsumers;
