import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWebhookAdapterConfig,
  redactWebhookAdapterConfig,
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
          apiKey: "json-fixture-key",
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
        MONO_AGENT_WEBHOOK_API_KEY: "env-fixture-key",
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
      apiKey: "env-fixture-key",
      defaultMode: "sync",
      retentionMs: 1000,
      maxStoredRequests: 10,
      endpoints: [{ name: "default", path: "/json", mode: "sync", enabled: true }],
    });
  });

  it("treats JSON apiKey strings literally and only uses the documented env override", async () => {
    const pseudoReference = "env:MONO_AGENT_WEBHOOK_API_KEY";
    const json = {
      webhook: {
        enabled: true,
        host: "127.0.0.1",
        apiKey: pseudoReference,
      },
    };

    const jsonOnly = await loadWebhookAdapterConfig({ env: {}, json });
    expect(jsonOnly.apiKey).toBe(pseudoReference);

    const withEnvOverride = await loadWebhookAdapterConfig({
      env: { MONO_AGENT_WEBHOOK_API_KEY: "actual-env-key" },
      json,
    });
    expect(withEnvOverride.apiKey).toBe("actual-env-key");
  });

  it("defaults to a single /webhook/invoke endpoint when nothing is configured", async () => {
    const config = await loadWebhookAdapterConfig({ env: {} });
    expect(config.endpoints).toEqual([{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }]);
    expect(config.path).toBe("/webhook/invoke");
  });

  it("parses webhook.maxRunMs (and omits it when unset)", async () => {
    const unset = await loadWebhookAdapterConfig({ env: {} });
    expect(unset.maxRunMs).toBeUndefined();

    const config = await loadWebhookAdapterConfig({
      env: { MONO_AGENT_WEBHOOK_MAX_RUN_MS: "600000" },
    });
    expect(config.maxRunMs).toBe(600000);
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
            {
              path: "/webhook/research-result",
              mode: "async",
              prompt: "Match the incoming result to a request.",
              notify: true,
              notifyConversationId: "telegram:42",
              model: "claude:claude-opus-4-8",
              effort: "high",
              maxRunMs: 45_000,
            },
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
        notify: true,
        notifyConversationId: "telegram:42",
        model: "claude:claude-opus-4-8",
        effort: "high",
        maxRunMs: 45_000,
      },
    ]);
    expect(config.path).toBe("/webhook/invoke");
    expect(config.defaultMode).toBe("sync");
  });

  it("reads endpoints from MONO_AGENT_WEBHOOK_ENDPOINTS_JSON", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([
          {
            name: "hook",
            path: "/hook",
            mode: "async",
            notify: true,
            notifyConversationId: "slack:C1",
            maxRunMs: 0,
          },
        ]),
      },
    });
    expect(config.endpoints).toEqual([
      {
        name: "hook",
        path: "/hook",
        mode: "async",
        enabled: true,
        notify: true,
        notifyConversationId: "slack:C1",
        maxRunMs: 0,
      },
    ]);
  });

  it.each([-1, 1.5, 86_400_001, "1000"])(
    "rejects invalid per-endpoint maxRunMs value %j",
    async (maxRunMs) => {
      await expect(loadWebhookAdapterConfig({
        env: {
          MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([{ path: "/hook", maxRunMs }]),
        },
      })).rejects.toThrow(/webhook\.endpoints\[\]\.maxRunMs/u);
    },
  );

  it("loads native notification fields for the legacy single endpoint from env", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_PATH: "/hook",
        MONO_AGENT_WEBHOOK_PROMPT: "Summarize the payload.",
        MONO_AGENT_WEBHOOK_NOTIFY: "true",
        MONO_AGENT_WEBHOOK_NOTIFY_CONVERSATION_ID: "telegram:42",
      },
    });
    expect(config.endpoints).toEqual([
      {
        name: "default",
        path: "/hook",
        mode: "sync",
        enabled: true,
        prompt: "Summarize the payload.",
        notify: true,
        notifyConversationId: "telegram:42",
      },
    ]);
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
      "---\npath: /webhook/deep-research\nmode: async\nnotify: true\nnotifyConversationId: telegram:42\n---\nMatch the request and file it.",
      "utf8",
    );

    const config = await loadWebhookAdapterConfig({ env: {}, jsonPath: path, cwd: dir });
    expect(config.endpoints.map((endpoint) => endpoint.name)).toEqual(["invoke", "deep-research"]);
    expect(config.endpoints[1]).toMatchObject({
      path: "/webhook/deep-research",
      mode: "async",
      prompt: "Match the request and file it.",
      notify: true,
      notifyConversationId: "telegram:42",
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

  it("accepts an enabled non-loopback bind only with explicit consent and an API key", async () => {
    const config = await loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_HOST: "0.0.0.0",
        MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK: "true",
        MONO_AGENT_WEBHOOK_API_KEY: "fixture-key",
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      host: "0.0.0.0",
      allowNonLoopback: true,
      apiKey: "fixture-key",
    });
  });

  it("fails closed when an enabled non-loopback bind has no API key", async () => {
    await expect(loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_HOST: "0.0.0.0",
        MONO_AGENT_WEBHOOK_ALLOW_NON_LOOPBACK: "true",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("fails closed when an enabled non-loopback bind has no explicit consent", async () => {
    await expect(loadWebhookAdapterConfig({
      env: {
        MONO_AGENT_WEBHOOK_ENABLED: "true",
        MONO_AGENT_WEBHOOK_HOST: "0.0.0.0",
        MONO_AGENT_WEBHOOK_API_KEY: "fixture-key",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });
  /**
   * An endpoint's name and path are its IDENTITY: the name keys `summary.invokeUrls` and the
   * path is the value (`http://host:port<path>`), and that map is logged on every channel
   * start and rendered by `mono-agent status`. Both were accepted at any length and with any
   * code point, so one config field wrote a megabyte into a durable operator surface -- and a
   * newline in either forged a line inside it.
   */
  describe("endpoint identity is bounded printable text", () => {
    const endpointsJson = (endpoint: Record<string, unknown>): Record<string, string> => ({
      MONO_AGENT_WEBHOOK_ENDPOINTS_JSON: JSON.stringify([endpoint]),
    });

    it("rejects an endpoint name longer than one filesystem name", async () => {
      const name = "n".repeat(1_000_000);
      await expect(
        loadWebhookAdapterConfig({ env: endpointsJson({ path: "/hook", name }) }),
      ).rejects.toThrow(/name is 1000000 bytes/u);
    });

    it("rejects an endpoint path longer than one filesystem name", async () => {
      const path = `/${"p".repeat(1_000_000)}`;
      await expect(
        loadWebhookAdapterConfig({ env: endpointsJson({ path }) }),
      ).rejects.toThrow(/path from config is 1000001 bytes/u);
    });

    it("never quotes the oversized value back inside the rejection", async () => {
      const name = "n".repeat(1_000_000);
      const error = await loadWebhookAdapterConfig({ env: endpointsJson({ path: "/hook", name }) })
        .then(() => undefined, (thrown: unknown) => thrown as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message.length).toBeLessThan(300);
      expect(error!.message).not.toContain("nnnn");
    });

    it("rejects a newline in an endpoint name so the summary stays one line per fact", async () => {
      const name = `hook${String.fromCharCode(10)}[ok] Core config: everything fine`;
      await expect(
        loadWebhookAdapterConfig({ env: endpointsJson({ path: "/hook", name }) }),
      ).rejects.toThrow(/single line/u);
    });

    it("accepts a name and a path at the bound", async () => {
      const name = "n".repeat(255);
      const path = `/${"p".repeat(254)}`;
      const config = await loadWebhookAdapterConfig({ env: endpointsJson({ path, name }) });
      expect(config.endpoints[0]?.name).toBe(name);
      expect(config.endpoints[0]?.path).toBe(path);
    });

    it("still rejects an oversized name derived from a folder endpoint", async () => {
      const webhookDir = join(dir, "webhook");
      await mkdir(webhookDir, { recursive: true });
      await writeFile(
        join(webhookDir, "hook.md"),
        `---\npath: /hook\nname: ${"n".repeat(1_000_000)}\n---\nbody\n`,
        "utf8",
      );
      await expect(
        loadWebhookAdapterConfig({ env: {}, cwd: dir }),
      ).rejects.toThrow(/name is 1000000 bytes/u);
    });

    /**
     * One folder file reaches `mergeEndpoints`, whose identity assertion rejects it without
     * quoting it. TWO files sharing an oversized name never get there: the directory loader
     * has its own duplicate-name check that runs first and interpolates the whole name into
     * both the message and `details.name` -- so a config error emitted megabytes on a path the
     * single-file case looks like it covers. The identity bound has to be enforced where the
     * endpoint is first built, ahead of every duplicate check.
     */
    it("rejects two folder endpoints that share an oversized name without quoting it", async () => {
      const webhookDir = join(dir, "webhook");
      await mkdir(webhookDir, { recursive: true });
      const name = "n".repeat(1_000_000);
      await writeFile(join(webhookDir, "a.md"), `---\npath: /a\nname: ${name}\n---\nbody\n`, "utf8");
      await writeFile(join(webhookDir, "b.md"), `---\npath: /b\nname: ${name}\n---\nbody\n`, "utf8");

      const error = await loadWebhookAdapterConfig({ env: {}, cwd: dir })
        .then(() => undefined, (thrown: unknown) => thrown as Error & { details?: Record<string, unknown> });

      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(/name is 1000000 bytes/u);
      expect(error!.message.length).toBeLessThan(300);
      expect(error!.message).not.toContain("nnnn");
      for (const value of Object.values(error!.details ?? {})) {
        expect(typeof value === "string" ? value.length : 0).toBeLessThan(300);
      }
    });

    /** Same ordering rule for the path: a shared oversized path must not be quoted either. */
    it("rejects two folder endpoints that share an oversized path without quoting it", async () => {
      const webhookDir = join(dir, "webhook");
      await mkdir(webhookDir, { recursive: true });
      const path = `/${"p".repeat(1_000_000)}`;
      await writeFile(join(webhookDir, "a.md"), `---\npath: ${path}\nname: a\n---\nbody\n`, "utf8");
      await writeFile(join(webhookDir, "b.md"), `---\npath: ${path}\nname: b\n---\nbody\n`, "utf8");

      const error = await loadWebhookAdapterConfig({ env: {}, cwd: dir })
        .then(() => undefined, (thrown: unknown) => thrown as Error & { details?: Record<string, unknown> });

      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(/path from webhook folder is 1000001 bytes/u);
      expect(error!.message.length).toBeLessThan(300);
      expect(error!.message).not.toContain("pppp");
      for (const value of Object.values(error!.details ?? {})) {
        expect(typeof value === "string" ? value.length : 0).toBeLessThan(300);
      }
    });
  });
});

describe("redactWebhookAdapterConfig", () => {
  it("returns public webhook settings with the optional API key redacted", () => {
    const config = {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      apiKey: "fixture-redacted-value",
      defaultMode: "async" as const,
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "async" as const, enabled: true, maxRunMs: 0 }],
    };
    const redacted = redactWebhookAdapterConfig(config);
    expect(redacted).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      apiKey: { present: true, redacted: true },
      defaultMode: "async",
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "async", enabled: true, maxRunMs: 0 }],
    });
    expect(JSON.stringify(redacted)).not.toContain("fixture-redacted-value");
    // Endpoints are deep-cloned so callers cannot mutate the source array.
    expect(redacted.endpoints).not.toBe(config.endpoints);
  });

  it("reports an unset API key without inventing a secret", () => {
    expect(redactWebhookAdapterConfig({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      path: "/webhook/invoke",
      allowNonLoopback: false,
      defaultMode: "sync",
      retentionMs: 60_000,
      maxStoredRequests: 100,
      endpoints: [{ name: "default", path: "/webhook/invoke", mode: "sync", enabled: true }],
    }).apiKey).toEqual({ present: false, redacted: true });
  });
});
