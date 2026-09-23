import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { createRestartProposalService, isProposeRestartToolAllowed, PROPOSE_RESTART_SERVER_NAME, PROPOSE_RESTART_TOOL_NAME } from "../restart-proposal.js";
import { createReplyPartBudget } from "../reply-part-budget.js";

function request(metadata: Record<string, unknown> = { source: "web", web: { threadId: "one", turnId: "turn-1" } }): AgentHarnessRuntimeOptionsInput {
  return { request: { conversationId: "web:one", userMessage: "work", abortSignal: new AbortController().signal, metadata },
    runId: "run-1", context: {} as never };
}

describe("ProposeRestart request-scoped tool", () => {
  it("observes the app-owned allow/deny policy", () => {
    expect(isProposeRestartToolAllowed({ allowedTools: ["ProposeRestart"], disallowedTools: [] })).toBe(true);
    expect(isProposeRestartToolAllowed({ allowedTools: ["*"], disallowedTools: ["ProposeRestart"] })).toBe(false);
    expect(isProposeRestartToolAllowed({ allowedTools: [], disallowedTools: [] })).toBe(false);
  });

  it("never installs on non-web, keyless, unsupported or unverifiable turns", async () => {
    const verify = vi.fn(async () => ({ supported: true }));
    let keyed = false;
    const service = createRestartProposalService({ authority: { verify }, isKeyed: () => keyed, budget: createReplyPartBudget() });
    expect((await service.extension(request())).runtimeOptions?.mcpServers).toBeUndefined();
    keyed = true;
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

  it("records one display-only part for the reply and never invokes lifecycle authority", async () => {
    const beginStop = vi.fn();
    const verify = vi.fn(async () => ({ supported: true }));
    const authority = { verify, beginStop, accept: vi.fn(), processIdentity: vi.fn() };
    const service = createRestartProposalService({ authority, isKeyed: () => true, budget: createReplyPartBudget() });
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
