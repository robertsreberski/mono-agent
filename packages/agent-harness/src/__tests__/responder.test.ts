import { describe, expect, it } from "vitest";

import type { AgentMessageStream } from "@mono-agent/agent-contracts";

import { bucketConversationId, createAgentResponder } from "../responder.js";
import type { AgentHarness, AgentHarnessRequest, AgentHarnessResponse } from "../types.js";

function okResponse(conversationId: string): AgentHarnessResponse {
  return {
    text: "ok",
    metadata: { runId: "r", conversationId, contextSources: [], contextSectionIds: [] },
  };
}

function noopStream(): AgentMessageStream {
  return { append: async () => {} };
}

function baseRequest(conversationId = "c1") {
  return { conversationId, text: "hi", abortSignal: new AbortController().signal };
}

describe("createAgentResponder", () => {
  it("routes respond() through harness.submit when available (queue-after-turn)", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        calls.push("run");
        return okResponse(request.conversationId);
      },
      submit: async (request: AgentHarnessRequest) => {
        calls.push("submit");
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), noopStream());

    expect(calls).toEqual(["submit"]);
  });

  it("falls back to harness.run when submit is absent", async () => {
    const calls: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        calls.push("run");
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), noopStream());

    expect(calls).toEqual(["run"]);
  });

  it("deliverVerbatim delegates to harness.appendVerbatimTurn under the same bucketed id as respond()", async () => {
    const verbatim: Array<[string, string]> = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      appendVerbatimTurn: async (conversationId: string, text: string) => {
        verbatim.push([conversationId, text]);
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-06-24T10:00:00Z"),
    });

    await responder.deliverVerbatim!("telegram:42", "Morning brief.");

    // Bucketed identically to respond(), so a later reply resumes with it in context.
    expect(verbatim).toEqual([["telegram:42#2026-06-24", "Morning brief."]]);
  });

  it("streams each assistant text delta to stream.append in order (no batching)", async () => {
    const appended: string[] = [];
    const stream: AgentMessageStream = {
      append: async (delta: string) => {
        appended.push(delta);
      },
    };
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => {
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "Hel" }] } });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "lo" }] } });
        request.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "!" }] } });
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest(), stream);

    expect(appended).toEqual(["Hel", "lo", "!"]);
  });

  it("cancel(conversationId) delegates to the harness", async () => {
    const cancelled: string[] = [];
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      cancel: (conversationId: string) => {
        cancelled.push(conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    responder.cancel?.("conv-7");

    expect(cancelled).toEqual(["conv-7"]);
  });

  it("applies a daily bucket to respond() and cancel() with the same key", async () => {
    const seen: { submitted?: string; cancelled?: string } = {};
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      submit: async (request: AgentHarnessRequest) => {
        seen.submitted = request.conversationId;
        return okResponse(request.conversationId);
      },
      cancel: (conversationId: string) => {
        seen.cancelled = conversationId;
      },
    };
    const responder = createAgentResponder({
      harness,
      rollover: "daily",
      rolloverTimezone: "UTC",
      now: () => new Date("2026-06-19T23:30:00Z"),
    });

    await responder.respond(baseRequest("telegram:42"), noopStream());
    responder.cancel?.("telegram:42");

    expect(seen.submitted).toBe("telegram:42#2026-06-19");
    // cancel buckets identically, so it targets the same queue/session key.
    expect(seen.cancelled).toBe("telegram:42#2026-06-19");
  });

  it("does not bucket the conversationId when rollover is off (default)", async () => {
    let submitted = "";
    const harness: AgentHarness = {
      run: async (request: AgentHarnessRequest) => okResponse(request.conversationId),
      submit: async (request: AgentHarnessRequest) => {
        submitted = request.conversationId;
        return okResponse(request.conversationId);
      },
    };
    const responder = createAgentResponder({ harness });

    await responder.respond(baseRequest("cron:scan"), noopStream());

    expect(submitted).toBe("cron:scan");
  });
});

describe("bucketConversationId", () => {
  const at = (iso: string) => () => new Date(iso);

  it("appends a local-date bucket under the daily policy", () => {
    expect(bucketConversationId("cron:scan", "daily", "UTC", at("2026-06-19T10:00:00Z")))
      .toBe("cron:scan#2026-06-19");
  });

  it("is a passthrough when rollover is none/undefined", () => {
    expect(bucketConversationId("cron:scan", "none", "UTC", at("2026-06-19T10:00:00Z"))).toBe("cron:scan");
    expect(bucketConversationId("cron:scan", undefined, "UTC", at("2026-06-19T10:00:00Z"))).toBe("cron:scan");
  });

  it("is idempotent within the same day (no double suffix)", () => {
    const once = bucketConversationId("cron:scan", "daily", "UTC", at("2026-06-19T10:00:00Z"));
    const twice = bucketConversationId(once, "daily", "UTC", at("2026-06-19T18:00:00Z"));
    expect(twice).toBe("cron:scan#2026-06-19");
  });

  it("honors the rollover timezone at the day boundary", () => {
    // 00:30 UTC on the 20th is still the 19th in New York (UTC-4 in June).
    expect(bucketConversationId("c", "daily", "America/New_York", at("2026-06-20T00:30:00Z")))
      .toBe("c#2026-06-19");
    // Same instant in Rome (UTC+2) is already the 20th.
    expect(bucketConversationId("c", "daily", "Europe/Rome", at("2026-06-20T00:30:00Z")))
      .toBe("c#2026-06-20");
  });

  it("falls back to system-local when the timezone is invalid", () => {
    expect(bucketConversationId("c", "daily", "Not/AZone", at("2026-06-19T10:00:00Z")))
      .toMatch(/^c#\d{4}-\d{2}-\d{2}$/);
  });
});
