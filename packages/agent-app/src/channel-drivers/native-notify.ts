import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";
import type { CronJobConfig, CronJobResult } from "@mono-agent/cron-adapter";
import type {
  WebhookEndpointConfig,
  WebhookInvocationRequest,
  WebhookInvocationStatus,
} from "@mono-agent/webhook-adapter";

import type { MonoAgentAppLogger } from "../channels.js";
import type { NotifyDestination } from "../notify-destinations.js";
import type { NotifyDeliveryResult } from "../proactive-notify.js";

/** Whether a notify-enabled turn's final text intentionally suppresses delivery. */
function suppressesNotification(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return trimmed.length === 0 || trimmed.toUpperCase() === NOTHING_TO_REPORT_SENTINEL;
}

/** A conversation id backed by a built-in push channel with a notify hook. */
function isDeliverableConversation(conversationId: string): boolean {
  return conversationId.startsWith("telegram:") || conversationId.startsWith("slack:");
}

export async function deliverNativeCronNotification(input: {
  readonly job: CronJobConfig | undefined;
  readonly result: CronJobResult;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const job = input.job;
  if (job?.notify !== true || input.result.kind !== "succeeded") {
    return;
  }
  const text = input.result.text;
  if (text === undefined || suppressesNotification(text)) {
    return;
  }
  try {
    if (input.notifyDestination === undefined) {
      input.logger?.warn?.("Native cron notification skipped: no delivery hook is available.", { jobId: job.id });
      return;
    }

    const destination = await resolveNativeCronNotifyDestination({
      job,
      ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    if (destination === undefined) {
      return;
    }

    const delivery = await input.notifyDestination(destination, text, { verbatim: true });
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

async function resolveNativeCronNotifyDestination(input: {
  readonly job: CronJobConfig;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<string | undefined> {
  if (input.job.notifyConversationId !== undefined) {
    return input.job.notifyConversationId;
  }
  if (input.listNotifyDestinations === undefined) {
    input.logger?.warn?.("Native cron notification skipped: no destination is configured and no destination resolver is available.", {
      jobId: input.job.id,
    });
    return undefined;
  }
  const destinations = await input.listNotifyDestinations();
  if (destinations.length !== 1) {
    input.logger?.warn?.("Native cron notification skipped: destination inference requires exactly one candidate.", {
      jobId: input.job.id,
      destinationCount: destinations.length,
    });
    return undefined;
  }
  return destinations[0]?.conversationId;
}

export async function inferUniqueNotifyDestination(input: {
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
}): Promise<string | undefined> {
  if (input.listNotifyDestinations === undefined) {
    return undefined;
  }
  const destinations = await input.listNotifyDestinations();
  return destinations.length === 1 ? destinations[0]?.conversationId : undefined;
}

export async function deliverNativeWebhookNotification(input: {
  readonly endpoint: WebhookEndpointConfig | undefined;
  readonly status: WebhookInvocationStatus;
  readonly request: WebhookInvocationRequest;
  readonly notifyDestination?: (
    conversationId: string,
    text: string,
    options?: { readonly verbatim?: boolean },
  ) => Promise<NotifyDeliveryResult>;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<void> {
  const endpoint = input.endpoint;
  if (endpoint?.notify !== true || input.status.status !== "succeeded") {
    return;
  }
  const text = input.status.text;
  if (text === undefined || suppressesNotification(text)) {
    return;
  }
  const source = { endpointName: input.request.metadata.webhook.endpointName };
  try {
    if (input.notifyDestination === undefined) {
      input.logger?.warn?.("Native webhook notification skipped: no delivery hook is available.", source);
      return;
    }

    const destination = await resolveNativeWebhookNotifyDestination({
      endpoint,
      source,
      requestConversationId: input.request.conversationId,
      ...(input.listNotifyDestinations === undefined ? {} : { listNotifyDestinations: input.listNotifyDestinations }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    if (destination === undefined) {
      return;
    }

    const delivery = await input.notifyDestination(destination, text, { verbatim: true });
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

async function resolveNativeWebhookNotifyDestination(input: {
  readonly endpoint: WebhookEndpointConfig;
  readonly source: Record<string, unknown>;
  readonly requestConversationId?: string;
  readonly listNotifyDestinations?: () => Promise<readonly NotifyDestination[]>;
  readonly logger?: MonoAgentAppLogger;
}): Promise<string | undefined> {
  if (input.endpoint.notifyConversationId !== undefined) {
    return input.endpoint.notifyConversationId;
  }
  if (input.requestConversationId !== undefined && isDeliverableConversation(input.requestConversationId)) {
    return input.requestConversationId;
  }
  if (input.listNotifyDestinations === undefined) {
    input.logger?.warn?.("Native webhook notification skipped: no destination is configured and no destination resolver is available.", input.source);
    return undefined;
  }
  const destinations = await input.listNotifyDestinations();
  if (destinations.length !== 1) {
    input.logger?.warn?.("Native webhook notification skipped: destination inference requires exactly one candidate.", {
      ...input.source,
      destinationCount: destinations.length,
    });
    return undefined;
  }
  return destinations[0]?.conversationId;
}
