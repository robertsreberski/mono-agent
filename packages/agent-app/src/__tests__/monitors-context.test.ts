import { describe, expect, it, vi } from "vitest";

import type { AgentRequestBase, AgentResponder, AgentResponse } from "@mono-agent/agent-contracts";

import {
  bindMonitorWakeContextToResponder,
  monitorWakeContextForRequest,
  runWithMonitorWakeContext,
} from "../monitors-context.js";

const HOST_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

function responderReturning(response: AgentResponse, seen: AgentRequestBase[] = []): AgentResponder {
  return {
    respond: async (request) => {
      seen.push(request);
      return response;
    },
  } as AgentResponder;
}

function wakeRequest(deliveryKey: string): AgentRequestBase {
  return {
    conversationId: "telegram:42",
    userMessage: "envelope",
    metadata: { telegram: { chat: { id: 42 } }, [HOST_WAKE_DELIVERY_METADATA]: deliveryKey },
  } as unknown as AgentRequestBase;
}

const stream = { push: async () => undefined, finish: async () => undefined } as never;

describe("monitor wake context", () => {
  it("resolves only its own delivery keys, never a process job's", async () => {
    await runWithMonitorWakeContext({ monitorId: "mon-1", chainDepth: 2 }, async () => {
      expect(monitorWakeContextForRequest(wakeRequest("monitor:mon-1:3")))
        .toEqual({ kind: "resolved", context: { monitorId: "mon-1", chainDepth: 2 } });
    }, "monitor:mon-1:3");

    expect(monitorWakeContextForRequest(wakeRequest("process-job:job-1"))).toEqual({ kind: "none" });
    expect(monitorWakeContextForRequest({} as Pick<AgentRequestBase, "metadata">)).toEqual({ kind: "none" });
  });

  it("reports a missed association when two flights share one delivery key", async () => {
    const request = wakeRequest("monitor:mon-1:1");
    await runWithMonitorWakeContext({ monitorId: "mon-1", chainDepth: 0 }, async () => {
      await runWithMonitorWakeContext({ monitorId: "mon-1", chainDepth: 1 }, async () => {
        expect(monitorWakeContextForRequest(request)).toEqual({ kind: "missed" });
      }, "monitor:mon-1:1");
    }, "monitor:mon-1:1");
  });

  it("carries the association across the responder queue boundary", async () => {
    const seen: AgentRequestBase[] = [];
    const bound = bindMonitorWakeContextToResponder(responderReturning({ text: "ok" }, seen));
    await runWithMonitorWakeContext({ monitorId: "mon-9", chainDepth: 1 }, async () => {
      await bound.respond(wakeRequest("monitor:mon-9:1"), stream);
    }, "monitor:mon-9:1");
    expect(seen).toHaveLength(1);
  });
});

describe("monitor wake reply suppression", () => {
  async function replyFor(response: AgentResponse, logger?: { warn: ReturnType<typeof vi.fn> }) {
    const bound = bindMonitorWakeContextToResponder(
      responderReturning(response),
      logger === undefined ? {} : { logger: logger as never },
    );
    return await runWithMonitorWakeContext({ monitorId: "mon-1", chainDepth: 0 }, async () =>
      await bound.respond(wakeRequest("monitor:mon-1:1"), stream), "monitor:mon-1:1");
  }

  it("blanks a sentinel-only reply so no message is posted", async () => {
    // Telegram and Slack skip delivery for an empty answer, which is how a
    // monitor turn stays silent without teaching either adapter about monitors.
    expect(await replyFor({ text: "NOTHING_TO_REPORT" })).toEqual({ text: "" });
    expect(await replyFor({ text: "  nothing_to_report  " })).toEqual({ text: "" });
  });

  it("honours a narrated sentinel and says so in the log", async () => {
    const logger = { warn: vi.fn() };
    const reply = await replyFor({ text: "I looked at the pane.\nNOTHING_TO_REPORT" }, logger);
    expect(reply).toEqual({ text: "" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("NOTHING_TO_REPORT"),
      { monitorId: "mon-1" },
    );
  });

  it("drops attachments alongside a suppressed answer", async () => {
    const reply = await replyFor({
      text: "NOTHING_TO_REPORT",
      parts: [{ kind: "attachment" }],
    } as unknown as AgentResponse);
    expect(reply).toEqual({ text: "" });
  });

  it("leaves a real answer, an empty answer, and a mid-body mention untouched", async () => {
    expect(await replyFor({ text: "The build failed on step 3." }))
      .toEqual({ text: "The build failed on step 3." });
    expect(await replyFor({ text: "" })).toEqual({ text: "" });
    expect(await replyFor({ text: "NOTHING_TO_REPORT is the sentinel we use." }))
      .toEqual({ text: "NOTHING_TO_REPORT is the sentinel we use." });
  });

  it("never suppresses an ordinary user turn that happens to say the sentinel", async () => {
    const bound = bindMonitorWakeContextToResponder(responderReturning({ text: "NOTHING_TO_REPORT" }));
    const reply = await bound.respond(
      { conversationId: "telegram:42", userMessage: "hi", metadata: {} } as unknown as AgentRequestBase,
      stream,
    );
    expect(reply).toEqual({ text: "NOTHING_TO_REPORT" });
  });
});
