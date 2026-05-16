import {
  AgentResponseCancelledError,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentResponseCancelledErrorOptions,
} from "@worklab-ai/agent-contracts";

export type AgentRequestLike = AgentRequestBase;
export type AgentResponseLike = AgentResponse;
export type AgentMessageStreamLike = AgentMessageStream;
export type AgentResponderLike = AgentResponder;
export type TuiAgentCancelledErrorOptions = AgentResponseCancelledErrorOptions;

export class TuiAgentCancelledError extends AgentResponseCancelledError {
  constructor(
    message = "Agent response was cancelled.",
    options: TuiAgentCancelledErrorOptions = {},
  ) {
    super(message, options);
    this.name = "TuiAgentCancelledError";
  }
}

export function isTuiAgentCancelledError(error: unknown): boolean {
  return error instanceof TuiAgentCancelledError || isAgentResponseCancelledError(error);
}
