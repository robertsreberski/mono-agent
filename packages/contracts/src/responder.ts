


import type { AgentContextImportRequest,AgentContextImportResult,AgentLiveInputOffer,AgentLiveInputRequest,AgentManualCompactionOptions,AgentManualCompactionResult,AgentRequestBase } from "./request.js";

import type { AgentMcpAppHostRequest,AgentMcpAppLoadRequest,AgentMcpAppResource,AgentReplyArtifactOpenRequest,AgentReplyArtifactStream,AgentResponse } from "./response.js";

import type { AgentMessageStream } from "./stream.js";

export interface AgentResponder<
  Request extends AgentRequestBase = AgentRequestBase,
  Stream extends AgentMessageStream = AgentMessageStream,
  Response extends AgentResponse = AgentResponse,
> {
  readonly liveInputOwnership?: { readonly version: 1 };
  respond(request: Request, stream: Stream): Promise<Response>;
  /**
   * Compact the exact idle conversation without submitting a user turn.
   * `model` is the same per-conversation model selection a turn would carry;
   * omitted means the host default.
   */
  compactConversation?(conversationId: string, options?: AgentManualCompactionOptions, signal?: AbortSignal): Promise<AgentManualCompactionResult>;
  /**
   * Optional: offer a text follow-up to the active turn without starting a
   * parallel response. Callers reserve their ordinary queue position first so
   * an unsupported or end-of-turn race can deterministically requeue it.
   */
  offerLiveInput?(request: AgentLiveInputRequest): AgentLiveInputOffer;
  /**
   * Optional: abort the in-flight turn for a conversation and clear any queued
   * follow-ups. Channels call this on an explicit user cancel (e.g. /cancel).
   */
  cancel?(conversationId: string, reason?: unknown): void;
  /**
   * Optional: record a message that a channel posted VERBATIM to `conversationId`
   * without running a turn (native cron/webhook notification delivery). The text
   * is appended to the conversation's durable history — and any warm provider
   * session for it is retired — so a later user reply resumes with the delivered
   * message in context. No model call happens here; the text was already posted.
   */
  deliverVerbatim?(
    conversationId: string,
    text: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /**
   * Optional v1 canonical context import. This is a positive capability:
   * implementations expose it only when they can atomically retain the whole
   * provenance/assistant batch and retire, or prove the absence of, durable
   * provider state. It never runs the model.
   */
  importContext?(
    conversationId: string,
    request: AgentContextImportRequest,
  ): Promise<AgentContextImportResult>;
  /**
   * Optional app-owned generated-file resolver. Implementations authenticate by
   * exact conversation ownership and return a bounded stream, never a path.
   */
  openReplyArtifact?(request: AgentReplyArtifactOpenRequest): Promise<AgentReplyArtifactStream>;
  /** Load private MCP App resource/input/result state for one authorized host instance. */
  loadMcpApp?(request: AgentMcpAppLoadRequest): Promise<AgentMcpAppResource>;
  /** Execute one bounded host/app bridge request against the originating MCP connection. */
  requestMcpApp?(request: AgentMcpAppHostRequest): Promise<unknown>;
}
