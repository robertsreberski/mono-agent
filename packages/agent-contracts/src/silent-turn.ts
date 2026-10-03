import type { AgentRequestBase } from "./index.js";

// Request-identity admission, deliberately not a JSON metadata flag. Only the
// cron/webhook drivers register their notify-enabled responder requests.
const nativeNotifyRequests = new WeakSet<object>();
const alreadyVisibleRequests = new WeakSet<object>();

export function registerNativeNotifyRequest(request: AgentRequestBase): void {
  if (request.metadata !== undefined) nativeNotifyRequests.add(request.metadata);
}

export function markSilentTurnAlreadyVisible(request: Pick<AgentRequestBase, "metadata">): void {
  if (request.metadata !== undefined) alreadyVisibleRequests.add(request.metadata);
}

export function isSilentTurnAlreadyVisible(request: Pick<AgentRequestBase, "metadata">): boolean {
  return request.metadata !== undefined && alreadyVisibleRequests.has(request.metadata);
}

export function isNativeNotifyRequest(request: Pick<AgentRequestBase, "metadata">): boolean {
  return request.metadata !== undefined && nativeNotifyRequests.has(request.metadata);
}
