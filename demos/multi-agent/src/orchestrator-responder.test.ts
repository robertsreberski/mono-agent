import { describe, expect, it } from "vitest";

import type { AgentMessageStream, AgentResponder } from "@worklab-ai/agent-contracts";
import { startA2AProvider } from "@worklab-ai/a2a-adapter";

import {
  buildSynthesisPrompt,
  createA2ACollaboratorClient,
  createCollaborativeOrchestratorResponder,
  type CollaboratorClient,
  type CollaboratorResult,
} from "./orchestrator-responder.js";

describe("collaborative orchestrator responder", () => {
  it("asks both collaborators and synthesizes from their outputs", async () => {
    const calls: string[] = [];
    const finalPrompts: string[] = [];
    const statuses: string[] = [];
    const researcher = fakeCollaborator({
      agentId: "researcher",
      label: "Researcher",
      status: "succeeded",
      text: "Research says the current answer needs a source.",
    }, calls);
    const worker = fakeCollaborator({
      agentId: "worker",
      label: "Worker",
      status: "succeeded",
      text: "Worker inspected the local workspace with read-only commands.",
    }, calls);
    const orchestrator: AgentResponder = {
      async respond(request) {
        finalPrompts.push(request.text);
        return { text: "final synthesis" };
      },
    };

    const responder = createCollaborativeOrchestratorResponder({ orchestrator, researcher, worker });
    const result = await responder.respond(
      {
        conversationId: "conversation-1",
        text: "What should we do?",
        abortSignal: new AbortController().signal,
      },
      fakeStream(statuses),
    );

    expect(result.text).toBe("final synthesis");
    expect(calls).toEqual(["researcher:What should we do?", "worker:What should we do?"]);
    expect(statuses).toEqual([
      "Asking researcher...",
      "Asking worker...",
      "Synthesizing final answer...",
    ]);
    expect(finalPrompts[0]).toContain("Original user request:\nWhat should we do?");
    expect(finalPrompts[0]).toContain("Research says the current answer needs a source.");
    expect(finalPrompts[0]).toContain("Worker inspected the local workspace with read-only commands.");
  });

  it("keeps collaborator failures visible in the synthesis prompt", () => {
    const prompt = buildSynthesisPrompt({
      userMessage: "Compare approaches.",
      researcher: {
        agentId: "researcher",
        label: "Researcher",
        status: "failed",
        text: "Web search failed.",
      },
      worker: {
        agentId: "worker",
        label: "Worker",
        status: "succeeded",
        text: "Local files were not relevant.",
      },
    });

    expect(prompt).toContain("Researcher (researcher) result: failed");
    expect(prompt).toContain("Web search failed.");
    expect(prompt).toContain("Do not hide collaborator failures.");
  });

  it("reports collaborator timeouts with actionable error metadata", async () => {
    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: 0,
      responder: {
        async respond() {
          await delay(100);
          return { text: "late collaborator report" };
        },
      },
      agent: {
        name: "Slow Collaborator",
        description: "Responds too slowly",
        version: "0.1.0",
      },
      skill: {
        id: "slow-collaborator",
        name: "Slow Collaborator",
        description: "Slow collaborator",
        tags: ["slow"],
      },
    });

    try {
      const collaborator = createA2ACollaboratorClient({
        id: "researcher",
        label: "Researcher",
        agentUrl: provider.agentCardUrl,
        timeoutMs: 10,
      });

      const result = await collaborator.ask({
        userMessage: "Research M5 Max memory options.",
        conversationId: "timeout-test",
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        agentId: "researcher",
        label: "Researcher",
        status: "failed",
        text: "A2A collaborator timed out after 10ms.",
        metadata: {
          error: {
            code: "timeout",
            timeoutMs: 10,
          },
        },
      });
      expect(JSON.stringify(result.metadata)).not.toContain("Bearer");
    } finally {
      await provider.stop();
    }
  });
});

function fakeCollaborator(result: CollaboratorResult, calls: string[]): CollaboratorClient {
  return {
    id: result.agentId,
    label: result.label,
    async ask(input) {
      calls.push(`${result.agentId}:${input.userMessage}`);
      return result;
    },
  };
}

function fakeStream(statuses: string[]): AgentMessageStream {
  return {
    async status(text) {
      statuses.push(text);
    },
    async append() {
      return undefined;
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
