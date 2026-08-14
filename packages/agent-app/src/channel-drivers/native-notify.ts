import { classifyNotifySuppression } from "@mono-agent/agent-contracts";
import type { NotifyDeliveryContext } from "@mono-agent/agent-contracts";
import type { CronJobConfig, CronJobResult } from "@mono-agent/cron-adapter";
import type {
  WebhookEndpointConfig,
  WebhookInvocationRequest,
  WebhookInvocationStatus,
} from "@mono-agent/webhook-adapter";

import type { MonoAgentAppLogger } from "../channels.js";
import type { NotifyDestination } from "../notify-destinations.js";
import type { NotifyDeliveryResult } from "../proactive-notify.js";

/**
 * Suppress delivery, and say so when the model went off-contract to get there.
 *
 * A `narrated-sentinel` turn is handled correctly but is still a signal worth
 * surfacing: it means the model that ran wrote prose before the marker, which is
 * how an entire cron turn's reasoning once reached a shared channel. Suppressing
 * it silently would leave that invisible until the next time the contract slips.
 */
function suppressesNotification(
  text: string | undefined,
  source: Record<string, unknown>,
  logger: MonoAgentAppLogger | undefined,
): boolean {
  const suppression = classifyNotifySuppression(text);
  if (suppression === "narrated-sentinel") {
    logger?.warn?.(
      "Native notification suppressed: the final answer ended with the NOTHING_TO_REPORT sentinel but was not the sentinel alone.",
      source,
    );
  }
  return suppression !== "none";
}

export async function deliverNativeCronNotification(input: {
  readonly job: CronJobConfig | undefined;
  readonly result: CronJobResult;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean; readonly deliveryKey?: string; readonly deliveryContext?: NotifyDeliveryContext },
  ) => Promise<NotifyDeliveryResult>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const job = input.job;
  if (job?.notify !== true || input.result.kind !== "succeeded") {
    return;
  }
  const text = input.result.text;
  if (text === undefined || suppressesNotification(text, { jobId: job.id }, input.logger)) {
    return;
  }
  try {
    if (input.notifyDestination === undefined) {
      input.logger?.warn?.("Native cron notification skipped: no delivery hook is available.", { jobId: job.id });
      return;
    }

    const destination = job.notifyConversationId ?? input.result.notifyConversationId;
    if (destination === undefined) {
      input.logger?.warn?.("Native cron notification skipped: no destination was resolved for this run.", {
        jobId: job.id,
      });
      return;
    }

    const delivery = await input.notifyDestination(destination, text, {
      verbatim: true,
      deliveryContext: { kind: "cron", jobId: job.id, runId: input.result.cronRunId },
      ...(destination === "web:new"
        ? { deliveryKey: `${input.result.cronRunId}:success` }
        : {}),
    });
    if (!delivery.delivered) {
      input.logger?.warn?.("Native cron notification was not delivered.", {
        jobId: job.id,
        conversationId: destination,
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      });
    }
  } catch (error) {
    input.logger?.warn?.("Native cron notification failed.", {
      jobId: job.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function inferUniqueNotifyDestination(input: {
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  if (input.listNotifyDestinations === undefined) {
    return undefined;
  }
  throwIfAborted(input.abortSignal);
  const destinations = await input.listNotifyDestinations();
  throwIfAborted(input.abortSignal);
  return destinations.length === 1 ? destinations[0]?.conversationId : undefined;
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted === true) {
    throw abortSignal.reason ?? new Error("Native notification destination resolution was aborted.");
  }
}

export async function deliverNativeWebhookNotification(input: {
  readonly endpoint: WebhookEndpointConfig | undefined;
  readonly status: WebhookInvocationStatus;
  readonly request: WebhookInvocationRequest;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean; readonly deliveryKey?: string; readonly deliveryContext?: NotifyDeliveryContext },
  ) => Promise<NotifyDeliveryResult>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const endpoint = input.endpoint;
  if (endpoint?.notify !== true || input.status.status !== "succeeded") {
    return;
  }
  const source = { endpointName: input.request.metadata.webhook.endpointName };
  const text = input.status.text;
  if (text === undefined || suppressesNotification(text, source, input.logger)) {
    return;
  }
  try {
    if (input.notifyDestination === undefined) {
      input.logger?.warn?.("Native webhook notification skipped: no delivery hook is available.", source);
      return;
    }

    const destination = input.request.replyTo?.conversationId;
    if (destination === undefined) {
      input.logger?.warn?.("Native webhook notification skipped: no destination was resolved for this run.", source);
      return;
    }

    const delivery = await input.notifyDestination(destination, text, {
      verbatim: true,
      ...(destination === "web:new"
        ? {
            deliveryKey: `webhook:${encodeURIComponent(endpoint.name)}:${input.status.requestId}:success`,
          }
        : {}),
    });
    if (!delivery.delivered) {
      input.logger?.warn?.("Native webhook notification was not delivered.", {
        ...source,
        conversationId: destination,
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      });
    }
  } catch (error) {
    input.logger?.warn?.("Native webhook notification failed.", {
      ...source,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
