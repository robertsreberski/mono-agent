import { describe, expect, it } from "vitest";

import type { AgentMessageStream, AgentResponder } from "@worklab-ai/agent-contracts";

import {
  buildSynthesisPrompt,
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
