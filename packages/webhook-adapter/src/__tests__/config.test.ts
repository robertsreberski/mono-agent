import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWebhookAdapterConfig,
  redactWebhookAdapterConfig,
  webhookFieldGroup,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-webhook-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadWebhookAdapterConfig", () => {
  it("loads adapter-owned webhook settings from JSON and env overrides", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        webhook: {
          enabled: true,
          host: "127.0.0.1",
          port: 4111,
          path: "/json",
          defaultMode: "async",
          retentionMs: 1000,
          maxStoredRequests: 10,
        },
      })}\n`,
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_PORT: "4222",
        MONO_AGENT_WEBHOOK_DEFAULT_MODE: "sync",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4222,
      path: "/json",
      allowNonLoopback: false,
      defaultMode: "sync",
      retentionMs: 1000,
      maxStoredRequests: 10,
    });
  });
});

describe("redactWebhookAdapterConfig", () => {
  it("returns public webhook settings without secrets", () => {
    expect(redactWebhookAdapterConfig({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      defaultMode: "async",
      retentionMs: 60_000,
      maxStoredRequests: 100,
    })).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      defaultMode: "async",
      retentionMs: 60_000,
      maxStoredRequests: 100,
    });
  });
});

describe("webhookFieldGroup", () => {
  it("declares webhook settings for operator surfaces", () => {
    expect(webhookFieldGroup.id).toBe("webhook");
    expect(webhookFieldGroup.fields.find((field) => field.id === "webhook.enabled")?.kind).toBe("switch");
    expect(webhookFieldGroup.fields.find((field) => field.id === "webhook.defaultMode")?.kind).toBe("select");
  });
});
