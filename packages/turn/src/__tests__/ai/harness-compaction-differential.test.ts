import type { Context, FauxResponseFactory } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";


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
  text: request.context.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((p: any) => p.text?.startsWith("<conversation>\n")).text.split("\n</conversation>\n\n")[1].replace(/"recordedTimestamp":(?:[0-9]+|null)/gu, '"recordedTimestamp":0'),
})).digest("hex");

// Captured before the pin bump using the published 0.99.2 helpers, not generated
// from the implementation under test. The deterministic provider is synthetic.
describe("owned compaction kit vs 0.99.2 baseline", () => {
  it("matches baseline-main manual split-turn compaction through the complete runtime", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createModels, fauxAssistantMessage, fauxProvider, fauxText } = await import("@earendil-works/pi-ai");
  const { generateEngineTurnResponse } = await import("../../execution/pi/run.js");
  const { disposeProviderSession } = await import("../../runtime/session-fanout.js");
  const { JsonlSessionRepo } = await import("../../engine/session-store.js");
  const baseline = JSON.parse(readFileSync(new URL("./fixtures/harness/runtime-compaction-baseline.json", import.meta.url), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "mono-pi-runtime-diff-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "differential-model", contextWindow: 128000, maxTokens: 4096 }], tokensPerSecond: undefined } as unknown as Parameters<typeof fauxProvider>[0]);
  const models = createModels(); models.setProvider(faux.provider);
  const history = [];
  for (let i = 0; i < 8; i++) {
    history.push({ role: "user", content: `Fictional request ${i}: ${"x".repeat(4000)}` });
    history.push({ role: "assistant", content: `Fictional answer ${i}: ${"y".repeat(8000)}` });
  }
  const requests: Array<{ context: Context; options: { maxTokens: number | undefined; cacheRetention: string | undefined } }> = [];
  const respond: FauxResponseFactory = (context, options) => {
    requests.push({ context, options: { maxTokens: options!.maxTokens, cacheRetention: options!.cacheRetention } });
    return fauxAssistantMessage([fauxText("Fictional deterministic summary.")]);
  };
  faux.setResponses([respond, respond]);
  const clean = (value: unknown) => JSON.parse(JSON.stringify(value, (k, v) => k === "timestamp" ? undefined
    : k === "api" && String(v).startsWith("faux:") ? "faux:fixture-api" : v));
  let result, raw;
  try {
    result = await generateEngineTurnResponse("Fictional system.", {
      model: { provider: "faux", model: "differential-model", reference: "faux:differential-model" },
      piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", allowedTools: [], messages: history,
      manualCompaction: true, sessionKeepAlive: true, sessionsRoot: root,
      compaction: { keepRecentTokens: 4000, summaryMaxTokens: 2000, compactionMinSavingsTokens: 0 },
    });
    expect(result.manualCompaction?.status).toBe("succeeded");
    const repo = new JsonlSessionRepo({ sessionsRoot: root }); raw = await repo.open((await repo.list())[0]!);
    const entry = (await raw.getEntries()).find((e: { type: string }) => e.type === "compaction");
    // Faux usage estimates the actual larger request; it is not provider billing.
    expect(entry!.usage.input - baseline.compaction.usage.input).toMatchSnapshot("added summary request input tokens");
    expect(entry!.usage.totalTokens).toBe(entry!.usage.input + entry!.usage.output + entry!.usage.cacheRead + entry!.usage.cacheWrite);
    expect(requests.map(request => request.options.maxTokens)).toEqual([1231, 769]);
    requests.forEach((request, index) => expect(request.options.maxTokens).toBeLessThanOrEqual(baseline.requests[index].options.maxTokens));
    expect(requests.map(promptDigest)).toMatchSnapshot("history-preserving runtime request contract");
    expect(clean({ requests: requests.map(legacyRequest), compaction: { summary: entry!.summary, retainedTail: entry!.retainedTail, tokensBefore: entry!.tokensBefore, usage: { ...entry!.usage, input: baseline.compaction.usage.input, totalTokens: baseline.compaction.usage.totalTokens } },
      status: result.manualCompaction.status, error: result.error })).toEqual(clean((({ source, requests, ...rest }) => ({ ...rest, requests: requests.map(legacyRequest) }))(baseline)));
  } finally {
    await raw?.close();
    if (result?.providerSessionId) await disposeProviderSession(result.providerSessionId);
    await rm(root, { recursive: true, force: true });
  }
});
});
