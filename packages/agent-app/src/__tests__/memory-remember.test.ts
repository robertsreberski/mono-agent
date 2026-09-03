import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { createBujoMemoryStore, dailyFilePath } from "@mono-agent/memory/bujo";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMemoryRememberRuntimeExtension,
  createMemoryRememberServer,
  isRememberCapableStore,
  isRememberToolAllowed,
  MEMORY_REMEMBER_MCP_SERVER_NAME,
  REMEMBER_TOOL_NAME,
  type RememberCapableStore,
} from "../memory-remember.js";

const FIXED = new Date("2026-09-03T10:00:00.000Z");
const stores: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (stores.length > 0) await stores.pop()!.close().catch(() => undefined);
});

function writableStore() {
  const dir = mkdtempSync(join(tmpdir(), "agent-app-remember-"));
  const store = createBujoMemoryStore({ root: dir, clock: () => FIXED });
  stores.push(store);
  return { dir, store: store as unknown as RememberCapableStore };
}

function dailyContent(dir: string): string {
  try {
    return readFileSync(dailyFilePath(dir, FIXED), "utf8");
  } catch {
    return "";
  }
}

async function callRemember(
  store: RememberCapableStore,
  text: string,
  env: Record<string, string | undefined> = {},
) {
  const server = createMemoryRememberServer(store, "conv-1", env);
  const client = new Client({ name: "remember-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const result = await client.callTool({ name: REMEMBER_TOOL_NAME, arguments: { text } });
    return { listed, result: result as { isError?: boolean; structuredContent?: Record<string, unknown> } };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function request(): AgentHarnessRuntimeOptionsInput {
  return {
    request: {
      conversationId: "web:thread-one",
      userMessage: "Remember something",
      abortSignal: new AbortController().signal,
    },
    runId: "run-one",
    context: {} as never,
  };
}

describe("isRememberToolAllowed", () => {
  it.each([
    REMEMBER_TOOL_NAME,
    `mcp__${MEMORY_REMEMBER_MCP_SERVER_NAME}__${REMEMBER_TOOL_NAME}`,
    `mcp__${MEMORY_REMEMBER_MCP_SERVER_NAME}__*`,
    "*",
  ])("accepts the supported policy spelling %s", (name) => {
    expect(isRememberToolAllowed({ allowedTools: [name], disallowedTools: [] })).toBe(true);
  });

  it("keeps deny and restrictive policies authoritative", () => {
    expect(isRememberToolAllowed({
      allowedTools: ["*"],
      disallowedTools: [REMEMBER_TOOL_NAME],
    })).toBe(false);
    expect(isRememberToolAllowed({ allowedTools: ["*"], disallowedTools: ["*"] })).toBe(false);
    expect(isRememberToolAllowed({ allowedTools: ["Read"], disallowedTools: [] })).toBe(false);
    expect(isRememberToolAllowed(undefined)).toBe(false);
  });
});

describe("isRememberCapableStore", () => {
  it("requires an affirmative capability, not just a remember method", () => {
    // A read-only store structurally HAS remember(); only the signal separates them.
    expect(isRememberCapableStore({ remember: async () => ({}), supportsRemember: () => false })).toBe(false);
    // The Supermemory shape: a MemoryStore with no durable write surface at all.
    expect(isRememberCapableStore({ appendHostSummary: async () => ({}) })).toBe(false);
    expect(isRememberCapableStore(undefined)).toBe(false);
    expect(isRememberCapableStore({ remember: async () => ({}), supportsRemember: () => true })).toBe(true);
  });
});

describe("Remember tool", () => {
  it("stores one normalized fact and reports what was actually written", async () => {
    const { dir, store } = writableStore();
    const { listed, result } = await callRemember(store, "  Robert   deploys\non Fridays.  ");

    expect(listed.tools.map((tool) => tool.name)).toEqual([REMEMBER_TOOL_NAME]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema: 1,
      storedText: "Robert deploys on Fridays.",
      duplicate: false,
      source: "daily/2026-09-03.md",
    });
    expect(dailyContent(dir)).toContain("Robert deploys on Fridays.");
  });

  it("reports an already-stored fact as a duplicate without appending again", async () => {
    const { dir, store } = writableStore();
    await callRemember(store, "Robert prefers squash merges.");
    const before = dailyContent(dir);
    const { result } = await callRemember(store, "Robert prefers squash merges.");

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ duplicate: true });
    expect(dailyContent(dir)).toBe(before);
  });

  it("surfaces a failed durable write as an error rather than a silent success", async () => {
    const failing: RememberCapableStore = {
      supportsRemember: () => true,
      remember: async () => { throw new Error("disk is full"); },
    };
    const { result } = await callRemember(failing, "A fact that cannot land.");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ stored: false });
  });

  it("rejects text that is too long once normalized, without writing", async () => {
    const { dir, store } = writableStore();
    const { result } = await callRemember(store, "x".repeat(501));
    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });
});

describe("Remember tool — credential rejection", () => {
  it.each([
    ["an OpenAI-shaped key", `sk-${"a".repeat(48)}`],
    ["a GitHub-shaped token", `ghp_${"b".repeat(36)}`],
    ["a Slack-shaped token", `xoxb-${"1".repeat(24)}`],
    ["a bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
    ["a Telegram-shaped bot token", `123456789:${"C".repeat(30)}`],
  ])("refuses to persist %s", async (_label, secret) => {
    const { dir, store } = writableStore();
    const { result } = await callRemember(store, `The deploy key is ${secret}`);

    expect(result.isError).toBe(true);
    // The point is non-persistence, not merely an error result.
    expect(dailyContent(dir)).toBe("");
    expect(await (store as never as { recall(q: string): Promise<unknown[]> }).recall(secret)).toHaveLength(0);
  });

  it("refuses to persist a configured credential value this agent actually holds", async () => {
    const { dir, store } = writableStore();
    const { result } = await callRemember(
      store,
      "The staging password is caller-only-secret-value.",
      { TEST_API_KEY: "caller-only-secret-value" },
    );

    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });

  it("refuses a payload that only becomes secret-shaped after NFKC normalization", async () => {
    // Fullwidth Latin letters are not `sk-` to a raw regex, but NFKC folds them
    // into ASCII. Checking the raw argument instead of the normalized stored
    // text would let this through and then persist a real credential.
    const { dir, store } = writableStore();
    const fullwidth = `ｓｋ－${"a".repeat(48)}`;
    expect(fullwidth.normalize("NFKC").startsWith("sk-")).toBe(true);

    const { result } = await callRemember(store, `The key is ${fullwidth}`);
    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });

  it("refuses a configured secret written with compatibility characters", async () => {
    const { dir, store } = writableStore();
    // Fullwidth digits normalize into the configured token's ASCII digits.
    const { result } = await callRemember(
      store,
      "The bot token is １２３４５６.",
      { SLACK_TOKEN: "123456" },
    );

    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });
});

describe("Remember runtime extension registration", () => {
  it("registers the loopback endpoint for a writable store", async () => {
    const { store } = writableStore();
    const extension = await createMemoryRememberRuntimeExtension(store)(request());
    try {
      const servers = extension.runtimeOptions?.mcpServers as Record<string, unknown> | undefined;
      expect(servers?.[MEMORY_REMEMBER_MCP_SERVER_NAME]).toBeDefined();
    } finally {
      await extension.cleanup?.();
    }
  });

  it.each([
    ["a read-only store", { remember: async () => ({}), supportsRemember: () => false }],
    ["a store with no remember surface", { appendHostSummary: async () => ({}) }],
  ])("registers nothing for %s", async (_label, store) => {
    const extension = await createMemoryRememberRuntimeExtension(store as never)(request());
    expect(extension.runtimeOptions).toEqual({});
    await extension.cleanup?.();
  });

  it("registers nothing for a real store opened read-only", async () => {
    const { dir, store } = writableStore();
    await store.remember("conv-1", "Seeded so the read-only open has canonical parity.");
    const readOnly = createBujoMemoryStore({ root: dir, readOnly: true, clock: () => FIXED });
    stores.push(readOnly);

    const extension = await createMemoryRememberRuntimeExtension(readOnly as never)(request());
    expect(extension.runtimeOptions).toEqual({});
    await extension.cleanup?.();
  });
});
