import { describe, expect, it } from "vitest";

import type { AgentMessageStream } from "@mono-agent/agent-contracts";

import { createAgentResponder } from "../responder.js";
import type { AgentHarness, AgentHarnessRequest, AgentHarnessResponse } from "../types.js";

function okResponse(conversationId: string): AgentHarnessResponse {
  return {
    text: "ok",
    metadata: { runId: "r", conversationId, contextSources: [], contextSectionIds: [] },
  };
}

function noopStream(): AgentMessageStream {
  return { append: async () => {} };
}

function baseRequest(conversationId = "c1") {
  return { conversationId, text: "hi", abortSignal: new AbortController().signal };
}

describe("createAgentResponder", () => {
  it("routes respond() through harness.submit when available (queue-after-turn)", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        calls.push("run");
        return okResponse(request.conversationId);
      },
      submit: async (request: AgentHarnessRequest) => {
        calls.push("submit");
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), noopStream());

    expect(calls).toEqual(["submit"]);
  });

  it("falls back to harness.run when submit is absent", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        calls.push("run");
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), noopStream());

    expect(calls).toEqual(["run"]);
  });

  it("cancel(conversationId) delegates to the harness", async () => {
    const cancelled: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      cancel: (conversationId: string) => {
        cancelled.push(conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    responder.cancel?.("conv-7");

    expect(cancelled).toEqual(["conv-7"]);
  });
});
