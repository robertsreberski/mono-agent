import type {
  AdapterSendToolsSettings,
  AdapterSendToolsHttpOptions,
  AdapterSendToolsClients,
  SlackAdapterModule,
  TelegramAdapterModule,
} from "./types.js";

// Lazy per module (mirrors channels.ts): a config without slack/telegram
// send-tool policy never pulls either SDK in.
let slackModule: SlackAdapterModule | undefined;
let telegramModule: TelegramAdapterModule | undefined;
export const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/channel-slack"));
export const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/channel-telegram"));

export async function createAdapterSendToolsClients(
  settings: AdapterSendToolsSettings,
  options: AdapterSendToolsHttpOptions = {},
): Promise<AdapterSendToolsClients> {
  const slack =
    settings.slack === undefined
      ? undefined
      : new (await loadSlackModule()).SlackWebApiClient({
          botToken: settings.slack.botToken,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
  const telegram =
    settings.telegram === undefined
      ? undefined
      : (await loadTelegramModule()).createTelegramMessageSender(settings.telegram.botToken, {
          ...(settings.telegram.apiRoot === undefined ? {} : { apiRoot: settings.telegram.apiRoot }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
  };
}

export function normalizeSlackChannelId(value: string): string {
  return value.trim().toLowerCase();
}
