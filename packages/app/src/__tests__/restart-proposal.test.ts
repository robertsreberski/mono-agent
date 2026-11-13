import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ConversationHarnessRuntimeOptionsInput } from "@mono-agent/conversation";
import { describe, expect, it, vi } from "vitest";
import { createRestartProposalService, isProposeRestartToolAllowed, PROPOSE_RESTART_SERVER_NAME, PROPOSE_RESTART_TOOL_NAME } from "../service/restart/restart-proposal.js";
import { createReplyPartBudget } from "../delivery/reply-part-budget.js";

function request(metadata: Record<string, unknown> = { source: "web", web: { threadId: "one", turnId: "turn-1" } }): ConversationHarnessRuntimeOptionsInput {
  return { request: { conversationId: "web:one", userMessage: "work", abortSignal: new AbortController().signal, metadata },
    runId: "run-1", context: {} as never };
}

describe("ProposeRestart request-scoped tool", () => {
  it("observes the app-owned allow/deny policy", () => {
    expect(isProposeRestartToolAllowed({ allowedTools: ["ProposeRestart"], disallowedTools: [] })).toBe(true);
    expect(isProposeRestartToolAllowed({ allowedTools: ["*"], disallowedTools: ["ProposeRestart"] })).toBe(false);
    expect(isProposeRestartToolAllowed({ allowedTools: [], disallowedTools: [] })).toBe(false);
  });

  it("never installs on non-web, unsupported or unverifiable turns", async () => {
    const verify = vi.fn(async () => ({ supported: true }));
    const service = createRestartProposalService({ authority: { verify }, budget: createReplyPartBudget() });
    for (const metadata of [
      { source: "telegram", web: { threadId: "one", turnId: "turn-1" } },
      { source: "slack", web: { threadId: "one", turnId: "turn-1" } },
      { source: "acp", web: { threadId: "one", turnId: "turn-1" } },
      { source: "web", web: { threadId: "one", turnId: "turn-1", trigger: "cron" } },
      { source: "web", web: { turnId: "turn-1" } },
    ]) {
      expect((await service.extension(request(metadata))).runtimeOptions?.mcpServers).toBeUndefined();
    }
    expect(verify).not.toHaveBeenCalled();
    verify.mockResolvedValueOnce({ supported: false });
    expect((await service.extension(request())).runtimeOptions?.mcpServers).toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("registers keylessly on supervised interactive web turns and records one display-only part", async () => {
    const beginStop = vi.fn();
    const verify = vi.fn(async () => ({ supported: true }));
    const authority = { verify, beginStop, accept: vi.fn(), processIdentity: vi.fn() };
    const service = createRestartProposalService({ authority, budget: createReplyPartBudget() });
    const responder = service.wrapResponder({
      async respond() {
        const extension = await service.extension(request());
        const spec = (extension.runtimeOptions?.mcpServers as Record<string, { readonly url: string }>)[PROPOSE_RESTART_SERVER_NAME]!;
        const client = new Client({ name: "proposal-test", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
          expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([PROPOSE_RESTART_TOOL_NAME]);
          const first = await client.callTool({ name: PROPOSE_RESTART_TOOL_NAME, arguments: { reason: `Useful\n${"x".repeat(300)}` } });
          expect(first.structuredContent).toEqual({ status: "proposed", restarted: false });
          expect(JSON.stringify(first.content)).toContain("Nothing has been restarted");
          expect(JSON.stringify(first.content)).toContain("the user must confirm separately");
          expect(JSON.stringify(first.content)).toContain("beneath your reply text");
          for (const guidance of [
            (await client.listTools()).tools.find((tool) => tool.name === PROPOSE_RESTART_TOOL_NAME)?.description,
            JSON.stringify(first.content),
          ]) {
            expect(guidance).toContain("An answer already written before this call counts as the reply");
            expect(guidance).toContain("do not repeat or rephrase it");
            expect(guidance).toContain("If you have not answered yet, write the answer as normal assistant prose");
            expect(guidance).toContain("progress updates alone do not count");
            expect(guidance).toContain("add only genuinely new information if needed");
            expect(guidance).toContain("otherwise end without extra prose");
            expect(guidance).not.toContain("must still write");
          }
          const second = await client.callTool({ name: PROPOSE_RESTART_TOOL_NAME, arguments: { reason: "another" } });
          expect(second.structuredContent).toEqual({ status: "already_proposed", restarted: false });
        } finally {
          await client.close();
          await extension.cleanup?.();
        }
        return { text: "answer", metadata: { runId: "run-1" } };
      },
    });
    const reply = await responder.respond({ conversationId: "web:one", text: "work", metadata: {}, abortSignal: new AbortController().signal }, {} as never);
    expect(reply.parts).toHaveLength(1);
    expect(reply.parts?.[0]).toMatchObject({ type: "restart_proposal", reason: expect.stringMatching(/^Useful /u) });
    expect((reply.parts?.[0] as { reason?: string }).reason?.length).toBe(280);
    expect(beginStop).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
