import { describe, expect, it } from "vitest";
import type { AgentResponder, AgentResponse } from "@mono-agent/agent-contracts";
import { bindProcessJobWakeContextToResponder, consumeSilentProcessJobWake, processJobWakeContextForRequest, runWithProcessJobWakeContext } from "../process-jobs-context.js";
import { MemoryRetrievalService, type SharedRecallStore } from "../memory-retrieval.js";

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

  it("settles only a certified silent active wake, never a forged or stale delivery key", async () => {
    const response = { text: "", metadata: { turnDisposition: "silent" as const } };
    const responder = bindProcessJobWakeContextToResponder({ respond: async () => response });
    expect(await responder.respond(request("process-job:expired"), stream)).toEqual(response);
    const key = "process-job:accepted";
    await runWithProcessJobWakeContext({ jobId: "accepted", chainDepth: 1 }, async () => {
      expect(await responder.respond(request(key), stream)).toEqual(response);
    }, key);
    expect(consumeSilentProcessJobWake("process-job:expired")).toBe(false);
    expect(consumeSilentProcessJobWake(key)).toBe(true);
  });

  it("retains an awaiting-question blocker on the exact bound request", async () => {
    const key = "process-job:question";
    const responder = bindProcessJobWakeContextToResponder({ respond: async (input) => {
      expect(processJobWakeContextForRequest(input)).toMatchObject({
        kind: "resolved", context: { pendingQuestion: true },
      });
      return { text: "Question pending" };
    } });
    await runWithProcessJobWakeContext({ jobId: "question", chainDepth: 1, pendingQuestion: true },
      async () => { await responder.respond(request(key), stream); }, key);
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

  it("suppresses recall only for privately bound host wakes, leaving capture and explicit recall intact", async () => {
    const hit = { score: 0.95, record: { id: "tea", text: "Morgan likes tea.", type: "note" as const, status: "open" as const } };
    const memory = new MemoryRetrievalService({ load: async () => undefined, recall: async () => [hit],
      close: async () => undefined } as SharedRecallStore);
    const observed: Array<{ capture: string | undefined; automatic: boolean }> = [];
    let ordinal = 0;
    const responder = bindProcessJobWakeContextToResponder({ respond: async (input) => {
      const automatic = await memory.load(input.conversationId, input.text, {
        ownerTurn: true, turnId: `turn-${++ordinal}`,
      });
      observed.push({ capture: input.captureSpeakerKind, automatic: automatic !== undefined });
      return { text: "Wake received." };
    } });
    const key = "process-job:memory";
    const human = { ...request(), text: "What does Morgan like to drink?", captureSpeakerKind: "human-turn" as const };
    await responder.respond(human, stream);
    await runWithProcessJobWakeContext({ jobId: "memory", chainDepth: 1 }, async () => {
      await responder.respond({ ...human, metadata: request(key).metadata }, stream);
    }, key);
    await responder.respond({ ...human, metadata: request("process-job:stale").metadata }, stream);
    // A client-supplied lookalike key is not proof of host provenance.
    expect(observed).toEqual([
      { capture: "human-turn", automatic: true },
      { capture: "human-turn", automatic: false },
      { capture: "human-turn", automatic: true },
    ]);
    expect(await memory.recallForTurn("turn-2", "Morgan likes tea")).toEqual([hit]);
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
