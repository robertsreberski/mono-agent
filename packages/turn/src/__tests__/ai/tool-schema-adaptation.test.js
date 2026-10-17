import { expect, it } from "vitest";
import { normalizeContext, toToolDeclaration } from "@earendil-works/pi-ai";
import { streamSimple as openai } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as google } from "@earendil-works/pi-ai/api/google-generative-ai";
import { adaptRequestTools } from "../../engine/tool-schema-adaptation.js";
const parameters = { type: "object", properties: { kinds: { anyOf: [
  { type: "array", items: { enum: ["text", "icon"] }, minItems: 1, maxItems: 2 }, { type: "null" }],
}, choice: { const: false }, count: { enum: [1, 2.5] }, mixed: { enum: [1, "one"] },
  annotation: { default: { properties: { literal: true } } } } };
const tool = { name: "FictionalLookup", description: "Find fictional records", parameters, execute() {} };
it("infers only schema nodes and preserves shared definitions and explicit types", () => {
  const before = structuredClone(parameters);
  const adapted = adaptRequestTools([tool], "openai-completions")[0].parameters;
  expect(adapted.properties.kinds.anyOf[0].items).toEqual({ enum: ["text", "icon"], type: "string" });
  expect(adapted.properties.choice.type).toBe("boolean");
  expect(adapted.properties.count.type).toBe("number");
  expect(adapted.properties.mixed.type).toBeUndefined();
  expect(adapted.properties.annotation.default).toEqual(parameters.properties.annotation.default);
  expect(parameters).toEqual(before);
  expect(adaptRequestTools([tool], "anthropic-messages")[0]).toBe(tool);
});
it.each(["openai-completions", "google-generative-ai"])("real %s payload contains missing enum items type", async (api) => {
  const tools = adaptRequestTools([tool], api);
  const context = normalizeContext({ tools: tools.map(toToolDeclaration), messages: [{ role: "user", content: "Find a fictional record", timestamp: 0 }] });
  let payload;
  const model = { api, provider: api === "openai-completions" ? "moonshot" : "google", id: "fictional-model", baseUrl: "https://fictional.invalid/v1", reasoning: false, input: ["text"],
    contextWindow: 200000, maxTokens: 2048, compat: { supportsStrictMode: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = (api === "openai-completions" ? openai : google)(model, context, {
    apiKey: "fictional-test-key", maxRetries: 0, onPayload: (value) => { payload = value; throw new Error("Captured before network"); },
    ...(api === "openai-completions" ? { fetch: () => { throw new Error("Network forbidden"); } } : {}),
  });
  const response = await stream.result();
  expect(response.errorMessage).toContain("Captured before network");
  const schema = api === "openai-completions" ? payload.tools[0].function.parameters : payload.config.tools[0].functionDeclarations[0].parametersJsonSchema;
  expect(schema.properties.kinds.anyOf[0].items.type).toBe("string");
  expect(parameters.properties.kinds.anyOf[0].items.type).toBeUndefined();
});

it("keeps reference, explicit type and heterogeneous union semantics", () => {
  const parameters = { $defs: { leaf: { enum: [null] } }, properties: { reference: { $ref: "#/$defs/leaf" }, explicit: { type: "number", enum: ["invalid"] }, union: { anyOf: [{ const: "a" }, { const: 2 }] } } };
  const copy = adaptRequestTools([{ parameters }], "google-generative-ai")[0].parameters;
  expect(copy.$defs.leaf.type).toBe("null");
  expect(copy.properties.reference).toEqual(parameters.properties.reference);
  expect(copy.properties.explicit).toEqual(parameters.properties.explicit);
  expect(copy.properties.union.type).toBeUndefined();
});
