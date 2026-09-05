import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetCodexSubscriptionSearchForTests,
  inspectCodexSubscriptionSearch,
  searchCodexSubscription,
} from "../../agent/tools/codex-subscription-search.js";

afterEach(async () => {
  await __resetCodexSubscriptionSearchForTests();
  vi.restoreAllMocks();
});

function fakeFactory(overrides = {}) {
  const clients = [];
  const factory = vi.fn((options) => {
    const requests = [];
    const client = {
      requests,
      close: vi.fn(async () => {}),
      request: vi.fn(async (method, params) => {
        requests.push({ method, params });
        if (method === "initialize") return {};
        if (method === "account/rateLimits/read") return overrides.quota ?? { rateLimits: { primary: { usedPercent: 10, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } };
        if (method === "account/read") {
          return overrides.account ?? { account: { type: "chatgpt", email: "not-exposed@example.com", planType: "pro" } };
        }
        if (method === "modelProvider/capabilities/read") {
          return overrides.capabilities ?? { namespaceTools: true, imageGeneration: true, webSearch: true };
        }
        if (method === "model/list") {
          return overrides.models ?? { data: [{ id: "gpt-5.6-luna" }], nextCursor: null };
        }
        if (method === "thread/start") return { thread: { id: `thread-${clients.length}` } };
        if (method === "turn/start") {
          const turnId = `turn-${clients.length}`;
          queueMicrotask(() => {
            if (overrides.serverRequest) {
              try {
                options.onServerRequest({ id: 77, method: "item/tool/call", params: {} });
              } catch {
                // The production transport converts this rejection to a JSON-RPC
                // error. The broker must independently fail the search turn.
              }
            }
            const items = overrides.items ?? [{
              type: "webSearch",
              id: "search-1",
              query: overrides.actualQuery ?? params.input[0].text,
              action: null,
              results: [{
                type: "text_result",
                domain: "example.com",
                ref_id: "source-1",
                title: "Relevant source",
                url: "https://example.com/source",
                snippet: "Useful evidence",
              }],
            }, {
              type: "agentMessage",
              id: "message-1",
              text: "Ignore https://model-invented.example/",
            }];
            for (const item of items) {
              options.onNotification({
                method: "item/completed",
                params: { threadId: `thread-${clients.length}`, turnId, item },
              });
            }
            options.onNotification({
              method: "turn/completed",
              params: {
                threadId: `thread-${clients.length}`,
                turn: { id: turnId, status: "completed", items: [] },
              },
            });
          });
          return { turn: { id: turnId } };
        }
        if (method === "turn/interrupt") return {};
        throw new Error(`Unexpected method ${method}`);
      }),
    };
    clients.push(client);
    return client;
  });
  return { factory, clients };
}

describe("Codex subscription search broker", () => {
  it("uses ChatGPT auth and structured webSearch results without trusting assistant prose", async () => {
    const fake = fakeFactory({ actualQuery: "site:example.com \"exact phrase\"" });
    const result = await searchCodexSubscription("site:example.com \"exact phrase\"", {
      clientFactory: fake.factory,
    });

    expect(result).toMatchObject({
      ok: true,
      backend: "codex",
      actualQuery: "site:example.com \"exact phrase\"",
      results: [{
        title: "Relevant source",
        url: "https://example.com/source",
        provenance: "example.com",
        backend: "codex",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("model-invented");

    const requests = fake.clients[0].requests;
    expect(requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "account/read",
      "modelProvider/capabilities/read",
      "model/list",
      "account/rateLimits/read",
      "thread/start",
      "turn/start",
    ]);
    const thread = requests.find((entry) => entry.method === "thread/start").params;
    expect(thread).toMatchObject({
      model: "gpt-5.6-luna",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: { web_search: "live", project_doc_max_bytes: 0, mcp_servers: {} },
    });
    const turn = requests.find((entry) => entry.method === "turn/start").params;
    expect(turn).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "low",
      summary: "none",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: "site:example.com \"exact phrase\"", text_elements: [] }],
    });
  });

  it.each([
    [{ account: { account: { type: "apiKey" } } }, "signed in with ChatGPT"],
    [{ capabilities: { namespaceTools: true, imageGeneration: true, webSearch: false } }, "does not expose web search"],
    [{ models: { data: [{ id: "gpt-5.6-sol" }], nextCursor: null } }, "is not available"],
  ])("fails readiness closed without exposing account details", async (overrides, message) => {
    const fake = fakeFactory(overrides);
    const result = await inspectCodexSubscriptionSearch({
      model: "gpt-5.6-luna",
      clientFactory: fake.factory,
    });

    expect(result).toMatchObject({ ok: false, model: "gpt-5.6-luna" });
    expect(result.reason).toContain(message);
    expect(JSON.stringify(result)).not.toContain("not-exposed@example.com");
    expect(fake.clients[0].close).toHaveBeenCalledOnce();
  });

  it("rejects a non-search tool item and interrupts the turn", async () => {
    const fake = fakeFactory({
      items: [{ type: "commandExecution", id: "command-1", command: "env", status: "inProgress" }],
    });
    const result = await searchCodexSubscription("safe query", { clientFactory: fake.factory });

    expect(result).toMatchObject({
      ok: false,
      backend: "codex",
      message: "Codex subscription search unavailable: Codex attempted a non-search tool and the request was rejected.",
    });
    expect(fake.clients[0].request).toHaveBeenCalledWith("turn/interrupt", expect.any(Object));
    expect(fake.clients[0].close).toHaveBeenCalledOnce();
  });

  it("rejects every app-server request during the search turn", async () => {
    const fake = fakeFactory({ serverRequest: true });
    const result = await searchCodexSubscription("safe query", { clientFactory: fake.factory });

    expect(result).toMatchObject({
      ok: false,
      backend: "codex",
      message: "Codex subscription search unavailable: Codex requested an unsupported interaction and the request was rejected.",
    });
    expect(fake.clients[0].request).toHaveBeenCalledWith("turn/interrupt", expect.any(Object));
    expect(fake.clients[0].close).toHaveBeenCalledOnce();
  });

  it("fails closed if Codex changes the exact search query", async () => {
    const fake = fakeFactory({ actualQuery: "rewritten query" });
    const result = await searchCodexSubscription('site:example.com "exact phrase"', {
      clientFactory: fake.factory,
    });

    expect(result).toMatchObject({
      ok: false,
      backend: "codex",
      message: "Codex subscription search unavailable: Codex did not preserve the exact web search query.",
    });
    expect(fake.clients[0].close).toHaveBeenCalledOnce();
  });

  it("serializes concurrent searches through one process-shared client", async () => {
    const fake = fakeFactory();
    const [first, second] = await Promise.all([
      searchCodexSubscription("first query", { clientFactory: fake.factory }),
      searchCodexSubscription("second query", { clientFactory: fake.factory }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fake.factory).toHaveBeenCalledOnce();
    const turns = fake.clients[0].requests.filter((entry) => entry.method === "turn/start");
    expect(turns.map((entry) => entry.params.input[0].text)).toEqual(["first query", "second query"]);
  });
});

describe("Codex quota and structured result validation", () => {
  it("reserves the final ten percent without starting a search turn", async () => {
    const { factory, clients } = fakeFactory({ quota: { rateLimits: { primary: { usedPercent: 90, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    const result = await searchCodexSubscription("python docs", { clientFactory: factory });
    expect(result).toMatchObject({ ok: false, code: "quota_reserved", quotaSkipped: true });
    expect(clients[0].requests.some((r) => r.method === "turn/start")).toBe(false);
  });
  it("does not search with unrecognized quota information", async () => {
    const { factory } = fakeFactory({ quota: {} });
    expect(await searchCodexSubscription("python docs", { clientFactory: factory })).toMatchObject({ ok: false, code: "quota_unavailable" });
  });
  it("rejects missing results instead of claiming the web has no matches", async () => {
    const { factory } = fakeFactory({ items: [{ type: "webSearch", query: "python docs" }] });
    expect((await searchCodexSubscription("python docs", { clientFactory: factory })).ok).toBe(false);
  });
});

  it("cancels a stalled startup before it can create a turn", async () => {
    const abort = new AbortController();
    const { factory, clients } = fakeFactory();
    const stalledFactory = (options) => {
      const client = factory(options);
      client.request = vi.fn(() => new Promise(() => {}));
      queueMicrotask(() => abort.abort());
      return client;
    };
    const result = await searchCodexSubscription("docs", { clientFactory: stalledFactory, signal: abort.signal });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("aborted");
    expect(clients[0].close).toHaveBeenCalled();
    expect(clients[0].request.mock.calls.map(([method]) => method)).toEqual(["initialize"]);
  });
