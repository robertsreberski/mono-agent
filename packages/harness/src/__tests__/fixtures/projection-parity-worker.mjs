// Compare byte strings with identical time/UUID inputs, never normalize output.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, rm } from "node:fs/promises";
let uuid = 0; crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;
syncBuiltinESMExports(); Math.random = () => 0.125; Date.now = () => 1700000000000;
const [source, root, legacy] = process.argv.slice(2);
const { JsonlSessionRepo } = await import(pathToFileURL(`${source}/session-store.js`));
const { createRunDriver } = await import(pathToFileURL(`${source}/run-driver.js`));
const { buildHarnessSessionContext } = await import(pathToFileURL(`${source}/session-context.js`));
const { readLegacySession } = await import(pathToFileURL(`${source}/legacy-import.js`));
const { createModels, fauxProvider, fauxAssistantMessage, fauxText, normalizeContext } = await import("@earendil-works/pi-ai");
await rm(root, { recursive: true, force: true });
const repo = new JsonlSessionRepo({ sessionsRoot: root });
const raw = await repo.create({ id: "parity-fixture", cwd: "/fictional" });
const faux = fauxProvider({ provider: "parity-fixture", models: [{ id: "A" }] }); const models = createModels();
const contexts = [];
models.setProvider({ ...faux.provider, streamSimple(selected, context, options) { contexts.push(JSON.stringify(context)); return faux.provider.streamSimple(selected, context, options); } });
faux.setResponses([fauxAssistantMessage([fauxText("Fictional response")])]);
const driver = createRunDriver(raw, { model: faux.getModel(), models, tools: [], systemPrompt: "Fictional rules", retry: { enabled: false } });
await driver.prompt("Fictional prompt");
const contextBefore = JSON.stringify(buildHarnessSessionContext(await raw.getEntries(), { repairs: await raw.getRepairEntries() }));
await raw.appendCompaction({ summary: "Fictional exact checkpoint", tokensBefore: 100, tokensAfter: 20, retainedTail: [] });
const contextAfter = JSON.stringify(buildHarnessSessionContext(await raw.getEntries(), { repairs: await raw.getRepairEntries() }));
const wirePayloads = [];
for (const api of ["anthropic-messages", "openai-responses"]) {
  const { streamSimple } = await import(`@earendil-works/pi-ai/api/${api}`);
  const model = { ...faux.getModel(), api, baseUrl: "https://fixture.invalid/v1", reasoning: false };
  const stream = streamSimple(model, normalizeContext({ systemPrompt: "Fictional current rules", messages: JSON.parse(contextBefore), tools: [] }), {
    apiKey: "synthetic-test-value", maxRetries: 0,
    fetch: async (_url, init) => { wirePayloads.push(init.body); throw new Error("fixture transport stop"); },
  });
  await stream.result();
}
const bytes = await readFile(raw.metadata.path, "utf8");
await driver.close(); await raw.close();
const reopened = await repo.open(raw.metadata); const ancestry = JSON.stringify(await reopened.getEntries()); await reopened.close();
const imported = JSON.stringify(await readLegacySession({ path: legacy, id: "fixture-session" }, dirname(legacy)));
console.log(JSON.stringify({ contexts, contextBefore, contextAfter, bytes, ancestry, imported, wirePayloads }));
await rm(root, { recursive: true, force: true });
