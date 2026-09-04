import type { AgentMessageStream } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  MessengerAdapter,
  isSafeAttachmentUrl,
  messengerConversationId,
  messengerUserIdFromConversation,
  type AgentRequest,
  type AgentResponder,
} from "../adapter.js";
import type { MessengerGraphClientLike, MessengerSendOptions } from "../graph-client.js";

interface SentText {
  readonly recipientId: string;
  readonly text: string;
  readonly options: MessengerSendOptions | undefined;
}

function fakeClient(): MessengerGraphClientLike & { readonly sent: SentText[]; readonly actions: string[] } {
  const sent: SentText[] = [];
  const actions: string[] = [];
  return {
    sent,
    actions,
    async sendText(recipientId, text, options) {
      sent.push({ recipientId, text, options });
      return { messageIds: [`m${sent.length}`] };
    },
    async sendAttachmentUrl() {
      return { messageIds: [] };
    },
    async senderAction(_recipientId, action) {
      actions.push(action);
    },
  };
}

function responderWith(handler: (request: AgentRequest, stream: AgentMessageStream) => Promise<string>): AgentResponder & {
  readonly requests: AgentRequest[];
  readonly verbatim: { conversationId: string; text: string }[];
} {
  const requests: AgentRequest[] = [];
  const verbatim: { conversationId: string; text: string }[] = [];
  return {
    requests,
    verbatim,
    async respond(request, stream) {
      requests.push(request);
      return { text: await handler(request, stream) };
    },
    async deliverVerbatim(conversationId, text) {
      verbatim.push({ conversationId, text });
    },
  };
}

function pagePayload(events: Record<string, unknown>[]): unknown {
  return { object: "page", entry: [{ id: "page-1", time: 1, messaging: events }] };
}

function textEvent(userId: string, text: string, mid = `mid-${text}`): Record<string, unknown> {
  return { sender: { id: userId }, recipient: { id: "page-1" }, timestamp: 1_700_000_000_000, message: { mid, text } };
}

describe("conversation ids", () => {
  it("round-trips a PSID and rejects other shapes", () => {
    expect(messengerConversationId("123456")).toBe("messenger:123456");
    expect(messengerUserIdFromConversation("messenger:123456")).toBe("123456");
    expect(messengerUserIdFromConversation("telegram:123456")).toBeUndefined();
    expect(messengerUserIdFromConversation("messenger:abc")).toBeUndefined();
    expect(messengerUserIdFromConversation("messenger:")).toBeUndefined();
  });
});

describe("MessengerAdapter", () => {
  it("requires an allowlist or allow-all", () => {
    expect(() => new MessengerAdapter({ client: fakeClient(), responder: responderWith(async () => "") })).toThrow(TypeError);
  });

  it("answers an allowed user's text through the responder and strips Markdown", async () => {
    const client = fakeClient();
    const responder = responderWith(async () => "**Hi** Geri");
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"] });

    const results = await adapter.handleWebhookPayload(pagePayload([textEvent("42", "hello")]));

    expect(results).toEqual([{ kind: "handled", userId: "42", action: "responded", messageId: "mid-hello" }]);
    expect(responder.requests).toHaveLength(1);
    const request = responder.requests[0]!;
    expect(request.conversationId).toBe("messenger:42");
    expect(request.replyTo).toEqual({ conversationId: "messenger:42" });
    expect(request.text).toBe("hello");
    expect(request.surface).toMatchObject({ kind: "dm", id: "42" });
    expect(request.metadata.messenger).toMatchObject({ user: { id: "42" }, page: { id: "page-1" }, message: { id: "mid-hello" }, trigger: "message" });
    expect(client.sent).toEqual([{ recipientId: "42", text: "Hi Geri", options: { maxMessageChars: 2000 } }]);
    expect(client.actions).toContain("typing_on");
  });

  it("drops unauthorized users with a denial and ignores echoes, receipts, and duplicates", async () => {
    const client = fakeClient();
    const responder = responderWith(async () => "never");
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"] });

    const results = await adapter.handleWebhookPayload(pagePayload([
      textEvent("99", "intruder"),
      { sender: { id: "42" }, message: { mid: "echo", text: "x", is_echo: true } },
      { sender: { id: "42" }, delivery: { mids: ["a"] } },
      textEvent("42", "same", "dup"),
      textEvent("42", "same", "dup"),
    ]));

    expect(results.map((result) => result.kind)).toEqual(["unauthorized", "ignored", "ignored", "handled", "ignored"]);
    expect(results[4]).toMatchObject({ reason: "duplicate" });
    expect(responder.requests).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({ recipientId: "99" });
  });

  it("handles /start, /help, and /cancel without a model turn", async () => {
    const client = fakeClient();
    const responder = responderWith(async () => "never");
    const cancel = vi.fn();
    responder.cancel = cancel;
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"] });

    const results = await adapter.handleWebhookPayload(pagePayload([
      textEvent("42", "/start"),
      textEvent("42", "/help"),
      textEvent("42", "/cancel"),
    ]));

    expect(results.map((result) => result.kind)).toEqual(["handled", "handled", "cancelled"]);
    expect(responder.requests).toHaveLength(0);
    expect(cancel).toHaveBeenCalledWith("messenger:42", expect.anything());
    expect(client.sent).toHaveLength(3);
  });

  it("turns postbacks and attachments into request text and ingests images", async () => {
    const client = fakeClient();
    const responder = responderWith(async () => "ok");
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("png-bytes"), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "9" },
    })) as unknown as typeof fetch;
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"], attachments: { fetch: fetchImpl } });

    await adapter.handleWebhookPayload(pagePayload([
      { sender: { id: "42" }, postback: { mid: "pb", title: "Yes", payload: "YES_PAYLOAD" } },
      {
        sender: { id: "42" },
        message: {
          mid: "img",
          attachments: [
            { type: "image", payload: { url: "https://scontent.example.com/photo.png" } },
            { type: "location", title: "Home", payload: { coordinates: { lat: 47.5, long: 19.04 } } },
            { type: "audio", payload: { url: "https://cdn.example.com/voice.mp4" } },
          ],
        },
      },
    ]));

    expect(responder.requests[0]).toMatchObject({ text: "YES_PAYLOAD", metadata: { messenger: { trigger: "postback" } } });
    const withAttachments = responder.requests[1]!;
    expect(withAttachments.attachments).toHaveLength(1);
    expect(withAttachments.attachments?.[0]).toMatchObject({ kind: "image", mimeType: "image/png", name: "photo.png", sizeBytes: 9 });
    expect(withAttachments.text).toContain("[image attachment: photo.png]");
    expect(withAttachments.text).toContain("[location: Home 47.5,19.04]");
    expect(withAttachments.text).toContain("[audio attachment: https://cdn.example.com/voice.mp4]");
    expect(withAttachments.metadata.messenger.attachmentTypes).toEqual(["image", "location", "audio"]);
  });

  it("queues messages per user and reports busy beyond the queue cap", async () => {
    const client = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const responder = responderWith(async (request) => {
      if (request.text === "slow") await gate;
      return `done:${request.text}`;
    });
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"], maxQueuedPerUser: 2 });

    const first = adapter.handleEvent(textEvent("42", "slow") as never);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const second = adapter.handleEvent(textEvent("42", "second") as never);
    const third = await adapter.handleEvent(textEvent("42", "third") as never);

    expect(third).toMatchObject({ kind: "busy" });
    release();
    expect(await first).toMatchObject({ kind: "handled" });
    expect(await second).toMatchObject({ kind: "handled" });
    expect(client.sent.map((entry) => entry.text)).toEqual([expect.stringContaining("still working"), "done:slow", "done:second"]);
  });

  it("delivers verbatim notifications with proactive send options and records history", async () => {
    const client = fakeClient();
    const responder = responderWith(async () => "never");
    const adapter = new MessengerAdapter({
      client,
      responder,
      allowedUserIds: ["42"],
      proactive: { messagingType: "MESSAGE_TAG", tag: "CONFIRMED_EVENT_UPDATE" },
    });

    const result = await adapter.notify("42", "Barber in **1 hour**", { verbatim: true, deliveryKey: "cron:1" });

    expect(result).toMatchObject({ delivered: true, code: "delivered", channelId: "messenger", historyRecorded: true, deliveryId: "m1" });
    expect(client.sent).toEqual([{
      recipientId: "42",
      text: "Barber in 1 hour",
      options: { messagingType: "MESSAGE_TAG", tag: "CONFIRMED_EVENT_UPDATE" },
    }]);
    expect(responder.verbatim).toEqual([{ conversationId: "messenger:42", text: "Barber in **1 hour**" }]);
    expect(responder.requests).toHaveLength(0);
  });

  it("runs a non-verbatim notification as a turn and refuses non-allowlisted users", async () => {
    const client = fakeClient();
    const responder = responderWith(async (request) => `answer to ${request.text}`);
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"] });

    const denied = await adapter.notify("7", "hi");
    const delivered = await adapter.notify("42", "summarize", { deliveryKey: "job:1" });

    expect(denied).toMatchObject({ delivered: false, retryable: false });
    expect(delivered).toMatchObject({ delivered: true, disposition: "follow_up" });
    expect(responder.requests[0]).toMatchObject({ text: "summarize", metadata: { messenger: { trigger: "proactive" } } });
    expect(client.sent.at(-1)).toMatchObject({ text: "answer to summarize" });
  });

  it("reports an error reply when the responder throws", async () => {
    const client = fakeClient();
    const responder = responderWith(async () => { throw new Error("boom"); });
    const adapter = new MessengerAdapter({ client, responder, allowedUserIds: ["42"] });

    const [result] = await adapter.handleWebhookPayload(pagePayload([textEvent("42", "x")]));

    expect(result).toMatchObject({ kind: "error" });
    expect(client.sent.at(-1)?.text).toContain("failed");
  });
});

describe("isSafeAttachmentUrl", () => {
  it("allows public https hosts only", () => {
    expect(isSafeAttachmentUrl("https://lookaside.fbsbx.com/file.pdf")).toBe(true);
    expect(isSafeAttachmentUrl("http://lookaside.fbsbx.com/file.pdf")).toBe(false);
    expect(isSafeAttachmentUrl("https://127.0.0.1/secret")).toBe(false);
    expect(isSafeAttachmentUrl("https://localhost/secret")).toBe(false);
    expect(isSafeAttachmentUrl("https://[::1]/secret")).toBe(false);
    expect(isSafeAttachmentUrl("https://user:pw@cdn.example.com/x")).toBe(false);
    expect(isSafeAttachmentUrl("not a url")).toBe(false);
  });
});
