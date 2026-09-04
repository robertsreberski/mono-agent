import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MessengerAdapterConfigError,
  loadMessengerAdapterConfig,
  redactMessengerAdapterConfig,
} from "../config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-messenger-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const secrets = {
  MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN: "page-token",
  MONO_AGENT_MESSENGER_APP_SECRET: "app-secret",
  MONO_AGENT_MESSENGER_VERIFY_TOKEN: "verify-token",
};

describe("loadMessengerAdapterConfig", () => {
  it("returns a disabled config without validating secrets or the allowlist", async () => {
    const config = await loadMessengerAdapterConfig({ env: {} });
    expect(config.enabled).toBe(false);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8650);
    expect(config.webhookPath).toBe("/messenger/webhook");
    expect(config.apiVersion).toBe("v21.0");
    expect(config.proactiveMessagingType).toBe("RESPONSE");
  });

  it("loads adapter-owned settings from the JSON section and layers env on top", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, `${JSON.stringify({
      messenger: {
        enabled: true,
        allowedUserIds: ["123", "456"],
        host: "0.0.0.0",
        port: 18789,
        allowNonLoopback: true,
        webhookPath: "messenger/webhook/",
        apiVersion: "21.0",
      },
    })}\n`, "utf8");

    const config = await loadMessengerAdapterConfig({
      env: { ...secrets, MONO_AGENT_MESSENGER_PORT: "9999" },
      jsonPath: path,
    });
    expect(config.enabled).toBe(true);
    expect(config.allowedUserIds).toEqual(["123", "456"]);
    expect(config.port).toBe(9999);
    expect(config.host).toBe("0.0.0.0");
    expect(config.webhookPath).toBe("/messenger/webhook");
    expect(config.apiVersion).toBe("v21.0");
    expect(config.pageAccessToken).toBe("page-token");
  });

  it("requires every secret when enabled", async () => {
    await expect(loadMessengerAdapterConfig({
      env: { MONO_AGENT_MESSENGER_ENABLED: "true", MONO_AGENT_MESSENGER_ALLOWED_USER_IDS: "1" },
    })).rejects.toMatchObject({ code: "missing_required_config", details: { env: "MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN" } });
  });

  it("requires an allowlist or allow-all when enabled", async () => {
    await expect(loadMessengerAdapterConfig({
      env: { ...secrets, MONO_AGENT_MESSENGER_ENABLED: "true" },
    })).rejects.toBeInstanceOf(MessengerAdapterConfigError);
    const allowAll = await loadMessengerAdapterConfig({
      env: { ...secrets, MONO_AGENT_MESSENGER_ENABLED: "true", MONO_AGENT_MESSENGER_ALLOW_ALL_USERS: "true" },
    });
    expect(allowAll.allowAllUsers).toBe(true);
  });

  it("refuses a non-loopback bind without the explicit opt-in", async () => {
    await expect(loadMessengerAdapterConfig({
      env: { ...secrets, MONO_AGENT_MESSENGER_ENABLED: "true", MONO_AGENT_MESSENGER_ALLOWED_USER_IDS: "1", MONO_AGENT_MESSENGER_HOST: "0.0.0.0" },
    })).rejects.toMatchObject({ code: "invalid_config", details: { env: "MONO_AGENT_MESSENGER_HOST" } });
  });

  it("requires a tag for MESSAGE_TAG proactive deliveries and rejects unknown types", async () => {
    const base = { ...secrets, MONO_AGENT_MESSENGER_ENABLED: "true", MONO_AGENT_MESSENGER_ALLOWED_USER_IDS: "1" };
    await expect(loadMessengerAdapterConfig({
      env: { ...base, MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE: "MESSAGE_TAG" },
    })).rejects.toMatchObject({ details: { env: "MONO_AGENT_MESSENGER_PROACTIVE_TAG" } });
    await expect(loadMessengerAdapterConfig({
      env: { ...base, MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE: "SPAM" },
    })).rejects.toMatchObject({ code: "invalid_config" });
    const tagged = await loadMessengerAdapterConfig({
      env: { ...base, MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE: "MESSAGE_TAG", MONO_AGENT_MESSENGER_PROACTIVE_TAG: "CONFIRMED_EVENT_UPDATE" },
    });
    expect(tagged.proactiveTag).toBe("CONFIRMED_EVENT_UPDATE");
  });

  it("rejects malformed paths, versions, and ports", async () => {
    const base = { ...secrets, MONO_AGENT_MESSENGER_ENABLED: "true", MONO_AGENT_MESSENGER_ALLOWED_USER_IDS: "1" };
    await expect(loadMessengerAdapterConfig({ env: { ...base, MONO_AGENT_MESSENGER_WEBHOOK_PATH: "/" } })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadMessengerAdapterConfig({ env: { ...base, MONO_AGENT_MESSENGER_WEBHOOK_PATH: "/hook?x=1" } })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadMessengerAdapterConfig({ env: { ...base, MONO_AGENT_MESSENGER_API_VERSION: "latest" } })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadMessengerAdapterConfig({ env: { ...base, MONO_AGENT_MESSENGER_PORT: "70000" } })).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactMessengerAdapterConfig", () => {
  it("never exposes secret values", async () => {
    const config = await loadMessengerAdapterConfig({
      env: { ...secrets, MONO_AGENT_MESSENGER_ENABLED: "true", MONO_AGENT_MESSENGER_ALLOWED_USER_IDS: "1,2" },
    });
    const redacted = redactMessengerAdapterConfig(config);
    expect(redacted.pageAccessToken).toEqual({ present: true, redacted: true });
    expect(redacted.allowedUserIds).toEqual({ count: 2 });
    expect(JSON.stringify(redacted)).not.toContain("page-token");
  });
});
