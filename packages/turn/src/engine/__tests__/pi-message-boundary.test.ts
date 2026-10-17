import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JsonlSessionRepo } from "../session-store.js";
import { createRunDriver } from "../run-driver.js";

it("keeps Pi response/tool timing out of stored envelopes, hooks and subsequent requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-boundary-"));
  const raw = await new JsonlSessionRepo({ sessionsRoot: root }).create();
  const faux = fauxProvider({ provider: "fictional", models: [{ id: "fictional-model" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const first = { ...fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "fictional-call" })]), durationMs: 123 };
  faux.setResponses([first, fauxAssistantMessage([fauxText("Fictional done")])]);
  const requests: any[] = [], responses: any[] = [];
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (...args) => { requests.push(structuredClone(args[1]!)); return stream(...args); };
  const driver = createRunDriver(raw, { models, model: faux.getModel(), systemPrompt: "Fictional rules", thinkingLevel: "off",
    retry: { enabled: false }, tools: [{ name: "Effect", description: "Fictional tool", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "Fictional result" }], details: { durationMs: 456 } }) }] });
  driver.hooks.on("after_response", ({ message }: any) => { responses.push(structuredClone(message)); });
  try {
    expect((await (driver as FixtureDriver).prompt("Fictional request")).status).toBe("completed");
    expect(requests).toHaveLength(2);
    const stored = (await raw.getEntries()).filter((entry: any) => entry.type === "message").map((entry: any) => entry.message);
    const result = stored.find((message: any) => message.role === "toolResult");
    expect(result.details.durationMs).toBe(456); // Never scrub tool-owned content.
    for (const message of [...stored, ...responses, ...requests[1]!.messages]) expect(message).not.toHaveProperty("durationMs");
    expect(stored.find((message: any) => message.role === "assistant").usage).toEqual(responses[0]!.usage);
    const records = (await readFile(raw.metadata.path, "utf8")).trim().split("\n").map(JSON.parse as unknown as (line: string, index: number) => any);
    for (const record of records.filter((record) => record.kind === "message" || record.kind === "tool_result")) {
      if (record.payload.message) expect(record.payload.message).not.toHaveProperty("durationMs");
    }
  } finally { await driver.close(); await raw.close(); await rm(root, { recursive: true, force: true }); }
});

type FixtureDriver = Omit<ReturnType<typeof import("../run-driver.js").createRunDriver>, "prompt"> & { prompt(content: unknown, options?: object): ReturnType<ReturnType<typeof import("../run-driver.js").createRunDriver>["prompt"]> };
