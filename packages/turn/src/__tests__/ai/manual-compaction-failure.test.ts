import type { AgentManualCompactionDiagnostic } from "@mono-agent/contracts";
import { retryAssistantCall } from "@earendil-works/pi-ai";
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
    let diagnostic: AgentManualCompactionDiagnostic | undefined;
    const models = summaryModels({ completeSimple: async () => { throw Object.assign(new Error("private fixture text"), { status: 529 }); } },
      { operationId: "fictional", focus: "", requests: [], onDiagnostic: value => { diagnostic = value; } });
    const model = { id: "fictional", provider: "fictional", api: "openai-completions", contextWindow: 200_000, maxTokens: 8192 };
    const failure = await models.completeSimple(model, { messages: [] }, { maxTokens: 4096 }).catch((error: unknown) => error);
    expect(diagnostic).toEqual({ reason: "provider_overloaded", httpStatus: 529 });
    expect(String(failure)).toContain("request_failed");
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


describe("summary proxy preserves Pi retry classification", () => {
  const model = { id: "fictional", provider: "fictional", api: "openai-completions", contextWindow: 200_000, maxTokens: 8192 };
  const policy = { enabled: true, maxRetries: 1, baseDelayMs: 0 };
  const errorResponse = (errorMessage: string) => ({ stopReason: "error", errorMessage, content: [] });

  it.each(["fetch failed", "socket hang up", "terminated", "stream ended before message_stop", "connection error", "server_error"])(
    "still retries %s and preserves final typed diagnostics", async message => {
      const first = errorResponse(message);
      const final = errorResponse("HTTP 529 overloaded: fictional private fixture text");
      let calls = 0;
      let diagnostic: AgentManualCompactionDiagnostic | undefined;
      const facade = summaryModels({ completeSimple: async () => ++calls === 1 ? first : final }, {
        operationId: "fictional-retry", focus: "", requests: [], onDiagnostic: value => { diagnostic = value; },
      });
      const result = await retryAssistantCall(() => facade.completeSimple(model, { messages: [] }, { maxTokens: 4096 }), policy, undefined);
      expect(calls).toBe(2);
      expect(result).toBe(final);
      expect(diagnostic).toEqual({ reason: "provider_overloaded", httpStatus: 529 });
      expect(JSON.stringify(diagnostic)).not.toContain("fictional private fixture text");
    },
  );

  it.each(["insufficient_quota", "GoUsageLimitError"])("does not retry HTTP 429 %s", async quota => {
    const response = errorResponse(`HTTP 429 ${quota}: fictional private fixture text`);
    let calls = 0;
    let diagnostic: AgentManualCompactionDiagnostic | undefined;
    const facade = summaryModels({ completeSimple: async () => { calls++; return response; } }, {
      operationId: "fictional-quota", focus: "", requests: [], onDiagnostic: value => { diagnostic = value; },
    });
    const result = await retryAssistantCall(() => facade.completeSimple(model, { messages: [] }, { maxTokens: 4096 }), policy, undefined);
    expect(calls).toBe(1);
    expect(result).toBe(response);
    expect(diagnostic).toEqual({ reason: "rate_limited", httpStatus: 429 });
    expect(JSON.stringify(diagnostic)).not.toContain("fictional private fixture text");
  });

  it("clears a previous failure when its retry succeeds", async () => {
    let calls = 0;
    let diagnostic: AgentManualCompactionDiagnostic | undefined;
    const success = { stopReason: "stop", content: [{ type: "text", text: "Fictional summary" }] };
    const facade = summaryModels({ completeSimple: async () => ++calls === 1 ? errorResponse("fetch failed") : success }, {
      operationId: "fictional-recovered", focus: "", requests: [], onDiagnostic: value => { diagnostic = value; },
    });
    expect(await retryAssistantCall(() => facade.completeSimple(model, { messages: [] }, { maxTokens: 4096 }), policy, undefined)).toBe(success);
    expect(calls).toBe(2);
    expect(diagnostic).toBeUndefined();
  });
});
