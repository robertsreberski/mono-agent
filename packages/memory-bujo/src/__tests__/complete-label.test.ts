import { describe, expect, it } from "vitest";

import { distill } from "../distill.js";
import { extractEntities } from "../entities.js";
import type { LlmComplete, LlmCompleteOptions } from "../llm.js";

/** Fake LLM that records the per-call options so we can assert the ritual label is passed through. */
function recordingLlm(): {
  calls: Array<{ prompt: string; opts?: LlmCompleteOptions }>;
  llm: LlmComplete;
} {
  const calls: Array<{ prompt: string; opts?: LlmCompleteOptions }> = [];
  const llm: LlmComplete = {
    id: "recording",
    complete: async (prompt: string, opts?: LlmCompleteOptions) => {
      calls.push({ prompt, ...(opts === undefined ? {} : { opts }) });
      return "[]";
    },
  };
  return { calls, llm };
}

describe("memory LLM call labels", () => {
  it("distill tags its completion with the capture:distill label", async () => {
    const rec = recordingLlm();
    await distill("the team discussed memory", rec.llm);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.opts?.label).toBe("capture:distill");
  });

  it("extractEntities tags its completion with the capture:entities label", async () => {
    const rec = recordingLlm();
    await extractEntities("Robert works on mono-agent", rec.llm);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.opts?.label).toBe("capture:entities");
  });
});
