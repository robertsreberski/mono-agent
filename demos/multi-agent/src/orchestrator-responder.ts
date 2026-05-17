import {
  AgentResponseCancelledError,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@worklab-ai/agent-contracts";
import { sendA2AMessage } from "@worklab-ai/a2a-adapter";
import type { A2AConsumerResponseMetadata } from "@worklab-ai/a2a-adapter";

export type MultiAgentRole = "orchestrator" | "researcher" | "worker";

export interface CollaboratorAskInput {
  readonly userMessage: string;
  readonly conversationId: string;
  readonly abortSignal: AbortSignal;
}

export type CollaboratorResult =
  | {
      readonly agentId: "researcher" | "worker";
      readonly label: string;
      readonly status: "succeeded";
      readonly text: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly agentId: "researcher" | "worker";
      readonly label: string;
      readonly status: "failed" | "cancelled";
      readonly text: string;
      readonly metadata?: Record<string, unknown>;
    };

export interface CollaboratorClient {
  readonly id: "researcher" | "worker";
  readonly label: string;
  ask(input: CollaboratorAskInput): Promise<CollaboratorResult>;
}

export interface A2ACollaboratorClientOptions {
  readonly id: "researcher" | "worker";
  readonly label: string;
  readonly agentUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
}

export interface CollaborativeOrchestratorResponderOptions {
  readonly orchestrator: AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse>;
  readonly researcher: CollaboratorClient;
  readonly worker: CollaboratorClient;
}

export function createA2ACollaboratorClient(
  options: A2ACollaboratorClientOptions,
): CollaboratorClient {
  return {
    id: options.id,
    label: options.label,
    async ask(input): Promise<CollaboratorResult> {
      try {
        const response = await sendA2AMessage({
          agentUrl: options.agentUrl,
          ...(options.bearerToken === undefined ? {} : { bearerToken: options.bearerToken }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          text: collaboratorPrompt(options.id, input.userMessage),
          contextId: `${input.conversationId}:${options.id}`,
          signal: input.abortSignal,
          stream: true,
        });
        const text = normalizeText(response.text);
        if (text === undefined) {
          return {
            agentId: options.id,
            label: options.label,
            status: "failed",
            text: "Collaborator returned no text.",
            metadata: sanitizeMetadata(response.metadata),
          };
        }
        return {
          agentId: options.id,
          label: options.label,
          status: "succeeded",
          text,
          metadata: sanitizeMetadata(response.metadata),
        };
      } catch (error) {
        return {
          agentId: options.id,
          label: options.label,
          status: isCancelled(error, input.abortSignal) ? "cancelled" : "failed",
          text: reasonOf(error),
        };
      }
    },
  };
}

export function createCollaborativeOrchestratorResponder(
  options: CollaborativeOrchestratorResponderOptions,
): AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse> {
  return {
    async respond(request, stream): Promise<AgentResponse> {
      if (request.abortSignal.aborted) {
        throw new AgentResponseCancelledError("Multi-agent request was cancelled before collaboration.");
      }

      await stream.status?.("Asking researcher...");
      const researcher = await options.researcher.ask({
        userMessage: request.text,
        conversationId: request.conversationId,
        abortSignal: request.abortSignal,
      });

      if (request.abortSignal.aborted) {
        throw new AgentResponseCancelledError("Multi-agent request was cancelled after researcher step.");
      }

      await stream.status?.("Asking worker...");
      const worker = await options.worker.ask({
        userMessage: request.text,
        conversationId: request.conversationId,
        abortSignal: request.abortSignal,
      });

      if (request.abortSignal.aborted) {
        throw new AgentResponseCancelledError("Multi-agent request was cancelled after worker step.");
      }

      await stream.status?.("Synthesizing final answer...");
      const synthesisRequest: AgentRequestBase = {
        conversationId: request.conversationId,
        text: buildSynthesisPrompt({
          userMessage: request.text,
          researcher,
          worker,
        }),
        abortSignal: request.abortSignal,
        metadata: {
          ...(request.metadata ?? {}),
          multiAgent: {
            originalUserMessage: request.text,
            collaboratorStatuses: [
              { id: researcher.agentId, status: researcher.status },
              { id: worker.agentId, status: worker.status },
            ],
          },
        },
      };
      const response = await options.orchestrator.respond(synthesisRequest, stream);
      return {
        ...response,
        metadata: {
          ...(response.metadata ?? {}),
          multiAgent: {
            researcher,
            worker,
          },
        },
      };
    },
  };
}

export function collaboratorPrompt(role: "researcher" | "worker", userMessage: string): string {
  const base = [
    "You are contributing to a deterministic multi-agent demo.",
    "Return one concise collaborator report for the orchestrator.",
    "",
    "Original user request:",
    userMessage,
  ].join("\n");

  if (role === "researcher") {
    return [
      base,
      "",
      "Researcher instructions:",
      "- Use WebSearch or WebFetch only when current external information materially helps.",
      "- If you use web information, include source names or URLs.",
      "- Do not inspect the local filesystem.",
    ].join("\n");
  }

  return [
    base,
    "",
    "Worker instructions:",
    "- Inspect the dedicated local workspace only when it helps.",
    "- Use safe read-only Bash, Read, or Grep actions.",
    "- Do not create, edit, delete, move, overwrite files, or change git state.",
  ].join("\n");
}

export function buildSynthesisPrompt(input: {
  readonly userMessage: string;
  readonly researcher: CollaboratorResult;
  readonly worker: CollaboratorResult;
}): string {
  return [
    "You are the orchestrator in a Mono Agent multi-agent demo.",
    "Synthesize the final answer from the original user request and the two collaborator reports.",
    "Do not hide collaborator failures. If a collaborator failed or was cancelled, say what impact that has.",
    "Keep the final answer concise and useful for Telegram.",
    "",
    "Original user request:",
    input.userMessage,
    "",
    formatCollaboratorBlock(input.researcher),
    "",
    formatCollaboratorBlock(input.worker),
  ].join("\n");
}

function formatCollaboratorBlock(result: CollaboratorResult): string {
  return [
    `${result.label} (${result.agentId}) result: ${result.status}`,
    result.text,
  ].join("\n");
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function sanitizeMetadata(metadata: A2AConsumerResponseMetadata): Record<string, unknown> {
  return {
    a2a: {
      remoteAgentUrl: metadata.a2a.remoteAgentUrl,
      protocolVersion: metadata.a2a.protocolVersion,
      ...(metadata.a2a.state === undefined ? {} : { state: metadata.a2a.state }),
    },
  };
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || isAgentResponseCancelledError(error) ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
