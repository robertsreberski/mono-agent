import { resolve } from "node:path";

import type { ChannelDriver } from "@mono-agent/agent-contracts";
import type { SettingsJsonValue } from "@mono-agent/agent-contracts";

import {
  loadWhatsAppAdapterConfig,
  WhatsAppAdapterConfigError,
  type WhatsAppAdapterConfig,
} from "./config.js";
import {
  startWhatsAppAdapter,
  type StartWhatsAppAdapterOptions,
  type WhatsAppAdapterStartResult,
  type WhatsAppSocketFactory,
} from "./start.js";

export type WhatsAppChannelDriverConfig = {
  readonly [key: string]: SettingsJsonValue;
};

export interface WhatsAppChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: WhatsAppChannelDriverConfig;
  readonly authDir?: string;
  readonly socketFactory?: WhatsAppSocketFactory;
  readonly startAdapter?: (
    options: StartWhatsAppAdapterOptions,
  ) => Promise<WhatsAppAdapterStartResult>;
}

export function createWhatsAppChannelDriver(
  options: WhatsAppChannelDriverOptions = {},
): ChannelDriver<WhatsAppAdapterConfig> {
  return {
    id: options.id ?? "whatsapp",
    label: options.label ?? "WhatsApp",
    async loadConfig(input) {
      if (options.config !== undefined) {
        return await loadWhatsAppAdapterConfig({
          env: input.env,
          json: { whatsapp: options.config },
        });
      }
      return await loadWhatsAppAdapterConfig({
        env: input.env,
        jsonPath: input.configPath,
      });
    },
    isConfigError(error) {
      return error instanceof WhatsAppAdapterConfigError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "WhatsApp is disabled.";
    },
    async start(input) {
      const startAdapter = options.startAdapter ?? startWhatsAppAdapter;
      const result = await startAdapter({
        authDir: options.authDir ?? resolve(input.cwd, ".mono-agent", "whatsapp-auth"),
        config: input.config,
        responder: input.responder,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        onQr: (qr) => {
          input.logger?.info?.("WhatsApp login QR code received; scan it with the WhatsApp app.", { qr });
        },
        ...(options.socketFactory === undefined ? {} : { createSocket: options.socketFactory }),
      });
      return {
        summary: {},
        stop: () => result.stop(),
      };
    },
  };
}

export const createChannelDriver = createWhatsAppChannelDriver;
