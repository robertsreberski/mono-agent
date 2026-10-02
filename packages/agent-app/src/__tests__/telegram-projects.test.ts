import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgentHarness, createAgentResponder, createInMemoryHistoryStore, type AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import type { TelegramAdapterStartOptions } from "@mono-agent/telegram-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramChannelDriver, type ChannelStartInput } from "../channels.js";
import { CONSOLE_PROJECT_SCHEMAS, createConsoleProjectsRuntimeExtension } from "../console-projects.js";
import {
  bindTelegramProjectTurn,
  createTelegramProjectsService,
  telegramProjectTurnFor,
  type TelegramProjectsService,
} from "../telegram-projects.js";
import { openTelegramTopicDirectory, type TelegramTopicDirectoryStore } from "../telegram-topic-directory.js";

const roots: string[] = [];
const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-telegram-projects-")));
  roots.push(root);
  return root;
}

async function directory(clock = { now: Date.parse("2026-09-28T10:00:00.000Z") }): Promise<TelegramTopicDirectoryStore> {
  const store = await openTelegramTopicDirectory({ cwd: await tempRoot(), botId: "42", now: () => new Date(clock.now) });
  open.push(store);
  return store;
}

const topic = (name?: string, extra: Record<string, unknown> = {}) => ({
  chatId: -1001, chatTitle: "Trips", isForum: true,
  topic: { messageThreadId: 77, ...(name === undefined ? {} : { nameRecord: { name, source: "root_reply" as const, messageId: 900 } }), ...extra },
});

/**
 * A stand-in for the web console's owner-private ingress: the real client code
 * reads a real owner-only record and talks through this fetch.
 */
async function fakeConsole(handlers: Partial<Record<string, (body: Record<string, unknown>) => unknown>> = {}) {
  const stateDir = await tempRoot();
  const record = join(stateDir, "notify-ingress.json");
  await writeFile(record, JSON.stringify({
    schema: 1, pid: 1, instanceId: "fake", url: "http://127.0.0.1:9/internal/v1/notifications",
    token: "t".repeat(43), updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  await chmod(record, 0o600);
  const calls: Array<{ path: string; body: Record<string, unknown>; authorization: string }> = [];
  let down = false;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (down) throw new TypeError("fetch failed");
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body, authorization: String((init?.headers as Record<string, string>).authorization) });
    const handler = handlers[path];
    const result = handler === undefined ? {} : handler(body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { web: { stateDir, fetchImpl }, calls, setDown: (value: boolean) => { down = value; } };
}

describe("telegram topic ledger", () => {
  it("records sightings with rename precedence, sticky forum flag, and revision-exact acknowledgement", async () => {
    const clock = { now: Date.parse("2026-09-28T10:00:00.000Z") };
    const ledger = await directory(clock);
    expect(ledger.observe(topic("Budapest"))).toBe(true);
    ledger.observe({ chatId: -1001, topic: { messageThreadId: 77, nameRecord: { name: "Flights", source: "edited", messageId: 950 } } });
    ledger.observe(topic("Budapest", { nameRecord: { name: "Budapest", source: "root_reply", messageId: 990 } }));
    expect(ledger.entry("-1001", 77)).toMatchObject({ chatTitle: "Trips", topicName: "Flights" });
    // An update without the forum flag is not evidence it was removed.
    ledger.observe({ chatId: -1001 });
    expect(ledger.isForum("-1001")).toBe(true);
    expect(ledger.entry("-1001", undefined)).toMatchObject({ chatTitle: "Trips" });
    expect(ledger.entry("555", undefined)).toBeUndefined();

    const first = ledger.pending(100);
    expect(first.entries.map((entry) => entry.topicId ?? "main")).toEqual([77, "main"]);
    // A change after the batch was read stays pending.
    clock.now += 60_000;
    ledger.observe(topic(undefined, { state: "closed" }));
    ledger.acknowledge(first.acknowledgement);
    expect(ledger.pending(100).entries).toContainEqual(expect.objectContaining({ topicId: 77, state: "closed" }));
    ledger.acknowledge(ledger.pending(100).acknowledgement);
    expect(ledger.pending(100).entries).toEqual([]);
    ledger.markAllPending();
    expect(ledger.pending(100).entries).toHaveLength(2);
    expect(ledger.knownTopicNames()).toEqual([{ chatId: "-1001", messageThreadId: 77, nameRecord: { name: "Flights", source: "edited", messageId: 950 } }]);
  });

  it("refuses a second live owner of the same ledger", async () => {
    const cwd = await tempRoot();
    const first = await openTelegramTopicDirectory({ cwd, botId: "42" });
    open.push(first);
    await expect(openTelegramTopicDirectory({ cwd, botId: "42" })).rejects.toMatchObject({ kind: "lease_conflict" });
  });
});

describe("telegram projects service", () => {
  it("mirrors sightings in batches and replays them after the console was unreachable", async () => {
    const ledger = await directory();
    const console = await fakeConsole({ "/internal/v1/external-conversations": () => ({ truncated: false }) });
    console.setDown(true);
    const warn = vi.fn();
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => true,
      web: console.web, logger: { warn }, syncDebounceMs: 1 });
    open.push(service);
    service.observe(topic("Flights"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Telegram topics could not be mirrored to the web console; retrying later.", { code: "web_console_unavailable" }));
    expect(ledger.pending(100).entries).toHaveLength(2);
    console.setDown(false);
    service.observe(topic("Flights", { state: "closed" }));
    await vi.waitFor(() => expect(ledger.pending(100).entries).toEqual([]));
    const observations = console.calls.flatMap((call) => call.body.observations as Array<Record<string, unknown>>);
    expect(observations).toContainEqual(expect.objectContaining({ key: "telegram:42:-1001:77", kind: "topic", chatLabel: "Trips", topicLabel: "Flights", state: "closed" }));
    expect(observations).toContainEqual(expect.objectContaining({ key: "telegram:42:-1001:main", kind: "main" }));
    expect(console.calls.every((call) => call.body.sourceId === "agent-one")).toBe(true);
  });

  it("never records private chats or plain groups", async () => {
    const ledger = await directory();
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => true, syncDebounceMs: 1 });
    open.push(service);
    service.observe({ chatId: 500, chatTitle: "Direct" });
    service.observe({ chatId: -3003, chatTitle: "Plain group" });
    expect(ledger.pending(100).entries).toEqual([]);
    expect(ledger.isForum("500")).toBe(false);
  });

  it("ignores sightings from chats outside the allowlist", async () => {
    const ledger = await directory();
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => false, syncDebounceMs: 1 });
    open.push(service);
    service.observe(topic("Flights"));
    expect(ledger.entry("-1001", 77)).toBeUndefined();
  });

  it("injects live context, falls back to the last known snapshot when the console is down, and proceeds without one otherwise", async () => {
    const ledger = await directory();
    ledger.observe(topic("Flights"));
    ledger.observe({ chatId: -1001, chatTitle: "Trips", isForum: true, topic: { messageThreadId: 88 } });
    const console = await fakeConsole({
      "/internal/v1/external-turns": () => ({ conversation: { id: "ext", label: "Trips › Flights", state: "open" }, project: { id: "p1", name: "Trips › Flights", context: "Prefer aisle seats." } }),
    });
    const warn = vi.fn();
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => true, web: console.web, logger: { warn } });
    open.push(service);

    const live = await service.beginTurn({ conversationId: "telegram:-1001:77", turnKey: "run-00000001", tools: false });
    expect(live.context).toBe("live");
    expect(live.decorateUserMessage!("book it")).toBe('<project_context name="Trips › Flights">\nPrefer aisle seats.\n</project_context>\n\nbook it');
    const sent = console.calls.at(-1)!.body;
    expect(sent).toMatchObject({ sourceId: "agent-one", channel: "telegram", key: "telegram:42:-1001:77", tools: false, pid: process.pid,
      observation: expect.objectContaining({ topicLabel: "Flights" }) });

    console.setDown(true);
    const cached = await service.beginTurn({ conversationId: "telegram:-1001:77", turnKey: "run-00000002", tools: true });
    expect(cached).toMatchObject({ context: "cached", unavailable: "console_capability_unavailable" });
    expect(cached.decorateUserMessage!("again")).toContain("Prefer aisle seats.");
    expect(warn).toHaveBeenCalledWith("Web console unreachable; this Telegram turn uses the last known project context.", { code: "web_console_unavailable" });

    const never = await service.beginTurn({ conversationId: "telegram:-1001:88", turnKey: "run-00000003", tools: false });
    expect(never).toMatchObject({ context: "none" });
    expect(never.decorateUserMessage).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Web console unreachable and no project context was fetched for this Telegram topic yet; continuing without project instructions.",
      { code: "web_console_unavailable" },
    );
  });

  it("never reaches the console for a plain chat turn without tools", async () => {
    const ledger = await directory();
    const console = await fakeConsole();
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => true, web: console.web });
    open.push(service);
    expect(await service.beginTurn({ conversationId: "telegram:500", turnKey: "run-00000004", tools: false })).toMatchObject({ context: "none" });
    expect(console.calls).toEqual([]);
  });

  it("resolves a project to its topic, rechecking bot and allowlist, and reports gone topics", async () => {
    const ledger = await directory();
    let key = "telegram:42:-1001:77";
    const console = await fakeConsole({
      "/internal/v1/external-destinations": () => ({ key, label: "Trips › Flights" }),
      "/internal/v1/external-conversations/gone": () => ({ recorded: true }),
    });
    let allowed = true;
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => allowed, web: console.web });
    open.push(service);
    await expect(service.resolveDestination("p1")).resolves.toEqual({ ok: true, conversationId: "telegram:-1001:77", label: "Trips › Flights" });
    key = "telegram:42:-1001:main";
    await expect(service.resolveDestination("p1")).resolves.toMatchObject({ ok: true, conversationId: "telegram:-1001" });
    key = "telegram:43:-1001:77";
    await expect(service.resolveDestination("p1")).resolves.toMatchObject({ ok: false, code: "project_not_linked" });
    key = "telegram:42:-1001:77";
    allowed = false;
    await expect(service.resolveDestination("p1")).resolves.toMatchObject({ ok: false, code: "telegram_chat_not_allowed" });
    await service.reportGone("telegram:-1001:77");
    expect(console.calls.at(-1)).toMatchObject({ path: "/internal/v1/external-conversations/gone", body: { key: "telegram:42:-1001:77" } });
  });

  it("maps a console refusal to a model-safe message", async () => {
    const ledger = await directory();
    const console = await fakeConsole({
      "/internal/v1/external-destinations": () => new Response(JSON.stringify({ error: { code: "external_conversation_closed", message: "x" } }), { status: 409 }),
    });
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => true, web: console.web });
    open.push(service);
    await expect(service.resolveDestination("p1")).resolves.toEqual({ ok: false, code: "external_conversation_closed",
      message: "That project's Telegram topic is closed. Ask the user to reopen it in Telegram first." });
  });
});

function telegramRequest(metadata: Record<string, unknown> = { telegram: {} }): AgentHarnessRuntimeOptionsInput {
  return {
    request: { conversationId: "telegram:-1001:77", userMessage: "book it", abortSignal: new AbortController().signal, metadata },
    runId: "run-00000009", context: {} as never,
  };
}

function fakeService(turn: Partial<Awaited<ReturnType<TelegramProjectsService["beginTurn"]>>>) {
  const revoke = vi.fn(async () => {});
  const beginTurn = vi.fn(async () => ({ context: "live" as const, revoke, ...turn }));
  return { service: { beginTurn } as unknown as TelegramProjectsService, beginTurn, revoke };
}

describe("console project tools on Telegram turns", () => {
  it("carries project context whatever the tool policy, without tools for a non-human turn", async () => {
    const { service, beginTurn, revoke } = fakeService({ decorateUserMessage: (message: string) => `ctx\n\n${message}` });
    const input = telegramRequest();
    bindTelegramProjectTurn(input.request.metadata!, { service, conversationId: "telegram:-1001:77", human: false });
    const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "agent-one", policy: { allowedTools: [], disallowedTools: [] } })(input);
    expect(bound.decorateUserMessage!("book it")).toBe("ctx\n\nbook it");
    expect(bound.runtimeOptions).toEqual({});
    expect(beginTurn).toHaveBeenCalledWith({ conversationId: "telegram:-1001:77", turnKey: "run-00000009", tools: false });
    await bound.cleanup?.();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("exposes only allowed project tools on a human turn and revokes at cleanup", async () => {
    const call = vi.fn().mockResolvedValue({ projects: [], truncated: false });
    const { service, beginTurn, revoke } = fakeService({ call });
    const input = telegramRequest();
    bindTelegramProjectTurn(input.request.metadata!, { service, conversationId: "telegram:-1001:77", human: true });
    const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "agent-one", channelProjects: true,
      policy: { allowedTools: ["*"], disallowedTools: ["DeleteProject"] } })(input);
    expect(beginTurn).toHaveBeenCalledWith(expect.objectContaining({ tools: true }));
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    const client = new Client({ name: "telegram-projects", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["CreateConversation", "CreateProject", "GetProject", "ListConversations", "ListProjects", "SearchConversations", "SetConversationProject", "UpdateProject"]);
      const listed = await client.callTool({ name: "ListProjects", arguments: { channel: "telegram" } });
      expect(listed.structuredContent).toEqual({ projects: [], truncated: false });
      expect(call.mock.calls[0]![0]).toMatchObject({ tool: "ListProjects", args: { channel: "telegram" } });
    } finally { await client.close(); await bound.cleanup?.(); }
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(bound.runtimeOptions?.hostCapabilities).toMatchObject({ ListProjects: { available: true } });
  });

  it.each([false, true])("keeps Telegram legacy search and refuses dated requests with opt-in=%s", async (enabled) => {
    const call = vi.fn().mockResolvedValue({ conversations: [{ id: "fictional-thread", title: "Pottery", snippet: "Pottery class", messageMatches: 1, titleMatch: true }], truncated: false });
    const { service, revoke } = fakeService({ call });
    const input = telegramRequest();
    bindTelegramProjectTurn(input.request.metadata!, { service, conversationId: "telegram:-1001:77", human: true });
    const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "agent-one", datedSnippets: enabled,
      policy: { allowedTools: ["SearchConversations"] } })(input);
    const client = new Client({ name: "telegram-search-test", version: "1" });
    try {
      const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const legacy = await client.callTool({ name: "SearchConversations", arguments: { query: "pottery" } });
      expect(legacy.structuredContent).toEqual(await call.mock.results[0]!.value);
      for (const args of [{ dated: true }, { after: "2001-01-01" }, { role: "user" }, { before: "2001-01-01", role: "assistant" }]) {
        const result = await client.callTool({ name: "SearchConversations", arguments: { query: "pottery", ...args } });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: "conversation_search_unavailable" }) }]);
      }
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await bound.cleanup?.(); }
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("keeps web turns and the ListProjects schema unchanged when the feature is off", async () => {
    const createClient = vi.fn().mockResolvedValue(vi.fn());
    const web: AgentHarnessRuntimeOptionsInput = {
      request: { conversationId: "web:thread", userMessage: "x", abortSignal: new AbortController().signal,
        metadata: { source: "web", web: { threadId: "thread", turnId: "turn", consoleProjects: { schema: 1 } } } },
      runId: "run", context: {} as never,
    };
    const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "agent-one", policy: { allowedTools: ["ListProjects"], disallowedTools: [] }, createClient })(web);
    expect(bound.decorateUserMessage).toBeUndefined();
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    const client = new Client({ name: "web-projects", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const [tool] = (await client.listTools()).tools;
      expect(tool!.inputSchema.properties ?? {}).toEqual({});
      expect(tool!.description).toBe("List this agent's projects, including archived projects. Returns up to 20 identities and a truncation flag.");
    } finally { await client.close(); await bound.cleanup?.(); }
    expect(CONSOLE_PROJECT_SCHEMAS.ListProjects.safeParse({ channel: "telegram" }).success).toBe(false);
  });

  it("ignores Telegram-looking metadata the channel driver did not bind", async () => {
    const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "agent-one", policy: { allowedTools: [], disallowedTools: [] } })(
      telegramRequest({ telegram: { chat: { id: -1001 } }, source: "telegram" }),
    );
    expect(bound).toMatchObject({ runtimeOptions: {} });
    expect(bound.decorateUserMessage).toBeUndefined();
  });
});

describe("telegram channel driver with projects", () => {
  function startInput(config: Record<string, unknown>, cwd: string, responder: unknown): ChannelStartInput<never> {
    return {
      config: { enabled: true, botToken: "42:secret", allowedChatIds: ["-1001"], allowAllChats: false, ...config } as never,
      coreConfig: { runtime: { model: { provider: "p", model: "m", reference: "p:m" } }, tools: { allowedTools: [], disallowedTools: [] } } as never,
      responder: responder as never,
      cwd,
      sourceId: "agent-one",
      onFailure: vi.fn(),
    };
  }

  it("leaves adapter options and requests untouched when the feature is off", async () => {
    let options: TelegramAdapterStartOptions | undefined;
    const responder = { respond: vi.fn() };
    const running = await createTelegramChannelDriver({
      startAdapter: async (started) => { options = started; return { stop: async () => {}, notify: vi.fn() } as never; },
    }).start(startInput({}, await tempRoot(), responder));
    expect(options!.responder).toBe(responder);
    expect(options).not.toHaveProperty("onChatObserved");
    expect(options).not.toHaveProperty("knownTopicNames");
    await running.stop();
  });

  it("observes topics, binds human turns host-side, and marks a topic gone after a failed post", async () => {
    let options: TelegramAdapterStartOptions | undefined;
    const seen: Array<Record<string, unknown> | undefined> = [];
    const responder = { respond: vi.fn(async (request: { metadata?: Record<string, unknown> }) => { seen.push(request.metadata); return { text: "ok" }; }) };
    const console = await fakeConsole({ "/internal/v1/external-conversations/gone": () => ({ recorded: true }) });
    const notify = vi.fn(async () => ({ delivered: false, code: "telegram_topic_gone", reason: "gone" }));
    const cwd = await tempRoot();
    const running = await createTelegramChannelDriver({
      startAdapter: async (started) => { options = started; return { stop: async () => {}, notify } as never; },
      projectsWeb: console.web,
    }).start(startInput({ projects: { enabled: true } }, cwd, responder));
    try {
      expect(options!.knownTopicNames).toEqual([]);
      options!.onChatObserved!({ chatId: -1001, chatTitle: "Trips", isForum: true, topic: { messageThreadId: 77 } });
      await options!.responder.respond({ conversationId: "telegram:-1001:77", text: "hi", captureSpeakerKind: "human-turn",
        abortSignal: new AbortController().signal, metadata: { telegram: {} } } as never, {} as never);
      const binding = telegramProjectTurnFor(seen[0]);
      expect(binding).toMatchObject({ conversationId: "telegram:-1001:77", human: true });
      // The binding is identity-keyed: a JSON copy of the metadata carries nothing.
      expect(telegramProjectTurnFor(JSON.parse(JSON.stringify(seen[0])) as object)).toBeUndefined();

      await running.notify!({ conversationId: "telegram:-1001:77", text: "digest", verbatim: true });
      await vi.waitFor(() => expect(console.calls).toContainEqual(expect.objectContaining({ path: "/internal/v1/external-conversations/gone", body: expect.objectContaining({ key: "telegram:42:-1001:77" }) })));
    } finally {
      await running.stop();
    }
    // Stopping releases the ledger lease for the next start.
    const reopened = await openTelegramTopicDirectory({ cwd, botId: "42" });
    reopened.close();
  });
});

describe("project context end to end", () => {
  it("reaches the model once through the real harness and never the canonical history", async () => {
    const cwd = await tempRoot();
    await writeFile(join(cwd, "IDENTITY.md"), "You are Mono.");
    const ledger = await directory();
    const console = await fakeConsole({
      "/internal/v1/external-turns": () => ({ conversation: { id: "ext", label: "Trips › Flights", state: "open" }, project: { id: "p1", name: "Trips › Flights", context: "Prefer aisle seats." } }),
    });
    const service = createTelegramProjectsService({ directory: ledger, botId: "42", sourceId: "agent-one", isAllowedChat: () => true, web: console.web });
    open.push(service);
    service.observe(topic("Flights"));
    const prompts: RuntimeRunOptions[] = [];
    const historyStore = createInMemoryHistoryStore();
    const harness = createAgentHarness({
      identityPath: join(cwd, "IDENTITY.md"),
      runtime: { async run(_prompt: string, options: RuntimeRunOptions) { prompts.push(options); return { text: "Booked." }; } },
      model: { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" },
      cwd,
      historyStore,
      runtimeOptionsForRequest: createConsoleProjectsRuntimeExtension({ sourceId: "agent-one", policy: { allowedTools: [], disallowedTools: [] } }),
    });
    const responder = createAgentResponder({ harness });
    // Exactly what the channel driver does for each Telegram request.
    const metadata = { telegram: { chat: { id: -1001 }, message: { id: 5 } } };
    bindTelegramProjectTurn(metadata, { service, conversationId: "telegram:-1001:77", human: true });
    await responder.respond({ conversationId: "telegram:-1001:77", replyTo: { conversationId: "telegram:-1001:77" }, text: "book the flight",
      abortSignal: new AbortController().signal, metadata, captureSpeakerKind: "human-turn" }, { append: async () => undefined });

    const prompt = JSON.stringify(prompts[0]!.messages.at(-1));
    expect(prompt.match(/Prefer aisle seats\./gu)).toHaveLength(1);
    const history = await historyStore.load("telegram:-1001:77");
    expect(history.find((message) => message.role === "user")?.content).toBe("book the flight");
    expect(JSON.stringify(history)).not.toContain("Prefer aisle seats");
  });
});
