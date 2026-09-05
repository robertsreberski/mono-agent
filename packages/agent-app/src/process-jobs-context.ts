import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AgentLiveInputOffer,
  AgentLiveInputRequest,
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";

export interface ProcessJobWakeContext {
  readonly jobId: string;
  readonly chainDepth: number;
}

interface ProcessJobWakeFlight extends ProcessJobWakeContext {
  readonly token: object;
  readonly deliveryKey: string;
}

interface ProcessJobWakeRequestBinding {
  readonly token: object;
  readonly flight: ProcessJobWakeFlight;
}

export type ProcessJobWakeContextResolution =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly context: ProcessJobWakeContext }
  | { readonly kind: "missed" };

const wakeContext = new AsyncLocalStorage<ProcessJobWakeFlight>();
const PROCESS_JOB_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");
// The metadata object is only an identity key. No string field is added to it,
// and a wire/user-created object cannot forge membership in this owner-private
// map or serialize the symbol-keyed adapter fallback below.
// The responder-to-harness conversion deliberately preserves this object
// identity even when same-conversation live-session work is queued and cloned.
const wakeContextByRequestMetadata = new WeakMap<object, readonly ProcessJobWakeRequestBinding[]>();
// Registered before the channel router is entered and cleared only after that
// route settles. Slack and Telegram carry this exact durable delivery identity
// on a non-JSON symbol so a queued adapter callback can recover its own flight
// without attributing context to unrelated work in the same conversation.
const wakeFlightsByDeliveryKey = new Map<string, readonly ProcessJobWakeFlight[]>();

interface ActiveProcessJobSteeringTarget {
  readonly token: object;
  readonly conversationId: string;
  readonly runId: string;
  readonly baseChainDepth: number;
  readonly wakeDepths: Map<object, number>;
}

export interface ProcessJobSteeringTargetLease {
  chainDepth(): number;
  release(): void;
}

const steeringTargetsByConversation = new Map<string, readonly ActiveProcessJobSteeringTarget[]>();

/** Register the exact active run whose controller can be raised by a host wake. */
export function registerProcessJobSteeringTarget(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly chainDepth: number;
}): ProcessJobSteeringTargetLease {
  const conversationId = baseConversationId(input.conversationId);
  const target: ActiveProcessJobSteeringTarget = {
    token: Object.freeze({}),
    conversationId,
    runId: input.runId,
    baseChainDepth: input.chainDepth,
    wakeDepths: new Map(),
  };
  const current = steeringTargetsByConversation.get(conversationId) ?? [];
  steeringTargetsByConversation.set(conversationId, [...current, target]);
  let released = false;
  return {
    chainDepth: () => effectiveSteeringDepth(target),
    release: () => {
      if (released) return;
      released = true;
      target.wakeDepths.clear();
      const active = steeringTargetsByConversation.get(conversationId) ?? [];
      const remaining = active.filter((candidate) => candidate.token !== target.token);
      if (remaining.length === 0) steeringTargetsByConversation.delete(conversationId);
      else steeringTargetsByConversation.set(conversationId, remaining);
    },
  };
}

/** Run a genuine channel turn with host-owned fan-out depth attached out of band. */
export async function runWithProcessJobWakeContext<T>(
  context: ProcessJobWakeContext,
  operation: () => Promise<T>,
  deliveryKey: string,
): Promise<T> {
  const flight = Object.freeze({
    ...context,
    token: Object.freeze({}),
    deliveryKey,
  });
  const current = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  wakeFlightsByDeliveryKey.set(deliveryKey, [...current, flight]);
  try {
    return await wakeContext.run(flight, operation);
  } finally {
    const active = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
    const remaining = active.filter((candidate) => candidate.token !== flight.token);
    if (remaining.length === 0) wakeFlightsByDeliveryKey.delete(deliveryKey);
    else wakeFlightsByDeliveryKey.set(deliveryKey, remaining);
  }
}

/**
 * Capture an admitted host wake on the exact request identity that survives
 * the responder-to-harness queue boundary. The association remains outside
 * public/string metadata, prompts, history, traces, and serialized payloads.
 */
export function bindProcessJobWakeContextToResponder(responder: AgentResponder): AgentResponder {
  const dispose = (responder as AgentResponder & { dispose?: () => Promise<void> }).dispose;
  const startNewSession = (responder as AgentResponder & {
    startNewSession?: (conversationId: string) => Promise<void>;
  }).startNewSession;
  return {
    respond: async (request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> => {
      const context = wakeContext.getStore();
      let installed: ProcessJobWakeRequestBinding | undefined;
      if (context !== undefined) {
        if (request.metadata === undefined) {
          throw new Error("A process-job wake request is missing its host-owned request identity.");
        }
        installed = { token: Object.freeze({}), flight: context };
        const current = wakeContextByRequestMetadata.get(request.metadata) ?? [];
        wakeContextByRequestMetadata.set(request.metadata, [...current, installed]);
      }
      try {
        return await responder.respond(request, stream);
      } finally {
        if (installed !== undefined && request.metadata !== undefined) {
          const current = wakeContextByRequestMetadata.get(request.metadata) ?? [];
          const remaining = current.filter((candidate) => candidate.token !== installed.token);
          // Only the invocation that installed this exact token may remove it.
          // Re-entrant calls using the same metadata identity retain their own
          // binding until their corresponding responder invocation settles.
          if (remaining.length === 0) wakeContextByRequestMetadata.delete(request.metadata);
          else wakeContextByRequestMetadata.set(request.metadata, remaining);
        }
      }
    },
    ...(responder.cancel === undefined ? {} : { cancel: responder.cancel.bind(responder) }),
    ...(responder.offerLiveInput === undefined
      ? {}
      : {
          offerLiveInput: (request: AgentLiveInputRequest): AgentLiveInputOffer =>
            offerProcessJobWakeToActiveRun(responder, request),
        }),
    ...(responder.deliverVerbatim === undefined
      ? {}
      : { deliverVerbatim: responder.deliverVerbatim.bind(responder) }),
    ...(responder.openReplyArtifact === undefined
      ? {}
      : { openReplyArtifact: responder.openReplyArtifact.bind(responder) }),
    ...(responder.loadMcpApp === undefined
      ? {}
      : { loadMcpApp: responder.loadMcpApp.bind(responder) }),
    ...(responder.requestMcpApp === undefined
      ? {}
      : { requestMcpApp: responder.requestMcpApp.bind(responder) }),
    ...(startNewSession === undefined
      ? {}
      : { startNewSession: startNewSession.bind(responder) }),
    ...(dispose === undefined ? {} : { dispose: dispose.bind(responder) }),
  } as AgentResponder;
}

function offerProcessJobWakeToActiveRun(
  responder: AgentResponder,
  request: AgentLiveInputRequest,
): AgentLiveInputOffer {
  const offerLiveInput = responder.offerLiveInput;
  if (offerLiveInput === undefined) return { status: "unavailable", reason: "unsupported" };
  const flight = processJobWakeFlightForOffer(request.deliveryKey);
  if (flight === undefined) return offerLiveInput.call(responder, request);

  const candidates = steeringTargetsByConversation.get(baseConversationId(request.conversationId)) ?? [];
  if (candidates.length !== 1) return { status: "unavailable", reason: "inactive" };
  const target = candidates[0]!;
  const wakeToken = Object.freeze({});
  target.wakeDepths.set(wakeToken, flight.chainDepth + 1);
  const rollback = (): void => {
    target.wakeDepths.delete(wakeToken);
  };

  let offer: AgentLiveInputOffer;
  try {
    offer = offerLiveInput.call(responder, {
      ...request,
      targetRunId: target.runId,
    });
  } catch (error) {
    rollback();
    throw error;
  }
  if (offer.status === "unavailable") {
    rollback();
    return offer;
  }
  return {
    status: "accepted",
    settled: offer.settled.then((settlement) => {
      if (settlement.status !== "applied" || settlement.runId !== target.runId) {
        rollback();
        return settlement.status === "applied"
          ? { status: "requeue" as const, reason: "failed" as const }
          : settlement;
      }
      return settlement;
    }, (error: unknown) => {
      rollback();
      throw error;
    }),
  };
}

function processJobWakeFlightForOffer(deliveryKey: string | undefined): ProcessJobWakeFlight | undefined {
  const current = wakeContext.getStore();
  if (current !== undefined) return current;
  if (deliveryKey === undefined) return undefined;
  const flights = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  return flights.length === 1 ? flights[0] : undefined;
}

/**
 * The live host-wake depth for a conversation's single active run, when it has
 * exactly one. Exported so a second host-owned wake feature can read the depth
 * this registry already tracks instead of registering a competing target: the
 * registry admits a steer only when exactly one candidate matches, so a
 * duplicate registration would silently disable steering for both.
 */
export function processJobSteeringDepth(conversationId: string): number | undefined {
  const candidates = steeringTargetsByConversation.get(baseConversationId(conversationId)) ?? [];
  return candidates.length === 1 ? effectiveSteeringDepth(candidates[0]!) : undefined;
}

function effectiveSteeringDepth(target: ActiveProcessJobSteeringTarget): number {
  let depth = target.baseChainDepth;
  for (const wakeDepth of target.wakeDepths.values()) depth = Math.max(depth, wakeDepth);
  return depth;
}

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

/** Resolve only an association previously issued by the app-owned responder seam. */
export function processJobWakeContextForRequest(
  request: Pick<AgentRequestBase, "metadata">,
): ProcessJobWakeContextResolution {
  const bindings = request.metadata === undefined
    ? []
    : wakeContextByRequestMetadata.get(request.metadata) ?? [];
  if (bindings.length > 0) {
    return resolveFlights(bindings.map((binding) => binding.flight));
  }
  const deliveryKey = processJobWakeDeliveryKey(request.metadata);
  if (deliveryKey === undefined) return { kind: "none" };
  const flights = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  // A host-marked wake cannot regain ordinary depth-zero capabilities after expiry.
  if (flights.length === 0) return { kind: "missed" };
  return resolveFlights(flights);
}

function processJobWakeDeliveryKey(metadata: AgentRequestBase["metadata"]): string | undefined {
  if (metadata === undefined) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(metadata, PROCESS_JOB_WAKE_DELIVERY_METADATA);
    return descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveFlights(
  flights: readonly ProcessJobWakeFlight[],
): Exclude<ProcessJobWakeContextResolution, { readonly kind: "none" }> {
  const distinct = [...new Map(flights.map((flight) => [flight.token, flight])).values()];
  if (distinct.length === 1) return { kind: "resolved", context: publicWakeContext(distinct[0]!) };
  return { kind: "missed" };
}

function publicWakeContext(context: ProcessJobWakeFlight): ProcessJobWakeContext {
  return Object.freeze({ jobId: context.jobId, chainDepth: context.chainDepth });
}
