import { describe, expect, it } from "vitest";
import type { AgentResponder, AgentResponse } from "@mono-agent/agent-contracts";
import { bindProcessJobWakeContextToResponder, consumeSilentProcessJobWake, runWithProcessJobWakeContext } from "../process-jobs-context.js";

const keySymbol = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");
const stream = { append: async () => {}, finish: async () => {} } as never;
const request = (key?: string) => ({
  conversationId: "web:thread", text: "wake", abortSignal: new AbortController().signal,
  metadata: key === undefined ? {} : { [keySymbol]: key },
});

describe("exact process-job wake silence", () => {
  it.each(["slack:C1:1.1", "telegram:42", "web:thread", "whatsapp:123@s.whatsapp.net"])("suppresses only the exact active delivery in %s", async (conversationId) => {
    const key = "process-job:silent";
    const responder = bindProcessJobWakeContextToResponder({ respond: async () => ({ text: "NOTHING_TO_REPORT" }) });
    await runWithProcessJobWakeContext({ jobId: "silent", chainDepth: 5 }, async () => {
      expect(await responder.respond({ ...request(key), conversationId }, stream)).toEqual({ text: "" });
    }, key);
    expect(consumeSilentProcessJobWake("process-job:other")).toBe(false);
    expect(consumeSilentProcessJobWake(key)).toBe(true);
    expect(consumeSilentProcessJobWake(key)).toBe(false);
  });

  it.each<AgentResponse>([
    { text: "Work continues.\nNOTHING_TO_REPORT" },
    { text: "NOTHING_TO_REPORT", parts: [{ type: "failure", id: "part", code: "artifact_missing", message: "Missing" }] },
    { text: "Use NOTHING_TO_REPORT if appropriate." },
    { text: "" },
  ])("preserves narration and rich output: %j", async (response) => {
    const responder = bindProcessJobWakeContextToResponder({ respond: async () => response } as AgentResponder);
    const key = "process-job:visible";
    await runWithProcessJobWakeContext({ jobId: "visible", chainDepth: 1 }, async () => {
      expect(await responder.respond(request(key), stream)).toEqual(response);
    }, key);
    expect(consumeSilentProcessJobWake(key)).toBe(false);
  });

  it("ignores missing, stale, and mismatched delivery keys", async () => {
    const response = { text: "NOTHING_TO_REPORT" };
    const responder = bindProcessJobWakeContextToResponder({ respond: async () => response });
    expect(await responder.respond(request(), stream)).toEqual(response);
    expect(await responder.respond(request("process-job:stale"), stream)).toEqual(response);
    await runWithProcessJobWakeContext({ jobId: "real", chainDepth: 1 }, async () => {
      expect(await responder.respond(request("process-job:other"), stream)).toEqual(response);
    }, "process-job:real");
    expect(consumeSilentProcessJobWake("process-job:real")).toBe(false);
  });
});
