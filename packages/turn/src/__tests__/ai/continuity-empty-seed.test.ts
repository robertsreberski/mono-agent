import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import type { RuntimeRunOptions } from "@mono-agent/turn/host/types";

async function seed(coldContext: NonNullable<RuntimeRunOptions["coldContext"]>): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "continuity-empty-seed-"));
  const runtime = createMonoRuntime({ workspace: root });
  try {
    const provider = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 1_000_000 });
    const models = createModels(); models.setProvider(provider.provider);
    const requests: { messages: readonly { role: string; content?: unknown }[] }[] = [];
    provider.setResponses([context => { requests.push(structuredClone(context)); return fauxAssistantMessage("Fictional answer."); }]);
    const result = await runtime.run("Fictional system.", {
      model: { provider: "faux", model: "fixture", reference: "faux:fixture" }, abortSignal: new AbortController().signal,
      piResolvedModel: provider.getModel("fixture")!, piResolvedModels: models, effort: "none", allowedTools: [], mcpServers: {},
      compaction: { enabled: false }, coldContext,
      messages: [{ role: "user", content: "Canonical prior." }, { role: "assistant", content: "Prior answer." }, { role: "user", content: "Current input." }],
    });
    expect(result.failureKind).toBeFalsy(); expect(requests).toHaveLength(1);
    const texts = requests[0]!.messages.map(message => {
      const content = message.content;
      return typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("") : "";
    });
    expect(texts.every(text => text.trim().length > 0)).toBe(true);
    return texts;
  } finally { await runtime.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
}

it.each([
  { label: "empty array", messages: [] },
  { label: "empty string", messages: [{ role: "user", content: "" }] },
  { label: "whitespace string", messages: [{ role: "user", content: " \n\t" }] },
  { label: "undefined content", messages: [{ role: "user", content: undefined }] },
  { label: "null content", messages: [{ role: "user", content: null }] },
  { label: "empty blocks", messages: [{ role: "user", content: [] }] },
  { label: "empty text block", messages: [{ role: "user", content: [{ type: "text", text: "" }] }] },
  { label: "undefined text block", messages: [{ role: "user", content: [{ type: "text", text: undefined }] }] },
  { label: "non-text blocks", messages: [{ role: "user", content: [{ type: "image", data: "fictional" }] }] },
])("injects no empty cold evidence message for $label", async ({ messages }) => {
  expect(await seed(async () => ({ messages }))).toEqual(["Fictional system.", "Canonical prior.", "Prior answer.", "Current input."]);
});

it("keeps valid text evidence while dropping blank adjacent messages", async () => {
  expect(await seed(async () => ({ messages: [
    { role: "user", content: "" }, { role: "user", content: [{ type: "text", text: "Historical pack." }] }, { role: "user", content: undefined },
  ] }))).toEqual(["Fictional system.", "Historical pack.", "Canonical prior.", "Prior answer.", "Current input."]);
});

it("accepts an empty replay replacement without inventing a blank prior turn", async () => {
  expect(await seed(async () => ({ messages: [], replayMessages: [] }))).toEqual(["Fictional system.", "Current input."]);
});
