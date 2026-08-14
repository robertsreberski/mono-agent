import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentRequestBase, AgentResponder } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import { loadAdvisorConfig } from "../config.js";
import { executeReviewIteration } from "../execution.js";
import { createAdvisorMcpServer } from "../mcp-server.js";
import { continuityIdForSessionKey, REVIEW_ITERATION_TOOL_NAME } from "../protocol.js";
import { createAdvisorRunFactoryFromResponder, type AdvisorRunFactory, type AdvisorRunInput } from "../run.js";

async function config() {
  return await loadAdvisorConfig({
    env: {
      MONO_AGENT_ADVISOR_ENABLED: "true",
      MONO_AGENT_ADVISOR_MODEL: "claude:claude-opus-test",
      MONO_AGENT_ADVISOR_EFFORT: "xhigh",
    },
    json: {},
  });
}

const reviewInput = {
  session_key: "secret-session-key",
  intent: "Check the implementation contract.",
  patch: "diff --git a/file.ts b/file.ts",
  verification: "tests passed",
  metadata: { iteration: 3, files: ["file.ts"] },
} as const;

describe("advisor execution", () => {
  it("starts exactly one configured run and returns structured success", async () => {
    let captured: AdvisorRunInput | undefined;
    const drain = vi.fn(async () => {});
    const factory: AdvisorRunFactory = {
      start: vi.fn(async (input) => {
        captured = input;
        return {
          result: Promise.resolve({ text: "One concrete finding." }),
          stop: vi.fn(async () => {}),
          drain,
        };
      }),
    };
    const response = await executeReviewIteration({
      input: reviewInput,
      config: await config(),
      runFactory: factory,
      abortSignal: new AbortController().signal,
    });
    expect(factory.start).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({
      continuityId: continuityIdForSessionKey(reviewInput.session_key),
      model: "claude:claude-opus-test",
      effort: "xhigh",
      metadata: reviewInput.metadata,
    });
    expect(captured?.prompt).not.toContain(reviewInput.session_key);
    expect(captured?.prompt).toContain("untrusted review data");
    expect(response).toMatchObject({ code: "ok", status: "succeeded", review: "One concrete finding." });
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("maps start and runtime failures without leaking raw errors", async () => {
    const startFailure: AdvisorRunFactory = {
      async start() {
        throw new Error("Bearer top-secret from /Users/private/repo");
      },
    };
    const runFailure: AdvisorRunFactory = {
      async start() {
        return {
          result: Promise.reject(new Error("Bearer top-secret from /Users/private/repo")),
          async stop() {},
          async drain() {},
        };
      },
    };
    const activeConfig = await config();
    const first = await executeReviewIteration({
      input: reviewInput,
      config: activeConfig,
      runFactory: startFailure,
      abortSignal: new AbortController().signal,
    });
    const second = await executeReviewIteration({
      input: reviewInput,
      config: activeConfig,
      runFactory: runFailure,
      abortSignal: new AbortController().signal,
    });
    expect(first.code).toBe("advisor_run_start_failed");
    expect(second.code).toBe("advisor_run_failed");
    expect(JSON.stringify([first, second])).not.toMatch(/top-secret|\/Users\/private/u);
  });

  it("adapts one responder turn without claiming a separate agent", async () => {
    let request: AgentRequestBase | undefined;
    const cancel = vi.fn();
    const responder: AgentResponder = {
      async respond(input, stream) {
        request = input;
        await stream.append("1234");
        await stream.append("5678");
        return {};
      },
      cancel,
    };
    const run = await createAdvisorRunFactoryFromResponder(responder).start({
      continuityId: continuityIdForSessionKey("session"),
      prompt: "Review payload",
      model: "claude:claude-opus-test",
      effort: "high",
      metadata: { iteration: 1 },
      abortSignal: new AbortController().signal,
      maxOutputChars: 5,
    });
    await expect(run.result).resolves.toEqual({ text: "12345", truncated: true });
    expect(request).toMatchObject({
      conversationId: continuityIdForSessionKey("session"),
      metadata: {
        advisor: {
          model: "claude:claude-opus-test",
          effort: "high",
          metadata: { iteration: 1 },
        },
      },
    });
    await Promise.all([run.stop("timeout"), run.stop("server_shutdown")]);
    await Promise.all([run.drain(), run.drain()]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("registers exactly one public MCP tool and returns structured content", async () => {
    const activeConfig = await config();
    const server = createAdvisorMcpServer({
      config: activeConfig,
      runFactory: {
        async start() {
          return {
            result: Promise.resolve({ text: "Looks sound." }),
            async stop() {},
            async drain() {},
          };
        },
      },
    });
    const client = new Client({ name: "advisor-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([REVIEW_ITERATION_TOOL_NAME]);
      const result = await client.callTool({ name: REVIEW_ITERATION_TOOL_NAME, arguments: reviewInput });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "ok", review: "Looks sound." });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
