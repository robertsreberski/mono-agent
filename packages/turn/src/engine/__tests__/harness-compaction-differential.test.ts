import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compact, compactWithRequest, prepareCompaction } from "../compaction-kit/compaction.js";
import { ENGINE_CONTEXT } from "../context.js";
import { formatFileOperations } from "../compaction-kit/utils.js";


// With no protected tuples, preserve upstream conversation bytes, caps, cuts and usage.
// Only the deliberately changed instructions/metadata have a separate digest pin.
const legacyRequest = (request: any) => ({ ...request, context: { ...request.context,
  systemPrompt: request.context.systemPrompt?.split("\n\nMono-agent summary focus")[0],
  messages: request.context.messages.map((message: any) => ({ ...message, content: typeof message.content === "string" ? message.content.split("\n\nMono-agent summary focus")[0] : message.content.map((part: any) => {
    if (part.type !== "text" || !part.text.startsWith("<conversation>\n")) return part;
    const end = part.text.indexOf("\n</conversation>\n\n") + "\n</conversation>\n\n".length;
    const prior = /<previous-summary>\n[\s\S]*?\n<\/previous-summary>\n\n/u.exec(part.text.slice(end))?.[0] ?? "";
    return { ...part, text: part.text.slice(0, end) + prior };
  }) })),
} });
const promptDigest = (request: any) => createHash("sha256").update(JSON.stringify({ systemPrompt: request.context.systemPrompt ?? request.context.messages.find((m: any) => m.role === "system")?.content,
  text: request.context.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((p: any) => p.text?.startsWith("<conversation>\n")).text.split("\n</conversation>\n\n")[1],
})).digest("hex");

// Captured before the pin bump using the published 0.99.2 helpers, not generated
// from the implementation under test. The deterministic provider is synthetic.
const baseline = JSON.parse(readFileSync(new URL("./fixtures/compaction-baseline.json", import.meta.url), "utf8"));
describe("owned compaction kit vs 0.99.2 baseline", () => {
  it("preserves summary input, retained tail, tokensBefore and billed usage", async () => {
    const prepared = prepareCompaction(baseline.pathEntries, baseline.settings);
    expect(prepared.ok).toBe(true);
    const requests: any[] = [];
    const models = { completeSimple: async (_model: any, context: any, options: any) => {
      requests.push({ context: { ...context, messages: context.messages.map(({ timestamp, ...m }: any) => m) },
        options: { maxTokens: options.maxTokens, cacheRetention: options.cacheRetention } });
      return { ...baseline.pathEntries[1]!.message, content: [{ type: "text", text: "Fictional deterministic summary." }] };
    } };
    const result = await compact(prepared.value!, models,
      { id: "fixture-model", provider: "faux", maxTokens: 4096, reasoning: false },
      "Keep queue details.", "off", undefined, undefined, ENGINE_CONTEXT);
    expect(requests.map(request => request.options.maxTokens)).toEqual([3200, 2000]);
    requests.forEach((request, index) => expect(request.options.maxTokens).toBeLessThanOrEqual(baseline.requests[index].options.maxTokens));
    expect(requests.map(legacyRequest)).toEqual(baseline.requests.map(legacyRequest));
    const sources = [prepared.value!.messagesToSummarize, prepared.value!.turnPrefixMessages];
    for (const [index, request] of requests.entries()) {
      const text = request.context.messages[0].content[0].text;
      const metadata = text.split("<request-local-positions>\n")[1].split("</request-local-positions>")[0];
      const rows = metadata.split("\n").filter((line: string) => line.startsWith("{")).map((line: string) => JSON.parse(line));
      expect(rows.map((row: any) => row.recordedTimestamp)).toEqual(sources[index].map((message: any) => message.timestamp ?? null));
    }
    expect(requests.map(promptDigest)).toMatchSnapshot("history-preserving request contract");
    expect(result).toEqual(baseline.result);
  });
});


it.each(["none", "read", "modified", "both"])("retains prior prose and one file-ops block when splitting its first retained turn (%s)", async (files) => {
  const readFiles = files === "read" || files === "both" ? ["fictional-input.txt"] : [];
  const modifiedFiles = files === "modified" || files === "both" ? ["fictional-output.txt"] : [];
  const fileOpsText = formatFileOperations(readFiles, modifiedFiles);
  const user = { role: "user", content: "Fictional large request ".repeat(500), timestamp: 1 };
  const reply = { role: "assistant", content: [{ type: "text", text: "Recent work ".repeat(100) }], timestamp: 2 };
  const prepared = prepareCompaction([
    { type: "compaction", id: "checkpoint", seq: 1, summary: "Keep the fictional constraint." + fileOpsText, details: { readFiles, modifiedFiles }, retainedTail: [user], timestamp: 1 },
    { type: "message", id: "reply", message: reply },
  ], { keepRecentTokens: 100, reserveTokens: 4000 });
  expect(prepared.value!.isSplitTurn).toBe(true);
  expect(prepared.value!.messagesToSummarize).toEqual([]);
  expect(prepared.value!.turnPrefixMessages).toEqual([user]);
  let requests = 0;
  const result = await compactWithRequest(prepared.value!,
    { model: { maxTokens: 4096, reasoning: false } }, async () => {
      requests++;
      return { stopReason: "stop", content: [{ type: "text", text: "Prefix summary" }], usage: {} };
    }, ENGINE_CONTEXT);
  expect(requests).toBe(1);
  expect(result.value!.summary).toContain("Keep the fictional constraint.");
  expect(result.value!.summary).toContain("Prefix summary");
  expect(result.value!.summary).not.toContain("No prior history.");
  expect(result.value!.summary).toBe("Keep the fictional constraint.\n\n---\n\n**Turn Context (split turn):**\n\nPrefix summary" + fileOpsText);
  expect(result.value!.details).toEqual({ readFiles, modifiedFiles });
});
