import { AsyncLocalStorage } from "node:async_hooks";

import {
  classifyNotifySuppression,
  type AgentLiveInputOffer,
  type AgentLiveInputRequest,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@mono-agent/agent-contracts";

import type { MonoAgentAppLogger } from "./channels.js";
import { runWithProcessJobWakeContext } from "./process-jobs-context.js";

export interface MonitorWakeContext {
  readonly monitorId: string;
  readonly chainDepth: number;
}

interface MonitorWakeFlight extends MonitorWakeContext {
  readonly token: object;
  readonly deliveryKey: string;
}

export type MonitorWakeContextResolution =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly context: MonitorWakeContext }
  | { readonly kind: "missed" };

const wakeContext = new AsyncLocalStorage<MonitorWakeFlight>();
/**
 * Monitor wakes reuse the process-job delivery-key metadata symbol because the
 * adapters already carry that exact non-JSON key through their queued proactive
 * turns. The key VALUE namespaces the two: a monitor delivery key is always
 * `monitor:<id>:<seq>`, so a lookup here can never resolve a job's flight.
 */
const HOST_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");
const wakeContextByRequestMetadata = new WeakMap<object, readonly {
  readonly token: object;
  readonly flight: MonitorWakeFlight;
}[]>();
const wakeFlightsByDeliveryKey = new Map<string, readonly MonitorWakeFlight[]>();
/**
 * Wakes whose turn ran and deliberately said nothing.
 *
 * Adapters classify an empty answer as "not delivered", which is right for a
 * proactive notification but wrong for a monitor: the batch WAS consumed, the
 * model simply had nothing worth saying. Without this the host would count a
 * successful silent turn as a lost batch and report a gap that never happened.
 */
const silentWakeDeliveryKeys = new Set<string>();
const MAX_SILENT_WAKE_KEYS = 512;

/**
 * Run a genuine channel turn as a monitor wake.
 *
 * This nests INSIDE the process-job wake context on purpose. Both features raise
 * host-owned turns on the same conversation, and the steering registry admits
 * exactly one active run per conversation: a second, parallel registration would
 * make every steer ambiguous and silently downgrade process-job wakes to a
 * follow-up turn. Sharing it also means a monitor wake inherits the same
 * targeted-run steering and the same unforgeable chain-depth increment, so a
 * monitor started from a wake turn cannot escape `maxChainDepth`.
 */
export async function runWithMonitorWakeContext<T>(
  context: MonitorWakeContext,
  operation: () => Promise<T>,
  deliveryKey: string,
): Promise<T> {
  const flight = Object.freeze({ ...context, token: Object.freeze({}), deliveryKey });
  const current = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  wakeFlightsByDeliveryKey.set(deliveryKey, [...current, flight]);
  try {
    return await wakeContext.run(flight, async () => await runWithProcessJobWakeContext(
      { jobId: context.monitorId, chainDepth: context.chainDepth },
      operation,
      deliveryKey,
    ));
  } finally {
    const active = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
    const remaining = active.filter((candidate) => candidate.token !== flight.token);
    if (remaining.length === 0) wakeFlightsByDeliveryKey.delete(deliveryKey);
    else wakeFlightsByDeliveryKey.set(deliveryKey, remaining);
  }
}

/**
 * Capture an admitted monitor wake on the request identity that survives the
 * responder-to-harness queue boundary, and suppress a sentinel-only answer.
 *
 * The suppression is the point of this wrapper. A monitor raises turns nobody
 * asked for, so it must be able to conclude "nothing worth saying" without
 * posting anything — but `NOTHING_TO_REPORT` is only honoured by the native
 * cron/webhook notify path, which a channel wake turn does not go through.
 * Blanking the answer here makes the adapters' existing "agent produced no
 * answer" path do the suppressing, without teaching any adapter about monitors.
 */
export function bindMonitorWakeContextToResponder(
  responder: AgentResponder,
  options: { readonly logger?: MonoAgentAppLogger } = {},
): AgentResponder {
  const dispose = (responder as AgentResponder & { dispose?: () => Promise<void> }).dispose;
  const startNewSession = (responder as AgentResponder & {
    startNewSession?: (conversationId: string) => Promise<void>;
  }).startNewSession;
  return {
    respond: async (request: AgentRequestBase, stream: AgentMessageStream): Promise<AgentResponse> => {
      const context = wakeContext.getStore();
      let installed: { readonly token: object; readonly flight: MonitorWakeFlight } | undefined;
      if (context !== undefined) {
        if (request.metadata === undefined) {
          throw new Error("A monitor wake request is missing its host-owned request identity.");
        }
        installed = { token: Object.freeze({}), flight: context };
        const current = wakeContextByRequestMetadata.get(request.metadata) ?? [];
        wakeContextByRequestMetadata.set(request.metadata, [...current, installed]);
      }
      try {
        const response = await responder.respond(request, stream);
        return context === undefined
          ? response
          : suppressSilentMonitorReply(response, context, options.logger);
      } finally {
        if (installed !== undefined && request.metadata !== undefined) {
          const current = wakeContextByRequestMetadata.get(request.metadata) ?? [];
          const remaining = current.filter((candidate) => candidate.token !== installed.token);
          if (remaining.length === 0) wakeContextByRequestMetadata.delete(request.metadata);
          else wakeContextByRequestMetadata.set(request.metadata, remaining);
        }
      }
    },
    ...(responder.cancel === undefined ? {} : { cancel: responder.cancel.bind(responder) }),
    ...(responder.offerLiveInput === undefined
      ? {}
      : { offerLiveInput: (request: AgentLiveInputRequest): AgentLiveInputOffer => responder.offerLiveInput!(request) }),
    ...(responder.deliverVerbatim === undefined
      ? {}
      : { deliverVerbatim: responder.deliverVerbatim.bind(responder) }),
    ...(responder.openReplyArtifact === undefined
      ? {}
      : { openReplyArtifact: responder.openReplyArtifact.bind(responder) }),
    ...(responder.loadMcpApp === undefined ? {} : { loadMcpApp: responder.loadMcpApp.bind(responder) }),
    ...(responder.requestMcpApp === undefined ? {} : { requestMcpApp: responder.requestMcpApp.bind(responder) }),
    ...(startNewSession === undefined
      ? {}
      : { startNewSession: (conversationId: string) => startNewSession.call(responder, conversationId) }),
    ...(dispose === undefined ? {} : { dispose: dispose.bind(responder) }),
  } as AgentResponder;
}

/**
 * Blank a monitor wake answer that ends with the sentinel. Attachments are
 * dropped with it: a turn that decided it has nothing to say must not still post
 * files. A `narrated-sentinel` is honoured but logged, exactly as the native
 * notify path does, because it means the model wrote prose before the marker.
 */
export function suppressSilentMonitorReply(
  response: AgentResponse,
  context: MonitorWakeContext & { readonly deliveryKey?: string },
  logger?: MonoAgentAppLogger,
): AgentResponse {
  const suppression = classifyNotifySuppression(response.text);
  if (suppression === "none" || suppression === "empty") return response;
  if (suppression === "narrated-sentinel") {
    logger?.warn?.(
      "Monitor wake reply suppressed: the final answer ended with the NOTHING_TO_REPORT sentinel but was not the sentinel alone.",
      { monitorId: context.monitorId },
    );
  }
  markSilentMonitorWake(context.deliveryKey);
  const { text: _text, parts: _parts, ...rest } = response as AgentResponse & { parts?: unknown };
  return { ...rest, text: "" } as AgentResponse;
}

function markSilentMonitorWake(deliveryKey: string | undefined): void {
  if (deliveryKey === undefined) return;
  // Bounded: a key is consumed by the settling wake, and this cap keeps a
  // pathological run from retaining keys nobody will ever read.
  if (silentWakeDeliveryKeys.size >= MAX_SILENT_WAKE_KEYS) {
    const oldest = silentWakeDeliveryKeys.values().next().value;
    if (oldest !== undefined) silentWakeDeliveryKeys.delete(oldest);
  }
  silentWakeDeliveryKeys.add(deliveryKey);
}

/**
 * Whether this wake's turn ran and chose silence. Consumed once: the settling
 * wake is the only reader, and a stale key must not make a later batch look
 * delivered.
 */
export function consumeSilentMonitorWake(deliveryKey: string): boolean {
  return silentWakeDeliveryKeys.delete(deliveryKey);
}

/** Resolve only an association previously issued by this app-owned seam. */
export function monitorWakeContextForRequest(
  request: Pick<AgentRequestBase, "metadata">,
): MonitorWakeContextResolution {
  const bindings = request.metadata === undefined
    ? []
    : wakeContextByRequestMetadata.get(request.metadata) ?? [];
  if (bindings.length > 0) return resolveFlights(bindings.map((binding) => binding.flight));
  const deliveryKey = monitorWakeDeliveryKey(request.metadata);
  if (deliveryKey === undefined) return { kind: "none" };
  const flights = wakeFlightsByDeliveryKey.get(deliveryKey) ?? [];
  if (flights.length === 0) return { kind: "none" };
  return resolveFlights(flights);
}

function monitorWakeDeliveryKey(metadata: AgentRequestBase["metadata"]): string | undefined {
  if (metadata === undefined) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(metadata, HOST_WAKE_DELIVERY_METADATA);
    const value = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    return typeof value === "string" && value.startsWith("monitor:") ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveFlights(
  flights: readonly MonitorWakeFlight[],
): Exclude<MonitorWakeContextResolution, { readonly kind: "none" }> {
  const distinct = [...new Map(flights.map((flight) => [flight.token, flight])).values()];
  return distinct.length === 1
    ? { kind: "resolved", context: Object.freeze({ monitorId: distinct[0]!.monitorId, chainDepth: distinct[0]!.chainDepth }) }
    : { kind: "missed" };
}
