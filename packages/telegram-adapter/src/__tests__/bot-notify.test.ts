import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES,
  type ProcessJobProjection,
  type ProcessJobState,
} from "@mono-agent/agent-contracts";
import type { AgentRequest, AgentResponder } from "../adapter.js";
import { createTelegramBot } from "../bot.js";

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Example Bot",
  username: "ExampleBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

function ok(result: unknown): never {
  return { ok: true, result } as never;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function buildNotifiableBot(
  responder: AgentResponder,
  behavior: {
    readonly failEdit?: boolean;
    readonly failSendAfter?: number;
    readonly beforeSend?: () => Promise<void>;
  } = {},
): {
  controller: ReturnType<typeof createTelegramBot>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let nextMessageId = 2000;
  const controller = createTelegramBot({
    botToken: "test-token",
    allowAllChats: true,
    responder,
    botFactory: () => {
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method, payload) => {
        const typedPayload = payload as Record<string, unknown>;
        calls.push({ method, payload: typedPayload });
        if (method === "sendMessage") {
          await behavior.beforeSend?.();
          const sends = calls.filter((call) => call.method === "sendMessage").length;
          if (behavior.failSendAfter !== undefined && sends > behavior.failSendAfter) {
            throw new Error("send failed");
          }
          return ok({
            message_id: nextMessageId++,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        if (method === "editMessageText") {
          if (behavior.failEdit === true) throw new Error("message is not editable");
          return ok({
            message_id: typedPayload.message_id ?? 0,
            date: 0,
            chat: { id: typedPayload.chat_id, type: "private" },
            text: typedPayload.text,
          });
        }
        return ok(true);
      });
      return bot;
    },
  });
  return { controller, calls };
}

describe("createTelegramBot notify (proactive)", () => {
  it("runs a turn keyed on telegram:<chatId> and delivers the answer to that chat", async () => {
    let captured: AgentRequest | undefined;
    const responder: AgentResponder = {
      async respond(request) {
        captured = request as AgentRequest;
        return { text: "Morning brief ready" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(42, "Compose and report the morning brief.", {
      deliveryKey: "process-job:telegram-wake",
    });

    expect(result).toEqual({ delivered: true });
    expect(captured?.conversationId).toBe("telegram:42");
    expect(captured?.replyTo).toEqual({ conversationId: "telegram:42" });
    expect(captured?.text).toBe("Compose and report the morning brief.");
    expect(Reflect.get(captured?.metadata ?? {}, Symbol.for("mono-agent.process-job-wake.delivery-key.v1")))
      .toBe("process-job:telegram-wake");
    expect(JSON.stringify(captured?.metadata)).not.toContain("process-job:telegram-wake");
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(calls.filter((call) => call.method === "editMessageText")).toEqual([]);
    expect(sent.at(-1)?.payload).toMatchObject({
      chat_id: 42,
      text: "Morning brief ready",
    });
  });

  it("suppresses transient tool activity for proactive turns", async () => {
    const responder: AgentResponder = {
      async respond(_request, stream) {
        await stream.event?.({
          type: "tool_call_started",
          id: "t1",
          name: "WebSearch",
          arguments: { query: "scheduled research" },
        });
        return { text: "Research complete" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    await controller.notify(42, "Research this in the background.");

    expect(calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text))
      .toEqual(["Research complete"]);
    expect(calls.some((call) => String(call.payload.text).includes("Searching the web")))
      .toBe(false);
  });

  it("verbatim mode posts the text as-is without running a turn and records it to history", async () => {
    let responded = false;
    const verbatimCalls: Array<[string, string]> = [];
    const responder: AgentResponder = {
      async respond() {
        responded = true;
        return { text: "should not run" };
      },
      async deliverVerbatim(conversationId, text) {
        verbatimCalls.push([conversationId, text]);
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(42, "Your morning brief: all clear.", { verbatim: true });

    expect(result).toEqual({ delivered: true });
    // No model turn ran — the body is posted through the normal stream (markdown
    // rendering still applies, so punctuation may be MarkdownV2-escaped).
    expect(responded).toBe(false);
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent.at(-1)?.payload.text)).toContain("Your morning brief");
    // The UNrendered body is recorded to history so a later reply resumes with it in context.
    expect(verbatimCalls).toEqual([["telegram:42", "Your morning brief: all clear."]]);
  });

  it("forwards silent through the verbatim path as disable_notification", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "should not run" };
      },
      async deliverVerbatim() {},
    };
    const { controller, calls } = buildNotifiableBot(responder);

    await controller.notify(42, "Overnight digest.", { verbatim: true, silent: true });

    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent.at(-1)?.payload).toMatchObject({ disable_notification: true });
  });

  it("does not set disable_notification when silent is not requested", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "answer" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    await controller.notify(42, "Anything urgent?");

    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.at(-1)?.payload.disable_notification).toBeUndefined();
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)(
    "posts running then edits the same Telegram lifecycle message to %s",
    async (state) => {
      const respond = vi.fn(async () => ({ text: "must not run" }));
      const { controller, calls } = buildNotifiableBot({ respond });
      await controller.updateProcessJob(42, processJobProjection("running"));
      await controller.updateProcessJob(42, processJobProjection(state));

      expect(respond).not.toHaveBeenCalled();
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
      const edits = calls.filter((call) => call.method === "editMessageText");
      expect(edits).toHaveLength(1);
      expect(edits[0]?.payload).toMatchObject({ chat_id: 42, message_id: 2000 });
      expect(String(edits[0]?.payload.text)).toContain(state.replaceAll("_", " "));
    },
  );

  it("serializes process-job updates so terminal wins over a late running update", async () => {
    const { controller, calls } = buildNotifiableBot({
      async respond() { return { text: "unused" }; },
    });
    await controller.updateProcessJob(42, processJobProjection("running"));
    await Promise.all([
      controller.updateProcessJob(42, processJobProjection("succeeded")),
      controller.updateProcessJob(42, processJobProjection("running")),
    ]);
    const edits = calls.filter((call) => call.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(String(edits[0]?.payload.text)).toContain("succeeded");
  });

  it("refuses cross-chat mutation and posts one same-chat fallback when the ref is uneditable", async () => {
    const { controller, calls } = buildNotifiableBot({
      async respond() { return { text: "unused" }; },
    }, { failEdit: true });
    await expect(controller.updateProcessJob(7, processJobProjection("running")))
      .resolves.toMatchObject({ delivered: false, code: "process_job_origin_mismatch" });
    expect(calls).toHaveLength(0);

    await controller.updateProcessJob(42, processJobProjection("running"));
    await expect(controller.updateProcessJob(42, processJobProjection("failed")))
      .resolves.toMatchObject({ delivered: true, code: "surface_terminal_fallback" });
    await controller.updateProcessJob(42, processJobProjection("failed"));
    const sends = calls.filter((call) => call.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.payload.chat_id).toBe(42);
  });

  it("attempts a missing-ref terminal fallback only once even when Telegram rejects it", async () => {
    const { controller, calls } = buildNotifiableBot({
      async respond() { return { text: "unused" }; },
    }, { failSendAfter: 0 });
    await expect(controller.updateProcessJob(42, processJobProjection("failed")))
      .resolves.toMatchObject({ delivered: false, code: "surface_update_failed" });
    await expect(controller.updateProcessJob(42, processJobProjection("failed")))
      .resolves.toMatchObject({ delivered: false, code: "surface_terminal_fallback_already_attempted" });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });

  it("does not republish an original terminal card after the former 256-entry eviction pressure", async () => {
    const { controller, calls } = buildNotifiableBot({
      async respond() { return { text: "unused" }; },
    });
    const original = processJobProjection("succeeded", "pj_original_terminal");
    await expect(controller.updateProcessJob(42, original))
      .resolves.toMatchObject({ delivered: true, code: "surface_terminal_fallback" });
    for (let index = 0; index < 257; index += 1) {
      await controller.updateProcessJob(
        42,
        processJobProjection("running", `pj_pressure_${String(index)}`),
      );
    }
    const nativePostsBeforeSettlement = calls.filter((call) => call.method === "sendMessage").length;
    const wakeSettlement: ProcessJobProjection = {
      ...original,
      wake: {
        ...original.wake,
        state: "delivered",
        attempts: 1,
        lastAttemptAt: "2026-08-15T00:00:03.000Z",
      },
    };

    await expect(controller.updateProcessJob(42, wakeSettlement))
      .resolves.toMatchObject({ delivered: true, code: "surface_unchanged" });
    expect(calls.filter((call) => call.method === "sendMessage"))
      .toHaveLength(nativePostsBeforeSettlement);
  });

  it("reclaims a failed terminal attempt after wake settlement without posting it twice", async () => {
    const behavior: { failSendAfter?: number } = { failSendAfter: 0 };
    const { controller, calls } = buildNotifiableBot(
      { async respond() { return { text: "unused" }; } },
      behavior,
    );
    const original = processJobProjection("failed", "pj_failed_terminal");
    await expect(controller.updateProcessJob(42, original))
      .resolves.toMatchObject({ delivered: false, code: "surface_update_failed" });
    const settled: ProcessJobProjection = {
      ...original,
      wake: { ...original.wake, state: "delivered", attempts: 1 },
    };
    await expect(controller.updateProcessJob(42, settled))
      .resolves.toMatchObject({
        delivered: false,
        code: "surface_terminal_fallback_already_attempted",
      });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);

    delete behavior.failSendAfter;
    for (let index = 0; index < MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES - 1; index += 1) {
      await controller.updateProcessJob(
        42,
        processJobProjection("running", `pj_failed_pressure_${String(index)}`),
      );
    }
    expect(controller.processJobLifecycleStateCount()).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);
    await expect(controller.updateProcessJob(
      42,
      processJobProjection("running", "pj_after_failed_terminal_settlement"),
    )).resolves.toMatchObject({ delivered: true, code: "surface_posted" });
    expect(controller.processJobLifecycleStateCount()).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);
    expect(calls.filter((call) => call.method === "sendMessage"))
      .toHaveLength(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES + 1);
  });

  it("retains the full shared outstanding population and refuses unsafe overflow", async () => {
    const terminalPostStarted = createDeferred<void>();
    const releaseTerminalPost = createDeferred<void>();
    let holdNextSend = true;
    const { controller, calls } = buildNotifiableBot(
      { async respond() { return { text: "unused" }; } },
      {
        beforeSend: async () => {
          if (!holdNextSend) return;
          holdNextSend = false;
          terminalPostStarted.resolve(undefined);
          await releaseTerminalPost.promise;
        },
      },
    );
    holdNextSend = false;
    for (let index = 0; index < MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES - 1; index += 1) {
      await controller.updateProcessJob(42, processJobProjection("running", `pj_${String(index)}`));
    }
    holdNextSend = true;
    const settledTerminal = processJobProjection("succeeded", "pj_settled_in_flight");
    const terminalPost = controller.updateProcessJob(42, {
      ...settledTerminal,
      wake: { ...settledTerminal.wake, state: "delivered", attempts: 1 },
    });
    await terminalPostStarted.promise;
    expect(controller.processJobMessageRefCount()).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES - 1);
    expect(controller.processJobLifecycleStateCount()).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);
    await expect(controller.updateProcessJob(
      42,
      processJobProjection("running", "pj_unsafe_overflow"),
    )).resolves.toMatchObject({ delivered: false, code: "surface_capacity_exceeded" });
    expect(controller.processJobLifecycleStateCount()).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);
    expect(calls.filter((call) => call.method === "sendMessage"))
      .toHaveLength(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);

    releaseTerminalPost.resolve(undefined);
    await expect(terminalPost)
      .resolves.toMatchObject({ delivered: true, code: "surface_terminal_fallback" });
    await expect(controller.updateProcessJob(
      42,
      processJobProjection("running", "pj_after_safe_settlement"),
    )).resolves.toMatchObject({ delivered: true, code: "surface_posted" });
    expect(controller.processJobLifecycleStateCount()).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);
    expect(calls.filter((call) => call.method === "sendMessage"))
      .toHaveLength(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES + 1);
  });

  it("posts nothing (and reports the reason) when the proactive turn produces no answer", async () => {
    const responder: AgentResponder = {
      async respond() {
        return { text: "" };
      },
    };
    const { controller, calls } = buildNotifiableBot(responder);

    const result = await controller.notify(7, "Anything urgent?");

    expect(result).toEqual({ delivered: false, reason: "agent produced no answer" });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("reports the queue-full reason when the chat is at its concurrency cap", async () => {
    // Hold the first turn open so a flood past the depth cap is rejected by the
    // per-chat admission queue while the run is still in-flight.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder: AgentResponder = {
      async respond() {
        await gate;
        return { text: "done" };
      },
    };
    const { controller } = buildNotifiableBot(responder);

    // Fill the queue to its depth cap (100) with notifies that park on `gate`,
    // then the next notify is rejected synchronously as queue-full.
    const inflight = Array.from({ length: 100 }, () => controller.notify(5, "tick"));
    const rejected = await controller.notify(5, "one too many");

    expect(rejected).toEqual({
      delivered: false,
      code: "conversation_busy",
      reason: "chat at concurrency cap",
      retryable: true,
    });

    release?.();
    await Promise.all(inflight);
  });
});

function processJobProjection(
  state: ProcessJobState,
  jobId = "pj_telegram",
): ProcessJobProjection {
  const terminal = state !== "queued" && state !== "starting" && state !== "running";
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId,
    tool: "Exec",
    state,
    summary: "Exec command (values redacted)",
    origin: {
      conversationId: "telegram:42#2026-08-15",
      channel: "telegram",
      runId: "run",
      historyBoundary: "run",
      bucket: "2026-08-15",
    },
    timestamps: {
      admittedAt: "2026-08-15T00:00:00.000Z",
      queueDeadlineAt: "2026-08-15T00:05:00.000Z",
      startedAt: "2026-08-15T00:00:01.000Z",
      runtimeDeadlineAt: "2026-08-15T00:30:01.000Z",
      completedAt: terminal ? "2026-08-15T00:00:02.000Z" : null,
    },
    limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1024, previewChars: 100, chainDepth: 0 },
    output: {
      stdoutBytes: terminal ? 2 : 0,
      stderrBytes: 0,
      truncated: false,
      preview: terminal ? "ok" : "",
      stdoutRef: null,
      stderrRef: null,
    },
    wake: { state: "pending", attempts: 0, deliveryKey: `process-job:${jobId}`, lastAttemptAt: null },
    exitCode: state === "succeeded" ? 0 : null,
    signal: null,
    durationMs: terminal ? 1_000 : null,
    cancelRequested: state === "cancelled",
    lastError: state === "failed"
      ? { code: "process_job_failed", message: "Process exited with code 1." }
      : null,
  };
}
