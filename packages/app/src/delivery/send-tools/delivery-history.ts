import type { AdapterSendToolsDeliveryHistory } from "./types.js";

export interface DeliveryHistoryOutcome {
  readonly accepted: boolean;
  readonly code: string;
}

const DELIVERY_HISTORY_BRIDGE_TIMEOUT_MS = 2_000;

export async function recordAdapterDeliveryHistory(input: {
  readonly settings: AdapterSendToolsDeliveryHistory | undefined;
  readonly fetchImpl: typeof fetch;
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}): Promise<DeliveryHistoryOutcome | undefined> {
  if (input.settings === undefined) return undefined;
  try {
    const response = await input.fetchImpl(new URL("/v1/delivery-history", input.settings.bridgeUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.settings.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationId: input.conversationId,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
      }),
      signal: AbortSignal.timeout(DELIVERY_HISTORY_BRIDGE_TIMEOUT_MS),
    });
    if (response.status === 202) return { accepted: true, code: "queued" };
    if (response.status === 400) return { accepted: false, code: "history_record_invalid" };
    if (response.status === 401) return { accepted: false, code: "history_capability_rejected" };
    if (response.status === 403) return { accepted: false, code: "history_capability_scope_rejected" };
    if (response.status === 501) return { accepted: false, code: "history_record_unavailable" };
    if (response.status === 503) return { accepted: false, code: "history_record_failed" };
    return { accepted: false, code: `history_bridge_http_${String(response.status)}` };
  } catch {
    return { accepted: false, code: "history_bridge_unreachable" };
  }
}

export function deliveryHistorySummary(
  outcomes: readonly (DeliveryHistoryOutcome | undefined)[],
): DeliveryHistoryOutcome | undefined {
  const present = outcomes.filter((outcome): outcome is DeliveryHistoryOutcome => outcome !== undefined);
  if (present.length === 0) return undefined;
  const failed = present.find((outcome) => !outcome.accepted);
  return failed ?? { accepted: true, code: "queued" };
}

export function withDeliveryHistoryWarning(message: string, history: DeliveryHistoryOutcome | undefined): string {
  return history?.accepted === false
    ? `${message} Delivery succeeded, but destination history was not queued (${history.code}).`
    : message;
}
