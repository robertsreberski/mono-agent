import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";

afterEach(() => vi.unstubAllGlobals());

// Invoke the real provider request builders, stopping at onPayload before any
// transport. The global transport also fails closed: this proof never calls a
// provider, reads credentials or authenticates. Classifier/image-only APIs do
// not consume chat transcripts and are deliberately outside this matrix.
it.each([
  "anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses",
  "azure-openai-responses", "google-generative-ai", "google-vertex", "bedrock-converse-stream",
  "mistral-conversations", "pi-messages",
])("preserves consecutive historical/current user text through the real %s transform", async api => {
  const network = vi.fn(async () => { throw new Error("Offline transform proof forbids network."); });
  vi.stubGlobal("fetch", network);
  const adapter = await import(`@earendil-works/pi-ai/api/${api}`);
  const base = fauxProvider({ models: [{ id: "fixture" }] }).getModel();
  const model = { ...base, id: "fictional-model", provider: "fictional-provider", api, baseUrl: "https://fixture.invalid/v1" };
  const context = { systemPrompt: "Fictional system.", messages: [
    { role: "user", content: "HISTORICAL-PACK-FIRST", timestamp: 0 },
    { role: "user", content: "CANONICAL-USER-SECOND", timestamp: 1 },
    { role: "user", content: "CURRENT-USER-LAST", timestamp: 2 },
  ] };
  // Codex decodes the account claim before assembling its body. This is a
  // runtime-generated fictional unsigned token, not a credential.
  const apiKey = api === "openai-codex-responses"
    ? `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fictional-account" } })).toString("base64url")}.fictional`
    : "synthetic-test-value";
  let captured: unknown;
  const stream = adapter.stream(model, context, { apiKey, env: { AWS_REGION: "us-east-1" }, maxRetries: 0,
    onPayload(payload: unknown) { captured = payload; throw new Error("OFFLINE_CAPTURE_STOP"); } });
  await stream.result();
  expect(captured).toBeDefined();
  const wire = JSON.stringify(captured);
  for (const text of ["HISTORICAL-PACK-FIRST", "CANONICAL-USER-SECOND", "CURRENT-USER-LAST"]) expect(wire.split(text)).toHaveLength(2);
  expect(wire.indexOf("HISTORICAL-PACK-FIRST")).toBeLessThan(wire.indexOf("CANONICAL-USER-SECOND"));
  expect(wire.indexOf("CANONICAL-USER-SECOND")).toBeLessThan(wire.indexOf("CURRENT-USER-LAST"));
  expect(network).not.toHaveBeenCalled();
});
