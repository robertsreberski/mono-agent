import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
    // Fullwidth Latin/digits normalize into the configured token's ASCII form.
    const { result } = await callRemember(
      store,
      "The bot token is ｚｔ９ｑ４ｗ７ｘ.",
      { SLACK_TOKEN: "zt9q4w7x" },
    );

    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });

  it("does not treat a credential NAME reference as a credential value", async () => {
    // `*_ENV` holds the name of a variable, never a secret, mirroring the
    // env/path carve-out that secretBearingPointer already applies.
    //
    // Deliberately narrow: `*_TOKENS` is NOT excluded any more, so a
    // credential-named budget such as ..._KEEP_RECENT_TOKENS=8000 does make the
    // literal 8000 unstorable. That false rejection is the accepted cost of not
    // weakening a guard the SELF-CONFIG proposal check also relies on.
    const { dir, store } = writableStore();
    const { result } = await callRemember(
      store,
      "The embeddings key is read from OPENAI_API_KEY at startup.",
      { MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "OPENAI_API_KEY" },
    );

    expect(result.isError).not.toBe(true);
    expect(dailyContent(dir)).toContain("read from OPENAI_API_KEY");
  });

  it("still rejects a short or numeric configured credential", async () => {
    // Raising the length floor or skipping numeric values to quiet false
    // positives would also widen what the SELF-CONFIG proposal guard accepts,
    // since both read this same helper.
    const { dir, store } = writableStore();
    const { result } = await callRemember(
      store,
      "The vault PIN is 90210 by the way.",
      { VAULT_PASSWORD: "90210" },
    );

    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });
});

describe("Remember tool — widened credential coverage", () => {
  it.each([
    ["a Slack app-level token", `xapp-${"a".repeat(24)}`],
    ["a GitHub fine-grained PAT", `github_pat_${"b".repeat(24)}`],
    ["an AWS access key id", `AKIA${"C".repeat(16)}`],
    ["a lowercase bearer credential", `bearer ${"d".repeat(24)}`],
  ])("refuses to persist %s", async (_label, secret) => {
    const { dir, store } = writableStore();
    const { result } = await callRemember(store, `The value is ${secret}`);
    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });

  it("still scans a credential-named variable whose name ends in _TOKENS", async () => {
    // A blanket `*_TOKENS` carve-out dropped real credential holders such as
    // SERVICE_API_TOKENS, and this helper also backs the SELF-CONFIG guard.
    const { dir, store } = writableStore();
    const { result } = await callRemember(
      store,
      "The service value is opaque-live-token-1 for now.",
      { SERVICE_API_TOKENS: "opaque-live-token-1" },
    );
    expect(result.isError).toBe(true);
    expect(dailyContent(dir)).toBe("");
  });

  it("stores an ordinary fact naming a run artifact", async () => {
    // The shared visible-text guard flags run-artifact filenames as private
    // evidence, which says nothing about credentials in a memory fact.
    const { dir, store } = writableStore();
    const { result } = await callRemember(store, "The release script writes build.summary.json at the end.");
    expect(result.isError).not.toBe(true);
    expect(dailyContent(dir)).toContain("build.summary.json");
  });

  it("reports a partial write as durable-but-unindexed instead of not stored", async () => {
    // Saying "not stored" after the canonical append already landed would invite
    // the model to reword and create a second memory for one fact.
    const partial: RememberCapableStore = {
      supportsRemember: () => true,
      remember: async () => {
        const error = new Error("index projection failed") as Error & { canonicalWritten?: boolean };
        error.canonicalWritten = true;
        throw error;
      },
    };
    const { result } = await callRemember(partial, "A fact whose index failed.");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ stored: true, indexed: false });
  });
});

describe("Remember runtime extension — production wiring", () => {
  it("uses the environment supplied by the host, not process.env", async () => {
    // The host resolves `options.env` as authoritative and SELF-CONFIG honours
    // it. Composing Remember without it silently fell back to process.env, so a
    // credential supplied only through the host was invisible to the guard.
    const { dir, store } = writableStore();
    const extension = await createMemoryRememberRuntimeExtension(store, {
      env: { HOST_ONLY_API_KEY: "host-only-secret-value" },
    })(request());
    try {
      const url = (extension.runtimeOptions?.mcpServers as Record<string, { url?: string }>)
        ?.[MEMORY_REMEMBER_MCP_SERVER_NAME]?.url;
      if (typeof url !== "string") throw new Error("Remember endpoint was not registered.");
      const client = new Client({ name: "remember-env-test", version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)) as never);
      try {
        const result = await client.callTool({
          name: REMEMBER_TOOL_NAME,
          arguments: { text: "The staging value is host-only-secret-value." },
        }) as { isError?: boolean };
        expect(result.isError).toBe(true);
        expect(dailyContent(dir)).toBe("");
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await extension.cleanup?.();
    }
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
