import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { classifyCompactionFailure } from "../../execution/pi/compaction/manual-failure.js";
import { summaryModels } from "../../execution/pi/compaction/compaction-summary.js";

describe("content-free compaction diagnostics", () => {
  it.each([
    [{ status: 529, message: "private fixture text" }, { reason: "provider_overloaded", httpStatus: 529 }],
    [{ status: 400, message: "prompt is too long: private fixture text" }, { reason: "context_too_large", httpStatus: 400 }],
    [{ name: "TimeoutError" }, { reason: "timeout" }],
    [{ code: "aborted" }, { reason: "cancelled" }],
    [{ status: 429 }, { reason: "rate_limited", httpStatus: 429 }],
    [{ code: "auth" }, { reason: "authentication" }],
    [{ code: "summary_refused" }, { reason: "summary_refused" }],
    [{ message: "Summary cannot fit a useful answer" }, { reason: "insufficient_headroom" }],
  ])("classifies %j without copying prose", (error, expected) => {
    expect(classifyCompactionFailure(error)).toEqual(expected);
  });
  it("preserves provider status through the summary exception scrubber", async () => {
    const models = summaryModels({ completeSimple: async () => { throw Object.assign(new Error("private fixture text"), { status: 529 }); } },
      { operationId: "fictional", focus: "", requests: [] });
    const model = { id: "fictional", provider: "fictional", api: "openai-completions", contextWindow: 200_000, maxTokens: 8192 };
    const failure = await models.completeSimple(model, { messages: [] }, { maxTokens: 4096 }).catch((error: unknown) => error);
    expect(classifyCompactionFailure(failure)).toEqual({ reason: "provider_overloaded", httpStatus: 529 });
    expect(String(failure)).not.toContain("private fixture text");
  });
});

it("uses Opus's catalog 1M window for a large summary without a context1M toggle", async () => {
  const model = getBuiltinModel("anthropic", "claude-opus-5-5");
  expect(model.contextWindow).toBe(1_000_000);
  let dispatched = false;
  const facade = summaryModels({ completeSimple: async (selected: typeof model, _context: unknown, options: { maxTokens: number }) => {
    expect(selected.contextWindow).toBe(1_000_000);
    expect(options.maxTokens).toBeGreaterThan(0);
    dispatched = true;
    return { stopReason: "stop", content: [{ type: "text", text: "Fictional summary" }] };
  } }, { operationId: "fictional-large", focus: "", requests: [], effort: "none" });
  await facade.completeSimple(model, { messages: [{ role: "user", content: "Fictional context. ".repeat(90_000), timestamp: 0 }] }, { maxTokens: 8192 });
  expect(dispatched).toBe(true);
});

it("applies the explicit manual summary deadline without changing automatic defaults", async () => {
  for (const timeoutMs of [undefined, 15 * 60_000]) {
    let observed: Record<string, unknown> | undefined;
    const facade = summaryModels({ completeSimple: async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      observed = options;
      return { stopReason: "stop", content: [{ type: "text", text: "Fictional summary" }] };
    } }, { operationId: "fictional-deadline", focus: "", requests: [], ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    await facade.completeSimple({ id: "fictional", provider: "fictional", api: "openai-completions", contextWindow: 200_000, maxTokens: 8192 }, { messages: [] }, { maxTokens: 4096 });
    expect(observed?.timeoutMs).toBe(timeoutMs);
  }
});
