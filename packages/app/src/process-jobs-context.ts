import { bindProcessJobLiveInput } from "@mono-agent/conversation";
import type { WakeRecovery } from "./process-jobs-wake-fence.js";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  classifyNotifySuppression,
  type AgentLiveInputOffer,
  type AgentLiveInputRequest,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/contracts";

interface ProcessJobWakeContext {
  readonly jobId: string;
  readonly chainDepth: number;
  readonly pendingQuestion?: boolean;
  readonly wakeRecovery?: WakeRecovery;
}

interface ProcessJobWakeFlight extends ProcessJobWakeContext {
  readonly token: object;
  readonly deliveryKey: string;
  /** One-use, process-local admission proofs; never serialized or retained. */
  readonly liveInputClaims: Map<string, string>;
}

interface ProcessJobWakeRequestBinding {
  readonly token: object;
  readonly flight: ProcessJobWakeFlight;
}

type ProcessJobWakeContextResolution =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly context: ProcessJobWakeContext }
  | { readonly kind: "missed" };

const wakeContext = new AsyncLocalStorage<ProcessJobWakeFlight>();
const claimedLiveInputContext = new AsyncLocalStorage<ProcessJobWakeFlight>();
// Recall-only provenance. An authenticated web channel is not evidence that a
// host-created follow-up contains human-authored text. Keep capture unchanged.
const hostWakeRecallContext = new AsyncLocalStorage<boolean>();

export function isHostProcessJobWakeRecall(): boolean {
  return hostWakeRecallContext.getStore() === true;
}

/** Private routing metadata for the authenticated app-owned web ingress. */
export function currentProcessJobWakeRecovery(): WakeRecovery | undefined {
  return wakeContext.getStore()?.wakeRecovery;
}

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
const silentWakeDeliveryKeys = new Set<string>();

/** Consume only the exact host-issued wake receipt; never a conversation-level marker. */
export function consumeSilentProcessJobWake(deliveryKey: string): boolean {
  return silentWakeDeliveryKeys.delete(deliveryKey);
}

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
    liveInputClaims: new Map<string, string>(),
  });
  const current = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  if (current.length === 0) silentWakeDeliveryKeys.delete(deliveryKey);
  wakeFlightsByDeliveryKey.set(deliveryKey, [...current, flight]);
  try {
    return await wakeContext.run(flight, operation);
  } finally {
    flight.liveInputClaims.clear();
    const active = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
    const remaining = active.filter((candidate) => candidate.token !== flight.token);
    if (remaining.length === 0) wakeFlightsByDeliveryKey.delete(deliveryKey);
    else wakeFlightsByDeliveryKey.set(deliveryKey, remaining);
  }
}

/** Only the service calls this, after its durable admission fence has crossed. */
export function recordProcessJobWakeAdmission(deliveryKey: string, token: string, boundary: string): void {
  const flight = admissionFlight(deliveryKey, token);
  flight?.liveInputClaims.set(boundary, token);
}

/** Releasing (or attempting to release) a claim cannot leave kind authority behind. */
export function revokeProcessJobWakeAdmission(deliveryKey: string, token: string, boundary: string): void {
  const flight = admissionFlight(deliveryKey, token);
  if (flight?.liveInputClaims.get(boundary) === token) flight.liveInputClaims.delete(boundary);
}

/** Scope proof to this synchronous offer, not every request knowing a live key. */
export function offerClaimedProcessJobLiveInput(
  deliveryKey: string, token: string, boundary: string, offer: () => AgentLiveInputOffer,
): AgentLiveInputOffer {
  const flight = admissionFlight(deliveryKey, token);
  if (flight === undefined || flight.liveInputClaims.get(boundary) !== token) return offer();
  flight.liveInputClaims.delete(boundary);
  return claimedLiveInputContext.run(flight, offer);
}

function admissionFlight(deliveryKey: string, token: string): ProcessJobWakeFlight | undefined {
  // Tokenless legacy admission cannot distinguish a client-supplied key from
  // a host completion. It retains delivery semantics, but grants no kind proof.
  if (!token) return undefined;
  const flights = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  const flight = flights.length === 1 ? flights[0] : undefined;
  return flight?.wakeRecovery?.token === token ? flight : undefined;
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
      const deliveryKey = processJobWakeDeliveryKey(request.metadata);
      const flights = deliveryKey === undefined ? [] : wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
      const context = deliveryKey === undefined ? wakeContext.getStore()
        : flights.length === 1 ? flights[0] : undefined;
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
        // The web operator already sends a delivery key, but its JSON field is
        // client-supplied. Only an exact active private flight can suppress
        // automatic recall. A client knowing that live key could suppress its
        // own concurrent turn's automatic block; explicit recall and capture
        // remain unchanged. Keep captureSpeakerKind and delivery unchanged.
        const response = await (context === undefined
          ? responder.respond(request, stream)
          : hostWakeRecallContext.run(true, () => responder.respond(request, stream)));
        const active = context === undefined ? [] : wakeFlightsByDeliveryKey.get(context.deliveryKey) ?? [];
        // A stale/missing/ambiguous key, narration, or any rich part stays visible.
        if (context !== undefined
          && active.length === 1 && active[0]?.token === context.token
          && (response.metadata?.turnDisposition === "silent"
            || (response.metadata?.turnDisposition === undefined
              && classifyNotifySuppression(response.text) === "sentinel"))
          && (response.parts?.length ?? 0) === 0) {
          if (silentWakeDeliveryKeys.size >= 10_096) {
            const oldest = silentWakeDeliveryKeys.values().next().value;
            if (oldest !== undefined) silentWakeDeliveryKeys.delete(oldest);
          }
          silentWakeDeliveryKeys.add(context.deliveryKey);
          return { ...response, text: "" };
        }
        return response;
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
    ...(responder.compactConversation === undefined
      ? {}
      : { compactConversation: responder.compactConversation.bind(responder) }),
    ...(responder.cancel === undefined ? {} : { cancel: responder.cancel.bind(responder) }),
    ...(responder.liveInputOwnership === undefined ? {} : { liveInputOwnership: responder.liveInputOwnership }),
    ...(responder.offerLiveInput === undefined
      ? {}
      : {
          offerLiveInput: (request: AgentLiveInputRequest): AgentLiveInputOffer =>
            offerProcessJobWakeToActiveRun(responder, request),
        }),
    ...(responder.deliverVerbatim === undefined
      ? {}
      : { deliverVerbatim: responder.deliverVerbatim.bind(responder) }),
    ...(responder.importContext === undefined
      ? {}
      : { importContext: responder.importContext.bind(responder) }),
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
  // The service already advances the lineage when it creates this wake. Live
  // steering and a separate wake turn must carry the same depth.
  target.wakeDepths.set(wakeToken, flight.chainDepth);
  const rollback = (): void => {
    target.wakeDepths.delete(wakeToken);
  };

  let offer: AgentLiveInputOffer;
  try {
    const targeted = { ...request, targetRunId: target.runId };
    // Transport text may include project/tag context. Kind comes only from
    // the private in-process wake or this exact one-use admitted offer.
    const verifiedCompletion = request.id === flight.deliveryKey && request.deliveryKey === flight.deliveryKey
      && (wakeFlightsByDeliveryKey.get(flight.deliveryKey) ?? []).includes(flight)
      && (wakeContext.getStore() === flight || claimedLiveInputContext.getStore() === flight);
    offer = offerLiveInput.call(responder, verifiedCompletion ? bindProcessJobLiveInput(targeted) : targeted);
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
      if (settlement.status === "applied" && settlement.runId === target.runId) return settlement;
      rollback();
      if (settlement.status === "requeue" || settlement.status === "discarded" || settlement.status === "uncertain") {
        return settlement;
      }
      return { status: "uncertain" as const, reason: "delivery_uncertain" as const };
    }, () => {
      rollback();
      return { status: "uncertain" as const, reason: "delivery_uncertain" as const };
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
  return Object.freeze({ jobId: context.jobId, chainDepth: context.chainDepth,
    ...(context.pendingQuestion === true ? { pendingQuestion: true } : {}) });
}
