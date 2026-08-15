import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";

export interface ProcessJobWakeContext {
  readonly jobId: string;
  readonly chainDepth: number;
}

const wakeContext = new AsyncLocalStorage<ProcessJobWakeContext>();
// The metadata object is only an identity key. No field is added to it, and a
// wire/user-created object cannot forge membership in this owner-private map.
// The responder-to-harness conversion deliberately preserves this object
// identity even when same-conversation live-session work is queued and cloned.
const wakeContextByRequestMetadata = new WeakMap<object, ProcessJobWakeContext>();

/** Run a genuine channel turn with host-owned fan-out depth attached out of band. */
export async function runWithProcessJobWakeContext<T>(
  context: ProcessJobWakeContext,
  operation: () => Promise<T>,
): Promise<T> {
  return await wakeContext.run(context, operation);
}

/**
 * Capture an admitted host wake on the exact request identity that survives
 * the responder-to-harness queue boundary. The association remains outside
 * public metadata, prompts, history, traces, and serialized request payloads.
 */
export function bindProcessJobWakeContextToResponder(responder: AgentResponder): AgentResponder {
  const dispose = (responder as AgentResponder & { dispose?: () => Promise<void> }).dispose;
  const startNewSession = (responder as AgentResponder & {
    startNewSession?: (conversationId: string) => Promise<void>;
  }).startNewSession;
  return {
    respond: async (request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> => {
      const context = wakeContext.getStore();
      if (context !== undefined) {
        if (request.metadata === undefined) {
          throw new Error("A process-job wake request is missing its host-owned request identity.");
        }
        wakeContextByRequestMetadata.set(request.metadata, Object.freeze({ ...context }));
      }
      return await responder.respond(request, stream);
    },
    ...(responder.cancel === undefined ? {} : { cancel: responder.cancel.bind(responder) }),
    ...(responder.offerLiveInput === undefined
      ? {}
      : { offerLiveInput: responder.offerLiveInput.bind(responder) }),
    ...(responder.deliverVerbatim === undefined
      ? {}
      : { deliverVerbatim: responder.deliverVerbatim.bind(responder) }),
    ...(startNewSession === undefined
      ? {}
      : { startNewSession: startNewSession.bind(responder) }),
    ...(dispose === undefined ? {} : { dispose: dispose.bind(responder) }),
  } as AgentResponder;
}

/** Resolve only an association previously issued by the app-owned responder seam. */
export function processJobWakeContextForRequest(
  request: Pick<AgentRequestBase, "metadata">,
): ProcessJobWakeContext | undefined {
  if (request.metadata === undefined) return undefined;
  const context = wakeContextByRequestMetadata.get(request.metadata);
  wakeContextByRequestMetadata.delete(request.metadata);
  return context;
}
