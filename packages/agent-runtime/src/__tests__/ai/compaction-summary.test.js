import { describe, expect, it, vi } from "vitest";
import { compact, serializeConversation, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { prepareSummaryInput, summaryModels, SUMMARY_FOCUS } from "../../ai/providers/pi-native/compaction-summary.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const call = (id, name, path) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: { file_path: path } }], timestamp: 0 });
const result = (id, text, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "Edit", content: [{ type: "text", text }], isError, timestamp: 0 });
const prep = (messages, extra = {}) => ({ messagesToSummarize: messages, turnPrefixMessages: [], retainedTail: [], isSplitTurn: false, tokensBefore: 10000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 1000, keepRecentTokens: 1000 }, ...extra });
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.1, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.11 } };
const answer = (text = "Pending: test. Do not deploy.") => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage, timestamp: 0 });
const model = { id: "faux", provider: "faux", api: "openai-completions", maxTokens: 1000, contextWindow: 200000, reasoning: false };

describe("summary preparation", () => {
  it.each([false, true])("preserves terminal error and approval evidence in Pi's %s split requests", async (split) => {
    const messages = [user("Fix pending work; do not deploy"), call("c", "Edit", "/exact/file.js"), result("c", "😀".repeat(3000) + "TERMINAL ERROR: patch failed", true)];
    const original = structuredClone(messages);
    const input = prepareSummaryInput(prep(messages, split ? { isSplitTurn: true, turnPrefixMessages: messages } : {}));
    const requests = [];
    const contexts = [];
    const models = { completeSimple: vi.fn(async (_model, context) => { contexts.push(context); return answer(); }) };
    const out = await compact(input.preparation, summaryModels(models, { operationId: "op", focus: input.focus, evidence: input.evidence, requests }), model, undefined, undefined, undefined, undefined, BACKGROUND_CONTEXT);
    expect(out.ok).toBe(true);
    expect(contexts).toHaveLength(split ? 2 : 1);
    for (const context of contexts) {
      expect(context.systemPrompt).toContain(SUMMARY_FOCUS);
      expect(context.messages[0].content.at(-1).text).toMatchSnapshot(`supplemental evidence ${split}`);
      expect(JSON.stringify(context.messages)).toContain('failed');
      expect(context.systemPrompt).not.toContain("/exact/file.js");
      const serialized = JSON.stringify(context.messages);
      for (const evidence of ["TERMINAL ERROR: patch failed", "/exact/file.js", "do not deploy", "unavailable", "Result tail"]) expect(serialized).toContain(evidence);
    }
    expect(requests.map((row) => row.costUsd)).toEqual(split ? [0.11, 0.11] : [0.11]);
    expect(new Set(requests.map((row) => row.requestId)).size).toBe(requests.length);
    expect(messages).toEqual(original);
    const text = input.preparation.messagesToSummarize[2].content[0].text;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.isWellFormed()).toBe(true);
    expect(input.preparation.fileOps.edited.size).toBe(0);
  });

  it("tracks confirmed built-in file identity separately from failed or unmatched writes", () => {
    const messages = [call("r", "Read", "/same"), result("r", "read"), call("w", "Write", "/same"), result("w", "written"), call("e", "Edit", "/failed"), result("e", "failed", true), call("p", "Write", "/pending"), call("shell", "Bash", "/not-a-file-op")];
    const input = prepareSummaryInput(prep(messages));
    expect([...input.preparation.fileOps.read]).toEqual(["/same"]);
    expect([...input.preparation.fileOps.written]).toEqual(["/same"]);
    expect([...input.preparation.fileOps.edited]).toEqual([]);
    expect(input.evidence).toContain('"path":"/failed","status":"failed"');
    expect(input.evidence).toContain('"path":"/pending","status":"unresolved"');
    expect(input.evidence).not.toContain("/not-a-file-op");
    expect(messages[0].content[0]).toMatchObject({ id: "r", name: "Read", arguments: { file_path: "/same" } });
  });

  it("uses host-proven normalized paths and preserves call identity and original arguments", () => {
    const invocation = call("identity", "Write", "./relative.js");
    const outcome = { ...result("identity", "written"), details: { tool: "Write", params: { file_path: "/workspace/relative.js" } } };
    const input = prepareSummaryInput(prep([invocation, outcome]));
    expect([...input.preparation.fileOps.written]).toEqual(["/workspace/relative.js"]);
    expect(input.preparation.messagesToSummarize[0]).toEqual(invocation);
    expect(input.preparation.messagesToSummarize[1].toolCallId).toBe("identity");
    expect(input.preparation.messagesToSummarize[0].content[0].arguments.file_path).toBe("./relative.js");
  });

  it("bounds file metadata by whole identities and leaves non-text handling to Pi", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const message = { ...result("c", "x".repeat(9000)), content: [image, { type: "text", text: "x".repeat(9000) }] };
    const input = prepareSummaryInput(prep([message], { fileOps: { read: new Set(["/" + "界".repeat(2000), "/small"]), written: new Set(), edited: new Set() } }));
    expect(input.preparation.messagesToSummarize[0].content[0]).toBe(image);
    expect([...input.preparation.fileOps.read]).toEqual(["/small"]);
    expect(input.metadata.omittedFiles).toBe(1);
    const manyAttempts = prepareSummaryInput(prep(Array.from({ length: 200 }, (_, i) => call(String(i), "Edit", `/path/${i}`))));
    expect(Buffer.byteLength(manyAttempts.evidence)).toBeLessThanOrEqual(4096);
    expect(manyAttempts.metadata.omittedAttempts).toBeGreaterThan(0);
    expect(serializeConversation(input.preparation.messagesToSummarize)).not.toContain("more characters truncated");
    const untouched = { ...message, content: [image] };
    expect(prepareSummaryInput(prep([untouched])).preparation.messagesToSummarize[0]).toBe(untouched);
  });

  it("keeps update evidence and explicitly demotes superseded instructions", async () => {
    const input = prepareSummaryInput(prep([user("Tests are now done. Prior request to deploy is superseded: do not deploy.")], { previousSummary: "Tests pending. Deploy next." }));
    const models = { completeSimple: vi.fn(async () => answer("Tests done; do not deploy.")) };
    await compact(input.preparation, summaryModels(models, { operationId: "op", focus: input.focus, evidence: input.evidence, requests: [] }), model, undefined, undefined, undefined, undefined, BACKGROUND_CONTEXT);
    const context = models.completeSimple.mock.calls[0][1];
    expect(context.systemPrompt).toContain("without resurrecting superseded instructions");
    expect(JSON.stringify(context.messages)).toContain("Tests are now done");
    expect(JSON.stringify(context.messages)).toContain("Tests pending. Deploy next.");
  });
});

describe("summary request accounting", () => {
  it.each(["length", "toolUse", "empty", "malformed"])("rejects %s without losing reported spend", async (kind) => {
    const response = kind === "malformed" ? null : { ...answer(kind === "empty" ? "  " : "private summary"), stopReason: ["empty"].includes(kind) ? "stop" : kind };
    const requests = [];
    const facade = summaryModels({ completeSimple: async () => response }, { operationId: "op", focus: SUMMARY_FOCUS, requests });
    await expect(facade.completeSimple(model, { systemPrompt: "base", messages: [] }, {})).rejects.toThrow("Compaction summary request failed");
    expect(requests[0]).toMatchObject({ status: "rejected", costUsd: kind === "malformed" ? null : 0.11 });
    expect(JSON.stringify(requests)).not.toContain("private summary");
  });

  it("forwards model/options/rest identity and receiver, while unknown usage stays null", async () => {
    const options = { maxTokens: 50, cacheRetention: "none" };
    const requestContext = { signal: new AbortController().signal };
    const originalContext = { systemPrompt: "original", messages: [user("private")] };
    const requests = [];
    const models = { marker: "bound", completeSimple: vi.fn(async function (m, context, opts, ctx) {
      expect(this).toBe(models); expect(m).toBe(model); expect(opts).toBe(options); expect(ctx).toBe(requestContext);
      expect(context.messages).toBe(originalContext.messages);
      return { ...answer(), usage: undefined };
    }), other() { return this.marker; } };
    const facade = summaryModels(models, { operationId: "op", focus: SUMMARY_FOCUS, requests });
    await facade.completeSimple(model, originalContext, options, requestContext);
    expect(facade.other()).toBe("bound");
    expect(originalContext.systemPrompt).toBe("original");
    expect(requests[0]).toMatchObject({ input: null, output: null, costUsd: null });
  });

  it.each(["error", "aborted"])("forwards %s to Pi with separately retained spend", async (stopReason) => {
    const response = { ...answer(), stopReason };
    const requests = [];
    const facade = summaryModels({ completeSimple: async () => response }, { operationId: "op", focus: SUMMARY_FOCUS, requests });
    expect(await facade.completeSimple(model, {})).toBe(response);
    expect(requests[0]).toMatchObject({ status: "failed", costUsd: 0.11 });
  });

  it("sanitizes thrown provider errors and retains terminal accounting", async () => {
    const requests = [];
    const facade = summaryModels({ completeSimple: async () => { throw new Error("SECRET /private/path"); } }, { operationId: "op", focus: SUMMARY_FOCUS, requests });
    await expect(facade.completeSimple(model, {})).rejects.toThrow("request_failed");
    expect(requests[0]).toMatchObject({ status: "failed", reason: "request_failed", costUsd: null });
    expect(JSON.stringify(requests)).not.toMatch(/SECRET|private/u);
  });
});
