import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelStartInput } from "@mono-agent/agent-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "../adapter.js";
import { createChannelDriver, createMessengerChannelDriver } from "../channel-driver.js";
import { MessengerAdapterConfigError, type MessengerAdapterConfig } from "../config.js";
import { createChannelDriver as createChannelDriverFromIndex } from "../index.js";
import type { MessengerAdapterStartResult, StartMessengerAdapterOptions } from "../start.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-messenger-channel-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const secrets = {
  MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN: "page-token",
  MONO_AGENT_MESSENGER_APP_SECRET: "app-secret",
  MONO_AGENT_MESSENGER_VERIFY_TOKEN: "verify-token",
};

function configInput(env: Record<string, string | undefined> = {}): { env: Record<string, string | undefined>; cwd: string; configPath: string } {
  return { env, cwd: dir, configPath: join(dir, "mono-agent.config.json") };
}

function fakeStartResult(): MessengerAdapterStartResult & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => ({ delivered: true, code: "delivered", channelId: "messenger" }));
  return {
    adapter: {} as MessengerAdapterStartResult["adapter"],
    host: "127.0.0.1",
    port: 8650,
    webhookPath: "/messenger/webhook",
    stop: async () => undefined,
    notify,
    updateProcessJob: async () => ({ delivered: true }),
  };
}

function responder(): AgentResponder {
  return { respond: async () => ({ text: "ok" }) };
}

describe("createMessengerChannelDriver", () => {
  it("uses the default id/label, declares its conversation scheme, and honors overrides", () => {
    const driver = createMessengerChannelDriver();
    expect(driver.id).toBe("messenger");
    expect(driver.label).toBe("Facebook Messenger");
    expect(driver.processJobs).toEqual({ conversationScheme: "messenger" });
    expect(createMessengerChannelDriver({ id: "fb", label: "FB" })).toMatchObject({ id: "fb", label: "FB" });
    expect(createChannelDriverFromIndex().id).toBe("messenger");
    expect(createChannelDriver).toBe(createMessengerChannelDriver);
  });

  it("loads inline plugin config and reports disabled without validating secrets", async () => {
    const driver = createMessengerChannelDriver({ config: { enabled: false } });
    const config = await driver.loadConfig(configInput());
    expect(config.enabled).toBe(false);
    expect(driver.disabledReason?.(config)).toBe("Messenger is disabled.");
  });

  it("treats an incomplete enabled config as its own typed config error", async () => {
    const driver = createMessengerChannelDriver({ config: { enabled: true, allowedUserIds: ["1"] } });
    const error = await driver.loadConfig(configInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MessengerAdapterConfigError);
    expect(driver.isConfigError(error)).toBe(true);
  });

  it("rejects malformed inline config values", async () => {
    const driver = createMessengerChannelDriver({ config: { enabled: "yes" } });
    await expect(driver.loadConfig(configInput())).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("loads from the config file's messenger section when no inline config is given", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, `${JSON.stringify({ messenger: { enabled: true, allowedUserIds: ["42"] } })}\n`, "utf8");
    const driver = createMessengerChannelDriver();
    const config = await driver.loadConfig(configInput(secrets));
    expect(config).toMatchObject({ enabled: true, allowedUserIds: ["42"], pageAccessToken: "page-token" });
    const view = await driver.configView?.(configInput(secrets));
    expect(view?.status).toBe("active");
    expect(view?.fields.find((field) => field.id === "messenger.pageAccessToken")).toMatchObject({ value: "set", redacted: true, source: "env" });
  });

  it("starts the adapter and routes proactive notifications through the allowlist", async () => {
    const started = fakeStartResult();
    const startAdapter = vi.fn(async (_options: StartMessengerAdapterOptions) => started);
    const driver = createMessengerChannelDriver({ config: { enabled: true, allowedUserIds: ["42"] }, startAdapter });
    const config = await driver.loadConfig(configInput(secrets));
    const running = await driver.start({
      config,
      coreConfig: {},
      responder: responder(),
      cwd: dir,
      onFailure: vi.fn(),
    } as unknown as ChannelStartInput<MessengerAdapterConfig>);

    expect(startAdapter).toHaveBeenCalledTimes(1);
    expect(running.summary).toMatchObject({ port: 8650, path: "/messenger/webhook" });

    const delivered = await running.notify?.({ conversationId: "messenger:42", text: "hi", verbatim: true, deliveryKey: "k" });
    expect(delivered).toMatchObject({ delivered: true });
    expect(started.notify).toHaveBeenCalledWith("42", "hi", { verbatim: true, deliveryKey: "k" });

    const denied = await running.notify?.({ conversationId: "messenger:7", text: "hi" });
    expect(denied).toMatchObject({ delivered: false });
    const unparseable = await running.notify?.({ conversationId: "telegram:42", text: "hi" });
    expect(unparseable).toMatchObject({ delivered: false });
  });
});
