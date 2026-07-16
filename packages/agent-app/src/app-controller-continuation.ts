import type { MonoAgentConfig } from "@mono-agent/config";

import { isAppCoreConfigError, loadAppCoreConfig } from "./app-config.js";
import { isAdapterSendToolAllowed } from "./adapter-send-tools.js";
import { loadInteractionSettings, startInteractionBridge } from "./interaction-bridge.js";
import type { InteractionBridgeHandle } from "./interaction-bridge.js";
import { loadContinuationSettings } from "./continuation-config.js";
import { ContinuationSynthesisUnavailableError, startContinuationService } from "./continuation-service.js";
import type { ContinuationServiceHandle } from "./continuation-service.js";
import type {
  ContinuationHistoryRecordResult,
  ContinuationNativeDeliveryResult,
  ContinuationSynthesisInput,
} from "./continuations.js";
import { channelIdForConversation } from "./proactive-notify.js";
import {
  continuationSynthesisPrompt,
  isActionableContinuationPayload,
  isPermanentDeliveryReason,
  normalizeContinuationOrigin,
  reasonOf,
  runtimeRouteContainsDirectOpenCode,
} from "./app-controller-utils.js";
import type { ContinuationRunningChannel } from "./app-controller-utils.js";
import type { MonoAgentAppController } from "./app-controller.js";

export function ensureInteractionBridge(controller: MonoAgentAppController, coreConfig: MonoAgentConfig): Promise<InteractionBridgeHandle | undefined> {
  controller.interactionBridgeStart ??= (async () => {
    const directOpenCodeRoute = runtimeRouteContainsDirectOpenCode(coreConfig);
    const settings = await loadInteractionSettings({ env: controller.env, configPath: controller.configReadPath });
    const askUserAllowed = !directOpenCodeRoute && isAdapterSendToolAllowed("AskUser", {
      allowedTools: coreConfig.tools.allowedTools,
      disallowedTools: coreConfig.tools.disallowedTools,
    });
    const telegramAskAllowed = !directOpenCodeRoute && isAdapterSendToolAllowed("TelegramAskButtons", {
      allowedTools: coreConfig.tools.allowedTools,
      disallowedTools: coreConfig.tools.disallowedTools,
    });
    const scopedProgressNeeded = settings.progressEnabled
      && (coreConfig.tools.mcpRequestContextServers?.length ?? 0) > 0;
    if (!askUserAllowed && !telegramAskAllowed && !scopedProgressNeeded && !settings.configured) {
      return undefined;
    }
    try {
      const bridge = await startInteractionBridge({
        host: settings.host,
        port: settings.port,
        askTimeoutMs: settings.askTimeoutMs,
        ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      });
      controller.interactionBridge = bridge;
      controller.logger?.info?.("Interaction bridge started.", { url: bridge.url });
      return bridge;
    } catch (error) {
      controller.logger?.warn?.("Interaction bridge failed to start; AskUser and tool progress are unavailable.", {
        reason: reasonOf(error),
      });
      return undefined;
    }
  })();
  return controller.interactionBridgeStart;
}

export async function stopInteractionBridge(controller: MonoAgentAppController): Promise<void> {
  const bridge = controller.interactionBridge;
  controller.interactionBridge = undefined;
  controller.interactionBridgeStart = undefined;
  await bridge?.stop().catch(() => undefined);
}

export function ensureContinuationService(controller: MonoAgentAppController, coreConfig: MonoAgentConfig): Promise<ContinuationServiceHandle | undefined> {
  controller.continuationServiceStart ??= (async () => {
    const settings = await loadContinuationSettings({ cwd: controller.cwd, configPath: controller.configReadPath, env: controller.env });
    const needed = settings.configured || (coreConfig.tools.continuationServers?.length ?? 0) > 0;
    if (!needed) {
      return undefined;
    }
    if (!settings.enabled) {
      throw new Error("Continuation service is disabled while continuation functionality is configured.");
    }
    try {
      const service = await startContinuationService({
        cwd: controller.cwd,
        stateDir: settings.stateDir,
        host: settings.host,
        port: settings.port,
        namedRoutes: settings.namedRoutes,
        detachedServices: settings.detachedServices,
        retention: settings.retention,
        limits: settings.limits,
        synthesisPreflight: (input) => controller.continuationSynthesisAvailability(input),
        synthesize: async (input) => await controller.synthesizeContinuation(input),
        deliver: async (input) => await controller.deliverContinuation(
          input.conversationId,
          input.text,
          input.deliveryKey,
        ),
        recordHistory: async (input) => await controller.recordContinuationHistory(
          input.conversationId,
          input.text,
          input.deliveryKey,
        ),
        ...(controller.logger === undefined ? {} : { logger: controller.logger }),
      });
      controller.continuationService = service;
      controller.logger?.info?.("Durable continuation service started.", { url: service.url });
      return service;
    } catch (error) {
      controller.logger?.error?.("Durable continuation service failed to start.", { reason: reasonOf(error) });
      throw error;
    }
  })();
  return controller.continuationServiceStart;
}

export async function startContinuationServiceIfConfigured(controller: MonoAgentAppController, reason: string): Promise<void> {
  if (controller.stopped) return;
  let coreConfig: MonoAgentConfig;
  try {
    coreConfig = await loadAppCoreConfig({ env: controller.env, cwd: controller.cwd, configPath: controller.configReadPath });
  } catch (error) {
    if (isAppCoreConfigError(error)) {
      controller.logger?.debug?.("Continuation service is waiting for valid core configuration.", { reason });
      return;
    }
    throw error;
  }
  await controller.ensureContinuationService(coreConfig);
  controller.logger?.debug?.("Continuation service configuration evaluated.", { reason });
}

export async function stopContinuationService(controller: MonoAgentAppController): Promise<void> {
  const service = controller.continuationService;
  controller.continuationService = undefined;
  controller.continuationServiceStart = undefined;
  await service?.stop().catch(() => undefined);
}

export function requireContinuationService(controller: MonoAgentAppController): ContinuationServiceHandle {
  if (controller.continuationService === undefined) throw new Error("Durable continuation service is not running.");
  return controller.continuationService;
}

export async function synthesizeContinuation(controller: MonoAgentAppController, input: ContinuationSynthesisInput): Promise<{ readonly text: string; readonly actionable?: boolean }> {
  const conversationId = input.replyToConversationId ?? normalizeContinuationOrigin(input.originConversationId);
  const channelId = channelIdForConversation(conversationId);
  const channel = channelId === undefined ? undefined : controller.running.get(channelId) as ContinuationRunningChannel | undefined;
  if (channel?.synthesizeContinuation === undefined) {
    // This is a lifecycle/readiness miss before the responder is invoked, so
    // the durable service may safely requeue without consuming a model attempt.
    throw new ContinuationSynthesisUnavailableError(
      "destination_channel_unavailable",
      `Destination channel is not ready to synthesize durable continuations: ${channelId ?? "unknown"}.`,
      1_000,
    );
  }
  const result = await channel.synthesizeContinuation({
    continuationId: input.continuationId,
    originRunId: input.originRunId,
    ...(input.historyBoundary === undefined ? {} : { historyBoundary: input.historyBoundary }),
    originContextPolicy: input.originContextPolicy,
    ...(input.originContext === undefined ? {} : { originContext: input.originContext }),
    originConversationId: input.originConversationId,
    replyToConversationId: conversationId,
    prompt: continuationSynthesisPrompt(input.payload, input.mode),
  });
  if (result.kind === "unavailable") {
    throw new ContinuationSynthesisUnavailableError(
      result.code,
      result.reason,
      result.retryAfterMs,
    );
  }
  const text = result.text;
  const actionable = input.mode === "notify_if_actionable" ? isActionableContinuationPayload(input.payload) : undefined;
  return { text, ...(actionable === undefined ? {} : { actionable }) };
}

export function continuationSynthesisAvailability(controller: MonoAgentAppController, input: ContinuationSynthesisInput):
  | { readonly ready: true }
  | { readonly ready: false; readonly code: string; readonly reason: string; readonly retryAfterMs: number } {
  const conversationId = input.replyToConversationId ?? normalizeContinuationOrigin(input.originConversationId);
  const channelId = channelIdForConversation(conversationId);
  const channel = channelId === undefined ? undefined : controller.running.get(channelId) as ContinuationRunningChannel | undefined;
  if (channel?.synthesizeContinuation !== undefined) return { ready: true };
  return {
    ready: false,
    code: "destination_channel_unavailable",
    reason: `Destination channel is not ready to synthesize durable continuations: ${channelId ?? "unknown"}.`,
    retryAfterMs: 1_000,
  };
}

export async function deliverContinuation(
  controller: MonoAgentAppController,
  conversationId: string,
  text: string,
  deliveryKey: string,
): Promise<ContinuationNativeDeliveryResult> {
  const result = await controller.notifyDestination(conversationId, text, { verbatim: true, deliveryKey });
  if (result.delivered) {
    return {
      kind: "delivered",
      code: "delivered",
      ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
      ...(result.channelId === undefined ? {} : { channelId: result.channelId }),
      ...(result.historyRecorded === undefined ? {} : { historyRecorded: result.historyRecorded }),
      ...(result.historyRecorded !== false || result.historyErrorCode === undefined
        ? {}
        : { historyErrorCode: result.historyErrorCode }),
    };
  }
  const reason = result.reason ?? "Native continuation delivery failed.";
  const code = result.code ?? "delivery_failed";
  if (result.ambiguous === true) return { kind: "unknown", code, reason };
  if (result.retryable === false || isPermanentDeliveryReason(reason)) return { kind: "permanent", code, reason };
  return { kind: "retryable", code, reason };
}

export async function recordContinuationHistory(
  controller: MonoAgentAppController,
  conversationId: string,
  text: string,
  deliveryKey: string,
): Promise<ContinuationHistoryRecordResult> {
  const channelId = channelIdForConversation(conversationId);
  const channel = channelId === undefined ? undefined : controller.running.get(channelId) as ContinuationRunningChannel | undefined;
  if (channel?.recordContinuationHistory === undefined) {
    return { recorded: false, code: "history_record_channel_unavailable" };
  }
  return await channel.recordContinuationHistory({ conversationId, text, deliveryKey });
}
