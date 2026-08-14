import type {
  AgentMessageStream,
  AgentRequestMetadata,
  AgentResponder,
} from "@mono-agent/agent-contracts";

import type { AdvisorEffort } from "./config.js";
import type { AdvisorMetadata } from "./protocol.js";

export type AdvisorStopReason = "client_cancelled" | "client_disconnected" | "request_aborted" | "server_shutdown" | "timeout";

export interface AdvisorRunInput {
  readonly continuityId: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort: AdvisorEffort;
  readonly metadata?: AdvisorMetadata;
  readonly abortSignal: AbortSignal;
  readonly maxOutputChars: number;
}

export interface AdvisorRunResult {
  readonly text: string;
  readonly truncated?: boolean;
}

export interface AdvisorRunHandle {
  readonly result: Promise<AdvisorRunResult>;
  stop(reason: AdvisorStopReason): Promise<void>;
  drain(): Promise<void>;
}

export interface AdvisorRunFactory {
  start(input: AdvisorRunInput): Promise<AdvisorRunHandle>;
}

/**
 * Adapt the structural responder available to a channel plugin into one run per
 * tool call. This proves a distinct responder turn, not a separate or isolated
 * agent process. The advisor metadata is consumed by agent-app's per-request
 * model/effort extension.
 */
export function createAdvisorRunFactoryFromResponder(responder: AgentResponder): AdvisorRunFactory {
  if (typeof responder?.respond !== "function") {
    throw new TypeError("Advisor run factory requires responder.respond().");
  }
  return {
    async start(input) {
      let streamed = "";
      let streamedTruncated = false;
      const stream: AgentMessageStream = {
        async append(delta) {
          if (typeof delta !== "string" || streamed.length >= input.maxOutputChars) {
            streamedTruncated ||= typeof delta === "string" && delta.length > 0;
            return;
          }
          const remaining = input.maxOutputChars - streamed.length;
          streamed += delta.slice(0, remaining);
          streamedTruncated ||= delta.length > remaining;
        },
      };
      const metadata: AgentRequestMetadata = {
        advisor: {
          schema: "mono-agent.advisor.request.v1",
          continuityId: input.continuityId,
          model: input.model,
          effort: input.effort,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      };
      const responsePromise = Promise.resolve().then(async () => await responder.respond({
        conversationId: input.continuityId,
        text: input.prompt,
        abortSignal: input.abortSignal,
        metadata,
      }, stream));
      const result = responsePromise.then((response) => {
        const responseText = typeof response?.text === "string" && response.text.trim().length > 0
          ? response.text
          : streamed;
        const truncated = responseText.length > input.maxOutputChars || streamedTruncated;
        return {
          text: responseText.slice(0, input.maxOutputChars),
          ...(truncated ? { truncated: true } : {}),
        };
      });
      let stopPromise: Promise<void> | undefined;
      let drainPromise: Promise<void> | undefined;
      return {
        result,
        stop(reason) {
          stopPromise ??= Promise.resolve().then(() => {
            responder.cancel?.(input.continuityId, new Error(`Advisor run stopped: ${reason}.`));
          });
          return stopPromise;
        },
        drain() {
          drainPromise ??= result.then(() => undefined, () => undefined);
          return drainPromise;
        },
      };
    },
  };
}
