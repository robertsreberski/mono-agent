import { describe, expect, it } from "vitest";

import { OperatorClient } from "../operator-client.js";
import { fakeProcessJob } from "./helpers.js";

function turnInput() {
  return {
    conversationId: "c",
    text: "prompt",
    attachments: [],
    metadata: {},
    signal: new AbortController().signal,
    onFrame() {},
  } as const;
}

const cronSummary = (overrides: Record<string, unknown> = {}) => ({
  projection: "summary",
  runId: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z",
  jobId: "daily:brief",
  scheduledAt: "2026-08-14T10:00:00.000Z",
  orderedAt: "2026-08-14T10:00:00.000Z",
  sequence: 1,
  trigger: "scheduled",
  status: "succeeded",
  eventCount: 1,
  ...overrides,
});

const replyPartOutcomes = [{
  partIndex: 0,
  partType: "attachment",
  status: "failed",
  code: "unsupported_destination",
  message: "Attachment reply parts are unsupported on this destination.",
}];

describe("OperatorClient", () => {
  it("parses compact cron pages and bounded detail through distinct encoded routes", async () => {
    const requests: string[] = [];
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async (input) => {
        const url = String(input);
        requests.push(url);
        return url.includes("/runs?")
          ? Response.json({ runs: [cronSummary({ replyPartOutcomes })], nextCursor: "older" })
          : Response.json({
              run: cronSummary({
                projection: "detail",
                replyPartOutcomes,
                events: [{ type: "runtime_warning", message: "bounded" }],
                eventsIncluded: 1,
              }),
            });
      }) as typeof fetch,
    });

    await expect(client.cronRuns("daily:brief", { limit: 100 })).resolves.toMatchObject({
      runs: [{ projection: "summary", eventCount: 1, replyPartOutcomes }],
      nextCursor: "older",
    });
    await expect(client.cronRun("daily:brief", cronSummary().runId)).resolves.toMatchObject({
      projection: "detail",
      eventsIncluded: 1,
      replyPartOutcomes,
    });
    expect(requests).toEqual([
      "http://127.0.0.1:1234/gui/v1/cron/jobs/daily%3Abrief/runs?limit=100",
      `http://127.0.0.1:1234/gui/v1/cron/jobs/daily%3Abrief/runs/${encodeURIComponent(cronSummary().runId)}`,
    ]);
  });

  it.each([
    ["summary events", { runs: [{ ...cronSummary(), events: [] }] }],
    ["unknown summary field", { runs: [{ ...cronSummary(), future: true }] }],
    ["wrong projection", { runs: [cronSummary({ projection: "detail", events: [], eventsIncluded: 0 })] }],
  ])("fails closed on cron pages with %s", async (_label, page) => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json(page)) as typeof fetch,
    });
    await expect(client.cronRuns("daily:brief", { limit: 100 }))
      .rejects.toMatchObject({ code: "invalid_operator_cron" });
  });

  it("fails closed on malformed detail events and detail envelopes", async () => {
    const responses = [
      { run: cronSummary({ projection: "detail", events: [{ type: "runtime_warning" }], eventsIncluded: 1 }) },
      { run: cronSummary({ projection: "detail", events: [], eventsIncluded: 0 }), future: true },
    ];
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json(responses.shift())) as typeof fetch,
    });
    await expect(client.cronRun("daily:brief", "run-one"))
      .rejects.toMatchObject({ code: "invalid_operator_cron" });
    await expect(client.cronRun("daily:brief", "run-two"))
      .rejects.toMatchObject({ code: "invalid_operator_cron" });
  });

  it("uses only the independent owner bearer for strict process-job projections", async () => {
    const requests: Array<{ url: string; authorization: string | null; method: string }> = [];
    const projection = fakeProcessJob();
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      apiKey: "ordinary-tui-key",
      processJobsBearer: "owner-job-key",
      fetchImpl: (async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        return Response.json(projection);
      }) as typeof fetch,
    });

    await expect(client.getJob(projection.jobId)).resolves.toEqual(projection);
    await expect(client.cancelJob(projection.jobId)).resolves.toEqual(projection);
    expect(requests).toEqual([
      expect.objectContaining({ authorization: "Bearer owner-job-key", method: "GET" }),
      expect.objectContaining({ authorization: "Bearer owner-job-key", method: "POST" }),
    ]);
    await expect(new OperatorClient({ baseUrl: "http://127.0.0.1:1234/gui" }).getJob(projection.jobId))
      .rejects.toMatchObject({ code: "process_jobs_unavailable" });
  });

  it("parses capabilities/model metadata and rejects untrusted endpoints", async () => {
    expect(() => new OperatorClient({ baseUrl: "http://192.168.1.5:1234/gui" })).toThrowError(/non-loopback/u);
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        label: "Agent",
        model: "p/m",
        effort: "high",
        models: ["p/m"],
        modelOptions: {
          "p/m": {
            effortLevels: ["low", "high"],
            reasoning: true,
            contextWindow: 128_000,
          },
        },
        skills: {
          status: "ready",
          items: [{
            name: "research",
            description: "Find sources.",
            availability: "on-demand",
            reference: "$research",
          }],
          total: 1,
        },
        capabilities: { attachments: true, askUser: true },
      })) as typeof fetch,
    });
    await expect(client.info()).resolves.toEqual({
      schema: 1,
      label: "Agent",
      model: "p/m",
      effort: "high",
      models: ["p/m"],
      modelOptions: {
        "p/m": {
          effortLevels: ["low", "high"],
          reasoning: true,
          contextWindow: 128_000,
        },
      },
      skills: {
        status: "ready",
        items: [{
          name: "research",
          description: "Find sources.",
          availability: "on-demand",
          reference: "$research",
        }],
        total: 1,
      },
      supportsAttachments: true,
      supportsHistoryAppend: false,
      supportsAskUser: true,
      supportsLiveInput: false,
    });
  });

  it("intersects additive reply attachment and MCP Apps capabilities", async () => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        capabilities: {
          replyAttachments: { version: 1, maxBytes: 20 * 1024 * 1024 },
          mcpApps: {
            bridgeVersion: 1,
            versions: ["future", "2025-11-21", "2026-01-26"],
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      replyAttachments: { version: 1, maxBytes: 20 * 1024 * 1024 },
      mcpApps: {
        bridgeVersion: 1,
        versions: ["2026-01-26", "2025-11-21"],
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    });
  });

  it("drops malformed optional skill metadata without taking the agent offline", async () => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        skills: {
          status: "ready",
          items: [{
            name: "research",
            description: "Find sources.",
            availability: "on-demand",
            reference: "/wrong",
          }],
          total: 1,
        },
        capabilities: {},
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      skills: { status: "ready", items: [], total: 1, truncated: true },
      supportsAttachments: false,
    });
  });

  it.each([
    {
      label: "an oversized description",
      item: {
        name: "research",
        description: "x".repeat(257),
        availability: "on-demand",
        reference: "$research",
      },
    },
    {
      label: "a non-canonical available name",
      item: {
        name: "plugin:research",
        description: "Find sources.",
        availability: "on-demand",
        reference: "$plugin:research",
      },
    },
  ])("drops $label while preserving a usable registry", async ({ item }) => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        skills: { status: "ready", items: [item], total: 1 },
        capabilities: {},
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      skills: { status: "ready", items: [], total: 1, truncated: true },
    });
  });

  it("drops an individually malformed skill while preserving valid registry entries", async () => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        skills: {
          status: "ready",
          items: [
            {
              name: "research",
              description: "Find sources.",
              availability: "on-demand",
              reference: "$research",
            },
            {
              name: "future-skill",
              description: "Uses a future wire status.",
              availability: "future",
            },
          ],
          total: 2,
        },
        capabilities: {},
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      skills: {
        status: "ready",
        items: [expect.objectContaining({ name: "research" })],
        total: 2,
        truncated: true,
      },
    });
  });

  it.each([
    {
      label: "duplicate names",
      registry: {
        status: "ready",
        items: [
          {
            name: "research",
            description: "Find sources.",
            availability: "on-demand",
            reference: "$research",
          },
          {
            name: "Research",
            description: "Find other sources.",
            availability: "inlined",
            reference: "$Research",
          },
        ],
        total: 2,
      },
    },
    {
      label: "inconsistent truncation",
      registry: {
        status: "ready",
        items: [],
        total: 1,
      },
    },
  ])("contains $label in optional skill metadata", async ({ registry }) => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        skills: registry,
        capabilities: {},
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      skills: { status: "error", items: [] },
    });
  });

  it("posts live input to the encoded conversation and validates its settlement", async () => {
    let request: { url: string; body: unknown } | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async (input, init) => {
        request = { url: String(input), body: JSON.parse(String(init?.body)) };
        return Response.json({ status: "applied", runId: "run-7" });
      }) as typeof fetch,
    });

    await expect(client.liveInput({
      conversationId: "web:thread/one",
      id: "input-1",
      text: "Use the new constraint",
      receivedAt: "2026-07-21T09:00:00.000Z",
    })).resolves.toEqual({ status: "applied", runId: "run-7" });
    expect(request).toEqual({
      url: "http://127.0.0.1:1234/gui/v1/conversations/web%3Athread%2Fone/live-input",
      body: {
        id: "input-1",
        text: "Use the new constraint",
        receivedAt: "2026-07-21T09:00:00.000Z",
      },
    });
  });

  it("reads and submits structured AskUser state on the encoded conversation route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const snapshot = {
      interactionId: "ask-test",
      questions: [],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: "2026-07-21T09:00:00.000Z",
      expiresAt: "2026-07-21T09:10:00.000Z",
    } as const;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return init?.method === "POST"
          ? Response.json({ accepted: true, snapshot: { ...snapshot, status: "answered" } })
          : Response.json({ ask: snapshot });
      }) as typeof fetch,
    });

    await expect(client.pendingAsk("web:thread/one")).resolves.toEqual(snapshot);
    await expect(client.submitAsk("web:thread/one", "ask-test", [{
      questionId: "q0",
      selectedOptionIds: ["q0o0"],
    }])).resolves.toMatchObject({ accepted: true, snapshot: { status: "answered" } });

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:1234/gui/v1/conversations/web%3Athread%2Fone/ask",
      "http://127.0.0.1:1234/gui/v1/conversations/web%3Athread%2Fone/ask",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
  });

  it("drops non-positive and non-integral context-window metadata", async () => {
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      fetchImpl: (async () => Response.json({
        schema: 1,
        modelOptions: {
          zero: { contextWindow: 0 },
          negative: { contextWindow: -1 },
          fractional: { contextWindow: 4_096.5 },
          text: { contextWindow: "8192" },
          valid: { contextWindow: 8_192 },
        },
      })) as typeof fetch,
    });

    await expect(client.info()).resolves.toMatchObject({
      modelOptions: {
        zero: {},
        negative: {},
        fractional: {},
        text: {},
        valid: { contextWindow: 8_192 },
      },
    });
  });

  it("sends the web client marker/attachments and replays every NDJSON frame", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      apiKey: "key",
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response([
          JSON.stringify({ kind: "status", text: "thinking" }),
          JSON.stringify({ kind: "append", delta: "hello" }),
          JSON.stringify({
            kind: "finish",
            finalText: "hello",
            metadata: { runtime: { model: "actual" } },
            parts: [{
              type: "attachment",
              id: "part-1",
              reference: { scheme: "mono-agent-artifact", id: "artifact-1" },
              name: "report.txt",
              mediaType: "text/plain",
              sizeBytes: 2,
              integrityId: `sha256:${"a".repeat(64)}`,
            }],
          }),
          "",
        ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
      }) as typeof fetch,
    });
    const frames: unknown[] = [];
    const result = await client.turn({
      conversationId: "web:thread",
      text: "prompt",
      attachments: [{ kind: "document", mimeType: "text/plain", data: "aGk=", name: "a.txt", sizeBytes: 2 }],
      metadata: { web: { model: "p/m" }, tui: { model: "p/m" } },
      signal: new AbortController().signal,
      onFrame(frame) { frames.push(frame); },
    });

    expect(requestBody).toMatchObject({ client: "web", conversationId: "web:thread", text: "prompt" });
    expect(requestBody?.attachments).toEqual([{ kind: "document", mimeType: "text/plain", data: "aGk=", name: "a.txt", sizeBytes: 2 }]);
    expect(frames).toEqual([{ kind: "status", text: "thinking" }, { kind: "append", delta: "hello" }]);
    expect(result).toMatchObject({
      finalText: "hello",
      metadata: { runtime: { model: "actual" } },
      parts: [{ type: "attachment", reference: { id: "artifact-1" } }],
    });
  });

  it("streams integrity-bound artifacts and uses exact MCP App connection headers", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      apiKey: "secret",
      fetchImpl: (async (input, init) => {
        const url = String(input);
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        if (url.includes("reply-artifacts")) {
          return new Response("ok", {
            headers: {
              "content-length": "2",
              "x-mono-agent-integrity-id": `sha256:${"a".repeat(64)}`,
            },
          });
        }
        if (url.endsWith("/requests")) {
          const body = JSON.parse(String(init?.body)) as { params?: { name?: string } };
          if (body.params?.name === "audit_incomplete") {
            return Response.json({
              error: {
                code: "app_audit_incomplete",
                message: "The tool ran; do not retry automatically.",
              },
            }, { status: 409 });
          }
          if (body.params?.name === "audit_failed") {
            return Response.json({
              error: { code: "app_audit_failed", message: "The action was not recorded." },
            }, { status: 507 });
          }
          return Response.json({ result: { refreshed: true } });
        }
        return Response.json({
          app: {
            type: "mcp_app",
            id: "invocation-1",
            invocationId: "invocation-1",
            connectionId: "connection-1",
            serverName: "widgets",
            toolName: "show_chart",
            resourceUri: "ui://widgets/chart",
            mediaType: "text/html;profile=mcp-app",
            protocolVersion: "2026-01-26",
          },
          html: "<!doctype html><p>chart</p>",
          connected: true,
        });
      }) as typeof fetch,
    });
    const attachment = {
      type: "attachment" as const,
      id: "part-1",
      reference: { scheme: "mono-agent-artifact" as const, id: "artifact-1" },
      name: "report.txt",
      mediaType: "text/plain",
      sizeBytes: 2,
      integrityId: `sha256:${"a".repeat(64)}`,
    };
    const artifact = await client.replyArtifact("web:thread/one", attachment);
    expect(await artifact.text()).toBe("ok");
    await expect(client.mcpAppResource("web:thread/one", "invocation-1", "connection-1"))
      .resolves.toMatchObject({ connected: true, app: { invocationId: "invocation-1" } });
    await expect(client.mcpAppRequest("web:thread/one", {
      invocationId: "invocation-1",
      connectionId: "connection-1",
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toEqual({ refreshed: true });
    await expect(client.mcpAppRequest("web:thread/one", {
      invocationId: "invocation-1",
      connectionId: "connection-1",
      method: "tools/call",
      params: { name: "audit_incomplete" },
      confirmed: true,
    })).rejects.toMatchObject({
      code: "app_audit_incomplete",
      status: 409,
      message: expect.stringContaining("do not retry automatically"),
    });
    await expect(client.mcpAppRequest("web:thread/one", {
      invocationId: "invocation-1",
      connectionId: "connection-1",
      method: "tools/call",
      params: { name: "audit_failed" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed", status: 507 });

    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-mono-agent-integrity-id": attachment.integrityId,
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      "x-mono-agent-mcp-connection-id": "connection-1",
    });
    expect(requests[2]?.init?.headers).toMatchObject({
      "x-mono-agent-mcp-connection-id": "connection-1",
    });
  });

  it("posts authenticated verbatim history with its stable idempotency key", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1234/gui",
      apiKey: "secret",
      fetchImpl: (async (input, init) => {
        request = { url: String(input), init };
        return Response.json({ recorded: true });
      }) as typeof fetch,
    });

    await client.recordVerbatim("web:notification-1", "Morning brief", "cron:daily:success");

    expect(request?.url).toBe("http://127.0.0.1:1234/gui/v1/conversations/web%3Anotification-1/verbatim");
    expect(request?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Morning brief", idempotencyKey: "cron:daily:success" }),
    });
  });

  it("distinguishes cancellation and incomplete streams", async () => {
    const cancelled = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(`${JSON.stringify({ kind: "error", message: "stop", cancelled: true })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(cancelled.turn(turnInput()))
      .rejects.toMatchObject({ code: "cancelled", cancelled: true });

    const incomplete = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("", { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch,
    });
    await expect(incomplete.turn(turnInput()))
      .rejects.toMatchObject({ code: "incomplete_operator_stream" });
  });

  it("rejects schema skew, oversized metadata, and non-NDJSON turn responses", async () => {
    const unsupported = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => Response.json({ schema: 2 })) as typeof fetch,
    });
    await expect(unsupported.info()).rejects.toMatchObject({ code: "unsupported_operator_schema" });

    const oversized = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch,
    });
    await expect(oversized.info()).rejects.toMatchObject({ code: "operator_info_too_large" });

    const wrongContentType = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => Response.json({ kind: "finish", finalText: "wrong" })) as typeof fetch,
    });
    await expect(wrongContentType.turn(turnInput())).rejects.toMatchObject({ code: "invalid_operator_content_type" });
  });

  it("accepts old-agent frames above the new producer cap and enforces the legacy 8 MiB consumer boundary", async () => {
    const mixedVersionText = "x".repeat(300 * 1024);
    const mixedVersion = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(`${JSON.stringify({ kind: "finish", finalText: mixedVersionText })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(mixedVersion.turn(turnInput())).resolves.toMatchObject({ finalText: mixedVersionText });

    const unterminated = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("x".repeat(8 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(unterminated.turn(turnInput())).rejects.toMatchObject({ code: "operator_frame_too_large" });

    const oversizedFinish = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(`${JSON.stringify({ kind: "finish", finalText: "x".repeat(8 * 1024 * 1024) })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(oversizedFinish.turn(turnInput())).rejects.toMatchObject({ code: "operator_frame_too_large" });

    const terminalWithoutNewline = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response(JSON.stringify({ kind: "finish", finalText: "done" }), {
        headers: { "content-type": "application/x-ndjson" },
      })) as typeof fetch,
    });
    await expect(terminalWithoutNewline.turn(turnInput())).resolves.toEqual({ finalText: "done" });
  });

  it("never follows redirects and reads only a bounded HTTP error prefix", async () => {
    let redirectMode: RequestInit["redirect"];
    const redirected = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } });
      }) as typeof fetch,
    });
    await expect(redirected.info()).rejects.toMatchObject({ code: "agent_http_error" });
    expect(redirectMode).toBe("error");

    const hugeError = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async () => new Response("sensitive".repeat(100_000), { status: 500 })) as typeof fetch,
    });
    const failure: unknown = await hugeError.info().then((): unknown => undefined, (error: unknown) => error);
    expect((failure as Error).message.length).toBeLessThan(400);
    expect(failure).toMatchObject({ code: "agent_http_error" });
  });

  it("bounds a hanging cancellation request", async () => {
    let cancelSignal: AbortSignal | undefined;
    const client = new OperatorClient({
      baseUrl: "http://127.0.0.1:1/gui",
      fetchImpl: (async (_input, init) => {
        cancelSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolvePromise, reject) => {
          cancelSignal?.addEventListener("abort", () => reject(cancelSignal?.reason), { once: true });
        });
      }) as typeof fetch,
    });
    const startedAt = Date.now();
    await expect(client.cancel("conversation")).rejects.toBeDefined();
    expect(cancelSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  }, 5_000);
});
