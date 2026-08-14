import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, uploadContent } from "./api";
import { agent, attachment } from "./test/fixtures";

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest;
  readonly headers = new Map<string, string>();
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  responseType: XMLHttpRequestResponseType = "";
  response: unknown = null;
  status = 0;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;

  constructor() {
    FakeXMLHttpRequest.latest = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

describe("uploadContent", () => {
  beforeEach(() => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads opaque bytes while preserving the declared MIME on the reservation", async () => {
    const reservation = attachment("upload one", {
      name: "notes.md",
      contentType: "text/markdown",
    });
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    const onProgress = vi.fn();
    const result = uploadContent(reservation, file, onProgress);
    const xhr = FakeXMLHttpRequest.latest;

    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("/api/v1/uploads/upload%20one/content");
    expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
    expect(xhr.headers.get("accept")).toBe("application/json");
    expect(xhr.body).toBe(file);

    const uploaded = { ...reservation, uploaded: true };
    xhr.status = 200;
    xhr.response = { attachment: uploaded };
    xhr.onload?.();

    await expect(result).resolves.toEqual(uploaded);
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });

  it("aborts the XHR when its attachment context is disposed", async () => {
    const reservation = attachment("abort-me");
    const controller = new AbortController();
    const result = uploadContent(
      reservation,
      new File(["data"], "data.txt", { type: "text/plain" }),
      vi.fn(),
      controller.signal,
    );

    controller.abort();

    expect(FakeXMLHttpRequest.latest.aborted).toBe(true);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("turn overrides", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits model and effort when automatic provider defaults are selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread: {}, turn: { id: "turn", status: "running" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.startTurn("thread", { text: "hello", model: undefined, effort: undefined });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
  });

  it("sends quote metadata without rewriting the authored text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ thread: {}, turn: { id: "turn", status: "running" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.startTurn("thread", {
      text: "Follow up",
      quote: { text: "Selected response", messageId: "source-message" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Follow up",
      quote: { text: "Selected response", messageId: "source-message" },
    });
  });

  it("posts a live follow-up to the encoded thread route", async () => {
    const receipt = {
      disposition: "pending" as const,
      message: {
        id: "live-message",
        threadId: "thread/one",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Steer this run" }],
        attachments: [],
        createdAt: "2026-07-21T10:00:00.000Z",
        updatedAt: "2026-07-21T10:00:00.000Z",
        status: "complete" as const,
        liveInputStatus: "pending" as const,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(receipt, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.liveInput("thread/one", "Steer this run")).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/threads/thread%2Fone/live-input",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Steer this run" }),
      }),
    );
  });
});

describe("AskUser API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses one encoded thread route for polling and atomic answer submission", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ask: { interactionId: "ask-test", status: "pending" } }))
      .mockResolvedValueOnce(Response.json({ accepted: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.pendingAsk("thread/one")).resolves.toMatchObject({ interactionId: "ask-test" });
    await expect(api.submitAsk("thread/one", "ask-test", [{
      questionId: "q0",
      selectedOptionIds: ["q0o0"],
    }])).resolves.toEqual({ accepted: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/threads/thread%2Fone/ask");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/threads/thread%2Fone/ask");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
  });
});

describe("cron activity API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads one selected run through its fully encoded detail route", async () => {
    const message = {
      id: "message-one",
      threadId: "cron-thread",
      role: "assistant",
      parts: [],
      attachments: [],
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z",
      status: "complete",
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ message }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.cronRun("agent/one", "daily:brief", "cron:daily/one"))
      .resolves.toEqual(message);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/agents/agent%2Fone/cron/jobs/daily%3Abrief/runs/cron%3Adaily%2Fone",
    );
  });
});

describe("push subscription API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds the secret-free status read to the current browser origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      subscription: { id: "subscription/one", state: "active", keyFingerprint: "fingerprint" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.pushSubscription("subscription/one");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/push/subscriptions/subscription%2Fone",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Mono-Agent-Web-Origin": window.location.origin }),
      }),
    );
  });

  it("registers a rotated browser subscription with an exact-origin replacement claim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      subscription: { id: "subscription-two", state: "active", keyFingerprint: "fingerprint" },
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const subscription = {
      endpoint: "https://push.example.test/send/new",
      expirationTime: null,
      toJSON: () => ({
        endpoint: "https://push.example.test/send/new",
        expirationTime: null,
        keys: { p256dh: "public-key", auth: "auth-secret" },
      }),
    } as unknown as PushSubscription;

    await api.registerPushSubscription(subscription, "subscription-one");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/push/subscriptions", expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ "X-Mono-Agent-Web-Origin": window.location.origin }),
    }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      endpoint: "https://push.example.test/send/new",
      expirationTime: null,
      keys: { p256dh: "public-key", auth: "auth-secret" },
      previousSubscriptionId: "subscription-one",
    });
  });
});

describe("agent favorites", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("patches the desired pin state using the encoded stable source id", async () => {
    const pinned = agent("alpha/one", { pinned: true });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ agent: pinned }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.patchAgent("alpha/one", true)).resolves.toEqual(pinned);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/agents/alpha%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ pinned: true }),
      }),
    );
  });
});
