import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it } from "vitest";
import { createSuggestRepliesService, isSuggestRepliesToolAllowed, SUGGEST_REPLIES_SERVER_NAME, SUGGEST_REPLIES_TOOL_NAME } from "../suggest-replies.js";
import { createReplyPartBudget } from "../reply-part-budget.js";

function request(metadata: Record<string, unknown> = { source: "web", web: { threadId: "one", turnId: "turn-1" } }): AgentHarnessRuntimeOptionsInput {
  return { request: { conversationId: "web:one", userMessage: "work", abortSignal: new AbortController().signal, metadata },
    runId: "run-1", context: {} as never };
}

describe("SuggestReplies", () => {
  it("honors ordinary allow/deny policy including MCP aliases", () => {
    expect(isSuggestRepliesToolAllowed({ allowedTools: ["SuggestReplies"], disallowedTools: [] })).toBe(true);
    expect(isSuggestRepliesToolAllowed({ allowedTools: ["*"], disallowedTools: ["SuggestReplies"] })).toBe(false);
    expect(isSuggestRepliesToolAllowed({ allowedTools: [], disallowedTools: [] })).toBe(false);
    expect(isSuggestRepliesToolAllowed({ allowedTools: ["*"], disallowedTools: [`mcp__${SUGGEST_REPLIES_SERVER_NAME}__*`] })).toBe(false);
  });

  it("never offers choices on non-web destinations or cron turns", async () => {
    const service = createSuggestRepliesService({ budget: createReplyPartBudget() });
    for (const source of ["telegram", "slack", "cron", "webhook", "tui", "acp", "a2a", "openaiApi"]) {
      expect((await service.extension(request({ source, web: { threadId: "one", turnId: "turn-1" } }))).runtimeOptions?.mcpServers).toBeUndefined();
    }
    for (const web of [{ threadId: "one" }, { threadId: "other", turnId: "turn-1" }, { threadId: "one", turnId: "turn-1", trigger: "cron" }]) {
      expect((await service.extension(request({ source: "web", web }))).runtimeOptions?.mcpServers).toBeUndefined();
    }
  });

  for (const web of [{ threadId: "one", turnId: "turn-1" }, { trigger: "job" }]) {
    it(`validates and replaces one persisted set on ${"trigger" in web ? "job wake" : "interactive"} turns`, async () => {
      const budget = createReplyPartBudget(1);
      const service = createSuggestRepliesService({ budget });
      const responder = service.wrapResponder({ async respond() {
        const extension = await service.extension(request({ source: "web", web }));
        const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)[SUGGEST_REPLIES_SERVER_NAME]!;
        const client = new Client({ name: "choices-test", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
          expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([SUGGEST_REPLIES_TOOL_NAME]);
          for (const options of [[], ["one"], Array.from({ length: 9 }, (_, index) => String(index)), ["", "two"], [" ", "two"], ["x".repeat(76), "two"], ["one\ntwo", "three"], ["one\u2028two", "three"], [" one ", "one"]]) {
            expect((await client.callTool({ name: SUGGEST_REPLIES_TOOL_NAME, arguments: { options } })).isError).toBe(true);
          }
          expect((await client.callTool({ name: SUGGEST_REPLIES_TOOL_NAME, arguments: { options: [" first ", "second"] } })).structuredContent).toEqual({ status: "suggested" });
          expect(budget.claim("run-1", "another-part")).toBe("limit");
          expect((await client.callTool({ name: SUGGEST_REPLIES_TOOL_NAME, arguments: { options: [" Review draft ", "Keep going", "x".repeat(75)] } })).structuredContent).toEqual({ status: "suggested" });
        } finally { await client.close(); await extension.cleanup?.(); }
        return { text: "answer", metadata: { runId: "run-1", turnDisposition: "silent" } };
      } });
      const reply = await responder.respond({ conversationId: "web:one", text: "work", abortSignal: new AbortController().signal }, {} as never);
      expect(reply.parts).toEqual([{ type: "reply_options", id: expect.any(String), options: ["Review draft", "Keep going", "x".repeat(75)] }]);
      expect(reply.metadata?.turnDisposition).toBe("visible");
    });
  }

  it("refuses a new set when the shared part budget is full", async () => {
    const budget = createReplyPartBudget(1);
    budget.claim("run-1", "attachment:one");
    const service = createSuggestRepliesService({ budget });
    const extension = await service.extension(request());
    const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)[SUGGEST_REPLIES_SERVER_NAME]!;
    const client = new Client({ name: "budget-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: SUGGEST_REPLIES_TOOL_NAME, arguments: { options: ["one", "two"] } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ status: "unavailable" });
    } finally { await client.close(); await extension.cleanup?.(); }
  });
});
