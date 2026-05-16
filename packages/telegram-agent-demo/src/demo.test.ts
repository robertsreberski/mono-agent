import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@worklab-ai/runtime-adapter";
import type { TelegramBotApi, TelegramLongPollerOptions, TelegramLongPollerStartOptions } from "@worklab-ai/telegram-bridge";

import { createTelegramAgentDemo } from "./index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "telegram-demo-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function envFor(dir: string): Record<string, string | undefined> {
  return {
    MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456:secret-token",
    MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS: "42",
    MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
    MONO_AGENT_IDENTITY_PATH: join(dir, "IDENTITY.md"),
    MONO_AGENT_ARTIFACT_DIR: join(dir, "artifacts"),
  };
}

const fakeApi: TelegramBotApi = {
  async sendMessage(params) {
    return { message_id: 1, chat: { id: params.chat_id }, text: params.text };
  },
  async editMessageText(params) {
    return { message_id: params.message_id ?? 1, chat: { id: params.chat_id ?? 42 }, text: params.text };
  },
  async getUpdates() {
    return [];
  },
  async deleteWebhook() {
    return true;
  },
};

function fakeRuntime() {
  return {
    calls: [] as Array<{ prompt: string; options: RuntimeRunOptions }>,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        thisCalls.push({ prompt, options });
        return { text: "ok" };
      },
    },
  };
}

const thisCalls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];

describe("telegram agent demo", () => {
  it("fails closed when required env is missing", async () => {
    await expect(createTelegramAgentDemo({ env: {}, cwd: "/repo", api: fakeApi })).rejects.toThrow(/MONO_AGENT_TELEGRAM_BOT_TOKEN/u);
  });

  it("composes config, real bridge, injected runtime/API, and redacted diagnostics", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono.", "utf8");
    const started: TelegramLongPollerStartOptions[] = [];
    let pollerOptions: TelegramLongPollerOptions | undefined;
    const runtime = fakeRuntime();

    const demo = await createTelegramAgentDemo({
      env: envFor(dir),
      cwd: dir,
      api: fakeApi,
      runtime: runtime.runtime,
      pollerFactory: (options) => {
        pollerOptions = options;
        return {
          async start(startOptions = {}) {
            started.push(startOptions);
          },
        };
      },
    });

    expect(JSON.stringify(demo.config)).not.toContain("secret-token");
    expect(demo.config.telegram.allowedChatIds).toEqual({ count: 1 });
    expect(pollerOptions).toMatchObject({ deleteWebhookOnStart: true, allowedUpdates: ["message"] });
    const controller = new AbortController();
    await demo.start({ signal: controller.signal });
    expect(started).toHaveLength(1);
    expect(started[0]?.signal).toBe(controller.signal);
  });

  it("keeps the demo host thin by letting the bridge drive the harness path", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "IDENTITY.md"), "You are Mono.", "utf8");
    thisCalls.splice(0);

    const demo = await createTelegramAgentDemo({
      env: { ...envFor(dir), MONO_AGENT_MCP_CONFIG_PATH: join(dir, "mcp.json") },
      cwd: dir,
      api: fakeApi,
      runtime: fakeRuntime().runtime,
      pollerFactory: () => ({ start: async () => undefined }),
    });

    const result = await demo.bridge.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 42, type: "private" },
        from: { id: 99, username: "tester" },
        text: "Hello",
      },
    });

    expect(result).toMatchObject({ kind: "handled", action: "responded" });
    expect(thisCalls).toHaveLength(1);
    expect(thisCalls[0]?.prompt).toContain("You are Mono.");
    expect(thisCalls[0]?.options.allowedTools).toEqual([]);
    expect(thisCalls[0]?.options.mcpConfigPath).toBe(join(dir, "mcp.json"));
  });
});
