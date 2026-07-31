import { NOTHING_TO_REPORT_SENTINEL, type AgentSurface } from "@mono-agent/agent-contracts";

import type { AgentHarnessRequest } from "../types.js";
import { sanitizeLabelPart } from "./speaker-context.js";

/**
 * Host-owned delivery guidance for the current turn.
 *
 * The line this block draws is between IDENTITY and ROUTE. Which surface the
 * turn is on -- DM vs. named channel, and which one -- is model-visible, because
 * an agent that cannot tell a shared channel from a private DM cannot apply the
 * behaviour it is configured for. The exact route stays host-owned: the thread to
 * deliver into, the `replyTo` conversation id, callback URLs, and delivery
 * tokens. An opted-in MCP server gets an opaque destination-bound claim
 * capability instead, and a model may promise a later reply only after such a
 * tool confirms that the continuation was registered.
 */
export function sessionContextBlock(
  request: Pick<AgentHarnessRequest, "metadata" | "replyTo" | "surface">,
  hostManagedMemory = false,
): string {
  const deliverable = request.replyTo !== undefined && !hasRequestDrivenTrigger(request.metadata);
  const memoryGuidance = hostManagedMemory ? HOST_MANAGED_MEMORY_GUIDANCE : undefined;
  if (deliverable) {
    const surface = surfaceGuidance(request.surface);
    return [
      "You are handling an interactive push conversation. The host owns its exact channel and thread destination.",
      surface,
      `${surface === undefined ? NO_ROUTE_PROHIBITION : SURFACE_ROUTE_PROHIBITION} You may promise a later reply only after a continuation-capable tool explicitly confirms that a destination-bound continuation was registered; otherwise finish synchronously or explain that background delivery was not scheduled.`,
      memoryGuidance,
    ].filter((part) => part !== undefined).join("\n\n");
  }
  const base = "This is a request-driven run (scheduled, webhook, or API) with no interactive user attached to a deliverable push conversation. Do not invent or infer a callback destination.";
  const notifyGuidance = notifyDeliveryGuidance(request.metadata);
  return [base, notifyGuidance, memoryGuidance]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

function hasRequestDrivenTrigger(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.cron !== undefined || metadata?.webhook !== undefined;
}

/**
 * Said when the channel disclosed no surface. Byte-identical to the guidance
 * that shipped before surfaces existed, so a TUI, web, or custom-channel turn is
 * unchanged.
 */
const NO_ROUTE_PROHIBITION =
  "Never copy, request, infer, or pass a conversation id, channel id, callback URL, or delivery token.";

/**
 * Said when the surface line above named an id. The blanket "never pass a channel
 * id" would contradict what the block just disclosed, so the prohibition narrows
 * to the route — the part that is still host-owned — and forbids using the
 * disclosed identifiers to redirect delivery.
 */
const SURFACE_ROUTE_PROHIBITION = [
  "The identifiers above tell you where you are; they are not a delivery target.",
  "Never copy, request, infer, or pass a thread identifier, callback URL, or delivery token, and never use the surface identifiers to redirect this turn's reply — the host routes it.",
].join(" ");

/**
 * One or two lines naming the surface, plus what the channel does with a long
 * answer. Returns undefined for a channel that discloses no surface, which keeps
 * the rest of the block byte-identical to its pre-surface form.
 *
 * The name is user-controlled — anyone who can rename a channel controls it — so
 * it goes through the same sanitizer as a speaker's display name rather than
 * being interpolated raw. The id is transport-issued and needs no sanitizing,
 * but is length-bounded so a hostile custom channel cannot pad the prompt.
 */
function surfaceGuidance(surface: AgentSurface | undefined): string | undefined {
  if (surface === undefined) {
    return undefined;
  }
  const name = sanitizeLabelPart(surface.name);
  const id = sanitizeLabelPart(surface.id)?.slice(0, SURFACE_ID_MAX_CHARS);
  const described = [
    SURFACE_KIND_LABEL[surface.kind],
    name === undefined ? undefined : `"${name}"`,
    id === undefined ? undefined : `(${id})`,
  ].filter((part) => part !== undefined).join(" ");
  return [
    `Surface: you are talking in ${described}. ${SURFACE_KIND_AUDIENCE[surface.kind]}`,
    messageBudgetGuidance(surface.messageBudget),
  ].filter((part) => part !== undefined).join(" ");
}

/** Bound on a transport-issued id, so a hostile custom channel cannot pad the prompt. */
const SURFACE_ID_MAX_CHARS = 64;

const SURFACE_KIND_LABEL: Record<AgentSurface["kind"], string> = {
  dm: "a direct message",
  channel: "the channel",
  group: "the group chat",
};

const SURFACE_KIND_AUDIENCE: Record<AgentSurface["kind"], string> = {
  dm: "One other person reads this.",
  channel: "It is shared: several people can read what you write here.",
  group: "It is shared: several people can read what you write here.",
};

function messageBudgetGuidance(
  budget: AgentSurface["messageBudget"],
): string | undefined {
  if (budget === undefined || !Number.isFinite(budget.maxChars) || budget.maxChars < 1) {
    return undefined;
  }
  const overflow = budget.overflow === "thread"
    ? "anything longer is continued in the thread under your first message"
    : "anything longer is continued in follow-up messages";
  return `Messages here are delivered in parts of at most ${String(Math.floor(budget.maxChars))} characters; ${overflow}, so write to that budget rather than guessing one.`;
}

const HOST_MANAGED_MEMORY_GUIDANCE = [
  "Long-term memory state is owned by the host; its configured memory pipeline decides whether and how qualifying successful turns are persisted.",
  "To remember something, acknowledge it in your reply and let the host handle capture; never edit memory Markdown, SQLite databases, indexes, manifests, or other internal memory state with file or shell tools.",
  "Use the available recall/search tools to read memory.",
].join(" ");

/**
 * Guidance for a notify-enabled cron/webhook turn (its trigger metadata carries
 * `nativeNotify.enabled`): the agent's final reply is delivered to the user
 * VERBATIM by the host, so it should read as the finished message and there is no
 * tool to call. Returns undefined for any non-notify turn.
 */
function notifyDeliveryGuidance(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined || !(nativeNotifyEnabled(metadata.cron) || nativeNotifyEnabled(metadata.webhook))) {
    return undefined;
  }
  return [
    "This run was triggered on a schedule or by a webhook, and your final reply is delivered to the user on their channel exactly as you write it.",
    "Write your final message as the finished notification: no preface, no meta-commentary, no narration of your steps, and do NOT call any tool to send it — delivery is automatic and posts your reply verbatim.",
    `If there is nothing worth telling the user, reply with exactly \`${NOTHING_TO_REPORT_SENTINEL}\` and nothing else; no notification is sent.`,
  ].join("\n\n");
}

function nativeNotifyEnabled(trigger: unknown): boolean {
  if (typeof trigger !== "object" || trigger === null) {
    return false;
  }
  const nativeNotify = (trigger as { nativeNotify?: unknown }).nativeNotify;
  return (
    typeof nativeNotify === "object" &&
    nativeNotify !== null &&
    (nativeNotify as { enabled?: unknown }).enabled === true
  );
}
