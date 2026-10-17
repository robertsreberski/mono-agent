import type { ChannelDriverOverrides, ChannelDriver } from "./types.js";

import type { MonoAgentAppConfigInput } from "../composition/app-config.js";
import { createCronChannelDriver } from "./drivers/cron.js";
import type { CronChannelOverrides } from "./types.js";
import { createOpenAIApiChannelDriver } from "./drivers/openai-api.js";
import type { OpenAIApiChannelOverrides } from "./types.js";
import { createSlackChannelDriver, slackTargetFromConversation } from "./drivers/slack.js";
import type { SlackChannelOverrides } from "./types.js";
import { createTelegramChannelDriver, telegramChatIdFromConversation } from "./drivers/telegram.js";
import type { TelegramChannelOverrides } from "./types.js";
import { createTuiChannelDriver } from "./drivers/tui.js";
import { createWebhookChannelDriver } from "./drivers/webhook.js";
import type { WebhookChannelOverrides } from "./types.js";
import { resolveConfiguredChannelPlugins } from "./channel-plugins.js";
import { CronOperatorRegistry } from "../cron-operator-service.js";


/** Built-in channel ids in startup and status-display order. */
const BUILTIN_CHANNEL_IDS = [
  "telegram",
  "slack",
  "webhook",
  "openai-api",
  "cron",
  "tui",
] as const;

export {
  createCronChannelDriver,
  createOpenAIApiChannelDriver,
  createSlackChannelDriver,
  createTelegramChannelDriver,
  createTuiChannelDriver,
  createWebhookChannelDriver,
  slackTargetFromConversation,
  telegramChatIdFromConversation,
};
export type { CronChannelOverrides, OpenAIApiChannelOverrides, SlackChannelOverrides, TelegramChannelOverrides, WebhookChannelOverrides };

/** Every built-in channel driver, in startup/status display order. */
export function defaultChannelDrivers(overrides: ChannelDriverOverrides = {}): readonly ChannelDriver[] {
  const cronOperator = new CronOperatorRegistry();
  return [
    createTelegramChannelDriver(overrides.telegram),
    createSlackChannelDriver(overrides.slack),
    createWebhookChannelDriver(overrides.webhook),
    createOpenAIApiChannelDriver(overrides.openaiApi),
    createCronChannelDriver(overrides.cron, cronOperator),
    createTuiChannelDriver(overrides.tui, cronOperator),
  ] as readonly ChannelDriver[];
}

export async function resolveChannelDrivers(
  input: MonoAgentAppConfigInput,
  overrides: ChannelDriverOverrides = {},
): Promise<readonly ChannelDriver[]> {
  const drivers = [...defaultChannelDrivers(overrides)];
  const plugins = await resolveConfiguredChannelPlugins(input, {
    reservedIds: BUILTIN_CHANNEL_IDS,
    ...(overrides.pluginFactoryOptions === undefined
      ? {}
      : { factoryOptionsByPackage: overrides.pluginFactoryOptions }),
  });
  for (const plugin of plugins) {
    const existing = drivers.findIndex((driver) => driver.id === plugin.id);
    if (existing >= 0) {
      drivers[existing] = plugin;
    } else {
      drivers.push(plugin);
    }
  }
  return drivers;
}
