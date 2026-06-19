import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      endpoints: [{ name: "default", path: "/json", mode: "sync", enabled: true }],
    });
  });

  it("defaults to a single /webhook/invoke endpoint when nothing is configured", async () => {
    const config = await loadWebhookAdapterConfig({ env: {} });
    expect(config.endpoints).toEqual([{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }]);
    expect(config.path).toBe("/webhook/invoke");
  });

  it("loads multiple endpoints from webhook.endpoints, mirroring the first as path/defaultMode", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        webhook: {
          enabled: true,
          port: 4310,
          defaultMode: "sync",
          endpoints: [
            { name: "invoke", path: "/webhook/invoke" },
            { path: "/webhook/research-result", mode: "async", prompt: "Match the incoming result to a request." },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path });
    expect(config.endpoints).toEqual([
      { name: "invoke", path: "/webhook/invoke", mode: "sync", enabled: true },
      {
        name: "research-result",
        path: "/webhook/research-result",
        mode: "async",
        enabled: true,
        prompt: "Match the incoming result to a request.",
      },
    ]);
    expect(config.path).toBe("/webhook/invoke");
    expect(config.defaultMode).toBe("sync");
  });

  it("reads endpoints from MONO_AGENT_WEBHOOK_ENDPOINTS_JSON", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([{ name: "hook", path: "/hook", mode: "async" }]),
      },
    });
    expect(config.endpoints).toEqual([{ name: "hook", path: "/hook", mode: "async", enabled: true }]);
  });

  it("synthesizes the legacy single endpoint with a prompt from webhook.prompt", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ webhook: { enabled: true, path: "/hook", prompt: "Do the thing." } })}\n`,
      "utf8",
    );
    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path });
    expect(config.endpoints).toEqual([
      { name: "default", path: "/hook", mode: "sync", enabled: true, prompt: "Do the thing." },
    ]);
  });

  it("merges webhook.endpoints with webhook/*.md files", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ webhook: { enabled: true, port: 4310, endpoints: [{ name: "invoke", path: "/webhook/invoke" }] } })}\n`,
      "utf8",
    );
    const webhookDir = join(dir, "webhook");
    await mkdir(webhookDir);
    await writeFile(
      join(webhookDir, "deep-research.md"),
      "---\npath: /webhook/deep-research\nmode: async\n---\nMatch the request and file it.",
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path, cwd: dir });
    expect(config.endpoints.map((endpoint) => endpoint.name)).toEqual(["invoke", "deep-research"]);
    expect(config.endpoints[1]).toMatchObject({
      path: "/webhook/deep-research",
      mode: "async",
      prompt: "Match the request and file it.",
    });
  });

  it("rejects two endpoints with the same path", async () => {
    await expect(
      loadWebhookAdapterConfig({
        env: {
          MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([
            { name: "a", path: "/dup" },
            { name: "b", path: "/dup" },
          ]),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactWebhookAdapterConfig", () => {
  it("returns public webhook settings without secrets", () => {
    const config = {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      defaultMode: "async" as const,
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "async" as const, enabled: true }],
    };
    const redacted = redactWebhookAdapterConfig(config);
    expect(redacted).toEqual(config);
    // Endpoints are deep-cloned so callers cannot mutate the source array.
    expect(redacted.endpoints).not.toBe(config.endpoints);
  });
});

describe("webhookFieldGroup", () => {
  it("declares webhook settings for operator surfaces", () => {
    expect(webhookFieldGroup.id).toBe("webhook");
    expect(webhookFieldGroup.fields.find((field) => field.id === "webhook.enabled")?.kind).toBe("switch");
    expect(webhookFieldGroup.fields.find((field) => field.id === "webhook.defaultMode")?.kind).toBe("select");
  });
});
