import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadInteractionSettings,
  startInteractionBridge,
  type ChannelInteractionSink,
  type InteractionBridgeHandle,
} from "../interaction-bridge.js";

let bridge: InteractionBridgeHandle | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

async function startBridge(
  options: { askTimeoutMs?: number } = {},
): Promise<InteractionBridgeHandle> {
  bridge = await startInteractionBridge({ host: "127.0.0.1", port: 0, ...options });
  return bridge;
}

function recordingSink(): {
  posts: Array<[string, string]>;
  statuses: Array<[string, string, { key: string; state: string }]>;
  sink: ChannelInteractionSink;
} {
  const posts: Array<[string, string]> = [];
  const statuses: Array<[string, string, { key: string; state: string }]> = [];
  return {
    posts,
    statuses,
    sink: {
      postQuestion: async (conversationId, text) => {
        posts.push([conversationId, text]);
      },
      postStatus: async (conversationId, text, options) => {
        statuses.push([conversationId, text, options]);
      },
    },
  };
}

function headers(handle: InteractionBridgeHandle): Record<string, string> {
  return { authorization: `Bearer ${handle.token}`, "content-type": "application/json" };
}

async function createAsk(
  handle: InteractionBridgeHandle,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(new URL("/v1/asks", handle.url), {
    method: "POST",
    headers: headers(handle),
    body: JSON.stringify(body),
  });
}

async function awaitAnswer(
  handle: InteractionBridgeHandle,
  askId: string,
  waitMs: number,
): Promise<{ status: string; answer?: string }> {
  const response = await fetch(
    new URL(`/v1/asks/${askId}?waitMs=${String(waitMs)}`, handle.url),
    { headers: headers(handle) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; answer?: string };
}

describe("interaction bridge", () => {
  it("posts the question through the channel sink and resolves the long-poll with the user's answer", async () => {
    const handle = await startBridge();
    const { posts, sink } = recordingSink();
    handle.registerSink("telegram", sink);

    const created = await createAsk(handle, {
      conversationId: "telegram:42",
      question: "Who is speaking?",
    });
    expect(created.status).toBe(201);
    const { askId } = (await created.json()) as { askId: string };
    expect(posts).toEqual([["telegram:42", "Who is speaking?"]]);

    // Park a long-poll, then resolve from the channel side (the bot interceptor).
    const pending = awaitAnswer(handle, askId, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.tryResolveAsk("telegram:42", "Alice and Bob, in Polish")).toBe(true);
    expect(await pending).toEqual({ status: "answered", answer: "Alice and Bob, in Polish" });
  });

  it("registers a pending ask without posting through the sink when postQuestion is false", async () => {
    const handle = await startBridge();
    const { posts, sink } = recordingSink();
    handle.registerSink("telegram", sink);

    const created = await createAsk(handle, {
      conversationId: "telegram:42",
      question: "Deploy now?",
      postQuestion: false,
    });
    expect(created.status).toBe(201);
    const { askId } = (await created.json()) as { askId: string };
    expect(posts).toEqual([]);

    expect(handle.tryResolveAsk("telegram:42", "Approve")).toBe(true);
    expect(await awaitAnswer(handle, askId, 1_000)).toEqual({ status: "answered", answer: "Approve" });
  });

  it("normalizes rollover-bucketed conversation ids so a reply on the base id resolves the ask", async () => {
    const handle = await startBridge();
    const { sink } = recordingSink();
    handle.registerSink("telegram", sink);

    const created = await createAsk(handle, {
      conversationId: "telegram:42#2026-07-02",
      question: "Language?",
    });
    expect(created.status).toBe(201);
    const { askId } = (await created.json()) as { askId: string };
    expect(handle.tryResolveAsk("telegram:42", "Polish")).toBe(true);
    expect(await awaitAnswer(handle, askId, 1_000)).toEqual({ status: "answered", answer: "Polish" });
  });

  it("rejects a second concurrent ask on the same conversation with 409", async () => {
    const handle = await startBridge();
    handle.registerSink("telegram", recordingSink().sink);

    expect((await createAsk(handle, { conversationId: "telegram:42", question: "One?" })).status).toBe(201);
    expect((await createAsk(handle, { conversationId: "telegram:42#b", question: "Two?" })).status).toBe(409);
  });

  it("returns 501 when no sink is registered for the conversation's channel", async () => {
    const handle = await startBridge();
    const response = await createAsk(handle, { conversationId: "slack:C1", question: "Hi?" });
    expect(response.status).toBe(501);
  });

  it("expires an unanswered ask after its timeout", async () => {
    const handle = await startBridge({ askTimeoutMs: 60 });
    handle.registerSink("telegram", recordingSink().sink);
    const created = await createAsk(handle, { conversationId: "telegram:42", question: "There?" });
    const { askId } = (await created.json()) as { askId: string };

    expect(await awaitAnswer(handle, askId, 2_000)).toEqual({ status: "expired" });
    // A late reply no longer matches anything.
    expect(handle.tryResolveAsk("telegram:42", "too late")).toBe(false);
  });

  it("cancels a pending ask when the conversation is cancelled (/cancel)", async () => {
    const handle = await startBridge();
    handle.registerSink("telegram", recordingSink().sink);
    const created = await createAsk(handle, { conversationId: "telegram:42", question: "Sure?" });
    const { askId } = (await created.json()) as { askId: string };

    const pending = awaitAnswer(handle, askId, 5_000);
    handle.cancelAsks("telegram:42");
    expect(await pending).toEqual({ status: "cancelled" });
  });

  it("routes progress posts to the channel sink's postStatus", async () => {
    const handle = await startBridge();
    const { statuses, sink } = recordingSink();
    handle.registerSink("telegram", sink);

    const response = await fetch(new URL("/v1/progress", handle.url), {
      method: "POST",
      headers: headers(handle),
      body: JSON.stringify({
        conversationId: "telegram:42#2026-07-02",
        key: "transcribe",
        message: "Transcribing… 4:10 / 10:12",
        state: "working",
      }),
    });
    expect(response.status).toBe(202);
    // postStatus receives the NORMALIZED conversation id (bucket stripped).
    expect(statuses).toEqual([
      ["telegram:42", "Transcribing… 4:10 / 10:12", { key: "transcribe", state: "working" }],
    ]);
  });

  it("rejects requests without the bearer token", async () => {
    const handle = await startBridge();
    const response = await fetch(new URL("/v1/asks", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "telegram:42", question: "?" }),
    });
    expect(response.status).toBe(401);
  });

  it("exposes the child-process environment for spawned tool servers", async () => {
    const handle = await startBridge({ askTimeoutMs: 123_000 });
    expect(handle.env()).toEqual({
      MONO_AGENT_INTERACTION_BRIDGE_URL: handle.url,
      MONO_AGENT_INTERACTION_BRIDGE_TOKEN: handle.token,
      MONO_AGENT_ASK_USER_TIMEOUT_MS: "123000",
    });
  });
});

describe("loadInteractionSettings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "interaction-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns unconfigured ephemeral defaults when no interaction block or env is present", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { model: "pi:openai-codex:gpt-5.5" } }), "utf8");

    const settings = await loadInteractionSettings({ env: {}, configPath });

    expect(settings).toEqual({
      configured: false,
      host: "127.0.0.1",
      port: 0,
      askTimeoutMs: 600_000,
      progressEnabled: true,
    });
  });

  it("reads the interaction block from the config JSON with env overrides winning", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        interaction: {
          bridge: { host: "127.0.0.1", port: 4471 },
          askUser: { timeoutMs: 300000 },
          progress: { enabled: false },
        },
      }),
      "utf8",
    );

    const fromJson = await loadInteractionSettings({ env: {}, configPath });
    expect(fromJson).toEqual({
      configured: true,
      host: "127.0.0.1",
      port: 4471,
      askTimeoutMs: 300_000,
      progressEnabled: false,
    });

    const overridden = await loadInteractionSettings({
      env: { MONO_AGENT_INTERACTION_BRIDGE_PORT: "0", MONO_AGENT_ASK_USER_TIMEOUT_MS: "120000" },
      configPath,
    });
    expect(overridden).toMatchObject({ configured: true, port: 0, askTimeoutMs: 120_000 });
  });
});
