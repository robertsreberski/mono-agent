import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, uploadContent, type ReplyAccessRefreshHandler } from "./api";
import { agent, attachment, processJob } from "./test/fixtures";

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

describe("process-job API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests only the encoded job bound beneath its thread", async () => {
    const job = processJob();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ job }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.threadJob("thread/one", "job/two")).resolves.toEqual(job);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/threads/thread%2Fone/jobs/job%2Ftwo");
    expect(api).not.toHaveProperty("threadJobs");
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

describe("short-lived reply access", () => {
  const staleResourceUrl = "/api/v1/threads/thread-one/messages/message-one/mcp-apps/app-one?expires=1000000000&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const staleBridgeUrl = "/api/v1/threads/thread-one/messages/message-one/mcp-apps/app-one/requests?expires=1000000000&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const freshResourceUrl = "/api/v1/threads/thread-one/messages/message-one/mcp-apps/app-one?expires=2000000000&token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const freshBridgeUrl = "/api/v1/threads/thread-one/messages/message-one/mcp-apps/app-one/requests?expires=2000000000&token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const appPart = {
    type: "mcp_app" as const,
    id: "app-one",
    invocationId: "app-one",
    connectionId: "connection-one",
    serverName: "widgets",
    toolName: "show_chart",
    resourceUri: "ui://widgets/chart",
    mediaType: "text/html;profile=mcp-app" as const,
    protocolVersion: "2026-01-26" as const,
    resourceUrl: freshResourceUrl,
    bridgeUrl: freshBridgeUrl,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts an authentic MCP refresh so later resource and bridge requests skip stale URLs", async () => {
    const resource = { app: appPart, html: "<!doctype html><p>ready</p>", connected: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "reply_access_expired", message: "Expired." } }, { status: 410 }))
      .mockResolvedValueOnce(Response.json({ part: appPart }))
      .mockResolvedValueOnce(Response.json(resource))
      .mockResolvedValueOnce(Response.json({ result: { contents: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    let access = { resourceUrl: staleResourceUrl, bridgeUrl: staleBridgeUrl };
    const adopt = vi.fn((part: Parameters<ReplyAccessRefreshHandler<"mcp_app">>[0]) => {
      if (part.resourceUrl === undefined || part.bridgeUrl === undefined) {
        throw new Error("Expected refreshed MCP App access.");
      }
      access = { resourceUrl: part.resourceUrl, bridgeUrl: part.bridgeUrl };
    });
    await expect(api.mcpAppResource(access.resourceUrl, undefined, adopt)).resolves.toEqual(resource);
    await expect(api.mcpAppRequest(
      access.bridgeUrl,
      "resources/read",
      { uri: "ui://widgets/data" },
      false,
      undefined,
      adopt,
    )).resolves.toEqual({ contents: [] });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith(appPart);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/threads/thread-one/messages/message-one/mcp-apps/app-one/access",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "X-Mono-Agent-Web-Origin": window.location.origin }),
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(freshResourceUrl);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(freshBridgeUrl);
  });

  it("retries an expired MCP bridge mutation at most once", async () => {
    const expired = () => Response.json(
      { error: { code: "reply_access_expired", message: "Expired." } },
      { status: 410 },
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(Response.json({ part: appPart }))
      .mockResolvedValueOnce(expired());
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.mcpAppRequest(
      staleBridgeUrl,
      "tools/call",
      { name: "refresh_chart" },
      true,
    )).rejects.toMatchObject({ code: "reply_access_expired", status: 410 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(freshBridgeUrl);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)))
      .toEqual(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)));
  });

  it("coalesces concurrent access refreshes for one MCP App generation", async () => {
    let resolveAccess!: (response: Response) => void;
    const accessResponse = new Promise<Response>((resolve) => {
      resolveAccess = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/access")) return accessResponse;
      if (url.includes("expires=1000000000")) {
        return Promise.resolve(Response.json(
          { error: { code: "reply_access_expired", message: "Expired." } },
          { status: 410 },
        ));
      }
      return Promise.resolve(Response.json({ result: { contents: [] } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const leftAdopt = vi.fn();
    const rightAdopt = vi.fn();

    const left = api.mcpAppRequest(
      staleBridgeUrl,
      "resources/read",
      { uri: "ui://widgets/left" },
      false,
      controller.signal,
      leftAdopt,
    );
    const right = api.mcpAppRequest(
      staleBridgeUrl,
      "resources/read",
      { uri: "ui://widgets/right" },
      false,
      controller.signal,
      rightAdopt,
    );
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/access"))).toHaveLength(1);
    });
    resolveAccess(Response.json({ part: appPart }));

    await expect(Promise.all([left, right])).resolves.toEqual([{ contents: [] }, { contents: [] }]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(leftAdopt).toHaveBeenCalledTimes(1);
    expect(rightAdopt).toHaveBeenCalledTimes(1);
  });

  it("does not refresh forged or unknown reply capabilities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ error: { code: "reply_part_not_found", message: "Not found." } }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.mcpAppResource(staleResourceUrl)).rejects.toMatchObject({
      code: "reply_part_not_found",
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes an authentic expired attachment once without carrying stale query data forward", async () => {
    const staleContentUrl = "/api/v1/threads/thread-one/messages/message-one/reply-attachments/file-one/content?expires=1000000000&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fresh = {
      type: "attachment" as const,
      id: "file-one",
      artifactId: "artifact-one",
      name: "report.txt",
      mediaType: "text/plain",
      sizeBytes: 6,
      integrityId: `sha256:${"a".repeat(64)}`,
      contentUrl: "/api/v1/threads/thread-one/messages/message-one/reply-attachments/file-one/content?expires=2000000000&token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: { code: "reply_access_expired", message: "Expired." } },
        { status: 410 },
      ))
      .mockResolvedValueOnce(Response.json({ part: fresh }))
      .mockResolvedValueOnce(new Response("report", {
        headers: {
          "content-length": "6",
          "x-mono-agent-integrity-id": fresh.integrityId,
        },
      }))
      .mockResolvedValueOnce(new Response("report", {
        headers: {
          "content-length": "6",
          "x-mono-agent-integrity-id": fresh.integrityId,
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    let contentUrl = staleContentUrl;
    const adopt = vi.fn((part: Parameters<ReplyAccessRefreshHandler<"attachment">>[0]) => {
      if (part.contentUrl === undefined) throw new Error("Expected refreshed attachment access.");
      contentUrl = part.contentUrl;
    });
    const response = await api.replyAttachmentContent(contentUrl, undefined, adopt);
    await expect(response.text()).resolves.toBe("report");
    await expect((await api.replyAttachmentContent(contentUrl, undefined, adopt)).text()).resolves.toBe("report");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/threads/thread-one/messages/message-one/reply-attachments/file-one/access",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("expires=");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("token=");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(fresh.contentUrl);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(fresh.contentUrl);
  });

  it("rejects cross-message companion capabilities before adoption or retry", async () => {
    const crossMessagePart = {
      ...appPart,
      resourceUrl: freshResourceUrl.replace("message-one", "message-two"),
      bridgeUrl: freshBridgeUrl.replace("message-one", "message-two"),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: { code: "reply_access_expired", message: "Expired." } },
        { status: 410 },
      ))
      .mockResolvedValueOnce(Response.json({ part: crossMessagePart }));
    vi.stubGlobal("fetch", fetchMock);
    const adopt = vi.fn();

    await expect(api.mcpAppResource(staleResourceUrl, undefined, adopt))
      .rejects.toThrow("binding changed");
    expect(adopt).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an incomplete MCP capability pair before adoption or retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: { code: "reply_access_expired", message: "Expired." } },
        { status: 410 },
      ))
      .mockResolvedValueOnce(Response.json({
        part: { ...appPart, bridgeUrl: undefined },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const adopt = vi.fn();

    await expect(api.mcpAppResource(staleResourceUrl, undefined, adopt))
      .rejects.toThrow("incomplete private endpoints");
    expect(adopt).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent MCP App instance refreshes bound to their own message and part", async () => {
    const requestCounts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1);
      const match = /threads\/(thread-[ab])\/messages\/(message-[ab])\/mcp-apps\/(app-[ab])/u.exec(url);
      if (match === null) return Response.json({ error: { code: "reply_part_not_found" } }, { status: 404 });
      const [, threadId, messageId, appId] = match;
      const base = `/api/v1/threads/${threadId}/messages/${messageId}/mcp-apps/${appId}`;
      if (url.endsWith("/access")) {
        return Response.json({
          part: {
            ...appPart,
            id: appId,
            invocationId: appId,
            connectionId: `connection-${appId}`,
            resourceUri: `ui://widgets/${appId}`,
            resourceUrl: `${base}?expires=2000000000&token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
            bridgeUrl: `${base}/requests?expires=2000000000&token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
          },
        });
      }
      if (url.includes("expires=1000000000")) {
        return Response.json({ error: { code: "reply_access_expired", message: "Expired." } }, { status: 410 });
      }
      return Response.json({
        app: {
          ...appPart,
          id: appId,
          invocationId: appId,
          connectionId: `connection-${appId}`,
          resourceUri: `ui://widgets/${appId}`,
        },
        html: `<!doctype html><p>${appId}</p>`,
        connected: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stale = (suffix: "a" | "b") =>
      `/api/v1/threads/thread-${suffix}/messages/message-${suffix}/mcp-apps/app-${suffix}?expires=1000000000&token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const leftAdopt = vi.fn();
    const rightAdopt = vi.fn();
    const [left, right] = await Promise.all([
      api.mcpAppResource(stale("a"), undefined, leftAdopt),
      api.mcpAppResource(stale("b"), undefined, rightAdopt),
    ]);
    expect(left.app.invocationId).toBe("app-a");
    expect(right.app.invocationId).toBe("app-b");
    expect(leftAdopt).toHaveBeenCalledWith(expect.objectContaining({ id: "app-a", invocationId: "app-a" }));
    expect(leftAdopt).not.toHaveBeenCalledWith(expect.objectContaining({ id: "app-b" }));
    expect(rightAdopt).toHaveBeenCalledWith(expect.objectContaining({ id: "app-b", invocationId: "app-b" }));
    expect(rightAdopt).not.toHaveBeenCalledWith(expect.objectContaining({ id: "app-a" }));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect([...requestCounts.keys()].filter((url) => url.endsWith("/access"))).toEqual(expect.arrayContaining([
      "/api/v1/threads/thread-a/messages/message-a/mcp-apps/app-a/access",
      "/api/v1/threads/thread-b/messages/message-b/mcp-apps/app-b/access",
    ]));
  });
});
