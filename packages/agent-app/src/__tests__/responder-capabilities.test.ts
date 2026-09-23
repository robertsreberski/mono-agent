import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { createSlackPostedReplyHistory } from "../posted-reply-history.js";
import { bindProcessJobWakeContextToResponder } from "../process-jobs-context.js";

// Keep this inventory tied to the shared contract: a new optional capability
// must be considered by the app's explicit responder decorators.
const optionalResponderKeys = [
  "liveInputOwnership",
  "compactConversation",
  "offerLiveInput",
  "cancel",
  "deliverVerbatim",
  "importContext",
  "openReplyArtifact",
  "loadMcpApp",
  "requestMcpApp",
] as const satisfies readonly Exclude<keyof AgentResponder, "respond">[];
type UnlistedResponderKey = Exclude<keyof AgentResponder, "respond" | (typeof optionalResponderKeys)[number]>;
const noUnlistedResponderKeys: UnlistedResponderKey extends never ? true : never = true;
void noUnlistedResponderKeys;

describe("app responder decorators", () => {
  it("retains a bound manual compaction capability across posted-reply and process-job wrappers", async () => {
    const inner: AgentResponder & { name: string } = {
      name: "inner",
      respond: async () => ({ text: "ok" }),
      compactConversation: vi.fn(function (this: typeof inner, conversationId: string) {
        expect(this).toBe(inner);
        expect(conversationId).toBe("web:thread");
        return Promise.resolve({ status: "succeeded" as const, operationId: "compact-1", trigger: "manual" as const });
      }),
    };
    const postedReplyHistory = createSlackPostedReplyHistory({ maxMessages: 64 });
    // The two allowlist decorators are the last stages of app-controller-responder's
    // replyArtifacts -> mcpApps -> postedReplyHistory -> processJobWake composition.
    const responder = bindProcessJobWakeContextToResponder(postedReplyHistory.wrapResponder(inner));

    expect(typeof responder.compactConversation).toBe("function");
    expect(await responder.compactConversation?.("web:thread", { model: "openai:test" })).toEqual({
      status: "succeeded", operationId: "compact-1", trigger: "manual",
    });
    expect(inner.compactConversation).toHaveBeenCalledWith("web:thread", { model: "openai:test" });

    const operator = await startTuiAdapter({ responder });
    try {
      const info = await (await fetch(operator.infoUrl)).json() as {
        capabilities: { manualCompaction?: { version: number } };
      };
      expect(info.capabilities.manualCompaction).toEqual({ version: 1 });
    } finally {
      await operator.stop();
    }
  });
});
