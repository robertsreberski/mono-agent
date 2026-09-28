import type { ChannelInteractionSink, NotifyDeliveryResult } from "@mono-agent/agent-contracts";
import { describeRunFailureKind } from "@mono-agent/observability";
import type {
  TelegramAdapterConfig,
  TelegramAdapterErrorTextInput,
  TelegramAdapterStartOptions,
  TelegramAdapterStartResult,
  TelegramChatId,
  TelegramDestination,
  TelegramTranscriptionConfig,
  TelegramRuntimeControls,
} from "@mono-agent/telegram-adapter";

import { buildChannelRuntimeControls } from "../channel-runtime-controls.js";
import { buildChannelConfigView } from "../channel-config-view.js";
import { isChannelConfigured } from "../channel-gate.js";
import type { ChannelGateSpec } from "../channel-gate.js";
import type { ChannelDriver, ChannelStartInput } from "../channels.js";
import { interactionScheduleHost } from "../interaction-bridge.js";
import { telegramTargetFromConversation, type TelegramDestinationTarget } from "../telegram-destination.js";
import {
  startTelegramScheduleService,
  type TelegramScheduleDeliverInput,
  type TelegramScheduleDeliveryResult,
  type TelegramScheduleService,
} from "../telegram-schedule-service.js";
import {
  openTelegramTopicDirectory,
  sanitizeTelegramLabel,
  telegramBotIdFromToken,
  type TelegramTopicDirectoryStore,
} from "../telegram-topic-directory.js";
import { unconfiguredChannelView } from "./shared.js";

type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");

let telegramModule: TelegramAdapterModule | undefined;
const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));

const TELEGRAM_GATE: ChannelGateSpec = { jsonKey: "telegram", envPrefix: "MONO_AGENT_TELEGRAM_" };
const UNCONFIGURED_TELEGRAM_CONFIG: TelegramAdapterConfig = {
  enabled: false,
  botToken: "",
  allowedChatIds: [],
  allowAllChats: false,
  groupMode: "any",
  stripMentionText: true,
};

export interface TelegramChannelOverrides {
  readonly botFactory?: TelegramAdapterStartOptions["botFactory"];
  readonly runnerFactory?: TelegramAdapterStartOptions["runnerFactory"];
  readonly startAdapter?: (options: TelegramAdapterStartOptions) => Promise<TelegramAdapterStartResult>;
}

export function createTelegramChannelDriver(
  overrides: TelegramChannelOverrides = {},
): ChannelDriver<TelegramAdapterConfig> {
  return {
    id: "telegram",
    label: "Telegram",
    processJobs: { conversationScheme: "telegram" },
    async configView(input) {
      if (!(await isChannelConfigured(input, TELEGRAM_GATE))) {
        return unconfiguredChannelView("telegram", "Telegram");
      }
      const adapter = await loadTelegramModule();
      return await buildChannelConfigView(this, adapter.TELEGRAM_CONFIG_FIELDS, input);
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, TELEGRAM_GATE))) {
        return UNCONFIGURED_TELEGRAM_CONFIG;
      }
      const adapter = await loadTelegramModule();
      return await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return telegramModule !== undefined && error instanceof telegramModule.TelegramAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Telegram is disabled.";
    },
    async start(input) {
      const adapter = await loadTelegramModule();
      const startAdapter = overrides.startAdapter ?? adapter.startTelegramAdapter;
      const topicDirectory = await openTopicDirectory(input);
      let result: TelegramAdapterStartResult;
      try {
        result = await startAdapter(telegramStartOptions(input, overrides, topicDirectory.store));
      } catch (error) {
        topicDirectory.store?.close();
        throw error;
      }
      const schedules = await startSchedules(input, topicDirectory.store, (delivery) =>
        deliverScheduledTurn(input, result, adapter, delivery));
      const interactionSink: ChannelInteractionSink = {
        presentAsk: async (conversationId, snapshot) => {
          await result.presentAsk(requireAllowedTelegramTarget(conversationId, input), snapshot);
        },
        updateAsk: async (conversationId, snapshot) => {
          await result.updateAsk(requireAllowedTelegramTarget(conversationId, input), snapshot);
        },
        postStatus: async (conversationId, text, statusOptions) => {
          await result.postStatus(requireAllowedTelegramTarget(conversationId, input), text, statusOptions);
        },
      };
      input.interaction?.registerSink("telegram", interactionSink);
      return {
        summary: {
          ...(topicDirectory.summary === undefined ? {} : { topicDirectory: topicDirectory.summary }),
          ...(schedules.summary === undefined ? {} : { schedules: schedules.summary }),
        },
        stop: async () => {
          // Schedules stop first so in-flight scheduled turns are cancelled
          // through the still-running adapter, then the lease is released.
          schedules.unregister?.();
          await schedules.service?.stop().catch((error: unknown) => {
            input.logger?.warn?.("Telegram schedules did not stop cleanly.", { error: errorMessage(error) });
          });
          try {
            await result.stop();
          } finally {
            topicDirectory.store?.close();
          }
        },
        processJobs: {
          update: async ({ conversationId, processJob, retirementOnly }) => {
            if (processJob.origin.channel !== "telegram"
              || conversationId !== baseConversationId(processJob.origin.conversationId)) {
              return {
                delivered: false,
                code: "process_job_origin_mismatch",
                reason: "The process-job origin does not match the Telegram destination.",
                retryable: false,
              };
            }
            const target = telegramTargetFromConversation(conversationId);
            if (target === undefined || !isAllowedTelegramChat(target, input)) {
              return { delivered: false, reason: "telegram chat is not in the adapter allowlist" };
            }
            const destination = adapterDestination(target);
            const silent = input.config.quietHours !== undefined
              && adapter.isWithinQuietHours(new Date(), input.config.quietHours);
            if (result.updateProcessJob === undefined) {
              return {
                delivered: false,
                code: "background_unsupported_channel",
                reason: "The running Telegram adapter does not support process-job lifecycle updates.",
                retryable: false,
              };
            }
            const updateOptions = {
              ...(silent ? { silent: true } : {}),
              ...(retirementOnly === true ? { retirementOnly: true } : {}),
            };
            return await result.updateProcessJob(
              destination,
              processJob,
              Object.keys(updateOptions).length === 0 ? undefined : updateOptions,
            );
          },
          wake: async ({ conversationId, text, deliveryKey, processJob }) => {
            if (processJob.origin.channel !== "telegram"
              || conversationId !== baseConversationId(processJob.origin.conversationId)) {
              return {
                delivered: false,
                code: "process_job_origin_mismatch",
                reason: "The process-job origin does not match the Telegram destination.",
                retryable: false,
              };
            }
            const target = telegramTargetFromConversation(conversationId);
            if (target === undefined || !isAllowedTelegramChat(target, input)) {
              return { delivered: false, reason: "telegram chat is not in the adapter allowlist" };
            }
            const destination = adapterDestination(target);
            const silent = input.config.quietHours !== undefined
              && adapter.isWithinQuietHours(new Date(), input.config.quietHours);
            const outcome = await result.notify(destination, text, {
              deliveryKey,
              steerActive: true,
              ...(silent ? { silent: true } : {}),
            });
            return settleProcessJobWake(outcome);
          },
        },
        notify: async (request) => {
          const { conversationId, text, verbatim, deliveryKey, processJob } = request;
          if (processJob !== undefined
            && (processJob.origin.channel !== "telegram"
              || conversationId !== baseConversationId(processJob.origin.conversationId))) {
            return {
              delivered: false,
              code: "process_job_origin_mismatch",
              reason: "The process-job origin does not match the Telegram destination.",
              retryable: false,
            };
          }
          const target = telegramTargetFromConversation(conversationId);
          if (target === undefined) {
            input.logger?.warn?.("Telegram proactive notify skipped: unparseable destination.", { conversationId });
            return { delivered: false, reason: "unparseable telegram destination" };
          }
          if (!isAllowedTelegramChat(target, input)) {
            input.logger?.warn?.("Telegram proactive notify skipped: destination not in allowlist.", { conversationId });
            return { delivered: false, reason: "telegram chat is not in the adapter allowlist" };
          }
          const destination = adapterDestination(target);
          const silent = input.config.quietHours !== undefined
            && adapter.isWithinQuietHours(new Date(), input.config.quietHours);
          if (processJob !== undefined) {
            const updater = result.updateProcessJob;
            if (typeof updater !== "function") {
              return {
                delivered: false,
                code: "background_unsupported_channel",
                reason: "The running Telegram adapter does not support process-job lifecycle updates.",
                retryable: false,
              };
            }
            const surfaceOutcome = await updater.call(
              result,
              destination,
              processJob,
              silent ? { silent: true } : undefined,
            );
            if (text.trim().length === 0) {
              return surfaceOutcome;
            }
          }
          const notifyOptions = verbatim === undefined && deliveryKey === undefined && !silent
            ? undefined
            : {
                ...(verbatim === undefined ? {} : { verbatim }),
                ...(deliveryKey === undefined ? {} : { deliveryKey }),
                ...(silent ? { silent: true } : {}),
              };
          const outcome = await result.notify(destination, text, notifyOptions);
          return processJob === undefined ? outcome : settleProcessJobWake(outcome);
        },
        recordContinuationHistory: async (historyInput: {
          readonly conversationId: string;
          readonly text: string;
          readonly deliveryKey: string;
        }) => {
          try {
            requireAllowedTelegramTarget(historyInput.conversationId, input);
          } catch {
            return { recorded: false as const, code: "telegram_destination_not_allowlisted" };
          }
          if (input.responder.deliverVerbatim === undefined) {
            return { recorded: false as const, code: "history_record_unavailable" };
          }
          try {
            await input.responder.deliverVerbatim(
              historyInput.conversationId,
              historyInput.text,
              { idempotencyKey: historyInput.deliveryKey },
            );
            return { recorded: true as const };
          } catch (error) {
            input.logger?.warn?.("Telegram destination history commit failed after delivery.", {
              conversationId: historyInput.conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            return { recorded: false as const, code: "history_record_failed" };
          }
        },
      };
    },
  };
}

interface TopicDirectoryStart {
  readonly store?: TelegramTopicDirectoryStore;
  readonly summary?: string;
}

/**
 * Open the persistent topic directory when enabled. A corrupt or insecure
 * directory disables name addressing with a diagnostic; ordinary Telegram
 * conversations keep working.
 */
async function openTopicDirectory(input: ChannelStartInput<TelegramAdapterConfig>): Promise<TopicDirectoryStart> {
  if (input.config.topicDirectory?.enabled !== true) return {};
  try {
    const store = await openTelegramTopicDirectory({
      cwd: input.cwd,
      botId: telegramBotIdFromToken(input.config.botToken),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    return { store, summary: "on" };
  } catch (error) {
    input.logger?.warn?.("Telegram topic directory is unavailable; topics cannot be addressed by name.", {
      error: errorMessage(error),
    });
    return { summary: `unavailable: ${errorMessage(error)}` };
  }
}

interface SchedulesStart {
  readonly service?: TelegramScheduleService;
  readonly unregister?: () => void;
  readonly summary?: string;
}

/**
 * Start agent-managed schedules after the adapter is running. Records are
 * never deleted by disabling the feature; a lease conflict or corrupt state
 * leaves schedules unavailable with a visible reason.
 */
async function startSchedules(
  input: ChannelStartInput<TelegramAdapterConfig>,
  directory: TelegramTopicDirectoryStore | undefined,
  deliver: (delivery: TelegramScheduleDeliverInput) => Promise<TelegramScheduleDeliveryResult>,
): Promise<SchedulesStart> {
  const config = input.config.schedules;
  if (config?.enabled !== true) return {};
  const host = interactionScheduleHost(input.interaction);
  if (directory === undefined || host === undefined) {
    const reason = directory === undefined
      ? "the topic directory is unavailable"
      : "the interaction bridge is not running";
    input.logger?.warn?.("Telegram schedules are unavailable.", { reason });
    return { summary: `unavailable: ${reason}` };
  }
  try {
    const service = await startTelegramScheduleService({
      cwd: input.cwd,
      botId: telegramBotIdFromToken(input.config.botToken),
      maxSchedules: config.maxSchedules,
      minIntervalMinutes: config.minIntervalMinutes,
      isChatAllowed: (chatId) => input.config.allowAllChats || input.config.allowedChatIds.includes(chatId),
      directory,
      deliver,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const unregister = host.registerScheduleHandler((operation, args, context) => service.call(operation, args, context));
    return { service, unregister, summary: "running" };
  } catch (error) {
    input.logger?.warn?.("Telegram schedules are unavailable.", { error: errorMessage(error) });
    return { summary: `unavailable: ${errorMessage(error)}` };
  }
}

/**
 * Run one scheduled turn in its destination conversation through the regular
 * proactive path (per-conversation queue, topic routing, quiet-hours silence),
 * with the allowlist re-checked right before. Only a finished answer is
 * posted; an empty or NOTHING_TO_REPORT answer posts nothing.
 */
async function deliverScheduledTurn(
  input: ChannelStartInput<TelegramAdapterConfig>,
  result: TelegramAdapterStartResult,
  adapter: TelegramAdapterModule,
  delivery: TelegramScheduleDeliverInput,
): Promise<TelegramScheduleDeliveryResult> {
  const { schedule } = delivery;
  const chatId = /^-?\d+$/u.test(schedule.destination.chatId)
    ? Number(schedule.destination.chatId)
    : schedule.destination.chatId;
  const target: TelegramDestinationTarget = schedule.destination.topicId === undefined
    ? { chatId }
    : { chatId, messageThreadId: schedule.destination.topicId };
  if (!isAllowedTelegramChat(target, input)) {
    return { delivered: false, code: "destination_not_allowlisted", reason: "telegram chat is not in the adapter allowlist" };
  }
  const silent = input.config.quietHours !== undefined
    && adapter.isWithinQuietHours(new Date(), input.config.quietHours);
  const prompt = `Scheduled task "${sanitizeTelegramLabel(schedule.name)}":\n\n${schedule.prompt}`;
  return await result.notify(adapterDestination(target), prompt, {
    finalAnswerOnly: true,
    abortSignal: delivery.signal,
    requestMetadata: {
      channelSchedule: {
        scheduleId: schedule.id,
        scheduledAt: delivery.scheduledAt,
        nativeNotify: { enabled: true },
      },
    },
    ...(silent ? { silent: true } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

function settleProcessJobWake(result: NotifyDeliveryResult): NotifyDeliveryResult {
  if (result.delivered) return result;
  if (result.code === "conversation_busy") {
    return { ...result, retryable: result.retryable ?? true };
  }
  // Compatibility for older/custom Telegram starters that predate the stable
  // adapter code. Built-in adapters classify this refusal at their boundary.
  if (result.code === undefined && result.reason === "chat at concurrency cap") {
    return { ...result, code: "conversation_busy", retryable: result.retryable ?? true };
  }
  return { ...result, retryable: false, ambiguous: true };
}

function telegramAttachmentOptions(
  config: TelegramAdapterConfig,
): {
  maxBytes?: number;
  downloadTimeoutMs?: number;
  transcription?: TelegramTranscriptionConfig;
} | undefined {
  const attachments = config.attachments;
  const transcription = config.transcription;
  if (
    attachments?.maxBytes === undefined
    && attachments?.downloadTimeoutMs === undefined
    && transcription === undefined
  ) {
    return undefined;
  }
  return {
    ...(attachments?.maxBytes === undefined ? {} : { maxBytes: attachments.maxBytes }),
    ...(attachments?.downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs: attachments.downloadTimeoutMs }),
    ...(transcription === undefined ? {} : { transcription }),
  };
}

/**
 * The chat allowlist is the only authorization boundary: a forum topic is
 * reachable exactly when its chat is allowlisted, and a topic id never
 * authorizes anything on its own.
 */
function isAllowedTelegramChat(
  target: TelegramDestinationTarget,
  input: ChannelStartInput<TelegramAdapterConfig>,
): boolean {
  return input.config.allowAllChats || input.config.allowedChatIds.includes(String(target.chatId));
}

/**
 * The adapter-facing destination: a bare chat id for the chat's main
 * conversation (so custom starters typed for chat ids keep working) and an
 * explicit chat + topic target for a forum topic.
 */
function adapterDestination(target: TelegramDestinationTarget): TelegramDestination {
  return target.messageThreadId === undefined
    ? target.chatId
    : { chatId: target.chatId, messageThreadId: target.messageThreadId };
}

function requireAllowedTelegramTarget(
  conversationId: string,
  input: ChannelStartInput<TelegramAdapterConfig>,
): TelegramDestination {
  const target = telegramTargetFromConversation(conversationId);
  if (target === undefined) {
    throw new Error(`unparseable telegram destination: ${conversationId}`);
  }
  if (!isAllowedTelegramChat(target, input)) {
    throw new Error("telegram chat is not in the adapter allowlist.");
  }
  return adapterDestination(target);
}

/**
 * Extract the Telegram chat id from a `telegram:<chat>` or forum-topic
 * `telegram:<chat>:<topic>` conversation id. Malformed ids return undefined.
 */
export function telegramChatIdFromConversation(conversationId: string): TelegramChatId | undefined {
  return telegramTargetFromConversation(conversationId)?.chatId;
}

function telegramStartOptions(
  input: ChannelStartInput<TelegramAdapterConfig>,
  overrides: TelegramChannelOverrides,
  topicDirectory?: TelegramTopicDirectoryStore,
): TelegramAdapterStartOptions {
  const runtimeControls: TelegramRuntimeControls = buildChannelRuntimeControls(input.coreConfig);
  const resetter = input.responder as typeof input.responder & {
    startNewSession?: (conversationId: string) => Promise<void>;
  };
  let pollingDegraded = false;
  return {
    botToken: input.config.botToken,
    allowedChatIds: [...input.config.allowedChatIds],
    allowAllChats: input.config.allowAllChats,
    groupMode: input.config.groupMode ?? "any",
    stripMentionText: input.config.stripMentionText ?? true,
    ...(input.config.topics === undefined ? {} : { topics: input.config.topics }),
    responder: input.responder,
    allowedUpdates: ["message", "callback_query"],
    runtimeControls,
    deleteWebhookOnStart: true,
    stream: {
      initialStatusText: "Agent is thinking...",
      editDebounceMs: 350,
      maxSendRetries: 3,
      retryCapMs: 60_000,
      formatMarkdown: true,
    },
    messages: {
      welcomeText: "Agent is online. Send a message to run the configured runtime.",
      helpText: "Send a message to talk to the agent. Use /new for a fresh conversation, /model and /effort for this chat or topic, or /cancel to stop an in-flight response.",
      unauthorizedText: "This chat is not allowlisted for this agent.",
      errorText: telegramErrorText,
    },
    onPollingError: (error) => {
      if (pollingDegraded) return;
      pollingDegraded = true;
      input.onDegraded?.(error instanceof Error ? error.message : String(error));
    },
    onPollingRecovered: () => {
      if (!pollingDegraded) return;
      pollingDegraded = false;
      input.onRecovered?.();
    },
    ...(input.config.apiRoot === undefined ? {} : { apiRoot: input.config.apiRoot }),
    ...(telegramAttachmentOptions(input.config) === undefined
      ? {}
      : { attachments: telegramAttachmentOptions(input.config)! }),
    ...(input.interaction === undefined
      ? {}
      : {
          pendingAsks: {
            getPendingAsk: (conversationId: string) => input.interaction!.getPendingAsk(conversationId),
            submitAskAnswers: (submission) => input.interaction!.submitAskAnswers(submission),
            cancel: (conversationId: string) => {
              input.interaction!.cancelAsks(conversationId);
            },
          },
        }),
    ...(resetter.startNewSession === undefined
      ? {}
      : { startNewSession: (conversationId: string) => resetter.startNewSession!(conversationId) }),
    ...(input.config.ipFamily === undefined ? {} : { transport: { ipFamily: input.config.ipFamily } }),
    ...(input.config.pollWatchdogMs === undefined ? {} : { pollWatchdogMs: input.config.pollWatchdogMs }),
    ...(input.config.commands === undefined ? {} : { commands: [...input.config.commands] }),
    ...(input.config.reactions === undefined ? {} : { reactions: input.config.reactions }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(topicDirectory === undefined
      ? {}
      : {
          knownTopicNames: topicDirectory.knownTopicNames(),
          onChatObserved: (observation) => topicDirectory.observe(observation),
        }),
    ...(overrides.botFactory === undefined ? {} : { botFactory: overrides.botFactory }),
    ...(overrides.runnerFactory === undefined ? {} : { runnerFactory: overrides.runnerFactory }),
  };
}

function telegramErrorText(input: TelegramAdapterErrorTextInput): string {
  const failure = failureFromUnknown(input.error);
  if (failure?.kind !== undefined) {
    const description = describeRunFailureKind({ failureKind: failure.kind });
    if (description.known || failure.message === undefined || failure.message.trim().length === 0) {
      const explanation = failure.kind === "usage_limit"
        ? usageLimitExplanation(description.explanation, failure.details)
        : description.explanation;
      return `${explanation} ${description.nextStep}`;
    }
  }
  if (failure?.message !== undefined && failure.message.trim().length > 0) {
    return `I could not complete that message: ${failure.message}`;
  }
  return "I could not complete that message. Check the local artifact summary for details.";
}

function usageLimitExplanation(explanation: string, details: unknown): string {
  const maxTurns = nestedNumber(details, ["diagnostics", "max_turns"]);
  return maxTurns === undefined ? explanation : `${explanation} Configured turn cap: ${maxTurns} turns.`;
}

function failureFromUnknown(error: unknown): {
  readonly kind?: string;
  readonly message?: string;
  readonly details?: unknown;
} | undefined {
  if (!isRecord(error) || !isRecord(error.failure)) {
    return undefined;
  }
  const failure = error.failure;
  return {
    ...(typeof failure.kind === "string" ? { kind: failure.kind } : {}),
    ...(typeof failure.message === "string" ? { message: failure.message } : {}),
    ...(Object.prototype.hasOwnProperty.call(failure, "details") ? { details: failure.details } : {}),
  };
}

function nestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
