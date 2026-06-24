import { NOTIFY_TOOLS_MCP_SERVER_NAME, type NotifyToolsServer } from "./notify-tool.js";

/**
 * Per-request input the harness hands each runtime-options extension. We only
 * need the request's metadata to decide whether this is a proactive trigger.
 */
interface NotifyRuntimeExtensionInput {
  readonly request: { readonly metadata?: Record<string, unknown> | undefined };
}

interface NotifyRuntimeExtensionResult {
  readonly runtimeOptions: { readonly mcpServers?: Record<string, unknown> };
  readonly cleanup: () => Promise<void>;
}

const EMPTY: NotifyRuntimeExtensionResult = { runtimeOptions: {}, cleanup: async () => {} };

/**
 * Runtime extension that exposes the `notify_conversation`/`list_notify_destinations`
 * tools, but ONLY on proactive trigger turns — cron and webhook — identified by the
 * request metadata (`metadata.cron`/`metadata.webhook`, robust regardless of how the
 * turn's conversationId is scoped). Live channel turns (telegram/slack/etc.) never see
 * these tools: a live turn is already in its conversation and just replies.
 */
export function createNotifyToolsRuntimeExtension(
  server: Pick<NotifyToolsServer, "url" | "token">,
): (input: NotifyRuntimeExtensionInput) => Promise<NotifyRuntimeExtensionResult> {
  const entry = {
    [NOTIFY_TOOLS_MCP_SERVER_NAME]: {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    },
  };
  return async (input) => {
    return isProactiveTrigger(input.request.metadata) && !isNativeNotify(input.request.metadata)
      ? { runtimeOptions: { mcpServers: entry }, cleanup: async () => {} }
      : EMPTY;
  };
}

function isProactiveTrigger(metadata: Record<string, unknown> | undefined): boolean {
  return metadata !== undefined && (metadata.cron !== undefined || metadata.webhook !== undefined);
}

function isNativeNotify(metadata: Record<string, unknown> | undefined): boolean {
  return isNativeNotifyTrigger(metadata?.cron) || isNativeNotifyTrigger(metadata?.webhook);
}

function isNativeNotifyTrigger(trigger: unknown): boolean {
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
