import dns from "node:dns";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  CodedError,
  MAX_AGENT_REPLY_PARTS,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
  isChannelUserCancelReason,
  parseCronOperatorJob,
  parseCronOperatorOverview,
  parseCronOperatorRunDetail,
  parseCronOperatorRunPage,
  parseAgentStreamFrame,
  serializeAgentStreamFrame,
  type AgentMessageStream,
  type AgentLiveInputRequest,
  type AgentLiveInputSettlement,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamWireFrame,
  type ChannelAskSubmission,
  type ChannelInteractionHub,
  MAX_INFO_BODY_BYTES,
} from "@mono-agent/agent-contracts";

import {
  CronOperatorError,
  MAX_CRON_OPERATOR_RESPONSE_BYTES,
  MAX_CRON_OPERATOR_RUN_PAGE,
  MAX_FRAME_BYTES,
  startTuiAdapter,
  type CronOperatorService,
  type TuiAdapterStartResult,
} from "../index.js";

let running: TuiAdapterStartResult | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function scriptedResponder(
  script: (request: AgentRequestBase, stream: AgentMessageStream) => Promise<AgentResponse>,
  cancel?: (conversationId: string, reason?: unknown) => void,
): AgentResponder {
  return { respond: script, ...(cancel === undefined ? {} : { cancel }) };
}

async function readFrames(response: globalThis.Response): Promise<AgentStreamWireFrame[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseAgentStreamFrame);
}

async function postTurn(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("startTuiAdapter", () => {
  it("accepts an allowlisted ACP tool environment as host-only request state", async () => {
    let seen: AgentRequestBase | undefined;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        seen = request;
        return { text: "ok" };
      }),
      requestToolEnvironment: {
        allowedKeys: ["MULTICA_TOKEN", "MULTICA_TASK_ID"],
        allowPathPrepend: true,
      },
    });

    await expect((await fetch(running.infoUrl)).json()).resolves.toMatchObject({
      capabilities: { toolEnvironment: true },
    });
    const response = await postTurn(running.baseUrl, {
      conversationId: "acp:fixture:session",
      text: "work",
      client: "acp",
      toolEnvironment: {
        schema: 1,
        values: { MULTICA_TOKEN: "secret", MULTICA_TASK_ID: "task-1" },
        pathPrepend: ["/opt/multica/bin"],
      },
    });
    expect(response.status).toBe(200);
    await readFrames(response);
    expect(seen?.toolEnvironment).toEqual({
      schema: 1,
      values: { MULTICA_TOKEN: "secret", MULTICA_TASK_ID: "task-1" },
      pathPrepend: ["/opt/multica/bin"],
    });
    expect(seen?.metadata).toMatchObject({ source: "acp", acpRequestId: expect.any(String) });
    expect(JSON.stringify(seen?.metadata)).not.toContain("secret");
  });

  it("rejects request environments outside the ACP loopback allowlist boundary", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      requestToolEnvironment: { allowedKeys: ["MULTICA_TOKEN"], allowPathPrepend: false },
    });

    for (const body of [
      { conversationId: "web:one", text: "work", client: "web", toolEnvironment: { schema: 1, values: {} } },
      { conversationId: "acp:one", text: "work", client: "acp", toolEnvironment: { schema: 1, values: { HOME: "/tmp" } } },
      { conversationId: "acp:one", text: "work", client: "acp", toolEnvironment: { schema: 1, values: {}, pathPrepend: ["/tmp"] } },
    ]) {
      expect((await postTurn(running.baseUrl, body)).status).toBe(400);
    }
  });

  it("serves /v1/info with schema and identity", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5" },
    });

    const info = await (await fetch(running.infoUrl)).json();
    const legacy = await fetch(`${new URL(running.baseUrl).origin}/tui/v1/info`);

    expect(running.baseUrl).toMatch(/\/gui$/u);
    expect(legacy.status).toBe(404);
    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      label: "test-agent",
      model: "claude-fable-5",
    });
  });

  it("passes through a bounded skill registry without exposing it when absent", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
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
      },
    });

    await expect((await fetch(running.infoUrl)).json()).resolves.toMatchObject({
      skills: {
        status: "ready",
        items: [{ name: "research", reference: "$research" }],
        total: 1,
      },
    });
    await running.stop();

    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
    });
    const legacy = await (await fetch(running.infoUrl)).json() as Record<string, unknown>;
    expect("skills" in legacy).toBe(false);
  });

  it("advertises and serves structured AskUser state through the operator boundary", async () => {
    const snapshot = {
      interactionId: "ask-test",
      questions: [{
        id: "q0",
        header: "Delivery",
        question: "Send the draft?",
        options: [
          { id: "q0o0", label: "Send", description: "Send it now." },
          { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        ],
        multiSelect: false,
      }],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending" as const,
      createdAt: "2026-07-21T09:00:00.000Z",
      expiresAt: "2026-07-21T09:10:00.000Z",
    };
    let submission: ChannelAskSubmission | undefined;
    const interaction: ChannelInteractionHub = {
      registerSink: () => undefined,
      getPendingAsk: (conversationId) => conversationId === "web:thread/one" ? snapshot : undefined,
      getAsk: (interactionId) => interactionId === snapshot.interactionId ? snapshot : undefined,
      submitAskAnswers: (input) => {
        submission = input;
        return { accepted: true, snapshot: { ...snapshot, status: "answered" } };
      },
      cancelAsks: () => undefined,
    };
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      interaction,
    });

    await expect((await fetch(running.infoUrl)).json()).resolves.toMatchObject({
      capabilities: { attachments: true, askUser: true, askById: true },
    });
    const route = `${running.baseUrl}/v1/conversations/${encodeURIComponent("web:thread/one")}/ask`;
    await expect((await fetch(route)).json()).resolves.toEqual({ ask: snapshot });
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ask-test",
        answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
      }),
    });
    await expect(response.json()).resolves.toMatchObject({ accepted: true, snapshot: { status: "answered" } });
    await expect((await fetch(`${running.baseUrl}/v1/interactions/ask-test`)).json()).resolves.toEqual({ ask: snapshot });
    await expect((await fetch(`${running.baseUrl}/v1/interactions/missing`)).json()).resolves.toEqual({ ask: null });
    expect(submission).toEqual({
      conversationId: "web:thread/one",
      interactionId: "ask-test",
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
    });
  });

  it("keeps exact AskUser lookup optional for third-party interaction hubs", async () => {
    const interaction: ChannelInteractionHub = {
      registerSink: () => undefined,
      getPendingAsk: () => undefined,
      submitAskAnswers: () => ({ accepted: false, code: "stale" }),
      cancelAsks: () => undefined,
    };
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      interaction,
    });

    const info = await (await fetch(running.infoUrl)).json() as { capabilities: Record<string, unknown> };
    expect(info.capabilities).toMatchObject({ askUser: true });
    expect(info.capabilities).not.toHaveProperty("askById");
    expect((await fetch(`${running.baseUrl}/v1/interactions/ask-test`)).status).toBe(501);
  });

  it("serves capability-gated cron reads and authenticated confirmed mutations without changing schema", async () => {
    let actionsEnabled = false;
    let degradedReason: string | undefined;
    const calls: unknown[] = [];
    const replyPartOutcomes = [{
      partIndex: 0,
      partType: "attachment" as const,
      status: "failed" as const,
      code: "unsupported_destination" as const,
      message: "Attachment reply parts are unsupported on this destination.",
    }];
    const cron: CronOperatorService = {
      overview: () => ({
        generatedAt: "2026-08-14T10:00:00.000Z",
        actionsEnabled,
        ...(degradedReason === undefined ? {} : { degradedReason }),
        jobs: [{
          jobId: "daily:brief",
          expression: "*/5 * * * *",
          timezone: "Europe/Amsterdam",
          conversationId: "cron:daily:brief",
          configured: true,
          declaredEnabled: true,
          effectiveEnabled: true,
          health: "unknown",
        }],
      }),
      runs: (input) => {
        calls.push(input);
        return { runs: [], nextCursor: "older" };
      },
      run: ({ jobId, runId }) => ({
        projection: "detail",
        runId,
        jobId,
        scheduledAt: "2026-08-14T10:00:00.000Z",
        orderedAt: "2026-08-14T10:00:00.000Z",
        sequence: 1,
        trigger: "manual",
        status: "succeeded",
        text: "  operator text\n",
        replyPartOutcomes,
        eventCount: 0,
        events: [],
        eventsIncluded: 0,
      }),
      configView: () => ({
        id: "cron",
        label: "Cron",
        status: "active",
        fields: [{ id: "jobs", label: "Jobs", value: "set", source: "json" }],
      }),
      runNow: (jobId, input) => {
        calls.push({ jobId, input });
        return input.confirmationToken === undefined
          ? {
              kind: "confirmation_required",
              confirmation: {
                token: "confirm-run",
                expiresAt: "2026-08-14T10:05:00.000Z",
                message: "Run now? Scheduled overlap may be skipped.",
              },
            }
          : {
              kind: "completed",
              replayed: false,
              value: {
                run: {
                  projection: "summary",
                  runId: "cron:daily%3Abrief:2026-08-14T10:00:00.000Z:m1",
                  jobId,
                  scheduledAt: "2026-08-14T10:00:00.000Z",
                  orderedAt: "2026-08-14T10:00:00.000Z",
                  sequence: 1,
                  trigger: "manual",
                  status: "admitted",
                  eventCount: 0,
                },
              },
            };
      },
      setEffectiveEnabled: (jobId, enabled, input) => {
        calls.push({ jobId, enabled, input });
        return {
          kind: "completed",
          replayed: false,
          value: {
            job: {
              jobId,
              conversationId: `cron:${jobId}`,
              configured: true,
              declaredEnabled: true,
              effectiveEnabled: enabled,
              health: enabled ? "unknown" : "disabled",
            },
          },
        };
      },
    };
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      apiKey: "fixture-secret",
      cron,
    });
    const headers = { authorization: "Bearer fixture-secret" };

    await expect((await fetch(running.infoUrl, { headers })).json()).resolves.toMatchObject({
      schema: 1,
      capabilities: { cron: { status: "ready", read: true, actions: false } },
    });
    actionsEnabled = true;
    await expect((await fetch(running.infoUrl, { headers })).json()).resolves.toMatchObject({
      schema: 1,
      capabilities: { cron: { status: "ready", read: true, actions: true } },
    });
    degradedReason = "Cron control store lease is held by another process.";
    await expect((await fetch(running.infoUrl, { headers })).json()).resolves.toMatchObject({
      schema: 1,
      capabilities: { cron: { status: "degraded", read: true, actions: false } },
    });
    degradedReason = undefined;
    await expect((await fetch(`${running.baseUrl}/v1/cron`, { headers })).json()).resolves.toMatchObject({
      jobs: [{ jobId: "daily:brief" }],
    });
    await expect((await fetch(
      `${running.baseUrl}/v1/cron/jobs/${encodeURIComponent("daily:brief")}/runs?limit=5&before=cursor`,
      { headers },
    )).json()).resolves.toEqual({ runs: [], nextCursor: "older" });
    await expect((await fetch(
      `${running.baseUrl}/v1/cron/jobs/${encodeURIComponent("daily:brief")}/runs/${encodeURIComponent("run-one")}`,
      { headers },
    )).json()).resolves.toMatchObject({
      run: { status: "succeeded", text: "  operator text\n", replyPartOutcomes },
    });
    await expect((await fetch(`${running.baseUrl}/v1/cron/config-view`, { headers })).json()).resolves.toMatchObject({
      configView: { fields: [{ value: "set" }] },
    });
    expect((await fetch(`${running.baseUrl}/v1/cron/jobs/daily%3Abrief/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "manual-one" }),
    })).status).toBe(401);
    const confirmation = await fetch(`${running.baseUrl}/v1/cron/jobs/daily%3Abrief/run`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "manual-one" }),
    });
    expect(confirmation.status).toBe(428);
    await expect(confirmation.json()).resolves.toMatchObject({
      kind: "confirmation_required",
      confirmation: { token: "confirm-run" },
    });
    const completed = await fetch(`${running.baseUrl}/v1/cron/jobs/daily%3Abrief/run`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "manual-one", confirmationToken: "confirm-run" }),
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ kind: "completed", value: { run: { jobId: "daily:brief" } } });
    expect(calls).toContainEqual({ jobId: "daily:brief", limit: 5, before: "cursor" });
  });

  it("serializes adversarial overview, 100-run pages, older pages, and detail below the cron wire ceiling", async () => {
    const replyPartOutcomes = Array.from({ length: MAX_AGENT_REPLY_PARTS }, (_, partIndex) => ({
      partIndex,
      partType: "failure" as const,
      status: "failed" as const,
      code: "artifact_integrity_failed" as const,
      message: "Reply part failed before destination delivery.",
    }));
    const summary = (index: number) => ({
      projection: "summary" as const,
      runId: `cron:${"r".repeat(700)}:${String(index)}`,
      jobId: `job-${String(index % 64)}`,
      scheduledAt: "2026-08-14T10:00:00.000Z",
      orderedAt: "2026-08-14T10:00:00.000Z",
      sequence: index + 1,
      trigger: "scheduled" as const,
      status: "failed" as const,
      startedAt: "2026-08-14T10:00:00.000Z",
      completedAt: "2026-08-14T10:00:01.000Z",
      artifactRunId: "a".repeat(512),
      text: "t".repeat(2 * 1024),
      error: "e".repeat(512),
      failureKind: "f".repeat(128),
      blockedByRunId: `cron:${"b".repeat(700)}`,
      replyPartOutcomes: replyPartOutcomes.slice(0, MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES),
      eventCount: 30,
      fieldsTruncated: ["text" as const],
    });
    const runs = Array.from({ length: MAX_CRON_OPERATOR_RUN_PAGE }, (_, index) => summary(index));
    const legacy = { runs: runs.map((run) => ({
      ...run,
      events: Array.from({ length: 30 }, () => ({ type: "runtime_warning", message: "x".repeat(350) })),
    })) };
    expect(Buffer.byteLength(JSON.stringify(legacy), "utf8")).toBeGreaterThan(1024 * 1024);
    const detail = {
      ...summary(0),
      projection: "detail" as const,
      text: "d".repeat(128 * 1024),
      replyPartOutcomes,
      eventCount: 30,
      events: Array.from({ length: 30 }, (_, index) => ({
        type: "runtime_warning" as const,
        warningKind: "probe",
        message: `${String(index)}:${"y".repeat(8 * 1024)}`,
      })),
      eventsIncluded: 30,
    };
    expect(runs.every((run) =>
      run.replyPartOutcomes.length === MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ runs, nextCursor: "older-page" }), "utf8"))
      .toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);
    const cron: CronOperatorService = {
      overview: () => ({
        generatedAt: "2026-08-14T10:00:00.000Z",
        actionsEnabled: false,
        jobs: Array.from({ length: 64 }, (_, index) => ({
          jobId: `job-${String(index)}`,
          expression: "*".repeat(256),
          timezone: "Z".repeat(128),
          conversationId: "c".repeat(512),
          configured: true,
          declaredEnabled: true,
          effectiveEnabled: true,
          health: "unhealthy" as const,
          lastRun: { ...summary(index), jobId: `job-${String(index)}` },
        })),
      }),
      runs: ({ before }) => before === undefined ? { runs, nextCursor: "older-page" } : { runs: [summary(100)] },
      run: () => detail,
      configView: () => ({ id: "cron", label: "Cron", status: "active", fields: [] }),
      runNow: () => { throw new CronOperatorError("actions_disabled", "disabled", 403); },
      setEffectiveEnabled: () => { throw new CronOperatorError("actions_disabled", "disabled", 403); },
    };
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })), cron });

    for (const path of [
      "/v1/cron",
      "/v1/cron/jobs/job-0/runs?limit=100",
      "/v1/cron/jobs/job-0/runs?limit=100&before=older-page",
      `/v1/cron/jobs/job-0/runs/${encodeURIComponent(detail.runId)}`,
    ]) {
      const response = await fetch(`${running.baseUrl}${path}`);
      expect(response.status).toBe(200);
      const serialized = await response.text();
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(MAX_CRON_OPERATOR_RESPONSE_BYTES);
      expect(() => JSON.parse(serialized)).not.toThrow();
    }
  });

  it("rejects swapping getters through the compiled public cron parser boundary without reading them", () => {
    const summary = (overrides: Record<string, unknown> = {}) => ({
      projection: "summary",
      runId: "cron:digest:2026-08-14T10:00:00.000Z",
      jobId: "digest",
      scheduledAt: "2026-08-14T10:00:00.000Z",
      orderedAt: "2026-08-14T10:00:00.000Z",
      sequence: 1,
      trigger: "scheduled",
      status: "succeeded",
      eventCount: 1,
      ...overrides,
    });
    const probes: Array<{ readonly parse: () => unknown; readonly reads: () => number }> = [];

    let expressionReads = 0;
    const job = {
      jobId: "digest",
      conversationId: "cron:digest",
      configured: true,
      declaredEnabled: true,
      effectiveEnabled: true,
      health: "healthy",
    };
    Object.defineProperty(job, "expression", {
      enumerable: true,
      get() {
        expressionReads += 1;
        return expressionReads === 1 ? "0 10 * * *" : "s".repeat(1_066);
      },
    });
    probes.push({ parse: () => parseCronOperatorJob(job), reads: () => expressionReads });

    let reasonReads = 0;
    const overview = { generatedAt: "2026-08-14T10:00:00.000Z", actionsEnabled: false, jobs: [] };
    Object.defineProperty(overview, "degradedReason", {
      enumerable: true,
      get() {
        reasonReads += 1;
        return reasonReads === 1 ? "bounded" : "s".repeat(4_097);
      },
    });
    probes.push({ parse: () => parseCronOperatorOverview(overview), reads: () => reasonReads });

    let runsReads = 0;
    const page = {};
    Object.defineProperty(page, "runs", {
      enumerable: true,
      get() {
        runsReads += 1;
        return runsReads === 1 ? [summary()] : Array.from({ length: 600 }, () => summary());
      },
    });
    probes.push({ parse: () => parseCronOperatorRunPage(page), reads: () => runsReads });

    let eventReads = 0;
    const events = [{ type: "runtime_warning", message: "bounded" }];
    Object.defineProperty(events, "0", {
      enumerable: true,
      get() {
        eventReads += 1;
        return eventReads === 1
          ? { type: "runtime_warning", message: "bounded" }
          : { type: "runtime_warning", message: "s".repeat(600 * 1024) };
      },
    });
    probes.push({
      parse: () => parseCronOperatorRunDetail(summary({
        projection: "detail",
        events,
        eventsIncluded: 1,
      })),
      reads: () => eventReads,
    });

    for (const probe of probes) {
      expect(probe.parse).toThrowError(/invalid cron operator/iu);
      expect(probe.reads()).toBe(0);
    }
  });

  it("keeps agent info live when the cron overview is stopped or fails", async () => {
    for (const failure of [
      () => { throw new CronOperatorError("unavailable", "registry stopped", 404); },
      async () => { throw new Error("control store failed"); },
    ]) {
      const errors: Array<{ readonly message: string; readonly data?: Readonly<Record<string, unknown>> }> = [];
      const cron = { overview: failure } as unknown as CronOperatorService;
      running = await startTuiAdapter({
        responder: scriptedResponder(async () => ({ text: "ok" })),
        cron,
        logger: {
          error: (message, data) => errors.push({ message, ...(data === undefined ? {} : { data }) }),
        },
      });

      const response = await fetch(running.infoUrl);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        schema: 1,
        capabilities: { cron: { status: "degraded", read: false, actions: false } },
      });
      expect(errors).toContainEqual({
        message: "Cron operator overview failed during TUI info.",
        data: { error: expect.stringMatching(/registry stopped|control store failed/u) },
      });

      await running.stop();
      running = undefined;
    }
  });

  it("keeps cron reads keyless only on a keyless operator while refusing mutations", async () => {
    const cron = {
      overview: () => ({ generatedAt: "2026-08-14T10:00:00.000Z", actionsEnabled: false, jobs: [] }),
      runs: () => ({ runs: [] }),
      configView: () => ({
        id: "cron",
        label: "Cron",
        status: "active" as const,
        fields: [{ id: "cron.prompt", label: "Prompt", value: "Visible prompt", source: "json" as const }],
      }),
    } as unknown as CronOperatorService;
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      cron,
    });

    expect((await fetch(`${running.baseUrl}/v1/cron`)).status).toBe(200);
    expect((await fetch(`${running.baseUrl}/v1/cron/jobs/digest/runs`)).status).toBe(200);
    const configResponse = await fetch(`${running.baseUrl}/v1/cron/config-view`);
    expect(configResponse.status).toBe(200);
    await expect(configResponse.json()).resolves.toMatchObject({
      configView: { fields: [{ id: "cron.prompt", value: "Visible prompt" }] },
    });
    const mutation = await fetch(`${running.baseUrl}/v1/cron/jobs/digest/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "must-not-run" }),
    });
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({
      error: { code: "actions_disabled", message: expect.stringContaining("API key") },
    });
  });

  it("includes effort in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5", effort: "high" },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      label: "test-agent",
      model: "claude-fable-5",
      effort: "high",
    });
  });

  it("includes the candidate models list in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      model: "claude-fable-5",
      models: ["claude-fable-5", "codex:gpt-5.5"],
    });
  });

  it("omits models from /v1/info when the list is empty or absent", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", models: [] },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("models" in info).toBe(false);
  });

  it("omits effort from /v1/info when not configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5" },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("effort" in info).toBe(false);
  });

  it("includes modelOptions in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
        model: "pi:ollama:qwen3.6",
        models: ["pi:ollama:qwen3.6", "pi:lmstudio:qwen3-8b"],
        modelOptions: {
          // A toggle-reasoning model (mode, no graded levels) and an effort model
          // (mode + levels) — both pass through /v1/info verbatim.
          "pi:ollama:qwen3.6": {
            reasoning: true,
            reasoningMode: "toggle",
            label: "qwen3.6",
            contextWindow: 131_072,
          },
          "pi:lmstudio:qwen3-8b": { effortLevels: ["low", "medium", "high"], reasoning: true, reasoningMode: "effort", label: "qwen3-8b" },
        },
      },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      model: "pi:ollama:qwen3.6",
      models: ["pi:ollama:qwen3.6", "pi:lmstudio:qwen3-8b"],
      modelOptions: {
        "pi:ollama:qwen3.6": {
          reasoning: true,
          reasoningMode: "toggle",
          label: "qwen3.6",
          contextWindow: 131_072,
        },
        "pi:lmstudio:qwen3-8b": { effortLevels: ["low", "medium", "high"], reasoning: true, reasoningMode: "effort", label: "qwen3-8b" },
      },
    });
  });

  it("omits modelOptions from /v1/info when absent or empty", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", modelOptions: {} },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("modelOptions" in info).toBe(false);
  });

  it("passes the provider catalog through /v1/info and gates modelCatalog on the supplied service", async () => {
    const providers = [{
      id: "anthropic",
      label: "Anthropic",
      modelCount: 13,
      source: "builtin",
      configured: true,
    }] as const;
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", providers },
    });

    const info = await (await fetch(running.infoUrl)).json() as {
      providers: unknown;
      capabilities: Record<string, unknown>;
    };
    expect(info.providers).toEqual(providers);
    expect(info.capabilities).not.toHaveProperty("modelCatalog");

    await running.stop();
    running = undefined;

    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5" },
      modelCatalog: () => ({ models: [], truncated: false }),
    });
    const withCatalog = await (await fetch(running.infoUrl)).json() as {
      capabilities: Record<string, unknown>;
    };
    expect(withCatalog.capabilities).toMatchObject({ modelCatalog: { version: 1, maxPageSize: 200 } });
  });

  it("validates, authorizes, and serves the /v1/models catalog through the injected provider", async () => {
    const requests: unknown[] = [];
    running = await startTuiAdapter({
      apiKey: "fixture-secret",
      responder: scriptedResponder(async () => ({ text: "ok" })),
      modelCatalog: (request) => {
        requests.push(request);
        return {
          models: [{
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "anthropic",
            providerLabel: "Anthropic",
          }],
          nextCursor: "claude-sonnet-4-6",
          truncated: true,
        };
      },
    });
    const headers = { authorization: "Bearer fixture-secret" };

    expect((await fetch(`${running.baseUrl}/v1/models?provider=anthropic`)).status).toBe(401);

    const ok = await fetch(`${running.baseUrl}/v1/models?provider=anthropic&limit=10`, { headers });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({
      models: [{
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        providerLabel: "Anthropic",
      }],
      nextCursor: "claude-sonnet-4-6",
      truncated: true,
    });
    expect(requests).toEqual([{ provider: "anthropic", limit: 10 }]);

    // Missing provider/q, and out-of-range limit, are client errors.
    expect((await fetch(`${running.baseUrl}/v1/models`, { headers })).status).toBe(400);
    expect((await fetch(`${running.baseUrl}/v1/models?provider=anthropic&limit=999`, { headers })).status).toBe(400);

    const search = await fetch(`${running.baseUrl}/v1/models?q=claude&limit=5`, { headers });
    expect(search.status).toBe(200);
    expect(requests).toContainEqual({ query: "claude", limit: 5 });

    // The two listing modes are mutually exclusive: suppliers service
    // `provider` and ignore `q`, so accepting both would answer a search with a
    // provider-scoped page. Reject it instead of silently answering the wrong
    // question, and never reach the supplier.
    const both = await fetch(`${running.baseUrl}/v1/models?provider=anthropic&q=claude&limit=10`, { headers });
    expect(both.status).toBe(400);
    await expect(both.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "provider and q are mutually exclusive." },
    });
    expect(requests).not.toContainEqual({ provider: "anthropic", query: "claude", limit: 10 });
  });

  it("404s /v1/models when no catalog service is supplied", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    expect((await fetch(`${running.baseUrl}/v1/models?provider=anthropic`)).status).toBe(404);
  });

  it("accepts an info PROVIDER function and resolves it fresh on every /v1/info request", async () => {
    let calls = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: () => {
        calls += 1;
        return { model: "claude-fable-5", models: [`model-${calls}`] };
      },
    });

    const first = (await (await fetch(running.infoUrl)).json()) as { models: string[] };
    const second = (await (await fetch(running.infoUrl)).json()) as { models: string[] };

    expect(first.models).toEqual(["model-1"]);
    expect(second.models).toEqual(["model-2"]);
  });

  it("reports a 500 (not a crash) when the info provider rejects", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: async () => {
        throw new Error("discovery exploded");
      },
    });

    const response = await fetch(running.infoUrl);

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("discovery exploded");
  });

  it("accepts an ASYNC info provider function (returning a promise)", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { model: "claude-fable-5", modelOptions: { "claude-fable-5": { reasoning: true } } };
      },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      capabilities: { attachments: true },
      model: "claude-fable-5",
      modelOptions: { "claude-fable-5": { reasoning: true } },
    });
  });

  it("streams the full callback sequence as NDJSON frames in order", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request, stream) => {
        expect(request.conversationId).toBe("tui:main");
        expect(request.metadata?.source).toBe("tui");
        await stream.status?.("Thinking…");
        await stream.event?.({ type: "assistant_thought", text: "let me look" });
        await stream.event?.({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });
        await stream.event?.({ type: "tool_call_progress", id: "t1", partialResult: "a.txt\n" });
        await stream.event?.({ type: "tool_call_completed", id: "t1", content: "a.txt\nb.txt", isError: false, executionMs: 12 });
        await stream.event?.({ type: "usage_update", cumulativeUsd: 0.02, tokens: { input: 5, output: 9, cacheRead: 0, cacheCreation: 0 } });
        await stream.append("Here");
        await stream.append(" you go.");
        return { text: "Here you go.", metadata: { runId: "r1" } };
      }),
    });

    const response = await postTurn(running.baseUrl, { conversationId: "tui:main", text: "list files" });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = await readFrames(response);

    expect(frames).toEqual([
      { kind: "status", text: "Thinking…" },
      { kind: "event", event: { type: "assistant_thought", text: "let me look" } },
      { kind: "event", event: { type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } } },
      { kind: "event", event: { type: "tool_call_progress", id: "t1", partialResult: "a.txt\n" } },
      { kind: "event", event: { type: "tool_call_completed", id: "t1", content: "a.txt\nb.txt", isError: false, executionMs: 12 } },
      { kind: "event", event: { type: "usage_update", cumulativeUsd: 0.02, tokens: { input: 5, output: 9, cacheRead: 0, cacheCreation: 0 } } },
      { kind: "append", delta: "Here" },
      { kind: "append", delta: " you go." },
      { kind: "finish", finalText: "Here you go.", metadata: { runId: "r1" } },
    ]);
  });

  it("accepts attachment-only web turns and preserves web metadata with a TUI override mirror", async () => {
    const requests: AgentRequestBase[] = [];
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        requests.push(request);
        return { text: "received" };
      }),
    });

    const data = Buffer.from("hello from the browser", "utf8").toString("base64");
    const frames = await readFrames(await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "web:thread-1",
      metadata: { web: { model: "claude:claude-opus-4-8", effort: "high" } },
      processJobWakeDeliveryKey: "process-job:web-wake",
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data,
        name: "note.txt",
        sizeBytes: 22,
      }],
    }));

    expect(frames).toEqual([{ kind: "finish", finalText: "received" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversationId: "web:thread-1",
      text: "",
      metadata: {
        source: "web",
        web: { model: "claude:claude-opus-4-8", effort: "high" },
        tui: { model: "claude:claude-opus-4-8", effort: "high" },
        webRequestId: expect.any(String),
      },
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data,
        name: "note.txt",
        text: "hello from the browser",
        sizeBytes: 22,
      }],
    });
    expect(Object.getOwnPropertyDescriptor(
      requests[0]?.metadata,
      Symbol.for("mono-agent.process-job-wake.delivery-key.v1"),
    )).toMatchObject({ value: "process-job:web-wake", enumerable: false });
    expect(JSON.stringify(requests[0]?.metadata)).not.toContain("process-job:web-wake");
  });

  it("emits a terminal error frame with cancelled=true for a cancelled turn", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));

    expect(frames).toEqual([
      { kind: "error", message: "Agent response was cancelled.", cancelled: true },
    ]);
  });

  it("emits a terminal error frame for a failed turn", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => {
        throw new Error("model exploded");
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));

    expect(frames).toEqual([{ kind: "error", message: "model exploded", cancelled: false }]);
  });

  it("aborts the in-flight turn when the client socket closes mid-stream", async () => {
    let sawAbort: Promise<void> | undefined;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request, stream) => {
        await stream.append("started");
        sawAbort = new Promise((resolve) => {
          request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await sawAbort;
        throw new AgentResponseCancelledError();
      }),
    });

    const controller = new AbortController();
    const responsePromise = postTurn(running.baseUrl, { conversationId: "c", text: "hi" });
    const response = await responsePromise;
    const reader = response.body!.getReader();
    await reader.read(); // first chunk arrived — the turn is in flight
    controller.abort();
    await reader.cancel(); // tear down the client side of the socket

    // The server-side abort must fire (fail the test via timeout otherwise).
    await expect(
      Promise.race([
        sawAbort,
        new Promise((_, reject) => setTimeout(() => reject(new Error("abort never fired")), 4000)),
      ]),
    ).resolves.toBeUndefined();
  });

  it("aborts active turns and bounds repeated shutdown calls", async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        requestSignal = request.abortSignal;
        enteredResolve?.();
        return await new Promise<AgentResponse>(() => undefined);
      }),
    });

    const response = await postTurn(running.baseUrl, { conversationId: "c", text: "hi" });
    await entered;
    const startedAt = Date.now();
    const firstStop = running.stop();
    expect(running.stop()).toBe(firstStop);
    await firstStop;

    expect(requestSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await response.body?.cancel();
    running = undefined;
  });

  it("routes explicit cancel to responder.cancel and 501s when unsupported", async () => {
    const cancelled: Array<[string, unknown]> = [];
    running = await startTuiAdapter({
      responder: scriptedResponder(
        async () => ({ text: "ok" }),
        (conversationId, reason) => void cancelled.push([conversationId, reason]),
      ),
    });

    const accepted = await fetch(`${running.baseUrl}/v1/conversations/tui%3Amain/cancel`, { method: "POST" });
    expect(accepted.status).toBe(202);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.[0]).toBe("tui:main");
    const reason = cancelled[0]?.[1];
    expect(isChannelUserCancelReason(reason)).toBe(true);
    if (!isChannelUserCancelReason(reason)) throw new Error("Expected a branded TUI cancellation reason.");
    expect(reason.channel).toBe("TUI");

    await running.stop();
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const unsupported = await fetch(`${running.baseUrl}/v1/conversations/c/cancel`, { method: "POST" });
    expect(unsupported.status).toBe(501);
  });

  it("advertises and authorizes durable verbatim history append", async () => {
    const recorded: Array<[string, string, string | undefined]> = [];
    running = await startTuiAdapter({
      apiKey: "fixture-secret",
      responder: {
        ...scriptedResponder(async () => ({ text: "ok" })),
        async deliverVerbatim(conversationId, text, options) {
          recorded.push([conversationId, text, options?.idempotencyKey]);
        },
      },
    });

    const info = await (await fetch(running.infoUrl, {
      headers: { authorization: "Bearer fixture-secret" },
    })).json() as { capabilities: Record<string, boolean> };
    expect(info.capabilities).toEqual({ attachments: true, historyAppend: true });

    const url = `${running.baseUrl}/v1/conversations/web%3Anotification-1/verbatim`;
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Morning brief", idempotencyKey: "cron:job:one" }),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Morning brief", idempotencyKey: "cron:job:one" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ recorded: true, conversationId: "web:notification-1" });
    expect(recorded).toEqual([["web:notification-1", "Morning brief", "cron:job:one"]]);
  });

  it("advertises live input and holds the request until the active run settles it", async () => {
    let markOffered!: (request: AgentLiveInputRequest) => void;
    const offered = new Promise<AgentLiveInputRequest>((resolve) => { markOffered = resolve; });
    let settle!: (value: AgentLiveInputSettlement) => void;
    const settled = new Promise<AgentLiveInputSettlement>((resolve) => { settle = resolve; });
    running = await startTuiAdapter({
      responder: {
        ...scriptedResponder(async () => ({ text: "ok" })),
        offerLiveInput(request) {
          markOffered(request);
          return { status: "accepted", settled };
        },
      },
    });

    const info = await (await fetch(running.infoUrl)).json() as { capabilities: Record<string, boolean> };
    expect(info.capabilities).toEqual({ attachments: true, liveInput: true });
    const responsePromise = fetch(`${running.baseUrl}/v1/conversations/web%3Athread-1/live-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "input-1",
        text: "Use the latest requirements",
        receivedAt: "2026-07-21T09:00:00.000Z",
        deliveryKey: "process-job:job-1",
      }),
    });
    await expect(offered).resolves.toEqual({
      conversationId: "web:thread-1",
      id: "input-1",
      text: "Use the latest requirements",
      receivedAt: "2026-07-21T09:00:00.000Z",
      deliveryKey: "process-job:job-1",
    });
    settle({ status: "applied", runId: "run-1" });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "applied", runId: "run-1" });
  });

  it("reports unavailable live input for responders without an active mailbox", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const response = await fetch(`${running.baseUrl}/v1/conversations/web%3Athread-1/live-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "input-1",
        text: "Follow up",
        receivedAt: "2026-07-21T09:00:00.000Z",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unavailable", reason: "unsupported" });
  });

  it("validates verbatim history append and reports unsupported responders", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const url = `${running.baseUrl}/v1/conversations/web%3Aone/verbatim`;

    const invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", idempotencyKey: "delivery:one" }),
    });
    expect(invalid.status).toBe(400);

    const unsupported = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", idempotencyKey: "delivery:one" }),
    });
    expect(unsupported.status).toBe(501);
  });

  it("rejects malformed turn bodies with 400", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    expect((await postTurn(running.baseUrl, { text: "no conversation" })).status).toBe(400);
    expect((await postTurn(running.baseUrl, { conversationId: "c" })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "image", mimeType: "text/plain", data: "aGk=" }],
    })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "document", mimeType: "application/octet-stream", data: "aGk=" }],
    })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "document", mimeType: "text/plain", data: "not-base64" }],
    })).status).toBe(400);
    expect((await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: Array.from({ length: 11 }, () => ({
        kind: "document",
        mimeType: "text/plain",
        data: "AA==",
      })),
    })).status).toBe(400);
  });

  it("enforces the decoded 20 MiB per-file limit", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const oversized = Buffer.alloc((20 * 1024 * 1024) + 1).toString("base64");

    const response = await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "c",
      attachments: [{ kind: "document", mimeType: "text/plain", data: oversized }],
    });

    expect(response.status).toBe(400);
  }, 30_000);

  it("accepts 64 MiB of control-heavy text through the 96 MiB parser, derives text, and rejects one byte more", async () => {
    let responderCalls = 0;
    let derivedTextBytes = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request) => {
        responderCalls += 1;
        derivedTextBytes = request.attachments?.reduce(
          (total, attachment) => total + Buffer.byteLength(attachment.text ?? "", "utf8"),
          0,
        ) ?? 0;
        return { text: "ok" };
      }),
    });
    const twentyMiB = Buffer.alloc(20 * 1024 * 1024).toString("base64");
    const fourMiB = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    const atLimit = [twentyMiB, twentyMiB, twentyMiB, fourMiB].map((data, index) => ({
      kind: "document",
      mimeType: "text/plain",
      data,
      name: `part-${String(index + 1)}.txt`,
    }));

    const accepted = await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "web:limit",
      attachments: atLimit,
    });
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(responderCalls).toBe(1);
    expect(derivedTextBytes).toBe(64 * 1024 * 1024);

    const rejected = await postTurn(running.baseUrl, {
      client: "web",
      conversationId: "web:over-limit",
      attachments: [
        ...atLimit,
        { kind: "document", mimeType: "text/plain", data: "AA==", name: "one-more-byte.txt" },
      ],
    });
    expect(rejected.status).toBe(400);
    expect(responderCalls).toBe(1);
  }, 30_000);

  it("reports server-side handler failures as 500, not 400", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(
        async () => ({ text: "ok" }),
        () => {
          throw new Error("cancel backend exploded");
        },
      ),
    });

    const response = await fetch(`${running.baseUrl}/v1/conversations/c/cancel`, { method: "POST" });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("exploded");
  });

  it("keeps body-parse failures as 400", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    const response = await fetch(`${running.baseUrl}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });

  it("reports turn bodies over the parser ceiling as 413", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    const response = await fetch(`${running.baseUrl}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc((96 * 1024 * 1024) + 1, 0x20),
    });

    expect(response.status).toBe(413);
  }, 30_000);

  it("enforces the bearer key on every route when configured", async () => {
    running = await startTuiAdapter({
      apiKey: "fixture-secret",
      responder: scriptedResponder(async () => ({ text: "ok" })),
    });

    expect((await fetch(running.infoUrl)).status).toBe(401);
    expect((await postTurn(running.baseUrl, { conversationId: "c", text: "hi" })).status).toBe(401);
    expect(
      (await fetch(running.infoUrl, { headers: { authorization: "Bearer fixture-secret" } })).status,
    ).toBe(200);
  });

  it("authenticates, ownership-checks, and download-hardens reply artifact streams", async () => {
    const bytes = Buffer.from("<script>document.cookie</script>");
    const responderWithArtifacts: AgentResponder = {
      respond: async () => ({ text: "ok" }),
      async openReplyArtifact(request) {
        if (request.conversationId !== "conversation-1") {
          throw new CodedError("artifact_forbidden", "wrong conversation");
        }
        return {
          attachment: {
            type: "attachment",
            id: "part-1",
            reference: request.reference,
            name: "evil\r\nname.html",
            mediaType: "text/html",
            sizeBytes: bytes.byteLength,
            integrityId: `sha256:${"a".repeat(64)}`,
          },
          body: (async function* () { yield bytes; })(),
        };
      },
    };
    running = await startTuiAdapter({ responder: responderWithArtifacts, apiKey: "secret" });
    await expect((await fetch(running.infoUrl, {
      headers: { authorization: "Bearer secret" },
    })).json()).resolves.toMatchObject({
      capabilities: { replyAttachments: { version: 1, maxBytes: 20 * 1024 * 1024 } },
    });

    const path = `${running.baseUrl}/v1/conversations/conversation-1/reply-artifacts/artifact-1`;
    expect((await fetch(path)).status).toBe(401);
    expect((await fetch(path.replace("conversation-1", "conversation-2"), {
      headers: { authorization: "Bearer secret" },
    })).status).toBe(404);

    const response = await fetch(path, {
      headers: {
        authorization: "Bearer secret",
        "x-mono-agent-integrity-id": `sha256:${"a".repeat(64)}`,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-original-content-type")).toBe("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/u);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("keeps MCP App resources private and binds bridge requests to exact conversation and connection identity", async () => {
    const requests: unknown[] = [];
    const responderWithApps: AgentResponder = {
      respond: async () => ({ text: "ok" }),
      async loadMcpApp(request) {
        if (request.conversationId !== "conversation-1" || request.connectionId !== "connection-1") {
          throw new CodedError("app_forbidden", "wrong app owner");
        }
        return {
          app: {
            type: "mcp_app",
            id: request.invocationId,
            invocationId: request.invocationId,
            connectionId: request.connectionId,
            serverName: "widgets",
            toolName: "show_chart",
            resourceUri: "ui://widgets/chart",
            mediaType: "text/html;profile=mcp-app",
            protocolVersion: "2026-01-26",
          },
          html: "<!doctype html><script>parent.document.cookie</script>",
          toolInput: { range: "week" },
          toolResult: { ok: true },
          connected: true,
        };
      },
      async requestMcpApp(request) {
        requests.push(request);
        if (request.method === "tools/call" && request.confirmed !== true) {
          throw new CodedError("app_confirmation_required", "confirmation required");
        }
        const requestedTool = (request.params as { readonly name?: unknown } | undefined)?.name;
        if (requestedTool === "audit_incomplete") {
          throw new CodedError(
            "app_audit_incomplete",
            "The MCP App tool ran, but completion could not be recorded safely; do not retry automatically.",
          );
        }
        if (requestedTool === "audit_failed") {
          throw new CodedError("app_audit_failed", "The MCP App action could not be recorded safely.");
        }
        if (request.method === "resources/read") {
          throw new CodedError("app_resource_forbidden", "resource forbidden");
        }
        if (request.method === "ui/update-model-context") {
          throw new CodedError("app_rate_limited", "rate limited");
        }
        return { accepted: true };
      },
    };
    running = await startTuiAdapter({ responder: responderWithApps, apiKey: "secret" });
    await expect((await fetch(running.infoUrl, {
      headers: { authorization: "Bearer secret" },
    })).json()).resolves.toMatchObject({
      capabilities: {
        mcpApps: {
          bridgeVersion: 1,
          versions: ["2026-01-26", "2025-11-21"],
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });

    const route = `${running.baseUrl}/v1/conversations/conversation-1/mcp-apps/invocation-1`;
    expect((await fetch(route)).status).toBe(401);
    expect((await fetch(route, {
      headers: {
        authorization: "Bearer secret",
        "x-mono-agent-mcp-connection-id": "wrong-connection",
      },
    })).status).toBe(404);

    const resourceResponse = await fetch(route, {
      headers: {
        authorization: "Bearer secret",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
    });
    expect(resourceResponse.status).toBe(200);
    expect(resourceResponse.headers.get("cache-control")).toContain("no-store");
    expect(resourceResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resourceResponse.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await expect(resourceResponse.json()).resolves.toMatchObject({ connected: true, toolInput: { range: "week" } });

    const bridgeRoute = `${route}/requests`;
    const unconfirmed = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "tools/call", params: { name: "refresh_chart" } }),
    });
    expect(unconfirmed.status).toBe(409);
    const confirmed = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "tools/call", params: { name: "refresh_chart" }, confirmed: true }),
    });
    await expect(confirmed.json()).resolves.toEqual({ result: { accepted: true } });
    expect(requests.at(-1)).toMatchObject({
      conversationId: "conversation-1",
      invocationId: "invocation-1",
      connectionId: "connection-1",
      method: "tools/call",
      confirmed: true,
    });

    const incomplete = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "tools/call", params: { name: "audit_incomplete" }, confirmed: true }),
    });
    expect(incomplete.status).toBe(409);
    await expect(incomplete.json()).resolves.toMatchObject({
      error: {
        code: "app_audit_incomplete",
        message: expect.stringContaining("do not retry automatically"),
      },
    });
    const auditFailed = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "tools/call", params: { name: "audit_failed" }, confirmed: true }),
    });
    expect(auditFailed.status).toBe(507);
    await expect(auditFailed.json()).resolves.toMatchObject({
      error: { code: "app_audit_failed" },
    });

    const forbiddenResource = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "resources/read", params: { uri: "ui://widgets/other" } }),
    });
    expect(forbiddenResource.status).toBe(403);
    const rateLimited = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "ui/update-model-context", confirmed: true }),
    });
    expect(rateLimited.status).toBe(429);

    const oversized = await fetch(bridgeRoute, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-mono-agent-mcp-connection-id": "connection-1",
      },
      body: JSON.stringify({ method: "resources/read", params: { value: "x".repeat(70 * 1024) } }),
    });
    expect(oversized.status).toBe(413);
  });

  it("refuses to bind a non-loopback host without allowNonLoopback", async () => {
    await expect(
      startTuiAdapter({ host: "0.0.0.0", responder: scriptedResponder(async () => ({ text: "ok" })) }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it("rechecks the resolved address, closes a rejected port, and permits an explicit non-loopback bind", async () => {
    const originalLookup = dns.lookup;
    let unexpectedServer: TuiAdapterStartResult | undefined;
    let rejected: unknown;
    dns.lookup = wildcardNonLoopbackLookup as typeof dns.lookup;
    try {
      try {
        unexpectedServer = await startTuiAdapter({
          host: "localhost",
          port: 0,
          responder: scriptedResponder(async () => ({ text: "ok" })),
        });
      } catch (error) {
        rejected = error;
      }
    } finally {
      dns.lookup = originalLookup;
    }

    if (unexpectedServer !== undefined) {
      await unexpectedServer.stop();
    }
    expect(unexpectedServer).toBeUndefined();
    expect(rejected).toMatchObject({
      code: "unsafe_host",
      details: {
        host: "localhost",
        boundAddress: "0.0.0.0",
        boundPort: expect.any(Number),
      },
    });

    const boundPort = rejectedBoundPort(rejected);
    running = await startTuiAdapter({
      host: "0.0.0.0",
      port: boundPort,
      allowNonLoopback: true,
      responder: scriptedResponder(async () => ({ text: "ok" })),
    });
    expect(running.port).toBe(boundPort);
  });

  it("truncates oversized event frames instead of streaming them verbatim", async () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1024);
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({ type: "tool_call_completed", id: "t1", content: huge });
        return { text: "done" };
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));
    const eventFrame = frames[0] as Extract<AgentStreamWireFrame, { kind: "event" }>;

    expect(eventFrame.kind).toBe("event");
    const event = eventFrame.event as { content: string; metadata?: Record<string, unknown> };
    expect(event.content.length).toBeLessThan(huge.length);
    expect(event.content.endsWith("… [truncated]")).toBe(true);
    expect(event.metadata?.truncated).toBe(true);
    expect(frames.at(-1)).toEqual({ kind: "finish", finalText: "done" });
  });

  it("splits oversized append frames without losing multibyte text", async () => {
    const huge = "🙂é".repeat(MAX_FRAME_BYTES);
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.append(huge);
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    expect(lines.every((line) => Buffer.byteLength(`${line}\n`, "utf8") <= MAX_FRAME_BYTES)).toBe(true);
    const frames = lines.map(parseAgentStreamFrame);
    expect(frames.filter((frame) => frame.kind === "append").map((frame) => (
      frame as Extract<AgentStreamWireFrame, { kind: "append" }>
    ).delta).join("")).toBe(huge);
    expect(frames.at(-1)).toEqual({ kind: "finish", finalText: "done" });
  });

  it("bounds terminal reply parts and emits an explicit per-part failure", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({
        text: "answer",
        metadata: { runId: "run-1" },
        parts: [
          {
            type: "attachment",
            id: "small",
            reference: { scheme: "mono-agent-artifact", id: "artifact-small" },
            name: "report.txt",
            mediaType: "text/plain",
            sizeBytes: 2,
            integrityId: `sha256:${"a".repeat(64)}`,
          },
          {
            type: "failure",
            id: "huge",
            code: "artifact_publish_failed",
            message: "é".repeat(MAX_FRAME_BYTES),
          },
        ],
      })),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(`${lines[0]}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    const frame = parseAgentStreamFrame(lines[0] ?? "") as Extract<AgentStreamWireFrame, { kind: "finish" }>;
    expect(frame).toMatchObject({
      kind: "finish",
      finalText: "answer",
      metadata: { runId: "run-1", truncated: true },
      parts: [
        { type: "attachment", id: "small" },
        { type: "failure", id: "wire-rich-parts-truncated", code: "reply_part_too_large" },
      ],
    });
  });

  it("enforces the shared rich-part count even when the terminal frame is small", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({
        text: "answer",
        parts: Array.from({ length: MAX_AGENT_REPLY_PARTS + 1 }, (_, index) => ({
          type: "failure" as const,
          id: `part-${String(index)}`,
          code: "artifact_publish_failed" as const,
          message: "failed",
        })),
      })),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));
    const frame = frames.at(-1) as Extract<AgentStreamWireFrame, { kind: "finish" }>;
    expect(frame.parts).toHaveLength(MAX_AGENT_REPLY_PARTS);
    expect(frame.parts?.slice(0, -1).map((part) => part.id)).toEqual(
      Array.from({ length: MAX_AGENT_REPLY_PARTS - 1 }, (_, index) => `part-${String(index)}`),
    );
    expect(frame.parts?.at(-1)).toMatchObject({
      type: "failure",
      id: "wire-rich-parts-over-limit",
      code: "reply_part_too_large",
    });
  });

  it("preserves bounded rich parts while truncating an oversized final answer", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({
        text: "x".repeat(MAX_FRAME_BYTES * 2),
        parts: [{
          type: "attachment",
          id: "small",
          reference: { scheme: "mono-agent-artifact", id: "artifact-small" },
          name: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 2,
          integrityId: `sha256:${"a".repeat(64)}`,
        }],
      })),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(`${lines[0]}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    const frame = parseAgentStreamFrame(lines[0] ?? "") as Extract<AgentStreamWireFrame, { kind: "finish" }>;
    expect(frame.finalText?.endsWith("… [truncated]")).toBe(true);
    expect(frame.parts).toEqual([expect.objectContaining({ type: "attachment", id: "small" })]);
  });

  it("field-reduces an oversized subagent tool event instead of collapsing it to a marker", async () => {
    // Subagent activity deliberately rides tool_call_* rather than a new event
    // variant: only those four types are field-reducible, so a bespoke variant
    // would degrade to an `oversized_event` marker exactly when it matters.
    const huge = "x".repeat(MAX_FRAME_BYTES + 1024);
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "tool_call_completed",
          id: "agent:call-1:t1",
          name: "researcher▸Read",
          content: huge,
          metadata: { subagent: { id: "call-1", name: "researcher", callIndex: 1 }, synthetic: true },
        });
        return { text: "done" };
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));
    const eventFrame = frames[0] as Extract<AgentStreamWireFrame, { kind: "event" }>;
    const event = eventFrame.event as { type: string; id: string; name?: string; content: string };

    expect(event.type).toBe("tool_call_completed");
    expect(event.id).toBe("agent:call-1:t1");
    expect(event.content.endsWith("… [truncated]")).toBe(true);
    // The marker path would have replaced the whole event with runtime_telemetry.
    expect(event.type).not.toBe("runtime_telemetry");
  });

  it("rechecks the encoded byte cap after reducing multibyte event text", async () => {
    const huge = "é".repeat(MAX_FRAME_BYTES);
    const priorSinglePass = serializeAgentStreamFrame({
      kind: "event",
      event: {
        type: "assistant_thought",
        text: huge.slice(0, MAX_FRAME_BYTES / 2),
        metadata: { truncated: true },
      },
    });
    expect(Buffer.byteLength(priorSinglePass, "utf8")).toBe(262_238);

    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({ type: "assistant_thought", text: huge });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    const eventLine = lines[0];
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);

    const eventFrame = parseAgentStreamFrame(eventLine ?? "") as Extract<
      AgentStreamWireFrame,
      { kind: "event" }
    >;
    expect(eventFrame.kind).toBe("event");
    expect(eventFrame.event).toMatchObject({
      type: "assistant_thought",
      metadata: { truncated: true },
    });
    expect((eventFrame.event as { text: string }).text.length).toBeLessThan(MAX_FRAME_BYTES / 2);
    expect(lines.slice(1).map(parseAgentStreamFrame)).toEqual([
      { kind: "finish", finalText: "done" },
    ]);
  });

  it("uses a bounded marker when oversized metadata cannot be field-reduced", async () => {
    let metadataSerializations = 0;
    let eventFrameSerializations = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "assistant_thought",
          text: "bounded thought",
          metadata: {
            toJSON() {
              metadataSerializations += 1;
              return { oversized: "é".repeat(MAX_FRAME_BYTES) };
            },
          },
        });
        return { text: "done" };
      }),
    });

    const originalStringify = JSON.stringify;
    JSON.stringify = ((...args: unknown[]) => {
      const value = args[0];
      if (
        typeof value === "object"
        && value !== null
        && (value as { kind?: unknown }).kind === "event"
      ) {
        eventFrameSerializations += 1;
      }
      return Reflect.apply(originalStringify, JSON, args) as string | undefined;
    }) as typeof JSON.stringify;
    let responseText = "";
    try {
      responseText = await (await postTurn(
        running.baseUrl,
        { conversationId: "c", text: "hi" },
      )).text();
    } finally {
      JSON.stringify = originalStringify;
    }
    const lines = responseText.split("\n").filter((line) => line.length > 0);
    const eventLine = lines[0];
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toEqual({
      kind: "event",
      event: {
        type: "runtime_telemetry",
        kind: "oversized_event",
        data: { originalType: "assistant_thought" },
        metadata: { truncated: true },
      },
    });
    expect(metadataSerializations).toBe(1);
    // Original oversized frame + one minimal probe + the bounded marker.
    expect(eventFrameSerializations).toBe(3);
  });

  it("replaces an oversized runtime warning with one bounded marker", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "runtime_warning",
          message: "warning".repeat(MAX_FRAME_BYTES),
        });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const eventLine = responseText.split("\n").find((line) => line.length > 0);
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toEqual({
      kind: "event",
      event: {
        type: "runtime_telemetry",
        kind: "oversized_event",
        data: { originalType: "runtime_warning" },
        metadata: { truncated: true },
      },
    });
  });

  it("serializes an oversized default-branch telemetry payload only once", async () => {
    let dataSerializations = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "runtime_telemetry",
          kind: "large_payload",
          data: {
            toJSON() {
              dataSerializations += 1;
              return { payload: "x".repeat(MAX_FRAME_BYTES) };
            },
          },
        });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const eventLine = responseText.split("\n").find((line) => line.length > 0);
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toEqual({
      kind: "event",
      event: {
        type: "runtime_telemetry",
        kind: "oversized_event",
        data: { originalType: "runtime_telemetry" },
        metadata: { truncated: true },
      },
    });
    expect(dataSerializations).toBe(1);
  });

  it("stabilizes a reducible tool payload before the bounded size search", async () => {
    let contentSerializations = 0;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({
          type: "tool_call_completed",
          id: "t1",
          content: {
            toJSON() {
              contentSerializations += 1;
              return { payload: "é".repeat(MAX_FRAME_BYTES) };
            },
          },
        });
        return { text: "done" };
      }),
    });

    const responseText = await (await postTurn(
      running.baseUrl,
      { conversationId: "c", text: "hi" },
    )).text();
    const eventLine = responseText.split("\n").find((line) => line.length > 0);
    expect(eventLine).toBeDefined();
    expect(Buffer.byteLength(`${eventLine}\n`, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(parseAgentStreamFrame(eventLine ?? "")).toMatchObject({
      kind: "event",
      event: {
        type: "tool_call_completed",
        id: "t1",
        metadata: { truncated: true },
      },
    });
    expect(contentSerializations).toBe(1);
  });
});

/**
 * The producer-side `/v1/info` fence.
 *
 * The console reads at most 1 MiB of this body and rejects a larger one
 * WHOLESALE: `info()` throws `operator_info_too_large` and the agent renders
 * OFFLINE, not degraded, on a 5 s poll behind a debug-level log. Before this
 * fence the only enforcement of that cap lived in the consumer, so any
 * producer-side miss took the agent down. The invariant pinned here is
 * therefore not "this fixture is handled" but: **every `/v1/info` response is a
 * 200 carrying a schema-1 JSON body of at most 1 MiB, whatever the info
 * provider returns.**
 */
describe("startTuiAdapter /v1/info payload fence", () => {

  async function readInfo(url: string): Promise<{
    readonly status: number;
    readonly contentType: string | null;
    readonly bytes: number;
    readonly body: Record<string, unknown>;
  }> {
    const response = await fetch(url);
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.byteLength(text, "utf8"),
      body: JSON.parse(text) as Record<string, unknown>,
    };
  }

  it("sheds only the oversized field and keeps the body under the console read cap", async () => {
    // ~1.6 MiB of skills: over the cap on its own, with every other field tiny.
    const items = Array.from({ length: 3_000 }, (_unused, index) => ({
      name: `skill-${String(index)}`,
      description: "d".repeat(512),
      availability: "inlined" as const,
    }));
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
        label: "fenced",
        model: "anthropic:claude-fable-5",
        effort: "high",
        models: ["anthropic:claude-fable-5", "ollama:qwen3.6"],
        modelOptions: { "anthropic:claude-fable-5": { reasoning: true } },
        providers: [{ id: "anthropic", label: "Anthropic", modelCount: 1, source: "builtin" }],
        skills: { status: "ready", items, total: items.length },
      },
    });

    const info = await readInfo(running.infoUrl);

    expect(info.status).toBe(200);
    expect(info.contentType).toContain("application/json");
    expect(info.bytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    // Schema 1 survives shedding: the console compares it with `!==`.
    expect(info.body.schema).toBe(1);
    expect(info.body.capabilities).toEqual({ attachments: true });
    // Only the offending field is gone. Shedding in a fixed least-important
    // order would have taken modelOptions, models and providers with it, so a
    // 1.6 MiB skill registry would have cost the console its model picker too.
    expect("skills" in info.body).toBe(false);
    expect(info.body.label).toBe("fenced");
    expect(info.body.model).toBe("anthropic:claude-fable-5");
    expect(info.body.effort).toBe("high");
    expect(info.body.models).toEqual(["anthropic:claude-fable-5", "ollama:qwen3.6"]);
    expect(info.body.modelOptions).toEqual({ "anthropic:claude-fable-5": { reasoning: true } });
    expect(info.body.providers).toEqual([
      { id: "anthropic", label: "Anthropic", modelCount: 1, source: "builtin" },
    ]);
  });

  it("sheds an oversized model reference rather than the whole body", async () => {
    // The pathological field is the one field a fixed order would shed LAST.
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
        model: `anthropic:${"m".repeat(2 * 1024 * 1024)}`,
        effort: "high",
        models: ["ollama:qwen3.6"],
        skills: { status: "ready", items: [], total: 0 },
      },
    });

    const info = await readInfo(running.infoUrl);

    expect(info.status).toBe(200);
    expect(info.bytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    expect(info.body.schema).toBe(1);
    expect("model" in info.body).toBe(false);
    expect(info.body.effort).toBe("high");
    expect(info.body.models).toEqual(["ollama:qwen3.6"]);
    expect(info.body.skills).toEqual({ status: "ready", items: [], total: 0 });
  });

  it("stays online when a field cannot be serialized at all", async () => {
    // A non-serializable value used to throw inside the response literal, land
    // in the route's `.catch`, and answer 500 — which the console reads as the
    // agent being unreachable rather than as one missing projection.
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
        model: "anthropic:claude-fable-5",
        models: ["anthropic:claude-fable-5"],
        skills: { status: "ready", items: [], total: 1n } as never,
      },
    });

    const info = await readInfo(running.infoUrl);

    expect(info.status).toBe(200);
    expect(info.body.schema).toBe(1);
    expect("skills" in info.body).toBe(false);
    expect(info.body.model).toBe("anthropic:claude-fable-5");
    expect(info.body.models).toEqual(["anthropic:claude-fable-5"]);
  });

  it("sends a body that fits byte-for-byte, shedding nothing", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: {
        label: "small",
        model: "anthropic:claude-fable-5",
        effort: "high",
        models: ["anthropic:claude-fable-5"],
        modelOptions: { "anthropic:claude-fable-5": { reasoning: true } },
        providers: [{ id: "anthropic", label: "Anthropic", modelCount: 1, source: "builtin" }],
        skills: { status: "ready", items: [], total: 0 },
      },
    });

    const info = await readInfo(running.infoUrl);

    // A fence that sheds when it does not have to is as wrong as no fence.
    expect(info.bytes).toBe(Buffer.byteLength(JSON.stringify(info.body), "utf8"));
    expect(Object.keys(info.body).sort()).toEqual([
      "capabilities",
      "effort",
      "label",
      "model",
      "modelOptions",
      "models",
      "pid",
      "providers",
      "schema",
      "skills",
    ]);
  });
});

/**
 * The producer-side `/v1/info` ERROR fence.
 *
 * The success path is bounded by shedding fields, but a rejecting `info`
 * provider never reaches it: it lands in the route's `.catch` and answers
 * through the shared JSON error responder, which serialized whatever message
 * the rejection carried. A real loopback probe returned a 1,052,696-byte 500
 * against a 1,048,576-byte contract. This is not reachable through
 * mono-agent's own info provider — its overflow stays on the bounded success
 * path — but the adapter is PUBLISHED, and any embedder whose `info` throws
 * large reaches it. Bounding success and not failure is not a defensible wire
 * contract, so the invariant pinned here is: **no `/v1/info` response of any
 * status exceeds `MAX_INFO_BODY_BYTES`.**
 */
describe("startTuiAdapter /v1/info error fence", () => {
  async function readRaw(url: string): Promise<{
    readonly status: number;
    readonly contentType: string | null;
    readonly bytes: number;
    readonly text: string;
  }> {
    const response = await fetch(url);
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.byteLength(text, "utf8"),
      text,
    };
  }

  it("clamps an oversized rejection instead of serializing it whole", async () => {
    const detail = "D".repeat(2 * 1024 * 1024);
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: () => {
        throw new CodedError("info_provider_failed", `Discovery failed: ${detail}`);
      },
    });

    const raw = await readRaw(running.infoUrl);

    expect(raw.status).toBe(500);
    expect(raw.contentType).toContain("application/json");
    expect(raw.bytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    // Still a valid, still a CODED error envelope: the console and the TUI
    // switch on `code`, so clamping must not cost it.
    const body = JSON.parse(raw.text) as { error?: { message?: unknown; code?: unknown } };
    expect(body.error?.code).toBe("info_provider_failed");
    expect(typeof body.error?.message).toBe("string");
    // A clamped message still names what failed, and says it was clamped, so a
    // reader is never handed a truncated diagnostic as if it were the whole one.
    expect(String(body.error?.message).startsWith("Discovery failed: ")).toBe(true);
    expect(String(body.error?.message).endsWith("[truncated]")).toBe(true);
  });

  it("clamps against the SERIALIZED envelope, not the raw message", async () => {
    // Every unit here escapes to six bytes (\u0007 -> "\\u0007"), so a clamp
    // that budgeted the raw string would hand back a body six times the cap.
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: () => {
        throw new CodedError("info_provider_failed", `bell:${"\u0007".repeat(1024 * 1024)}`);
      },
    });

    const raw = await readRaw(running.infoUrl);

    expect(raw.status).toBe(500);
    expect(raw.bytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    const body = JSON.parse(raw.text) as { error?: { message?: unknown; code?: unknown } };
    expect(body.error?.code).toBe("info_provider_failed");
    expect(String(body.error?.message).startsWith("bell:\u0007")).toBe(true);
    expect(String(body.error?.message).endsWith("[truncated]")).toBe(true);
  });

  it("passes an ordinary rejection through byte-for-byte", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: async () => {
        await Promise.resolve();
        throw new CodedError("info_provider_failed", "Ollama endpoint refused the connection.");
      },
    });

    const raw = await readRaw(running.infoUrl);

    expect(raw.status).toBe(500);
    // A fence that clamps when it does not have to is as wrong as no fence.
    expect(JSON.parse(raw.text)).toEqual({
      error: {
        message: "Ollama endpoint refused the connection.",
        code: "info_provider_failed",
      },
    });
  });
});


function wildcardNonLoopbackLookup(
  _hostname: string,
  options: unknown,
  callback?: unknown,
): void {
  const done = typeof options === "function" ? options : callback;
  if (typeof done !== "function") {
    throw new TypeError("dns.lookup callback is required");
  }
  const all = typeof options === "object"
    && options !== null
    && (options as { all?: unknown }).all === true;
  queueMicrotask(() => {
    if (all) {
      (done as (error: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: "0.0.0.0", family: 4 }],
      );
      return;
    }
    (done as (error: null, address: string, family: number) => void)(null, "0.0.0.0", 4);
  });
}

function rejectedBoundPort(error: unknown): number {
  const boundPort = (error as { details?: { boundPort?: unknown } } | undefined)?.details?.boundPort;
  if (typeof boundPort !== "number") {
    throw new TypeError("Expected an unsafe_host error with a numeric boundPort detail.");
  }
  return boundPort;
}
